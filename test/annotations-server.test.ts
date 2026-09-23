import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { handleAnnotations, isResolved, readReplies, readResolutions, writeReply, writeResolution, type Annotation, type AnnotationOptions,
	type Batch, type Recipient, type Reply, type Submission } from "../src/lib/annotations/server.ts";

const annotation: Annotation = {
	id: "comment_1", documentId: "plan/changes/a.md", documentTitle: "A change", revision: "aabbcc11",
	quote: "some text", text: "Please explain.", start: 0, end: 9,
};
const submission: Submission = { id: "batch-1", comments: [annotation] };
const reply: Reply = { commentId: annotation.id, text: "Explanation.", createdAt: "2026-01-02T03:04:05.000Z", author: "Reviewer" };
function batch(value: Submission = submission): Batch {
	return { ...value, recipientId: "session_1", createdAt: reply.createdAt, delivered: false, replies: [] };
}

async function fixture(t: TestContext, overrides: Partial<AnnotationOptions> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "annotations-test-"));
	const submitted: Submission[] = [];
	const completed: Promise<void>[] = [];
	const state: { recipient: Recipient | null; batches: Batch[] } = {
		recipient: { id: "session_1", label: "Planning", active: true, updatedAt: 1 }, batches: [],
	};
	const options: AnnotationOptions = {
		directory, allowedOrigins: [], load: async () => state,
		onSubmit: async (value) => { submitted.push(value); return batch(value); }, ...overrides,
	};
	const server = createServer((req, res) => { completed.push(handleAnnotations(req, res, options)); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	options.allowedOrigins = [origin, `http://localhost:${address.port}`];
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all(completed);
		await rm(directory, { recursive: true, force: true });
	});
	async function send(method = "GET", body?: string | Buffer, headers: Record<string, string | string[] | undefined> = {}) {
		return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: any }>((resolve, reject) => {
			const req = request(`${origin}/w/test/annotations`, { method, headers }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.once("error", reject);
				res.once("end", () => {
					try { resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
					catch (error) { reject(error); }
				});
			});
			req.once("error", reject);
			req.end(body);
		});
	}
	async function credentials() {
		const response = await send();
		assert.equal(response.status, 200);
		return { "Content-Type": "application/json", "X-Annotation-Token": response.body.token as string };
	}
	return { directory, submitted, state, options, server, completed, origin, send, credentials };
}

