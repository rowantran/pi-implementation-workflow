import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants, lstatSync, readlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	isPlanObject, isPlannedChangeId, PlanValidationError, planValidationErrors,
	renderPlanMarkdown, unknownFieldErrors, validatePlanDocument, type PlanDocument, type PlannedChange,
} from "./planned-changes.ts";
import type { WorkflowFiles } from "./storage.ts";

export type { PlanDocument, PlannedChange } from "./planned-changes.ts";
export interface PlanVersion {
	number: number;
	createdAt: string;
	/** The immutable directory, not the latest-plan alias. */
	path: string;
	/** Generated for presentation only. Never parsed back into a plan. */
	content: string;
	document: PlanDocument;
	description: string;
}
export interface PlanDraft { path: string; baseVersion: number }
/** Phase authorization is checked by the caller; publication enforces field policy inside its lock. */
export type PlanPublicationPolicy =
	| { phase: "planning" }
	| { phase: "review"; reviewOrigin: { reviewNumber: number; sessionId: string; entryIds: readonly string[] } }
	| { phase: "implementation" };
interface Snapshot { files: Map<string, string>; directories: Set<string>; errors: string[] }
interface VersionMetadata { schemaVersion: 1; number: number; createdAt: string; description: string; digest: string }
const VERSION_METADATA = "version-metadata.json";
const DRAFT_BASE_SCHEMA_VERSION = 1;

/** For prompt paths only. Extension reads resolve and validate the pointer separately. */
export function planDirectory(files: WorkflowFiles, version?: number): string {
	assertPlanStoragePaths(files);
	if (version === undefined) return files.latestPlan;
	assertVersionNumber(version);
	return join(files.versions, `v${version}`);
}

