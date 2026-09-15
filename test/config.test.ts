import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { temporaryDirectory } from "./helpers.ts";

async function withConfig(toml: string | undefined) {
	const agent = await temporaryDirectory();
	if (toml !== undefined) {
		await mkdir(join(agent, "implementation-workflow"), { recursive: true });
		await writeFile(join(agent, "implementation-workflow", "config.toml"), toml);
	}
	try {
		return await loadConfig(agent);
	} finally {
		await rm(agent, { recursive: true, force: true });
	}
}

test("defaults without a file", async () => {
	const config = await withConfig(undefined);
	assert.deepEqual(config.models, {});
	assert.deepEqual(config.dashboard, { listenHost: "127.0.0.1", listenPort: 43121, publicBaseUrl: "http://127.0.0.1:43121" });
});

test("parses model overrides and remote dashboard settings", async () => {
	const config = await withConfig(`
[models.planning]
provider = "anthropic"
model = "claude-opus-4"
thinking_level = "high"

[models.reviewing]
thinking_level = "max"

[dashboard]
listen_host = "0.0.0.0"
listen_port = 5000
public_base_url = "http://devbox:5000/"
`);
	assert.deepEqual(config.models.planning, { provider: "anthropic", model: "claude-opus-4", thinkingLevel: "high" });
	assert.deepEqual(config.models.reviewing, { thinkingLevel: "max" });
	assert.equal(config.models.implementing, undefined);
	assert.deepEqual(config.dashboard, { listenHost: "0.0.0.0", listenPort: 5000, publicBaseUrl: "http://devbox:5000" });
});

test("rejects unknown and malformed fields", async () => {
	await assert.rejects(withConfig("[models.revising]\nthinking_level = 'low'\n"), /models\.revising is not one of/);
	await assert.rejects(withConfig("[models.planning]\nmodel = 'x'\n"), /needs both provider and model/);
	await assert.rejects(withConfig("[dashboard]\nlisten_port = 70000\n"), /listen_port must be a TCP port/);
	await assert.rejects(withConfig("[dashboard]\npublic_base_url = 'devbox:1'\n"), /public_base_url must be an http/);
	await assert.rejects(withConfig("[other]\n"), /Unknown configuration field other/);
});
