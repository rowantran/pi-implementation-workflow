import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import {
	implementationWorkflowConfigPath,
	loadImplementationWorkflowConfig,
	type ImplementationWorkflowConfig,
} from "./config.ts";
import {
	DRAFT_IDENTIFIER_PATTERN,
	IDENTIFIER_PATTERN,
	type WorkflowFiles,
} from "./storage.ts";

export const DEFAULT_DASHBOARD_PORT = 43121;
export const DASHBOARD_SERVER_PROTOCOL_VERSION = 1;
export const DASHBOARD_HEALTH_PATH = "/implementation-workflow/health";
export const DASHBOARD_REVISION_HEADER = "X-Implementation-Workflow-Revision";
const PROCESS_SERVER_KEY = Symbol.for("pi-implementation-workflow.dashboard-server.v1");
const PROBE_TIMEOUT_MS = 750;
const MAX_HEALTH_RESPONSE_BYTES = 8 * 1024;
const MAX_DASHBOARD_REVISION_SCAN_BYTES = 8 * 1024;
const DASHBOARD_REVISION_PATTERN = /<meta name="implementation-workflow-revision" content="([a-f0-9]{64})">/;

export type DashboardScope = "draft" | "workflow";

export interface DashboardReference {
	scope: DashboardScope;
	id: string;
	filePath: string;
}

export interface DashboardServerConfig {
	mode: "local" | "remote";
	publicBaseUrl: string;
	listenHost: string;
	listenPort: number;
	probeHost: string;
	configPath: string;
}

export interface DashboardServerIdentity {
	protocolVersion: number;
	workflowsRootFingerprint: string;
}

interface ProcessDashboardServer {
	config: DashboardServerConfig;
	workflowsRoot: string;
	identity: DashboardServerIdentity;
	server: Server;
}

interface ProcessServerHolder {
	ownedServer?: ProcessDashboardServer;
	startup?: Promise<EnsureDashboardServerResult>;
}

export type EnsureDashboardServerResult =
	| { status: "started" | "reused" }
	| {
			status: "error";
			reason: "port-conflict" | "process-configuration-conflict" | "start-failure";
			message: string;
	  };

type ProbeResult = "none" | "different" | "matching";

export function dashboardConfigPath(agentDirectory: string): string {
	return implementationWorkflowConfigPath(agentDirectory);
}

export async function loadDashboardServerConfig(agentDirectory: string): Promise<DashboardServerConfig> {
	return dashboardServerConfig(await loadImplementationWorkflowConfig(agentDirectory));
}

export function dashboardServerConfig(config: ImplementationWorkflowConfig): DashboardServerConfig {
	const { configPath, dashboard } = config;
	if (dashboard === undefined) return localDashboardConfig(configPath);
	const unknownFields = Object.keys(dashboard).filter(
		(key) => key !== "mode" && key !== "public_base_url" && key !== "listen_port" && key !== "listen_host",
	);
	if (unknownFields.length > 0) {
		throw new Error(
			`Unknown dashboard field${unknownFields.length === 1 ? "" : "s"} ${unknownFields.join(", ")}: ${configPath}`,
		);
	}

	const mode = dashboard.mode;
	if (mode === undefined || mode === "local") {
		const listenPort = dashboard.listen_port === undefined
			? DEFAULT_DASHBOARD_PORT
			: requireListenPort(dashboard.listen_port, configPath);
		return localDashboardConfig(configPath, listenPort);
	}
	if (mode !== "remote") {
		throw new Error(`dashboard.mode must be either "local" or "remote": ${configPath}`);
	}

	const listenPort = requireListenPort(dashboard.listen_port, configPath);
	let listenHost = "0.0.0.0";
	if (dashboard.listen_host !== undefined) {
		if (typeof dashboard.listen_host !== "string" || !dashboard.listen_host.trim()) {
			throw new Error(`dashboard.listen_host must be a non-empty string: ${configPath}`);
		}
		listenHost = dashboard.listen_host.trim();
	}
	const publicBaseUrl = requirePublicBaseUrl(dashboard.public_base_url, configPath);
	return {
		mode: "remote",
		publicBaseUrl,
		listenHost,
		listenPort,
		probeHost: isWildcardHost(listenHost) ? "127.0.0.1" : listenHost,
		configPath,
	};
}