test("GET creates a private stable token without storing submissions, caches, or CORS", async (t) => {
	const app = await fixture(t);
	const responses = await Promise.all(Array.from({ length: 24 }, () => app.send()));
	const token = responses[0].body.token;
	assert.match(token, /^[a-f0-9]{64}$/);
	for (const result of responses) {
		assert.equal(result.status, 200);
		assert.equal(result.body.token, token);
		assert.equal(result.headers["cache-control"], "no-store");
		assert.equal(result.headers["access-control-allow-origin"], undefined);
		assert.deepEqual(result.body.recipient, app.state.recipient);
		assert.equal(Object.hasOwn(result.body, "recipients"), false);
		assert.deepEqual(result.body.batches, []);
	}
	assert.equal(await readFile(join(app.directory, "token"), "utf8"), token);
	assert.equal((await stat(join(app.directory, "token"))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(app.directory), ["token"]);
	const second = await fixture(t);
	assert.notEqual((await second.send()).body.token, token);
	second.options.directory = app.directory;
	assert.equal((await second.send()).body.token, token, "independent handlers reuse the persisted token");
});

test("GET rejects cross-origin requests and unknown Hosts before creating a token", async (t) => {
	const app = await fixture(t);
	for (const headers of [
		{ Origin: "https://attacker.example" }, { Origin: "null" },
		{ Origin: app.options.allowedOrigins[1] }, { Origin: `${app.origin}/` },
		{ Host: "attacker.example" }, { Host: "127.0.0.1.attacker.example" },
		{ Host: "attacker.example@" + new URL(app.origin).host },
		{ Host: new URL(app.origin).host + ".attacker.example" },
		{ "Sec-Fetch-Site": "cross-site" },
	]) {
		const result = await app.send("GET", undefined, headers);
		assert.equal(result.status, 403, JSON.stringify(headers));
		assert.deepEqual(result.body, { error: "Forbidden." });
		assert.equal(result.headers["cache-control"], "no-store");
	}
	assert.deepEqual(await readdir(app.directory), []);
	assert.equal((await app.send("GET", undefined, { Origin: app.origin })).status, 200);
	assert.equal((await app.send("GET", undefined, {
		Host: new URL(app.options.allowedOrigins[1]).host, Origin: app.options.allowedOrigins[1],
	})).status, 200);
});

test("GET rejects ambiguous duplicate Hosts and missing Hosts", async (t) => {
	const app = await fixture(t);
	const address = app.server.address();
	assert.ok(address && typeof address !== "string");
	for (const hostHeaders of [`Host: ${new URL(app.origin).host}\r\nHost: attacker.example\r\n`, ""]) {
		const socket = connect(address.port, "127.0.0.1");
		await once(socket, "connect");
		let response = "";
		socket.setEncoding("utf8").on("data", (chunk) => { response += chunk; });
		const closed = once(socket, "close");
		socket.end(`GET /w/test/annotations HTTP/1.0\r\n${hostHeaders}Connection: close\r\n\r\n`);
		await closed;
		assert.match(response, /^HTTP\/1\.1 403 /);
	}
	assert.deepEqual(await readdir(app.directory), []);
});

test("POST checks token, exact origin and Host, including without Origin", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	for (const invalid of [
		{ "X-Annotation-Token": "" }, { "X-Annotation-Token": "0".repeat(64) },
		{ "X-Annotation-Token": "é".repeat(64) }, { "X-Annotation-Token": headers["X-Annotation-Token"] + "x" },
		{ Origin: "https://attacker.example" }, { Origin: app.options.allowedOrigins[1] },
		{ Host: "attacker.example" }, { Host: "127.0.0.1" },
		{ Host: "attacker.example", "X-Forwarded-Host": new URL(app.origin).host },
		{ Origin: app.origin.replace("http:", "https:"), "X-Forwarded-Proto": "https" },
	]) {
		const result = await app.send("POST", JSON.stringify(submission), { ...headers, ...invalid });
		assert.equal(result.status, 403, JSON.stringify(invalid));
		assert.ok(!JSON.stringify(result.body).includes(headers["X-Annotation-Token"]));
	}
	assert.equal(app.submitted.length, 0);
	assert.equal((await app.send("POST", JSON.stringify(submission), { "Content-Type": "application/json" })).status, 403);
	assert.equal((await app.send("POST", JSON.stringify(submission), headers)).status, 201);
	assert.equal((await app.send("POST", JSON.stringify(submission), { ...headers, Origin: app.origin })).status, 201);
	assert.deepEqual(app.submitted, [submission, submission]);
});

test("POST passes validated submissions once to the callback and returns its batch", async (t) => {
	const app = await fixture(t);
	const result = await app.send("POST", JSON.stringify(submission), {
		...await app.credentials(), "Content-Type": "application/json; charset=utf-8",
	});
	assert.equal(result.status, 201);
	assert.deepEqual(result.body, batch());
	assert.deepEqual(app.submitted, [submission]);
	assert.deepEqual(await readdir(app.directory), ["token"], "callback, not library, owns submissions");
});

test("POST queues for an offline recipient but leaves new work unsubmitted without one", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	app.state.recipient!.active = false;
	assert.equal((await app.send("POST", JSON.stringify(submission), headers)).status, 201);
	app.state.recipient = null;
	assert.equal((await app.send()).body.recipient, null);
	assert.equal((await app.send("POST", JSON.stringify(submission), headers)).status, 503);
	assert.deepEqual(app.submitted, [submission]);

	// Retained submissions remain retryable without any recipient metadata.
	app.state.batches = [batch()];
	const retried = await app.send("POST", JSON.stringify(submission), headers);
	assert.equal(retried.status, 201);
	assert.deepEqual(retried.body, batch());
	assert.deepEqual(app.submitted, [submission, submission]);
});

