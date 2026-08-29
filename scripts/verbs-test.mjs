import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-verbs-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const implementationWorkflow = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname, {
	default: true,
});
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const dashboardServer = await jiti.import(new URL("../src/dashboard-server.ts", import.meta.url).pathname);

const validPlan = `# Implementation plan

## Goal

Complete the workflow verbs.

## Planned Changes

### PC-01: Complete the verbs

**What**
Support explicit workflow verbs.

**Why**
The workflow must stay flexible.

**Pseudocode**
\`\`\`text
procedure RunVerb()
\`\`\`

## Testing

Verify each verb.
`;

async function reviewAgentRunner(request) {
	if (request.role === "incremental-scope") {
		return {
			summary: "The revision affects the verbs planned change.",
			relevantPlannedChanges: [{
				id: "PC-01",
				explanation: "The revision changes the verb implementation.",
			}],
		};
	}
	if (request.role === "planned-change") {
		return {
			id: "PC-01",
			title: "Complete the verbs",
			walkthrough: "The verbs are implemented.",
			necessary: { status: "yes", explanation: "It maps to the plan." },
			sufficient: { status: "yes", explanation: "The verbs complete." },
			concerns: [],
		};
	}
	if (request.role === "holistic-review") {
		return {
			summary: "The pull request matches the plan.",
			necessary: { status: "yes", explanation: "No extra work." },
			sufficient: { status: "yes", explanation: "All behavior exists." },
			concerns: [],
		};
	}
	if (request.role === "testing-criteria") {
		return {
			summary: "The verb criterion is satisfied.",
			satisfied: { status: "yes", explanation: "Verb tests pass." },
			criteria: [{
				criterion: "Verify each verb.",
				status: "yes",
				explanation: "The verb test covers each command.",
				evidence: [{ location: "scripts/verbs-test.mjs:1", description: "Exercises workflow verbs." }],
			}],
			concerns: [],
		};
	}
	return {
		overallResult: {
			summary: "The pull request is necessary and sufficient.",
			necessary: { status: "yes", explanation: "No extra work." },
			sufficient: { status: "yes", explanation: "All behavior exists." },
		},
		overallConcerns: [],
	};
}

function phaseEntry(phase, values = {}) {
	return {
		type: "custom",
		customType: "implementation-workflow-phase",
		data: { phase, ...values },
	};
}

