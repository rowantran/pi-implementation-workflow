import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { delivered, list, monitor, publish, recipients, type Notification } from "../src/lib/notifications.ts";

const roots: string[] = [];
// Remove fixtures after per-test hooks have closed all consumers and children.
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function topicFor(_t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "notifications-test-"));
	roots.push(root);
	return join(root, "topic");
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, "condition did not become true within five seconds");
		await sleep(5);
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

const options = { intervalMs: 10 };
const recipient = { id: "reader", label: "Reader", resume: "resume reader" };

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

function worker(t: TestContext, topic: string, id: string) {
	const messages: { type: string; notification?: Notification; error?: string }[] = [];
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { monitor } from ${JSON.stringify(new URL("../src/lib/notifications.ts", import.meta.url).href)};
		try {
			const consumer = await monitor(${JSON.stringify(topic)}, { id: ${JSON.stringify(id)}, label: "Child", resume: "resume child" }, async (notification) => {
				process.send({ type: "notification", notification });
				return true;
			}, { intervalMs: 10 });
			process.on("message", async () => { await consumer.close(); process.exit(0); });
			process.send({ type: "ready" });
		} catch (error) {
			process.send({ type: "error", error: error.message });
			process.exit(1);
		}
	`], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	child.on("message", (message: typeof messages[number]) => { messages.push(message); });
	t.after(() => stop(child));
	return { child, messages };
}

test("absent topic reads are safe and do not create directories", async (t) => {
	const topic = await topicFor(t);
	assert.deepEqual(await recipients(topic), []);
	assert.deepEqual(await list(topic), []);
	assert.equal(await delivered(topic, "missing"), false);
	await assert.rejects(stat(topic), { code: "ENOENT" });
});

test("independent monitors deliver only to the selected recipient and retain messages and receipts", async (t) => {
	const topic = await topicFor(t);
	const first: Notification[] = [];
	const second: Notification[] = [];
	const a = await monitor(topic, { id: "first", label: "First" }, async (n) => { first.push(n); return true; }, options);
	const b = await monitor(topic, { id: "second", label: "Second" }, async (n) => { second.push(n); return true; }, options);
	t.after(async () => { await a.close(); await b.close(); });
	const notification = await publish(topic, { id: "batch", recipientId: "second", payload: { comments: ["hello"] } });
	await until(() => delivered(topic, "batch"));
	await sleep(50);
	assert.deepEqual(first, []);
	assert.deepEqual(second, [notification]);
	assert.deepEqual(await list(topic), [notification]);
	assert.deepEqual((await recipients(topic)).map(({ id, active }) => ({ id, active })), [
		{ id: "first", active: true }, { id: "second", active: true },
	]);
	assert.equal((await readdir(join(topic, "messages"))).length, 1);
	assert.equal((await readdir(join(topic, "receipts"))).length, 1);
	await b.close();
	const reopened = await monitor<{ comments: string[] }>(topic, { id: "second", label: "Second again" }, async (n) => { second.push(n); return true; }, options);
	t.after(() => reopened.close());
	await sleep(50);
	assert.equal(second.length, 1, "a receipt prevents redelivery to a new monitor");
});

test("offline messages survive until a resumed recipient acknowledges them", async (t) => {
	const topic = await topicFor(t);
	const original = await monitor(topic, recipient, async () => true, options);
	await original.close();
	const [inactive] = await recipients(topic);
	assert.deepEqual(inactive, { ...recipient, active: false, registeredAt: inactive.registeredAt, updatedAt: inactive.updatedAt });
	const notification = await publish(topic, { id: "offline", recipientId: recipient.id, payload: { comments: [] } });
	assert.equal(await delivered(topic, notification.id), false);
	let attempts = 0;
	const pending = await monitor(topic, { id: recipient.id, label: "Resumed" }, async () => { attempts++; return false; }, options);
	t.after(() => pending.close());
	await until(() => attempts >= 3);
	await pending.close();
	assert.equal(await delivered(topic, notification.id), false);
	assert.equal((await recipients(topic))[0].resume, recipient.resume);
	const received: Notification[] = [];
	const resumed = await monitor(topic, recipient, async (n) => { received.push(n); return true; }, options);
	t.after(() => resumed.close());
	await until(() => delivered(topic, notification.id));
	await sleep(40);
	assert.deepEqual(received, [notification]);
});

test("publish is immutable and handles concurrent identical retries and conflicting content", async (t) => {
	const topic = await topicFor(t);
	const input = { id: "batch", recipientId: recipient.id, payload: { comments: ["a"], value: 1 } };
	const copies = await Promise.all(Array.from({ length: 24 }, () => publish(topic, input)));
	for (const copy of copies) assert.deepEqual(copy, copies[0]);
	const path = join(topic, "messages", "batch.json");
	const before = await readFile(path, "utf8");
	await sleep(5);
	assert.deepEqual(await publish(topic, { ...input, payload: { value: 1, comments: ["a"] } }), copies[0]);
	await assert.rejects(publish(topic, { ...input, payload: { comments: ["different"], value: 1 } }), /conflict/);
	await assert.rejects(publish(topic, { ...input, recipientId: "other" }), /conflict/);
	assert.equal(await readFile(path, "utf8"), before);
	assert.deepEqual(await readdir(join(topic, "messages")), ["batch.json"]);
	const conflicts = await Promise.allSettled([
		publish(topic, { id: "race", recipientId: recipient.id, payload: "a" }),
		publish(topic, { id: "race", recipientId: recipient.id, payload: "b" }),
	]);
	assert.equal(conflicts.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(conflicts.filter((result) => result.status === "rejected").length, 1);
});

test("list returns retained messages in creation order with deterministic id ties", async (t) => {
	const topic = await topicFor(t);
	const first = await publish(topic, { id: "z-first", recipientId: "reader", payload: { comments: [1] } });
	await sleep(5);
	const second = await publish(topic, { id: "a-second", recipientId: "reader", payload: { comments: [2] } });
	assert.deepEqual(await list<{ comments: number[] }>(topic), [first, second]);
	// An incomplete temporary file must never appear as a published notification.
	await writeFile(join(topic, "messages", ".unfinished.tmp"), "{");
	// Fixed timestamps exercise the documented tie-break independently of clock resolution.
	await writeFile(join(topic, "messages", "b-tie.json"), JSON.stringify({ ...second, id: "b-tie" }));
	assert.deepEqual((await list(topic)).map((n) => n.id), ["z-first", "a-second", "b-tie"]);
});

test("offline messages are delivered in creation order despite a corrupt unrelated file", async (t) => {
	const topic = await topicFor(t);
	const first = await publish(topic, { id: "z-first", recipientId: recipient.id, payload: "first" });
	await sleep(5);
	const second = await publish(topic, { id: "a-second", recipientId: recipient.id, payload: "second" });
	assert.ok(first.createdAt < second.createdAt);
	await writeFile(join(topic, "messages", "0-corrupt.json"), "{");
	await writeFile(join(topic, "messages", "bad-timestamp.json"), JSON.stringify({
		...first, id: "bad-timestamp", createdAt: { toString: null },
	}));
	const seen: string[] = [];
	const errors: unknown[] = [];
	const consumer = await monitor(topic, recipient, async (notification) => {
		seen.push(notification.id);
		return true;
	}, { ...options, onError: (error) => { errors.push(error); } });
	t.after(() => consumer.close());
	await until(async () => await delivered(topic, first.id) && await delivered(topic, second.id));
	await consumer.close();
	assert.deepEqual(seen, [first.id, second.id]);
	assert.ok(errors.some((error) => error instanceof SyntaxError));
	assert.ok(errors.some((error) => error instanceof Error && /creation timestamp/.test(error.message)));
});

test("callback failures and false results do not acknowledge, and callbacks are serial", async (t) => {
	const topic = await topicFor(t);
	const failure = new Error("try again");
	const errors: unknown[] = [];
	let attempts = 0;
	let running = 0;
	let maximum = 0;
	await publish(topic, { id: "retry", recipientId: recipient.id, payload: null });
	const consumer = await monitor(topic, recipient, async () => {
		attempts++;
		running++;
		maximum = Math.max(maximum, running);
		try {
			assert.equal(await delivered(topic, "retry"), false);
			await sleep(25);
			if (attempts === 1) throw failure;
			return attempts >= 3;
		} finally { running--; }
	}, { ...options, onError: (error) => { errors.push(error); throw new Error("reporter failed too"); } });
	t.after(() => consumer.close());
	await until(() => delivered(topic, "retry"));
	await sleep(40);
	assert.equal(attempts, 3);
	assert.equal(maximum, 1);
	assert.deepEqual(errors, [failure]);
});

test("close waits for an in-flight callback and never starts a queued or stale callback", async (t) => {
	const topic = await topicFor(t);
	const started = deferred();
	const release = deferred();
	const seen: string[] = [];
	await publish(topic, { id: "a", recipientId: recipient.id, payload: "first" });
	await publish(topic, { id: "b", recipientId: recipient.id, payload: "second" });
	const consumer = await monitor(topic, recipient, async (n) => {
		seen.push(n.id);
		started.resolve();
		await release.promise;
		return true;
	}, options);
	t.after(async () => { release.resolve(); await consumer.close(); });
	await started.promise;
	let finished = false;
	const closing = consumer.close();
	assert.equal(consumer.close(), closing, "close is idempotent");
	void closing.then(() => { finished = true; });
	await sleep(30);
	assert.equal(finished, false);
	await assert.rejects(monitor(topic, recipient, async () => true, options), /already monitored/);
	release.resolve();
	await closing;
	assert.equal(await delivered(topic, "a"), true);
	assert.equal(await delivered(topic, "b"), false);
	await publish(topic, { id: "c", recipientId: recipient.id, payload: "after close" });
	await sleep(40);
	assert.deepEqual(seen, ["a"]);
	assert.equal((await recipients(topic))[0].active, false);
});

test("immediate close cancels the startup scan", async (t) => {
	const topic = await topicFor(t);
	await publish(topic, { id: "pending", recipientId: recipient.id, payload: null });
	let calls = 0;
	const consumer = await monitor(topic, recipient, async () => { calls++; return true; }, options);
	await consumer.close();
	await sleep(30);
	assert.equal(calls, 0);
	assert.equal(await delivered(topic, "pending"), false);
});

test("simultaneous monitors for one recipient have exactly one owner", async (t) => {
	const topic = await topicFor(t);
	const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => monitor(topic, recipient, async () => true, options)));
	const winners = attempts.filter((result) => result.status === "fulfilled");
	t.after(async () => { for (const winner of winners) await winner.value.close(); });
	assert.equal(winners.length, 1);
	for (const loser of attempts.filter((result) => result.status === "rejected")) assert.match(loser.reason.message, /already monitored/);
	await winners[0].value.close();
	const reopened = await monitor(topic, recipient, async () => true, options);
	await reopened.close();
	assert.equal((await recipients(topic)).length, 1);
});

test("delivery and exclusive ownership work across processes, with recovery after a crash", async (t) => {
	const topic = await topicFor(t);
	const first = worker(t, topic, recipient.id);
	await until(() => first.messages.some((message) => message.type === "ready"));
	await assert.rejects(monitor(topic, recipient, async () => true, options), /already monitored/);
	const duplicate = worker(t, topic, recipient.id);
	await until(() => duplicate.messages.some((message) => message.type === "error"));
	assert.match(duplicate.messages.find((message) => message.type === "error")!.error!, /already monitored/);
	const sent = await publish(topic, { id: "cross-process", recipientId: recipient.id, payload: "hello child" });
	await until(() => delivered(topic, sent.id));
	assert.deepEqual(first.messages.find((message) => message.type === "notification")!.notification, sent);
	await stop(first.child);
	const [offline] = await recipients(topic);
	assert.equal(offline.active, false, "a dead PID expires even a fresh heartbeat");
	assert.equal(offline.resume, "resume child");
	assert.deepEqual(Object.keys(offline).sort(), ["active", "id", "label", "registeredAt", "resume", "updatedAt"]);
	await publish(topic, { id: "after-crash", recipientId: recipient.id, payload: "retained" });
	const recovery = [worker(t, topic, recipient.id), worker(t, topic, recipient.id)];
	await until(() => recovery.every(({ messages }) => messages.some((message) => message.type === "ready" || message.type === "error")));
	assert.equal(recovery.filter(({ messages }) => messages.some((message) => message.type === "ready")).length, 1);
	await until(() => delivered(topic, "after-crash"));
	assert.deepEqual(recovery.flatMap(({ messages }) => messages.filter((message) => message.type === "notification").map((message) => message.notification!.id)), ["after-crash"]);
});

test("a stale heartbeat is inactive without stealing a live process's consumer", async (t) => {
	const topic = await topicFor(t);
	const directory = join(topic, "recipients", recipient.id);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "0.json"), JSON.stringify({ ...recipient, active: true, updatedAt: Date.now() - 60_000, pid: process.pid }));
	assert.equal((await recipients(topic))[0].active, false);
	assert.equal((await recipients(topic))[0].registeredAt, 0, "legacy registrations never inherit heartbeat priority");
	await assert.rejects(monitor(topic, recipient, async () => true, options), /already monitored/);
});

test("heartbeats continue while a callback is in flight", async (t) => {
	const topic = await topicFor(t);
	const started = deferred();
	const release = deferred();
	await publish(topic, { id: "slow", recipientId: recipient.id, payload: "slow" });
	const consumer = await monitor(topic, recipient, async () => { started.resolve(); await release.promise; return false; }, options);
	t.after(async () => { release.resolve(); await consumer.close(); });
	await started.promise;
	const before = (await recipients(topic))[0];
	await until(async () => (await recipients(topic))[0].updatedAt > before.updatedAt);
	const after = (await recipients(topic))[0];
	assert.equal(after.active, true);
	assert.equal(after.registeredAt, before.registeredAt, "heartbeats keep registration time fixed");
	assert.ok(after.updatedAt > after.registeredAt);
	release.resolve();
	await consumer.close();
	assert.equal((await recipients(topic))[0].registeredAt, before.registeredAt, "close is not registration");
});

test("each registration records a fresh activation time and starts its heartbeat at that time", async (t) => {
	const topic = await topicFor(t);
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
	const first = await monitor(topic, recipient, async () => true, options);
	await first.close();
	assert.equal((await recipients(topic))[0].registeredAt, Date.now());
	t.mock.timers.setTime(Date.now() + 5_000);
	const resumed = await monitor(topic, recipient, async () => true, options);
	t.after(() => resumed.close());
	const [record] = await recipients(topic);
	assert.equal(record.registeredAt, Date.now());
	assert.equal(record.updatedAt, record.registeredAt);
	assert.equal(JSON.parse(await readFile(join(topic, "recipients", recipient.id, "1.json"), "utf8")).registeredAt, record.registeredAt);
});

test("unreferenced monitor timers do not keep a process running", async (t) => {
	const topic = await topicFor(t);
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { monitor } from ${JSON.stringify(new URL("../src/lib/notifications.ts", import.meta.url).href)};
		await monitor(${JSON.stringify(topic)}, { id: "unref", label: "Unref" }, async () => true);
	`], { stdio: "ignore" });
	t.after(() => stop(child));
	const [code] = await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
	assert.equal(code, 0);
	assert.equal((await recipients(topic))[0].active, false);
});

test("rejects path ids and invalid input before creating a topic", async (t) => {
	const topic = await topicFor(t);
	for (const id of ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "x\0y", "x".repeat(129)]) {
		await assert.rejects(publish(topic, { id, recipientId: "valid", payload: null }), /Invalid/);
		await assert.rejects(publish(topic, { id: "valid", recipientId: id, payload: null }), /Invalid/);
		await assert.rejects(delivered(topic, id), /Invalid/);
		await assert.rejects(monitor(topic, { id, label: "Bad" }, async () => true), /Invalid/);
	}
	for (const intervalMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
		await assert.rejects(monitor(topic, recipient, async () => true, { intervalMs }), /interval/);
	}
	await assert.rejects(publish(topic, { id: "valid", recipientId: "valid", payload: undefined }), /JSON/);
	await assert.rejects(publish(topic, { id: "valid", recipientId: "valid", payload: 1n }), /BigInt/);
	await assert.rejects(stat(topic), { code: "ENOENT" });
});
