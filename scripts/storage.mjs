import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	WORKFLOW_STATE_VERSION,
	createDraft,
	ensureWorkflowFiles,
	promoteDraft,
	readWorkflowMetadata,
	readWorkflowReview,
	writeDraftWorkflowMetadata,
	writeWorkflowMetadata,
	writeWorkflowReview,
} = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-storage-"));

function filesAt(root) {
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
		legacyDescription: join(root, "description.txt"),
		previousPlan: join(root, "plan.previous.md"),
	};
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

try {
	const ask = 'Preserve this ask exactly.\n\n- Keep <markup> & "quotes".\n';
	const draftId = "new-draft";
	const draftFiles = filesAt(join(temporaryRoot, ".drafts", draftId));
	const draftMetadata = {
		version: WORKFLOW_STATE_VERSION,
		status: "planning",
		draftId,
		description: "",
		ask,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	await createDraft(draftFiles, "# Implementation plan\n", draftMetadata);
	assert.deepEqual(JSON.parse(await readFile(draftFiles.metadata, "utf8")), draftMetadata);
	assert.equal(await readFile(draftFiles.plan, "utf8"), "# Implementation plan\n");
	assert.equal(await readFile(draftFiles.workingPlan, "utf8"), "# Implementation plan\n");
	assert.ok(!(await readFile(draftFiles.plan, "utf8")).includes(ask));
	assert.equal(await exists(draftFiles.legacyDescription), false);

	await writeFile(draftFiles.plan, "# Uncommitted direct change\n", "utf8");
	await ensureWorkflowFiles(draftFiles);
	assert.equal(await readFile(draftFiles.plan, "utf8"), "# Implementation plan\n");
	assert.deepEqual(await readdir(draftFiles.versions), ["0001.md"]);

	const missingAskFiles = filesAt(join(temporaryRoot, ".drafts", "missing-ask"));
	await assert.rejects(
		createDraft(missingAskFiles, "# Implementation plan\n", {
			...draftMetadata,
			draftId: "missing-ask",
			ask: null,
		}),
		/non-empty original ask/,
	);
	assert.equal(await exists(missingAskFiles.root), false);

	const describedDraft = { ...draftMetadata, description: "Store workflow asks in metadata" };
	await writeDraftWorkflowMetadata(draftFiles, describedDraft);
	assert.deepEqual(await readWorkflowMetadata(draftFiles), describedDraft);
	await assert.rejects(
		writeDraftWorkflowMetadata(draftFiles, { ...describedDraft, ask: "A replacement ask" }),
		/original ask is immutable/,
	);
	assert.equal((await readWorkflowMetadata(draftFiles)).ask, ask);

	const identifier = "promoted-workflow";
	const completedFiles = filesAt(join(temporaryRoot, identifier));
	const completedMetadata = {
		version: WORKFLOW_STATE_VERSION,
		identifier,
		description: describedDraft.description,
		ask,
		status: "ready_for_implementation",
		repositoryRoot: "/repository",
		gitCommonDir: "/repository/.git",
		baseBranch: "main",
		baseCommit: "abc123",
		workflowBranch: `workflow/${identifier}`,
		worktreePath: `/repository/.worktrees/${identifier}`,
		createdAt: describedDraft.createdAt,
	};
	await writeWorkflowMetadata(draftFiles, completedMetadata);
	await promoteDraft(draftFiles, completedFiles);
	assert.equal((await readWorkflowMetadata(completedFiles)).ask, ask);
	assert.equal(await exists(completedFiles.workingPlan), false);

	const implementing = {
		...completedMetadata,
		status: "implementing",
		implementationStartedAt: "2026-01-02T00:00:00.000Z",
	};
	await writeWorkflowMetadata(completedFiles, implementing);
	const implementationComplete = {
		...implementing,
		status: "implementation_complete",
		pullRequestUrl: "https://example.test/pull/1",
		pullRequestNumber: 1,
	};
	await writeWorkflowMetadata(completedFiles, implementationComplete);
	let lifecycleMetadata = implementationComplete;
	for (const status of ["reviewing", "cleanup_pending", "review_complete"]) {
		lifecycleMetadata = { ...lifecycleMetadata, status };
		await writeWorkflowMetadata(completedFiles, lifecycleMetadata);
		assert.equal((await readWorkflowMetadata(completedFiles)).ask, ask);
	}
	const review = {
		version: 1,
		pullRequestUrl: "https://example.test/pull/1",
		baseCommit: "abc123",
		headCommit: "def456",
		generatedAt: "2026-01-03T00:00:00.000Z",
		overallResult: {
			summary: "The implementation matches the plan.",
			necessary: { status: "yes", explanation: "No unrelated work." },
			sufficient: { status: "yes", explanation: "All planned behavior exists." },
		},
		overallConcerns: [],
		plannedChanges: [{
			id: "PC-01",
			title: "Store the report",
			what: "Store a report.",
			why: "Keep the review durable.",
			pseudocode: "save(report)",
			review: {
				id: "PC-01",
				title: "Store the report",
				summary: "Stored as JSON and Markdown.",
				necessary: { status: "yes", explanation: "Required by the plan." },
				sufficient: { status: "yes", explanation: "Both files are stored." },
				contracts: [],
				concerns: [],
			},
		}],
		testingCriteria: {
			originalCriteria: "Verify the stored report.",
			review: {
				summary: "The report storage test passes.",
				satisfied: { status: "yes", explanation: "Both formats are verified." },
				criteria: [{
					criterion: "Verify the stored report.",
					status: "yes",
					explanation: "JSON and Markdown are read back.",
					evidence: [{ location: "scripts/storage.mjs:1", description: "Verifies both report files." }],
				}],
				concerns: [],
			},
		},
	};
	await writeWorkflowReview(completedFiles, review);
	assert.deepEqual(await readWorkflowReview(completedFiles), review);
	assert.match(await readFile(completedFiles.reviewMarkdown, "utf8"), /## Review of planned changes/);
	assert.match(await readFile(completedFiles.reviewMarkdown, "utf8"), /## Testing criteria/);
	await writeFile(completedFiles.review, "{}\n", "utf8");
	await assert.rejects(readWorkflowReview(completedFiles), /invalid structure/);
	await writeWorkflowReview(completedFiles, review);
	await assert.rejects(
		writeWorkflowMetadata(completedFiles, { ...lifecycleMetadata, ask: "changed" }),
		/original ask is immutable/,
	);

	const invalidCompletedFiles = filesAt(join(temporaryRoot, "invalid-current-workflow"));
	await assert.rejects(
		writeWorkflowMetadata(invalidCompletedFiles, {
			...completedMetadata,
			identifier: "invalid-current-workflow",
			ask: null,
		}),
		/non-empty original ask/,
	);

	const legacyDraftId = "legacy-draft";
	const legacyDraftFiles = filesAt(join(temporaryRoot, ".drafts", legacyDraftId));
	await mkdir(legacyDraftFiles.root, { recursive: true });
	await writeFile(legacyDraftFiles.plan, "# Legacy draft\n", "utf8");
	await writeFile(legacyDraftFiles.legacyDescription, "Migrated draft description\n", "utf8");
	const migratedDraft = await ensureWorkflowFiles(legacyDraftFiles);
	assert.equal(migratedDraft.status, "planning");
	assert.equal(await readFile(legacyDraftFiles.workingPlan, "utf8"), "# Legacy draft\n");
	assert.equal(migratedDraft.description, "Migrated draft description");
	assert.equal(migratedDraft.ask, null);
	assert.equal(JSON.parse(await readFile(legacyDraftFiles.metadata, "utf8")).ask, null);
	assert.equal(await exists(legacyDraftFiles.legacyDescription), false);

	const legacyIdentifier = "legacy-completed-workflow";
	const legacyCompletedFiles = filesAt(join(temporaryRoot, legacyIdentifier));
	await mkdir(legacyCompletedFiles.root, { recursive: true });
	await writeFile(legacyCompletedFiles.plan, "# Completed plan\n", "utf8");
	await writeFile(legacyCompletedFiles.legacyDescription, "Migrated completed description\n", "utf8");
	await writeFile(
		legacyCompletedFiles.metadata,
		`${JSON.stringify(
			{
				version: 1,
				identifier: legacyIdentifier,
				status: "ready_for_implementation",
				repositoryRoot: "/repository",
				gitCommonDir: "/repository/.git",
				baseBranch: "main",
				baseCommit: "abc123",
				workflowBranch: `workflow/${legacyIdentifier}`,
				worktreePath: `/repository/.worktrees/${legacyIdentifier}`,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const migratedCompleted = await ensureWorkflowFiles(legacyCompletedFiles);
	assert.equal(migratedCompleted.status, "ready_for_implementation");
	assert.equal(migratedCompleted.description, "Migrated completed description");
	assert.equal(migratedCompleted.ask, null);
	assert.equal(await exists(legacyCompletedFiles.legacyDescription), false);
	const migratedCompletedJson = JSON.parse(await readFile(legacyCompletedFiles.metadata, "utf8"));
	assert.equal(migratedCompletedJson.description, "Migrated completed description");
	assert.equal(migratedCompletedJson.ask, null);

	const descriptionlessIdentifier = "descriptionless-legacy-workflow";
	const descriptionlessFiles = filesAt(join(temporaryRoot, descriptionlessIdentifier));
	await mkdir(descriptionlessFiles.root, { recursive: true });
	await writeFile(descriptionlessFiles.plan, "# Descriptionless plan\n", "utf8");
	await writeFile(
		descriptionlessFiles.metadata,
		`${JSON.stringify(
			{
				version: 1,
				identifier: descriptionlessIdentifier,
				status: "review_complete",
				repositoryRoot: "/repository",
				gitCommonDir: "/repository/.git",
				baseBranch: "main",
				baseCommit: "def456",
				workflowBranch: `workflow/${descriptionlessIdentifier}`,
				worktreePath: `/repository/.worktrees/${descriptionlessIdentifier}`,
				createdAt: "2025-01-01T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const descriptionless = await ensureWorkflowFiles(descriptionlessFiles);
	assert.equal(descriptionless.description, "");
	assert.equal(descriptionless.ask, null);
	assert.equal((await readWorkflowMetadata(descriptionlessFiles)).description, "");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Storage test passed: original asks are required, immutable, promoted unchanged, and legacy metadata migrates safely.");
