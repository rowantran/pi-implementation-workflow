import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const dashboardServer = await jiti.import(new URL("../src/dashboard-server.ts", import.meta.url).pathname);
const dashboard = await jiti.import(new URL("../src/dashboard.ts", import.meta.url).pathname);

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-dashboard-server-"));
const agentDirectory = join(temporaryRoot, "agent");
const workflowsRoot = join(agentDirectory, "workflows");
await mkdir(workflowsRoot, { recursive: true });

function rawRequest(port, path, method = "GET") {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: "127.0.0.1", port, path, method }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolve({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

async function unusedPort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

async function writeConfig(value) {
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(join(agentDirectory, "implementation-workflow.json"), `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureFromAnotherProcess(config, root) {
	const modulePath = fileURLToPath(new URL("../src/dashboard-server.ts", import.meta.url));
	const script = `
		import { createJiti } from "jiti/static";
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		const server = await jiti.import(${JSON.stringify(modulePath)});
		const result = await server.ensureSharedDashboardServer(${JSON.stringify(config)}, ${JSON.stringify(root)});
		process.stdout.write(JSON.stringify(result));
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`dashboard reuse child failed: ${Buffer.concat(stderr).toString("utf8")}`));
				return;
			}
			resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
		});
	});
}

try {
	const defaultConfig = await dashboardServer.loadDashboardServerConfig(join(temporaryRoot, "missing-agent"));
	assert.deepEqual(
		{
			mode: defaultConfig.mode,
			publicBaseUrl: defaultConfig.publicBaseUrl,
			listenHost: defaultConfig.listenHost,
			listenPort: defaultConfig.listenPort,
			probeHost: defaultConfig.probeHost,
		},
		{
			mode: "local",
			publicBaseUrl: "http://127.0.0.1:43121",
			listenHost: "127.0.0.1",
			listenPort: 43121,
			probeHost: "127.0.0.1",
		},
	);

	const port = await unusedPort();
	await writeConfig({ dashboard: { mode: "local", listenPort: port } });
	const localConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(localConfig.publicBaseUrl, `http://127.0.0.1:${port}`);
	assert.equal(localConfig.listenHost, "127.0.0.1");

	await writeConfig({
		dashboard: {
			mode: "remote",
			publicBaseUrl: "http://rowan-v2-devbox:45678",
			listenPort: 45678,
		},
	});
	const remoteConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(remoteConfig.listenHost, "0.0.0.0");
	assert.equal(remoteConfig.probeHost, "127.0.0.1");
	assert.equal(remoteConfig.publicBaseUrl, "http://rowan-v2-devbox:45678");
	await writeConfig({
		dashboard: {
			mode: "remote",
			publicBaseUrl: "https://rowan-v2-devbox/workflow-dashboards/",
			listenPort: 45678,
		},
	});
	const prefixedRemoteConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(prefixedRemoteConfig.publicBaseUrl, "https://rowan-v2-devbox/workflow-dashboards");

	for (const invalid of [
		{ dashboard: { mode: "remote", listenPort: 45678 } },
		{ dashboard: { mode: "remote", publicBaseUrl: "file:///tmp/dashboard", listenPort: 45678 } },
		{ dashboard: { mode: "remote", publicBaseUrl: "http://devbox:45678/path?query=yes", listenPort: 45678 } },
		{ dashboard: { mode: "remote", publicBaseUrl: "http://devbox:45678", listenPort: 45678, listenHost: " " } },
		{ dashboard: { mode: "local", listenPort: 0 } },
	]) {
		await writeConfig(invalid);
		await assert.rejects(
			dashboardServer.loadDashboardServerConfig(agentDirectory),
			new RegExp(join(agentDirectory, "implementation-workflow.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}

	const draftFiles = { dashboard: join(workflowsRoot, ".drafts", "Draft-123", "dashboard.html") };
	const workflowFiles = { dashboard: join(workflowsRoot, "workflow-one", "dashboard.html") };
	const draftReference = dashboardServer.dashboardReference(draftFiles, "draft", "Draft-123");
	const workflowReference = dashboardServer.dashboardReference(workflowFiles, "workflow", "workflow-one");
	assert.equal(
		dashboardServer.dashboardUrl(draftReference, localConfig),
		`http://127.0.0.1:${port}/implementation-workflow/drafts/Draft-123`,
	);
	assert.equal(
		dashboardServer.dashboardUrl(workflowReference, localConfig),
		`http://127.0.0.1:${port}/implementation-workflow/workflows/workflow-one`,
	);
	assert.equal(
		dashboardServer.dashboardUrl(workflowReference, prefixedRemoteConfig),
		"https://rowan-v2-devbox/workflow-dashboards/implementation-workflow/workflows/workflow-one",
	);
	assert.throws(() => dashboardServer.dashboardReference(workflowFiles, "workflow", "../escape"));

	await mkdir(join(workflowsRoot, ".drafts", "Draft-123"), { recursive: true });
	await mkdir(join(workflowsRoot, "workflow-one"), { recursive: true });
	await writeFile(draftFiles.dashboard, "<h1>draft one</h1>", "utf8");
	await writeFile(workflowFiles.dashboard, "<h1>workflow one</h1>", "utf8");

	const concurrentStarts = await Promise.all([
		dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot),
		dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot),
		dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot),
	]);
	assert.ok(concurrentStarts.every(({ status }) => status === "started"), "concurrent startup calls share one result");
	assert.deepEqual(await dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot), { status: "reused" });
	assert.deepEqual(
		await ensureFromAnotherProcess(localConfig, workflowsRoot),
		{ status: "reused" },
		"a separate Pi process recognizes and reuses the listener",
	);

	const draftResponse = await rawRequest(port, "/implementation-workflow/drafts/Draft-123");
	assert.equal(draftResponse.status, 200);
	assert.equal(draftResponse.body, "<h1>draft one</h1>");
	assert.equal(draftResponse.headers["content-type"], "text/html; charset=utf-8");
	assert.equal(draftResponse.headers["cache-control"], "no-store");
	assert.equal(draftResponse.headers["x-content-type-options"], "nosniff");
	assert.equal(draftResponse.headers["x-frame-options"], "DENY");
	assert.equal(draftResponse.headers["referrer-policy"], "no-referrer");

	const headResponse = await rawRequest(port, "/implementation-workflow/workflows/workflow-one", "HEAD");
	assert.equal(headResponse.status, 200);
	assert.equal(headResponse.body, "");
	assert.equal(Number(headResponse.headers["content-length"]), Buffer.byteLength("<h1>workflow one</h1>"));
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-one", "POST")).status, 405);
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/missing")).status, 404);
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/%2e%2e")).status, 404);
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-one/plan.md")).status, 404);
	assert.equal((await rawRequest(port, "/workflow-dashboards/implementation-workflow/workflows/workflow-one")).status, 200);
	const outsideDashboard = join(temporaryRoot, "outside-dashboard.html");
	await writeFile(outsideDashboard, "outside workflow storage", "utf8");
	await mkdir(join(workflowsRoot, "symlink-escape"), { recursive: true });
	await symlink(outsideDashboard, join(workflowsRoot, "symlink-escape", "dashboard.html"));
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/symlink-escape")).status, 404);

	await mkdir(join(workflowsRoot, "created-after-start"), { recursive: true });
	const liveDashboard = join(workflowsRoot, "created-after-start", "dashboard.html");
	await writeFile(liveDashboard, "first version", "utf8");
	assert.equal(
		(await rawRequest(port, "/implementation-workflow/workflows/created-after-start")).body,
		"first version",
	);
	await writeFile(liveDashboard, "second version", "utf8");
	assert.equal(
		(await rawRequest(port, "/implementation-workflow/workflows/created-after-start")).body,
		"second version",
	);

	const redirectPath = join(workflowsRoot, ".drafts", "promoted", "dashboard.html");
	const destinationUrl = `http://127.0.0.1:${port}/implementation-workflow/workflows/workflow-one`;
	await dashboard.writeWorkflowDashboardRedirect(redirectPath, destinationUrl);
	const redirect = await readFile(redirectPath, "utf8");
	assert.match(redirect, new RegExp(destinationUrl.replaceAll("/", "\\/")));
	assert.doesNotMatch(redirect, /file:\/\//);
	assert.equal((await rawRequest(port, "/implementation-workflow/drafts/promoted")).status, 200);

	const conflictingConfig = { ...localConfig, listenPort: await unusedPort(), publicBaseUrl: "http://127.0.0.1:1" };
	const inProcessConflict = await dashboardServer.ensureSharedDashboardServer(conflictingConfig, workflowsRoot);
	assert.equal(inProcessConflict.reason, "process-configuration-conflict");

	await dashboardServer.closeOwnedDashboardServer();
	await assert.rejects(rawRequest(port, dashboardServer.DASHBOARD_HEALTH_PATH));
	assert.deepEqual(await dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot), { status: "started" });
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-one")).status, 200);
	await dashboardServer.closeOwnedDashboardServer();

	const occupiedPort = await unusedPort();
	const unrelated = createHttpServer((_request, response) => response.end("not this extension"));
	await new Promise((resolve, reject) => {
		unrelated.once("error", reject);
		unrelated.listen(occupiedPort, "127.0.0.1", resolve);
	});
	const occupiedConfig = {
		...localConfig,
		listenPort: occupiedPort,
		publicBaseUrl: `http://127.0.0.1:${occupiedPort}`,
	};
	const conflict = await dashboardServer.ensureSharedDashboardServer(occupiedConfig, workflowsRoot);
	assert.equal(conflict.reason, "port-conflict");
	await new Promise((resolve) => unrelated.close(resolve));

	console.log("Dashboard-server test passed: configuration, stable URLs, stateless routing, sharing, restart, and conflicts work.");
} finally {
	await dashboardServer.closeOwnedDashboardServer();
	await rm(temporaryRoot, { recursive: true, force: true });
}