/** The only permitted artifact symlink: this exact relative target, under this bundle. */
export function latestPlanVersionNumber(files: WorkflowFiles): number {
	assertPlanStoragePaths(files);
	let info;
	try { info = lstatSync(files.latestPlan); }
	catch (error) { if (missing(error)) return 0; throw error; }
	if (!info.isSymbolicLink()) throw new Error(`latest-plan must be a tool-managed relative symbolic link: ${files.latestPlan}`);
	const target = readlinkSync(files.latestPlan);
	const match = /^plan-versions\/v([1-9]\d*)$/.exec(target);
	if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Unsafe latest-plan symbolic link target: ${JSON.stringify(target)}`);
	const number = Number(match[1]);
	const path = planDirectory(files, number);
	assertSafePlanPath(path);
	try {
		if (!lstatSync(path).isDirectory()) throw new Error(`latest-plan target is not a real directory: ${path}`);
	} catch (error) {
		if (missing(error)) throw new Error(`latest-plan target is missing: ${path}`);
		throw error;
	}
	return number;
}

/** No finalized placeholder exists before the first successful finalize. */
export async function readPlanVersion(files: WorkflowFiles, number?: number): Promise<PlanVersion | undefined> {
	if (number !== undefined) {
		const path = planDirectory(files, number);
		assertSafePlanPath(path);
		return await exists(path) ? readPublishedVersion(files, number) : undefined;
	}
	const latest = latestPlanVersionNumber(files);
	return latest === 0 ? undefined : readPublishedVersion(files, latest);
}

export async function listPlanVersions(files: WorkflowFiles): Promise<PlanVersion[]> {
	const latest = latestPlanVersionNumber(files);
	const result: PlanVersion[] = [];
	for (let number = 1; number <= latest; number++) result.push(await readPublishedVersion(files, number));
	return result;
}

/** Existing edits are preserved, including invalid drafts and drafts based on older versions. */
export async function preparePlanDraft(files: WorkflowFiles): Promise<PlanDraft> {
	return withPlanLock(files, async () => {
		const latest = await readPlanVersion(files);
		if (await exists(files.workingPlan)) {
			assertRealDirectory(files.workingPlan);
			// A successful finalize may leave its old base record behind. Refresh it
			// only when the draft exactly matches the published snapshot, never on edits.
			if (latest && await draftMatchesVersion(files, latest.number)) {
				const snapshot = await captureDirectory(files.workingPlan, false);
				const upgraded = upgradeLegacySnapshot(snapshot);
				if (snapshotDigest(snapshot) !== snapshotDigest(upgraded)) await replaceUnchangedDraft(files, snapshot, upgraded);
				await writeDraftBase(files, latest.number);
				return { path: files.workingPlan, baseVersion: latest.number };
			}
			return { path: files.workingPlan, baseVersion: await readDraftBase(files) };
		}
		const baseVersion = latest?.number ?? 0;
		const temporary = join(files.root, `.plan-prepare-${randomUUID()}`);
		try {
			if (latest) {
				const snapshot = await captureDirectory(latest.path, true);
				snapshot.files.delete(VERSION_METADATA);
				await writeSnapshot(temporary, upgradeLegacySnapshot(snapshot));
			} else {
				await writeSnapshot(temporary, skeleton());
			}
			await writeDraftBase(files, baseVersion);
			assertSafePlanPath(files.workingPlan);
			await rename(temporary, files.workingPlan);
		} finally { await rm(temporary, { recursive: true, force: true }); }
		return { path: files.workingPlan, baseVersion };
	});
}

/** Invalid drafts count as unsaved. Reads never repair the draft or its base record. */
export async function hasUnsavedPlanDraft(files: WorkflowFiles): Promise<boolean> {
	assertPlanStoragePaths(files);
	if (!await exists(files.workingPlan)) return false;
	const latest = await readPlanVersion(files);
	return !latest || !await draftMatchesVersion(files, latest.number);
}

/**
 * Validate an isolated snapshot, then publish its pointer as the last fallible
 * operation. The lock is cross-process; every expected base is checked inside
 * it. Nothing in a previously published version is ever rewritten or linked
 * into the mutable draft. Failed attempts leave the draft and published state alone.
 */
export async function finalizePlanDraft(
	files: WorkflowFiles,
	description: string,
	expectedBaseVersion: number,
	policy: PlanPublicationPolicy = { phase: "planning" },
): Promise<PlanVersion> {
	if (!Number.isSafeInteger(expectedBaseVersion) || expectedBaseVersion < 0) throw new Error("expectedBaseVersion must be a nonnegative integer (0 for the initial draft).");
	return withPlanLock(files, async () => {
		// Approval and finalization share this lock. A tool-level check before
		// acquiring it cannot prevent a concurrent approval from winning the race.
		const workflowMetadata: unknown = JSON.parse(await readRegularFile(files.metadata));
		if (!isPlanObject(workflowMetadata)) throw new Error(`Invalid workflow metadata: ${files.metadata}`);
		if (!["planning", "review", "implementation"].includes(policy.phase)) throw new Error("Invalid plan publication phase.");
		const approvedNumber = workflowMetadata.approvedPlanVersion;
		if (policy.phase === "planning" && approvedNumber !== undefined) throw new Error("The workflow plan is approved and cannot be finalized again in planning.");
		if (policy.phase !== "planning" && (!Number.isSafeInteger(approvedNumber) || (approvedNumber as number) < 1)) throw new Error("Review and implementation publication require an approved plan.");
		const latest = latestPlanVersionNumber(files);
		const base = await readDraftBase(files);
		if (base !== expectedBaseVersion || latest !== expectedBaseVersion) {
			throw new Error(`Stale plan draft: expected base v${expectedBaseVersion}, draft base v${base}, latest v${latest}. No plan was published. Preserve your edits and prepare a fresh draft from the latest version before retrying.`);
		}
		// Detect corruption of the base and post-approval history before publishing.
		const previous = latest ? await readPublishedVersion(files, latest) : undefined;
		let approved: PlanVersion | undefined;
		if (policy.phase !== "planning") {
			if ((approvedNumber as number) > latest) throw new Error("The approved plan is newer than latest-plan.");
			approved = await readPublishedVersion(files, approvedNumber as number);
			await validatePublishedHistory(files, approved, previous!, String(workflowMetadata.ask ?? ""));
		}
		const snapshot = await captureDirectory(files.workingPlan, false);
		const errors = [...snapshot.errors];
		const document = documentFromSnapshot(snapshot, errors);
		if (typeof description !== "string" || !description.trim()) errors.push("description: provide a nonempty description when finalizing");
		if (errors.length) throw new PlanValidationError([...new Set(errors)]);
		if (policy.phase === "planning") {
			if (document!.changes.some((change) => change.implemented || change.followup)) throw new PlanValidationError(["Initial planning cannot add followups or mark changes implemented."]);
		} else {
			validateSnapshotEvolution(approved!.document, previous!.document, document!, String(workflowMetadata.ask ?? ""));
			if (policy.phase === "implementation") validateImplementationDraft(previous!.document, document!);
			else validateReviewDraft(previous!.document, document!, policy.reviewOrigin);
		}
		const number = latest + 1;
		assertVersionNumber(number);
		const path = planDirectory(files, number);
		assertSafePlanPath(path);
		if (await exists(path)) throw new Error(`Cannot overwrite immutable plan version v${number}: ${path}. An unpublished snapshot may need manual cleanup.`);
		const facts = { schemaVersion: 1 as const, number, createdAt: new Date().toISOString(), description: description.trim() };
		const metadata: VersionMetadata = { ...facts, digest: versionDigest(snapshot, facts) };
		const version: PlanVersion = { number, createdAt: metadata.createdAt, path, content: renderPlanMarkdown(document!), document: document!, description: metadata.description };
		const temporary = join(files.root, `.plan-publish-${randomUUID()}`);
		const pointer = join(files.root, `.latest-plan-${randomUUID()}.tmp`);
		let renamed = false;
		let published = false;
		try {
			await writeSnapshot(temporary, snapshot);
			await writeFile(join(temporary, VERSION_METADATA), json(metadata), { flag: "wx" });
			const current = await captureDirectory(files.workingPlan, false);
			if (current.errors.length || snapshotDigest(current) !== snapshotDigest(snapshot)) {
				throw new Error("The working plan changed during finalize. No plan was published; retry after editing finishes.");
			}
			assertPlanStoragePaths(files);
			if (latestPlanVersionNumber(files) !== latest) throw new Error("Stale plan pointer changed during finalize; no plan was published.");
			await mkdir(files.versions, { recursive: true });
			if (await exists(path)) throw new Error(`Cannot overwrite immutable plan version v${number}: ${path}`);
			await rename(temporary, path);
			renamed = true;
			await symlink(`plan-versions/v${number}`, pointer, "dir");
			// Publication is a single atomic rename. Do not make draft/base/export
			// updates afterward: their failure must never report a published plan as failed.
			await rename(pointer, files.latestPlan);
			published = true;
			return version;
		} finally {
			await rm(pointer, { force: true }).catch(() => undefined);
			await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
			if (renamed && !published) await rm(path, { recursive: true, force: true }).catch(() => undefined);
		}
	});
}

/** Requirement evolution is independent of a live session, so saved history stays portable. */
export function validateSnapshotEvolution(approvedInput: PlanDocument, previousInput: PlanDocument, candidateInput: PlanDocument, originalAsk: string): void {
	const approved = validatePlanDocument(approvedInput, { originalAsk });
	const previous = validatePlanDocument(previousInput, { originalAsk });
	const candidate = validatePlanDocument(candidateInput, { originalAsk });
	const errors: string[] = [];
	if (approved.changes.some((change) => change.followup)) errors.push("The original approved plan cannot contain followups.");
	if (previous.schemaVersion === 2 && candidate.schemaVersion !== 2) errors.push("A schemaVersion 2 plan cannot be downgraded.");
	for (const field of ["goal", "intro", "testing"] as const) if (approved[field] !== candidate[field]) errors.push(`Original ${field}.md must remain byte-identical to the approved plan.`);
	if (!isDeepStrictEqual(candidate.readingOrder.slice(0, approved.readingOrder.length), approved.readingOrder)) errors.push("Original IDs must remain the original prefix of readingOrder.");
	const originals = new Map(approved.changes.map((change) => [change.id, change]));
	const current = new Map(candidate.changes.map((change) => [change.id, change]));
	for (const [id, original] of originals) {
		const change = current.get(id);
		if (!change || !isDeepStrictEqual(changeDefinition(original), changeDefinition(change))) errors.push(`${id}: original requirements and metadata except implemented must remain unchanged; originals cannot be reclassified as followups.`);
	}
	for (const change of candidate.changes) if (!originals.has(change.id) && !change.followup) errors.push(`${change.id}: new requirements must be followups.`);
	for (const change of previous.changes) {
		const next = current.get(change.id);
		if (!next) errors.push(`${change.id}: published IDs must be retained; deleting or renaming a published change is not allowed.`);
		else if (change.followup && !isDeepStrictEqual(change.followup.origin, next.followup?.origin)) errors.push(`${change.id}: published followup origin must remain unchanged.`);
	}
	if (errors.length) throw new PlanValidationError(errors);
}

/** Implementation changes assessments only, including during a supported v1 -> v2 conversion. */
export function validateImplementationDraft(previousInput: PlanDocument, candidateInput: PlanDocument): void {
	const previous = validatePlanDocument(previousInput);
	const candidate = validatePlanDocument(candidateInput);
	const errors: string[] = [];
	if (previous.schemaVersion === 2 && candidate.schemaVersion !== 2) errors.push("Implementation cannot downgrade the plan schema.");
	const requirements = (document: PlanDocument) => ({
		readingOrder: document.readingOrder, goal: document.goal, intro: document.intro,
		testing: document.testing, changes: document.changes.map(changeDefinition),
	});
	if (!isDeepStrictEqual(requirements(previous), requirements(candidate))) errors.push("Implementation may change only implemented fields; IDs, reading order, requirement prose, and all other metadata must remain unchanged.");
	if (errors.length) throw new PlanValidationError(errors);
}

function changeDefinition(change: PlannedChange): Omit<PlannedChange, "implemented"> {
	const { implemented: _implemented, ...definition } = change;
	return definition;
}

function validateReviewDraft(previous: PlanDocument, candidate: PlanDocument, context: Extract<PlanPublicationPolicy, { phase: "review" }>["reviewOrigin"]): void {
	if (!context || !Number.isSafeInteger(context.reviewNumber) || context.reviewNumber < 1 || typeof context.sessionId !== "string" || !context.sessionId.trim() || !Array.isArray(context.entryIds) || context.entryIds.some((id) => typeof id !== "string" || !id.trim())) throw new PlanValidationError(["Review publication requires a valid reviewOrigin context."]);
	const previousById = new Map(previous.changes.map((change) => [change.id, change]));
	const entryIds = new Set(context.entryIds);
	const errors: string[] = [];
	for (const change of candidate.changes) {
		const old = previousById.get(change.id);
		if (!old) {
			const origin = change.followup?.origin;
			if (!origin || origin.reviewNumber !== context.reviewNumber || origin.sessionId !== context.sessionId || !entryIds.has(origin.entryId)) errors.push(`${change.id}: new followup origin must reference this saved review and a current session entry.`);
			if (change.implemented) errors.push(`${change.id}: new followups must start with implemented: false.`);
		} else if (!isDeepStrictEqual(changeDefinition(old), changeDefinition(change))) {
			if (!old.followup) errors.push(`${change.id}: review cannot edit original requirements.`);
			if (change.implemented) errors.push(`${change.id}: revised followup requirements must explicitly reset implemented to false.`);
		} else if (change.implemented !== old.implemented) errors.push(`${change.id}: review cannot change implemented without revising that followup's requirements.`);
	}
	if (errors.length) throw new PlanValidationError(errors);
}

