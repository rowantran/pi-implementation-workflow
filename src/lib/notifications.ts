import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface Recipient {
	id: string;
	label: string;
	resume?: string;
}

export interface RegisteredRecipient extends Recipient {
	active: boolean;
	registeredAt: number;
	updatedAt: number;
}

export interface Notification<T = unknown> {
	id: string;
	recipientId: string;
	createdAt: string;
	payload: T;
}

interface Registration extends RegisteredRecipient {
	pid: number;
}

const HEARTBEAT_TIMEOUT_MS = 30_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validateId(id: string): void {
	if (typeof id !== "string" || !ID.test(id)) {
		throw new Error("Invalid notification or recipient id: use 1–128 letters, digits, underscores, or hyphens");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function names(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	}
}

// Link a complete temporary file to claim a name without replacing another writer.
// Rename is used only for the registration that this monitor exclusively owns.
async function writeJson(path: string, value: unknown, replace = false): Promise<boolean> {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
		if (replace) await rename(temporary, path);
		else await link(temporary, path);
		return true;
	} catch (error) {
		if (!replace && hasCode(error, "EEXIST")) return false;
		throw error;
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!hasCode(error, "ENOENT")) throw error;
		});
	}
}

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return hasCode(error, "EPERM");
	}
}

async function latest(directory: string): Promise<{ generation: number; record?: Registration }> {
	const generations = (await names(directory)).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5)));
	const generation = generations.reduce((maximum, value) => Math.max(maximum, value), -1);
	return { generation, record: generation < 0 ? undefined : await readJson<Registration>(join(directory, `${generation}.json`)) };
}

/** List retained recipient metadata. Reading an absent topic does not create it. */
export async function recipients(topic: string): Promise<RegisteredRecipient[]> {
	const result: RegisteredRecipient[] = [];
	for (const id of (await names(join(topic, "recipients"))).filter((name) => ID.test(name)).sort()) {
		const { record } = await latest(join(topic, "recipients", id));
		if (!record) continue;
		result.push({
			id: record.id,
			label: record.label,
			...(record.resume === undefined ? {} : { resume: record.resume }),
			active: record.active && alive(record.pid) && Date.now() - record.updatedAt < HEARTBEAT_TIMEOUT_MS,
			// Old registrations must not acquire priority from a recent heartbeat.
			registeredAt: record.registeredAt ?? 0,
			updatedAt: record.updatedAt,
		});
	}
	return result;
}

