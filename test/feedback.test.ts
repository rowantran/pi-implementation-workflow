import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { annotationCallbacks, monitorFeedback, replyToFeedback } from "../src/feedback.ts";
import { readReplies } from "../src/lib/annotations/server.ts";
import { delivered, list, monitor, recipients } from "../src/lib/notifications.ts";
import { temporaryDirectory, writeFiles } from "./helpers.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempts = 0; attempts < 150; attempts++) {
		if (await predicate()) return;
		await delay(25);
	}
	assert.fail("Notification did not reach the expected state");
}
function batch() {
	return { id: randomUUID(), comments: [{
		id: randomUUID(), documentId: "plan/goal", documentTitle: "Goal", revision: "v1", start: 0, end: 4, quote: "Goal", text: "Why?",
	}] };
}
function appendAssistant(manager: SessionManager) {
	manager.appendMessage({
		role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-responses", provider: "test", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	});
}

test("new comments follow the latest activation, not heartbeats or an older active session", async (t) => {
	const root = await temporaryDirectory();
	const topic = join(root, "notifications");
	const callbacks = annotationCallbacks(root);
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const olderMessages: string[] = [];
	const older = await monitor(topic, { id: "older", label: "Older" }, async (message) => {
		olderMessages.push(message.id);
		return true;
	}, { intervalMs: 10 });
	t.after(async () => { await older.close(); await rm(root, { recursive: true, force: true }); });
	assert.equal((await callbacks.load()).recipient?.id, "older");
	t.mock.timers.setTime(Date.now() + 1_000);
	const newer = await monitor(topic, { id: "newer", label: "Newer", resume: "newer.jsonl" }, async () => false);
	await newer.close();
	t.mock.timers.setTime(Date.now() + 1_000);
	await eventually(async () => (await recipients(topic)).find((record) => record.id === "older")!.updatedAt === Date.now());
	const selected = (await callbacks.load()).recipient!;
	assert.equal(selected.id, "newer");
	assert.equal(selected.active, false);
	assert.equal(selected.resume, "newer.jsonl");
	const submission = batch();
	const saved = await callbacks.onSubmit(submission);
	assert.equal(saved.recipientId, "newer");
	assert.equal(saved.delivered, false);
	assert.equal((await list(topic))[0].recipientId, "newer");
	await delay(40);
	assert.deepEqual(olderMessages, [], "an older active session cannot take the offline recipient's work");
	assert.equal((await callbacks.load()).recipient?.id, "newer");

	// Resuming a previously older session is a new activation.
	await older.close();
	t.mock.timers.setTime(Date.now() + 1_000);
	const resumed = await monitor(topic, { id: "older", label: "Resumed" }, async () => false);
	await resumed.close();
	assert.equal((await callbacks.load()).recipient?.id, "older");
	assert.equal((await callbacks.onSubmit(batch())).recipientId, "older");
	assert.deepEqual(await callbacks.onSubmit(submission), saved, "already submitted work stays pinned");
});

test("activation ties use ascending IDs and legacy heartbeats do not gain ownership", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const registrations = {
		"a-legacy": { updatedAt: Date.now() },
		"b-winner": { registeredAt: 100, updatedAt: 200 },
		"c-tied": { registeredAt: 100, updatedAt: Date.now() },
	};
	for (const [id, timestamps] of Object.entries(registrations)) {
		await writeFiles(root, { [`notifications/recipients/${id}/0.json`]: JSON.stringify({
			id, label: id, active: true, pid: process.pid, ...timestamps,
		}) });
	}
	const callbacks = annotationCallbacks(root);
	assert.equal((await callbacks.load()).recipient?.id, "b-winner");
	assert.equal((await callbacks.onSubmit(batch())).recipientId, "b-winner");
	await rm(join(root, "notifications", "recipients", "b-winner"), { recursive: true });
	await rm(join(root, "notifications", "recipients", "c-tied"), { recursive: true });
	assert.equal((await callbacks.load()).recipient?.id, "a-legacy", "legacy sessions remain addressable");
	assert.equal((await callbacks.load()).recipient?.registeredAt, 0);
});

test("retries retain the first durable address and payload after activation changes or metadata removal", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const topic = join(root, "notifications");
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const first = await monitor(topic, { id: "first", label: "First" }, async () => false);
	await first.close();
	const callbacks = annotationCallbacks(root);
	const submission = batch();
	const saved = await callbacks.onSubmit(submission);
	const path = join(topic, "messages", `${submission.id}.json`);
	const original = await readFile(path, "utf8");
	t.mock.timers.setTime(Date.now() + 1_000);
	const second = await monitor(topic, { id: "second", label: "Second" }, async () => false);
	await second.close();
	assert.equal((await callbacks.load()).recipient?.id, "second");
	assert.deepEqual(await callbacks.onSubmit(submission), saved);
	const conflicting = { ...submission, comments: [{ ...submission.comments[0], text: "Different" }] };
	await assert.rejects(callbacks.onSubmit(conflicting), /conflict/);
	assert.equal(await readFile(path, "utf8"), original);
	assert.equal((await callbacks.onSubmit(batch())).recipientId, "second");
	await rm(join(topic, "recipients"), { recursive: true });
	assert.equal((await callbacks.load()).recipient, null);
	assert.deepEqual(await callbacks.onSubmit(submission), saved);
	await assert.rejects(callbacks.onSubmit(conflicting), /conflict/);
	assert.equal(await readFile(path, "utf8"), original);
	await assert.rejects(callbacks.onSubmit(batch()), /No registered session/);
	assert.equal((await list(topic)).length, 2);
});