/** Validate every post-approval transition using exact immutable versions, never rereading latest-plan. */
export async function validatePublishedHistory(files: WorkflowFiles, approved: PlanVersion, current: PlanVersion, originalAsk: string): Promise<void> {
	if (current.number < approved.number) throw new Error("The current plan predates its approved baseline.");
	validateSnapshotEvolution(approved.document, approved.document, approved.document, originalAsk);
	let previous = approved;
	for (let number = approved.number + 1; number <= current.number; number++) {
		const next = number === current.number ? current : await readPublishedVersion(files, number);
		validateSnapshotEvolution(approved.document, previous.document, next.document, originalAsk);
		previous = next;
	}
}

async function readPublishedVersion(files: WorkflowFiles, number: number): Promise<PlanVersion> {
	const path = planDirectory(files, number);
	const snapshot = await captureDirectory(path, true);
	const errors = [...snapshot.errors];
	const document = documentFromSnapshot(snapshot, errors);
	const value = parseJson(snapshot, VERSION_METADATA, errors);
	if (value) {
		errors.push(...unknownFieldErrors(value, ["schemaVersion", "number", "createdAt", "description", "digest"], VERSION_METADATA));
		if (value.schemaVersion !== 1 || value.number !== number || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
			(typeof value.description !== "string" || !value.description.trim()) || typeof value.digest !== "string") {
			errors.push(`${VERSION_METADATA}: invalid tool-owned version metadata`);
		}
		if (value.digest !== versionDigest(snapshot, value)) errors.push(`v${number}: immutable finalized plan was modified (snapshot digest mismatch)`);
	}
	if (errors.length) throw new PlanValidationError([...new Set(errors)]);
	const metadata = value as unknown as VersionMetadata;
	return { number, path, createdAt: metadata.createdAt, document: document!, content: renderPlanMarkdown(document!), description: metadata.description };
}