/** Publish an immutable notification. An id identifies one recipient and JSON payload. */
export async function publish<T>(topic: string, input: { id: string; recipientId: string; payload: T }): Promise<Notification<T>> {
	validateId(input.id);
	validateId(input.recipientId);
	const json = JSON.stringify(input.payload);
	if (json === undefined) throw new Error("Notification payload must be JSON-serializable");
	const notification: Notification<T> = {
		id: input.id,
		recipientId: input.recipientId,
		createdAt: new Date().toISOString(),
		payload: JSON.parse(json) as T,
	};
	const directory = join(topic, "messages");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${notification.id}.json`);
	if (await writeJson(path, notification)) return notification;
	const existing = await readJson<Notification<T>>(path);
	if (!existing || existing.recipientId !== notification.recipientId || !isDeepStrictEqual(existing.payload, notification.payload)) {
		throw new Error(`Notification id conflict: ${notification.id}`);
	}
	return existing;
}

function creationOrder(left: Notification, right: Notification): number {
	const a = `${left.createdAt}\0${left.id}`;
	const b = `${right.createdAt}\0${right.id}`;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Read retained messages in creation order, breaking timestamp ties by id. */
export async function list<T = unknown>(topic: string): Promise<Notification<T>[]> {
	const result: Notification<T>[] = [];
	for (const name of await names(join(topic, "messages"))) {
		if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
		const notification = await readJson<Notification<T>>(join(topic, "messages", name));
		if (notification) result.push(notification);
	}
	return result.sort(creationOrder);
}

/** True only after a callback returned true and its receipt was saved. */
export async function delivered(topic: string, id: string): Promise<boolean> {
	validateId(id);
	return (await readJson(join(topic, "receipts", `${id}.json`))) !== undefined;
}

/** Consume one recipient's pending notifications, serially, including at startup. */
export async function monitor<T>(
	topic: string,
	recipient: Recipient,
	onNotification: (notification: Notification<T>) => Promise<boolean>,
	options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): Promise<{ close: () => Promise<void> }> {
	recipient = { ...recipient };
	validateId(recipient.id);
	if (typeof recipient.label !== "string" || (recipient.resume !== undefined && typeof recipient.resume !== "string")) {
		throw new Error("Recipient label and resume must be strings");
	}
	const intervalMs = options.intervalMs ?? 1_000;
	if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
		throw new Error("Notification interval must be between 1 and 2147483647 milliseconds");
	}
	const directory = join(topic, "recipients", recipient.id);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await mkdir(join(topic, "receipts"), { recursive: true, mode: 0o700 });

	let path: string;
	let registration: Registration;
	for (;;) {
		const { generation, record } = await latest(directory);
		// A stale heartbeat makes a recipient appear offline, but never permits
		// stealing from a live process: its callback may still be running.
		if (record?.active && alive(record.pid)) throw new Error(`Recipient already monitored: ${recipient.id}`);
		const now = Date.now();
		registration = {
			id: recipient.id,
			label: recipient.label,
			...((recipient.resume ?? record?.resume) === undefined ? {} : { resume: recipient.resume ?? record?.resume }),
			active: true,
			registeredAt: now,
			updatedAt: now,
			pid: process.pid,
		};
		path = join(directory, `${generation + 1}.json`);
		// Never reuse or delete a claim, even after a crash. Concurrent recovery
		// attempts therefore cannot accidentally remove the new owner's lock.
		if (await writeJson(path, registration)) break;
	}

	let closed = false;
	let timer: NodeJS.Timeout | undefined;
	let heartbeat: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const report = (error: unknown): void => {
		try { options.onError?.(error); } catch { /* Reporting must not stop the consumer. */ }
	};
	const update = async (active: boolean): Promise<void> => {
		await writeJson(path, { ...registration, active, updatedAt: Date.now() }, true);
	};
	// Heartbeat independently of callbacks, which may take longer than a poll.
	const heartbeats = setInterval(() => {
		if (!heartbeat) heartbeat = update(true).catch(report).finally(() => { heartbeat = undefined; });
	}, Math.min(intervalMs, 1_000));
	heartbeats.unref();

	async function poll(): Promise<void> {
		try {
			const pending: Notification<T>[] = [];
			for (const name of (await names(join(topic, "messages"))).filter((name) => name.endsWith(".json"))) {
				if (closed) break;
				try {
					const notification = await readJson<Notification<T>>(join(topic, "messages", name));
					if (!notification || notification.recipientId !== recipient.id || await delivered(topic, notification.id)) continue;
					if (typeof notification.createdAt !== "string") throw new Error("Invalid notification creation timestamp");
					pending.push(notification);
				} catch (error) { report(error); }
			}
			for (const notification of pending.sort(creationOrder)) {
				if (closed) break;
				try {
					const id = notification.id;
					if (await onNotification(notification) === true) {
						await writeJson(join(topic, "receipts", `${id}.json`), {
							id, recipientId: recipient.id, deliveredAt: new Date().toISOString(),
						});
					}
				} catch (error) { report(error); }
			}
		} catch (error) { report(error); }
		if (!closed) {
			timer = setTimeout(() => { work = poll(); }, intervalMs);
			timer.unref();
		}
	}
	let work = poll();

	return {
		close(): Promise<void> {
			if (!closing) {
				closed = true;
				clearTimeout(timer);
				clearInterval(heartbeats);
				closing = (async () => {
					await work;
					await heartbeat;
					await update(false);
				})();
			}
			return closing;
		},
	};
}
