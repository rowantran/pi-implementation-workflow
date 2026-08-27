import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function scenario({ args = "", editorResult, planningModel, planningThinkingLevel, afterFirstStart } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-command-"));
	const agentDir = join(root, "agent");
	const repositoryRoot = join(root, "repository");
	const gitCommonDir = join(repositoryRoot, ".git");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (planningModel || planningThinkingLevel) {
		const configDirectory = join(agentDir, "implementation-workflow");
		await mkdir(configDirectory, { recursive: true });
		const modelConfig = planningModel
			? `provider = ${JSON.stringify(planningModel.provider)}\nmodel = ${JSON.stringify(planningModel.model)}\n`
			: "";
		const thinkingConfig = planningThinkingLevel
			? `thinking_level = ${JSON.stringify(planningThinkingLevel)}\n`
			: "";
		await writeFile(
			join(configDirectory, "config.toml"),
			`[models.planning]\n${modelConfig}${thinkingConfig}`,
			"utf8",
		);
	}

	const commands = new Map();
	const events = new Map();
	const tools = new Map();
	const editorCalls = [];
	const notifications = [];
	const phaseEntries = [];
	const sentMessages = [];
	const selectedModels = [];
	const selectedThinkingLevels = [];
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
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		sendUserMessage(message) {
			kickoffAssertion?.(message);
			sentMessages.push(message);
		},
		setActiveTools(tools) {
			activeTools = [...tools];
		},
		async setModel(model) {
			selectedModels.push(model);
			return true;
		},
		setThinkingLevel(level) {
			selectedThinkingLevels.push(level);
		},
		setSessionName() {},
	};
	implementationWorkflow(pi);

	const ctx = {
		cwd: repositoryRoot,
		mode: "rpc",
		model: { provider: "default", id: "default-model" },
		modelRegistry: {
			find(provider, model) {
				return planningModel && provider === planningModel.provider && model === planningModel.model
					? { provider, id: model }
					: undefined;
			},
		},
		sessionManager: { getSessionId: () => "command-session" },
		ui: {
			editor: async (title, prefill) => {
				editorCalls.push({ title, prefill });
				return editorValue;
			},
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
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
				implementCommand: commands.get("workflow-implement"),
				editorCalls,
				notifications,
				phaseEntries,
				sentMessages,
				draftRoot,
				tools,
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
			workingPlan: (await exists(join(draftRoot, "working-plan.md")))
				? await readFile(join(draftRoot, "working-plan.md"), "utf8")
				: undefined,
			activeTools,
			selectedModels,
			selectedThinkingLevels,
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

const modelOverride = await scenario({
	editorResult: "Plan with the configured Isara model",
	planningModel: { provider: "isara", model: "anthropic/claude-opus:planning" },
	planningThinkingLevel: "high",
});
assert.deepEqual(modelOverride.selectedModels, [
	{ provider: "isara", id: "anthropic/claude-opus:planning" },
]);
assert.deepEqual(modelOverride.selectedThinkingLevels, ["high"]);

const thinkingOnlyOverride = await scenario({
	editorResult: "Plan with the current model at maximum thinking",
	planningThinkingLevel: "max",
});
assert.deepEqual(thinkingOnlyOverride.selectedModels, []);
assert.deepEqual(thinkingOnlyOverride.selectedThinkingLevels, ["max"]);

const protectedFiles = {
	plan: "/workflow/plan.md",
	workingPlan: "/workflow/working-plan.md",
	metadata: "/workflow/metadata.json",
};
assert.equal(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, protectedFiles.workingPlan),
	undefined,
);
assert.match(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, protectedFiles.plan),
	/only change.*working-plan\.md/,
);
assert.match(
	workflowModule.workflowWriteBlockReason("planning", protectedFiles, "/repository/src/index.ts"),
	/only change.*working-plan\.md/,
);
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
assert.equal(started.workingPlan, started.plan);
assert.ok(started.activeTools.includes("edit"));
assert.ok(started.activeTools.includes("write"));
assert.ok(!started.plan.includes(submittedAsk));
assert.equal(started.phaseEntries.length, 1);
assert.equal(started.sentMessages.length, 1);

await scenario({
	editorResult: "Leave a working plan uncommitted",
	afterFirstStart: async ({ ctx, draftRoot, implementCommand, notifications }) => {
		await writeFile(join(draftRoot, "working-plan.md"), "# Implementation plan\n\nUncommitted.\n", "utf8");
		await implementCommand.handler("", ctx);
		assert.match(notifications.at(-1).message, /working plan has uncommitted changes/);
	},
});

await scenario({
	editorResult: "Commit a working plan",
	afterFirstStart: async ({ draftRoot, tools }) => {
		const updatePlan = tools.get("workflow_update_plan");
		assert.ok(updatePlan);
		assert.equal(updatePlan.parameters.properties.plan, undefined);
		assert.ok(updatePlan.parameters.properties.description);

		const updatedPlan = "# Implementation plan\n\n## Scope\n\nCommit the working plan.\n";
		await writeFile(join(draftRoot, "working-plan.md"), updatedPlan, "utf8");
		const result = await updatePlan.execute("update-plan", {
			description: "Commit the editable working plan",
		});
		assert.equal(result.details.version, 2);
		assert.equal(await readFile(join(draftRoot, "plan.md"), "utf8"), updatedPlan);
		assert.equal(await readFile(join(draftRoot, "working-plan.md"), "utf8"), updatedPlan);
		assert.equal(await readFile(join(draftRoot, "versions", "0002.md"), "utf8"), updatedPlan);
		assert.deepEqual((await readdir(join(draftRoot, "versions"))).sort(), ["0001.md", "0002.md"]);
	},
});

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