function documentFromSnapshot(snapshot: Snapshot, errors: string[]): PlanDocument | undefined {
	const manifest = parseJson(snapshot, "plan.json", errors);
	if (manifest) errors.push(...unknownFieldErrors(manifest, ["schemaVersion", "readingOrder"], "plan.json"));
	const changes: unknown[] = [];
	for (const directory of [...snapshot.directories].filter((path) => /^planned-changes\/[^/]+$/.test(path)).sort()) {
		const id = directory.slice("planned-changes/".length);
		const metadata = parseJson(snapshot, `${directory}/change_metadata.json`, errors);
		if (metadata) errors.push(...unknownFieldErrors(metadata, manifest?.schemaVersion === 1 ? ["title", "dependsOn"] : ["title", "dependsOn", "implemented", "followup"], `${directory}/change_metadata.json`));
		changes.push({ id, ...metadata, content: snapshot.files.get(`${directory}/change.md`),
			...(snapshot.files.has(`${directory}/testing.md`) ? { testing: snapshot.files.get(`${directory}/testing.md`) } : {}),
		});
	}
	const value = {
		schemaVersion: manifest?.schemaVersion, readingOrder: manifest?.readingOrder,
		goal: snapshot.files.get("goal.md"), testing: snapshot.files.get("testing.md"),
		...(snapshot.files.has("intro.md") ? { intro: snapshot.files.get("intro.md") } : {}), changes,
	};
	const validation = planValidationErrors(value);
	errors.push(...validation);
	return validation.length ? undefined : validatePlanDocument(value);
}

