import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_STATE_VERSION = 1;
export const CLARIFICATIONS_STATE_VERSION = 1;
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export type WorkflowStatus =
	| "ready_for_implementation"
	| "implementing"
	| "implementation_complete"
	| "reviewing"
	| "cleanup_pending"
	| "review_complete";

export interface WorkflowMetadata {
	version: number;
	identifier: string;
	/** Concise plain-English summary. Optional only for workflows created before this field existed. */
	description?: string;
	status: WorkflowStatus;
	repositoryRoot: string;
	gitCommonDir: string;
	baseBranch: string;
	baseCommit: string;
	workflowBranch: string;
	worktreePath: string;
	createdAt: string;
	implementationStartedAt?: string;
	implementationCompletedAt?: string;
	reviewStartedAt?: string;
	reviewCompletedAt?: string;
	pullRequestUrl?: string;
	pullRequestNumber?: number;
}

export interface PlanVersion {
	number: number;
	createdAt: string;
	path: string;
	content: string;
}

export interface WorkflowClarification {
	id: string;
	label: string;
	question: string;
	answer: string;
	custom: boolean;
	optionIndex?: number;
	answeredAt: string;
}

export interface WorkflowClarifications {
	version: number;
	entries: WorkflowClarification[];
}

export interface WorkflowFiles {
	root: string;
	plan: string;
	description: string;
	versions: string;
	clarifications: string;
	dashboard: string;
	metadata: string;
	/** Legacy two-version storage. Read only during migration. */
	previousPlan: string;
}

export function workflowsRoot(): string {
	return join(getAgentDir(), "workflows");
}

export function draftFiles(draftId: string): WorkflowFiles {
	if (!/^[a-zA-Z0-9-]+$/.test(draftId)) throw new Error(`Invalid workflow draft id: ${draftId}`);
	return filesAt(join(workflowsRoot(), ".drafts", draftId));
}

export function workflowFiles(identifier: string): WorkflowFiles {
	assertIdentifier(identifier);
	return filesAt(join(workflowsRoot(), identifier));
}

function filesAt(root: string): WorkflowFiles {
	return {
		root,
		plan: join(root, "plan.md"),
		description: join(root, "description.txt"),
		versions: join(root, "versions"),
		clarifications: join(root, "clarifications.json"),
		dashboard: join(root, "dashboard.html"),
		metadata: join(root, "metadata.json"),
		previousPlan: join(root, "plan.previous.md"),
	};
}

export function assertIdentifier(identifier: string): void {
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Workflow identifiers contain only lowercase letters, numbers, and hyphens.");
	}
}