test("POST checks availability without choosing the callback's final address", async (t) => {
	const app = await fixture(t, { onSubmit: async (value) => ({ ...batch(value), recipientId: "newly-opened" }) });
	const response = await app.send("POST", JSON.stringify(submission), await app.credentials());
	assert.equal(response.status, 201);
	assert.equal(response.body.recipientId, "newly-opened");
});

test("POST rejects invalid JSON, encodings, and content types without calling the callback", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	for (const contentType of ["", "text/plain", "application/jsonp", "application/json; charset=latin1"]) {
		assert.equal((await app.send("POST", JSON.stringify(submission), { ...headers, "Content-Type": contentType })).status, 415);
	}
	for (const malformed of ["", "{", "undefined", "{\"id\":NaN}", Buffer.from([0xff])]) {
		assert.equal((await app.send("POST", malformed, headers)).status, 400);
	}
	assert.equal(app.submitted.length, 0);
});

test("POST validates shape, meaningful strings, path IDs, offsets, duplicates, and rejects client addressing", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	const changes: Record<string, unknown>[] = [
		{ id: "../escape" }, { id: "" }, { id: "a".repeat(101) }, { id: 1 }, { extra: true },
		{ documentId: " " }, { documentId: "d".repeat(1001) }, { documentTitle: "" },
		{ documentTitle: "t".repeat(1001) }, { revision: " " }, { revision: "r".repeat(201) },
		{ quote: " " }, { quote: "q".repeat(16001) }, { text: "\n\t" }, { text: "t".repeat(8001) },
		{ text: "has\0null" }, { start: -1 }, { start: 1.5 }, { start: "0" },
		{ start: 9 }, { end: 0 }, { end: 9.5 }, { end: 10_000_001 }, { end: Number.MAX_SAFE_INTEGER + 1 },
	];
	const invalid: unknown[] = [null, [], {}, "text", 0, { ...submission, extra: true },
		{ ...submission, id: ".." }, { ...submission, id: "a/b" },
		{ ...submission, recipientId: "../session" }, { ...submission, recipientId: "missing" },
		{ ...submission, recipientId: "session_1" },
		{ ...submission, comments: [] }, { ...submission, comments: null },
		{ ...submission, comments: [annotation, annotation] }, { ...submission, comments: [null] },
		...changes.map((change) => ({ ...submission, comments: [{ ...annotation, ...change }] })),
	];
	for (const field of Object.keys(annotation)) {
		const missing: Record<string, unknown> = { ...annotation };
		delete missing[field];
		invalid.push({ ...submission, comments: [missing] });
	}
	for (const value of invalid) {
		assert.equal((await app.send("POST", JSON.stringify(value), headers)).status, 400, JSON.stringify(value).slice(0, 150));
	}
	assert.equal(app.submitted.length, 0);
});

test("POST enforces byte and comment count limits, including chunked requests", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	const json = JSON.stringify(submission);
	const tooLarge = json + " ".repeat(256 * 1024 + 1 - Buffer.byteLength(json));
	assert.equal((await app.send("POST", tooLarge, { ...headers, "Content-Length": String(Buffer.byteLength(tooLarge)) })).status, 413);
	assert.equal((await app.send("POST", tooLarge, { ...headers, "Transfer-Encoding": "chunked" })).status, 413);
	const comments = Array.from({ length: 51 }, (_, index) => ({ ...annotation, id: `comment_${index}` }));
	assert.equal((await app.send("POST", JSON.stringify({ ...submission, comments }), headers)).status, 413);
	assert.equal(app.submitted.length, 0);
	const boundary = json + " ".repeat(256 * 1024 - Buffer.byteLength(json));
	assert.equal((await app.send("POST", boundary, headers)).status, 201);
	assert.equal((await app.send("POST", JSON.stringify({ ...submission, comments: comments.slice(0, 50) }), headers)).status, 201);
	const maximal = { ...annotation, quote: "é".repeat(16000), text: "好".repeat(8000), end: 10_000_000 };
	assert.equal((await app.send("POST", JSON.stringify({ ...submission, comments: [maximal] }), headers)).status, 201);
	assert.equal(app.submitted.length, 3);
});

