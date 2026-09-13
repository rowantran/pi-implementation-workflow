import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti/static";
import { makePlanDocument, writePlanDocument } from "./fixtures/plan-document.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-storage-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const { resolveWorkflow, workflowIdentifierCompletions } = await jiti.import(
	new URL("../src/workflow-select.ts", import.meta.url).pathname,
);
const {
	WORKFLOW_METADATA_VERSION, activeWorkflowMarkerPath, appendClarifications, appendWorkflowReview,
	atomicWrite, createDraft, createWorkflow, draftFiles, ensureWorkflowFiles, listCompletedWorkflows,
	listPlanVersions, listSavedReviews, readActiveWorkflow, readCompletedWorkflowMetadata,
	readWorkflowMetadata, readWorkflowReview, registerWorkflow, resolveWorkflowLocator,
	finalizePlanDraft, preparePlanDraft, unregisterWorkflow, workflowFiles, workflowRegistryFiles, workflowsRoot,
	writeCompletedWorkflowMetadata, writeDraftWorkflowMetadata,
} = storage;
const exec = promisify(execFile);
const ask = 'Preserve this ask exactly.\n\n- Keep <markup> & "quotes".\n';

async function exists(path) {
	try { await access(path); return true; } catch { return false; }
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function snapshot(root) {
	const result = {};
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		result[entry.name] = entry.isSymbolicLink() ? { link: await readlink(path) } : entry.isDirectory() ? await snapshot(path) : {
			content: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs,
		};
	}
	return result;
}
function metadataFor(identifier, repositoryRoot, overrides = {}) {
	return {
		version: WORKFLOW_METADATA_VERSION, identifier, description: `Plan ${identifier}`, ask,
		repositoryRoot, gitCommonDir: join(repositoryRoot, ".git"), baseBranch: "main", baseCommit: "abc123",
		workflowBranch: `workflow/${identifier}`, worktreePath: join(repositoryRoot, ".worktrees", identifier),
		createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
	};
}
async function initialize(metadata) {
	await mkdir(metadata.worktreePath, { recursive: true });
	const files = workflowFiles(metadata.identifier, metadata.worktreePath);
	await createWorkflow(files, metadata);
	await registerWorkflow(metadata);
	return files;
}
function sampleReview(overrides = {}) {
	const yes = { status: "yes", explanation: "Covered by the plan." };
	return {
		version: 3, pullRequestUrls: ["https://example.test/pull/1"], baseCommit: "abc123",
		headCommit: "def456", sourceFingerprint: "source789", generatedAt: "2026-01-03T00:00:00.000Z",
		overallResult: { summary: "The implementation matches the plan.", necessary: yes, sufficient: yes },
		overallConcerns: [],
		holisticReview: { summary: "Coherent implementation.", necessary: yes, sufficient: yes, concerns: [] },
		plannedChanges: [{
			id: "store-report", title: "Store the report", dependsOn: [], content: "Store a report to keep the review durable.\n\n```ts\nsave(report);\n```", review: {
				id: "store-report", title: "Store the report", walkthrough: "Stored as JSON and Markdown.",
				necessary: yes, sufficient: yes, concerns: [],
			},
		}],
		testingCriteria: {
			originalCriteria: "Verify the stored report.", review: {
				summary: "The report storage test passes.", satisfied: yes,
				criteria: [{ criterion: "Verify the stored report.", status: "yes", explanation: "Both formats verified.",
					evidence: [{ location: "scripts/storage.mjs:1", description: "Verifies report files." }] }], concerns: [],
			},
		}, ...overrides,
	};
}

