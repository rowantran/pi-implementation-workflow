import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createJiti } from "jiti/static";
import { planFixture, writePlanFixture } from "./plan-fixture.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const workflowModule = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname);
const implementationWorkflow = workflowModule.default;
const { registerWorkflowPlanTool } = await jiti.import(new URL("../src/plan-tool.ts", import.meta.url).pathname);
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const { readWorkflowScope } = await jiti.import(new URL("../src/workflow-scope.ts", import.meta.url).pathname);

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function unusedPort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

async function scenario({ args = "", editorResult, planningModel, planningThinkingLevel, expectedIdentifier = "command-workflow", beforeStart, duringApproval, afterFirstStart, reviewAgentRunner } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-workflow-command-")));
	const agentDir = join(root, "agent");
	const repositoryRoot = join(root, "repository");
	const identifier = expectedIdentifier;
	const worktreePath = join(repositoryRoot, ".worktrees", identifier);
	const workflowRoot = join(worktreePath, ".workflows", identifier);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(repositoryRoot, { recursive: true });
	const git = async (cwd, ...args) => {
		if (args[0] === "branch" && args[1] === "--show-current" && existsSync(join(workflowRoot, ".plan.lock"))) {
			await duringApproval?.({ workflowRoot });
		}
		try {
			const result = await execFileAsync("git", ["-C", cwd, ...args]);
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
		}
	};
	for (const args of [["init", "-b", "main"], ["config", "user.name", "Workflow Test"], ["config", "user.email", "workflow@example.test"], ["config", "commit.gpgsign", "false"], ["config", "core.hooksPath", "/dev/null"]]) {
		assert.equal((await git(repositoryRoot, ...args)).code, 0);
	}
	await writeFile(join(repositoryRoot, "README.md"), "Workflow fixture\n");
	await writeFile(join(repositoryRoot, ".gitignore"), ".workflows/\n");
	assert.equal((await git(repositoryRoot, "add", "README.md", ".gitignore")).code, 0);
	assert.equal((await git(repositoryRoot, "commit", "-m", "Initial content")).code, 0);
	const baseCommit = (await git(repositoryRoot, "rev-parse", "HEAD")).stdout.trim();
	const initialExclude = await readFile(join(repositoryRoot, ".git", "info", "exclude"), "utf8");
	const configDirectory = join(agentDir, "implementation-workflow");
	await mkdir(configDirectory, { recursive: true });
	const dashboardConfig = `[dashboard]\nmode = "local"\nlisten_port = ${await unusedPort()}\n`;
	const modelConfig = planningModel
		? `provider = ${JSON.stringify(planningModel.provider)}\nmodel = ${JSON.stringify(planningModel.model)}\n`
		: "";
	const thinkingConfig = planningThinkingLevel ? `thinking_level = ${JSON.stringify(planningThinkingLevel)}\n` : "";
	await writeFile(join(configDirectory, "config.toml"), `${dashboardConfig}${modelConfig || thinkingConfig ? `\n[models.planning]\n${modelConfig}${thinkingConfig}` : ""}`);

	const editorCalls = [];
	const notifications = [];
	const phaseEntries = [];
	const sentMessages = [];
	const selectedModels = [];
	const selectedThinkingLevels = [];
	const executions = [];
	const switches = [];
	const slugRequests = [];
	let activeTools = ["read", "bash", "edit", "write"];
	let editorValue = editorResult;
	let current;
	let generation = 0;
	let kickoffAssertion;
	let pullRequests = [];
	let duringGitHubLookup;
	function install(cwd, branch = [], sessionId = "command-session") {
		const ownGeneration = ++generation;
		const assertCurrent = () => assert.equal(ownGeneration, generation, "retired extension API must not be used after replacement");
		const commands = new Map();
		const events = new Map();
		const tools = new Map();
		const pi = {
			appendEntry(type, data) {
				assertCurrent();
				branch.push({ type: "custom", customType: type, data });
				if (type === "implementation-workflow-phase") phaseEntries.push(data);
			},
			exec: async (command, args) => {
				assertCurrent();
				executions.push({ command, args });
				const gitCommand = args[2] === "-c" ? args[4] : args[2];
				if (command === "git") assert.ok(gitCommand !== "add" && gitCommand !== "commit", "workflow commands never stage or commit local records");
				if (command === "gh") {
					if (args[0] === "pr" && args[1] === "list") {
						const mutate = duringGitHubLookup;
						duringGitHubLookup = undefined;
						await mutate?.();
						return { code: 0, stdout: JSON.stringify(pullRequests), stderr: "" };
					}
					if (args[0] === "api") {
						const pr = pullRequests.find(({ number }) => number === Number(args[1].split("/").at(-1)));
						return pr ? { code: 0, stdout: `${pr.headRefOid}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "Unknown fixture pull request" };
					}
					throw new Error(`Unexpected GitHub call: ${args.join(" ")}`);
				}
				assert.equal(command, "git");
				assert.equal(args[0], "-C");
				return git(args[1], ...args.slice(2));
			},
			getActiveTools: () => { assertCurrent(); return [...activeTools]; },
			on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler]); },
			registerCommand(name, definition) { commands.set(name, definition); },
			registerEntryRenderer() {},
			registerShortcut() {},
			registerTool(definition) { tools.set(definition.name, definition); },
			sendUserMessage(message) {
				assertCurrent();
				kickoffAssertion?.(message);
				sentMessages.push(message);
			},
			setActiveTools(tools) { assertCurrent(); activeTools = [...tools]; },
			async setModel(model) { assertCurrent(); selectedModels.push(model); return true; },
			setThinkingLevel(level) { assertCurrent(); selectedThinkingLevels.push(level); },
			setSessionName() { assertCurrent(); },
		};
		const ctx = {
			cwd,
			mode: "rpc",
			model: { provider: "default", id: "default-model" },
			modelRegistry: {
				find(provider, model) {
					return planningModel && provider === planningModel.provider && model === planningModel.model
						? { provider, id: model } : undefined;
				},
				async complete(model, context, options) {
					assertCurrent();
					slugRequests.push({ model, context, options });
					assert.ok(context.messages[0].content[0].text.includes(editorValue), "slug generation uses the verbatim ask, not the plan");
					return { stopReason: "stop", content: [{ type: "text", text: "command-workflow" }] };
				},
			},
			sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
			ui: {
				editor: async (title, prefill) => { editorCalls.push({ title, prefill }); return editorValue; },
				confirm: async () => true,
				notify: (message, level) => { assertCurrent(); notifications.push({ message, level }); },
				setStatus: () => {},
				setWidget: () => {},
				theme: { fg: (_color, text) => text },
			},
			waitForIdle: async () => { assertCurrent(); },
			async switchSession(sessionFile, options = {}) {
				assertCurrent();
				const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
				const header = entries[0];
				const savedPhase = entries.find((entry) => entry.customType === "implementation-workflow-phase")?.data;
				assert.ok(savedPhase, "replacement session persists a workflow phase before switching");
				phaseEntries.push(savedPhase);
				switches.push({ sessionFile, cwd: header.cwd, phase: savedPhase });
				await emit("session_shutdown", { reason: "resume" });
				activeTools = ["read", "bash", "edit", "write"];
				install(header.cwd, entries.slice(1), header.id);
				await emit("session_start", { reason: "resume" });
				await options.withSession?.({ ...current.ctx, sendUserMessage: async (message) => current.pi.sendUserMessage(message) });
				return { cancelled: false };
			},
		};
		implementationWorkflow(pi, { reviewAgentRunner });
		current = { pi, ctx, commands, events, tools };
	}
	async function emit(name, event = {}) {
		const results = [];
		for (const handler of current.events.get(name) ?? []) results.push(await handler(event, current.ctx));
		return results.find((result) => result !== undefined);
	}
	const run = (name, args = "") => current.commands.get(name).handler(args, current.ctx);
	install(repositoryRoot);
	kickoffAssertion = (message) => {
		assert.equal(phaseEntries.at(-1)?.phase, "planning", "replacement phase must activate before kickoff");
		assert.equal(phaseEntries.at(-1)?.identifier, identifier);
		assert.ok(!Object.hasOwn(phaseEntries.at(-1), "draftId"));
		assert.equal(current.ctx.cwd, worktreePath, "planning must run in the replacement worktree session");
		assert.equal(sentMessages.length, 0, "kickoff must be the first injected message");
		assert.ok(existsSync(join(workflowRoot, "metadata.json")), "portable metadata must exist before kickoff");
		assert.ok(existsSync(join(worktreePath, ".workflows", "active.json")), "active worktree marker must exist before kickoff");
		assert.ok(message.includes(editorValue), "kickoff must contain the submitted ask verbatim");
	};
	try {
		await beforeStart?.({ git, repositoryRoot, worktreePath, agentDir, identifier });
		await emit("session_start");
		await run("workflow-plan", args);
		if (editorValue === undefined || !editorValue.trim()) {
			assert.equal(await exists(join(repositoryRoot, ".worktrees")), false, "cancelled asks create no worktree directory");
			assert.equal(await exists(join(repositoryRoot, ".workflows")), false);
			assert.equal(await exists(join(agentDir, "workflows")), false, "cancelled asks create no registry or draft");
			assert.equal(await exists(join(agentDir, "sessions")), false, "cancelled asks create no session");
			assert.equal(await readFile(join(repositoryRoot, ".git", "info", "exclude"), "utf8"), initialExclude);
			assert.equal((await git(repositoryRoot, "for-each-ref", "--format=%(refname)")).stdout.trim(), "refs/heads/main");
			assert.equal(slugRequests.length, 0);
			assert.equal(switches.length, 0);
		}
		if (afterFirstStart) {
			kickoffAssertion = undefined;
			await afterFirstStart({
				get ctx() { return current.ctx; },
				get tools() { return current.tools; },
				get activeTools() { return activeTools; },
				async resumePhase(phase) {
					install(worktreePath, [
						{ type: "custom", id: "phase-entry", customType: "implementation-workflow-phase", data: { phase, identifier } },
						{ type: "message", id: "discussion-entry", message: { role: "user", content: "Save followups in the plan. Keep the helper unchanged.", timestamp: Date.now() } },
					], "review-session");
					await emit("session_start", { reason: "resume" });
				},
				run, emit, git, switches, slugRequests, executions, baseCommit, repositoryRoot, worktreePath,
				identifier, workflowRoot, agentDir, editorCalls, notifications, phaseEntries, sentMessages,
				setEditorResult(value) { editorValue = value; },
				setPullRequests(value) { pullRequests = value; },
				setDuringGitHubLookup(action) { duringGitHubLookup = action; },
			});
		}
		return {
			agentDir, workflowRoot, editorCalls, notifications, phaseEntries, sentMessages, switches, slugRequests,
			metadata: (await exists(join(workflowRoot, "metadata.json"))) ? JSON.parse(await readFile(join(workflowRoot, "metadata.json"), "utf8")) : undefined,
			plan: (await exists(join(workflowRoot, "latest-plan", "plan.json"))) ? await readFile(join(workflowRoot, "latest-plan", "plan.json"), "utf8") : undefined,
			workingPlan: (await exists(join(workflowRoot, "working-plan", "plan.json"))) ? await readFile(join(workflowRoot, "working-plan", "plan.json"), "utf8") : undefined,
			activeTools, selectedModels, selectedThinkingLevels,
		};
	} finally {
		await emit("session_shutdown", { reason: "quit" });
		await rm(root, { recursive: true, force: true });
	}
}

const cancelled = await scenario({ args: "prefill", editorResult: undefined });
assert.deepEqual(cancelled.editorCalls.map((call) => call.prefill), ["prefill"]);
assert.equal(cancelled.metadata, undefined);
assert.equal(cancelled.phaseEntries.length, 0);
assert.equal(cancelled.sentMessages.length, 0);
assert.match(cancelled.notifications.at(-1).message, /Planning did not start/);

const empty = await scenario({ editorResult: "" });
assert.equal(empty.editorCalls[0].prefill, "");
assert.equal(empty.metadata, undefined);
assert.equal(empty.phaseEntries.length, 0);
assert.equal(empty.sentMessages.length, 0);

const blank = await scenario({ editorResult: " \n\t " });
assert.equal(blank.editorCalls[0].prefill, "");
assert.equal(blank.metadata, undefined);
assert.equal(blank.phaseEntries.length, 0);
assert.equal(blank.sentMessages.length, 0);

const fromEmptyEditor = await scenario({ editorResult: "Ask typed into the empty editor" });
assert.equal(fromEmptyEditor.editorCalls[0].prefill, "");
assert.ok(fromEmptyEditor.metadata, JSON.stringify(fromEmptyEditor.notifications));
assert.equal(fromEmptyEditor.metadata.ask, "Ask typed into the empty editor");

const modelOverride = await scenario({
	editorResult: "Plan with the configured Isara model",
	planningModel: { provider: "isara", model: "anthropic/claude-opus:planning" },
	planningThinkingLevel: "high",
});
assert.deepEqual(modelOverride.selectedModels, [
	{ provider: "isara", id: "anthropic/claude-opus:planning" },
]);
assert.deepEqual(modelOverride.selectedThinkingLevels, ["high"]);

const thinkingOnlyOverride = await scenario({
	editorResult: "Plan with the current model at maximum thinking",
	planningThinkingLevel: "max",
});
assert.deepEqual(thinkingOnlyOverride.selectedModels, []);
assert.deepEqual(thinkingOnlyOverride.selectedThinkingLevels, ["max"]);

const protectedFiles = {
	root: "/workflow",
	plan: "/workflow/latest-plan",
	workingPlan: "/workflow/working-plan",
	metadata: "/workflow/metadata.json",
	versions: "/workflow/plan-versions",
	planDraftBase: "/workflow/plan-draft-base.json",
};
assert.equal(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, join(protectedFiles.workingPlan, "goal.md")),
	undefined,
);
assert.match(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, protectedFiles.plan),
	/only change.*working-plan/,
);
assert.match(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, "/repository/src/index.ts"),
	/only change.*working-plan/,
);
assert.match(
	workflowModule.workflowWriteBlockReason("implementation", protectedFiles, protectedFiles.metadata),
	/original ask/,
);
assert.match(
	workflowModule.workflowWriteBlockReason("review", protectedFiles, protectedFiles.plan),
	/frozen and read-only/,
);
assert.equal(
	workflowModule.workflowWriteBlockReason("implementation", protectedFiles, "/worktree/src/index.ts"),
	undefined,
);

// The native write guard rejects links at any bundle ancestor, not only inside the draft.
const guardRoot = await realpath(await mkdtemp(join(tmpdir(), "workflow-write-guard-")));
try {
	const bundle = join(guardRoot, ".workflows", "guard-plan");
	const draft = join(bundle, "working-plan");
	await mkdir(draft, { recursive: true });
	const guardFiles = { ...protectedFiles, root: bundle, workingPlan: draft };
	const target = join(draft, "goal.md");
	await writeFile(target, "Goal\n");
	assert.equal(workflowModule.workflowWriteBlockReason("planning", guardFiles, target), undefined);
	for (const ancestor of [draft, bundle, join(guardRoot, ".workflows")]) {
		const saved = `${ancestor}-saved`;
		await rename(ancestor, saved);
		await symlink(saved, ancestor, "dir");
		assert.match(workflowModule.workflowWriteBlockReason("planning", guardFiles, target), /links/);
		await rm(ancestor);
		await rename(saved, ancestor);
	}
	await link(target, join(guardRoot, "external-alias.md"));
	assert.match(workflowModule.workflowWriteBlockReason("planning", guardFiles, target), /hard links/);
} finally { await rm(guardRoot, { recursive: true, force: true }); }

// Finalization remains successful when only dashboard delivery fails.
for (const dashboard of [{}, { dashboardUrl: "http://example.test/workflow" }, { dashboardError: "Server unavailable" }]) {
	let tool;
	const details = { action: "finalize", version: 4, ...dashboard };
	registerWorkflowPlanTool({ registerTool: (definition) => { tool = definition; } }, async () => details);
	const result = await tool.execute("save-draft", { action: "finalize", expectedBaseVersion: 3, description: "Save a valid plan" });
	assert.equal(result.details, details);
	assert.match(result.content[0].text, /Finalized implementation plan version 4/);
	const rendered = tool.renderResult(result, {}, {
		fg: (_color, text) => text,
	}).render(1000).join("\n");
	if (dashboard.dashboardError) {
		assert.ok(result.content[0].text.includes(`Workflow dashboard unavailable: ${dashboard.dashboardError}`));
		assert.ok(rendered.includes(`Workflow dashboard unavailable: ${dashboard.dashboardError}`));
	}
	if (dashboard.dashboardUrl) {
		assert.ok(result.content[0].text.includes(dashboard.dashboardUrl));
		assert.ok(rendered.includes(dashboard.dashboardUrl));
	}
}

const submittedAsk = 'First line\n\nSecond <line> & "quotes".\n';
const started = await scenario({ args: "inline prefill", editorResult: submittedAsk });
assert.equal(started.editorCalls[0].prefill, "inline prefill");
assert.equal(started.metadata.ask, submittedAsk);
assert.equal(started.plan, undefined, "initialization publishes no incomplete version");
assert.deepEqual(JSON.parse(started.workingPlan), { schemaVersion: 2, readingOrder: [] });
assert.ok(started.activeTools.includes("edit"));
assert.ok(started.activeTools.includes("write"));
assert.ok(!started.workingPlan.includes(submittedAsk));
assert.equal(started.phaseEntries.length, 1);
assert.equal(started.sentMessages.length, 1);

await scenario({
	editorResult: "Leave a working plan unsaved",
	afterFirstStart: async ({ workflowRoot, run, notifications }) => {
		await writeFile(join(workflowRoot, "working-plan", "goal.md"), "Unsaved.\n", "utf8");
		await run("workflow-implement");
		assert.match(notifications.at(-1).message, /working plan has unsaved changes/);
	},
});

await scenario({
	editorResult: "Finalize a structured working plan",
	afterFirstStart: async ({ workflowRoot, tools, run, notifications }) => {
		const updatePlan = tools.get("workflow_update_plan");
		assert.ok(updatePlan);
		assert.equal(updatePlan.parameters.properties.plan, undefined);
		const prepared = await updatePlan.execute("prepare", { action: "prepare" });
		assert.equal(prepared.details.baseVersion, 0);
		assert.equal(prepared.details.draftPath, join(workflowRoot, "working-plan"));
		await assert.rejects(updatePlan.execute("missing-base", { action: "finalize", description: "Save the plan" }), /expectedBaseVersion/);
		await assert.rejects(updatePlan.execute("empty-draft", { action: "finalize", description: "Save the plan", expectedBaseVersion: 0 }), /invalid|nonempty/);
		assert.deepEqual(await readdir(join(workflowRoot, "plan-versions")), []);
		const plan = planFixture();
		await writePlanFixture(prepared.details.draftPath, plan);
		const result = await updatePlan.execute("finalize", { action: "finalize", expectedBaseVersion: 0, description: "Keep workflow records local" });
		assert.equal(result.details.version, 1);
		assert.match(result.content[0].text, /Finalized implementation plan version 1/);
		assert.match(result.details.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/implementation-workflow\/workflows\/command-workflow$/);
		const savedGoal = await readFile(join(workflowRoot, "latest-plan", "goal.md"), "utf8");
		assert.equal(savedGoal, plan.goal);
		assert.equal(await readFile(join(workflowRoot, "plan-versions", "v1", "goal.md"), "utf8"), savedGoal);

		const next = await updatePlan.execute("prepare-next", { action: "prepare" });
		assert.equal(next.details.baseVersion, 1);
		const metadataPath = join(next.details.draftPath, "planned-changes", plan.readingOrder[0], "change_metadata.json");
		await writeFile(metadataPath, JSON.stringify({ title: "Store records", dependsOn: ["missing-change"], surprise: true }));
		await assert.rejects(updatePlan.execute("invalid", { action: "finalize", expectedBaseVersion: 1, description: "Keep workflow records local" }), (error) => {
			assert.match(error.message, /unknown field/);
			assert.match(error.message, /unknown change|unknown ID/);
			return true;
		});
		assert.deepEqual((await readdir(join(workflowRoot, "plan-versions"))).sort(), ["v1"]);
		assert.equal(await readFile(join(workflowRoot, "latest-plan", "goal.md"), "utf8"), savedGoal);
		await run("workflow-implement");
		assert.match(notifications.at(-1).message, /working plan has unsaved changes/);
		const resumed = await updatePlan.execute("resume-draft", { action: "prepare" });
		assert.equal(resumed.details.baseVersion, 1);
		assert.match(await readFile(metadataPath, "utf8"), /surprise/, "prepare must preserve invalid unsaved edits");
		await writePlanFixture(next.details.draftPath, plan);
		const second = await updatePlan.execute("finalize-next", { action: "finalize", expectedBaseVersion: 1, description: "Keep workflow records local" });
		assert.equal(second.details.version, 2, "identical valid content can still create a snapshot");
		await assert.rejects(updatePlan.execute("stale-base", { action: "finalize", expectedBaseVersion: 1, description: "Stale edit" }), /stale|base version|baseVersion/i);
	},
});

await scenario({
	editorResult: "Start once",
	afterFirstStart: async ({ run, editorCalls, phaseEntries, sentMessages, notifications }) => {
		await run("workflow-plan", "do not prefill");
		assert.equal(editorCalls.length, 1, "an active planning session must not reopen the editor");
		assert.equal(phaseEntries.length, 1, "an active planning session must not append another phase");
		assert.equal(sentMessages.length, 1, "an active planning session must not inject a continuation message");
		assert.match(notifications.at(-1).message, /Continue planning through normal conversation/);
	},
});

const approvedPlan = planFixture();

await scenario({
	editorResult: "Keep workflow records local",
	afterFirstStart: async ({ workflowRoot, tools, run, git, worktreePath, repositoryRoot, identifier, baseCommit, switches }) => {
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Keep workflow records local" });
		await writeFile(join(worktreePath, "README.md"), "An unrelated staged code change\n");
		assert.equal((await git(worktreePath, "add", "README.md")).code, 0);
		const indexBefore = (await git(worktreePath, "ls-files", "--stage", "-z")).stdout;
		await run("workflow-implement");
		assert.equal(switches.length, 2, "approval starts implementation in a separate session");
		const saved = JSON.parse(await readFile(join(workflowRoot, "metadata.json"), "utf8"));
		assert.equal(saved.approvedPlanVersion, 1);
		assert.equal(saved.ask, "Keep workflow records local");
		for (const key of ["repositoryRoot", "gitCommonDir", "worktreePath", "pullRequests"]) assert.ok(!(key in saved));
		assert.equal(await readFile(join(workflowRoot, "plan-versions", "v1", "goal.md"), "utf8"), approvedPlan.goal);
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout.trim(), baseCommit, "approval creates no Git commit");
		assert.equal((await git(worktreePath, "ls-files", "--stage", "-z")).stdout, indexBefore, "approval leaves the index unchanged");
		assert.equal((await git(worktreePath, "ls-files", ".workflows")).stdout, "");
		assert.equal((await git(worktreePath, "status", "--porcelain")).stdout.trim(), "M  README.md");
		await run("workflow-cleanup");
		assert.equal(await exists(worktreePath), false);
		assert.equal((await git(repositoryRoot, "rev-parse", `workflow/${identifier}`)).stdout.trim(), baseCommit, "cleanup creates no Git commit");
		assert.equal((await git(repositoryRoot, "ls-tree", "-r", `workflow/${identifier}`, "--", ".workflows")).stdout, "");
		assert.equal((await git(repositoryRoot, "show", `workflow/${identifier}:README.md`)).stdout, "Workflow fixture\n", "cleanup did not commit unrelated edits");
	},
});

await scenario({
	editorResult: "Approve without Git signing credentials",
	afterFirstStart: async (test) => {
		const { workflowRoot, tools, run, git, worktreePath, baseCommit, switches } = test;
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Approve a local plan" });
		await git(worktreePath, "config", "commit.gpgsign", "true");
		await git(worktreePath, "config", "gpg.program", "/missing-workflow-test-signing-program");
		await run("workflow-implement");
		assert.equal(switches.length, 2, "approval does not require a working Git signer");
		assert.equal(JSON.parse(await readFile(join(workflowRoot, "metadata.json"), "utf8")).approvedPlanVersion, 1);
		assert.equal(await readFile(join(workflowRoot, "latest-plan", "goal.md"), "utf8"), approvedPlan.goal);
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout.trim(), baseCommit);
		assert.equal((await git(worktreePath, "status", "--porcelain")).stdout.trim(), "");
		const indexBefore = (await git(worktreePath, "ls-files", "--stage", "-z")).stdout;
		for (const phase of ["implementation", "revision"]) {
			if (phase === "revision") await test.resumePhase("revision");
			const question = { id: phase, label: "Storage", question: "Where should records stay?", options: [{ label: "Local" }, { label: "Elsewhere" }], allowOther: true };
			const answer = { id: phase, answer: "Local", index: 1, custom: false };
			const result = await test.tools.get("workflow_questions").execute("clarify", { questions: [question] }, undefined, undefined, {
				mode: "tui", ui: { custom: async () => ({ questions: [question], answers: [answer], cancelled: false }) },
			});
			assert.equal(result.details.cancelled, false);
			assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout.trim(), baseCommit, `${phase} clarifications create no commit`);
			assert.equal((await git(worktreePath, "ls-files", "--stage", "-z")).stdout, indexBefore);
			assert.equal((await git(worktreePath, "status", "--porcelain")).stdout.trim(), "");
		}
		const clarifications = JSON.parse(await readFile(join(workflowRoot, "clarifications.json"), "utf8"));
		assert.deepEqual(clarifications.entries.map(({ answer }) => answer), ["Local", "Local"]);
		await run("workflow-cleanup");
		assert.equal(await exists(worktreePath), false, "cleanup also works without signing credentials");
	},
});

await scenario({
	editorResult: "Preserve a draft edit made during approval",
	duringApproval: async ({ workflowRoot }) => {
		await writeFile(join(workflowRoot, "working-plan", "goal.md"), "A newer draft edit from another session.\n");
	},
	afterFirstStart: async ({ workflowRoot, tools, run, notifications, switches }) => {
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Preserve concurrent draft edits" });
		await run("workflow-implement");
		assert.equal(switches.length, 1, "an unsaved concurrent draft blocks implementation handoff");
		assert.match(notifications.at(-1).message, /working plan has unsaved changes/);
		assert.equal(await readFile(join(workflowRoot, "working-plan", "goal.md"), "utf8"), "A newer draft edit from another session.\n");
		assert.equal(await readFile(join(workflowRoot, "plan-versions", "v1", "goal.md"), "utf8"), approvedPlan.goal);
		assert.ok(notifications.some(({ message }) => /draft changed during approval and was preserved/.test(message)));
	},
});

await scenario({
	editorResult: "Save review followups without relaying the conversation",
	afterFirstStart: async (harness) => {
		const { workflowRoot, worktreePath, identifier, run, emit, git } = harness;
		const files = storage.workflowFiles(identifier, worktreePath);
		const callPlan = (params) => harness.tools.get("workflow_update_plan").execute("plan-edit", params, undefined, undefined, harness.ctx);
		await writePlanFixture(files.workingPlan, approvedPlan);
		await callPlan({ action: "finalize", expectedBaseVersion: 0, description: "Save review followups" });
		await run("workflow-implement");
		assert.ok(harness.activeTools.includes("workflow_update_plan"), "first implementation can save original flags");
		let prepared = await callPlan({ action: "prepare" });
		assert.match(prepared.content[0].text, /Only implemented booleans/);
		const originalId = approvedPlan.readingOrder[0];
		const originalMetadataPath = join(files.workingPlan, "planned-changes", originalId, "change_metadata.json");
		const originalMetadata = JSON.parse(await readFile(originalMetadataPath, "utf8"));
		await writeFile(originalMetadataPath, JSON.stringify({ ...originalMetadata, title: "Not authorized" }));
		const switchesBeforeDraft = harness.switches.length;
		for (const command of ["workflow-implement", "workflow-review"]) {
			await run(command);
			assert.equal(harness.switches.length, switchesBeforeDraft);
			assert.match(harness.notifications.at(-1).message, /working plan has unsaved changes/);
		}
		await assert.rejects(callPlan({ action: "finalize", expectedBaseVersion: 1, description: "Save review followups" }), /original requirements|only implemented/);
		await writeFile(originalMetadataPath, JSON.stringify({ ...originalMetadata, implemented: true }));
		const headBeforeFlag = (await git(worktreePath, "rev-parse", "HEAD")).stdout;
		await callPlan({ action: "finalize", expectedBaseVersion: 1, description: "Save review followups" });
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout, headBeforeFlag, "flag publication is not a Git commit");
		let scope = await readWorkflowScope(files, await storage.readCompletedWorkflowMetadata(identifier));
		assert.equal(scope.changes[0].implemented, true);
		const failing = { status: "no", explanation: "The implementation misses a failure case." };
		const report = {
			version: 3, pullRequestUrls: ["https://example.test/pull/1"], baseCommit: "base", headCommit: "head", generatedAt: new Date().toISOString(),
			overallResult: { summary: "A correction is needed.", necessary: failing, sufficient: failing }, overallConcerns: [],
			plannedChanges: scope.changes.map(({ id, title, dependsOn, content }) => ({ id, title, dependsOn, content, review: { id, title, walkthrough: "Inspect the missing case.", necessary: failing, sufficient: failing, concerns: [] } })),
			testingCriteria: { originalCriteria: scope.currentPlan.document.testing, review: { summary: "Coverage is missing.", satisfied: failing, criteria: [{ criterion: "Failure regression", status: "no", explanation: "Missing coverage", evidence: [{ location: "README.md:1", description: "Fixture source" }] }], concerns: [] } },
		};
		await storage.appendWorkflowReview(files, report);
		assert.equal((await readWorkflowScope(files, await storage.readCompletedWorkflowMetadata(identifier))).changes[0].implemented, true, "a failed independent report leaves flags unchanged");
		await harness.resumePhase("review");
		assert.ok(harness.activeTools.includes("edit") && harness.activeTools.includes("workflow_update_plan"));
		assert.ok(!harness.activeTools.includes("bash"));
		prepared = await callPlan({ action: "prepare" });
		assert.deepEqual(prepared.details.followupOrigin, { reviewNumber: 1, sessionId: "review-session", entryId: "discussion-entry" });
		for (const path of [originalMetadataPath, join(files.workingPlan, "goal.md"), files.review, files.metadata, join(worktreePath, "README.md")]) {
			assert.equal((await emit("tool_call", { toolName: "write", input: { path } })).block, true, `review cannot write ${path}`);
		}
		assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "touch README.md" } })).block, true);
		assert.equal((await emit("tool_call", { toolName: "background_start", input: { kind: "agent", task: "edit code" } })).block, true);
		const followup = { id: "shared-layout", title: "Share the deployment layout", dependsOn: [originalId], implemented: false,
			content: "Use a shared layout for the implementation.", testing: "Verify both callers use the shared layout.",
			followup: { origin: prepared.details.followupOrigin, effect: { type: "amendment", requirements: [{ source: { type: "change", id: originalId }, quotedRequirement: scope.changes[0].content }] } },
		};
		const followupPath = join(files.workingPlan, "planned-changes", followup.id, "change_metadata.json");
		assert.equal(await emit("tool_call", { toolName: "write", input: { path: followupPath } }), undefined);
		await writePlanFixture(files.workingPlan, { ...scope.currentPlan.document, readingOrder: [originalId, followup.id], changes: [...scope.changes, followup] });
		await callPlan({ action: "finalize", expectedBaseVersion: 2, description: "Save review followups" });
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout, headBeforeFlag, "followup publication creates no Git commit");
		await harness.resumePhase("review");
		scope = await readWorkflowScope(files, await storage.readCompletedWorkflowMetadata(identifier));
		assert.deepEqual(scope.changes.map(({ id, implemented }) => [id, implemented]), [[originalId, true], [followup.id, false]]);
		assert.ok(!scope.changes.some(({ id }) => id === "rewrite-helper"), "rejected suggestions stay out; no decision store is needed");
		assert.equal(await exists(join(workflowRoot, "implementation.json")), false);
		assert.equal(harness.tools.has("workflow_followups"), false);
		prepared = await callPlan({ action: "prepare" });
		await writeFile(followupPath, JSON.stringify({ title: followup.title, dependsOn: followup.dependsOn, implemented: true, followup: followup.followup }));
		await assert.rejects(callPlan({ action: "finalize", expectedBaseVersion: 3, description: "Save review followups" }), /review cannot change implemented/i);
		await writeFile(followupPath, JSON.stringify({ title: followup.title, dependsOn: followup.dependsOn, implemented: false, followup: followup.followup }));
		await callPlan({ action: "finalize", expectedBaseVersion: 3, description: "Save review followups" });
		await harness.resumePhase("implementation");
		prepared = await callPlan({ action: "prepare" });
		await writeFile(followupPath, JSON.stringify({ title: followup.title, dependsOn: followup.dependsOn, implemented: true, followup: followup.followup }));
		await callPlan({ action: "finalize", expectedBaseVersion: 4, description: "Save review followups" });
		await harness.resumePhase("review");
		await callPlan({ action: "prepare" });
		await writeFile(join(files.workingPlan, "planned-changes", followup.id, "change.md"), "Refine the shared layout requirement.");
		await assert.rejects(callPlan({ action: "finalize", expectedBaseVersion: 5, description: "Save review followups" }), /reset implemented to false/);
		await writeFile(followupPath, JSON.stringify({ title: followup.title, dependsOn: followup.dependsOn, implemented: false, followup: followup.followup }));
		await callPlan({ action: "finalize", expectedBaseVersion: 5, description: "Save review followups" });
		assert.equal((await readWorkflowScope(files, await storage.readCompletedWorkflowMetadata(identifier))).changes[1].implemented, false);

		// A real review -> implement handoff carries saved followups, not the old conversation.
		assert.equal((await git(worktreePath, "switch", "-c", "workflow/stack-tip")).code, 0);
		await writeFile(join(worktreePath, "README.md"), "Manual staged integration edits\n");
		await git(worktreePath, "add", "README.md");
		await writeFile(join(worktreePath, "manual.txt"), "Manual untracked work\n");
		const stagedBeforeHandoff = (await git(worktreePath, "diff", "--cached", "--", "README.md")).stdout;
		const switchesBeforeHandoff = harness.switches.length;
		const headBeforeHandoff = (await git(worktreePath, "rev-parse", "HEAD")).stdout;
		await git(worktreePath, "config", "commit.gpgsign", "true");
		await git(worktreePath, "config", "gpg.program", "/missing-followup-signing-program");
		const editorCount = harness.editorCalls.length;
		await run("workflow-implement");
		assert.equal(harness.switches.length, switchesBeforeHandoff + 1, "local handoff does not require Git signing");
		assert.equal((await storage.readPlanVersion(files)).number, 6, "handoff retains saved local history");
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout, headBeforeHandoff, "handoff creates no artifact commit");
		assert.equal((await git(worktreePath, "ls-files", ".workflows")).stdout, "");
		assert.equal(harness.ctx.cwd, worktreePath);
		assert.equal(harness.editorCalls.length, editorCount, "continuation opens no request editor");
		assert.equal((await git(worktreePath, "branch", "--show-current")).stdout.trim(), "workflow/stack-tip");
		assert.equal((await git(worktreePath, "diff", "--cached", "--", "README.md")).stdout, stagedBeforeHandoff);
		assert.equal(await readFile(join(worktreePath, "manual.txt"), "utf8"), "Manual untracked work\n");
		let kickoff = harness.sentMessages.at(-1);
		for (const text of [join(files.versions, "v1"), join(files.versions, "v6"), files.clarifications, join(files.reviews, "0001.json"), `Not marked implemented: ${followup.id}`, `Marked implemented: ${originalId}`, "Does not cover all current inputs"]) assert.ok(kickoff.includes(text), `missing kickoff context: ${text}`);
		await callPlan({ action: "prepare" });
		await writeFile(followupPath, JSON.stringify({ title: followup.title, dependsOn: followup.dependsOn, implemented: true, followup: followup.followup }));
		await callPlan({ action: "finalize", expectedBaseVersion: 6, description: "Save review followups" });
		await run("workflow-implement");
		kickoff = harness.sentMessages.at(-1);
		assert.match(kickoff, /Not marked implemented: None/);
		const allMarkedHead = (await git(worktreePath, "rev-parse", "HEAD")).stdout;
		await run("workflow-implement");
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout, allMarkedHead, "unchanged all-marked handoff makes no artificial commit");
		assert.equal((await storage.readPlanVersion(files)).number, 7);
		await harness.resumePhase("revision");
		assert.ok(harness.activeTools.includes("workflow_update_plan"), "legacy revision sessions resume with implementation tools");
		const resumedPrompt = await emit("before_agent_start", { systemPrompt: "Base" });
		assert.match(resumedPrompt.systemPrompt, /Not marked implemented: None/);
		assert.doesNotMatch(resumedPrompt.systemPrompt, /workflow-revise/);
		await writeFile(files.review, "unreadable latest review");
		await run("workflow-implement");
		assert.ok(harness.notifications.some(({ message }) => /Latest review is unreadable/.test(message)));
		assert.match((await emit("before_agent_start", { systemPrompt: "Base" })).systemPrompt, /Current finalized plan:/, "an optional unreadable report must not remove implementation context");
		const savedMetadata = await readFile(files.metadata, "utf8");
		for (const missing of [false, true]) {
			if (missing) await rm(files.metadata); else await writeFile(files.metadata, "corrupt metadata");
			await harness.resumePhase("review");
			assert.ok(!harness.activeTools.some((name) => ["edit", "write", "bash", "workflow_update_plan"].includes(name)), "failed review restoration exposes only read tools");
			for (const toolName of ["edit", "write", "bash", "background_start", "workflow_update_plan"]) {
				assert.equal((await emit("tool_call", { toolName, input: { path: join(worktreePath, "README.md") } })).block, true, `${toolName} fails closed when workflow restoration fails`);
			}
			await writeFile(files.metadata, savedMetadata);
			await harness.resumePhase("review");
		}
	},
});

// Real persistence and Git, with only Pi/model/GitHub responses controlled.
let duringReview;
let failSynthesis = false;
const reviewRequests = [];
const yes = { status: "yes", explanation: "Covered by the controlled result." };
async function controlledReviewRunner(request) {
	reviewRequests.push(request);
	const mutate = duringReview;
	duringReview = undefined;
	await mutate?.();
	if (request.role === "planned-change") {
		const identity = /Planned change identity: ([a-z0-9-]+): (.+)/.exec(request.prompt);
		assert.ok(identity);
		return { id: identity[1], title: identity[2], walkthrough: "Inspect the delivery in README.md.", necessary: yes, sufficient: { status: "no", explanation: "A correction is still needed, regardless of the flag." }, concerns: [] };
	}
	if (request.role === "testing-criteria") return { summary: "All groups are represented.", satisfied: yes, concerns: [], criteria: [...request.prompt.matchAll(/Testing source ID: ([^\n]+)/g)].map((match) => ({ sourceId: match[1], criterion: "Exercise this group's observable behavior.", status: "yes", explanation: "Controlled evidence for orchestration.", evidence: [{ location: "README.md:1", description: "The real temporary repository's delivery source." }] })) };
	if (request.role === "holistic-review") return { summary: "Review all scoped requirements.", necessary: yes, sufficient: yes, concerns: [] };
	if (request.role === "incremental-scope") return { summary: "All source is affected.", relevantPlannedChanges: [{ id: "store-workflow-records", explanation: "The source changed." }] };
	if (failSynthesis) throw new Error("Synthesis fixture failed after focused outputs were saved");
	return { overallResult: { summary: "Review complete, corrections remain.", necessary: yes, sufficient: yes }, overallConcerns: [] };
}
await scenario({
	editorResult: "Review the complete saved scope without mixed inputs", reviewAgentRunner: controlledReviewRunner,
	afterFirstStart: async (harness) => {
		const { worktreePath, identifier, run, git } = harness;
		const files = storage.workflowFiles(identifier, worktreePath);
		const callPlan = (params) => harness.tools.get("workflow_update_plan").execute("update", params, undefined, undefined, harness.ctx);
		await writePlanFixture(files.workingPlan, approvedPlan);
		await callPlan({ action: "finalize", expectedBaseVersion: 0, description: "Review complete saved scope" });
		await run("workflow-implement");
		await writeFile(join(worktreePath, "README.md"), "Initial implementation\n");
		await git(worktreePath, "commit", "-am", "Implement the initial request");
		async function publishRemoteHead() {
			harness.setPullRequests([{ number: 1, url: "https://example.test/pull/1", baseRefName: "main", headRefName: `workflow/${identifier}`, headRefOid: (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim() }]);
		}
		await publishRemoteHead();
		duringReview = async () => {
			await writeFile(join(worktreePath, "README.md"), "Changed during review\n");
			await git(worktreePath, "commit", "-am", "Concurrent implementation change");
		};
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /changed during review/);
		assert.equal(await storage.readWorkflowReview(files), undefined, "a code change during agents must not publish mixed-input evidence");
		await publishRemoteHead();
		await run("workflow-review");
		let report = await storage.readWorkflowReview(files);
		assert.equal(report.version, 4);
		assert.equal((await storage.listSavedReviews(files)).length, 1);
		await run("workflow-implement");
		await callPlan({ action: "prepare" });
		const metadataPath = join(files.workingPlan, "planned-changes", approvedPlan.readingOrder[0], "change_metadata.json");
		const original = JSON.parse(await readFile(metadataPath, "utf8"));
		await writeFile(metadataPath, JSON.stringify({ ...original, implemented: true }));
		await callPlan({ action: "finalize", expectedBaseVersion: 1, description: "Review complete saved scope" });
		reviewRequests.length = 0;
		await run("workflow-review");
		assert.equal(reviewRequests.length, 0, "a flag-only snapshot reuses the current report at the same content HEAD");
		assert.equal((await storage.listSavedReviews(files)).length, 1);
		const metadata = await storage.readCompletedWorkflowMetadata(identifier);
		async function addFollowup(id) {
			await storage.preparePlanDraft(files);
			const current = await storage.readPlanVersion(files);
			const origin = { reviewNumber: (await storage.listSavedReviews(files)).length, sessionId: "review-session", entryId: "followup-entry" };
			const change = { id, title: `Correct ${id}`, dependsOn: [approvedPlan.readingOrder[0]], implemented: false, content: `Correct the ${id} behavior.`, testing: `Execute the ${id} regression test.`, followup: { origin, effect: { type: "addition" } } };
			await writePlanFixture(files.workingPlan, { ...current.document, readingOrder: [...current.document.readingOrder, id], changes: [...current.document.changes, change] });
			await storage.finalizePlanDraft(files, "Review complete saved scope", current.number, { phase: "review", reviewOrigin: { reviewNumber: origin.reviewNumber, sessionId: origin.sessionId, entryIds: [origin.entryId] } });
		}
		await addFollowup("failure-case");
		reviewRequests.length = 0;
		duringReview = () => addFollowup("concurrent-requirement");
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /changed during review/);
		assert.equal((await storage.listSavedReviews(files)).length, 1, "changed requirements leave old reports immutable and publish no mixed scope");
		reviewRequests.length = 0;
		duringReview = async () => {
			await git(worktreePath, "config", "commit.gpgsign", "true");
			await git(worktreePath, "config", "gpg.program", "/missing-review-signing-program");
		};
		const headBeforeLocalReview = (await git(worktreePath, "rev-parse", "HEAD")).stdout;
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /review is ready/);
		assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout, headBeforeLocalReview, "review saves locally without Git signing or commits");
		assert.equal((await git(worktreePath, "ls-files", ".workflows")).stdout, "");
		report = await storage.readWorkflowReview(files);
		assert.equal(report.plannedChanges.length, 3);
		assert.equal(reviewRequests.filter(({ role }) => role === "planned-change").length, 3, "same-HEAD expanded scope requires a full review including marked originals");
		assert.ok(!reviewRequests.some(({ role }) => role === "incremental-scope"));
		assert.equal(report.plannedChanges[0].review.sufficient.status, "no");
		assert.equal((await readWorkflowScope(files, metadata)).changes[0].implemented, true, "a current-format failed review does not reset a marked original");
		await git(worktreePath, "config", "commit.gpgsign", "false");
		reviewRequests.length = 0;
		await run("workflow-review");
		assert.equal(reviewRequests.length, 0, "the locally saved review is reused without duplicate agents");
		assert.equal((await storage.listSavedReviews(files)).length, 2);

		// Reuse must recheck scope and draft state after slow delivery/network checks.
		harness.setDuringGitHubLookup(() => addFollowup("late-network-followup"));
		reviewRequests.length = 0;
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /changed during review/);
		assert.equal(reviewRequests.length, 0);
		assert.equal((await storage.listSavedReviews(files)).length, 2, "network-time scope publication cannot return the old report as current");
		await run("workflow-review");
		assert.equal((await storage.listSavedReviews(files)).length, 3);
		harness.setDuringGitHubLookup(async () => {
			await storage.preparePlanDraft(files);
			await writeFile(join(files.workingPlan, "planned-changes", "late-network-followup", "change.md"), "Unfinished network-time edit.");
		});
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /working plan has unsaved changes/);
		assert.equal((await storage.listSavedReviews(files)).length, 3);
		await rm(files.workingPlan, { recursive: true });

		// Failed synthesis may leave focused results. Dirty-input outputs cannot survive a retry.
		await addFollowup("failed-agent-case");
		const committedReadme = await readFile(join(worktreePath, "README.md"), "utf8");
		duringReview = async () => { await writeFile(join(worktreePath, "README.md"), "Transient dirty code inspected by an agent\n"); };
		failSynthesis = true;
		await run("workflow-review");
		assert.match(harness.notifications.at(-1).message, /Cached evidence was discarded/);
		assert.equal((await storage.listSavedReviews(files)).length, 3);
		await writeFile(join(worktreePath, "README.md"), committedReadme);
		failSynthesis = false;
		reviewRequests.length = 0;
		await run("workflow-review");
		assert.equal(reviewRequests.filter(({ role }) => role === "planned-change").length, 5, "retry at the same HEAD reruns every focused result after unsafe failed inputs");
		assert.equal((await storage.listSavedReviews(files)).length, 4);
	},
});

console.log("Command-flow test passed: Git-backed handoff, local followup drafts and flags, complete-scope review, source-race rejection, and safe retries.");