test("aborted requests never submit partial JSON", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	const address = app.server.address();
	assert.ok(address && typeof address !== "string");
	const socket = connect(address.port, "127.0.0.1");
	await once(socket, "connect");
	const json = JSON.stringify(submission);
	const received = once(app.server, "request");
	socket.write(`POST /w/test/annotations HTTP/1.1\r\nHost: ${new URL(app.origin).host}\r\nContent-Type: application/json\r\nX-Annotation-Token: ${headers["X-Annotation-Token"]}\r\nContent-Length: ${json.length + 100}\r\n\r\n${json}`);
	await received;
	socket.destroy();
	await Promise.all(app.completed);
	assert.equal(app.submitted.length, 0);
	assert.equal((await app.send()).status, 200, "abort does not damage later requests");
});

test("only GET and POST are supported", async (t) => {
	const app = await fixture(t);
	for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"]) {
		const result = await app.send(method);
		assert.equal(result.status, 405);
		assert.equal(result.headers.allow, "GET, POST");
		assert.equal(result.headers["access-control-allow-origin"], undefined);
	}
	assert.equal(app.submitted.length, 0);
});

test("callback, load, and token-store failures return generic errors without secrets", async (t) => {
	const app = await fixture(t);
	const headers = await app.credentials();
	let calls = 0;
	app.options.onSubmit = async () => { calls++; throw new Error(`private callback stack ${headers["X-Annotation-Token"]}`); };
	const result = await app.send("POST", JSON.stringify(submission), headers);
	assert.equal(result.status, 503);
	assert.deepEqual(result.body, { error: "Service unavailable." });
	assert.equal(calls, 1);
	app.options.load = async () => { throw new Error("private storage failure"); };
	assert.deepEqual((await app.send()).body, { error: "Service unavailable." });
	assert.equal((await app.send("POST", JSON.stringify(submission), headers)).status, 503);
	assert.equal(calls, 1);
	await writeFile(join(app.directory, "token"), "corrupted secret");
	assert.deepEqual((await app.send()).body, { error: "Service unavailable." });
});

test("reply files append privately, retain legacy history, and merge with callback user replies", async (t) => {
	const app = await fixture(t);
	assert.deepEqual(await readReplies(app.directory, submission.id), []);
	const folder = join(app.directory, "replies", submission.id);
	await mkdir(folder, { recursive: true });
	const legacy = JSON.stringify(reply);
	await writeFile(join(folder, `${reply.commentId}.json`), legacy);
	await writeReply(app.directory, submission.id, { ...reply, id: "answer-1", text: "More detail.", createdAt: "2026-01-02T03:04:07Z" });
	await writeReply(app.directory, "another-batch", { ...reply, id: "answer-1", text: "Other batch." });
	assert.deepEqual(await readdir(folder), ["answer-1.json", "comment_1.json"]);
	assert.equal((await stat(join(folder, "answer-1.json"))).mode & 0o777, 0o600);
	assert.equal(await readFile(join(folder, `${reply.commentId}.json`), "utf8"), legacy);
	assert.deepEqual((await readReplies(app.directory, submission.id)).map((item) => item.text), ["Explanation.", "More detail."]);
	assert.deepEqual(await readReplies(app.directory, "another-batch"), [{ ...reply, id: "answer-1", role: "agent", text: "Other batch." }]);
	const user: Reply = { ...reply, id: "user-1", role: "user", author: "You", text: "Please elaborate.", createdAt: "2026-01-02T03:04:06Z", delivered: false };
	app.state.batches = [{ ...batch(), replies: [user] }];
	const result = await app.send();
	assert.equal(result.status, 200);
	assert.deepEqual(result.body.batches[0].replies.map((item: Reply) => item.text), ["Explanation.", "Please elaborate.", "More detail."]);
	assert.deepEqual(app.state.batches[0].replies, [user], "GET does not mutate callback history");
});