function parseJson(snapshot: Snapshot, path: string, errors: string[]): Record<string, unknown> | undefined {
	const text = snapshot.files.get(path);
	if (text === undefined) { errors.push(`${path}: required JSON file is missing`); return undefined; }
	try {
		const value: unknown = JSON.parse(text);
		if (!isPlanObject(value)) { errors.push(`${path}: expected a JSON object`); return undefined; }
		return value;
	} catch { errors.push(`${path}: invalid JSON`); return undefined; }
}

/** Traverse only the schema's directories. Never follow links or open devices/FIFOs. */
async function captureDirectory(root: string, published: boolean): Promise<Snapshot> {
	const snapshot: Snapshot = { files: new Map(), directories: new Set(), errors: [] };
	async function directory(path: string, suffix: string): Promise<void> {
		try {
			assertSafePlanPath(path);
			assertRealDirectory(path);
			const entries = await readdir(path, { withFileTypes: true });
			const required = suffix === "" ? ["plan.json", "goal.md", "testing.md", "planned-changes", ...(published ? [VERSION_METADATA] : [])]
				: suffix === "planned-changes" ? [] : ["change_metadata.json", "change.md"];
			for (const name of required) if (!entries.some((entry) => entry.name === name)) snapshot.errors.push(`${suffix ? `${suffix}/` : ""}${name}: required ${name === "planned-changes" ? "directory" : "file"} is missing`);
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				const key = suffix ? `${suffix}/${entry.name}` : entry.name;
				const child = join(path, entry.name);
				const allowed = suffix === "" ? [...required, "intro.md"].includes(entry.name)
					: suffix === "planned-changes" ? isPlannedChangeId(entry.name) : [...required, "testing.md"].includes(entry.name);
				if (!allowed) { snapshot.errors.push(`${key}: unexpected path${suffix === "planned-changes" ? "; change directories must use lowercase kebab-case slugs starting with a letter (at most 80 characters)" : ""}`); continue; }
				try {
					assertSafePlanPath(child);
					const info = await lstat(child);
					const isDirectory = key === "planned-changes" || suffix === "planned-changes";
					if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
					if (isDirectory) {
						if (!info.isDirectory()) throw new Error("expected a real directory");
						snapshot.directories.add(key);
						await directory(child, key);
					} else {
						if (!info.isFile()) throw new Error("expected a regular file");
						snapshot.files.set(key, await readRegularFile(child));
					}
				} catch (error) { snapshot.errors.push(`${key}: ${message(error)}`); }
			}
		} catch (error) { snapshot.errors.push(`${suffix || root}: ${message(error)}`); }
	}
	await directory(root, "");
	return snapshot;
}

