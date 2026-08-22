import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	WORKFLOW_STATE_VERSION,
	createDraft,
	ensureWorkflowFiles,
	readWorkflowMetadata,
	writeDraftWorkflowMetadata,
} = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-storage-"));

function filesAt(root) {
	return {
		root,
		plan: join(root, "plan.md"),
		versions: join(root, "versions"),
		clarifications: join(root, "clarifications.json"),
		dashboard: join(root, "dashboard.html"),
		metadata: join(root, "metadata.json"),
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
	const draftId = "new-draft";
	const draftFiles = filesAt(join(temporaryRoot, ".drafts", draftId));
	const draftMetadata = {
		version: WORKFLOW_STATE_VERSION,
		status: "planning",
		draftId,
		description: "",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	await createDraft(draftFiles, "# Implementation plan\n", draftMetadata);
	assert.deepEqual(JSON.parse(await readFile(draftFiles.metadata, "utf8")), draftMetadata);
	assert.equal(await exists(draftFiles.legacyDescription), false);

	const describedDraft = { ...draftMetadata, description: "Store workflow descriptions in metadata" };
	await writeDraftWorkflowMetadata(draftFiles, describedDraft);
	assert.deepEqual(await readWorkflowMetadata(draftFiles), describedDraft);

	const legacyDraftId = "legacy-draft";
	const legacyDraftFiles = filesAt(join(temporaryRoot, ".drafts", legacyDraftId));
	await mkdir(legacyDraftFiles.root, { recursive: true });
	await writeFile(legacyDraftFiles.plan, "# Legacy draft\n", "utf8");
	await writeFile(legacyDraftFiles.legacyDescription, "Migrated draft description\n", "utf8");
	const migratedDraft = await ensureWorkflowFiles(legacyDraftFiles);
	assert.equal(migratedDraft.status, "planning");
	assert.equal(migratedDraft.description, "Migrated draft description");
	assert.equal(await exists(legacyDraftFiles.legacyDescription), false);

	const identifier = "legacy-completed-workflow";
	const completedFiles = filesAt(join(temporaryRoot, identifier));
	await mkdir(completedFiles.root, { recursive: true });
	await writeFile(completedFiles.plan, "# Completed plan\n", "utf8");
	await writeFile(completedFiles.legacyDescription, "Migrated completed description\n", "utf8");
	await writeFile(
		completedFiles.metadata,
		`${JSON.stringify(
			{
				version: WORKFLOW_STATE_VERSION,
				identifier,
				status: "ready_for_implementation",
				repositoryRoot: "/repository",
				gitCommonDir: "/repository/.git",
				baseBranch: "main",
				baseCommit: "abc123",
				workflowBranch: `workflow/${identifier}`,
				worktreePath: `/repository/.worktrees/${identifier}`,
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const migratedCompleted = await ensureWorkflowFiles(completedFiles);
	assert.equal(migratedCompleted.status, "ready_for_implementation");
	assert.equal(migratedCompleted.description, "Migrated completed description");
	assert.equal(await exists(completedFiles.legacyDescription), false);
	assert.equal(JSON.parse(await readFile(completedFiles.metadata, "utf8")).description, "Migrated completed description");

	const descriptionlessIdentifier = "descriptionless-legacy-workflow";
	const descriptionlessFiles = filesAt(join(temporaryRoot, descriptionlessIdentifier));
	await mkdir(descriptionlessFiles.root, { recursive: true });
	await writeFile(descriptionlessFiles.plan, "# Descriptionless plan\n", "utf8");
	await writeFile(
		descriptionlessFiles.metadata,
		`${JSON.stringify(
			{
				version: WORKFLOW_STATE_VERSION,
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
	assert.equal((await readWorkflowMetadata(descriptionlessFiles)).description, "");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Storage test passed: draft metadata is created immediately and legacy descriptions migrate.");
