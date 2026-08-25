import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	isWorkflowReviewReport,
	renderWorkflowReviewMarkdown,
	type WorkflowReviewReport,
} from "./review-report.ts";
import { assertWorkflowState, type WorkflowState } from "./workflow-state.ts";

export const WORKFLOW_STATE_VERSION = 2;
const LEGACY_WORKFLOW_STATE_VERSION = 1;
export const CLARIFICATIONS_STATE_VERSION = 1;
export const DRAFT_IDENTIFIER_PATTERN = /^[a-zA-Z0-9-]+$/;
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface DraftWorkflowMetadata {
	version: number;
	state: WorkflowState & { phase: "planning"; step: "draft" };
	draftId: string;
	description: string;
	/** Verbatim original ask. Null only for workflows created before state version 2. */
	ask: string | null;
	createdAt: string;
}

export interface CompletedWorkflowMetadata {
	version: number;
	identifier: string;
	description: string;
	/** Verbatim original ask. Null only for workflows created before state version 2. */
	ask: string | null;
	state: WorkflowState;
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
	revisionStartedAt?: string;
	revisionCompletedAt?: string;
	pullRequestUrl?: string;
	pullRequestNumber?: number;
}

export type WorkflowMetadata = DraftWorkflowMetadata | CompletedWorkflowMetadata;

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
	workingPlan: string;
	versions: string;
	clarifications: string;
	dashboard: string;
	metadata: string;
	review: string;
	reviewMarkdown: string;
	reviews: string;
	reviewRuns: string;
	/** Legacy standalone description storage. Read only during migration. */
	legacyDescription: string;
	/** Legacy two-version storage. Read only during migration. */
	previousPlan: string;
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
		legacyDescription: join(root, "description.txt"),
		previousPlan: join(root, "plan.previous.md"),
	};
}

export function assertIdentifier(identifier: string): void {
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Workflow identifiers contain only lowercase letters, numbers, and hyphens.");
	}
}

export async function createDraft(
	files: WorkflowFiles,
	initialPlan: string,
	metadata: DraftWorkflowMetadata,
): Promise<void> {
	if (await pathExists(files.root)) throw new Error(`Workflow draft already exists: ${files.root}`);
	assertCurrentMetadataHasAsk(metadata);
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
	await migratePlanVersions(files);
	await readClarifications(files);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftState(metadata.state)) await ensureFile(files.workingPlan, await readText(files.plan));
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

