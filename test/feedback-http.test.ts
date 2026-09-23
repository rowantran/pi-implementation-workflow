import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { annotationCallbacks, replyToFeedback } from "../src/feedback.ts";
import { closeDashboardServer, ensureDashboardServer, registerDashboard } from "../src/dashboard-server.ts";
import { list, monitor } from "../src/lib/notifications.ts";
import { isResolved } from "../src/lib/annotations/server.ts";
import { temporaryDirectory, writeFiles } from "./helpers.ts";

test("dashboard HTTP callbacks route automatically, pin retries, and return saved replies", async (t) => {
	const directory = await temporaryDirectory();
	const root = join(directory, "workflow");
	const index = join(directory, "index.json");
	const sessionId = randomUUID();
	const observed: string[] = [];
	const subscription = await monitor(join(root, "notifications"), { id: sessionId, label: "Reviewer" }, async (message) => {
		observed.push(message.id);
		return true;
	}, { intervalMs: 10 });
	const other = await monitor(join(directory, "other-workflow", "notifications"), { id: sessionId, label: "Other workflow" }, async () => {
		assert.fail("A notification must not cross workflow topics");
	});
	t.after(async () => {
		await closeDashboardServer();
		await subscription.close();
		await other.close();
		await rm(directory, { recursive: true, force: true });
	});
	await writeFiles(root, { "dashboard.html": "<html>Preview</html>" });
	await registerDashboard("comments", root, index);
	const port = 44100 + Math.floor(Math.random() * 200);
	const origin = `http://127.0.0.1:${port}`;
	let failAfterPublish = false;
	let failAfterReply = false;
	await ensureDashboardServer({ listenHost: "127.0.0.1", listenPort: port, publicBaseUrl: origin }, index, (root) => {
		const callbacks = annotationCallbacks(root);
		return { ...callbacks, onSubmit: async (submission) => {
			const batch = await callbacks.onSubmit(submission);
			if (failAfterPublish) { failAfterPublish = false; throw new Error("Response failed after saving"); }
			return batch;
		}, onReply: async (submission) => {
			const batch = await callbacks.onReply(submission);
			if (failAfterReply) { failAfterReply = false; throw new Error("Reply response failed after saving"); }
			return batch;
		} };
	});
	const endpoint = `${origin}/w/comments/annotations`;
	const initial = await (await fetch(endpoint)).json() as any;
	assert.equal(initial.recipient.id, sessionId);
	assert.equal(Object.hasOwn(initial, "recipients"), false);
	assert.deepEqual(initial.batches, []);
	const submission = {
		id: randomUUID(),
		comments: ["plan/change/followup", "review/overall"].map((documentId) => ({
			id: randomUUID(), documentId, documentTitle: "Discussion", revision: "text-v1:7:abc",
			start: 0, end: 7, quote: "Testing", text: "Why is this needed?",
		})),
	};
	const options = { method: "POST", headers: { "Content-Type": "application/json", "X-Annotation-Token": initial.token, Origin: origin }, body: JSON.stringify(submission) };
	const posted = await fetch(endpoint, options);
	assert.equal(posted.status, 201);
	const original = await posted.json() as any;
	assert.equal(original.recipientId, sessionId);
	assert.equal((await fetch(endpoint, options)).status, 201, "Retrying the same submission is safe");
	let snapshot: any;
	for (let attempts = 0; attempts < 100; attempts++) {
		snapshot = await (await fetch(endpoint)).json();
		if (snapshot.batches[0]?.delivered) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(snapshot.batches[0].delivered, true);
	assert.deepEqual(observed, [submission.id]);
	await replyToFeedback(root, sessionId, submission.id, submission.comments[0]!.id, "It closes a validation gap.", "Reviewer");
	const answered = await (await fetch(endpoint)).json() as any;
	assert.equal(answered.batches[0].replies[0].text, "It closes a validation gap.");
	assert.equal((await fetch(endpoint, { ...options, headers: { ...options.headers, Origin: "https://evil.example" } })).status, 403);
	assert.equal((await fetch(endpoint, { ...options, body: JSON.stringify({ ...submission, id: randomUUID(), recipientId: "unknown" }) })).status, 400);
	assert.equal((await fetch(`${origin}/w/missing/annotations`)).status, 404);

	// A newer offline session owns new work despite the older active consumer.
	const newest = await monitor(join(root, "notifications"), { id: "newest", label: "Latest", resume: "latest.jsonl" }, async () => false);
	await newest.close();
	const selected = await (await fetch(endpoint)).json() as any;
	assert.equal(selected.recipient.id, "newest");
	assert.equal(selected.recipient.active, false);
	const followup = { id: randomUUID(), action: "reply", batchId: submission.id, commentId: submission.comments[0].id, text: "What about retries?" };
	const postAction = (action: unknown) => fetch(endpoint, { ...options, body: JSON.stringify(action) });
	failAfterReply = true;
	assert.equal((await postAction(followup)).status, 503);
	const followupPath = join(root, "notifications", "messages", `${followup.id}.json`);
	const savedFollowup = await readFile(followupPath, "utf8");
	assert.equal(JSON.parse(savedFollowup).recipientId, "newest");
	const confirmed = await (await fetch(endpoint)).json() as any;
	assert.equal(confirmed.batches.length, 1, "follow-up notifications are not root batches");
	assert.equal(confirmed.batches[0].recipientId, sessionId);
	assert.equal(confirmed.batches[0].replies.length, 2, "callback user and library agent history both survive");
	assert.equal(confirmed.batches[0].replies.find((reply: any) => reply.id === followup.id).delivered, false);
	const resolution = { id: randomUUID(), action: "resolve", batchId: submission.id, commentId: followup.commentId, resolved: true };
	const resolved = await (await postAction(resolution)).json() as any;
	assert.equal(isResolved(resolved.resolutions, followup.commentId), true);
	assert.equal((await postAction({ ...followup, id: randomUUID() })).status, 409);
	assert.equal((await postAction(followup)).status, 201, "uncertain saved reply can be retried after resolve");
	await replyToFeedback(root, "newest", submission.id, followup.commentId, "Retries retain one saved reply.", "Latest", "late-answer");
	const late = await (await fetch(endpoint)).json() as any;
	assert.equal(late.batches[0].replies.length, 3);
	assert.equal(isResolved(late.batches[0].resolutions, followup.commentId), true, "late answers do not reopen threads");
	await assert.rejects(replyToFeedback(root, "newest", submission.id, submission.comments[1].id, "Wrong thread", "Latest"));
	const reopened = await (await postAction({ ...resolution, id: randomUUID(), resolved: false })).json() as any;
	assert.equal(isResolved(reopened.resolutions, followup.commentId), false);
	const retryResolve = await (await postAction(resolution)).json() as any;
	assert.deepEqual(retryResolve.resolutions, reopened.resolutions, "retrying an older resolution preserves the later reopen");
	assert.equal((await list(join(root, "notifications"))).length, 2, "resolution operations send no notifications");
	const queuedSubmission = { ...submission, id: randomUUID() };
	const queuedOptions = { ...options, body: JSON.stringify(queuedSubmission) };
	failAfterPublish = true;
	assert.equal((await fetch(endpoint, queuedOptions)).status, 503);
	const messagePath = join(root, "notifications", "messages", `${queuedSubmission.id}.json`);
	const beforeRetry = await readFile(messagePath, "utf8");
	assert.equal(JSON.parse(beforeRetry).recipientId, "newest");
	await new Promise((resolve) => setTimeout(resolve, 10));
	const later = await monitor(join(root, "notifications"), { id: "later", label: "Later" }, async () => false);
	await later.close();
	assert.equal((await (await fetch(endpoint)).json() as any).recipient.id, "later");
	assert.equal((await postAction(followup)).status, 201);
	assert.equal(await readFile(followupPath, "utf8"), savedFollowup, "reply retries stay pinned after a newer session opens");
	assert.equal((await postAction({ ...followup, text: "Changed follow-up" })).status, 400);
	assert.equal(await readFile(followupPath, "utf8"), savedFollowup);
	const queuedRetry = await fetch(endpoint, queuedOptions);
	assert.equal(queuedRetry.status, 201);
	assert.equal((await queuedRetry.json() as any).recipientId, "newest");
	assert.equal(await readFile(messagePath, "utf8"), beforeRetry, "a callback error and newer activation cannot change saved work");
	const pinned = await (await fetch(endpoint, options)).json() as any;
	assert.equal(pinned.recipientId, sessionId);
	assert.equal(pinned.createdAt, original.createdAt);
	assert.deepEqual(pinned.comments, original.comments);
	const conflict = { ...queuedSubmission, comments: [{ ...queuedSubmission.comments[0], text: "Changed" }] };
	assert.equal((await fetch(endpoint, { ...options, body: JSON.stringify(conflict) })).status, 503);
	assert.equal(await readFile(messagePath, "utf8"), beforeRetry);

	// Retries use stored addressing even if all registration metadata is absent.
	await subscription.close();
	await rm(join(root, "notifications", "recipients"), { recursive: true });
	assert.equal((await (await fetch(endpoint)).json() as any).recipient, null);
	assert.equal((await fetch(endpoint, queuedOptions)).status, 201);
	assert.equal((await postAction(followup)).status, 201);
	assert.equal((await postAction({ ...followup, id: randomUUID() })).status, 503);
	assert.equal((await fetch(endpoint, { ...options, body: JSON.stringify({ ...submission, id: randomUUID() }) })).status, 503);
	assert.equal((await (await fetch(endpoint)).json() as any).batches.length, 2);
	assert.deepEqual(observed, [submission.id], "the older active session never receives the offline session's work");
	for (const asset of ["annotations.js", "annotations.css"]) {
		const response = await fetch(`${origin}/assets/${asset}`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type")!, asset.endsWith(".css") ? /text\/css/ : /javascript/);
	}
});