export function dashboardReference(files: WorkflowFiles, scope: DashboardScope, id: string): DashboardReference {
	assertDashboardIdentifier(scope, id);
	return { scope, id, filePath: resolve(files.dashboard) };
}

export function dashboardUrl(reference: DashboardReference, config: DashboardServerConfig): string {
	assertDashboardIdentifier(reference.scope, reference.id);
	const collection = reference.scope === "draft" ? "drafts" : "workflows";
	return `${config.publicBaseUrl}/implementation-workflow/${collection}/${encodeURIComponent(reference.id)}`;
}

export function dashboardServerIdentity(workflowsRoot: string): DashboardServerIdentity {
	return {
		protocolVersion: DASHBOARD_SERVER_PROTOCOL_VERSION,
		workflowsRootFingerprint: createHash("sha256").update(resolve(workflowsRoot)).digest("hex"),
	};
}

export async function ensureSharedDashboardServer(
	config: DashboardServerConfig,
	workflowsRoot: string,
): Promise<EnsureDashboardServerResult> {
	const holder = processServerHolder();
	if (holder.startup) return holder.startup;
	const identity = dashboardServerIdentity(workflowsRoot);
	const owned = holder.ownedServer;
	if (owned && !owned.server.listening) holder.ownedServer = undefined;
	if (holder.ownedServer) {
		if (serverMatches(holder.ownedServer, config, workflowsRoot, identity)) return { status: "reused" };
		return {
			status: "error",
			reason: "process-configuration-conflict",
			message: "This Pi process already owns a dashboard server with different addressing or workflow storage.",
		};
	}

	const startup = probeAndClaimServer(holder, config, resolve(workflowsRoot), identity);
	holder.startup = startup;
	try {
		return await startup;
	} finally {
		if (holder.startup === startup) holder.startup = undefined;
	}
}

export async function closeOwnedDashboardServer(): Promise<void> {
	const holder = processServerHolder();
	if (holder.startup) await holder.startup.catch(() => undefined);
	const owned = holder.ownedServer;
	holder.ownedServer = undefined;
	holder.startup = undefined;
	if (!owned?.server.listening) return;
	await new Promise<void>((resolveClose) => {
		owned.server.close(() => resolveClose());
	});
}

async function probeAndClaimServer(
	holder: ProcessServerHolder,
	config: DashboardServerConfig,
	workflowsRoot: string,
	identity: DashboardServerIdentity,
): Promise<EnsureDashboardServerResult> {
	const observed = await probeDashboardServer(config.probeHost, config.listenPort, identity);
	if (observed === "matching") return { status: "reused" };
	if (observed === "different") return portConflict(config);

	const server = createServer((incoming, response) => {
		void handleDashboardRequest(incoming.method, incoming.url, response, workflowsRoot, identity).catch(() => {
			if (!response.headersSent) sendText(response, 500, "Internal Server Error\n");
			else response.destroy();
		});
	});
	const listenError = await listen(server, config.listenHost, config.listenPort);
	if (!listenError) {
		holder.ownedServer = { config, workflowsRoot, identity, server };
		return { status: "started" };
	}

	if (listenError.code === "EADDRINUSE") {
		const raced = await probeDashboardServer(config.probeHost, config.listenPort, identity);
		if (raced === "matching") return { status: "reused" };
		return portConflict(config);
	}
	return {
		status: "error",
		reason: "start-failure",
		message: `Could not listen on ${config.listenHost}:${config.listenPort}: ${listenError.message}`,
	};
}

