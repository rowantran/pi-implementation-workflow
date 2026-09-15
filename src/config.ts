import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { isRecord } from "./plan.ts";

export const PHASES = ["planning", "implementing", "reviewing"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_DASHBOARD_PORT = 43121;

export type Phase = (typeof PHASES)[number];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelOverride {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface DashboardConfig {
	listenHost: string;
	listenPort: number;
	/** Base URL shown to the user, without a trailing slash. */
	publicBaseUrl: string;
}

export interface WorkflowConfig {
	configPath: string;
	models: Partial<Record<Phase, ModelOverride>>;
	dashboard: DashboardConfig;
}

export function configPath(agentDirectory: string): string {
	return resolve(agentDirectory, "implementation-workflow", "config.toml");
}

/**
 * Optional TOML at ~/.pi/agent/implementation-workflow/config.toml:
 *
 *   [models.planning]      # also implementing, reviewing
 *   provider = "anthropic"
 *   model = "claude-opus-4"
 *   thinking_level = "high"
 *
 *   [dashboard]
 *   listen_host = "0.0.0.0"          # default 127.0.0.1
 *   listen_port = 43121
 *   public_base_url = "http://devbox:43121"
 */
export async function loadConfig(agentDirectory: string): Promise<WorkflowConfig> {
	const path = configPath(agentDirectory);
	const fallback: WorkflowConfig = {
		configPath: path,
		models: {},
		dashboard: { listenHost: "127.0.0.1", listenPort: DEFAULT_DASHBOARD_PORT, publicBaseUrl: `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}` },
	};
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
	const fail: (message: string) => never = (message) => { throw new Error(`${message} (${path})`); };
	let document: unknown;
	try {
		document = parse(text);
	} catch (error) {
		return fail(`Configuration is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(document)) return fail("Configuration must be a TOML document");
	for (const key of Object.keys(document)) if (key !== "models" && key !== "dashboard") fail(`Unknown configuration field ${key}`);

	const models: WorkflowConfig["models"] = {};
	if (document.models !== undefined) {
		if (!isRecord(document.models)) fail("models must be a table");
		for (const [phase, value] of Object.entries(document.models)) {
			if (!PHASES.includes(phase as Phase)) fail(`models.${phase} is not one of ${PHASES.join(", ")}`);
			if (!isRecord(value)) fail(`models.${phase} must be a table`);
			for (const key of Object.keys(value)) if (!["provider", "model", "thinking_level"].includes(key)) fail(`Unknown field models.${phase}.${key}`);
			const override: ModelOverride = {};
			if (value.provider !== undefined || value.model !== undefined) {
				if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.model !== "string" || !value.model.trim()) {
					fail(`models.${phase} needs both provider and model as nonempty strings`);
				}
				override.provider = (value.provider as string).trim();
				override.model = (value.model as string).trim();
			}
			if (value.thinking_level !== undefined) {
				if (!THINKING_LEVELS.includes(value.thinking_level as ThinkingLevel)) fail(`models.${phase}.thinking_level must be one of ${THINKING_LEVELS.join(", ")}`);
				override.thinkingLevel = value.thinking_level as ThinkingLevel;
			}
			if (!override.model && !override.thinkingLevel) fail(`models.${phase} must set a model or thinking_level`);
			models[phase as Phase] = override;
		}
	}

	const dashboard = { ...fallback.dashboard };
	if (document.dashboard !== undefined) {
		const value: unknown = document.dashboard;
		if (!isRecord(value)) fail("dashboard must be a table");
		for (const key of Object.keys(value)) if (!["listen_host", "listen_port", "public_base_url"].includes(key)) fail(`Unknown field dashboard.${key}`);
		if (value.listen_port !== undefined) {
			if (!Number.isInteger(value.listen_port) || (value.listen_port as number) < 1 || (value.listen_port as number) > 65535) fail("dashboard.listen_port must be a TCP port");
			dashboard.listenPort = value.listen_port as number;
		}
		if (value.listen_host !== undefined) {
			if (typeof value.listen_host !== "string" || !value.listen_host.trim()) fail("dashboard.listen_host must be a nonempty string");
			dashboard.listenHost = value.listen_host.trim();
		}
		dashboard.publicBaseUrl = `http://${dashboard.listenHost === "0.0.0.0" || dashboard.listenHost === "::" ? "127.0.0.1" : dashboard.listenHost}:${dashboard.listenPort}`;
		if (value.public_base_url !== undefined) {
			if (typeof value.public_base_url !== "string" || !/^https?:\/\/[^\s?#]+$/.test(value.public_base_url)) fail("dashboard.public_base_url must be an http(s) URL without query or fragment");
			dashboard.publicBaseUrl = value.public_base_url.replace(/\/+$/, "");
		}
	}
	return { configPath: path, models, dashboard };
}
