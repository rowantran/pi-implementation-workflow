import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export interface Annotation {
	id: string;
	documentId: string;
	documentTitle: string;
	revision: string;
	quote: string;
	text: string;
	start: number;
	end: number;
}
export interface Submission { id: string; comments: Annotation[] }
export interface Reply {
	commentId: string; text: string; createdAt: string; author: string;
	id?: string; role?: "user" | "agent"; delivered?: boolean;
}
export interface ReplySubmission { id: string; batchId: string; commentId: string; text: string }
export interface Resolution { id: string; commentId: string; resolved: boolean; createdAt: string }
export interface Batch extends Submission {
	recipientId: string; createdAt: string; delivered: boolean; replies: Reply[]; resolutions?: Resolution[];
}
export interface Recipient { id: string; label: string; active: boolean; resume?: string; updatedAt: number }
export interface AnnotationOptions {
	directory: string;
	allowedOrigins: string[];
	load: () => Promise<{ recipient: Recipient | null; batches: Batch[] }>;
	onSubmit: (submission: Submission) => Promise<Batch>;
	onReply?: (submission: ReplySubmission) => Promise<Batch>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const BODY_LIMIT = 256 * 1024;
export class HttpError extends Error {
	status: number;
	constructor(status: number) { super(); this.status = status; }
}
const isId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);
const isText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length <= max && value.trim().length > 0 && !value.includes("\0");
function hasFields(value: unknown, fields: string[]): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function submissionFrom(value: unknown): Submission {
	if (!hasFields(value, ["id", "comments"]) || !isId(value.id)
		|| !Array.isArray(value.comments)) throw new HttpError(400);
	if (value.comments.length > 50) throw new HttpError(413);
	if (!value.comments.length) throw new HttpError(400);
	const ids = new Set<string>();
	for (const comment of value.comments) {
		if (!hasFields(comment, ["id", "documentId", "documentTitle", "revision", "quote", "text", "start", "end"])
			|| !isId(comment.id) || ids.has(comment.id) || !isText(comment.documentId, 1000)
			|| !isText(comment.documentTitle, 1000) || !isText(comment.revision, 200)
			|| !isText(comment.quote, 16000) || !isText(comment.text, 8000)
			|| typeof comment.start !== "number" || !Number.isSafeInteger(comment.start) || comment.start < 0
			|| typeof comment.end !== "number" || !Number.isSafeInteger(comment.end)
			|| comment.end <= comment.start || comment.end > 10_000_000) throw new HttpError(400);
		ids.add(comment.id);
	}
	return value as unknown as Submission;
}

function validReply(value: unknown): value is Reply {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const fields = ["commentId", "text", "createdAt", "author", ...["id", "role", "delivered"].filter((key) => Object.hasOwn(value, key))];
	return hasFields(value, fields) && isId(value.commentId)
		&& isText(value.text, 8000) && isText(value.author, 1000) && validTimestamp(value.createdAt)
		&& (value.id === undefined || isId(value.id))
		&& (value.role === undefined || value.role === "user" || value.role === "agent")
		&& (value.delivered === undefined || typeof value.delivered === "boolean");
}
const validTimestamp = (value: unknown): value is string => isText(value, 100) && Number.isFinite(Date.parse(value));
function validResolution(value: unknown): value is Resolution {
	return hasFields(value, ["id", "commentId", "resolved", "createdAt"]) && isId(value.id) && isId(value.commentId)
		&& typeof value.resolved === "boolean" && validTimestamp(value.createdAt);
}