export async function createDraft(files: WorkflowFiles, initialPlan: string): Promise<void> {
	if (await pathExists(files.root)) throw new Error(`Workflow draft already exists: ${files.root}`);
	await mkdir(files.versions, { recursive: true });
	await Promise.all([
		atomicWrite(files.plan, initialPlan),
		atomicWrite(files.description, ""),
		atomicWrite(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`),
	]);
	await writeVersionFile(files, 1, initialPlan);
}

export async function ensureDraft(files: WorkflowFiles): Promise<void> {
	await mkdir(files.root, { recursive: true });
	await ensureFile(files.plan, "# Implementation plan\n");
	await ensureFile(files.description, "");
	await ensureFile(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`);
	await migratePlanVersions(files);
	await readClarifications(files);
}

export async function savePlanVersion(files: WorkflowFiles, content: string): Promise<PlanVersion> {
	await mkdir(files.versions, { recursive: true });
	let number = (await latestPlanVersionNumber(files)) + 1;
	while (true) {
		try {
			const path = await writeVersionFile(files, number, content);
			await atomicWrite(files.plan, content);
			const info = await stat(path);
			return { number, createdAt: info.mtime.toISOString(), path, content };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			number += 1;
		}
	}
}

export async function listPlanVersions(files: WorkflowFiles): Promise<PlanVersion[]> {
	let names: string[];
	try {
		names = await readdir(files.versions);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const numbered = names
		.map((name) => ({ name, match: /^(\d+)\.md$/.exec(name) }))
		.filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
		.map((item) => ({ name: item.name, number: Number(item.match[1]) }))
		.filter((item) => Number.isSafeInteger(item.number) && item.number > 0)
		.sort((left, right) => left.number - right.number);

	return Promise.all(
		numbered.map(async ({ name, number }) => {
			const path = join(files.versions, name);
			const [content, info] = await Promise.all([readText(path), stat(path)]);
			return { number, createdAt: info.mtime.toISOString(), path, content };
		}),
	);
}

export async function readClarifications(files: WorkflowFiles): Promise<WorkflowClarifications> {
	const text = await readText(files.clarifications);
	if (!text.trim()) return emptyClarifications();

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Workflow clarifications are invalid JSON: ${files.clarifications}`);
	}
	if (!isWorkflowClarifications(value)) {
		throw new Error(`Workflow clarifications have an invalid structure: ${files.clarifications}`);
	}
	return value;
}

export async function appendClarifications(
	files: WorkflowFiles,
	entries: WorkflowClarification[],
): Promise<WorkflowClarifications> {
	const current = await readClarifications(files);
	const next: WorkflowClarifications = {
		version: CLARIFICATIONS_STATE_VERSION,
		entries: [...current.entries, ...entries],
	};
	await atomicWrite(files.clarifications, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export async function promoteDraft(draft: WorkflowFiles, destination: WorkflowFiles): Promise<void> {
	await mkdir(dirname(destination.root), { recursive: true });
	await rename(draft.root, destination.root);
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function ensureFile(path: string, content: string): Promise<void> {
	if (!(await pathExists(path))) await atomicWrite(path, content);
}

export async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporary, content, "utf8");
	await rename(temporary, path);
}

export async function readMetadata(identifier: string): Promise<WorkflowMetadata> {
	const files = workflowFiles(identifier);
	const text = await readText(files.metadata);
	if (!text.trim()) throw new Error(`Workflow ${identifier} has no metadata.`);

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Workflow ${identifier} has invalid metadata JSON.`);
	}
	if (!isWorkflowMetadata(value) || value.identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has invalid metadata.`);
	}
	return value;
}

export async function writeMetadata(metadata: WorkflowMetadata): Promise<void> {
	assertIdentifier(metadata.identifier);
	await atomicWrite(workflowFiles(metadata.identifier).metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function migratePlanVersions(files: WorkflowFiles): Promise<void> {
	await mkdir(files.versions, { recursive: true });
	const versions = await listPlanVersions(files);
	const current = await readText(files.plan);
	if (versions.length === 0) {
		const previous = await readText(files.previousPlan);
		let number = 1;
		if (previous && previous !== current) {
			await writeVersionFile(files, number, previous);
			number += 1;
		}
		await writeVersionFile(files, number, current);
		return;
	}
	if (versions[versions.length - 1]?.content !== current) {
		await savePlanVersion(files, current);
	}
}

async function latestPlanVersionNumber(files: WorkflowFiles): Promise<number> {
	const versions = await listPlanVersions(files);
	return versions[versions.length - 1]?.number ?? 0;
}

async function writeVersionFile(files: WorkflowFiles, number: number, content: string): Promise<string> {
	const path = join(files.versions, `${String(number).padStart(4, "0")}.md`);
	await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	return path;
}

function emptyClarifications(): WorkflowClarifications {
	return { version: CLARIFICATIONS_STATE_VERSION, entries: [] };
}

function isWorkflowClarifications(value: unknown): value is WorkflowClarifications {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<WorkflowClarifications>;
	if (item.version !== CLARIFICATIONS_STATE_VERSION || !Array.isArray(item.entries)) return false;
	return item.entries.every((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const clarification = entry as Partial<WorkflowClarification>;
		return (
			typeof clarification.id === "string" &&
			typeof clarification.label === "string" &&
			typeof clarification.question === "string" &&
			typeof clarification.answer === "string" &&
			typeof clarification.custom === "boolean" &&
			(clarification.optionIndex === undefined || typeof clarification.optionIndex === "number") &&
			typeof clarification.answeredAt === "string"
		);
	});
}

function isWorkflowMetadata(value: unknown): value is WorkflowMetadata {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<WorkflowMetadata>;
	const statuses: WorkflowStatus[] = [
		"ready_for_implementation",
		"implementing",
		"implementation_complete",
		"reviewing",
		"cleanup_pending",
		"review_complete",
	];
	return (
		item.version === WORKFLOW_STATE_VERSION &&
		typeof item.identifier === "string" &&
		IDENTIFIER_PATTERN.test(item.identifier) &&
		(item.description === undefined ||
			(typeof item.description === "string" && item.description.trim().length > 0)) &&
		typeof item.status === "string" &&
		statuses.includes(item.status as WorkflowStatus) &&
		typeof item.repositoryRoot === "string" &&
		typeof item.gitCommonDir === "string" &&
		typeof item.baseBranch === "string" &&
		typeof item.baseCommit === "string" &&
		typeof item.workflowBranch === "string" &&
		typeof item.worktreePath === "string" &&
		typeof item.createdAt === "string"
	);
}
