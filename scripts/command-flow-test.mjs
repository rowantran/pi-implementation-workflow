import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const workflowModule = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname);
const implementationWorkflow = workflowModule.default;

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function scenario({ args = "", editorResult, afterFirstStart } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-command-"));
	const agentDir = join(root, "agent");
	const repositoryRoot = join(root, "repository");
	const gitCommonDir = join(repositoryRoot, ".git");
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const commands = new Map();
	const events = new Map();
	const editorCalls = [];
	const notifications = [];
	const phaseEntries = [];
	const sentMessages = [];
	let activeTools = ["read", "edit", "write"];
	let editorValue = editorResult;
	let kickoffAssertion;

	const pi = {
		appendEntry(type, data) {
			if (type === "implementation-workflow-phase") phaseEntries.push(data);
		},
		exec: async (command, commandArgs) => {
			assert.equal(command, "git");
			if (commandArgs.includes("--show-toplevel")) return { code: 0, stdout: `${repositoryRoot}\n`, stderr: "" };
			if (commandArgs.includes("--git-common-dir")) return { code: 0, stdout: `${gitCommonDir}\n`, stderr: "" };
			throw new Error(`Unexpected command: ${command} ${commandArgs.join(" ")}`);
		},
		getActiveTools: () => [...activeTools],
		on(name, handler) {
			events.set(name, handler);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerEntryRenderer() {},
		registerShortcut() {},
		registerTool() {},
		sendUserMessage(message) {
			kickoffAssertion?.(message);
			sentMessages.push(message);
		},
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		setSessionName() {},
	};
	implementationWorkflow(pi);

	const ctx = {
		cwd: repositoryRoot,
		mode: "rpc",
		sessionManager: { getSessionId: () => "command-session" },
		ui: {
			editor: async (title, prefill) => {
				editorCalls.push({ title, prefill });
				return editorValue;
			},
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			theme: { fg: (_color, text) => text },
		},
		waitForIdle: async () => {},
	};

	const draftRoot = join(agentDir, "workflows", ".drafts", "command-session");
	kickoffAssertion = (message) => {
		assert.equal(phaseEntries.at(-1)?.phase, "planning", "phase must activate before kickoff");
		assert.ok(sentMessages.length === 0, "kickoff must be the first injected message");
		assert.ok(existsSync(join(draftRoot, "metadata.json")), "metadata must exist before kickoff");
		assert.ok(message.includes(editorValue), "kickoff must contain the submitted ask verbatim");
	};

	try {
		await commands.get("workflow-plan").handler(args, ctx);
		if (afterFirstStart) {
			kickoffAssertion = undefined;
			await afterFirstStart({
				ctx,
				command: commands.get("workflow-plan"),
				editorCalls,
				notifications,
				phaseEntries,
				sentMessages,
				setEditorResult(value) {
					editorValue = value;
				},
			});
		}
		return {
			agentDir,
			draftRoot,
			editorCalls,
			notifications,
			phaseEntries,
			sentMessages,
			metadata: (await exists(join(draftRoot, "metadata.json")))
				? JSON.parse(await readFile(join(draftRoot, "metadata.json"), "utf8"))
				: undefined,
			plan: (await exists(join(draftRoot, "plan.md")))
				? await readFile(join(draftRoot, "plan.md"), "utf8")
				: undefined,
		};
	} finally {
		await events.get("session_shutdown")?.();
		await rm(root, { recursive: true, force: true });
	}
}

const cancelled = await scenario({ args: "prefill", editorResult: undefined });
assert.deepEqual(cancelled.editorCalls.map((call) => call.prefill), ["prefill"]);
assert.equal(cancelled.metadata, undefined);
assert.equal(cancelled.phaseEntries.length, 0);
assert.equal(cancelled.sentMessages.length, 0);
assert.match(cancelled.notifications.at(-1).message, /Planning did not start/);

const empty = await scenario({ editorResult: "" });
assert.equal(empty.editorCalls[0].prefill, "");
assert.equal(empty.metadata, undefined);
assert.equal(empty.phaseEntries.length, 0);
assert.equal(empty.sentMessages.length, 0);

const blank = await scenario({ editorResult: " \n\t " });
assert.equal(blank.editorCalls[0].prefill, "");
assert.equal(blank.metadata, undefined);
assert.equal(blank.phaseEntries.length, 0);
assert.equal(blank.sentMessages.length, 0);

const fromEmptyEditor = await scenario({ editorResult: "Ask typed into the empty editor" });
assert.equal(fromEmptyEditor.editorCalls[0].prefill, "");
assert.equal(fromEmptyEditor.metadata.ask, "Ask typed into the empty editor");

const protectedFiles = {
	plan: "/workflow/plan.md",
	metadata: "/workflow/metadata.json",
};
assert.match(
	workflowModule.workflowWriteBlockReason("implementation", protectedFiles, protectedFiles.metadata),
	/original ask/,
);
assert.match(
	workflowModule.workflowWriteBlockReason("review", protectedFiles, protectedFiles.plan),
	/frozen and read-only/,
);
assert.equal(
	workflowModule.workflowWriteBlockReason("implementation", protectedFiles, "/worktree/src/index.ts"),
	undefined,
);

const submittedAsk = 'First line\n\nSecond <line> & "quotes".\n';
const started = await scenario({ args: "inline prefill", editorResult: submittedAsk });
assert.equal(started.editorCalls[0].prefill, "inline prefill");
assert.equal(started.metadata.ask, submittedAsk);
assert.equal(started.plan, "# Implementation plan\n");
assert.ok(!started.plan.includes(submittedAsk));
assert.equal(started.phaseEntries.length, 1);
assert.equal(started.sentMessages.length, 1);

await scenario({
	editorResult: "Start once",
	afterFirstStart: async ({ command, ctx, editorCalls, phaseEntries, sentMessages, notifications }) => {
		await command.handler("do not prefill", ctx);
		assert.equal(editorCalls.length, 1, "an active planning session must not reopen the editor");
		assert.equal(phaseEntries.length, 1, "an active planning session must not append another phase");
		assert.equal(sentMessages.length, 1, "an active planning session must not inject a continuation message");
		assert.match(notifications.at(-1).message, /Continue planning through normal conversation/);
	},
});

console.log("Command-flow test passed: the required editor captures one immutable ask before planning activation and kickoff.");