/** Stable chronological order, including legacy replies without an ID. */
export function historyOrder(a: { createdAt: string; id?: string }, b: { createdAt: string; id?: string }): number {
	const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
	return time || ((a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0);
}

// Publish complete immutable events. A retry compares meaning, not its new timestamp.
async function appendEvent<T extends { createdAt: string }>(folder: string, id: string, event: T): Promise<void> {
	await mkdir(folder, { recursive: true, mode: 0o700 });
	const temporary = join(folder, `.${id}-${randomUUID()}.tmp`);
	const filename = join(folder, `${id}.json`);
	const json = JSON.stringify(event);
	try {
		await writeFile(temporary, json, { flag: "wx", mode: 0o600 });
		try { await link(temporary, filename); }
		catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			const { createdAt: _oldTime, ...existing } = JSON.parse(await readFile(filename, "utf8"));
			const { createdAt: _newTime, ...input } = JSON.parse(json);
			if (!isDeepStrictEqual(existing, input)) throw new HttpError(400);
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

/** The caller must authorize the session and confirm the comment belongs to this batch.
 * New calls append; supply a stable ID to make retries idempotent. Legacy files are never replaced. */
export async function writeReply(directory: string, batchId: string, reply: Reply, id = reply.id ?? randomUUID()): Promise<void> {
	if (!isId(batchId) || !isId(id) || !validReply(reply) || (reply.id !== undefined && reply.id !== id)) throw new Error("Invalid reply.");
	await appendEvent(join(directory, "replies", batchId), id, { ...reply, id, role: reply.role ?? "agent" });
}

async function readEvents<T>(folder: string, valid: (value: unknown) => value is T, key: (value: T) => string): Promise<T[]> {
	let files: string[];
	try { files = await readdir(folder); }
	catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
	const events: T[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(".json") || !isId(file.slice(0, -5))) continue;
		try {
			const event: unknown = JSON.parse(await readFile(join(folder, file), "utf8"));
			if (valid(event) && key(event) === file.slice(0, -5)) events.push(event);
		} catch (error) {
			// Malformed or removed individual records do not hide the rest. Storage
			// failures must propagate rather than making a resolved thread look open.
			if (!(error instanceof SyntaxError) && !hasCode(error, "ENOENT")) throw error;
		}
	}
	return events;
}

/** An invalid file cannot hide other replies; legacy comment-ID filenames remain readable. */
export async function readReplies(directory: string, batchId: string): Promise<Reply[]> {
	if (!isId(batchId)) throw new Error("Invalid batch ID.");
	return (await readEvents(join(directory, "replies", batchId), validReply, (reply) => reply.id ?? reply.commentId)).sort(historyOrder);
}

export async function readResolutions(directory: string, batchId: string): Promise<Resolution[]> {
	if (!isId(batchId)) throw new Error("Invalid batch ID.");
	return (await readEvents(join(directory, "resolutions", batchId), validResolution, (resolution) => resolution.id)).sort(historyOrder);
}

export function isResolved(resolutions: Resolution[], commentId: string): boolean {
	return resolutions.filter((event) => event.commentId === commentId).sort(historyOrder).at(-1)?.resolved ?? false;
}

/** Keep every operation for uncertain-retry confirmation. Old retries never replace a later reopen. */
export async function writeResolution(directory: string, batchId: string, resolution: Omit<Resolution, "createdAt">): Promise<void> {
	const previous = await readResolutions(directory, batchId);
	// Sequential operations must sort later even within one millisecond or after a clock adjustment.
	const timestamp = previous.reduce((time, event) => Math.max(time, Date.parse(event.createdAt) + 1), Date.now());
	const event = { ...resolution, createdAt: new Date(timestamp).toISOString() };
	if (!validResolution(event)) throw new HttpError(400);
	await appendEvent(join(directory, "resolutions", batchId), event.id, event);
}

/** Merge adapter-owned user replies with library-owned agent history. */
export async function enrichBatch(directory: string, batch: Batch): Promise<Batch> {
	const [replies, resolutions] = await Promise.all([readReplies(directory, batch.id), readResolutions(directory, batch.id)]);
	return { ...batch, replies: [...batch.replies, ...replies].sort(historyOrder),
		...(resolutions.length ? { resolutions } : {}) };
}

type Action = ({ action: "reply" } & ReplySubmission)
	| { id: string; action: "resolve"; batchId: string; commentId: string; resolved: boolean };
function requestFrom(value: unknown): Submission | Action {
	if (typeof value !== "object" || value === null || !("action" in value)) return submissionFrom(value);
	const record = value as Record<string, unknown>;
	const field = record.action === "reply" ? "text" : "resolved";
	if (!hasFields(record, ["id", "action", "batchId", "commentId", field]) || !isId(record.id)
		|| !isId(record.batchId) || !isId(record.commentId)
		|| (record.action !== "reply" && record.action !== "resolve")
		|| (record.action === "reply" ? !isText(record.text, 8000) : typeof record.resolved !== "boolean")) throw new HttpError(400);
	return value as unknown as Action;
}

async function tokenFor(directory: string): Promise<string> {
	const filename = join(directory, "token");
	try {
		const token = await readFile(filename, "utf8");
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid token store.");
		return token;
	} catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.token-${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
		// A hard link publishes a complete file without replacing a concurrent winner.
		try { await link(temporary, filename); }
		catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
	} finally {
		await unlink(temporary).catch(() => {});
	}
	return tokenFor(directory);
}

function checkOrigin(request: IncomingMessage, allowedOrigins: string[]): void {
	const host = request.headers.host;
	const hostCount = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === "host").length;
	const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
	const actual = `${protocol}//${host}`;
	if (!host || hostCount !== 1 || !allowedOrigins.some((allowed) => {
		try {
			const url = new URL(allowed);
			return url.origin === allowed && url.origin === actual;
		} catch { return false; }
	}) || (request.headers.origin !== undefined && request.headers.origin !== actual)
		|| request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403);
}

function readBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const fail = (status: number) => {
			if (settled) return;
			settled = true;
			chunks = [];
			reject(new HttpError(status));
		};
		request.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > BODY_LIMIT) fail(413);
			else chunks.push(chunk);
		});
		request.once("error", () => fail(400));
		request.once("aborted", () => fail(400));
		request.once("end", () => {
			if (settled) return;
			if (!request.complete) { fail(400); return; }
			try {
				const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
				settled = true;
				chunks = [];
				resolve(parsed);
			} catch { fail(400); }
		});
		if (request.aborted || request.destroyed) fail(400);
		else if (Number(request.headers["content-length"]) > BODY_LIMIT) fail(413);
	});
}