async function handleDashboardRequest(
	method: string | undefined,
	rawUrl: string | undefined,
	response: ServerResponse,
	workflowsRoot: string,
	identity: DashboardServerIdentity,
): Promise<void> {
	setDefensiveHeaders(response);
	if (method !== "GET" && method !== "HEAD") {
		response.setHeader("Allow", "GET, HEAD");
		sendText(response, 405, "Method Not Allowed\n", method === "HEAD");
		return;
	}

	const rawPath = (rawUrl ?? "").split("?", 1)[0];
	if (rawPath === DASHBOARD_HEALTH_PATH) {
		sendJson(response, 200, identity, method === "HEAD");
		return;
	}
	const reference = parseDashboardRoute(rawPath);
	if (!reference) {
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}

	const candidate = reference.scope === "draft"
		? resolve(workflowsRoot, ".drafts", reference.id, "dashboard.html")
		: resolve(workflowsRoot, reference.id, "dashboard.html");
	if (!isPathWithin(resolve(workflowsRoot), candidate)) {
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}

	let rootRealPath: string;
	let dashboardRealPath: string;
	try {
		[rootRealPath, dashboardRealPath] = await Promise.all([realpath(workflowsRoot), realpath(candidate)]);
	} catch {
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}
	if (!isPathWithin(rootRealPath, dashboardRealPath)) {
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}

	let dashboardFile: Awaited<ReturnType<typeof open>> | undefined;
	let fileInfo: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;
	try {
		dashboardFile = await open(dashboardRealPath, "r");
		fileInfo = await dashboardFile.stat();
	} catch {
		await dashboardFile?.close().catch(() => undefined);
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}
	if (!fileInfo.isFile()) {
		await dashboardFile.close();
		sendText(response, 404, "Not Found\n", method === "HEAD");
		return;
	}

	const dashboardRevision = await readDashboardRevision(dashboardFile, fileInfo.size);
	if (dashboardRevision) response.setHeader(DASHBOARD_REVISION_HEADER, dashboardRevision);
	response.statusCode = 200;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("Content-Length", fileInfo.size);
	if (method === "HEAD") {
		await dashboardFile.close();
		response.end();
		return;
	}
	try {
		const html = await dashboardFile.readFile();
		response.setHeader("Content-Length", html.byteLength);
		response.end(html);
	} catch {
		if (!response.headersSent) sendText(response, 404, "Not Found\n");
		else response.destroy();
	} finally {
		await dashboardFile.close();
	}
}

async function readDashboardRevision(
	dashboardFile: Awaited<ReturnType<typeof open>>,
	fileSize: number,
): Promise<string | undefined> {
	const scanLength = Math.min(fileSize, MAX_DASHBOARD_REVISION_SCAN_BYTES);
	if (!scanLength) return undefined;
	const buffer = Buffer.allocUnsafe(scanLength);
	const { bytesRead } = await dashboardFile.read(buffer, 0, scanLength, 0);
	return DASHBOARD_REVISION_PATTERN.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
}

function parseDashboardRoute(rawPath: string): Pick<DashboardReference, "scope" | "id"> | undefined {
	const routeStart = rawPath.lastIndexOf("/implementation-workflow/");
	if (routeStart < 0) return undefined;
	const match = /^\/implementation-workflow\/(drafts|workflows)\/([^/]+)$/.exec(rawPath.slice(routeStart));
	if (!match) return undefined;
	let id: string;
	try {
		id = decodeURIComponent(match[2]);
	} catch {
		return undefined;
	}
	const scope: DashboardScope = match[1] === "drafts" ? "draft" : "workflow";
	try {
		assertDashboardIdentifier(scope, id);
		return { scope, id };
	} catch {
		return undefined;
	}
}

function assertDashboardIdentifier(scope: DashboardScope, id: string): void {
	const valid = scope === "draft" ? DRAFT_IDENTIFIER_PATTERN.test(id) : IDENTIFIER_PATTERN.test(id);
	if (!valid) throw new Error(`Invalid ${scope} dashboard identifier: ${id}`);
}

function localDashboardConfig(configPath: string, listenPort = DEFAULT_DASHBOARD_PORT): DashboardServerConfig {
	return {
		mode: "local",
		publicBaseUrl: `http://127.0.0.1:${listenPort}`,
		listenHost: "127.0.0.1",
		listenPort,
		probeHost: "127.0.0.1",
		configPath,
	};
}

function requireListenPort(value: unknown, configPath: string): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
		throw new Error(`dashboard.listen_port must be an integer from 1 through 65535: ${configPath}`);
	}
	return value as number;
}

