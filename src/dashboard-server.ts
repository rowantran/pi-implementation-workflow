import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DashboardConfig } from "./config.ts";
import { isRecord, isSlug, readOptional } from "./plan.ts";

const ASSETS = new Map([
	["marked.umd.js", () => fileURLToPath(new URL("./marked.umd.js", import.meta.resolve("marked")))],
	["highlight.min.js", () => fileURLToPath(import.meta.resolve("@highlightjs/cdn-assets/highlight.min.js"))],
	["mermaid.min.js", () => fileURLToPath(new URL("./mermaid.min.js", import.meta.resolve("mermaid")))],
]);

let owned: Server | undefined;
let starting: Promise<void> | undefined;

export function dashboardUrl(config: DashboardConfig, id: string): string {
	return `${config.publicBaseUrl}/w/${encodeURIComponent(id)}`;
}

/**
 * The only global state: ~/.pi/agent/workflows/index.json maps workflow ids to
 * their .workflows/<id> directories so any pi process can serve any dashboard.
 */
export function indexPath(agentDirectory = getAgentDir()): string {
	return join(agentDirectory, "workflows", "index.json");
}

export async function readIndex(path = indexPath()): Promise<Record<string, string>> {
	const text = await readOptional(path);
	if (!text?.trim()) return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([id, root]) => isSlug(id) && typeof root === "string")) as Record<string, string> : {};
	} catch {
		return {};
	}
}

export async function registerDashboard(id: string, root: string, path = indexPath()): Promise<void> {
	const index = await readIndex(path);
	if (index[id] === root) return;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify({ ...index, [id]: root }, null, 2)}\n`);
}

export async function unregisterDashboard(id: string, path = indexPath()): Promise<void> {
	const index = await readIndex(path);
	if (!(id in index)) return;
	delete index[id];
	await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Starts this process's dashboard server once. If the port is already taken,
 * another pi process is assumed to be serving the same files from disk, so the
 * URL still works and no error is raised. Real bind errors are thrown.
 */
export function ensureDashboardServer(config: DashboardConfig, index = indexPath()): Promise<void> {
	if (owned?.listening) return Promise.resolve();
	starting ??= new Promise<void>((resolve, reject) => {
		const server = createServer((request, response) => {
			handle(request.method ?? "GET", request.url ?? "/", response, index).catch(() => {
				if (!response.headersSent) send(response, 500, "text/plain", "Internal Server Error\n");
				else response.destroy();
			});
		});
		server.once("error", (error: NodeJS.ErrnoException) => {
			starting = undefined;
			if (error.code === "EADDRINUSE") resolve();
			else reject(new Error(`Could not start the dashboard server on ${config.listenHost}:${config.listenPort}: ${error.message}`));
		});
		server.listen(config.listenPort, config.listenHost, () => {
			server.unref();
			owned = server;
			starting = undefined;
			resolve();
		});
	});
	return starting;
}

export async function closeDashboardServer(): Promise<void> {
	const server = owned;
	owned = undefined;
	if (!server?.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function handle(method: string, url: string, response: ServerResponse, index: string): Promise<void> {
	if (method !== "GET" && method !== "HEAD") return send(response, 405, "text/plain", "Method Not Allowed\n");
	const path = new URL(url, "http://localhost").pathname;
	const asset = /\/assets\/([a-z0-9.-]+)$/.exec(path);
	if (asset) {
		const resolveAsset = ASSETS.get(asset[1]!);
		if (!resolveAsset) return send(response, 404, "text/plain", "Not Found\n");
		return send(response, 200, "text/javascript; charset=utf-8", await readFile(resolveAsset()), method === "HEAD", "public, max-age=86400");
	}
	const dashboard = /\/w\/([a-z0-9-]+)$/.exec(path);
	if (!dashboard) return send(response, 404, "text/plain", "Not Found\n");
	const root = (await readIndex(index))[dashboard[1]!];
	const html = root ? await readOptional(join(root, "dashboard.html")) : undefined;
	if (html === undefined) return send(response, 404, "text/plain", "No dashboard for this workflow. Run /workflow-dashboard in its session.\n");
	return send(response, 200, "text/html; charset=utf-8", html, method === "HEAD");
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, headOnly = false, cache = "no-store"): void {
	response.writeHead(status, {
		"Content-Type": type,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": cache,
		ETag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`,
	});
	response.end(headOnly ? undefined : body);
}