function createHarness(repositoryRoot, worktreePath, workflowBranch) {
	const commands = new Map();
	const events = new Map();
	const entries = [];
	const notifications = [];
	const confirmations = [];
	const selections = [];
	const statuses = new Map();
	const widgets = new Map();
	const switches = [];
	const userMessages = [];
	const reviewRequests = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let switchCancelled = false;
	let pullRequests = [];
	let headCommit = "head111";
	let currentBranch = workflowBranch;
	let worktreeStatus = "";
	let ancestorCheck = () => true;
	let editorValue = "Address the review findings.";
	let confirmResult = true;
	let selectChoice = (options) => options[0];

	const pi = {
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		exec: async (command, args, options = {}) => {
			if (command === "gh") {
				if (args[0] === "pr" && args[1] === "list") {
					return {
						code: 0,
						stdout: JSON.stringify(pullRequests.map(({ headRefOid: _headRefOid, ...pullRequest }) => pullRequest)),
						stderr: "",
					};
				}
				if (args[0] === "api") {
					const number = Number(args[1].split("/").at(-1));
					const pullRequest = pullRequests.find((candidate) => candidate.number === number);
					return pullRequest
						? { code: 0, stdout: `${pullRequest.headRefOid}\n`, stderr: "" }
						: { code: 1, stdout: "", stderr: "pull request not found" };
				}
				throw new Error(`Unexpected gh command: ${args.join(" ")} (${options.cwd ?? repositoryRoot})`);
			}
			assert.equal(command, "git");
			const cwd = args[1];
			const gitArgs = args.slice(2);
			if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") {
				return { code: 0, stdout: `${cwd === worktreePath ? worktreePath : repositoryRoot}\n`, stderr: "" };
			}
			if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute") {
				return { code: 0, stdout: `${join(repositoryRoot, ".git")}\n`, stderr: "" };
			}
			if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") {
				return { code: 0, stdout: `${headCommit}\n`, stderr: "" };
			}
			if (gitArgs[0] === "branch" && gitArgs[1] === "--show-current") {
				const branch =
					cwd === worktreePath
						? currentBranch
						: cwd.includes("/.worktrees/")
							? `workflow/${cwd.split("/").at(-1)}`
							: "main";
				return { code: 0, stdout: `${branch}\n`, stderr: "" };
			}
			if (gitArgs[0] === "merge-base" && gitArgs[1] === "--is-ancestor") {
				return ancestorCheck(gitArgs[2], gitArgs[3]) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" };
			}
			if (gitArgs[0] === "status") return { code: 0, stdout: worktreeStatus, stderr: "" };
			if (gitArgs[0] === "worktree" && gitArgs[1] === "add") {
				await mkdir(gitArgs[4], { recursive: true });
				return { code: 0, stdout: "", stderr: "" };
			}
			if (gitArgs[0] === "worktree" && gitArgs[1] === "remove") {
				await rm(gitArgs.at(-1), { recursive: true, force: true });
				return { code: 0, stdout: "", stderr: "" };
			}
			if (gitArgs[0] === "branch" && gitArgs[1] === "-D") {
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`Unexpected git command: ${gitArgs.join(" ")} (${options.cwd ?? cwd})`);
		},
		getActiveTools: () => [...activeTools],
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerEntryRenderer() {},
		registerShortcut() {},
		registerTool() {},
		sendUserMessage(message) {
			userMessages.push(message);
		},
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		setSessionName() {},
	};
	implementationWorkflow(pi, {
		reviewAgentRunner: async (request) => {
			reviewRequests.push(request);
			return reviewAgentRunner(request);
		},
	});

	function context(cwd, branch) {
		return {
			cwd,
			hasUI: false,
			mode: "json",
			model: {},
			modelRegistry: {
				complete: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: "workflow-verbs" }],
				}),
			},
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => "test-session",
			},
			switchSession: async (sessionFile, options = {}) => {
				switches.push(sessionFile);
				if (switchCancelled) return { cancelled: true };
				await options.withSession?.({
					sendUserMessage: async (message) => {
						userMessages.push(message);
					},
					ui: {
						notify: (message, level) => notifications.push({ message, level }),
					},
				});
				return { cancelled: false };
			},
			ui: {
				confirm: async (title, message) => {
					confirmations.push({ title, message });
					return confirmResult;
				},
				editor: async (_title, prefill) => (prefill === undefined || prefill === "" ? editorValue : prefill),
				notify: (message, level) => notifications.push({ message, level }),
				select: async (title, options) => {
					selections.push({ title, options });
					return selectChoice(options);
				},
				setStatus: (id, content) => {
					if (content === undefined) statuses.delete(id);
					else statuses.set(id, content);
				},
				setWidget: (id, content, options) => {
					if (content === undefined) widgets.delete(id);
					else widgets.set(id, { content, options });
				},
				theme: { fg: (_color, text) => text },
			},
			waitForIdle: async () => {},
		};
	}

	async function emit(name, ctx) {
		// Pi restores each session's own tool set before session_start fires.
		if (name === "session_start") activeTools = ["read", "bash", "edit", "write"];
		for (const handler of events.get(name) ?? []) await handler({}, ctx);
	}

	async function run(command, args, ctx) {
		return commands.get(command).handler(args, ctx);
	}

	return {
		commands,
		context,
		emit,
		run,
		entries,
		notifications,
		confirmations,
		selections,
		statuses,
		widgets,
		switches,
		userMessages,
		reviewRequests,
		getActiveTools: () => [...activeTools],
		setPullRequest(value) {
			pullRequests = [{ headRefOid: headCommit, ...value }];
		},
		setPullRequests(values) {
			pullRequests = values.map((value) => ({ headRefOid: headCommit, ...value }));
		},
		setCurrentBranch(value) {
			currentBranch = value;
		},
		setHeadCommit(value) {
			headCommit = value;
		},
		setWorktreeStatus(value) {
			worktreeStatus = value;
		},
		setAncestorCheck(value) {
			ancestorCheck = value;
		},
		setEditorResult(value) {
			editorValue = value;
		},
		setConfirmResult(value) {
			confirmResult = value;
		},
		setSelectChoice(value) {
			selectChoice = value;
		},
		setSwitchCancelled(value) {
			switchCancelled = value;
		},
	};
}

