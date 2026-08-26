import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-transitions-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const implementationWorkflow = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname, {
	default: true,
});
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);

const validPlan = `# Implementation plan

## Goal

Complete the workflow transition.

## Planned Changes

### PC-01: Complete the transition

**What**
Advance the workflow to its next phase.

**Why**
The workflow must progress deterministically.

**Pseudocode**
\`\`\`text
procedure AdvanceWorkflow()
\`\`\`

## Testing

Verify each transition.
`;

async function reviewAgentRunner(request) {
	if (request.role === "incremental-scope") {
		return {
			summary: "The revision affects the transition planned change.",
			relevantPlannedChanges: [{
				id: "PC-01",
				explanation: "The revision changes the workflow transition implementation.",
			}],
		};
	}
	if (request.role === "planned-change") {
		return {
			id: "PC-01",
			title: "Complete the transition",
			summary: "The transition is implemented.",
			necessary: { status: "yes", explanation: "It maps to the plan." },
			sufficient: { status: "yes", explanation: "The transition completes." },
			contracts: [],
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
			summary: "The transition criterion is satisfied.",
			satisfied: { status: "yes", explanation: "Transition tests pass." },
			criteria: [{
				criterion: "Verify each transition.",
				status: "yes",
				explanation: "The transition test covers each phase.",
				evidence: [{ location: "scripts/transitions-test.mjs:1", description: "Exercises workflow transitions." }],
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

async function sampleReview(headCommit, pullRequestUrl = "https://example.test/pull/21") {
	return {
		version: 1,
		pullRequestUrl,
		baseCommit: "abc123",
		headCommit,
		generatedAt: "2026-01-02T00:00:00.000Z",
		overallResult: {
			summary: "Review result.",
			necessary: { status: "yes", explanation: "Within scope." },
			sufficient: { status: "yes", explanation: "Complete." },
		},
		overallConcerns: [],
		plannedChanges: [{
			id: "PC-01",
			title: "Complete the transition",
			what: "Advance the workflow to its next phase.",
			why: "The workflow must progress deterministically.",
			pseudocode: "procedure AdvanceWorkflow()",
			review: await reviewAgentRunner({ role: "planned-change" }),
		}],
		testingCriteria: {
			originalCriteria: "Verify each transition.",
			review: await reviewAgentRunner({ role: "testing-criteria" }),
		},
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
	const widgets = new Map();
	const switches = [];
	const userMessages = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let switchCancelled = false;
	let pullRequest;
	let headCommit = "abc123";
	let worktreeStatus = "";

	const pi = {
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		exec: async (command, args, options = {}) => {
			if (command === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify(pullRequest ? [pullRequest] : []),
					stderr: "",
				};
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
				return { code: 0, stdout: `${cwd === worktreePath ? workflowBranch : "main"}\n`, stderr: "" };
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
			commands.set(name, definition.handler);
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
	implementationWorkflow(pi, { reviewAgentRunner });

	function context(cwd, branch) {
		return {
			cwd,
			hasUI: false,
			mode: "json",
			model: {},
			modelRegistry: {
				complete: async () => ({
					stopReason: "stop",
					content: [{ type: "text", text: "direct-phase-transitions" }],
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
					return true;
				},
				editor: async (_title, prefill) => prefill || "Address the review findings.",
				notify: (message, level) => notifications.push({ message, level }),
				setStatus() {},
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
		for (const handler of events.get(name) ?? []) await handler({}, ctx);
	}

	return {
		commands,
		context,
		emit,
		entries,
		notifications,
		confirmations,
		widgets,
		switches,
		userMessages,
		getActiveTools: () => [...activeTools],
		getEventHandlers: (name) => [...(events.get(name) ?? [])],
		setPullRequest(value) {
			pullRequest = { headRefOid: headCommit, ...value };
		},
		setHeadCommit(value) {
			headCommit = value;
		},
		setWorktreeStatus(value) {
			worktreeStatus = value;
		},
		setSwitchCancelled(value) {
			switchCancelled = value;
		},
	};
}

function stateForLegacyStatus(status) {
	switch (status) {
		case "ready_for_implementation": return { phase: "planning", step: "ready" };
		case "implementing": return { phase: "implementing", step: "active" };
		case "implementation_complete": return { phase: "implementing", step: "complete" };
		case "reviewing": return { phase: "reviewing", step: "active", round: 1 };
		case "cleanup_pending": return { phase: "complete", step: "cleanup_pending" };
		case "review_complete": return { phase: "complete", step: "complete" };
		default: throw new Error(`Unknown test state: ${status}`);
	}
}

async function writeCompletedWorkflow(identifier, status, options = {}) {
	const repositoryRoot = options.repositoryRoot ?? join(temporaryRoot, identifier, "repository");
	const worktreePath = options.worktreePath ?? join(repositoryRoot, ".worktrees", identifier);
	const workflowBranch = `workflow/${identifier}`;
	await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
	await mkdir(worktreePath, { recursive: true });
	const files = storage.workflowFiles(identifier);
	await mkdir(files.versions, { recursive: true });
	await writeFile(files.plan, validPlan, "utf8");
	await writeFile(join(files.versions, "0001.md"), validPlan, "utf8");
	await writeFile(files.clarifications, '{"version":1,"entries":[]}\n', "utf8");
	const metadata = {
		version: storage.WORKFLOW_STATE_VERSION,
		identifier,
		description: "Unify phase transitions",
		ask: "Unify all workflow phase transitions under /workflow-next.",
		state: stateForLegacyStatus(status),
		repositoryRoot,
		gitCommonDir: join(repositoryRoot, ".git"),
		baseBranch: "main",
		baseCommit: "abc123",
		workflowBranch,
		worktreePath,
		createdAt: "2026-01-01T00:00:00.000Z",
		...options.metadata,
	};
	await storage.writeCompletedWorkflowMetadata(metadata);
	return { files, metadata, repositoryRoot, worktreePath, workflowBranch };
}

async function readMetadata(identifier) {
	return JSON.parse(await readFile(storage.workflowFiles(identifier).metadata, "utf8"));
}

try {
	{
		const repositoryRoot = join(temporaryRoot, "planning-repository");
		const identifier = "direct-phase-transitions";
		const worktreePath = join(repositoryRoot, ".worktrees", identifier);
		const workflowBranch = `workflow/${identifier}`;
		await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
		const draftId = "planning-draft";
		await storage.createDraft(storage.draftFiles(draftId), validPlan, {
			version: storage.WORKFLOW_STATE_VERSION,
			state: { phase: "planning", step: "draft" },
			draftId,
			description: "Unify phase transitions",
			ask: "Unify all workflow phase transitions under /workflow-next.",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const harness = createHarness(repositoryRoot, worktreePath, workflowBranch);
		assert.deepEqual([...harness.commands.keys()], ["workflow-plan", "workflow-revise", "workflow-next", "workflow-dashboard"]);
		const ctx = harness.context(repositoryRoot, [phaseEntry("planning", { draftId })]);
		await harness.emit("session_start", ctx);
		harness.setSwitchCancelled(true);
		await harness.commands.get("workflow-next")("", ctx);
		assert.equal(harness.switches.length, 1);
		assert.deepEqual((await readMetadata(identifier)).state, { phase: "implementing", step: "active" });
		harness.setSwitchCancelled(false);
		await harness.commands.get("workflow-next")("", ctx);
		assert.equal(harness.switches.length, 2, "a cancelled implementation switch can be retried");
		assert.match(harness.userMessages.at(-1), /Implement the plan/);
		assert.match(harness.userMessages.at(-1), /immutable original ask/);
		assert.match(harness.userMessages.at(-1), /implementation questionnaire/);
		assert.doesNotMatch(harness.userMessages.at(-1), new RegExp(worktreePath));
		assert.doesNotMatch(harness.userMessages.at(-1), new RegExp(workflowBranch));
		assert.equal(harness.entries.some((entry) => entry.customType === "implementation-workflow-completion"), false);
		await harness.emit("session_shutdown", ctx);
	}

	{
		const workflow = await writeCompletedWorkflow("automatic-completion", "implementing");
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
		const beforeAgentStart = harness.getEventHandlers("before_agent_start")[0];
		const implementationPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);
		assert.match(implementationPrompt.systemPrompt, new RegExp(workflow.worktreePath));
		assert.match(implementationPrompt.systemPrompt, new RegExp(workflow.workflowBranch));
		await harness.emit("agent_settled", ctx);
		const completed = await readMetadata(workflow.metadata.identifier);
		assert.deepEqual(completed.state, { phase: "implementing", step: "complete" });
		assert.equal(completed.pullRequestUrl, "https://example.test/pull/17");
		const completion = harness.entries.find(
			(entry) => entry.customType === "implementation-workflow-completion",
		);
		assert.equal(completion.data.command, "/workflow-next");
		assert.deepEqual(completion.data.details, ["Pull request: https://example.test/pull/17"]);
		assert.match(completion.data.instruction, /^Send \/workflow-next/);
		assert.equal("clipboard" in completion.data, false, "completion does not report or attempt clipboard use");
		assert.equal(harness.widgets.size, 1, "completion keeps workflow-next visible below the editor");
		assert.equal([...harness.widgets.values()][0].options.placement, "belowEditor");
		await harness.commands.get("workflow-next")("", ctx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "reviewing", step: "active", round: 1 });
		assert.equal(harness.userMessages.length, 0, "review generation does not start another conversational agent");
		assert.match(harness.notifications.at(-1).message, /review is ready/i);
		assert.ok(await storage.pathExists(workflow.files.review));
		assert.ok(await storage.pathExists(workflow.files.reviewMarkdown));
	}

	{
		const workflow = await writeCompletedWorkflow("manual-completion-retry", "implementing");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.emit("agent_settled", ctx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "implementing", step: "active" });
		harness.setPullRequest({
			number: 18,
			url: "https://example.test/pull/18",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		await harness.commands.get("workflow-next")("", ctx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "reviewing", step: "active", round: 1 });
		assert.equal(
			harness.entries.filter((entry) => entry.customType === "implementation-workflow-completion").length,
			0,
			"a successful manual retry enters review without another handoff card",
		);
	}

	{
		const workflow = await writeCompletedWorkflow("cancelled-review-switch", "implementation_complete", {
			metadata: {
				pullRequestUrl: "https://example.test/pull/19",
				pullRequestNumber: 19,
			},
		});
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		harness.setSwitchCancelled(true);
		await harness.commands.get("workflow-next")("", ctx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "reviewing", step: "active", round: 1 });

		const resumedHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const resumedCtx = resumedHarness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await resumedHarness.emit("session_start", resumedCtx);
		assert.equal(resumedHarness.getActiveTools().includes("workflow_questions"), false);
		assert.equal(resumedHarness.widgets.size, 1, "a cancelled review switch restores the persistent reminder");
		const beforeAgentStart = resumedHarness.getEventHandlers("before_agent_start")[0];
		assert.equal(
			await beforeAgentStart({ systemPrompt: "base prompt" }, resumedCtx),
			undefined,
			"a resumed implementation session does not reactivate implementation after review starts",
		);
		await resumedHarness.commands.get("workflow-next")("", resumedCtx);
		assert.equal(resumedHarness.switches.length, 1, "a cancelled review switch can be retried after resume");
		assert.equal(resumedHarness.userMessages.length, 0);
		assert.match(resumedHarness.notifications.at(-1).message, /review is ready/i);
	}

	{
		const workflow = await writeCompletedWorkflow("review-revision-loop", "reviewing", {
			metadata: {
				pullRequestUrl: "https://example.test/pull/22",
				pullRequestNumber: 22,
			},
		});
		await storage.writeWorkflowReview(workflow.files, await sampleReview("abc123", "https://example.test/pull/22"), 1);
		const reviewHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const reviewCtx = reviewHarness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier, reviewRound: 1 }),
		]);
		await reviewHarness.emit("session_start", reviewCtx);
		assert.equal(reviewHarness.getActiveTools().includes("edit"), false, "review remains read-only");
		assert.deepEqual(
			reviewHarness.entries.find(
				(entry) => entry.customType === "implementation-workflow-phase-reminder",
			)?.data,
			{ phase: "review", draftId: undefined, identifier: workflow.metadata.identifier },
			"review persists the transcript card entry",
		);
		reviewHarness.setWorktreeStatus(" M src/index.ts\n");
		await reviewHarness.commands.get("workflow-revise")("Finish and review my worktree changes.", reviewCtx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, {
			phase: "revising",
			step: "active",
			round: 1,
			reviewedHeadCommit: "abc123",
		});
		assert.equal(reviewHarness.switches.length, 1);
		assert.match(reviewHarness.userMessages.at(-1), /Finish and review my worktree changes/);
		const revisionSession = (await readFile(reviewHarness.switches[0], "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const revisionPhase = revisionSession.find(
			(entry) => entry.type === "custom" && entry.customType === "implementation-workflow-phase",
		);
		assert.deepEqual(revisionPhase.data, {
			phase: "revision",
			identifier: workflow.metadata.identifier,
			reviewRound: 1,
		});
		await reviewHarness.commands.get("workflow-next")("", reviewCtx);
		assert.match(reviewHarness.notifications.at(-1).message, /cannot advance/i, "the prior review cannot clean up");

		const revisionHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		revisionHarness.setHeadCommit("new123");
		revisionHarness.setPullRequest({
			number: 22,
			url: "https://example.test/pull/22",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		const revisionCtx = revisionHarness.context(workflow.worktreePath, [
			phaseEntry("revision", { identifier: workflow.metadata.identifier, reviewRound: 1 }),
		]);
		await revisionHarness.emit("session_start", revisionCtx);
		assert.equal(revisionHarness.getActiveTools().includes("edit"), true);
		assert.equal(revisionHarness.getActiveTools().includes("workflow_questions"), true);
		await revisionHarness.emit("agent_settled", revisionCtx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, {
			phase: "revising",
			step: "complete",
			round: 1,
			reviewedHeadCommit: "abc123",
		});
		assert.equal(revisionHarness.widgets.size, 1, "revision completion keeps workflow-next visible");
		revisionHarness.setSwitchCancelled(true);
		await revisionHarness.commands.get("workflow-next")("", revisionCtx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, {
			phase: "reviewing",
			step: "active",
			round: 2,
		});
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "new123");
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0001.json")), true);
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0002.json")), true);

		const resumedRevisionHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		resumedRevisionHarness.setHeadCommit("new123");
		const resumedRevisionCtx = resumedRevisionHarness.context(workflow.worktreePath, [
			phaseEntry("revision", { identifier: workflow.metadata.identifier, reviewRound: 1 }),
		]);
		await resumedRevisionHarness.emit("session_start", resumedRevisionCtx);
		assert.equal(resumedRevisionHarness.widgets.size, 1, "a cancelled revision review switch restores the reminder");
		await resumedRevisionHarness.commands.get("workflow-next")("", resumedRevisionCtx);
		assert.equal(resumedRevisionHarness.switches.length, 1, "the revision review switch can be retried after resume");
		const secondReviewSession = (await readFile(resumedRevisionHarness.switches.at(-1), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const secondReviewPhase = secondReviewSession.find(
			(entry) => entry.type === "custom" && entry.customType === "implementation-workflow-phase",
		);
		assert.equal(secondReviewPhase.data.reviewRound, 2);
	}

	{
		const workflow = await writeCompletedWorkflow("adopt-existing-revision", "reviewing", {
			metadata: {
				pullRequestUrl: "https://example.test/pull/24",
				pullRequestNumber: 24,
			},
		});
		await storage.writeWorkflowReview(workflow.files, await sampleReview("abc123", "https://example.test/pull/24"), 1);
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		harness.setHeadCommit("new456");
		harness.setPullRequest({
			number: 24,
			url: "https://example.test/pull/24",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier, reviewRound: 1 }),
		]);
		await harness.emit("session_start", ctx);
		await harness.commands.get("workflow-revise")("This editor prefill must not start a revision agent.", ctx);
		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0].title, /existing commits/i);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, {
			phase: "reviewing",
			step: "active",
			round: 2,
		});
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "new456");
		assert.equal(harness.userMessages.length, 0, "an existing completed revision skips the revision agent session");
		assert.equal(harness.switches.length, 1, "the workflow switches directly to the next review session");
	}

	{
		const workflow = await writeCompletedWorkflow("unpushed-revision", "reviewing", {
			metadata: {
				state: {
					phase: "revising",
					step: "active",
					round: 1,
					reviewedHeadCommit: "abc123",
				},
				pullRequestUrl: "https://example.test/pull/23",
				pullRequestNumber: 23,
			},
		});
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		harness.setHeadCommit("new123");
		harness.setPullRequest({
			number: 23,
			url: "https://example.test/pull/23",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
			headRefOid: "abc123",
		});
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("revision", { identifier: workflow.metadata.identifier, reviewRound: 1 }),
		]);
		await harness.emit("session_start", ctx);
		await harness.emit("agent_settled", ctx);
		assert.equal((await readMetadata(workflow.metadata.identifier)).state.step, "active");
		assert.match(harness.notifications.at(-1).message, /has not been pushed/i);
	}

	{
		const workflow = await writeCompletedWorkflow("stale-review-regeneration", "reviewing", {
			metadata: {
				pullRequestUrl: "https://example.test/pull/21",
				pullRequestNumber: 21,
			},
		});
		await storage.writeWorkflowReview(workflow.files, {
			version: 1,
			pullRequestUrl: "https://example.test/pull/21",
			baseCommit: "abc123",
			headCommit: "old123",
			sourceFingerprint: "old-source",
			generatedAt: "2026-01-02T00:00:00.000Z",
			overallResult: {
				summary: "Old review.",
				necessary: { status: "yes", explanation: "Old result." },
				sufficient: { status: "yes", explanation: "Old result." },
			},
			overallConcerns: [],
			holisticReview: await reviewAgentRunner({ role: "holistic-review" }),
			plannedChanges: [{
				id: "PC-01",
				title: "Complete the transition",
				what: "Advance the workflow to its next phase.",
				why: "The workflow must progress deterministically.",
				pseudocode: "procedure AdvanceWorkflow()",
				review: await reviewAgentRunner({ role: "planned-change" }),
			}],
			testingCriteria: {
				originalCriteria: "Verify each transition.",
				review: await reviewAgentRunner({ role: "testing-criteria" }),
			},
		});
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		harness.setHeadCommit("new123");
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.commands.get("workflow-next")("", ctx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "reviewing", step: "active", round: 1 });
		assert.equal(harness.switches.length, 0, "a stale review must not clean up the worktree");
		assert.equal((await storage.readWorkflowReview(workflow.files)).headCommit, "old123");
		assert.match(harness.notifications.at(-1).message, /workflow-revise/i);
	}

	{
		const workflow = await writeCompletedWorkflow("deterministic-cleanup", "reviewing", {
			metadata: {
				pullRequestUrl: "https://example.test/pull/20",
				pullRequestNumber: 20,
			},
		});
		const reviewHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const reviewCtx = reviewHarness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier }),
		]);
		await reviewHarness.emit("session_start", reviewCtx);
		await reviewHarness.commands.get("workflow-next")("", reviewCtx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "complete", step: "cleanup_pending" });
		assert.equal(reviewHarness.userMessages.length, 0, "cleanup session switching does not invoke the model");
		const cleanupSession = (await readFile(reviewHarness.switches[0], "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(cleanupSession[0].cwd, workflow.repositoryRoot);
		const cleanupPhase = cleanupSession.find(
			(entry) => entry.type === "custom" && entry.customType === "implementation-workflow-phase",
		);
		assert.deepEqual(cleanupPhase.data, {
			phase: "cleanup",
			identifier: workflow.metadata.identifier,
		});

		const cleanupHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const cleanupCtx = cleanupHarness.context(workflow.repositoryRoot, [cleanupPhase]);
		await cleanupHarness.emit("session_start", cleanupCtx);
		assert.deepEqual((await readMetadata(workflow.metadata.identifier)).state, { phase: "complete", step: "complete" });
		assert.equal(cleanupHarness.userMessages.length, 0);
		assert.ok(
			cleanupHarness.entries.some(
				(entry) =>
					entry.customType === "implementation-workflow-completion" && entry.data.title === "Review complete",
			),
		);
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
	"Transition test passed: /workflow-next handles direct phase entry, automatic completion, retries, and cleanup.",
);
