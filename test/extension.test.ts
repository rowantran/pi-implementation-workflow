import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
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
	const messages: Array<{ content: string; options: unknown }> = [];
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
		getSessionName: () => sessionName,
		sendUserMessage: (content: string, options: unknown) => { messages.push({ content, options }); },
		appendEntry: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	const ctx = (cwd: string, entries: unknown[] = [], sessionId = randomUUID()) => ({
		cwd,
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: { find: () => undefined },
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => sessionId, getSessionFile: () => join(cwd, `${sessionId}.jsonl`) },
		ui: { notify: (text: string) => notifications.push(text) },
	});
	const emit = async (event: string, payload: unknown, context: unknown) => {
		let result;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, context)) ?? result;
		return result;
	};
	return { pi, tools, commands, notifications, messages, emit, ctx, activeTools: () => activeTools, sessionName: () => sessionName };
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

test("dashboard batches reach the latest session, stay pinned through shutdown, and return replies", async (t) => {
	const { annotationCallbacks } = await import("../src/feedback.ts");
	const { readReplies } = await import("../src/lib/annotations/server.ts");
	const { delivered, recipients } = await import("../src/lib/notifications.ts");
	const { default: extension } = await import("../src/index.ts");
	const agentDir = await temporaryDirectory("pi-workflow-comments-agent-");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const repo = await initRepository();
	const { location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "comments", ask: "Comment on a review followup" });
	await writeFiles(location.plan, VALID_PLAN);
	const sessionId = randomUUID();
	const entries: any[] = [{ type: "custom", customType: "implementation-workflow", data: { phase: "review", id: location.id, repositoryRoot: repo, worktree: location.worktree } }];
	let harness = fakePi(nodeExec);
	extension(harness.pi as any);
	let context = harness.ctx(location.worktree, entries, sessionId);
	t.after(async () => {
		await harness.emit("session_shutdown", { reason: "quit" }, context);
		await rm(repo, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	await harness.emit("session_start", {}, context);
	assert.ok(harness.activeTools().includes("workflow_comment_reply"));
	const registrations = await recipients(join(location.root, "notifications"));
	assert.equal(registrations[0]?.id, sessionId);
	assert.equal(registrations[0]?.active, true);
	const makeComment = (documentId: string) => ({
		id: randomUUID(), documentId, documentTitle: "Followup", revision: "abc", start: 0, end: 7, quote: "Testing", text: "Why is this necessary?",
	});
	const batch = { id: randomUUID(), comments: [makeComment("plan/change/followup"), makeComment("review/change/define-policy")] };
	const callbacks = annotationCallbacks(location.root);
	assert.equal((await callbacks.onSubmit(batch)).recipientId, sessionId);
	await eventually(() => harness.messages.length === 1);
	assert.deepEqual(harness.messages[0]!.options, { deliverAs: "followUp" });
	assert.match(harness.messages[0]!.content, /plan\/change\/followup/);
	assert.match(harness.messages[0]!.content, /review\/change\/define-policy/);
	assert.match(harness.messages[0]!.content, /workflow_comment_reply/);
	assert.equal(await delivered(join(location.root, "notifications"), batch.id), false, "queued is not yet persisted delivery");

	await harness.emit("session_shutdown", { reason: "resume" }, context);
	assert.equal((await recipients(join(location.root, "notifications")))[0]?.active, false);
	// Another active session cannot consume the already addressed batch.
	harness = fakePi(nodeExec);
	extension(harness.pi as any);
	context = harness.ctx(location.worktree, entries, randomUUID());
	await harness.emit("session_start", {}, context);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(harness.messages.length, 0);
	await assert.rejects(harness.tools.get("workflow_comment_reply").execute("reply", { batchId: batch.id, commentId: batch.comments[0]!.id, reply: "Wrong session" }, undefined, undefined, context), /addressed to the current session/);
	await harness.emit("session_shutdown", { reason: "resume" }, context);

	// Resume the original session: the lost in-memory queue is reconstructed from disk.
	harness = fakePi(nodeExec);
	extension(harness.pi as any);
	context = harness.ctx(location.worktree, entries, sessionId);
	await harness.emit("session_start", {}, context);
	await eventually(() => harness.messages.length === 1);
	entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: harness.messages[0]!.content }] } });
	await writeFile(context.sessionManager.getSessionFile(), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	await eventually(() => delivered(join(location.root, "notifications"), batch.id));
	assert.equal(harness.messages.length, 1, "polling must not repeatedly queue the same batch");
	await callbacks.onSubmit(batch); // A browser retry is idempotent.
	assert.equal((await callbacks.load()).batches.length, 1);
	const reply = harness.tools.get("workflow_comment_reply");
	await reply.execute("reply", { batchId: batch.id, commentId: batch.comments[0]!.id, reply: "It covers a missing validation case." }, undefined, undefined, context);
	const answers = await readReplies(join(location.root, "annotations"), batch.id);
	assert.equal(answers.length, 1);
	assert.equal(answers[0]?.text, "It covers a missing validation case.");
	assert.match(answers[0]?.author ?? "", /^Review:/);
	assert.equal(answers[0]?.role, "agent");
	assert.match(answers[0]?.id ?? "", /^agent-[a-f0-9]{64}$/);
	await reply.execute("reply", { batchId: batch.id, commentId: batch.comments[0]!.id, reply: "It covers a missing validation case." }, undefined, undefined, context);
	assert.deepEqual(await readReplies(join(location.root, "annotations"), batch.id), answers, "tool-call retries preserve the original answer and timestamp");
	await assert.rejects(reply.execute("reply", { batchId: batch.id, commentId: batch.comments[0]!.id, reply: "Conflicting retry." }, undefined, undefined, context), /Could not save/);
	await reply.execute("reply-2:/unsafe-id", { batchId: batch.id, commentId: batch.comments[0]!.id, reply: "Additional detail." }, undefined, undefined, context);
	assert.equal((await readReplies(join(location.root, "annotations"), batch.id)).length, 2, "a new call appends instead of replacing");
	assert.equal((await harness.emit("tool_call", { toolName: "write", input: { path: join(location.root, "notifications", "tamper.json") } }, context))?.block, true);
});

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const until = Date.now() + 5000;
	while (!(await predicate())) {
		assert.ok(Date.now() < until, "timed out waiting for notification delivery");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
