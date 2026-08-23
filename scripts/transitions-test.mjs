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
	const switches = [];
	const userMessages = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let switchCancelled = false;
	let pullRequest;

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
				return { code: 0, stdout: "abc123\n", stderr: "" };
			}
			if (gitArgs[0] === "branch" && gitArgs[1] === "--show-current") {
				return { code: 0, stdout: `${cwd === worktreePath ? workflowBranch : "main"}\n`, stderr: "" };
			}
			if (gitArgs[0] === "status") return { code: 0, stdout: "", stderr: "" };
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
	implementationWorkflow(pi);

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
				});
				return { cancelled: false };
			},
			ui: {
				confirm: async () => true,
				notify: (message, level) => notifications.push({ message, level }),
				setStatus() {},
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
		switches,
		userMessages,
		getActiveTools: () => [...activeTools],
		getEventHandlers: (name) => [...(events.get(name) ?? [])],
		setPullRequest(value) {
			pullRequest = value;
		},
		setSwitchCancelled(value) {
			switchCancelled = value;
		},
	};
}

async function writeCompletedWorkflow(identifier, status, options = {}) {
	const repositoryRoot = options.repositoryRoot ?? join(temporaryRoot, identifier, "repository");
	const worktreePath = options.worktreePath ?? join(repositoryRoot, ".worktrees", identifier);
	const workflowBranch = `workflow/${identifier}`;
	await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
	await mkdir(worktreePath, { recursive: true });
	const files = storage.workflowFiles(identifier);
	await mkdir(files.versions, { recursive: true });
	await writeFile(files.plan, "# Implementation plan\n\nImplement the transition.\n", "utf8");
	await writeFile(join(files.versions, "0001.md"), "# Implementation plan\n\nImplement the transition.\n", "utf8");
	await writeFile(files.clarifications, '{"version":1,"entries":[]}\n', "utf8");
	const metadata = {
		version: storage.WORKFLOW_STATE_VERSION,
		identifier,
		description: "Unify phase transitions",
		ask: "Unify all workflow phase transitions under /workflow-next.",
		status,
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
		await storage.createDraft(storage.draftFiles(draftId), "# Implementation plan\n\nUnify transitions.\n", {
			version: storage.WORKFLOW_STATE_VERSION,
			status: "planning",
			draftId,
			description: "Unify phase transitions",
			ask: "Unify all workflow phase transitions under /workflow-next.",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		const harness = createHarness(repositoryRoot, worktreePath, workflowBranch);
		assert.deepEqual([...harness.commands.keys()], ["workflow-plan", "workflow-next", "workflow-dashboard"]);
		const ctx = harness.context(repositoryRoot, [phaseEntry("planning", { draftId })]);
		await harness.emit("session_start", ctx);
		harness.setSwitchCancelled(true);
		await harness.commands.get("workflow-next")("", ctx);
		assert.equal(harness.switches.length, 1);
		assert.equal((await readMetadata(identifier)).status, "implementing");
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
		assert.equal(completed.status, "implementation_complete");
		assert.equal(completed.pullRequestUrl, "https://example.test/pull/17");
		const completion = harness.entries.find(
			(entry) => entry.customType === "implementation-workflow-completion",
		);
		assert.equal(completion.data.command, "/workflow-next");
		assert.deepEqual(completion.data.details, ["Pull request: https://example.test/pull/17"]);
		await harness.commands.get("workflow-next")("", ctx);
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "reviewing");
		assert.match(harness.userMessages.at(-1), /Review pull request https:\/\/example\.test\/pull\/17/);
	}

	{
		const workflow = await writeCompletedWorkflow("manual-completion-retry", "implementing");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.emit("agent_settled", ctx);
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "implementing");
		harness.setPullRequest({
			number: 18,
			url: "https://example.test/pull/18",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		await harness.commands.get("workflow-next")("", ctx);
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "reviewing");
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
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "reviewing");

		const resumedHarness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const resumedCtx = resumedHarness.context(workflow.worktreePath, [
			phaseEntry("implementation", { identifier: workflow.metadata.identifier }),
		]);
		await resumedHarness.emit("session_start", resumedCtx);
		assert.equal(resumedHarness.getActiveTools().includes("workflow_questions"), false);
		const beforeAgentStart = resumedHarness.getEventHandlers("before_agent_start")[0];
		assert.equal(
			await beforeAgentStart({ systemPrompt: "base prompt" }, resumedCtx),
			undefined,
			"a resumed implementation session does not reactivate implementation after review starts",
		);
		await resumedHarness.commands.get("workflow-next")("", resumedCtx);
		assert.equal(resumedHarness.switches.length, 1, "a cancelled review switch can be retried after resume");
		assert.match(resumedHarness.userMessages.at(-1), /Review pull request/);
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
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "cleanup_pending");
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
		assert.equal((await readMetadata(workflow.metadata.identifier)).status, "review_complete");
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
