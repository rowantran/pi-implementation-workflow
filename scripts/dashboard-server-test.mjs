import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { stringify } from "smol-toml";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-dashboard-server-"));
const agentDirectory = join(temporaryRoot, "agent");
const workflowsRoot = join(agentDirectory, "workflows");
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
await mkdir(workflowsRoot, { recursive: true });

const jiti = createJiti(import.meta.url, { moduleCache: false });
const dashboardServer = await jiti.import(new URL("../src/dashboard-server.ts", import.meta.url).pathname);
const dashboard = await jiti.import(new URL("../src/dashboard.ts", import.meta.url).pathname);
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);

async function createWorkflow(worktreePath, identifier, html) {
	await mkdir(worktreePath, { recursive: true });
	const metadata = {
		version: storage.WORKFLOW_METADATA_VERSION,
		identifier,
		description: "",
		ask: `Plan ${identifier}`,
		repositoryRoot: dirname(worktreePath),
		gitCommonDir: join(dirname(worktreePath), ".git"),
		baseBranch: "main",
		baseCommit: "abc123",
		workflowBranch: `workflow/${identifier}`,
		worktreePath,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const files = storage.workflowFiles(identifier, worktreePath);
	await storage.createWorkflow(files, metadata);
	await storage.registerWorkflow(metadata);
	await writeFile(files.dashboard, html, "utf8");
	return files;
}

async function withSymlink(path, target, action) {
	const saved = `${path}.saved`;
	await rename(path, saved);
	try {
		await symlink(target ?? saved, path);
		await action();
	} finally {
		await rm(path, { force: true });
		await rename(saved, path);
	}
}

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
	const configDirectory = join(agentDirectory, "implementation-workflow");
	await mkdir(configDirectory, { recursive: true });
	await writeFile(join(configDirectory, "config.toml"), stringify(value), "utf8");
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
	await writeConfig({ dashboard: { mode: "local", listen_port: port } });
	const localConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(localConfig.publicBaseUrl, `http://127.0.0.1:${port}`);
	assert.equal(localConfig.listenHost, "127.0.0.1");

	await writeConfig({
		dashboard: {
			mode: "remote",
			public_base_url: "http://rowan-v2-devbox:45678",
			listen_port: 45678,
		},
	});
	const remoteConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(remoteConfig.listenHost, "0.0.0.0");
	assert.equal(remoteConfig.probeHost, "127.0.0.1");
	assert.equal(remoteConfig.publicBaseUrl, "http://rowan-v2-devbox:45678");
	await writeConfig({
		dashboard: {
			mode: "remote",
			public_base_url: "https://rowan-v2-devbox/workflow-dashboards/",
			listen_port: 45678,
		},
	});
	const prefixedRemoteConfig = await dashboardServer.loadDashboardServerConfig(agentDirectory);
	assert.equal(prefixedRemoteConfig.publicBaseUrl, "https://rowan-v2-devbox/workflow-dashboards");

	for (const invalid of [
		{ dashboard: { mode: "remote", listen_port: 45678 } },
		{ dashboard: { mode: "remote", public_base_url: "file:///tmp/dashboard", listen_port: 45678 } },
		{ dashboard: { mode: "remote", public_base_url: "http://devbox:45678/path?query=yes", listen_port: 45678 } },
		{ dashboard: { mode: "remote", public_base_url: "http://devbox:45678/?", listen_port: 45678 } },
		{ dashboard: { mode: "remote", public_base_url: "http://devbox:45678/#", listen_port: 45678 } },
		{ dashboard: { mode: "remote", public_base_url: "http://devbox:45678", listen_port: 45678, listen_host: " " } },
		{ dashboard: { mode: "local", listen_port: 0 } },
	]) {
		await writeConfig(invalid);
		await assert.rejects(
			dashboardServer.loadDashboardServerConfig(agentDirectory),
			new RegExp(join(agentDirectory, "implementation-workflow", "config.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}

	const firstWorktree = join(temporaryRoot, "repo-one", "worktree");
	const secondWorktree = join(temporaryRoot, "repo-two", "worktree");
	const workflowFiles = await createWorkflow(firstWorktree, "workflow-one", "<h1>workflow one</h1>");
	await createWorkflow(secondWorktree, "workflow-two", "<h1>workflow two</h1>");
	const workflowReference = dashboardServer.dashboardReference(workflowFiles, "workflow", "workflow-one");
	assert.equal(
		dashboardServer.dashboardUrl(workflowReference, localConfig),
		`http://127.0.0.1:${port}/implementation-workflow/workflows/workflow-one`,
	);
	assert.equal(
		dashboardServer.dashboardUrl(workflowReference, prefixedRemoteConfig),
		"https://rowan-v2-devbox/workflow-dashboards/implementation-workflow/workflows/workflow-one",
	);
	assert.throws(() => dashboardServer.dashboardReference(workflowFiles, "workflow", "../escape"));
	assert.throws(() => dashboardServer.dashboardReference(workflowFiles, "draft", "Draft-123"));

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

	const health = await rawRequest(port, dashboardServer.DASHBOARD_HEALTH_PATH);
	assert.deepEqual(JSON.parse(health.body), dashboardServer.dashboardServerIdentity(workflowsRoot));
	assert.equal(JSON.parse(health.body).protocolVersion, 3);
	const workflowResponse = await rawRequest(port, "/implementation-workflow/workflows/workflow-one");
	assert.equal(workflowResponse.status, 200);
	assert.equal(workflowResponse.body, "<h1>workflow one</h1>");
	assert.equal(workflowResponse.headers["content-type"], "text/html; charset=utf-8");
	assert.equal(workflowResponse.headers["cache-control"], "no-store");
	assert.equal(workflowResponse.headers["x-content-type-options"], "nosniff");
	assert.equal(workflowResponse.headers["x-frame-options"], "DENY");
	assert.equal(workflowResponse.headers["referrer-policy"], "no-referrer");
	assert.equal(
		(await rawRequest(port, "/implementation-workflow/workflows/workflow-two")).body,
		"<h1>workflow two</h1>",
		"one listener routes to worktrees in different repositories",
	);

	const markedAsset = await rawRequest(port, "/implementation-workflow/assets/marked.umd.js");
	assert.equal(markedAsset.status, 200);
	assert.equal(markedAsset.headers["content-type"], "text/javascript; charset=utf-8");
	assert.ok(markedAsset.body.includes("marked"));
	const mermaidAsset = await rawRequest(port, "/workflow-dashboards/implementation-workflow/assets/mermaid.min.js", "HEAD");
	assert.equal(mermaidAsset.status, 200);
	assert.equal(mermaidAsset.body, "");
	assert.ok(Number(mermaidAsset.headers["content-length"]) > 100_000);
	assert.equal((await rawRequest(port, "/implementation-workflow/assets/missing.js")).status, 404);

	const headResponse = await rawRequest(port, "/implementation-workflow/workflows/workflow-one", "HEAD");
	assert.equal(headResponse.status, 200);
	assert.equal(headResponse.body, "");
	assert.equal(Number(headResponse.headers["content-length"]), Buffer.byteLength("<h1>workflow one</h1>"));
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-one", "POST")).status, 405);
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/missing")).status, 404);
	for (const invalid of ["%2e%2e", "%2e%2e%2fescape", "workflow-one%2fplan.md", "workflow-one%5cplan.md", "%00", "%ZZ", "UPPERCASE", "a".repeat(81)]) {
		assert.equal((await rawRequest(port, `/implementation-workflow/workflows/${invalid}`)).status, 404, invalid);
	}
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-one/plan.md")).status, 404);
	assert.equal((await rawRequest(port, "/workflow-dashboards/implementation-workflow/workflows/workflow-one")).status, 200);
	const liveFiles = await createWorkflow(join(temporaryRoot, "live-worktree"), "created-after-start", "first version");
	const liveDashboard = liveFiles.dashboard;
	assert.equal(
		(await rawRequest(port, "/implementation-workflow/workflows/created-after-start")).body,
		"first version",
	);
	await writeFile(`${liveDashboard}.tmp`, "second version", "utf8");
	await rename(`${liveDashboard}.tmp`, liveDashboard);
	assert.equal(
		(await rawRequest(port, "/implementation-workflow/workflows/created-after-start")).body,
		"second version",
	);
	const revisionedDashboard = dashboard.renderWorkflowDashboard({
		slug: "created-after-start",
		description: "Revision one",
		generatedAt: "2026-01-01T00:00:00.000Z",
		versions: [],
		clarifications: [],
	});
	await writeFile(liveDashboard, revisionedDashboard, "utf8");
	const revisionedResponse = await rawRequest(port, "/implementation-workflow/workflows/created-after-start");
	const revisionedHead = await rawRequest(port, "/implementation-workflow/workflows/created-after-start", "HEAD");
	const embeddedRevision = /<meta name="implementation-workflow-revision" content="([a-f0-9]{64})">/.exec(revisionedDashboard)?.[1];
	assert.equal(revisionedResponse.body, revisionedDashboard, "revision scanning does not truncate the response body");
	assert.equal(revisionedHead.headers["x-implementation-workflow-revision"], embeddedRevision);

	// Legacy global artifacts are not a fallback when the locator is absent.
	for (const [directory, route] of [
		[join(workflowsRoot, "legacy-global"), "/implementation-workflow/workflows/legacy-global"],
		[join(workflowsRoot, ".drafts", "Draft-123"), "/implementation-workflow/drafts/Draft-123"],
	]) {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "dashboard.html"), "legacy dashboard", "utf8");
		assert.equal((await rawRequest(port, route)).status, 404);
	}

	const outsideDashboard = join(temporaryRoot, "outside-dashboard.html");
	await writeFile(outsideDashboard, "must never be served", "utf8");
	const workflowRoute = "/implementation-workflow/workflows/workflow-one";
	for (const target of [outsideDashboard, join(secondWorktree, ".workflows", "workflow-two", "dashboard.html"), undefined]) {
		await withSymlink(workflowFiles.dashboard, target, async () => {
			assert.equal((await rawRequest(port, workflowRoute)).status, 404, "dashboard symlinks are not served");
			assert.equal((await rawRequest(port, workflowRoute, "HEAD")).status, 404);
		});
	}
	for (const directory of [workflowFiles.root, join(firstWorktree, ".workflows")]) {
		await withSymlink(directory, undefined, async () => {
			assert.equal((await rawRequest(port, workflowRoute)).status, 404, "workflow-directory symlinks are not served");
		});
	}
	await rename(workflowFiles.dashboard, `${workflowFiles.dashboard}.saved`);
	try {
		await mkdir(workflowFiles.dashboard);
		assert.equal((await rawRequest(port, workflowRoute)).status, 404, "a dashboard must be a regular file");
	} finally {
		await rm(workflowFiles.dashboard, { recursive: true });
		await rename(`${workflowFiles.dashboard}.saved`, workflowFiles.dashboard);
	}

	const markerPath = storage.activeWorkflowMarkerPath(firstWorktree);
	const locatorPath = storage.workflowRegistryFiles("workflow-one").locator;
	const originalMarker = await readFile(markerPath, "utf8");
	const originalLocator = await readFile(locatorPath, "utf8");
	for (const path of [markerPath, locatorPath]) {
		await withSymlink(path, undefined, async () => {
			assert.equal((await rawRequest(port, workflowRoute)).status, 404, "symlinked routing records are not trusted");
		});
		const original = await readFile(path, "utf8");
		try {
			for (const content of ["not json", "null", JSON.stringify({ ...JSON.parse(original), identifier: "another-workflow" }), JSON.stringify({ ...JSON.parse(original), worktreePath: "../escape" })]) {
				await writeFile(path, content, "utf8");
				assert.equal((await rawRequest(port, workflowRoute)).status, 404, "routing records must validate and match");
			}
		} finally {
			await writeFile(path, original, "utf8");
		}
	}
	await withSymlink(workflowsRoot, undefined, async () => {
		assert.equal((await rawRequest(port, workflowRoute)).status, 404, "a symlinked index root is not trusted");
	});
	await withSymlink(firstWorktree, undefined, async () => {
		assert.equal((await rawRequest(port, workflowRoute)).status, 404, "a replaced worktree symlink is not trusted");
	});
	await rename(markerPath, `${markerPath}.saved`);
	try {
		assert.equal((await rawRequest(port, workflowRoute)).status, 404, "local artifacts without an active marker are not served");
	} finally {
		await rename(`${markerPath}.saved`, markerPath);
	}
	for (const field of ["repositoryRoot", "gitCommonDir"]) {
		try {
			await writeFile(markerPath, JSON.stringify({ ...JSON.parse(originalMarker), [field]: temporaryRoot }), "utf8");
			assert.equal((await rawRequest(port, workflowRoute)).status, 404, "matching identifiers alone do not authenticate a locator");
		} finally {
			await writeFile(markerPath, originalMarker, "utf8");
		}
	}

	// A committed historical bundle and stale locator do not make it the active workflow.
	const historicalFiles = storage.workflowFiles("historical", firstWorktree);
	await mkdir(historicalFiles.root);
	await writeFile(historicalFiles.dashboard, "historical dashboard", "utf8");
	await writeFile(storage.workflowRegistryFiles("historical").locator, JSON.stringify({ ...JSON.parse(originalLocator), identifier: "historical" }), "utf8");
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/historical")).status, 404);
	assert.equal((await rawRequest(port, workflowRoute)).status, 200);

	const cleanedWorktree = join(temporaryRoot, "cleaned-worktree");
	await createWorkflow(cleanedWorktree, "cleaned", "will be removed");
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/cleaned")).status, 200);
	await rm(cleanedWorktree, { recursive: true });
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/cleaned")).status, 404, "a stale locator cannot resurrect a removed worktree");

	// The running listener observes a deleted and rebuilt index without keeping artifact paths in memory.
	await rm(workflowsRoot, { recursive: true });
	assert.equal((await rawRequest(port, workflowRoute)).status, 404);
	assert.equal(await readFile(workflowFiles.dashboard, "utf8"), "<h1>workflow one</h1>");
	assert.equal((await storage.readActiveWorkflow(firstWorktree)).identifier, "workflow-one");
	assert.equal((await rawRequest(port, workflowRoute)).status, 200);
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-two")).status, 404);
	assert.equal((await storage.readActiveWorkflow(secondWorktree)).identifier, "workflow-two");
	assert.equal((await rawRequest(port, "/implementation-workflow/workflows/workflow-two")).body, "<h1>workflow two</h1>");

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

	for (const identity of [
		{ ...dashboardServer.dashboardServerIdentity(workflowsRoot), protocolVersion: 2 },
		dashboardServer.dashboardServerIdentity(join(temporaryRoot, "another-index")),
	]) {
		const incompatible = createHttpServer((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(identity));
		});
		await new Promise((resolve, reject) => {
			incompatible.once("error", reject);
			incompatible.listen(0, "127.0.0.1", resolve);
		});
		try {
			const incompatibleConfig = { ...localConfig, listenPort: incompatible.address().port };
			assert.equal(
				(await dashboardServer.ensureSharedDashboardServer(incompatibleConfig, workflowsRoot)).reason,
				"port-conflict",
				"a legacy global-artifact server or different locator index cannot be reused",
			);
		} finally {
			await new Promise((resolve) => incompatible.close(resolve));
		}
	}

	// The explicit server root must remain authoritative even if ambient configuration changes.
	assert.deepEqual(await dashboardServer.ensureSharedDashboardServer(localConfig, workflowsRoot), { status: "started" });
	process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "unrelated-agent");
	try {
		assert.equal((await rawRequest(port, workflowRoute)).status, 200, "routing uses the server's configured index, not ambient process configuration");
	} finally {
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
	}

	console.log("Dashboard-server test passed: worktree-local routing, live updates, locator restoration, safety, sharing, and protocol conflicts work.");
} finally {
	await dashboardServer.closeOwnedDashboardServer();
	await rm(temporaryRoot, { recursive: true, force: true });
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
}