async function writeCompletedWorkflow(identifier, options = {}) {
	const repositoryRoot = options.repositoryRoot ?? join(temporaryRoot, identifier, "repository");
	const worktreePath = join(repositoryRoot, ".worktrees", identifier);
	const workflowBranch = `workflow/${identifier}`;
	await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
	if (options.createWorktree !== false) await mkdir(worktreePath, { recursive: true });
	const files = storage.workflowFiles(identifier);
	await mkdir(files.versions, { recursive: true });
	await writeFile(files.plan, validPlan, "utf8");
	await writeFile(join(files.versions, "0001.md"), validPlan, "utf8");
	await writeFile(files.clarifications, '{"version":1,"entries":[]}\n', "utf8");
	const metadata = {
		version: storage.WORKFLOW_METADATA_VERSION,
		identifier,
		description: `Untangle ${identifier}`,
		ask: "Untangle the workflow into explicit verbs.",
		repositoryRoot,
		gitCommonDir: join(repositoryRoot, ".git"),
		baseBranch: "main",
		baseCommit: "base000",
		workflowBranch,
		worktreePath,
		createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
		...options.metadata,
	};
	await storage.writeCompletedWorkflowMetadata(metadata);
	return { files, metadata, repositoryRoot, worktreePath, workflowBranch };
}

async function readMetadata(identifier) {
	return JSON.parse(await readFile(storage.workflowFiles(identifier).metadata, "utf8"));
}

