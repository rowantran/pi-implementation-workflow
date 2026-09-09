import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isWorkflowPullRequest, type WorkflowPullRequest } from "./pull-requests.ts";
import {
	isWorkflowReviewReport,
	renderWorkflowReviewMarkdown,
	type WorkflowReviewReport,
} from "./review-report.ts";

export const WORKFLOW_METADATA_VERSION = 5;
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
	/** The saved plan version approved for implementation; absent while planning. */
	approvedPlanVersion?: number;
	/**
	 * Display cache of the last discovered delivery, ordered from the bottom
	 * pull request to the stack tip. Refreshed from GitHub at review time.
	 */
	pullRequests?: WorkflowPullRequest[];
}

/** Tracked metadata contains facts that remain meaningful on another machine. */
export type PortableWorkflowMetadata = Omit<
	CompletedWorkflowMetadata,
	"repositoryRoot" | "gitCommonDir" | "worktreePath" | "pullRequests"
>;

/** A small, machine-local pointer. Artifacts never live in the registry. */
export interface WorkflowLocator {
	version: number;
	identifier: string;
	repositoryRoot: string;
	gitCommonDir: string;
	worktreePath: string;
}

export interface ActiveWorkflowMarker extends WorkflowLocator {
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

/** Explicit paths also work before registration, during /workflow-plan initialization. */
export function workflowFiles(identifier: string, worktreePath?: string): WorkflowFiles {
	assertIdentifier(identifier);
	const worktree = worktreePath ?? resolveWorkflowLocator(identifier).worktreePath;
	if (!isAbsolute(worktree)) throw new Error(`Workflow worktree path must be absolute: ${worktree}`);
	const root = join(resolve(worktree), ".workflows", identifier);
	assertNoSymlinks(resolve(worktree), root);
	return filesAt(root);
}

export function activeWorkflowMarkerPath(worktreePath: string): string {
	if (!isAbsolute(worktreePath)) throw new Error(`Workflow worktree path must be absolute: ${worktreePath}`);
	const path = join(resolve(worktreePath), ".workflows", "active.json");
	assertNoSymlinks(resolve(worktreePath), path);
	return path;
}

export function workflowRegistryFiles(
	identifier: string,
	registryRoot = workflowsRoot(),
): { root: string; locator: string } {
	assertIdentifier(identifier);
	const root = resolve(registryRoot);
	const locator = join(root, `${identifier}.json`);
	assertNoSymlinks(root, locator);
	return { root, locator };
}

/** Synchronous for dashboard routing and callers that only need local file paths. */
export function resolveWorkflowLocator(identifier: string, registryRoot = workflowsRoot()): WorkflowLocator {
	const { locator } = workflowRegistryFiles(identifier, registryRoot);
	const value = readJsonSync(locator);
	if (value === undefined) {
		throw new Error(`Workflow ${identifier} has no locator. Open Pi in its active worktree to register it.`);
	}
	if (!isLocatorValue(value) || value.identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has an invalid locator: ${locator}`);
	}
	if (!existsSync(value.worktreePath)) {
		throw new Error(`Workflow ${identifier} has no worktree at ${value.worktreePath}; it may have been cleaned up.`);
	}
	const marker = readActiveMarker(value.worktreePath);
	if (!marker || !sameLocation(marker, value)) {
		throw new Error(`Workflow ${identifier} has no matching active marker at ${activeWorkflowMarkerPath(value.worktreePath)}.`);
	}
	return locatorFrom(marker);
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
	assertSafeArtifactPath(files.versions);
	await mkdir(files.versions, { recursive: true });
	await Promise.all([
		atomicWrite(files.plan, initialPlan),
		atomicWrite(files.workingPlan, initialPlan),
		atomicWrite(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`),
		atomicWrite(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`),
	]);
	await writeVersionFile(files, 1, initialPlan);
}

/** Creates an unpublished bundle. registerWorkflow publishes its active marker separately. */
export async function createWorkflow(
	files: WorkflowFiles,
	initialPlan: string,
	metadata: CompletedWorkflowMetadata,
): Promise<void> {
	assertCompletedMetadata(metadata);
	assertFilesEqual(files, workflowFiles(metadata.identifier, metadata.worktreePath));
	await mkdir(dirname(files.root), { recursive: true });
	// Exclusive mkdir prevents concurrent initialization from clobbering an existing bundle.
	try {
		await mkdir(files.root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Workflow already exists: ${files.root}`);
		}
		throw error;
	}
	try {
		for (const directory of [files.versions, files.reviews, files.reviewRuns]) await mkdir(directory);
		await atomicWrite(files.plan, initialPlan);
		await atomicWrite(files.workingPlan, initialPlan);
		await writeVersionFile(files, 1, initialPlan);
		await atomicWrite(files.clarifications, `${JSON.stringify(emptyClarifications(), null, 2)}\n`);
		await atomicWrite(files.metadata, `${JSON.stringify(portableMetadata(metadata), null, 2)}\n`);
	} catch (error) {
		await rm(files.root, { recursive: true, force: true });
		throw error;
	}
}

