import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isWorkflowPullRequest, type WorkflowPullRequest } from "./pull-requests.ts";
import {
	isWorkflowReviewReport,
	renderWorkflowReviewMarkdown,
	type WorkflowReviewReport,
} from "./review-report.ts";

export const WORKFLOW_METADATA_VERSION = 4;
export const CLARIFICATIONS_STATE_VERSION = 1;
export const DRAFT_IDENTIFIER_PATTERN = /^[a-zA-Z0-9-]+$/;
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface DraftWorkflowMetadata {
	version: number;
	draftId: string;
	description: string;
	/** Verbatim original ask. Write-once and immutable. */
	ask: string;
	createdAt: string;
}

export interface CompletedWorkflowMetadata {
	version: number;
	identifier: string;
	description: string;
	/** Verbatim original ask. Write-once and immutable. */
	ask: string;
	repositoryRoot: string;
	gitCommonDir: string;
	baseBranch: string;
	baseCommit: string;
	workflowBranch: string;
	worktreePath: string;
	createdAt: string;
	/**
	 * Display cache of the last discovered delivery, ordered from the bottom
	 * pull request to the stack tip. Refreshed from GitHub at review time.
	 */
	pullRequests?: WorkflowPullRequest[];
}

export type WorkflowMetadata = DraftWorkflowMetadata | CompletedWorkflowMetadata;

export interface PlanVersion {
	number: number;
	createdAt: string;
	path: string;
	content: string;
}

export interface SavedWorkflowReview {
	number: number;
	path: string;
	report: WorkflowReviewReport;
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
	workingPlan: string;
	versions: string;
	clarifications: string;
	dashboard: string;
	metadata: string;
	review: string;
	reviewMarkdown: string;
	reviews: string;
	reviewRuns: string;
}

export function workflowsRoot(): string {
	return join(getAgentDir(), "workflows");
}

export function draftFiles(draftId: string): WorkflowFiles {
	if (!DRAFT_IDENTIFIER_PATTERN.test(draftId)) throw new Error(`Invalid workflow draft id: ${draftId}`);
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
		workingPlan: join(root, "working-plan.md"),
		versions: join(root, "versions"),
		clarifications: join(root, "clarifications.json"),
		dashboard: join(root, "dashboard.html"),
		metadata: join(root, "metadata.json"),
		review: join(root, "review.json"),
		reviewMarkdown: join(root, "review.md"),
		reviews: join(root, "reviews"),
		reviewRuns: join(root, "review-runs"),
	};
}

export function assertIdentifier(identifier: string): void {
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Workflow identifiers contain only lowercase letters, numbers, and hyphens.");
	}
}

export function isDraftWorkflowMetadata(metadata: WorkflowMetadata): metadata is DraftWorkflowMetadata {
	return "draftId" in metadata;
}

export async function createDraft(
	files: WorkflowFiles,
	initialPlan: string,
	metadata: DraftWorkflowMetadata,
): Promise<void> {
	if (await pathExists(files.root)) throw new Error(`Workflow draft already exists: ${files.root}`);
	assertDraftMetadataForFiles(files, metadata);
	await mkdir(files.versions, { recursive: true });
	await Promise.all([
		atomicWrite(files.plan, initialPlan),
		atomicWrite(files.workingPlan, initialPlan),
		atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`),
		atomicWrite(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`),
	]);
	await writeVersionFile(files, 1, initialPlan);
}

export async function ensureWorkflowFiles(files: WorkflowFiles): Promise<WorkflowMetadata> {
	await mkdir(files.root, { recursive: true });
	await ensureFile(files.plan, "# Implementation plan\n");
	await ensureFile(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`);
	await ensurePlanVersions(files);
	await readClarifications(files);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftWorkflowMetadata(metadata)) await ensureFile(files.workingPlan, await readText(files.plan));
	return metadata;
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
	const numbered = await listNumberedFiles(files.versions, ".md");
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

export async function readWorkflowReview(files: WorkflowFiles): Promise<WorkflowReviewReport | undefined> {
	const text = await readText(files.review);
	if (!text.trim()) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Workflow review is invalid JSON: ${files.review}`);
	}
	if (!isWorkflowReviewReport(value)) throw new Error(`Workflow review has an invalid structure: ${files.review}`);
	return value;
}

/**
 * Lists every saved review report in ascending order. Files that no longer
 * parse or validate are skipped: saved reviews are derived artifacts, and an
 * unreadable one must never block generating a fresh review.
 */
export async function listSavedReviews(files: WorkflowFiles): Promise<SavedWorkflowReview[]> {
	const numbered = await listNumberedFiles(files.reviews, ".json");
	const reviews: SavedWorkflowReview[] = [];
	for (const { name, number } of numbered) {
		const path = join(files.reviews, name);
		try {
			const value: unknown = JSON.parse(await readText(path));
			if (isWorkflowReviewReport(value)) reviews.push({ number, path, report: value });
		} catch {
			// Skip unreadable saved reviews.
		}
	}
	return reviews;
}

