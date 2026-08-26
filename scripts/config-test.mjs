import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const configModule = await jiti.import(new URL("../src/config.ts", import.meta.url).pathname);
const workflowModule = await jiti.import(new URL("../src/index.ts", import.meta.url).pathname);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-config-"));

async function writeConfig(agentDirectory, content) {
	const directory = join(agentDirectory, "implementation-workflow");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.toml"), content, "utf8");
}

try {
	const emptyAgentDirectory = join(temporaryRoot, "empty-agent");
	const empty = await configModule.loadImplementationWorkflowConfig(emptyAgentDirectory);
	assert.equal(empty.configPath, join(emptyAgentDirectory, "implementation-workflow", "config.toml"));
	assert.deepEqual(empty.models, {});
	assert.equal(empty.dashboard, undefined);

	const configuredAgentDirectory = join(temporaryRoot, "configured-agent");
	await writeConfig(configuredAgentDirectory, `
[dashboard]
mode = "remote"
public_base_url = "http://devbox:43121"
listen_port = 43121
listen_host = "0.0.0.0"

[models.planning]
provider = "isara"
model = "anthropic/claude-opus:planning"

[models.implementing]
provider = "openai-codex"
model = "gpt-5.4"

[models.reviewing]
provider = "isara-review"
model = "openai/gpt-5.4:review"

[models.revising]
provider = "anthropic"
model = "claude-opus-4-6"
`);
	const configured = await configModule.loadImplementationWorkflowConfig(configuredAgentDirectory);
	assert.deepEqual(configured.models, {
		planning: { provider: "isara", model: "anthropic/claude-opus:planning" },
		implementing: { provider: "openai-codex", model: "gpt-5.4" },
		reviewing: { provider: "isara-review", model: "openai/gpt-5.4:review" },
		revising: { provider: "anthropic", model: "claude-opus-4-6" },
	});
	assert.equal(configured.dashboard.public_base_url, "http://devbox:43121");

	assert.deepEqual(
		["planning", "implementation", "review", "revision", "cleanup", "complete", undefined].map(
			workflowModule.phaseModelOverrideName,
		),
		["planning", "implementing", "reviewing", "revising", undefined, undefined, undefined],
	);

	const unknownPhaseAgentDirectory = join(temporaryRoot, "unknown-phase-agent");
	await writeConfig(unknownPhaseAgentDirectory, `[models.review]\nprovider = "isara"\nmodel = "reviewer"\n`);
	await assert.rejects(
		configModule.loadImplementationWorkflowConfig(unknownPhaseAgentDirectory),
		/Unknown model override phase review; expected planning, implementing, reviewing, or revising/,
	);

	const incompleteAgentDirectory = join(temporaryRoot, "incomplete-agent");
	await writeConfig(incompleteAgentDirectory, `[models.planning]\nmodel = "planner"\n`);
	await assert.rejects(
		configModule.loadImplementationWorkflowConfig(incompleteAgentDirectory),
		/models\.planning\.provider must be a non-empty string/,
	);

	const malformedAgentDirectory = join(temporaryRoot, "malformed-agent");
	await writeConfig(malformedAgentDirectory, "[models.planning\n");
	await assert.rejects(
		configModule.loadImplementationWorkflowConfig(malformedAgentDirectory),
		/not valid TOML/,
	);

	const legacyAgentDirectory = join(temporaryRoot, "legacy-agent");
	await mkdir(legacyAgentDirectory, { recursive: true });
	await writeFile(join(legacyAgentDirectory, "implementation-workflow.json"), "{}\n", "utf8");
	await assert.rejects(
		configModule.loadImplementationWorkflowConfig(legacyAgentDirectory),
		/legacy JSON configuration.*implementation-workflow\.json.*implementation-workflow.*config\.toml/is,
	);

	console.log("Config test passed: TOML parsing, phase model references, strict phase names, and legacy migration errors work.");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