function respond(response: ServerResponse, status: number, body: unknown): void {
	if (response.destroyed || response.writableEnded) return;
	const json = JSON.stringify(body);
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff" });
	response.end(json);
}

/** Handle an already-matched route. Callbacks own user submissions; local files own answers and resolutions. */
export async function handleAnnotations(request: IncomingMessage, response: ServerResponse, options: AnnotationOptions): Promise<void> {
	try {
		if (request.method !== "GET" && request.method !== "POST") {
			response.setHeader("Allow", "GET, POST");
			throw new HttpError(405);
		}
		checkOrigin(request, options.allowedOrigins);
		const token = await tokenFor(options.directory);
		if (request.method === "GET") {
			const { recipient, batches } = await options.load();
			const withReplies = await Promise.all(batches.map((batch) => enrichBatch(options.directory, batch)));
			respond(response, 200, { token, recipient, batches: withReplies });
			return;
		}
		const provided = request.headers["x-annotation-token"];
		if (typeof provided !== "string" || !/^[a-f0-9]{64}$/.test(provided)
			|| !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) throw new HttpError(403);
		if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers["content-type"] ?? "")) {
			throw new HttpError(415);
		}
		const input = requestFrom(await readBody(request));
		const { recipient, batches } = await options.load();
		if (request.aborted || response.destroyed) return;
		if (!("action" in input)) {
			// A retained batch can be retried even without recipient metadata.
			if (!recipient && !batches.some((batch) => batch.id === input.id)) throw new HttpError(503);
			respond(response, 201, await enrichBatch(options.directory, await options.onSubmit(input)));
			return;
		}
		const parent = batches.find((batch) => batch.id === input.batchId);
		if (!parent || !parent.comments.some((comment) => comment.id === input.commentId)) throw new HttpError(400);
		if (input.action === "resolve") {
			await writeResolution(options.directory, parent.id, { id: input.id, commentId: input.commentId, resolved: input.resolved });
			respond(response, 201, await enrichBatch(options.directory, parent));
			return;
		}
		const existing = parent.replies.find((reply) => reply.id === input.id);
		if (existing && (existing.role !== "user" || existing.commentId !== input.commentId || existing.text !== input.text)) throw new HttpError(400);
		// A saved reply remains retryable after resolve; only new replies need an open thread.
		if (!existing && isResolved(await readResolutions(options.directory, parent.id), input.commentId)) throw new HttpError(409);
		if (!options.onReply || (!recipient && !existing)) throw new HttpError(503);
		const { action: _action, ...submission } = input;
		respond(response, 201, await enrichBatch(options.directory, await options.onReply(submission)));
	} catch (error) {
		request.resume();
		const status = error instanceof HttpError ? error.status : 503;
		respond(response, status, { error: ({ 400: "Invalid request.", 403: "Forbidden.", 405: "Method not allowed.",
			409: "Thread is resolved. Reopen it before replying.", 413: "Request too large.", 415: "Expected application/json." } as Record<number, string>)[status] ?? "Service unavailable." });
	}
}