try {
	assert.equal(WORKFLOW_METADATA_VERSION, 6);
	assert.throws(() => workflowFiles("unknown"), /no locator/);
	for (const identifier of ["../escape", "a/b", "a\\b", "UPPER", ".", "a".repeat(81)]) {
		assert.throws(() => workflowFiles(identifier, temporaryRoot), /identifiers/);
		assert.throws(() => workflowRegistryFiles(identifier), /identifiers/);
	}
	assert.throws(() => workflowFiles("valid", "relative/path"), /absolute/);

	// Draft exports remain available for fixtures, not as the runtime planning flow.
	const draft = draftFiles("fixture-draft");
	const draftMetadata = { version: 6, draftId: "fixture-draft", description: "Fixture", ask, createdAt: "2026-01-01" };
	await createDraft(draft, draftMetadata);
	assert.deepEqual(await readWorkflowMetadata(draft), draftMetadata);
	await assert.rejects(writeDraftWorkflowMetadata(draft, { ...draftMetadata, ask: "changed" }), /immutable/);

	// A new workflow is allocated directly inside its worktree, without a global artifact directory.
	const repositoryRoot = join(temporaryRoot, "repository");
	await mkdir(repositoryRoot);
	await exec("git", ["init", "-q", repositoryRoot]);
	await writeFile(join(repositoryRoot, ".gitignore"), ".workflows/\n");
	const metadata = metadataFor("local-planning", repositoryRoot);
	const files = workflowFiles(metadata.identifier, metadata.worktreePath);
	await mkdir(metadata.worktreePath, { recursive: true });
	await createWorkflow(files, metadata);
	assert.equal(files.root, join(metadata.worktreePath, ".workflows", metadata.identifier));
	assert.equal(await exists(join(workflowsRoot(), metadata.identifier)), false);
	assert.equal(await exists(activeWorkflowMarkerPath(metadata.worktreePath)), false);
	assert.equal(await exists(files.plan), false);
	assert.equal((await stat(files.workingPlan)).isDirectory(), true);
	assert.deepEqual(await json(join(files.workingPlan, "plan.json")), { schemaVersion: 2, readingOrder: [] });
	assert.deepEqual(await listPlanVersions(files), []);
	assert.deepEqual(await json(files.clarifications), { version: 1, entries: [] });
	await assert.rejects(createWorkflow(files, metadata), /already exists/);
	assert.equal(await exists(files.plan), false);
	await assert.rejects(readWorkflowMetadata(files), /active marker/);
	assert.equal(await readActiveWorkflow(metadata.worktreePath), undefined, "a directory alone is not active");

	await registerWorkflow(metadata);
	assert.deepEqual(workflowFiles(metadata.identifier), files);
	assert.deepEqual(await readCompletedWorkflowMetadata(metadata.identifier), metadata);
	const markerPath = activeWorkflowMarkerPath(metadata.worktreePath);
	const registry = workflowRegistryFiles(metadata.identifier);
	const marker = await json(markerPath);
	assert.deepEqual(resolveWorkflowLocator(metadata.identifier), marker);
	assert.deepEqual(await json(registry.locator), marker);
	assert.deepEqual(Object.keys(marker).sort(), ["gitCommonDir", "identifier", "repositoryRoot", "version", "worktreePath"]);
	const portable = await json(files.metadata);
	for (const key of ["repositoryRoot", "gitCommonDir", "worktreePath", "pullRequests", "state", "approvedPlanVersion"]) {
		assert.equal(key in portable, false, `${key} must not be stored in planning metadata`);
	}
	assert.equal(portable.ask, ask);
	assert.ok(!(await readFile(files.metadata, "utf8")).includes(temporaryRoot));
	assert.equal((await listCompletedWorkflows()).length, 1, "planning workflows are discoverable");
	// The repository's ignore rule covers both the marker and saved workflow records.
	const exclude = await readFile(join(metadata.gitCommonDir, "info", "exclude"), "utf8");
	assert.doesNotMatch(exclude, /\.workflows/);
	for (const path of [".workflows/active.json", `.workflows/${metadata.identifier}/plan.md`]) {
		const ignored = await exec("git", ["-C", repositoryRoot, "check-ignore", path]);
		assert.equal(ignored.stdout.trim(), path);
	}

	// Explicit finalization, not initialization, creates the first immutable version.
	await writePlanDocument(files.workingPlan, makePlanDocument());
	const firstPlan = await finalizePlanDraft(files, "Initial saved plan", 0);
	assert.equal(firstPlan.number, 1);
	metadata.description = firstPlan.description;

	// Fresh Pi discovery rebuilds the index without changing the brief or active marker.
	const beforeDiscovery = await snapshot(join(metadata.worktreePath, ".workflows"));
	await rm(workflowsRoot(), { recursive: true });
	assert.throws(() => workflowFiles(metadata.identifier), /no locator/);
	assert.deepEqual(await readActiveWorkflow(metadata.worktreePath), metadata);
	assert.deepEqual(await snapshot(join(metadata.worktreePath, ".workflows")), beforeDiscovery);
	assert.deepEqual(await readdir(workflowsRoot()), [`${metadata.identifier}.json`]);
	assert.deepEqual(workflowFiles(metadata.identifier), files);

	// Brief reads never repair direct edits or recreate missing files.
	const exportPath = join(files.root, "plan.md");
	await writeFile(exportPath, "# A direct edit must survive a read\n");
	await rm(files.workingPlan, { recursive: true });
	const beforeRead = await snapshot(files.root);
	await ensureWorkflowFiles(files);
	await readActiveWorkflow(metadata.worktreePath);
	await readCompletedWorkflowMetadata(metadata.identifier);
	await listCompletedWorkflows();
	assert.deepEqual(await snapshot(files.root), beforeRead);
	const draftBase = await preparePlanDraft(files);
	await writePlanDocument(files.workingPlan, makePlanDocument({ goal: "Second saved plan." }));
	const secondPlan = await finalizePlanDraft(files, "Second saved plan", draftBase.baseVersion);
	assert.equal(secondPlan.number, 2);
	metadata.description = secondPlan.description;
	assert.equal(await readFile(exportPath, "utf8"), "# A direct edit must survive a read\n", "display exports are not plan authority");
	assert.equal((await listPlanVersions(files))[0].content, firstPlan.content);
	await writeCompletedWorkflowMetadata({ ...metadata, approvedPlanVersion: secondPlan.number });
	assert.equal((await readCompletedWorkflowMetadata(metadata.identifier)).approvedPlanVersion, 2);
	assert.equal((await json(files.metadata)).approvedPlanVersion, 2);
	assert.deepEqual(await json(markerPath), marker, "approval does not replace runtime facts");
	await assert.rejects(writeCompletedWorkflowMetadata({ ...metadata, approvedPlanVersion: 0 }), /invalid metadata/);
	await assert.rejects(writeCompletedWorkflowMetadata({ ...metadata, ask: "changed" }), /immutable/);
	await assert.rejects(writeCompletedWorkflowMetadata({ ...metadata, repositoryRoot: temporaryRoot }), /runtime paths/);

	// Pull-request refreshes touch only the ignored display cache, not tracked metadata.
	const approved = await readCompletedWorkflowMetadata(metadata.identifier);
	const metadataBeforeCache = { content: await readFile(files.metadata, "utf8"), mtime: (await stat(files.metadata)).mtimeMs };
	const pullRequests = [{ number: 1, url: "https://example.test/pull/1", baseRefName: "main", headRefName: metadata.workflowBranch }];
	await writeCompletedWorkflowMetadata({ ...approved, pullRequests });
	assert.deepEqual((await json(markerPath)).pullRequests, pullRequests);
	assert.deepEqual((await readCompletedWorkflowMetadata(metadata.identifier)).pullRequests, pullRequests);
	assert.equal((await stat(files.metadata)).mtimeMs, metadataBeforeCache.mtime);
	assert.equal(await readFile(files.metadata, "utf8"), metadataBeforeCache.content);
	await writeCompletedWorkflowMetadata(approved);
	assert.deepEqual((await json(markerPath)).pullRequests, pullRequests, "omitting the cache preserves it");
	assert.equal("pullRequests" in await json(registry.locator), false);

	await appendClarifications(files, [{ id: "q1", label: "Scope", question: "Local?", answer: "Yes", custom: false, optionIndex: 0, answeredAt: "2026-01-02" }]);
	assert.equal((await json(files.clarifications)).entries.length, 1);
	const firstReview = sampleReview();
	assert.equal((await appendWorkflowReview(files, firstReview)).number, 1);
	assert.deepEqual(await readWorkflowReview(files), firstReview);
	assert.match(await readFile(files.reviewMarkdown, "utf8"), /## Review of planned changes/);
	const secondReview = sampleReview({ headCommit: "fed654" });
	assert.equal((await appendWorkflowReview(files, secondReview)).number, 2);
	await writeJson(join(files.reviews, "0003.json"), {});
	assert.deepEqual((await listSavedReviews(files)).map(({ number }) => number), [1, 2]);
	await writeJson(files.review, {});
	await assert.rejects(readWorkflowReview(files), /invalid structure/);

	// Historical tracked bundles never become active, even when a locator points at them.
	const historicalRoot = join(temporaryRoot, "historical-checkout");
	await mkdir(join(historicalRoot, ".workflows"), { recursive: true });
	await cp(files.root, join(historicalRoot, ".workflows", metadata.identifier), { recursive: true });
	assert.equal(await readActiveWorkflow(historicalRoot), undefined);
	await assert.rejects(readCompletedWorkflowMetadata(metadata.identifier, historicalRoot), /active marker/);
	await rm(markerPath);
	assert.equal(await readActiveWorkflow(metadata.worktreePath), undefined);
	assert.throws(() => workflowFiles(metadata.identifier), /active marker/);
	assert.deepEqual(await listCompletedWorkflows(), []);
	await writeJson(markerPath, { ...marker, pullRequests });
	await writeJson(registry.locator, { ...marker, worktreePath: historicalRoot });
	assert.throws(() => workflowFiles(metadata.identifier), /active marker/);
	await readActiveWorkflow(metadata.worktreePath); // repairs the stale locator

	// Unsupported metadata, invalid approval facts, and malformed markers fail closed.
	const currentPortable = await json(files.metadata);
	for (const patch of [{ version: 4 }, { version: 5 }, { ask: " " }, { approvedPlanVersion: -1 }, { repositoryRoot: "/machine/path" }]) {
		await writeJson(files.metadata, { ...currentPortable, ...patch });
		await assert.rejects(readWorkflowMetadata(files), patch.version ? new RegExp(`unsupported metadata version ${patch.version}`) : /invalid metadata/);
		assert.deepEqual(await listCompletedWorkflows(), []);
	}
	await writeJson(files.metadata, currentPortable);
	for (const patch of [{ identifier: "../escape" }, { worktreePath: historicalRoot }, { version: 4 }]) {
		await writeJson(markerPath, { ...marker, ...patch });
		await assert.rejects(readActiveWorkflow(metadata.worktreePath), /active marker is invalid/);
	}
	await writeJson(markerPath, { ...marker, pullRequests });

	// Registering another bundle in the same worktree never replaces its active workflow.
	const conflicting = { ...metadata, identifier: "conflicting", workflowBranch: "workflow/conflicting" };
	const conflictingFiles = workflowFiles(conflicting.identifier, conflicting.worktreePath);
	await createWorkflow(conflictingFiles, conflicting);
	await assert.rejects(registerWorkflow(conflicting), /already has active workflow/);
	assert.equal((await readActiveWorkflow(metadata.worktreePath)).identifier, metadata.identifier);
	const duplicate = { ...metadata, worktreePath: join(temporaryRoot, "duplicate-worktree") };
	await mkdir(duplicate.worktreePath);
	await createWorkflow(workflowFiles(duplicate.identifier, duplicate.worktreePath), duplicate);
	await assert.rejects(registerWorkflow(duplicate), /already active/);
	assert.equal(await exists(activeWorkflowMarkerPath(duplicate.worktreePath)), false);

	// Resolution priority is explicit id, current marker, session binding, repository picker.
	const other = metadataFor("other-planning", repositoryRoot, { createdAt: "2026-01-02T00:00:00.000Z" });
	await initialize(other);
	const roots = [metadata.worktreePath, other.worktreePath, historicalRoot];
	const fakeExec = async (_command, args) => ({ code: 0, stderr: "", stdout: `${args.includes("--show-toplevel")
		? roots.find((root) => args[1] === root || args[1].startsWith(`${root}/`)) ?? repositoryRoot : metadata.gitCommonDir}\n` });
	const options = { exec: fakeExec, cwd: join(metadata.worktreePath, "src"), verb: "implement", sessionIdentifier: other.identifier,
		select: async () => { throw new Error("Unexpected picker"); } };
	assert.equal((await resolveWorkflow(options)).workflow.identifier, metadata.identifier);
	assert.equal((await resolveWorkflow({ ...options, argument: other.identifier })).workflow.identifier, other.identifier);
	await unregisterWorkflow(metadata.identifier);
	assert.equal((await resolveWorkflow({ ...options, argument: metadata.identifier })).workflow.identifier, metadata.identifier);
	assert.equal((await resolveWorkflow({ ...options, cwd: repositoryRoot })).workflow.identifier, other.identifier);
	assert.equal((await resolveWorkflow({ ...options, cwd: historicalRoot })).workflow.identifier, other.identifier);
	let pickerLabels;
	const picked = await resolveWorkflow({ ...options, cwd: repositoryRoot, sessionIdentifier: undefined, select: async (_title, labels) => {
		pickerLabels = labels; return labels[1];
	} });
	assert.equal(picked.workflow.identifier, metadata.identifier);
	assert.deepEqual(pickerLabels, [`${other.identifier} — ${other.description}`, `${metadata.identifier} — ${metadata.description}`]);
	assert.deepEqual((await workflowIdentifierCompletions("other-")).map(({ value }) => value), [other.identifier]);
	assert.deepEqual((await listCompletedWorkflows()).map(({ identifier }) => identifier), [metadata.identifier, other.identifier]);
	await rm(other.worktreePath, { recursive: true });
	assert.equal((await listCompletedWorkflows()).length, 1);
	assert.match((await resolveWorkflow({ ...options, argument: other.identifier })).message, /no worktree/);

	// File and directory symlinks cannot redirect storage writes or discovery.
	const outside = join(temporaryRoot, "outside");
	await mkdir(outside);
	const linkedWorktree = join(temporaryRoot, "linked-worktree");
	await mkdir(linkedWorktree);
	await symlink(outside, join(linkedWorktree, ".workflows"));
	assert.throws(() => workflowFiles("escape", linkedWorktree), /symbolic links/);
	await assert.rejects(readActiveWorkflow(linkedWorktree), /symbolic links/);
	const outsideFile = join(outside, "keep.txt");
	await writeFile(outsideFile, "keep");
	await rm(exportPath);
	await symlink(outsideFile, exportPath);
	await assert.rejects(atomicWrite(exportPath, "clobber"), /symbolic links/);
	assert.equal(await readFile(outsideFile, "utf8"), "keep");
	await rm(exportPath);
	await atomicWrite(exportPath, secondPlan.content);
	await rename(files.versions, `${files.versions}.safe`);
	await symlink(outside, files.versions);
	await assert.rejects(finalizePlanDraft(files, "escape", 2), /symbolic links/);
	await assert.rejects(listPlanVersions(files), /symbolic links/);
	await rm(files.versions);
	await rename(`${files.versions}.safe`, files.versions);
	await rm(registry.locator);
	await symlink(outsideFile, registry.locator);
	assert.throws(() => workflowFiles(metadata.identifier), /symbolic links/);
	await rm(registry.locator);
	await readActiveWorkflow(metadata.worktreePath);

	// Atomic writes use unique temporary names and leave none behind on success.
	const scratch = join(files.root, "scratch.txt");
	await Promise.all(Array.from({ length: 16 }, (_, index) => atomicWrite(scratch, `writer-${index}`)));
	assert.match(await readFile(scratch, "utf8"), /^writer-\d+$/);
	assert.equal((await readdir(files.root)).some((name) => name.endsWith(".tmp")), false);
	await unregisterWorkflow(metadata.identifier);
	await unregisterWorkflow(metadata.identifier);
	assert.equal(await exists(registry.locator), false);
	assert.equal(await exists(files.metadata), true, "unregister only removes the locator");
	assert.equal(await exists(markerPath), true);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
console.log("Storage tests passed: v6 local bundles, portable metadata, marker-only discovery, selection, and guards.");