test("malformed reply files cannot hide valid replies or escape the batch", async (t) => {
	const app = await fixture(t);
	const saved = { ...reply, id: "answer", role: "agent" as const };
	await writeReply(app.directory, submission.id, saved);
	const folder = join(app.directory, "replies", submission.id);
	await Promise.all([
		writeFile(join(folder, "broken.json"), "{"),
		writeFile(join(folder, "empty.json"), "null"),
		writeFile(join(folder, "wrong.json"), JSON.stringify(reply)),
		writeFile(join(folder, "invalid.json"), JSON.stringify({ ...reply, commentId: "invalid", text: " " })),
		writeFile(join(folder, "comment_2.json"), JSON.stringify({ ...reply, commentId: "comment_2", createdAt: "bad" })),
		writeFile(join(folder, ".temporary.tmp"), JSON.stringify(reply)),
	]);
	assert.deepEqual(await readReplies(app.directory, submission.id), [saved]);
	app.state.batches = [batch()];
	assert.deepEqual((await app.send()).body.batches[0].replies, [saved]);
});

test("reply helpers reject unsafe IDs and invalid reply fields before writing", async (t) => {
	const app = await fixture(t);
	for (const id of ["../escape", "..", "", "a/b", "a\\b", "a".repeat(101)]) {
		await assert.rejects(writeReply(app.directory, id, reply));
		await assert.rejects(readReplies(app.directory, id));
		await assert.rejects(writeReply(app.directory, submission.id, { ...reply, commentId: id }));
	}
	for (const change of [{ text: " " }, { text: "t".repeat(8001) }, { createdAt: "bad" },
		{ author: "" }, { author: "a".repeat(1001) }, { extra: true }, { id: "../bad" }, { role: "system" }, { delivered: 1 }]) {
		await assert.rejects(writeReply(app.directory, submission.id, { ...reply, ...change } as Reply));
	}
	assert.deepEqual(await readdir(app.directory), []);
});