test("no recipient leaves new comments unpublished; concurrent retries keep one batch", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const callbacks = annotationCallbacks(root);
	const submission = batch();
	assert.deepEqual(await callbacks.load(), { recipient: null, batches: [] });
	await assert.rejects(callbacks.onSubmit(submission), /No registered session/);
	await assert.rejects(access(join(root, "notifications")), { code: "ENOENT" });
	const consumer = await monitor(join(root, "notifications"), { id: "new", label: "New" }, async () => false);
	await consumer.close();
	const saved = await Promise.all(Array.from({ length: 16 }, () => annotationCallbacks(root).onSubmit(submission)));
	for (const copy of saved) assert.deepEqual(copy, saved[0]);
	assert.equal(saved[0].recipientId, "new", "routing uses current registration, not the earlier load");
	assert.equal((await callbacks.load()).batches.length, 1);
});

test("a fork's memory-only user message is not a delivery receipt", async (t) => {
	const root = await temporaryDirectory();
	const manager = SessionManager.create(root, join(root, "sessions"));
	const leaf = manager.appendCustomEntry("test-binding", {});
	const sessionFile = manager.createBranchedSession(leaf)!;
	assert.ok(sessionFile);
	await assert.rejects(access(sessionFile));
	let sends = 0;
	const pi = { sendUserMessage(content: string) { sends++; manager.appendMessage({ role: "user", content, timestamp: Date.now() }); } } as ExtensionAPI;
	const ctx = { sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
	const stop = await monitorFeedback(pi, ctx, root, "Fork");
	t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
	const submission = batch();
	await annotationCallbacks(root).onSubmit(submission);
	await eventually(() => sends === 1);
	await delay(1100);
	assert.equal(await delivered(join(root, "notifications"), submission.id), false);
	await assert.rejects(access(sessionFile));
	assert.equal(sends, 1, "the memory-only message must suppress repeated sends");
	appendAssistant(manager); // Pi now flushes the actual JSONL session.
	await eventually(() => delivered(join(root, "notifications"), submission.id));
	assert.equal(sends, 1);
});

test("a rejected send retries after cooldown only when Pi and its queue are idle", async (t) => {
	const root = await temporaryDirectory();
	const manager = SessionManager.create(root, join(root, "sessions"));
	let sends = 0, busy = false, pending = false;
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const pi = { sendUserMessage(content: string) {
		sends++;
		if (sends === 1) return; // Like a fire-and-forget Pi preflight rejection.
		manager.appendMessage({ role: "user", content, timestamp: Date.now() });
		appendAssistant(manager);
	} } as ExtensionAPI;
	const ctx = { sessionManager: manager, isIdle: () => !busy, hasPendingMessages: () => pending, ui: { notify() {} } } as unknown as ExtensionContext;
	const stop = await monitorFeedback(pi, ctx, root, "Retry");
	t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
	const submission = batch();
	await annotationCallbacks(root).onSubmit(submission);
	await eventually(() => sends === 1);
	await delay(1100);
	assert.equal(sends, 1, "no immediate repeated sends");
	busy = true;
	t.mock.timers.setTime(Date.now() + 31_000);
	await delay(1100);
	assert.equal(sends, 1, "do not retry while Pi is busy");
	busy = false; pending = true;
	await delay(1100);
	assert.equal(sends, 1, "do not retry while a follow-up may still be queued");
	pending = false;
	await eventually(() => sends === 2);
	await eventually(() => delivered(join(root, "notifications"), submission.id));
	assert.equal(sends, 2);
});

test("follow-ups route to the current session, pin retries, and authorize only their root thread", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const topic = join(root, "notifications");
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const first = await monitor(topic, { id: "first", label: "First" }, async () => false);
	await first.close();
	const callbacks = annotationCallbacks(root);
	const submission = batch();
	submission.comments.push({ ...submission.comments[0], id: randomUUID(), text: "A separate thread" });
	await callbacks.onSubmit(submission);
	const rootPath = join(topic, "messages", `${submission.id}.json`);
	const original = await readFile(rootPath, "utf8");
	t.mock.timers.setTime(Date.now() + 1000);
	const second = await monitor(topic, { id: "second", label: "Second" }, async () => false);
	await second.close();
	const followup = { id: "user-followup", batchId: submission.id, commentId: submission.comments[0].id, text: "Can you explain more?" };
	const saved = await Promise.all(Array.from({ length: 16 }, () => callbacks.onReply(followup)));
	for (const copy of saved) assert.deepEqual(copy, saved[0]);
	assert.equal(saved[0].id, submission.id);
	assert.equal(saved[0].recipientId, "first", "the root keeps its original recipient");
	assert.equal(saved[0].replies.length, 1);
	assert.deepEqual(saved[0].replies[0], { id: followup.id, commentId: followup.commentId, text: followup.text,
		role: "user", author: "You", createdAt: new Date().toISOString(), delivered: false });
	const messages = await list<any>(topic);
	const notification = messages.find((message) => message.id === followup.id)!;
	assert.equal(notification.recipientId, "second");
	assert.deepEqual(notification.payload, { thread: { batchId: submission.id, commentId: followup.commentId }, text: followup.text });
	assert.equal(await readFile(rootPath, "utf8"), original);
	await assert.rejects(callbacks.onReply({ ...followup, text: "Different" }));
	await assert.rejects(callbacks.onReply({ ...followup, commentId: submission.comments[1].id }));
	await assert.rejects(callbacks.onReply({ ...followup, id: "invalid-parent", batchId: followup.id }));
	assert.equal((await list(topic)).length, 2);

	await assert.rejects(replyToFeedback(root, "stranger", submission.id, followup.commentId, "Not allowed", "Stranger"), /addressed to the current session/);
	await assert.rejects(replyToFeedback(root, "second", submission.id, submission.comments[1].id, "Not allowed", "Second"), /addressed to the current session/);
	await assert.rejects(replyToFeedback(root, "second", followup.id, followup.commentId, "Wrong batch ID", "Second"), /root batch/);
	await replyToFeedback(root, "second", submission.id, followup.commentId, "Here is more detail.", "Second", "call:/unsafe|tool-id");
	const firstAnswer = await readReplies(join(root, "annotations"), submission.id);
	assert.equal(firstAnswer.length, 1);
	assert.equal(firstAnswer[0].role, "agent");
	assert.match(firstAnswer[0].id!, /^agent-[a-f0-9]{64}$/);
	t.mock.timers.setTime(Date.now() + 1000);
	await Promise.all(Array.from({ length: 12 }, () => replyToFeedback(root, "second", submission.id, followup.commentId,
		"Here is more detail.", "Second", "call:/unsafe|tool-id")));
	assert.deepEqual(await readReplies(join(root, "annotations"), submission.id), firstAnswer);
	await assert.rejects(replyToFeedback(root, "second", submission.id, followup.commentId, "Conflicting answer", "Second", "call:/unsafe|tool-id"), /Could not save/);
	await replyToFeedback(root, "first", submission.id, followup.commentId, "Original session can still answer.", "First", "next-call");
	assert.equal((await readReplies(join(root, "annotations"), submission.id)).length, 2);

	const third = await monitor(topic, { id: "third", label: "Third" }, async () => false);
	await third.close();
	assert.deepEqual(await callbacks.onReply(followup), saved[0]);
	await assert.rejects(replyToFeedback(root, "third", submission.id, followup.commentId, "Not addressed", "Third"), /addressed to the current session/);
	await rm(join(topic, "recipients"), { recursive: true });
	assert.deepEqual(await callbacks.onReply(followup), saved[0]);
	assert.equal((await list(topic)).find((message) => message.id === followup.id)!.recipientId, "second");
	await assert.rejects(callbacks.onReply({ ...followup, id: "new-followup" }), /No registered session/);
	assert.equal(await readFile(rootPath, "utf8"), original);
});