/**
 * Appends the report to the immutable review history and updates the latest
 * `review.json` / `review.md` exports.
 */
export async function appendWorkflowReview(
	files: WorkflowFiles,
	report: WorkflowReviewReport,
): Promise<SavedWorkflowReview> {
	if (!isWorkflowReviewReport(report)) throw new Error("Cannot save an invalid workflow review report.");
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const markdown = renderWorkflowReviewMarkdown(report);
	await mkdir(files.reviews, { recursive: true });
	const numbered = await listNumberedFiles(files.reviews, ".json");
	let number = (numbered.at(-1)?.number ?? 0) + 1;
	while (true) {
		const name = String(number).padStart(4, "0");
		const path = join(files.reviews, `${name}.json`);
		try {
			await writeFile(path, json, { encoding: "utf8", flag: "wx" });
			await atomicWrite(join(files.reviews, `${name}.md`), markdown);
			await Promise.all([atomicWrite(files.review, json), atomicWrite(files.reviewMarkdown, markdown)]);
			return { number, path, report };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			number += 1;
		}
	}
}

export async function promoteDraft(draft: WorkflowFiles, destination: WorkflowFiles): Promise<void> {
	await mkdir(dirname(destination.root), { recursive: true });
	await rename(draft.root, destination.root);
	await rm(destination.workingPlan, { force: true }).catch(() => undefined);
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

export async function writeDraftWorkflowMetadata(
	files: WorkflowFiles,
	metadata: DraftWorkflowMetadata,
): Promise<void> {
	assertDraftMetadataForFiles(files, metadata);
	await writeWorkflowMetadata(files, metadata);
}

export async function writeWorkflowMetadata(
	files: WorkflowFiles,
	metadata: WorkflowMetadata,
): Promise<void> {
	assertSupportedMetadataVersion(metadata.version);
	assertMetadataHasAsk(metadata);
	// Completed metadata may be written into a draft directory transiently while
	// planning completion promotes the draft, so only draft metadata is checked
	// against its directory here.
	if (isDraftWorkflowMetadata(metadata)) assertDraftMetadataForFiles(files, metadata);
	else assertIdentifier(metadata.identifier);
	await assertAskIsUnchanged(files, metadata.ask);
	await atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function readCompletedWorkflowMetadata(
	identifier: string,
): Promise<CompletedWorkflowMetadata> {
	const files = workflowFiles(identifier);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftWorkflowMetadata(metadata) || metadata.identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has invalid completed metadata.`);
	}
	return metadata;
}

export async function writeCompletedWorkflowMetadata(
	metadata: CompletedWorkflowMetadata,
): Promise<void> {
	await writeWorkflowMetadata(workflowFiles(metadata.identifier), metadata);
}

/** Lists the identifiers of every completed workflow with readable, current metadata. */
export async function listCompletedWorkflows(): Promise<CompletedWorkflowMetadata[]> {
	let names: string[];
	try {
		names = await readdir(workflowsRoot());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const workflows: CompletedWorkflowMetadata[] = [];
	for (const name of names.sort()) {
		if (!IDENTIFIER_PATTERN.test(name)) continue;
		try {
			workflows.push(await readCompletedWorkflowMetadata(name));
		} catch {
			// Skip unreadable and unsupported workflow directories.
		}
	}
	return workflows;
}

export async function readWorkflowMetadata(files: WorkflowFiles): Promise<WorkflowMetadata> {
	const text = await readText(files.metadata);
	if (!text.trim()) throw new Error(`Workflow ${basename(files.root)} has no metadata.`);

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata JSON.`);
	}
	const storedVersion =
		value && typeof value === "object" ? (value as { version?: unknown }).version : undefined;
	if (storedVersion !== WORKFLOW_METADATA_VERSION) {
		throw new Error(
			`Workflow ${basename(files.root)} uses unsupported metadata version ${String(storedVersion)}; ` +
				`this extension release only supports workflows created at version ${WORKFLOW_METADATA_VERSION}.`,
		);
	}
	if (!isDraftMetadataValue(value) && !isCompletedMetadataValue(value)) {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata.`);
	}
	const metadata = value as WorkflowMetadata;
	assertWorkflowMetadataForFiles(files, metadata);
	return metadata;
}

function assertWorkflowMetadataForFiles(files: WorkflowFiles, metadata: WorkflowMetadata): void {
	assertSupportedMetadataVersion(metadata.version);
	assertMetadataHasAsk(metadata);
	if (basename(dirname(files.root)) === ".drafts") {
		if (!isDraftWorkflowMetadata(metadata)) {
			throw new Error(`Workflow draft ${basename(files.root)} has completed metadata.`);
		}
		assertDraftMetadataForFiles(files, metadata);
		return;
	}
	if (isDraftWorkflowMetadata(metadata) || metadata.identifier !== basename(files.root)) {
		throw new Error(`Workflow ${basename(files.root)} has invalid completed metadata.`);
	}
	assertIdentifier(metadata.identifier);
}

function assertDraftMetadataForFiles(files: WorkflowFiles, metadata: DraftWorkflowMetadata): void {
	assertSupportedMetadataVersion(metadata.version);
	assertMetadataHasAsk(metadata);
	if (basename(dirname(files.root)) !== ".drafts" || metadata.draftId !== basename(files.root)) {
		throw new Error(`Workflow draft ${metadata.draftId} does not match ${files.root}.`);
	}
}

function assertSupportedMetadataVersion(version: number): void {
	if (version !== WORKFLOW_METADATA_VERSION) {
		throw new Error(`Unsupported workflow metadata version: ${version}.`);
	}
}

function assertMetadataHasAsk(metadata: WorkflowMetadata): void {
	if (typeof metadata.ask !== "string" || !metadata.ask.trim()) {
		throw new Error("Workflow metadata requires a non-empty original ask.");
	}
}

async function assertAskIsUnchanged(files: WorkflowFiles, ask: string): Promise<void> {
	const text = await readText(files.metadata);
	if (!text.trim()) return;
	let current: unknown;
	try {
		current = JSON.parse(text);
	} catch {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata JSON.`);
	}
	if (!current || typeof current !== "object") {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata.`);
	}
	const storedAsk = (current as { ask?: unknown }).ask;
	if (typeof storedAsk === "string" && storedAsk !== ask) {
		throw new Error("The workflow original ask is immutable.");
	}
}

/**
 * Guarantees the numbered plan history exists and that `plan.md` matches its
 * latest entry, repairing a crash between the two writes in savePlanVersion.
 */
async function ensurePlanVersions(files: WorkflowFiles): Promise<void> {
	await mkdir(files.versions, { recursive: true });
	const versions = await listPlanVersions(files);
	const current = await readText(files.plan);
	if (versions.length === 0) {
		await writeVersionFile(files, 1, current);
		return;
	}
	const latest = versions[versions.length - 1];
	if (latest && latest.content !== current) await atomicWrite(files.plan, latest.content);
}

async function latestPlanVersionNumber(files: WorkflowFiles): Promise<number> {
	const versions = await listNumberedFiles(files.versions, ".md");
	return versions[versions.length - 1]?.number ?? 0;
}

async function writeVersionFile(files: WorkflowFiles, number: number, content: string): Promise<string> {
	const path = join(files.versions, `${String(number).padStart(4, "0")}.md`);
	await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	return path;
}

async function listNumberedFiles(
	directory: string,
	extension: string,
): Promise<Array<{ name: string; number: number }>> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const pattern = new RegExp(`^(\\d+)\\${extension}$`);
	return names
		.map((name) => ({ name, match: pattern.exec(name) }))
		.filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
		.map((item) => ({ name: item.name, number: Number(item.match[1]) }))
		.filter((item) => Number.isSafeInteger(item.number) && item.number > 0)
		.sort((left, right) => left.number - right.number);
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

function isDraftMetadataValue(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<DraftWorkflowMetadata>;
	return (
		item.version === WORKFLOW_METADATA_VERSION &&
		typeof item.draftId === "string" &&
		DRAFT_IDENTIFIER_PATTERN.test(item.draftId) &&
		typeof item.description === "string" &&
		typeof item.ask === "string" &&
		Boolean(item.ask.trim()) &&
		typeof item.createdAt === "string" &&
		!("identifier" in item)
	);
}

function isCompletedMetadataValue(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<CompletedWorkflowMetadata>;
	return (
		item.version === WORKFLOW_METADATA_VERSION &&
		typeof item.identifier === "string" &&
		IDENTIFIER_PATTERN.test(item.identifier) &&
		typeof item.description === "string" &&
		typeof item.ask === "string" &&
		Boolean(item.ask.trim()) &&
		typeof item.repositoryRoot === "string" &&
		typeof item.gitCommonDir === "string" &&
		typeof item.baseBranch === "string" &&
		typeof item.baseCommit === "string" &&
		typeof item.workflowBranch === "string" &&
		typeof item.worktreePath === "string" &&
		typeof item.createdAt === "string" &&
		!("draftId" in item) &&
		(item.pullRequests === undefined ||
			(Array.isArray(item.pullRequests) &&
				item.pullRequests.length > 0 &&
				item.pullRequests.every(isWorkflowPullRequest)))
	);
}