export async function writeWorkflowReview(
	files: WorkflowFiles,
	report: WorkflowReviewReport,
	reviewRound?: number,
): Promise<void> {
	if (!isWorkflowReviewReport(report)) throw new Error("Cannot save an invalid workflow review report.");
	if (reviewRound !== undefined && (!Number.isSafeInteger(reviewRound) || reviewRound < 1)) {
		throw new Error("Review rounds must be positive integers.");
	}
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const markdown = renderWorkflowReviewMarkdown(report);
	const writes = [atomicWrite(files.review, json), atomicWrite(files.reviewMarkdown, markdown)];
	if (reviewRound !== undefined) {
		const basename = String(reviewRound).padStart(4, "0");
		writes.push(
			atomicWrite(join(files.reviews, `${basename}.json`), json),
			atomicWrite(join(files.reviews, `${basename}.md`), markdown),
		);
	}
	await Promise.all(writes);
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

export async function readDraftWorkflowMetadata(files: WorkflowFiles): Promise<DraftWorkflowMetadata> {
	const metadata = await readWorkflowMetadata(files);
	if (!isDraftState(metadata.state)) {
		throw new Error(`Workflow draft ${basename(files.root)} has completed metadata.`);
	}
	assertDraftMetadataForFiles(files, metadata as DraftWorkflowMetadata);
	return metadata as DraftWorkflowMetadata;
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
	if (metadata.version >= 2) assertCurrentMetadataHasAsk(metadata);
	assertWorkflowState(metadata.state);
	if (isDraftState(metadata.state)) assertDraftMetadataForFiles(files, metadata as DraftWorkflowMetadata);
	else assertIdentifier((metadata as CompletedWorkflowMetadata).identifier);
	await assertAskIsUnchanged(files, metadata.ask);
	await atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function readCompletedWorkflowMetadata(
	identifier: string,
): Promise<CompletedWorkflowMetadata> {
	const files = workflowFiles(identifier);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftState(metadata.state) || (metadata as CompletedWorkflowMetadata).identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has invalid completed metadata.`);
	}
	return metadata as CompletedWorkflowMetadata;
}

export async function writeCompletedWorkflowMetadata(
	metadata: CompletedWorkflowMetadata,
): Promise<void> {
	await writeWorkflowMetadata(workflowFiles(metadata.identifier), metadata);
}

export async function readWorkflowMetadata(files: WorkflowFiles): Promise<WorkflowMetadata> {
	const [text, legacyDescriptionText] = await Promise.all([
		readText(files.metadata),
		readText(files.legacyDescription),
	]);
	const legacyDescription = legacyDescriptionText.trim();

	if (!text.trim()) {
		if (basename(dirname(files.root)) !== ".drafts") {
			throw new Error(`Workflow ${basename(files.root)} has no metadata.`);
		}
		const metadata: DraftWorkflowMetadata = {
			version: 1,
			state: { phase: "planning", step: "draft" },
			draftId: basename(files.root),
			description: legacyDescription,
			ask: null,
			createdAt: new Date().toISOString(),
		};
		await atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
		await rm(files.legacyDescription, { force: true });
		return metadata;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata JSON.`);
	}
	let metadata: WorkflowMetadata;
	let migrated = false;
	if (isStoredDraftWorkflowMetadata(value)) {
		metadata = { ...value, ask: value.ask ?? null };
		migrated = value.ask === undefined;
	} else if (isStoredCompletedWorkflowMetadata(value)) {
		metadata = {
			...value,
			description: value.description ?? legacyDescription,
			ask: value.ask ?? null,
		};
		migrated = value.description === undefined || value.ask === undefined;
	} else {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata.`);
	}

	if (!metadata.description && legacyDescription) {
		metadata = { ...metadata, description: legacyDescription };
		migrated = true;
	}
	assertWorkflowMetadataForFiles(files, metadata);
	if (migrated) await atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
	await rm(files.legacyDescription, { force: true });
	return metadata;
}

function assertWorkflowMetadataForFiles(files: WorkflowFiles, metadata: WorkflowMetadata): void {
	assertSupportedMetadataVersion(metadata.version);
	if (metadata.version >= 2) assertCurrentMetadataHasAsk(metadata);
	assertWorkflowState(metadata.state);
	if (basename(dirname(files.root)) === ".drafts") {
		if (!isDraftState(metadata.state)) {
			throw new Error(`Workflow draft ${basename(files.root)} has completed metadata.`);
		}
		assertDraftMetadataForFiles(files, metadata as DraftWorkflowMetadata);
		return;
	}
	if (isDraftState(metadata.state) || (metadata as CompletedWorkflowMetadata).identifier !== basename(files.root)) {
		throw new Error(`Workflow ${basename(files.root)} has invalid completed metadata.`);
	}
}

function assertDraftMetadataForFiles(files: WorkflowFiles, metadata: DraftWorkflowMetadata): void {
	assertSupportedMetadataVersion(metadata.version);
	if (metadata.version >= 2) assertCurrentMetadataHasAsk(metadata);
	if (!isDraftState(metadata.state)) throw new Error(`Workflow draft ${metadata.draftId} has invalid state.`);
	if (basename(dirname(files.root)) !== ".drafts" || metadata.draftId !== basename(files.root)) {
		throw new Error(`Workflow draft ${metadata.draftId} does not match ${files.root}.`);
	}
}

function assertSupportedMetadataVersion(version: number): void {
	if (version !== LEGACY_WORKFLOW_STATE_VERSION && version !== WORKFLOW_STATE_VERSION) {
		throw new Error(`Unsupported workflow metadata version: ${version}.`);
	}
}

function isDraftState(state: WorkflowState): state is WorkflowState & { phase: "planning"; step: "draft" } {
	return state.phase === "planning" && state.step === "draft";
}

function assertCurrentMetadataHasAsk(metadata: WorkflowMetadata): void {
	if (typeof metadata.ask !== "string" || !metadata.ask.trim()) {
		throw new Error("Current workflow metadata requires a non-empty original ask.");
	}
}

async function assertAskIsUnchanged(files: WorkflowFiles, ask: string | null): Promise<void> {
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
	const normalizedAsk = typeof storedAsk === "string" ? storedAsk : null;
	if (normalizedAsk !== ask) throw new Error("The workflow original ask is immutable.");
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
	const latest = versions[versions.length - 1];
	if (latest && latest.content !== current) await atomicWrite(files.plan, latest.content);
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

type StoredDraftWorkflowMetadata = Omit<DraftWorkflowMetadata, "ask"> & {
	ask?: string | null;
};

function isStoredDraftWorkflowMetadata(value: unknown): value is StoredDraftWorkflowMetadata {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StoredDraftWorkflowMetadata>;
	return (
		isSupportedStoredVersion(item.version) &&
		item.state !== undefined &&
		isValidWorkflowState(item.state) &&
		isDraftState(item.state) &&
		typeof item.draftId === "string" &&
		DRAFT_IDENTIFIER_PATTERN.test(item.draftId) &&
		typeof item.description === "string" &&
		isStoredAskValid(item.version, item.ask) &&
		typeof item.createdAt === "string"
	);
}

type StoredCompletedWorkflowMetadata = Omit<CompletedWorkflowMetadata, "description" | "ask"> & {
	description?: string;
	ask?: string | null;
};

function isStoredCompletedWorkflowMetadata(value: unknown): value is StoredCompletedWorkflowMetadata {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<StoredCompletedWorkflowMetadata>;
	return (
		isSupportedStoredVersion(item.version) &&
		typeof item.identifier === "string" &&
		IDENTIFIER_PATTERN.test(item.identifier) &&
		(item.description === undefined || typeof item.description === "string") &&
		isStoredAskValid(item.version, item.ask) &&
		item.state !== undefined &&
		isValidWorkflowState(item.state) &&
		!isDraftState(item.state) &&
		typeof item.repositoryRoot === "string" &&
		typeof item.gitCommonDir === "string" &&
		typeof item.baseBranch === "string" &&
		typeof item.baseCommit === "string" &&
		typeof item.workflowBranch === "string" &&
		typeof item.worktreePath === "string" &&
		typeof item.createdAt === "string"
	);
}

function isValidWorkflowState(value: unknown): value is WorkflowState {
	try {
		assertWorkflowState(value);
		return true;
	} catch {
		return false;
	}
}

function isSupportedStoredVersion(version: unknown): version is number {
	return version === LEGACY_WORKFLOW_STATE_VERSION || version === WORKFLOW_STATE_VERSION;
}

function isStoredAskValid(version: number | undefined, ask: unknown): boolean {
	if (version !== undefined && version >= 2) return typeof ask === "string" && Boolean(ask.trim());
	return ask === undefined || ask === null || typeof ask === "string";
}
