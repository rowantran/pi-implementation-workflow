import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-storage-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	WORKFLOW_METADATA_VERSION,
	appendWorkflowReview,
	createDraft,
	ensureWorkflowFiles,
	listCompletedWorkflows,
	listSavedReviews,
	promoteDraft,
	readWorkflowMetadata,
	readWorkflowReview,
	workflowFiles,
	writeDraftWorkflowMetadata,
	writeWorkflowMetadata,
} = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);

const workflowsRoot = join(temporaryRoot, "agent", "workflows");

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
		reviews: join(root, "reviews"),
		reviewRuns: join(root, "review-runs"),
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

function sampleReview(overrides = {}) {
	return {
		version: 2,
		pullRequestUrls: ["https://example.test/pull/1"],
		baseCommit: "abc123",
		headCommit: "def456",
		sourceFingerprint: "source789",
		generatedAt: "2026-01-03T00:00:00.000Z",
		overallResult: {
			summary: "The implementation matches the plan.",
			necessary: { status: "yes", explanation: "No unrelated work." },
			sufficient: { status: "yes", explanation: "All planned behavior exists." },
		},
		overallConcerns: [],
		holisticReview: {
			summary: "The pull request is coherent as a whole.",
			necessary: { status: "yes", explanation: "No unrelated work." },
			sufficient: { status: "yes", explanation: "All planned behavior exists." },
			concerns: [],
		},
		plannedChanges: [{
			id: "PC-01",
			title: "Store the report",
			what: "Store a report.",
			why: "Keep the review durable.",
			pseudocode: "save(report)",
			review: {
				id: "PC-01",
				title: "Store the report",
				walkthrough: "Stored as JSON and Markdown.",
				necessary: { status: "yes", explanation: "Required by the plan." },
				sufficient: { status: "yes", explanation: "Both files are stored." },
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
		...overrides,
	};
}

try {
	const ask = 'Preserve this ask exactly.\n\n- Keep <markup> & "quotes".\n';
	const draftId = "new-draft";
	const draftFiles = filesAt(join(workflowsRoot, ".drafts", draftId));
	const draftMetadata = {
		version: WORKFLOW_METADATA_VERSION,
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

	// A direct plan edit is repaired back to the committed version history.
	await writeFile(draftFiles.plan, "# Uncommitted direct change\n", "utf8");
	await ensureWorkflowFiles(draftFiles);
	assert.equal(await readFile(draftFiles.plan, "utf8"), "# Implementation plan\n");
	assert.deepEqual(await readdir(draftFiles.versions), ["0001.md"]);

	const missingAskFiles = filesAt(join(workflowsRoot, ".drafts", "missing-ask"));
	await assert.rejects(
		createDraft(missingAskFiles, "# Implementation plan\n", {
			...draftMetadata,
			draftId: "missing-ask",
			ask: "  ",
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

	// Planning completion writes completed metadata into the draft directory and promotes it.
	const identifier = "promoted-workflow";
	const completedFiles = workflowFiles(identifier);
	const completedMetadata = {
		version: WORKFLOW_METADATA_VERSION,
		identifier,
		description: describedDraft.description,
		ask,
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

	// The pull request cache and the ask immutability guard.
	const withPullRequests = {
		...completedMetadata,
		pullRequests: [{
			number: 1,
			url: "https://example.test/pull/1",
			baseRefName: "main",
			headRefName: `workflow/${identifier}`,
		}],
	};
	await writeWorkflowMetadata(completedFiles, withPullRequests);
	assert.deepEqual((await readWorkflowMetadata(completedFiles)).pullRequests, withPullRequests.pullRequests);
	await assert.rejects(
		writeWorkflowMetadata(completedFiles, { ...withPullRequests, ask: "changed" }),
		/original ask is immutable/,
	);

	// Reviews are an append-only numbered history plus a latest export.
	const firstReview = sampleReview();
	const firstSaved = await appendWorkflowReview(completedFiles, firstReview);
	assert.equal(firstSaved.number, 1);
	assert.deepEqual(await readWorkflowReview(completedFiles), firstReview);
	assert.match(await readFile(completedFiles.reviewMarkdown, "utf8"), /## Review of planned changes/);
	const secondReview = sampleReview({ headCommit: "fed654", generatedAt: "2026-01-04T00:00:00.000Z" });
	const secondSaved = await appendWorkflowReview(completedFiles, secondReview);
	assert.equal(secondSaved.number, 2);
	assert.deepEqual(await readWorkflowReview(completedFiles), secondReview);
	assert.deepEqual(
		(await readdir(completedFiles.reviews)).sort(),
		["0001.json", "0001.md", "0002.json", "0002.md"],
	);

	// Unreadable saved reviews are skipped; unreadable latest reviews are surfaced.
	await writeFile(join(completedFiles.reviews, "0003.json"), "{}\n", "utf8");
	const savedReviews = await listSavedReviews(completedFiles);
	assert.deepEqual(savedReviews.map(({ number }) => number), [1, 2]);
	assert.deepEqual(savedReviews.map(({ report }) => report.headCommit), ["def456", "fed654"]);
	await writeFile(completedFiles.review, "{}\n", "utf8");
	await assert.rejects(readWorkflowReview(completedFiles), /invalid structure/);

	// Listing skips drafts, invalid directories, and unsupported metadata versions.
	const legacyIdentifier = "legacy-workflow";
	const legacyFiles = workflowFiles(legacyIdentifier);
	await mkdir(legacyFiles.root, { recursive: true });
	await writeFile(
		legacyFiles.metadata,
		`${JSON.stringify({
			...completedMetadata,
			version: 3,
			identifier: legacyIdentifier,
			state: { phase: "reviewing", step: "active", round: 1 },
			workflowBranch: `workflow/${legacyIdentifier}`,
			worktreePath: `/repository/.worktrees/${legacyIdentifier}`,
		})}\n`,
		"utf8",
	);
	await assert.rejects(readWorkflowMetadata(legacyFiles), /unsupported metadata version 3/);
	assert.deepEqual(
		(await listCompletedWorkflows()).map(({ identifier: id }) => id),
		[identifier],
	);

	// Metadata with a blank ask is rejected outright.
	const statefulIdentifier = "blank-ask-workflow";
	const statefulFiles = workflowFiles(statefulIdentifier);

	await mkdir(statefulFiles.root, { recursive: true });
	await writeFile(
		statefulFiles.metadata,
		`${JSON.stringify({
			...completedMetadata,
			identifier: statefulIdentifier,
			ask: "  ",
			workflowBranch: `workflow/${statefulIdentifier}`,
			worktreePath: `/repository/.worktrees/${statefulIdentifier}`,
		})}\n`,
		"utf8",
	);
	await assert.rejects(readWorkflowMetadata(statefulFiles), /invalid metadata/);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Storage test passed: version-4 metadata stays fact-only, asks remain immutable, and reviews append.");