function requirePublicBaseUrl(value: unknown, configPath: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Remote dashboard mode requires dashboard.public_base_url: ${configPath}`);
	}
	const rawUrl = value.trim();
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`dashboard.public_base_url must be an absolute HTTP or HTTPS URL: ${configPath}`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
		throw new Error(`dashboard.public_base_url must be an absolute HTTP or HTTPS URL: ${configPath}`);
	}
	if (url.username || url.password || rawUrl.includes("?") || rawUrl.includes("#")) {
		throw new Error(`dashboard.public_base_url cannot contain credentials, a query, or a fragment: ${configPath}`);
	}
	return url.href.replace(/\/$/, "");
}

function isWildcardHost(host: string): boolean {
	return host === "0.0.0.0" || host === "::";
}

function processServerHolder(): ProcessServerHolder {
	const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
	const existing = store[PROCESS_SERVER_KEY];
	if (existing) return existing as ProcessServerHolder;
	const holder: ProcessServerHolder = {};
	store[PROCESS_SERVER_KEY] = holder;
	return holder;
}

function serverMatches(
	owned: ProcessDashboardServer,
	config: DashboardServerConfig,
	workflowsRoot: string,
	identity: DashboardServerIdentity,
): boolean {
	return (
		resolve(owned.workflowsRoot) === resolve(workflowsRoot) &&
		owned.identity.protocolVersion === identity.protocolVersion &&
		owned.identity.workflowsRootFingerprint === identity.workflowsRootFingerprint &&
		owned.config.mode === config.mode &&
		owned.config.publicBaseUrl === config.publicBaseUrl &&
		owned.config.listenHost === config.listenHost &&
		owned.config.listenPort === config.listenPort &&
		owned.config.probeHost === config.probeHost
	);
}

function listen(server: Server, host: string, port: number): Promise<NodeJS.ErrnoException | undefined> {
	return new Promise((resolveListen) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			resolveListen(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolveListen(undefined);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function probeDashboardServer(
	host: string,
	port: number,
	identity: DashboardServerIdentity,
): Promise<ProbeResult> {
	return new Promise((resolveProbe) => {
		let settled = false;
		let deadline: NodeJS.Timeout | undefined;
		const finish = (result: ProbeResult) => {
			if (settled) return;
			settled = true;
			if (deadline) clearTimeout(deadline);
			resolveProbe(result);
		};
		const probe = request(
			{
				host,
				port,
				path: DASHBOARD_HEALTH_PATH,
				method: "GET",
				headers: { Connection: "close" },
			},
			(response) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > MAX_HEALTH_RESPONSE_BYTES) {
						response.destroy();
						finish("different");
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					if (response.statusCode !== 200) {
						finish("different");
						return;
					}
					try {
						const observed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<DashboardServerIdentity>;
						finish(
							observed.protocolVersion === identity.protocolVersion &&
								observed.workflowsRootFingerprint === identity.workflowsRootFingerprint
								? "matching"
								: "different",
						);
					} catch {
						finish("different");
					}
				});
			},
		);
		deadline = setTimeout(() => {
			probe.destroy();
			finish("different");
		}, PROBE_TIMEOUT_MS);
		probe.on("error", (error: NodeJS.ErrnoException) => {
			finish(
				error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH"
					? "none"
					: "different",
			);
		});
		probe.end();
	});
}

function portConflict(config: DashboardServerConfig): EnsureDashboardServerResult {
	return {
		status: "error",
		reason: "port-conflict",
		message: `Port ${config.listenPort} on ${config.probeHost} is occupied by a different service or workflow root.`,
	};
}

function setDefensiveHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendText(response: ServerResponse, statusCode: number, text: string, head = false): void {
	const body = Buffer.from(text);
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "text/plain; charset=utf-8");
	response.setHeader("Content-Length", body.byteLength);
	response.end(head ? undefined : body);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown, head = false): void {
	const body = Buffer.from(`${JSON.stringify(value)}\n`);
	response.statusCode = statusCode;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Content-Length", body.byteLength);
	response.end(head ? undefined : body);
}

function isPathWithin(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