async function readRegularFile(path: string): Promise<string> {
	assertSafePlanPath(path);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Expected a regular file: ${path}`);
		if (info.nlink !== 1) throw new Error(`Hard links are not allowed: ${path}`);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await handle.readFile());
	} finally { await handle.close(); }
}

function skeleton(): Snapshot {
	return { files: new Map([["plan.json", json({ schemaVersion: 2, readingOrder: [] })], ["goal.md", ""], ["testing.md", ""]]), directories: new Set(["planned-changes"]), errors: [] };
}

async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
	assertSafePlanPath(path);
	await mkdir(path);
	for (const directory of [...snapshot.directories].sort()) await mkdir(join(path, directory));
	for (const [name, content] of snapshot.files) await writeFile(join(path, name), content, { encoding: "utf8", flag: "wx" });
}

function snapshotDigest(snapshot: Snapshot): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify([...snapshot.directories].sort()));
	for (const [name, content] of [...snapshot.files].filter(([name]) => name !== VERSION_METADATA).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify([name, content]));
	return hash.digest("hex");
}

function versionDigest(snapshot: Snapshot, metadata: Record<string, unknown>): string {
	return createHash("sha256").update(snapshotDigest(snapshot)).update(JSON.stringify([
		metadata.schemaVersion, metadata.number, metadata.createdAt, metadata.description,
	])).digest("hex");
}

async function draftMatchesVersion(files: WorkflowFiles, number: number): Promise<boolean> {
	const draft = await captureDirectory(files.workingPlan, false);
	if (draft.errors.length) return false;
	const saved = await captureDirectory(planDirectory(files, number), true);
	return !saved.errors.length && (snapshotDigest(draft) === snapshotDigest(saved) || snapshotDigest(draft) === snapshotDigest(upgradeLegacySnapshot(saved)));
}

/** Conversion changes only the editable manifest and metadata; legacy snapshots stay byte-identical. */
function upgradeLegacySnapshot(snapshot: Snapshot): Snapshot {
	const errors = [...snapshot.errors];
	const document = documentFromSnapshot(snapshot, errors);
	if (errors.length || document?.schemaVersion !== 1) return snapshot;
	const upgraded: Snapshot = { files: new Map(snapshot.files), directories: new Set(snapshot.directories), errors: [] };
	upgraded.files.set("plan.json", json({ schemaVersion: 2, readingOrder: document.readingOrder }));
	for (const change of document.changes) upgraded.files.set(`planned-changes/${change.id}/change_metadata.json`, json({ title: change.title, dependsOn: change.dependsOn, implemented: false }));
	return upgraded;
}

async function replaceUnchangedDraft(files: WorkflowFiles, original: Snapshot, upgraded: Snapshot): Promise<void> {
	const temporary = join(files.root, `.plan-prepare-${randomUUID()}`);
	const backup = join(files.root, `.plan-backup-${randomUUID()}`);
	let moved = false;
	try {
		await writeSnapshot(temporary, upgraded);
		const current = await captureDirectory(files.workingPlan, false);
		if (current.errors.length || snapshotDigest(current) !== snapshotDigest(original)) throw new Error("The working plan changed during prepare; preserve your edits and retry.");
		await rename(files.workingPlan, backup);
		moved = true;
		try { await rename(temporary, files.workingPlan); }
		catch (error) { await rename(backup, files.workingPlan); moved = false; throw error; }
	} finally {
		await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		if (moved) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function readDraftBase(files: WorkflowFiles): Promise<number> {
	let value: unknown;
	try { value = JSON.parse(await readRegularFile(files.planDraftBase)); }
	catch (error) { throw new Error(`Cannot read tool-owned plan draft base ${files.planDraftBase}: ${message(error)}. Preserve your edits before preparing a fresh draft.`); }
	if (!isPlanObject(value) || value.schemaVersion !== DRAFT_BASE_SCHEMA_VERSION || !Number.isSafeInteger(value.baseVersion) || (value.baseVersion as number) < 0 || unknownFieldErrors(value, ["schemaVersion", "baseVersion"], "draft base").length) throw new Error(`Invalid tool-owned plan draft base: ${files.planDraftBase}`);
	return value.baseVersion as number;
}

async function writeDraftBase(files: WorkflowFiles, baseVersion: number): Promise<void> {
	assertSafePlanPath(files.planDraftBase);
	const temporary = join(files.root, `.plan-base-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, json({ schemaVersion: DRAFT_BASE_SCHEMA_VERSION, baseVersion }), { flag: "wx" });
		assertSafePlanPath(files.planDraftBase);
		await rename(temporary, files.planDraftBase);
	} finally { await rm(temporary, { force: true }); }
}

