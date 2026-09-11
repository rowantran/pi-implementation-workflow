import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { stream as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { planFixture, writePlanFixture } from "./plan-fixture.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-verbs-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const implementationWorkflow = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname, {
	default: true,
});
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const dashboardServer = await jiti.import(new URL("../src/dashboard-server.ts", import.meta.url).pathname);
const { readReviewSourceFingerprint } = await jiti.import(new URL("../src/review-selection.ts", import.meta.url).pathname);

const validPlan = planFixture({
	schemaVersion: 1, // Keep the shared fixture legacy-shaped; current scopes normalize its flags.
	readingOrder: ["complete-verbs"],
	goal: "Complete the workflow verbs.",
	testing: "Verify each verb.",
	changes: [{
		id: "complete-verbs",
		title: "Complete the verbs",
		dependsOn: [],
		content: "Support explicit workflow verbs so the workflow stays flexible.\n\nKeep briefing read-only and preserve workflow identity across session switches.\n\n```text\nprocedure RunVerb()\n```",
	}],
});

async function reviewAgentRunner(request) {
	if (request.role === "incremental-scope") {
		return {
			summary: "The revision affects the verbs planned change.",
			relevantPlannedChanges: [{
				id: "complete-verbs",
				explanation: "The revision changes the verb implementation.",
			}],
		};
	}
	if (request.role === "planned-change") {
		return {
			id: "complete-verbs",
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
				sourceId: "plan:testing",
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

async function legacyTestingReview() {
	const result = await reviewAgentRunner({ role: "testing-criteria" });
	return { ...result, criteria: result.criteria.map(({ sourceId, ...criterion }) => criterion) };
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
	const toolChanges = [];
	const modelChanges = [];
	const thinkingChanges = [];
	const sessionNames = [];
	const executions = [];
	let currentCtx;
	let generation = 0;
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

	function install() {
	commands.clear();
	events.clear();
	const ownGeneration = ++generation;
	const assertCurrent = () => assert.equal(ownGeneration, generation, "retired extension API used after session replacement");
	const pi = {
		appendEntry(customType, data) {
			assertCurrent();
			entries.push({ customType, data });
			currentCtx?.sessionManager.getBranch().push({ type: "custom", customType, data });
		},
		exec: async (command, args, options = {}) => {
			assertCurrent();
			executions.push({ command, args });
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
			const gitArgs = args[2] === "-c" ? args.slice(4) : args.slice(2);
			if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--show-toplevel") {
				const root = cwd.includes("/.worktrees/") ? cwd.split("/.worktrees/")[0] + "/.worktrees/" + cwd.split("/.worktrees/")[1].split("/")[0] : repositoryRoot;
				return { code: 0, stdout: `${root}\n`, stderr: "" };
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
			if (gitArgs[0] === "log" || gitArgs[0] === "rev-list") {
				assert.ok(gitArgs.some((arg) => arg.includes("exclude") && arg.includes(".workflows")), "content HEAD excludes workflow bookkeeping");
				return { code: 0, stdout: `${headCommit}\n`, stderr: "" };
			}
			if (gitArgs[0] === "show-ref" || (gitArgs[0] === "rev-parse" && gitArgs.includes("--verify"))) return { code: 1, stdout: "", stderr: "" };
			assert.ok(gitArgs[0] !== "add" && gitArgs[0] !== "commit", "workflow verbs never stage or commit records");
			if (gitArgs[0] === "diff") return { code: 0, stdout: "", stderr: "" };
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
		getActiveTools: () => { assertCurrent(); return [...activeTools]; },
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
			assertCurrent();
			userMessages.push(message);
		},
		setActiveTools(tools) {
			assertCurrent();
			toolChanges.push([...tools]);
			activeTools = [...tools];
		},
		async setModel(model) { assertCurrent(); modelChanges.push(model); return true; },
		setThinkingLevel(level) { assertCurrent(); thinkingChanges.push(level); },
		setSessionName(name) { assertCurrent(); sessionNames.push(name); },
	};
	implementationWorkflow(pi, {
		reviewAgentRunner: async (request) => {
			reviewRequests.push(request);
			return reviewAgentRunner(request);
		},
	});
	}
	install();

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
				const saved = await sessionEntries(sessionFile);
				await emit("session_shutdown", currentCtx, { reason: "resume" });
				const replacement = context(saved[0].cwd, saved.slice(1));
				await emit("session_start", replacement, { reason: "resume" });
				await options.withSession?.({
					...replacement,
					sendUserMessage: async (message) => {
						assert.equal(currentCtx, replacement, "kickoff uses the replacement context after session_start");
						const instructions = await emit("before_agent_start", replacement, { systemPrompt: "Replacement session" });
						assert.ok(instructions?.systemPrompt, "role is restored before kickoff");
						userMessages.push(message);
					},
				});
				return { cancelled: false };
			},
			ui: {
				confirm: async (title, message) => {
					confirmations.push({ title, message });
					return typeof confirmResult === "function" ? confirmResult(title) : confirmResult;
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

	async function emit(name, ctx = currentCtx, event = {}) {
		if (name === "session_start") {
			// A replacement loads a new extension instance, not just a new context.
			if (currentCtx && currentCtx !== ctx) install();
			currentCtx = ctx;
			activeTools = ["read", "bash", "edit", "write"];
		}
		let result;
		for (const handler of events.get(name) ?? []) result = await handler(event, ctx) ?? result;
		return result;
	}

	async function run(command, args = "", ctx = currentCtx) {
		assert.equal(ctx, currentCtx, "commands must use the current replacement context");
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
		toolChanges, modelChanges, thinkingChanges, sessionNames, executions,
		currentContext: () => currentCtx,
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
	const files = storage.workflowFiles(identifier, worktreePath);
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
		approvedPlanVersion: 1,
		...options.metadata,
	};
	const initialMetadata = { ...metadata };
	delete initialMetadata.approvedPlanVersion;
	await storage.createWorkflow(files, initialMetadata);
	await storage.registerWorkflow(initialMetadata);
	await writePlanFixture(files.workingPlan, validPlan);
	await storage.finalizePlanDraft(files, metadata.description, 0);
	if (metadata.approvedPlanVersion !== undefined) await storage.writeCompletedWorkflowMetadata(metadata);
	return { files, metadata, repositoryRoot, worktreePath, workflowBranch };
}

async function readMetadata(identifier) {
	return storage.readCompletedWorkflowMetadata(identifier);
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
	// /workflow-brief attaches context, not a role, and preserves the existing session.
	for (const approved of [false, true]) {
		const workflow = await writeCompletedWorkflow(`brief-${approved ? "approved" : "draft"}`, {
			metadata: { approvedPlanVersion: approved ? 1 : undefined },
		});
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		const ctx = harness.context(join(workflow.worktreePath, "src"), []);
		await harness.emit("session_start", ctx);
		const planPath = storage.planDirectory(workflow.files, approved ? 1 : undefined);
		assert.equal(planPath, approved ? join(workflow.files.versions, "v1") : workflow.files.latestPlan);
		const before = {
			tools: harness.getActiveTools(), toolChanges: harness.toolChanges.length,
			models: harness.modelChanges.length, thinking: harness.thinkingChanges.length,
			names: harness.sessionNames.length,
			plan: (await storage.readPlanVersion(workflow.files, 1)).document,
			metadata: await readFile(workflow.files.metadata, "utf8"),
			clarifications: await readFile(workflow.files.clarifications, "utf8"),
		};
		await harness.run("workflow-brief");
		assert.equal(harness.currentContext(), ctx);
		assert.equal(harness.switches.length, 0);
		assert.deepEqual(harness.getActiveTools(), before.tools);
		assert.equal(harness.toolChanges.length, before.toolChanges);
		assert.equal(harness.modelChanges.length, before.models);
		assert.equal(harness.thinkingChanges.length, before.thinking);
		assert.equal(harness.sessionNames.length, before.names);
		assert.deepEqual(harness.entries.at(-1), {
			customType: "implementation-workflow-binding", data: { identifier: workflow.metadata.identifier },
		});
		assert.ok(!harness.entries.some(({ customType }) => customType === "implementation-workflow-phase"));
		const prompt = harness.userMessages.at(-1);
		for (const file of [workflow.files.metadata, planPath, workflow.files.clarifications]) assert.ok(prompt.includes(file));
		assert.match(prompt, /then wait for my next task/);
		assert.match(prompt, approved ? /The plan is approved/ : /NOT approved/);
		assert.deepEqual((await storage.readPlanVersion(workflow.files, 1)).document, before.plan);
		assert.equal(await readFile(workflow.files.metadata, "utf8"), before.metadata);
		assert.equal(await readFile(workflow.files.clarifications, "utf8"), before.clarifications);
		assert.ok(!harness.executions.some(({ args }) => args.includes("add") || args.includes("commit")));

		// Only the custom binding must survive resume/compaction; full plans are not injected each turn.
		const resumed = harness.context(ctx.cwd, [{ type: "custom", ...harness.entries.at(-1) }]);
		await harness.emit("session_start", resumed);
		const restored = await harness.emit("before_agent_start", resumed, { systemPrompt: "Base instructions" });
		assert.ok(restored.systemPrompt.startsWith("Base instructions\n"));
		assert.ok(restored.systemPrompt.includes(planPath));
		assert.ok(!restored.systemPrompt.includes(validPlan.changes[0].content));
		assert.equal(harness.sessionNames.length, before.names);
		if (!approved) {
			await storage.writeCompletedWorkflowMetadata({ ...workflow.metadata, approvedPlanVersion: 1 });
			const updated = await harness.emit("before_agent_start", resumed, { systemPrompt: "Base" });
			assert.match(updated.systemPrompt, /The plan is approved/);
			assert.doesNotMatch(updated.systemPrompt, /NOT approved/);
			assert.ok(updated.systemPrompt.includes(join(workflow.files.versions, "v1")));
		}
	}

	// Historical committed bundles without an active marker must never be auto-selected.
	{
		const workflow = await writeCompletedWorkflow("brief-historical");
		await rm(storage.activeWorkflowMarkerPath(workflow.worktreePath));
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		await harness.emit("session_start", harness.context(workflow.worktreePath, []));
		await harness.run("workflow-brief");
		assert.equal(harness.userMessages.length, 0);
		assert.equal(harness.entries.length, 0);
		assert.match(harness.notifications.at(-1).message, /No workflows/);
	}

	// A role-bound session can be briefed on itself without losing its role or tools.
	{
		const workflow = await writeCompletedWorkflow("brief-role");
		const other = await writeCompletedWorkflow("brief-other-role", { repositoryRoot: workflow.repositoryRoot });
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		await harness.emit("session_start", harness.context(workflow.repositoryRoot, [phaseEntry("review", { identifier: workflow.metadata.identifier })]));
		const tools = harness.getActiveTools();
		await harness.run("workflow-brief");
		assert.deepEqual(harness.getActiveTools(), tools);
		assert.ok(tools.includes("write"), "briefing preserves review draft-editing permissions");
		assert.ok(!tools.includes("bash"));
		assert.equal(harness.switches.length, 0);
		const messageCount = harness.userMessages.length;
		await harness.run("workflow-brief", other.metadata.identifier);
		assert.equal(harness.userMessages.length, messageCount);
		assert.match(harness.notifications.at(-1).message, /already has a role in another workflow/);
	}

	// Planning already owns its worktree; /workflow-implement approves and switches sessions.
	{
		const identifier = "workflow-verbs";
		const { repositoryRoot, worktreePath, workflowBranch } = await writeCompletedWorkflow(identifier, {
			metadata: { approvedPlanVersion: undefined },
		});
		const harness = createHarness(repositoryRoot, worktreePath, workflowBranch);
		assert.deepEqual(
			[...harness.commands.keys()],
			["workflow-plan", "workflow-implement", "workflow-brief", "workflow-review", "workflow-revise", "workflow-cleanup", "workflow-dashboard"],
		);
		harness.setHeadCommit("base000");
		const ctx = harness.context(worktreePath, [phaseEntry("planning", { identifier })]);
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
		assert.equal(metadata.approvedPlanVersion, 1);
		assert.ok(!harness.executions.some(({ args }) => args.includes("worktree") && args.includes("add")), "implementation does not create another worktree");
		assert.match(harness.userMessages.at(-1), /Implement the plan/);
		assert.ok(harness.userMessages.at(-1).includes(join(storage.workflowFiles(identifier).versions, "v1")));
		assert.deepEqual((await sessionPhase(harness.switches[0])).data, {
			phase: "implementation",
			identifier,
		});

		// Re-entry: /workflow-implement from any session bound to the workflow starts a fresh implementation session.
		const implementationCtx = harness.currentContext();
		assert.notEqual(implementationCtx, ctx);
		await harness.run("workflow-implement");
		assert.equal(harness.switches.length, 2);

		// /workflow-plan refuses to run in a session bound to a workflow.
		await harness.run("workflow-plan");
		assert.match(harness.notifications.at(-1).message, /belongs to workflow workflow-verbs/);
		await harness.emit("session_shutdown");
	}

	// Slug generation must not send reasoning.effort=none to always-reasoning models,
	// including custom model aliases whose catalog does not declare that limitation.
	for (const { name, modelOverrides = {}, expectedEffort } of [
		{ name: "missing-thinking-map", expectedEffort: "low" },
		{ name: "always-reasoning", modelOverrides: { thinkingLevelMap: { off: null, minimal: null } }, expectedEffort: "low" },
		{ name: "higher-minimum", modelOverrides: { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } }, expectedEffort: "high" },
		{ name: "mapped-effort", modelOverrides: { thinkingLevelMap: { low: "medium" } }, expectedEffort: "medium" },
		{ name: "non-reasoning", modelOverrides: { reasoning: false }, expectedEffort: undefined },
		{ name: "completions", modelOverrides: { api: "openai-completions" }, expectedEffort: "low" },
		{ name: "codex", modelOverrides: { api: "openai-codex-responses" }, expectedEffort: "low" },
		{ name: "azure", modelOverrides: { api: "azure-openai-responses" }, expectedEffort: "low" },
		{ name: "anthropic", modelOverrides: { api: "anthropic-messages" }, expectedEffort: undefined },
	]) {
		const identifier = `slug-${name}`;
		const repositoryRoot = join(temporaryRoot, identifier);
		const worktreePath = join(repositoryRoot, ".worktrees", identifier);
		await mkdir(join(repositoryRoot, ".git", "info"), { recursive: true });
		const harness = createHarness(repositoryRoot, worktreePath, `workflow/${identifier}`);
		const ask = "Start planning with an always-reasoning model.";
		harness.setEditorResult(ask);
		const ctx = harness.context(repositoryRoot, []);
		ctx.model = {
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			provider: "test-proxy",
			api: "openai-responses",
			baseUrl: "https://unused.example.test/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...modelOverrides,
		};
		ctx.thinkingLevel = "high";
		const payloads = [];
		let completionCalls = 0;
		ctx.modelRegistry.complete = async (model, context, options) => {
			completionCalls++;
			assert.equal(model, ctx.model, "slug generation keeps the selected model");
			assert.equal(options.cacheRetention, "none");
			assert.ok(options.sessionId);
			assert.ok(context.messages[0].content[0].text.includes(ask), "slug generation uses the submitted ask");
			if (model.api !== "openai-responses") {
				assert.equal(options.reasoningEffort, expectedEffort, name);
				return { stopReason: "stop", content: [{ type: "text", text: identifier }] };
			}
			return streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-only",
				maxRetries: 0,
				fetch: async (_url, init) => {
					const payload = JSON.parse(init.body);
					payloads.push(payload);
					if (payload.reasoning?.effort === "none") {
						return Response.json({ error: {
							message: "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.",
							type: "invalid_request_error",
							param: "reasoning.effort",
							code: "unsupported_value",
						} }, { status: 400 });
					}
					const item = {
						id: "msg_slug", type: "message", role: "assistant", status: "completed",
						content: [{ type: "output_text", text: identifier, annotations: [] }],
					};
					const events = [
						{ type: "response.output_item.done", output_index: 0, item },
						{ type: "response.completed", response: { status: "completed", output: [item] } },
					];
					return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "Content-Type": "text/event-stream" },
					});
				},
			}).result();
		};
		await harness.emit("session_start", ctx);
		await harness.run("workflow-plan", "", ctx);
		assert.equal(harness.switches.length, 1, JSON.stringify(harness.notifications));
		assert.equal(completionCalls, 1, "a supported effort succeeds without retrying");
		if (ctx.model.api === "openai-responses") {
			assert.equal(payloads.length, 1);
			assert.equal(payloads[0].reasoning?.effort, expectedEffort, name);
		}
		assert.equal(ctx.thinkingLevel, "high", "slug generation does not change session thinking");
		assert.equal((await readMetadata(identifier)).worktreePath, worktreePath);
		const files = storage.workflowFiles(identifier);
		assert.equal(await storage.readPlanVersion(files), undefined, "planning starts without a finalized placeholder");
		assert.equal(await storage.pathExists(files.latestPlan), false);
		assert.deepEqual(JSON.parse(await readFile(join(files.workingPlan, "plan.json"), "utf8")), { schemaVersion: 2, readingOrder: [] });
		assert.equal(await readFile(join(files.workingPlan, "goal.md"), "utf8"), "");
		assert.equal((await readMetadata(identifier)).approvedPlanVersion, undefined);
		assert.equal((await readMetadata(identifier)).ask, ask);
		assert.deepEqual((await sessionPhase(harness.switches[0])).data, { phase: "planning", identifier });
		await harness.emit("session_shutdown");
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
		// A progress-only version preserves every baseline requirement and does not certify it.
		await storage.preparePlanDraft(workflow.files);
		await writePlanFixture(workflow.files.workingPlan, {
			...validPlan, schemaVersion: 2,
			changes: validPlan.changes.map((change) => ({ ...change, implemented: true })),
		});
		await storage.finalizePlanDraft(workflow.files, "Record implementation assessment", 1, { phase: "implementation" });
		assert.equal((await storage.readPlanVersion(workflow.files)).number, 2);
		assert.equal((await readMetadata(workflow.metadata.identifier)).approvedPlanVersion, 1);
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
		assert.equal(harness.switches.length, 1, JSON.stringify(harness.notifications));
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
		const firstReport = await storage.readWorkflowReview(workflow.files);
		assert.equal(firstReport.headCommit, "head111");
		assert.equal(firstReport.version, 4);
		assert.equal(firstReport.baselinePlanVersion, 1);
		assert.equal(firstReport.currentPlanVersion, 2);
		assert.deepEqual(firstReport.plannedChanges.map(({ review, ...change }) => change), validPlan.changes.map((change) => ({ ...change, kind: "original" })));
		assert.equal(await storage.pathExists(join(workflow.files.reviews, "0001.json")), true);
		const firstRunRoles = harness.reviewRequests.map(({ role }) => role);
		assert.ok(!firstRunRoles.includes("incremental-scope"), "the first review is a full review");
		for (const { prompt } of harness.reviewRequests) {
			assert.ok(prompt.includes(join(workflow.files.versions, "v1")), "review prompts reference the exact approved directory");
			assert.ok(prompt.includes(validPlan.changes[0].content), "reviewers receive the full approved prose");
			assert.doesNotMatch(prompt, /PC-\d+|PC-\*/);
		}
		assert.ok(!harness.executions.some(({ args }) => args.includes("add") || args.includes("commit")), "review saves reports without staging or committing any workflow files");

		// Reuse: the same approved inputs and commits are never re-reviewed.
		const reviewCtx = harness.currentContext();
		assert.notEqual(reviewCtx, ctx);
		assert.equal(harness.getActiveTools().includes("edit"), true, "review sessions can edit followup drafts");
		assert.equal(harness.getActiveTools().includes("workflow_update_plan"), true);
		assert.equal(harness.getActiveTools().includes("bash"), false, "review shell writes cannot bypass draft guards");
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
		const revisionCtx = harness.currentContext();
		assert.notEqual(revisionCtx, reviewCtx);
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
		for (const { prompt } of harness.reviewRequests) {
			assert.ok(prompt.includes(join(workflow.files.versions, "v1")));
			assert.ok(prompt.includes(validPlan.changes[0].content));
			assert.ok(!prompt.includes("Unapproved replacement prose."));
		}

		// Fallback: when no saved review is a Git ancestor, a full review is generated instead of an error.
		harness.setHeadCommit("head333");
		harness.setPullRequest({
			number: 17,
			url: "https://example.test/pull/17",
			baseRefName: "main",
			headRefName: workflow.workflowBranch,
		});
		harness.setAncestorCheck((ancestor, descendant) => ancestor === "base000" || ancestor === descendant);
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
		assert.equal(harness.confirmations.length, 2, "local records and a missing review each require confirmation");
		assert.match(harness.confirmations[0].title, /Remove local workflow records/);
		assert.match(harness.confirmations[0].message, /delete its local plans, clarifications, reviews, and working drafts/);
		assert.match(harness.confirmations[1].title, /No up-to-date review/);
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
			version: 3,
			pullRequestUrls: ["https://example.test/pull/20"],
			baseCommit: "base000",
			headCommit: "head111",
			sourceFingerprint: await readReviewSourceFingerprint(workflow.files, workflow.metadata.ask),
			generatedAt: "2026-01-02T00:00:00.000Z",
			overallResult: {
				summary: "Fine.",
				necessary: { status: "yes", explanation: "Fine." },
				sufficient: { status: "yes", explanation: "Fine." },
			},
			overallConcerns: [],
			plannedChanges: [{
				...validPlan.changes[0],
				review: await reviewAgentRunner({ role: "planned-change" }),
			}],
			testingCriteria: {
				originalCriteria: validPlan.testing,
				review: await legacyTestingReview(),
			},
		});
		const ctx = harness.context(workflow.worktreePath, [
			phaseEntry("review", { identifier: workflow.metadata.identifier }),
		]);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 2, "cleanup confirms local record deletion and legacy v3 reviews cannot certify current coverage");
		assert.match(harness.confirmations[0].title, /Remove local workflow records/);
		assert.match(harness.confirmations[1].title, /No up-to-date review/);
		assert.equal(harness.switches.length, 1);
		const cleanupPhase = await sessionPhase(harness.switches[0]);
		assert.deepEqual(cleanupPhase.data, {
			phase: "cleanup",
			identifier: workflow.metadata.identifier,
			force: false,
		});
		assert.equal((await sessionEntries(harness.switches[0]))[0].cwd, workflow.repositoryRoot);

		assert.equal(harness.currentContext().cwd, workflow.repositoryRoot);
		assert.equal(await storage.pathExists(workflow.worktreePath), false);
		assert.equal(await harness.emit("before_agent_start", harness.currentContext(), { systemPrompt: "Base" }), undefined, "completed cleanup does not keep reading removed files");
		assert.ok(
			harness.entries.some(
				(entry) =>
					entry.customType === "implementation-workflow-completion" &&
					entry.data.title === "Workflow cleanup complete",
			),
		);
		assert.equal(
			harness.entries.at(-1).customType,
			"implementation-workflow-phase",
			"finished cleanup records the completed session phase",
		);
	}

	// A stale review makes cleanup ask before proceeding, and a decline stops it.
	{
		const workflow = await writeCompletedWorkflow("stale-review-cleanup");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		await storage.appendWorkflowReview(workflow.files, {
			version: 3,
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
				...validPlan.changes[0],
				review: await reviewAgentRunner({ role: "planned-change" }),
			}],
			testingCriteria: {
				originalCriteria: validPlan.testing,
				review: await legacyTestingReview(),
			},
		});
		harness.setConfirmResult((title) => title === "Remove local workflow records");
		const ctx = harness.context(workflow.repositoryRoot, []);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 2);
		assert.match(harness.confirmations[1].message, /branch or workflow sources changed after the latest review/);
		assert.equal(await storage.pathExists(workflow.worktreePath), true, "a declined confirmation keeps the worktree");
	}

	// Declining deletion of local records preserves the worktree and saved plan.
	{
		const workflow = await writeCompletedWorkflow("keep-local-records");
		const harness = createHarness(workflow.repositoryRoot, workflow.worktreePath, workflow.workflowBranch);
		harness.setConfirmResult(false);
		const ctx = harness.context(workflow.repositoryRoot, []);
		await harness.emit("session_start", ctx);
		await harness.run("workflow-cleanup", "", ctx);
		assert.equal(harness.confirmations.length, 1);
		assert.equal(harness.confirmations[0].title, "Remove local workflow records");
		assert.equal(await storage.pathExists(workflow.worktreePath), true);
		assert.equal((await storage.readPlanVersion(workflow.files)).number, 1);
		assert.ok(!harness.executions.some(({ args }) => args.includes("remove")));
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
		await harness.run("workflow-implement", "shared-first");
		assert.match(harness.notifications.at(-1).message, /no worktree/i);
	}
} finally {
	await dashboardServer.closeOwnedDashboardServer();
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Verbs test passed: briefing preserves sessions; plan, implement, review, revise, and cleanup use live workflow state.");