/** Reading a brief must never repair, create, or rewrite tracked artifacts. */
export async function ensureWorkflowFiles(files: WorkflowFiles): Promise<WorkflowMetadata> {
	const metadata = await readWorkflowMetadata(files);
	await readClarifications(files);
	return metadata;
}

export async function savePlanVersion(files: WorkflowFiles, content: string): Promise<PlanVersion> {
	assertSafeArtifactPath(files.versions);
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
	assertSafeArtifactPath(files.reviews);
	await mkdir(files.reviews, { recursive: true });
	const numbered = await listNumberedFiles(files.reviews, ".json");
	let number = (numbered.at(-1)?.number ?? 0) + 1;
	while (true) {
		const name = String(number).padStart(4, "0");
		const path = join(files.reviews, `${name}.json`);
		assertSafeArtifactPath(path);
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

export async function readText(path: string): Promise<string> {
	assertSafeArtifactPath(path);
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

export async function atomicWrite(path: string, content: string): Promise<void> {
	await writeAtomically(path, content, false);
}

async function writeAtomically(path: string, content: string, exclusive: boolean): Promise<void> {
	assertSafeArtifactPath(path);
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
		assertSafeArtifactPath(path);
		if (exclusive) await link(temporary, path);
		else await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
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
	if (isDraftWorkflowMetadata(metadata)) {
		assertDraftMetadataForFiles(files, metadata);
		await assertAskIsUnchanged(files, metadata.ask);
		await writeJsonIfChanged(files.metadata, metadata);
		return;
	}
	assertCompletedMetadata(metadata);
	// Retain the legacy draft helper for fixtures, but never use it for new planning.
	if (basename(dirname(files.root)) === ".drafts") {
		await assertAskIsUnchanged(files, metadata.ask);
		await writeJsonIfChanged(files.metadata, portableMetadata(metadata));
		return;
	}
	assertFilesEqual(files, workflowFiles(metadata.identifier, metadata.worktreePath));
	const marker = requireActiveMarker(metadata.worktreePath, metadata.identifier);
	if (!sameLocation(marker, metadata)) throw new Error("Workflow runtime paths do not match its active marker.");
	await assertAskIsUnchanged(files, metadata.ask);
	await writeJsonIfChanged(files.metadata, portableMetadata(metadata));
	// Preserve runtime location facts and cache when omitted by a portable-metadata editor.
	if (Object.hasOwn(metadata, "pullRequests")) {
		await writeJsonIfChanged(activeWorkflowMarkerPath(metadata.worktreePath), {
			...marker,
			pullRequests: metadata.pullRequests,
		});
	}
}

export async function readCompletedWorkflowMetadata(
	identifier: string,
	worktreePath?: string,
): Promise<CompletedWorkflowMetadata> {
	const files = workflowFiles(identifier, worktreePath);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftWorkflowMetadata(metadata) || metadata.identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has invalid completed metadata.`);
	}
	return metadata;
}

export async function writeCompletedWorkflowMetadata(
	metadata: CompletedWorkflowMetadata,
): Promise<void> {
	await writeWorkflowMetadata(workflowFiles(metadata.identifier, metadata.worktreePath), metadata);
}

/** Publishes an initialized bundle, keeping only its locator in the global registry. */
export async function registerWorkflow(metadata: CompletedWorkflowMetadata): Promise<void> {
	assertCompletedMetadata(metadata);
	const files = workflowFiles(metadata.identifier, metadata.worktreePath);
	const stored = await readStoredMetadata(files);
	if (isDraftMetadataValue(stored) || (stored as PortableWorkflowMetadata).identifier !== metadata.identifier) {
		throw new Error(`Workflow ${metadata.identifier} has invalid completed metadata.`);
	}
	if (stored.ask !== metadata.ask) throw new Error("The workflow original ask is immutable.");
	const previous = readActiveMarker(metadata.worktreePath);
	if (previous && !sameLocation(previous, metadata)) {
		throw new Error(`Worktree ${metadata.worktreePath} already has active workflow ${previous.identifier}.`);
	}
	await assertLocatorAvailable(metadata);
	// The marker is machine-local; never ignore the portable workflow bundle itself.
	await installActiveMarkerExclude(metadata.gitCommonDir);
	const marker: ActiveWorkflowMarker = {
		...previous,
		...locatorFrom(metadata),
		...(Object.hasOwn(metadata, "pullRequests") ? { pullRequests: metadata.pullRequests } : {}),
	};
	const markerPath = activeWorkflowMarkerPath(metadata.worktreePath);
	let createdMarker = false;
	if (previous) {
		await writeJsonIfChanged(markerPath, marker);
	} else {
		try {
			await writeAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`, true);
			createdMarker = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const concurrent = requireActiveMarker(metadata.worktreePath, metadata.identifier);
			if (!sameLocation(concurrent, metadata)) throw new Error("Workflow registration conflicts with the active marker.");
		}
	}
	try {
		await writeLocator(marker, true);
	} catch (error) {
		if (createdMarker) await rm(markerPath, { force: true });
		throw error;
	}
}

