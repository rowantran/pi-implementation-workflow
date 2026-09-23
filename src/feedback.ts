import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Annotation, Batch, Reply, ReplySubmission, Submission } from "./lib/annotations/server.ts";
import { enrichBatch, historyOrder, HttpError, writeReply } from "./lib/annotations/server.ts";
import { delivered, list, monitor, publish, recipients, type Notification, type RegisteredRecipient } from "./lib/notifications.ts";
import { renderPrompt, text } from "./prompts.ts";

/** The only adapter between the two mini-libraries and Pi. Topics are scoped to
 * a workflow directory, so equal workflow names in different repositories do not mix. */
const topic = (root: string) => join(root, "notifications");
export const annotationDirectory = (root: string) => join(root, "annotations");
type CommentPayload = { comments: Annotation[] };
type ReplyPayload = { thread: { batchId: string; commentId: string }; text: string };
type Payload = CommentPayload | ReplyPayload;

// Registration represents opening/resuming a session. Activity and heartbeats
// never transfer new comments away from that session, even when it is offline.
function newestRecipient(registered: RegisteredRecipient[]): RegisteredRecipient | null {
	return registered.sort((a, b) => b.registeredAt - a.registeredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}

async function loadBatches(root: string): Promise<Batch[]> {
	const messages = await list<Payload>(topic(root));
	const batches = new Map<string, Batch>();
	for (const message of messages) {
		if (!("comments" in message.payload)) continue;
		batches.set(message.id, { id: message.id, recipientId: message.recipientId, createdAt: message.createdAt,
			comments: message.payload.comments, delivered: await delivered(topic(root), message.id), replies: [] });
	}
	for (const message of messages) {
		if (!("thread" in message.payload)) continue;
		const { thread, text } = message.payload;
		const batch = batches.get(thread.batchId);
		if (!batch?.comments.some((comment) => comment.id === thread.commentId)) continue;
		batch.replies.push({ id: message.id, commentId: thread.commentId, text, createdAt: message.createdAt,
			role: "user", author: "You", delivered: await delivered(topic(root), message.id) });
	}
	return [...batches.values()];
}

async function publishToCurrent<T extends Payload>(root: string, id: string, payload: T): Promise<Notification<T>> {
	const findExisting = async () => (await list<Payload>(topic(root))).find((message) => message.id === id);
	// Address new comments and follow-ups at first publication, never from their root batch.
	const existing = await findExisting();
	const recipientId = existing?.recipientId ?? newestRecipient(await recipients(topic(root)))?.id;
	if (!recipientId) throw new Error("No registered session for dashboard comments.");
	const input = { id, recipientId, payload };
	return publish(topic(root), input).catch(async (error: unknown) => {
		// A concurrent publication may win with another address. Compare against it.
		if (existing) throw error;
		const winner = await findExisting();
		if (!winner || winner.recipientId === recipientId) throw error;
		return publish(topic(root), { ...input, recipientId: winner.recipientId });
	});
}

/** These callbacks contain no session closure: any Pi process can serve a workflow. */
export function annotationCallbacks(root: string) {
	return {
		directory: annotationDirectory(root),
		async load() {
			const [registered, batches] = await Promise.all([recipients(topic(root)), loadBatches(root)]);
			return { recipient: newestRecipient(registered), batches };
		},
		async onSubmit(submission: Submission): Promise<Batch> {
			await publishToCurrent(root, submission.id, { comments: submission.comments });
			return (await loadBatches(root)).find((batch) => batch.id === submission.id)!;
		},
		async onReply(submission: ReplySubmission): Promise<Batch> {
			const parent = (await loadBatches(root)).find((batch) => batch.id === submission.batchId);
			if (!parent?.comments.some((comment) => comment.id === submission.commentId)) throw new HttpError(400);
			const payload: ReplyPayload = { thread: { batchId: parent.id, commentId: submission.commentId }, text: submission.text };
			try { await publishToCurrent(root, submission.id, payload); }
			catch (error) {
				const existing = (await list<Payload>(topic(root))).find((message) => message.id === submission.id);
				if (existing && !isDeepStrictEqual(existing.payload, payload)) throw new HttpError(400);
				throw error;
			}
			return (await loadBatches(root)).find((batch) => batch.id === parent.id)!;
		},
	};
}

async function notificationPrompt(root: string, notification: Notification<Payload>, marker: string): Promise<string> {
	if ("comments" in notification.payload) {
		return renderPrompt("annotations", { marker, batchId: notification.id, comments: JSON.stringify(notification.payload.comments, null, 2) });
	}
	const { thread } = notification.payload;
	const parent = (await loadBatches(root)).find((batch) => batch.id === thread.batchId);
	const comment = parent?.comments.find((comment) => comment.id === thread.commentId);
	if (!parent || !comment) throw new Error("Missing dashboard thread.");
	const batch = await enrichBatch(annotationDirectory(root), parent);
	const latest = batch.replies.find((reply) => reply.id === notification.id && reply.role === "user")!;
	const history: Reply[] = batch.replies.filter((reply) => reply.commentId === thread.commentId && historyOrder(reply, latest) < 0)
		.map((reply) => ({ ...reply, role: reply.role ?? "agent" }));
	return renderPrompt("annotation-reply", { marker, batchId: thread.batchId, commentId: thread.commentId,
		comment: JSON.stringify({ ...comment, createdAt: parent.createdAt }, null, 2),
		history: JSON.stringify(history, null, 2), latestReply: JSON.stringify(latest, null, 2) });
}

function received(entries: readonly SessionEntry[], marker: string): boolean {
	return entries.some((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return false;
		const content = entry.message.content;
		const value = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		return value.startsWith(`${marker}\n`);
	});
}

async function persisted(path: string, marker: string): Promise<boolean> {
	let contents: string;
	try { contents = await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	// Ignore an unfinished last line and malformed unrelated entries. Pi can defer
	// flushing a new/forked session until its first assistant message.
	return contents.split("\n").slice(0, -1).some((line) => {
		try { return received([JSON.parse(line)], marker); } catch { return false; }
	});
}

/** Polling/disk bookkeeping belongs to notifications; Pi delivery belongs here.
 * A queued follow-up is not acknowledged until it appears on disk. Pi's send
 * API is fire-and-forget, so rejected/cleared messages are retried after 30s,
 * only when Pi is idle with no pending queue. Transport remains at-least-once. */
export async function monitorFeedback(pi: ExtensionAPI, ctx: ExtensionContext, root: string, label: string): Promise<() => Promise<void>> {
	const id = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Dashboard comments require a persistent Pi session.");
	const inflight = new Map<string, number>();
	let stopped = false;
	let reportedError = false;
	const subscription = await monitor<Payload>(topic(root), {
		id, label: `${label} (${id.slice(0, 8)})`, resume: sessionFile,
	}, async (notification) => {
		if (stopped) return false;
		const marker = text("messages.annotation_marker", { id: notification.id });
		if (received(ctx.sessionManager.getEntries(), marker)) {
			const saved = await persisted(sessionFile, marker);
			if (saved) inflight.delete(notification.id);
			return saved;
		}
		const sentAt = inflight.get(notification.id);
		if (sentAt !== undefined && (Date.now() - sentAt < 30_000 || !ctx.isIdle() || ctx.hasPendingMessages())) return false;
		if (stopped) return false;
		const prompt = await notificationPrompt(root, notification, marker);
		if (stopped) return false;
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		inflight.set(notification.id, Date.now());
		return false;
	}, {
		onError: () => {
			if (!stopped && !reportedError) ctx.ui.notify("Could not check dashboard comments. Pending comments remain on disk; resume this session to retry.", "warning");
			reportedError = true;
		},
	});
	return async () => { stopped = true; await subscription.close(); };
}

export async function replyToFeedback(root: string, sessionId: string, batchId: string, commentId: string, reply: string, author: string, toolCallId?: string): Promise<void> {
	let messages: Notification<Payload>[];
	try { messages = await list<Payload>(topic(root)); }
	catch { throw new Error(text("tools.workflow_comment_reply.failed")); }
	const batch = messages.find((message) => message.id === batchId);
	const addressed = batch?.recipientId === sessionId || messages.some((message) => message.recipientId === sessionId
		&& "thread" in message.payload && message.payload.thread.batchId === batchId && message.payload.thread.commentId === commentId);
	if (!batch || !("comments" in batch.payload) || !addressed || !batch.payload.comments.some((comment) => comment.id === commentId)) {
		throw new Error(text("tools.workflow_comment_reply.unknown"));
	}
	try {
		const id = toolCallId === undefined ? randomUUID() : `agent-${createHash("sha256").update(JSON.stringify([sessionId, toolCallId])).digest("hex")}`;
		await writeReply(annotationDirectory(root), batchId, { id, role: "agent", commentId, text: reply, author, createdAt: new Date().toISOString() });
	} catch {
		throw new Error(text("tools.workflow_comment_reply.failed"));
	}
}
