import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-dashboard-notification-"));
const agentDirectory = join(temporaryRoot, "agent");
const repositoryRoot = join(temporaryRoot, "repository");
const gitCommonDir = join(repositoryRoot, ".git");
process.env.PI_CODING_AGENT_DIR = agentDirectory;

async function unusedPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

const port = await unusedPort();
const configDirectory = join(agentDirectory, "implementation-workflow");
await mkdir(configDirectory, { recursive: true });
await writeFile(
	join(configDirectory, "config.toml"),
	`[dashboard]\nmode = "local"\nlisten_port = ${port}\n`,
	"utf8",
);

const jiti = createJiti(import.meta.url, { moduleCache: false });
const implementationWorkflow = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname, { default: true });

function createHarness() {
	const commands = new Map();
	const shortcuts = new Map();
	const events = new Map();
	const notifications = [];
	const executions = [];
	let activeTools = ["read", "edit", "write"];
	const pi = {
		appendEntry() {},
		exec: async (command, args) => {
			executions.push({ command, args });
			assert.equal(command, "git", "dashboard presentation must not launch a browser command");
			if (args.includes("--show-toplevel")) return { code: 0, stdout: `${repositoryRoot}\n`, stderr: "" };
			if (args.includes("--git-common-dir")) return { code: 0, stdout: `${gitCommonDir}\n`, stderr: "" };
			throw new Error(`Unexpected git command: ${args.join(" ")}`);
		},
		getActiveTools: () => [...activeTools],
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) { commands.set(name, definition); },
		registerEntryRenderer() {},
		registerShortcut(name, definition) { shortcuts.set(name, definition); },
		registerTool() {},
		sendUserMessage() {},
		setActiveTools(tools) { activeTools = [...tools]; },
		setSessionName() {},
	};
	implementationWorkflow(pi);
	return { commands, shortcuts, events, notifications, executions };
}

function context(branch, mode = "rpc") {
	return {
		cwd: repositoryRoot,
		mode,
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "notification-session",
		},
		ui: {
			editor: async () => "Serve the workflow dashboard through one shared HTTP listener.",
			notify: (message, level) => activeNotifications.push({ message, level }),
			setStatus() {},
			setWidget() {},
			theme: { fg: (_color, text) => text },
		},
		waitForIdle: async () => {},
	};
}

async function emit(harness, name, event, ctx) {
	for (const handler of harness.events.get(name) ?? []) await handler(event, ctx);
}

function dashboardNotifications(notifications) {
	return notifications.filter(({ message }) => message.startsWith("Workflow dashboard: "));
}

let activeNotifications;
try {
	const first = createHarness();
	activeNotifications = first.notifications;
	const draftBranch = [{
		type: "custom",
		customType: "implementation-workflow-phase",
		data: { phase: "planning", draftId: "notification-session" },
	}];
	const rpcContext = context(draftBranch);
	await first.commands.get("workflow-plan").handler("", rpcContext);
	const expectedUrl = `http://127.0.0.1:${port}/implementation-workflow/drafts/notification-session`;
	assert.equal(dashboardNotifications(first.notifications).length, 1);
	assert.equal(dashboardNotifications(first.notifications)[0].message, `Workflow dashboard: ${expectedUrl}`);
	assert.equal(first.commands.get("workflow-dashboard").description, "Show the active implementation workflow dashboard link");
	assert.match(first.shortcuts.get("ctrl+alt+d").description, /^Show /);

	await emit(first, "session_start", { reason: "startup" }, rpcContext);
	assert.equal(dashboardNotifications(first.notifications).length, 1, "automatic announcements deduplicate per runtime");
	await first.commands.get("workflow-dashboard").handler("", rpcContext);
	await first.shortcuts.get("ctrl+alt+d").handler(rpcContext);
	assert.equal(dashboardNotifications(first.notifications).length, 3, "explicit command and shortcut always announce");
	assert.ok(first.executions.every(({ command }) => command === "git"));
	assert.equal((await fetch(expectedUrl)).status, 200);

	await emit(first, "session_shutdown", { reason: "resume" }, rpcContext);
	assert.equal((await fetch(expectedUrl)).status, 200, "session replacement keeps the process server alive");

	setCapabilities({ images: "none", trueColor: false, hyperlinks: true });
	const second = createHarness();
	activeNotifications = second.notifications;
	const tuiContext = context(draftBranch, "tui");
	await emit(second, "session_start", { reason: "resume" }, tuiContext);
	const linkedMessage = dashboardNotifications(second.notifications)[0].message;
	assert.ok(linkedMessage.includes(expectedUrl), "the OSC 8 label retains the literal URL");
	assert.ok(linkedMessage.includes("\u001b]8;;"), "supported terminals receive an OSC 8 link");
	assert.equal((await fetch(expectedUrl)).status, 200);

	await emit(second, "session_shutdown", { reason: "fork" }, tuiContext);
	assert.equal((await fetch(expectedUrl)).status, 200, "fork keeps the process server alive");
	await emit(second, "session_shutdown", { reason: "quit" }, tuiContext);
	await assert.rejects(fetch(expectedUrl));

	await second.commands.get("workflow-dashboard").handler("", tuiContext);
	assert.equal((await fetch(expectedUrl)).status, 200, "the next presentation restores the stable URL");
	await emit(second, "session_shutdown", { reason: "reload" }, tuiContext);
	await assert.rejects(fetch(expectedUrl));

	const invalidAgentDirectory = join(temporaryRoot, "invalid-agent");
	const invalidConfigDirectory = join(invalidAgentDirectory, "implementation-workflow");
	await mkdir(invalidConfigDirectory, { recursive: true });
	await writeFile(join(invalidConfigDirectory, "config.toml"), "[invalid toml\n", "utf8");
	process.env.PI_CODING_AGENT_DIR = invalidAgentDirectory;
	const invalidConfigHarness = createHarness();
	activeNotifications = invalidConfigHarness.notifications;
	await invalidConfigHarness.commands.get("workflow-plan").handler("", context([]));
	assert.match(invalidConfigHarness.notifications.at(-1).message, /Could not configure.*implementation-workflow.*config\.toml/i);
	assert.equal(invalidConfigHarness.notifications.at(-1).level, "error");
	await emit(invalidConfigHarness, "session_shutdown", { reason: "quit" }, context([]));

	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /xdg-open|pathToFileURL|\/c["']\s*,\s*["']start/i);
	console.log("Dashboard-notification test passed: links replace browser launches, deduplicate automatically, and survive session switches.");
} finally {
	resetCapabilitiesCache();
	await rm(temporaryRoot, { recursive: true, force: true });
}