/** Removes only the global pointer, for initialization rollback or completed cleanup. */
export async function unregisterWorkflow(identifier: string): Promise<void> {
	await rm(workflowRegistryFiles(identifier).locator, { force: true });
}

/**
 * The marker is the sole authority for current-worktree discovery. In particular,
 * committed .workflows/<id> directories never imply an active workflow.
 * A fresh Pi process can rebuild the disposable registry from this marker alone.
 */
export async function readActiveWorkflow(worktreeRoot: string): Promise<CompletedWorkflowMetadata | undefined> {
	const marker = readActiveMarker(worktreeRoot);
	if (!marker) return undefined;
	const files = workflowFiles(marker.identifier, worktreeRoot);
	const metadata = await readWorkflowMetadata(files);
	if (isDraftWorkflowMetadata(metadata)) throw new Error("An active workflow cannot be a draft.");
	await assertLocatorAvailable(marker);
	await writeLocator(marker);
	return metadata;
}

/** Includes both active planning and approved workflows; skips stale or invalid pointers. */
export async function listCompletedWorkflows(): Promise<CompletedWorkflowMetadata[]> {
	let names: string[];
	try {
		assertNoSymlinks(workflowsRoot(), workflowsRoot());
		names = await readdir(workflowsRoot());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const workflows: CompletedWorkflowMetadata[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const identifier = name.slice(0, -5);
		if (!IDENTIFIER_PATTERN.test(identifier)) continue;
		try {
			workflows.push(await readCompletedWorkflowMetadata(identifier));
		} catch {
			// An index entry is not an artifact backup, nor proof a worktree is active.
		}
	}
	return workflows;
}

export async function readWorkflowMetadata(files: WorkflowFiles): Promise<WorkflowMetadata> {
	const stored = await readStoredMetadata(files);
	if (isDraftMetadataValue(stored)) {
		const metadata = stored as DraftWorkflowMetadata;
		assertDraftMetadataForFiles(files, metadata);
		return metadata;
	}
	const portable = stored as PortableWorkflowMetadata;
	if (basename(dirname(files.root)) !== ".workflows" || basename(files.root) !== portable.identifier) {
		throw new Error(`Workflow ${basename(files.root)} is not a worktree-local workflow bundle.`);
	}
	const worktreePath = dirname(dirname(resolve(files.root)));
	assertFilesEqual(files, workflowFiles(portable.identifier, worktreePath));
	const marker = requireActiveMarker(worktreePath, portable.identifier);
	return {
		...portable,
		...locatorFrom(marker),
		...(marker.pullRequests === undefined ? {} : { pullRequests: marker.pullRequests }),
	};
}

async function readStoredMetadata(files: WorkflowFiles): Promise<DraftWorkflowMetadata | PortableWorkflowMetadata> {
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
	if (!isDraftMetadataValue(value) && !isPortableMetadataValue(value)) {
		throw new Error(`Workflow ${basename(files.root)} has invalid metadata.`);
	}
	return value as DraftWorkflowMetadata | PortableWorkflowMetadata;
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

async function latestPlanVersionNumber(files: WorkflowFiles): Promise<number> {
	const versions = await listNumberedFiles(files.versions, ".md");
	return versions[versions.length - 1]?.number ?? 0;
}

async function writeVersionFile(files: WorkflowFiles, number: number, content: string): Promise<string> {
	const path = join(files.versions, `${String(number).padStart(4, "0")}.md`);
	assertSafeArtifactPath(path);
	await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	return path;
}

async function listNumberedFiles(
	directory: string,
	extension: string,
): Promise<Array<{ name: string; number: number }>> {
	assertSafeArtifactPath(directory);
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

function isPortableMetadataValue(value: unknown): value is PortableWorkflowMetadata {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<CompletedWorkflowMetadata>;
	return (
		item.version === WORKFLOW_METADATA_VERSION &&
		typeof item.identifier === "string" &&
		IDENTIFIER_PATTERN.test(item.identifier) &&
		typeof item.description === "string" &&
		typeof item.ask === "string" && Boolean(item.ask.trim()) &&
		typeof item.baseBranch === "string" &&
		typeof item.baseCommit === "string" &&
		typeof item.workflowBranch === "string" &&
		typeof item.createdAt === "string" &&
		(item.approvedPlanVersion === undefined ||
			(Number.isSafeInteger(item.approvedPlanVersion) && item.approvedPlanVersion > 0)) &&
		!["draftId", "repositoryRoot", "gitCommonDir", "worktreePath", "pullRequests", "state"].some((key) => key in item)
	);
}

function portableMetadata(metadata: CompletedWorkflowMetadata): PortableWorkflowMetadata {
	return {
		version: metadata.version,
		identifier: metadata.identifier,
		description: metadata.description,
		ask: metadata.ask,
		baseBranch: metadata.baseBranch,
		baseCommit: metadata.baseCommit,
		workflowBranch: metadata.workflowBranch,
		createdAt: metadata.createdAt,
		...(metadata.approvedPlanVersion === undefined ? {} : { approvedPlanVersion: metadata.approvedPlanVersion }),
	};
}

function locatorFrom(metadata: WorkflowLocator): WorkflowLocator {
	return {
		version: WORKFLOW_METADATA_VERSION,
		identifier: metadata.identifier,
		repositoryRoot: resolve(metadata.repositoryRoot),
		gitCommonDir: resolve(metadata.gitCommonDir),
		worktreePath: resolve(metadata.worktreePath),
	};
}

function isLocatorValue(value: unknown): value is WorkflowLocator {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<WorkflowLocator>;
	return item.version === WORKFLOW_METADATA_VERSION &&
		typeof item.identifier === "string" && IDENTIFIER_PATTERN.test(item.identifier) &&
		[item.repositoryRoot, item.gitCommonDir, item.worktreePath].every(
			(path) => typeof path === "string" && isAbsolute(path) && !path.includes("\0"),
		);
}

function assertCompletedMetadata(metadata: CompletedWorkflowMetadata): void {
	assertSupportedMetadataVersion(metadata.version);
	assertMetadataHasAsk(metadata);
	assertIdentifier(metadata.identifier);
	if (!isPortableMetadataValue(portableMetadata(metadata)) || !isLocatorValue(metadata) ||
		!isPullRequestCache(metadata.pullRequests)) {
		throw new Error(`Workflow ${metadata.identifier} has invalid metadata.`);
	}
}

function isPullRequestCache(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.length > 0 && value.every(isWorkflowPullRequest));
}

function readActiveMarker(worktreePath: string): ActiveWorkflowMarker | undefined {
	const path = activeWorkflowMarkerPath(worktreePath);
	const value = readJsonSync(path);
	if (value === undefined) return undefined;
	if (!isLocatorValue(value) || !isPullRequestCache((value as ActiveWorkflowMarker).pullRequests) ||
		pathIdentity(value.worktreePath) !== pathIdentity(worktreePath)) {
		throw new Error(`Workflow active marker is invalid or belongs to another worktree: ${path}`);
	}
	return value as ActiveWorkflowMarker;
}

function requireActiveMarker(worktreePath: string, identifier: string): ActiveWorkflowMarker {
	const marker = readActiveMarker(worktreePath);
	if (!marker || marker.identifier !== identifier) {
		throw new Error(`Workflow ${identifier} has no matching active marker at ${activeWorkflowMarkerPath(worktreePath)}.`);
	}
	return marker;
}

function sameLocation(left: WorkflowLocator, right: WorkflowLocator): boolean {
	return left.identifier === right.identifier &&
		pathIdentity(left.repositoryRoot) === pathIdentity(right.repositoryRoot) &&
		pathIdentity(left.gitCommonDir) === pathIdentity(right.gitCommonDir) &&
		pathIdentity(left.worktreePath) === pathIdentity(right.worktreePath);
}

function pathIdentity(path: string): string {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
		throw error;
	}
}

async function assertLocatorAvailable(metadata: WorkflowLocator): Promise<void> {
	let existing: WorkflowLocator;
	try {
		existing = resolveWorkflowLocator(metadata.identifier);
	} catch {
		// Missing, stale, or corrupt locators are disposable and may be rebuilt.
		return;
	}
	if (!sameLocation(existing, metadata)) {
		throw new Error(`Workflow identifier ${metadata.identifier} is already active at ${existing.worktreePath}.`);
	}
}

async function writeLocator(metadata: WorkflowLocator, exclusive = false): Promise<void> {
	const path = workflowRegistryFiles(metadata.identifier).locator;
	const locator = locatorFrom(metadata);
	if (exclusive) {
		try {
			await writeAtomically(path, `${JSON.stringify(locator, null, 2)}\n`, true);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await assertLocatorAvailable(metadata);
		}
	}
	await writeJsonIfChanged(path, locator);
}

async function writeJsonIfChanged(path: string, value: unknown): Promise<void> {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (await readText(path) !== content) await atomicWrite(path, content);
}

async function installActiveMarkerExclude(gitCommonDir: string): Promise<void> {
	const path = join(gitCommonDir, "info", "exclude");
	assertNoSymlinks(gitCommonDir, path);
	const content = await readText(path);
	const rule = "/.workflows/active.json";
	if (content.split("\n").some((line) => line.trim() === rule)) return;
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${content && !content.endsWith("\n") ? "\n" : ""}${rule}\n`, "utf8");
}

function readJsonSync(path: string): unknown {
	assertSafeArtifactPath(path);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Workflow file has invalid JSON: ${path}`);
	}
}