test("live follow-up delivery includes root quotation and chronological history, and waits for saved acknowledgment", async (t) => {
	const root = await temporaryDirectory();
	const topic = join(root, "notifications");
	const old = await monitor(topic, { id: "old", label: "Old" }, async () => false);
	await old.close();
	const callbacks = annotationCallbacks(root);
	const submission = batch();
	submission.comments[0].quote = "The original selected quotation";
	await callbacks.onSubmit(submission);
	await writeFiles(root, { [`annotations/replies/${submission.id}/${submission.comments[0].id}.json`]: JSON.stringify({
		commentId: submission.comments[0].id, text: "Legacy first answer", author: "Old", createdAt: "2020-01-01T00:00:00.000Z",
	}) });
	await replyToFeedback(root, "old", submission.id, submission.comments[0].id, "A later answer", "Old", "answer-call");
	await delay(5);
	const manager = SessionManager.create(root, join(root, "sessions"));
	const sends: string[] = [];
	const pi = { sendUserMessage(content: string, options: unknown) {
		assert.deepEqual(options, { deliverAs: "followUp" });
		sends.push(content);
		manager.appendMessage({ role: "user", content, timestamp: Date.now() });
	} } as ExtensionAPI;
	const ctx = { sessionManager: manager, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
	let stop = await monitorFeedback(pi, ctx, root, "New");
	t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
	const followup = { id: "followup", batchId: submission.id, commentId: submission.comments[0].id, text: "Latest follow-up question" };
	await callbacks.onReply(followup);
	await eventually(() => sends.length === 1);
	const prompt = sends[0];
	assert.match(prompt, /The original selected quotation/);
	assert.match(prompt, /"text": "Why\?"/);
	assert.ok(prompt.indexOf("Legacy first answer") < prompt.indexOf("A later answer"));
	assert.ok(prompt.indexOf("A later answer") < prompt.indexOf("Latest follow-up question"));
	assert.ok(prompt.includes(`ROOT batch ID \`${submission.id}\``));
	assert.ok(prompt.includes(`ROOT comment ID \`${followup.commentId}\``));
	assert.match(prompt, /workflow_comment_reply/);
	assert.match(prompt, /current workflow role and permissions/);
	assert.equal(await delivered(topic, followup.id), false);
	assert.equal((await callbacks.load()).batches[0].replies[0].delivered, false);
	await delay(1100);
	assert.equal(sends.length, 1, "memory-only history suppresses repeated delivery but is not acknowledgment");
	appendAssistant(manager);
	await eventually(() => delivered(topic, followup.id));
	assert.equal((await callbacks.load()).batches[0].replies[0].delivered, true);
	assert.equal(await delivered(topic, submission.id), false, "the new session cannot consume the root's old notification");
	await stop();
	stop = await monitorFeedback(pi, ctx, root, "Resumed");
	await delay(1100);
	assert.equal(sends.length, 1, "resumption preserves acknowledgment");
});

test("concurrent conflicting user replies keep one immutable payload", async (t) => {
	const root = await temporaryDirectory();
	t.after(() => rm(root, { recursive: true, force: true }));
	const consumer = await monitor(join(root, "notifications"), { id: "current", label: "Current" }, async () => false);
	await consumer.close();
	const callbacks = annotationCallbacks(root);
	const submission = batch();
	await callbacks.onSubmit(submission);
	const input = { id: "reply", batchId: submission.id, commentId: submission.comments[0].id, text: "First" };
	const outcomes = await Promise.allSettled([callbacks.onReply(input), callbacks.onReply({ ...input, text: "Second" })]);
	assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
	const replies = (await callbacks.load()).batches[0].replies;
	assert.equal(replies.length, 1);
	assert.ok(["First", "Second"].includes(replies[0].text));
});