test("concurrent replies append complete immutable files; retries preserve the winning timestamp", async (t) => {
	const app = await fixture(t);
	await Promise.all(Array.from({ length: 20 }, (_, index) => writeReply(app.directory, submission.id,
		{ ...reply, id: "one-answer", createdAt: new Date(Date.parse(reply.createdAt) + index).toISOString() })));
	const first = await readReplies(app.directory, submission.id);
	assert.equal(first.length, 1);
	await writeReply(app.directory, submission.id, { ...reply, id: "one-answer", createdAt: "2027-01-01T00:00:00Z" });
	assert.deepEqual(await readReplies(app.directory, submission.id), first);
	await writeReply(app.directory, submission.id, { ...reply, id: "one-answer", delivered: undefined });
	assert.deepEqual(await readReplies(app.directory, submission.id), first, "optional undefined fields have the same JSON meaning");
	await assert.rejects(writeReply(app.directory, submission.id, { ...reply, id: "one-answer", text: "Changed" }));
	await assert.rejects(writeReply(app.directory, submission.id, { ...reply, id: "one-answer", commentId: "another-comment" }));
	await Promise.all(Array.from({ length: 20 }, (_, index) => writeReply(app.directory, submission.id,
		{ ...reply, text: `Answer ${index}.` }, `answer-${String(index).padStart(2, "0")}`)));
	const all = await readReplies(app.directory, submission.id);
	assert.equal(all.length, 21);
	assert.equal(all.filter((item) => item.id === "one-answer").length, 1);
	assert.equal((await readdir(join(app.directory, "replies", submission.id))).length, 21);
	const conflicting = await Promise.allSettled(["First", "Second"].map((text) =>
		writeReply(app.directory, submission.id, { ...reply, id: "conflict", text })));
	assert.equal(conflicting.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(conflicting.filter((result) => result.status === "rejected").length, 1);
	assert.equal((await readReplies(app.directory, submission.id)).filter((item) => item.id === "conflict").length, 1);
});

test("resolve operations persist without recipients or notifications; old retries cannot undo reopen", async (t) => {
	const app = await fixture(t);
	app.state.batches = [batch()];
	app.state.recipient = null;
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const headers = await app.credentials();
	const operation = { id: "z-resolve", action: "resolve", batchId: submission.id, commentId: annotation.id, resolved: true };
	const post = (value: unknown) => app.send("POST", JSON.stringify(value), headers);
	const saved = await post(operation);
	assert.equal(saved.status, 201);
	assert.equal(saved.body.id, submission.id);
	assert.equal(isResolved(saved.body.resolutions, annotation.id), true);
	const original = saved.body.resolutions[0];
	const reopened = await post({ ...operation, id: "a-reopen", resolved: false });
	assert.equal(reopened.status, 201);
	assert.equal(isResolved(reopened.body.resolutions, annotation.id), false);
	assert.ok(Date.parse(reopened.body.resolutions[1].createdAt) > Date.parse(original.createdAt), "same-millisecond reopen sorts after resolve");
	const retried = await post(operation);
	assert.equal(retried.status, 201);
	assert.deepEqual(retried.body.resolutions, reopened.body.resolutions);
	assert.equal((await post({ ...operation, resolved: false })).status, 400, "an operation ID cannot change meaning");
	assert.deepEqual((await app.send()).body.batches[0].resolutions, reopened.body.resolutions);
	assert.equal((await stat(join(app.directory, "resolutions", submission.id, "z-resolve.json"))).mode & 0o777, 0o600);
	assert.deepEqual(app.submitted, []);
	assert.deepEqual((await readdir(app.directory)).sort(), ["resolutions", "token"]);
});

test("concurrent resolution retries save one immutable event; late agent answers do not reopen", async (t) => {
	const app = await fixture(t);
	const operation = { id: "resolve", commentId: annotation.id, resolved: true };
	await Promise.all(Array.from({ length: 20 }, () => writeResolution(app.directory, submission.id, operation)));
	const before = await readResolutions(app.directory, submission.id);
	assert.equal(before.length, 1);
	await writeReply(app.directory, submission.id, reply);
	assert.deepEqual(await readResolutions(app.directory, submission.id), before);
	await writeResolution(app.directory, submission.id, { ...operation, id: "reopen", resolved: false });
	await writeResolution(app.directory, submission.id, operation);
	const after = await readResolutions(app.directory, submission.id);
	assert.equal(after.length, 2);
	assert.equal(isResolved(after, annotation.id), false);
	assert.deepEqual(after[0], before[0]);
	await assert.rejects(writeResolution(app.directory, submission.id, { ...operation, commentId: "other" }));
	await assert.rejects(writeResolution(app.directory, "../escape", operation));
	await assert.rejects(writeResolution(app.directory, submission.id, { ...operation, id: "../escape" }));
});

test("HTTP replies use only the callback for persistence, merge agent history, and reject resolved threads", async (t) => {
	const app = await fixture(t);
	app.state.batches = [batch()];
	const headers = await app.credentials();
	const operation = { id: "user-reply", action: "reply", batchId: submission.id, commentId: annotation.id, text: "Please clarify." };
	let calls = 0;
	app.options.onReply = async (input) => {
		calls++;
		assert.deepEqual(input, { id: operation.id, batchId: submission.id, commentId: annotation.id, text: operation.text });
		const parent = app.state.batches[0];
		if (!parent.replies.some((reply) => reply.id === input.id)) parent.replies.push({ id: input.id, commentId: input.commentId,
			text: input.text, role: "user", author: "You", createdAt: reply.createdAt, delivered: false });
		return parent;
	};
	await writeReply(app.directory, submission.id, { ...reply, id: "agent-answer" });
	const post = (value: unknown) => app.send("POST", JSON.stringify(value), headers);
	const saved = await post(operation);
	assert.equal(saved.status, 201);
	assert.equal(saved.body.id, submission.id);
	assert.equal(saved.body.replies.length, 2);
	assert.equal(saved.body.replies.find((item: Reply) => item.role === "user").text, operation.text);
	assert.equal((await readReplies(app.directory, submission.id)).length, 1, "user replies have no second source of truth");
	await writeResolution(app.directory, submission.id, { id: "resolve", commentId: annotation.id, resolved: true });
	assert.equal((await post({ ...operation, id: "new-reply" })).status, 409);
	assert.equal(calls, 1);
	app.state.recipient = null;
	assert.equal((await post(operation)).status, 201, "a saved reply is retryable after resolve and metadata removal");
	assert.equal((await post({ ...operation, text: "Different" })).status, 400);
	assert.equal(calls, 2);
	await writeResolution(app.directory, submission.id, { id: "reopen", commentId: annotation.id, resolved: false });
	assert.equal((await post({ ...operation, id: "new-reply" })).status, 503, "new reply needs a recipient");
	assert.deepEqual((await app.send()).body.batches[0].replies, saved.body.replies);
});

test("reply and resolve share strict HTTP security, body limits, field validation, and parent checks", async (t) => {
	const app = await fixture(t);
	app.state.batches = [batch()];
	const headers = await app.credentials();
	let calls = 0;
	app.options.onReply = async () => { calls++; return batch(); };
	const base = { id: "operation", batchId: submission.id, commentId: annotation.id };
	for (const operation of [{ ...base, action: "reply", text: "Follow up" }, { ...base, action: "resolve", resolved: true }]) {
		const post = (value: unknown, extra = {}) => app.send("POST", JSON.stringify(value), { ...headers, ...extra });
		for (const extra of [{ Origin: "https://evil.example" }, { Host: "evil.example" }, { "X-Annotation-Token": "" }, { "Sec-Fetch-Site": "cross-site" }]) {
			assert.equal((await post(operation, extra)).status, 403);
		}
		assert.equal((await post(operation, { "Content-Type": "text/plain" })).status, 415);
		assert.equal((await app.send("POST", JSON.stringify(operation) + " ".repeat(256 * 1024), headers)).status, 413);
		for (const change of [{ id: "../bad" }, { id: "x".repeat(101) }, { batchId: "../bad" }, { commentId: "../bad" },
			{ batchId: "missing" }, { commentId: "missing" }, { action: "unknown" }, { extra: true }, { recipientId: "session_1" }]) {
			assert.equal((await post({ ...operation, ...change })).status, 400, JSON.stringify(change));
		}
		for (const key of Object.keys(operation)) {
			const missing: Record<string, unknown> = { ...operation }; delete missing[key];
			assert.equal((await post(missing)).status, 400);
		}
	}
	for (const text of ["", " \n\t", "has\0null", "x".repeat(8001), 1, null]) {
		assert.equal((await app.send("POST", JSON.stringify({ ...base, action: "reply", text }), headers)).status, 400);
	}
	for (const resolved of ["true", 1, null]) {
		assert.equal((await app.send("POST", JSON.stringify({ ...base, action: "resolve", resolved }), headers)).status, 400);
	}
	assert.equal(calls, 0);
	assert.deepEqual(await readResolutions(app.directory, submission.id), []);
	const operation = { ...base, action: "reply", text: "Follow up" };
	app.options.onReply = undefined;
	assert.equal((await app.send("POST", JSON.stringify(operation), headers)).status, 503);
	app.options.onReply = async () => { throw new Error("private callback detail"); };
	const failed = await app.send("POST", JSON.stringify(operation), headers);
	assert.equal(failed.status, 503);
	assert.deepEqual(failed.body, { error: "Service unavailable." });
});

test("resolution reads use timestamp then ordinal ID and return 503 for unavailable storage", async (t) => {
	const app = await fixture(t);
	app.state.batches = [batch()];
	const headers = await app.credentials();
	const folder = join(app.directory, "resolutions", submission.id);
	await mkdir(folder, { recursive: true });
	const base = { commentId: annotation.id, createdAt: reply.createdAt };
	// Punctuation IDs test ordinal order without case-distinct filenames on macOS.
	await writeFile(join(folder, "_a.json"), JSON.stringify({ ...base, id: "_a", resolved: false }));
	await writeFile(join(folder, "a.json"), JSON.stringify({ ...base, id: "a", resolved: true }));
	await writeFile(join(folder, "invalid.json"), "{");
	assert.deepEqual((await readResolutions(app.directory, submission.id)).map((event) => event.id), ["_a", "a"]);
	assert.equal(isResolved((await app.send()).body.batches[0].resolutions, annotation.id), true);
	await mkdir(join(folder, "unavailable.json"));
	const response = await app.send("POST", JSON.stringify({ id: "reply", action: "reply", batchId: submission.id,
		commentId: annotation.id, text: "Do not treat storage failure as an open thread" }), headers);
	assert.equal(response.status, 503);
	assert.equal((await app.send()).status, 503);
});