async function sessionEntries(sessionFile) {
	return (await readFile(sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

async function sessionPhase(sessionFile) {
	return (await sessionEntries(sessionFile)).find(
		(entry) => entry.type === "custom" && entry.customType === "implementation-workflow-phase",
	);
}

const REVIEW_READY_WIDGET = "implementation-workflow-review-ready-notice";

try {
	// Planning completes through /workflow-implement: freeze, worktree, session switch.
	{
		const repositoryRoot = join(temporaryRoot, "planning-repository");
		const identifier = "workflow-verbs";
		const worktreePath = join(repositoryRoot, ".worktrees", identifier);
		const workflowBranch = `workflow/${identifier}`;
		await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
		const draftId = "planning-draft";
		await storage.createDraft(storage.draftFiles(draftId), validPlan, {
			version: storage.WORKFLOW_METADATA_VERSION,
			draftId,
			description: "Untangle the workflow",
			ask: "Untangle the workflow into explicit verbs.",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const harness = createHarness(repositoryRoot, worktreePath, workflowBranch);
		assert.deepEqual(
			[...harness.commands.keys()],
			["workflow-plan", "workflow-implement", "workflow-review", "workflow-revise", "workflow-cleanup", "workflow-dashboard"],
		);
		harness.setHeadCommit("base000");
		const ctx = harness.context(repositoryRoot, [phaseEntry("planning", { draftId })]);
		await harness.emit("session_start", ctx);

		await harness.run("workflow-implement", "some-other-workflow", ctx);
		assert.match(harness.notifications.at(-1).message, /freezes its own plan/);

		await harness.run("workflow-implement", "", ctx);
		assert.equal(harness.switches.length, 1);
		const metadata = await readMetadata(identifier);
		assert.equal(metadata.version, storage.WORKFLOW_METADATA_VERSION);
		assert.equal("state" in metadata, false, "completed metadata records facts, not lifecycle state");
		assert.equal(metadata.baseCommit, "base000");
		assert.equal(metadata.worktreePath, worktreePath);
		assert.match(harness.userMessages.at(-1), /Implement the plan/);
		assert.deepEqual((await sessionPhase(harness.switches[0])).data, {
			phase: "implementation",
			identifier,
		});

		// Re-entry: /workflow-implement from any session bound to the workflow starts a fresh implementation session.
		const implementationCtx = harness.context(worktreePath, [phaseEntry("implementation", { identifier })]);
		await harness.emit("session_start", implementationCtx);
		await harness.run("workflow-implement", "", implementationCtx);
		assert.equal(harness.switches.length, 2);

		// /workflow-plan refuses to run in a session bound to a workflow.
		await harness.run("workflow-plan", "", implementationCtx);
		assert.match(harness.notifications.at(-1).message, /belongs to workflow workflow-verbs/);
		await harness.emit("session_shutdown", implementationCtx);
	}

	// A settled implementation turn suggests /workflow-review only when the worktree is clean with new commits.
	{
		const workflow = await writeCompletedWorkflow("review-readiness");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.emit("agent_settled", ctx);
		assert.ok(harness.widgets.has(REVIEW_READY_WIDGET), "clean worktree with commits suggests review");
		assert.equal(harness.widgets.get(REVIEW_READY_WIDGET).options.placement, "belowEditor");
		harness.setWorktreeStatus(" M src/index.ts\n");
		await harness.emit("agent_settled", ctx);
		assert.ok(!harness.widgets.has(REVIEW_READY_WIDGET), "a dirty worktree hides the suggestion");
		harness.setWorktreeStatus("");
		harness.setHeadCommit("base000");
		await harness.emit("agent_settled", ctx);
		assert.ok(!harness.widgets.has(REVIEW_READY_WIDGET), "no new commits hides the suggestion");
	}

	// The footer links only the pull request at the checked-out stack tip.
	{
		const workflow = await writeCompletedWorkflow("stack-footer");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const stackTipBranch = "feature/stack-footer-tip";
		harness.setCurrentBranch(stackTipBranch);
		harness.setPullRequests([
			{
				number: 41,
				url: "https://example.test/pull/41",
				baseRefName: "main",
				headRefName: workflow.workflowBranch,
			},
			{
				number: 42,
				url: "https://example.test/pull/42",
				baseRefName: workflow.workflowBranch,
				headRefName: stackTipBranch,
			},
		]);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		assert.equal(
			harness.statuses.get("implementation-workflow-phase"),
			"PR #42 · /workflow-review to review",
		);
	}

	// /workflow-review checks the live delivery, generates, reuses, re-reviews incrementally, and falls back.
	{
		const workflow = await writeCompletedWorkflow("verb-review");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		harness.setPullRequest({
			number: 17,
			url: "https://example.test/pull/17",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-review", "", ctx);
		assert.equal(harness.switches.length, 1);
		assert.deepEqual((await sessionPhase(harness.switches[0])).data, {
			phase: "review",
			identifier: workflow.metadata.identifier,
		});
		assert.match(harness.notifications.at(-1).message, /review is ready/i);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).pullRequests, [{
			number: 17,
			url: "https://example.test/pull/17",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		}]);
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "head111");
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0001.json")), true);
		const firstRunRoles = harness.reviewRequests.map(({ role }) => role);
		assert.ok(!firstRunRoles.includes("incremental-scope"), "the first review is a full review");

		// Reuse: the same commits are never re-reviewed.
		const reviewCtx = harness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", reviewCtx);
		assert.equal(harness.getActiveTools().includes("edit"), false, "review sessions stay read-only");
		harness.reviewRequests.length = 0;
		await harness.run("workflow-review", "", reviewCtx);
		assert.equal(harness.reviewRequests.length, 0, "an up-to-date review reruns no agents");
		assert.equal(harness.switches.length, 1, "an up-to-date review keeps the current review session");
		assert.match(harness.notifications.at(-1).message, /already covers/i);

		// Revise: a change request starts a revision session that references the saved review.
		await harness.run("workflow-revise", "", reviewCtx);
		assert.equal(harness.switches.length, 2);
		assert.deepEqual((await sessionPhase(harness.switches[1])).data, {
			phase: "revision",
			identifier: workflow.metadata.identifier,
		});
		assert.match(harness.userMessages.at(-1), /Address the review findings/);
		assert.match(harness.userMessages.at(-1), new RegExp(workflow.files.review.replaceAll("/", "\\/")));

		// Incremental re-review after new commits.
		harness.setHeadCommit("head222");
		harness.setPullRequest({
			number: 17,
			url: "https://example.test/pull/17",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		const revisionCtx = harness.context(workflow.worktreePath, [
			phaseEntry("revision", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", revisionCtx);
		assert.equal(harness.getActiveTools().includes("edit"), true);
		assert.equal(harness.getActiveTools().includes("workflow_questions"), true);
		await harness.emit("agent_settled", revisionCtx);
		assert.ok(harness.widgets.has(REVIEW_READY_WIDGET), "a revised head suggests re-review");
		harness.reviewRequests.length = 0;
		await harness.run("workflow-review", "", revisionCtx);
		const incrementalRoles = harness.reviewRequests.map(({ role }) => role);
		assert.ok(incrementalRoles.includes("incremental-scope"), "a re-review scopes incrementally");
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "head222");
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0002.json")), true);

		// Fallback: when no saved review is a Git ancestor, a full review is generated instead of an error.
		harness.setHeadCommit("head333");
		harness.setPullRequest({
			number: 17,
			url: "https://example.test/pull/17",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		harness.setAncestorCheck((ancestor) => ancestor === "base000");
		harness.reviewRequests.length = 0;
		const secondRevisionCtx = harness.context(workflow.worktreePath, [
			phaseEntry("revision", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", secondRevisionCtx);
		await harness.run("workflow-review", "", secondRevisionCtx);
		const fallbackRoles = harness.reviewRequests.map(({ role }) => role);
		assert.ok(!fallbackRoles.includes("incremental-scope"), "an unrelated history falls back to a full review");
		assert.ok(
			harness.notifications.some(({ message }) => /generating a full review/i.test(message)),
			"the fallback is explained",
		);
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "head333");
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0003.json")), true);
	}

	// /workflow-revise works straight after implementation, without any review.
	{
		const workflow = await writeCompletedWorkflow("revise-before-review");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		harness.setEditorResult("Tighten the error handling.");
		await harness.run("workflow-revise", "", ctx);
		assert.equal(harness.switches.length, 1);
		assert.match(harness.userMessages.at(-1), /Tighten the error handling/);
		assert.doesNotMatch(harness.userMessages.at(-1), /review/i, "without a saved review the prompt omits it");
	}

	// /workflow-cleanup removes the worktree directly when the session is outside it.
	{
		const workflow = await writeCompletedWorkflow("direct-cleanup");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.repositoryRoot, []);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 1, "a missing review requires confirmation");
		assert.match(harness.confirmations[0].title, /No up-to-date review/);
		assert.equal(harness.switches.length, 0, "cleanup outside the worktree removes it in place");
		assert.equal(await storage.pathExists(workflow.worktreePath), false);
		assert.ok(
			harness.entries.some(
				(entry) =>
					entry.customType === "implementation-workflow-completion" &&
					entry.data.title === "Workflow cleanup complete",
			),
		);
	}

	// /workflow-cleanup from inside the worktree switches out first, then removes.
	{
		const workflow = await writeCompletedWorkflow("switching-cleanup");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		await storage.appendWorkflowReview(workflow.files, {
			version: 2,
			pullRequestUrls: ["https://example.test/pull/20"],
			baseCommit: "base000",
			headCommit: "head111",
			sourceFingerprint: "irrelevant",
			generatedAt: "2026-01-02T00:00:00.000Z",
			overallResult: {
				summary: "Fine.",
				necessary: { status: "yes", explanation: "Fine." },
				sufficient: { status: "yes", explanation: "Fine." },
			},
			overallConcerns: [],
			plannedChanges: [{
				id: "PC-01",
				title: "Complete the verbs",
				what: "Support explicit workflow verbs.",
				why: "The workflow must stay flexible.",
				review: await reviewAgentRunner({ role: "planned-change" }),
			}],
			testingCriteria: {
				originalCriteria: "Verify each verb.",
				review: await reviewAgentRunner({ role: "testing-criteria" }),
			},
		});
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 0, "an up-to-date review needs no confirmation");
		assert.equal(harness.switches.length, 1);
		const cleanupPhase = await sessionPhase(harness.switches[0]);
		assert.deepEqual(cleanupPhase.data, {
			phase: "cleanup",
			identifier: workflow.metadata.identifier,
			force: false,
		});
		assert.equal((await sessionEntries(harness.switches[0]))[0].cwd, workflow.repositoryRoot);

		const cleanupHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const cleanupCtx = cleanupHarness.context(workflow.repositoryRoot, [cleanupPhase]);
		await cleanupHarness.emit("session_start", cleanupCtx);
		assert.equal(await storage.pathExists(workflow.worktreePath), false);
		assert.ok(
			cleanupHarness.entries.some(
				(entry) =>
					entry.customType === "implementation-workflow-completion" &&
					entry.data.title === "Workflow cleanup complete",
			),
		);
		assert.equal(
			cleanupHarness.entries.at(-1).customType,
			"implementation-workflow-phase",
			"finished cleanup records the completed session phase",
		);
	}

	// A stale review makes cleanup ask before proceeding, and a decline stops it.
	{
		const workflow = await writeCompletedWorkflow("stale-review-cleanup");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		await storage.appendWorkflowReview(workflow.files, {
			version: 2,
			pullRequestUrls: ["https://example.test/pull/21"],
			baseCommit: "base000",
			headCommit: "older-head",
			sourceFingerprint: "irrelevant",
			generatedAt: "2026-01-02T00:00:00.000Z",
			overallResult: {
				summary: "Fine.",
				necessary: { status: "yes", explanation: "Fine." },
				sufficient: { status: "yes", explanation: "Fine." },
			},
			overallConcerns: [],
			plannedChanges: [{
				id: "PC-01",
				title: "Complete the verbs",
				what: "Support explicit workflow verbs.",
				why: "The workflow must stay flexible.",
				review: await reviewAgentRunner({ role: "planned-change" }),
			}],
			testingCriteria: {
				originalCriteria: "Verify each verb.",
				review: await reviewAgentRunner({ role: "testing-criteria" }),
			},
		});
		harness.setConfirmResult(false);
		const ctx = harness.context(workflow.repositoryRoot, []);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0].message, /branch changed after the latest review/);
		assert.equal(await storage.pathExists(workflow.worktreePath), true, "a declined confirmation keeps the worktree");
	}

	// Identifier resolution: explicit arguments, pickers, and completions.
	{
		const repositoryRoot = join(temporaryRoot, "shared-repository");
		const first = await writeCompletedWorkflow("shared-first", { repositoryRoot, createdAt: "2026-01-01T00:00:00.000Z" });
		const second = await writeCompletedWorkflow("shared-second", { repositoryRoot, createdAt: "2026-01-02T00:00:00.000Z" });
		const harness = createHarness(repositoryRoot, second.worktreePath, second.workflowBranch);
		const ctx = harness.context(repositoryRoot, []);
		await harness.emit("session_start", ctx);

		// An ambiguous verb offers a picker sorted by recency.
		harness.setEditorResult("");
		await harness.run("workflow-revise", "", ctx);
		assert.equal(harness.selections.length, 1);
		assert.deepEqual(harness.selections[0].options, [
			"shared-second — Untangle shared-second",
			"shared-first — Untangle shared-first",
		]);
		assert.match(harness.notifications.at(-1).message, /no change request/i);

		// An explicit identifier argument skips the picker.
		harness.setEditorResult("Adjust the first workflow.");
		await harness.run("workflow-revise", "shared-first", ctx);
		assert.equal(harness.selections.length, 1, "an explicit argument skips the picker");
		assert.equal(harness.switches.length, 1);
		assert.deepEqual((await sessionPhase(harness.switches[0])).data, {
			phase: "revision",
			identifier: "shared-first",
		});

		// Argument completions list known workflows.
		const completions = await harness.commands.get("workflow-review").getArgumentCompletions("shared-");
		assert.deepEqual(completions.map(({ value }) => value), ["shared-second", "shared-first"]);

		// A cleaned-up worktree is reported clearly.
		await rm(first.worktreePath, { recursive: true, force: true });
		await harness.run("workflow-implement", "shared-first", ctx);
		assert.match(harness.notifications.at(-1).message, /no worktree/i);
	}
} finally {
	await dashboardServer.closeOwnedDashboardServer();
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Verbs test passed: plan, implement, review, revise, and cleanup verbs run from live workflow state.");
