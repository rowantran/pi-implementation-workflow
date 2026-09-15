import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { nodeExec } from "../src/git.ts";
import { createWorkflow } from "../src/workflow.ts";
import { initRepository, temporaryDirectory, VALID_PLAN, writeFiles } from "./helpers.ts";

/** A minimal stand-in for pi's ExtensionAPI that records registrations and lets the test drive events. */
function fakePi(exec: typeof nodeExec) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notifications: string[] = [];
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	let sessionName = "";
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: () => {},
		on: (event: string, handler: any) => { (handlers.get(event) ?? handlers.set(event, []).get(event))!.push(handler); },
		exec,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
		setSessionName: (name: string) => { sessionName = name; },
		appendEntry: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	const ctx = (cwd: string, entries: unknown[] = []) => ({
		cwd,
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: { getBranch: () => entries },
		ui: { notify: (text: string) => notifications.push(text) },
	});
	const emit = async (event: string, payload: unknown, context: unknown) => {
		let result;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, context)) ?? result;
		return result;
	};
	return { pi, tools, commands, notifications, emit, ctx, activeTools: () => activeTools, sessionName: () => sessionName };
}

test("planning session: binding, tool gating, plan save, and system prompt", async () => {
	const agentDir = await temporaryDirectory("pi-workflow-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const repo = await initRepository();
	const { location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "wire", ask: "Wire it up" });
	const { default: extension } = await import("../src/index.ts");
	const harness = fakePi(nodeExec);
	extension(harness.pi as any);
	assert.deepEqual([...harness.commands.keys()].sort(), ["workflow-cleanup", "workflow-dashboard", "workflow-implement", "workflow-plan", "workflow-review"]);

	const binding = { type: "custom", customType: "implementation-workflow", data: { phase: "planning", id: "wire", repositoryRoot: repo, worktree: location.worktree } };
	const context = harness.ctx(location.worktree, [binding]);
	await harness.emit("session_start", {}, context);
	assert.ok(harness.activeTools().includes("workflow_plan_save"));
	assert.ok(harness.activeTools().includes("workflow_questions"));
	assert.ok(!harness.activeTools().includes("workflow_review_save"));
	assert.equal(harness.sessionName(), "Planning: wire");
	assert.ok(harness.notifications.some((text) => text.includes("/w/wire")), `dashboard link announced: ${harness.notifications}`);

	const gate = (path: string) => harness.emit("tool_call", { toolName: "edit", input: { path } }, context);
	assert.equal((await gate(join(location.plan, "goal.md"))), undefined);
	assert.match((await gate(join(location.worktree, "README.md")))!.reason, /may only edit files under/);
	assert.match((await gate(location.clarifications))!.reason, /read-only/);

	const save = harness.tools.get("workflow_plan_save");
	await assert.rejects(save.execute("1", {}, undefined, undefined, context), /not valid yet/);
	await writeFiles(location.plan, VALID_PLAN);
	const saved = await save.execute("1", {}, undefined, undefined, context);
	assert.match(saved.content[0].text, /Saved plan "Queue redrive with retry policy" with 2 changes/);
	assert.equal(harness.sessionName(), "Planning: wire · Queue redrive with retry policy");

	const prompt = await harness.emit("before_agent_start", { systemPrompt: "BASE" }, context);
	assert.match(prompt.systemPrompt, /^BASE\n\nYou are the planner/);
	assert.match(prompt.systemPrompt, new RegExp(`Workflow \`wire\` lives in \`${location.root}\``));
	assert.ok(!prompt.systemPrompt.includes("review/`: the latest"), "no review section before a review exists");

	const review = harness.tools.get("workflow_review_save");
	await assert.rejects(review.execute("2", {}, undefined, undefined, context), /only be saved from a review session/);

	await harness.emit("session_shutdown", { reason: "quit" }, context);
	await rm(repo, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
});