function existsSync(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function assertFilesEqual(files: WorkflowFiles, expected: WorkflowFiles): void {
	for (const key of Object.keys(expected) as Array<keyof WorkflowFiles>) {
		if (resolve(files[key]) !== expected[key]) throw new Error(`Invalid workflow artifact path: ${files[key]}`);
		assertSafeArtifactPath(files[key]);
	}
}

/** Reject symlinked artifacts/directories without rejecting OS aliases such as macOS /tmp. */
function assertNoSymlinks(root: string, path: string): void {
	const base = resolve(root);
	const suffix = relative(base, resolve(path));
	if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
		throw new Error(`Workflow path escapes its root: ${path}`);
	}
	let current = base;
	for (const part of ["", ...suffix.split(sep).filter(Boolean)]) {
		if (part) current = join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) throw new Error(`Workflow paths cannot be symbolic links: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

function assertSafeArtifactPath(path: string): void {
	const absolute = resolve(path);
	const parts = absolute.split(sep);
	const localIndex = parts.indexOf(".workflows");
	if (localIndex >= 0) {
		assertNoSymlinks(parts.slice(0, localIndex).join(sep) || sep, absolute);
	} else {
		const registry = resolve(workflowsRoot());
		if (absolute === registry || absolute.startsWith(`${registry}${sep}`)) assertNoSymlinks(registry, absolute);
		else assertNoSymlinks(absolute, absolute);
	}
}
