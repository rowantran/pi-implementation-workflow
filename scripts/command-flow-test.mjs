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

async function scenario({ args = "", editorResult, planningModel, planningThinkingLevel, expectedIdentifier = "command-workflow", beforeStart, beforeApprovalCommit, afterFirstStart } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-workflow-command-")));
	const agentDir = join(root, "agent");
	const repositoryRoot = join(root, "repository");
	const identifier = expectedIdentifier;
	const worktreePath = join(repositoryRoot, ".worktrees", identifier);
	const workflowRoot = join(worktreePath, ".workflows", identifier);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(repositoryRoot, { recursive: true });
	const git = async (cwd, ...args) => {
		if (args.includes("commit") && args.some((arg) => arg.startsWith("Approve workflow plan:"))) {
			await beforeApprovalCommit?.({ workflowRoot });
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
	assert.equal((await git(repositoryRoot, "add", "README.md")).code, 0);
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
				if (command === "gh") return { code: 0, stdout: "[]", stderr: "" };
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
		implementationWorkflow(pi);
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
				run, emit, git, switches, slugRequests, executions, baseCommit, repositoryRoot, worktreePath,
				identifier, workflowRoot, agentDir, editorCalls, notifications, phaseEntries, sentMessages,
				setEditorResult(value) { editorValue = value; },
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
assert.deepEqual(JSON.parse(started.workingPlan), { schemaVersion: 1, readingOrder: [] });
assert.ok(started.activeTools.includes("edit"));
assert.ok(started.activeTools.includes("write"));
assert.ok(!started.workingPlan.includes(submittedAsk));
assert.equal(started.phaseEntries.length, 1);
assert.equal(started.sentMessages.length, 1);

await scenario({
	editorResult: "Leave a working plan uncommitted",
	afterFirstStart: async ({ workflowRoot, run, notifications }) => {
		await writeFile(join(workflowRoot, "working-plan", "goal.md"), "Uncommitted.\n", "utf8");
		await run("workflow-implement");
		assert.match(notifications.at(-1).message, /working plan has uncommitted changes/);
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
		const result = await updatePlan.execute("finalize", { action: "finalize", expectedBaseVersion: 0, description: "Preserve workflow records in Git" });
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
		await assert.rejects(updatePlan.execute("invalid", { action: "finalize", expectedBaseVersion: 1, description: "Preserve workflow records in Git" }), (error) => {
			assert.match(error.message, /unknown field/);
			assert.match(error.message, /unknown change|unknown ID/);
			return true;
		});
		assert.deepEqual((await readdir(join(workflowRoot, "plan-versions"))).sort(), ["v1"]);
		assert.equal(await readFile(join(workflowRoot, "latest-plan", "goal.md"), "utf8"), savedGoal);
		await run("workflow-implement");
		assert.match(notifications.at(-1).message, /working plan has uncommitted changes/);
		const resumed = await updatePlan.execute("resume-draft", { action: "prepare" });
		assert.equal(resumed.details.baseVersion, 1);
		assert.match(await readFile(metadataPath, "utf8"), /surprise/, "prepare must preserve invalid unsaved edits");
		await writePlanFixture(next.details.draftPath, plan);
		const second = await updatePlan.execute("finalize-next", { action: "finalize", expectedBaseVersion: 1, description: "Preserve workflow records in Git" });
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
	editorResult: "Preserve all workflow records in the pull request",
	afterFirstStart: async ({ workflowRoot, tools, run, git, worktreePath, repositoryRoot, identifier, baseCommit, switches }) => {
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Preserve workflow records in Git" });
		await writeFile(join(worktreePath, "README.md"), "An unrelated staged code change\n");
		assert.equal((await git(worktreePath, "add", "README.md")).code, 0);
		await run("workflow-implement");
		assert.equal(switches.length, 2, "approval starts implementation in a separate session");
		const metadataPath = `.workflows/${identifier}/metadata.json`;
		const saved = JSON.parse((await git(worktreePath, "show", `HEAD:${metadataPath}`)).stdout);
		assert.equal(saved.approvedPlanVersion, 1);
		assert.equal(saved.ask, "Preserve all workflow records in the pull request");
		for (const key of ["repositoryRoot", "gitCommonDir", "worktreePath", "pullRequests"]) assert.ok(!(key in saved));
		const paths = (await git(worktreePath, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).stdout.trim().split("\n");
		assert.ok(paths.every((path) => path.startsWith(`.workflows/${identifier}/`)), "the first workflow commit contains only the bundle");
		assert.ok(!paths.some((path) => /active\.json|working-plan|dashboard|review-runs/.test(path)));
		assert.equal((await git(worktreePath, "rev-parse", "HEAD^")).stdout.trim(), baseCommit);
		assert.equal((await git(worktreePath, "diff", "--cached", "--name-only")).stdout.trim(), "README.md", "unrelated staging survives approval");
		assert.equal((await git(worktreePath, "status", "--porcelain")).stdout.trim(), "M  README.md");
		await run("workflow-cleanup");
		assert.equal(await exists(worktreePath), false);
		assert.equal((await git(repositoryRoot, "show", `workflow/${identifier}:.workflows/${identifier}/plan-versions/v1/goal.md`)).stdout, approvedPlan.goal);
		assert.equal(JSON.parse((await git(repositoryRoot, "show", `workflow/${identifier}:${metadataPath}`)).stdout).ask, saved.ask);
		assert.equal((await git(repositoryRoot, "show", `workflow/${identifier}:README.md`)).stdout, "Workflow fixture\n", "cleanup did not commit unrelated edits");
	},
});

await scenario({
	editorResult: "Recover an initial artifact commit failure",
	afterFirstStart: async ({ workflowRoot, tools, run, git, worktreePath, switches, notifications }) => {
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Recover artifact commit failures" });
		await git(worktreePath, "config", "commit.gpgsign", "true");
		await git(worktreePath, "config", "gpg.program", "/missing-workflow-test-signing-program");
		await run("workflow-implement");
		assert.equal(switches.length, 1, "failed approval stays in planning");
		assert.match(notifications.at(-1).message, /Could not commit the approved plan/);
		assert.equal(JSON.parse(await readFile(join(workflowRoot, "metadata.json"), "utf8")).approvedPlanVersion, undefined);
		assert.equal(await readFile(join(workflowRoot, "latest-plan", "goal.md"), "utf8"), approvedPlan.goal);
		await git(worktreePath, "config", "commit.gpgsign", "false");
		await run("workflow-implement");
		assert.equal(switches.length, 2, "approval can be retried without another slug or worktree");
	},
});

await scenario({
	editorResult: "Preserve a draft edit made during approval",
	beforeApprovalCommit: async ({ workflowRoot }) => {
		await writeFile(join(workflowRoot, "working-plan", "goal.md"), "A newer draft edit from another session.\n");
	},
	afterFirstStart: async ({ workflowRoot, tools, run, notifications, switches }) => {
		await writePlanFixture(join(workflowRoot, "working-plan"), approvedPlan);
		await tools.get("workflow_update_plan").execute("save-plan", { action: "finalize", expectedBaseVersion: 0, description: "Preserve concurrent draft edits" });
		await run("workflow-implement");
		assert.equal(switches.length, 2);
		assert.equal(await readFile(join(workflowRoot, "working-plan", "goal.md"), "utf8"), "A newer draft edit from another session.\n");
		assert.equal(await readFile(join(workflowRoot, "plan-versions", "v1", "goal.md"), "utf8"), approvedPlan.goal);
		assert.ok(notifications.some(({ message }) => /draft changed during approval and was preserved/.test(message)));
	},
});

console.log("Command-flow test passed: early worktrees, immutable asks, strict approval, recoverable commits, and Git-backed cleanup.");