/** Shared cross-process lock for prepare/finalize and approval transactions. Not reentrant. */
export async function withPlanLock<T>(files: WorkflowFiles, action: () => Promise<T>): Promise<T> {
	assertPlanStoragePaths(files);
	await mkdir(files.root, { recursive: true });
	const path = join(files.root, ".plan.lock");
	assertSafePlanPath(path);
	let handle;
	try { handle = await open(path, "wx"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Plan storage is locked by another prepare/finalize operation: ${path}. Retry after it finishes; remove a stale lock only after confirming its owner has stopped.`);
		throw error;
	}
	try { await handle.writeFile(json({ pid: process.pid, createdAt: new Date().toISOString() })); return await action(); }
	finally { await handle.close().catch(() => undefined); await rm(path, { force: true }).catch(() => undefined); }
}

function assertPlanStoragePaths(files: WorkflowFiles): void {
	if (!isAbsolute(files.root)) throw new Error(`Workflow root must be absolute: ${files.root}`);
	for (const [key, name] of [["plan", "latest-plan"], ["workingPlan", "working-plan"], ["versions", "plan-versions"], ["latestPlan", "latest-plan"], ["planDraftBase", ".plan-draft-base.json"], ["metadata", "metadata.json"]] as const) {
		if (files[key] !== join(files.root, name)) throw new Error(`Invalid workflow plan path: ${files[key]}`);
	}
	// Reads of immutable versions are independent of both the draft and alias.
	// Operations on mutable paths validate those paths immediately before use.
	assertSafePlanPath(files.root);
	assertSafePlanPath(files.versions);
}

function assertRealDirectory(path: string): void {
	assertSafePlanPath(path);
	if (!lstatSync(path).isDirectory()) throw new Error(`Expected a real directory: ${path}`);
}

/** Preserve OS aliases above the worktree/registry, but reject all bundle symlinks. */
function assertSafePlanPath(path: string): void {
	const absolute = resolve(path);
	const parts = absolute.split(sep);
	const index = parts.findIndex((part) => part === ".workflows" || part === ".drafts");
	const base = index >= 0 ? parts.slice(0, index).join(sep) || sep : absolute;
	const suffix = relative(base, absolute);
	let current = base;
	for (const part of ["", ...suffix.split(sep).filter(Boolean)]) {
		if (part) current = join(current, part);
		try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Workflow paths cannot be symbolic links: ${current}`); }
		catch (error) { if (missing(error)) return; throw error; }
	}
}

function assertVersionNumber(number: number): void {
	if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid plan version number: ${number}`);
}
async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
