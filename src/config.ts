import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "smol-toml";

export const MODEL_OVERRIDE_PHASES = ["planning", "implementing", "reviewing", "revising"] as const;

export type ModelOverridePhase = (typeof MODEL_OVERRIDE_PHASES)[number];

export interface WorkflowModelOverride {
	provider: string;
	model: string;
}

export interface ImplementationWorkflowConfig {
	configPath: string;
	dashboard?: Record<string, unknown>;
	models: Partial<Record<ModelOverridePhase, WorkflowModelOverride>>;
}

export function implementationWorkflowConfigDirectory(agentDirectory: string): string {
	return resolve(agentDirectory, "implementation-workflow");
}

export function implementationWorkflowConfigPath(agentDirectory: string): string {
	return resolve(implementationWorkflowConfigDirectory(agentDirectory), "config.toml");
}

export function legacyImplementationWorkflowConfigPath(agentDirectory: string): string {
	return resolve(agentDirectory, "implementation-workflow.json");
}

export async function loadImplementationWorkflowConfig(
	agentDirectory: string,
): Promise<ImplementationWorkflowConfig> {
	const configPath = implementationWorkflowConfigPath(agentDirectory);
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Could not read implementation workflow configuration ${configPath}: ${errorMessage(error)}`);
		}
		const legacyPath = legacyImplementationWorkflowConfigPath(agentDirectory);
		if (await pathExists(legacyPath)) {
			throw new Error(
				`The legacy JSON configuration ${legacyPath} is no longer supported. Move it to ${configPath} and convert it to TOML.`,
			);
		}
		return { configPath, models: {} };
	}

	let document: unknown;
	try {
		document = parse(text);
	} catch (error) {
		throw new Error(`Implementation workflow configuration is not valid TOML: ${configPath} (${errorMessage(error)})`);
	}
	if (!isRecord(document)) {
		throw new Error(`Implementation workflow configuration must contain a TOML document: ${configPath}`);
	}

	const unknownTopLevelFields = Object.keys(document).filter((key) => key !== "dashboard" && key !== "models");
	if (unknownTopLevelFields.length > 0) {
		throw new Error(
			`Unknown implementation workflow configuration field${unknownTopLevelFields.length === 1 ? "" : "s"} ${unknownTopLevelFields.join(", ")}: ${configPath}`,
		);
	}

	let dashboard: Record<string, unknown> | undefined;
	if (document.dashboard !== undefined) {
		if (!isRecord(document.dashboard)) {
			throw new Error(`dashboard must be a TOML table: ${configPath}`);
		}
		dashboard = document.dashboard;
	}

	return {
		configPath,
		dashboard,
		models: parseModelOverrides(document.models, configPath),
	};
}

function parseModelOverrides(
	value: unknown,
	configPath: string,
): Partial<Record<ModelOverridePhase, WorkflowModelOverride>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`models must be a TOML table: ${configPath}`);

	const allowedPhases = new Set<string>(MODEL_OVERRIDE_PHASES);
	const unknownPhases = Object.keys(value).filter((phase) => !allowedPhases.has(phase));
	if (unknownPhases.length > 0) {
		throw new Error(
			`Unknown model override phase${unknownPhases.length === 1 ? "" : "s"} ${unknownPhases.join(", ")}; expected planning, implementing, reviewing, or revising: ${configPath}`,
		);
	}

	const overrides: Partial<Record<ModelOverridePhase, WorkflowModelOverride>> = {};
	for (const phase of MODEL_OVERRIDE_PHASES) {
		const candidate = value[phase];
		if (candidate === undefined) continue;
		if (!isRecord(candidate)) throw new Error(`models.${phase} must be a TOML table: ${configPath}`);
		const unknownFields = Object.keys(candidate).filter((key) => key !== "provider" && key !== "model");
		if (unknownFields.length > 0) {
			throw new Error(`Unknown models.${phase} field${unknownFields.length === 1 ? "" : "s"} ${unknownFields.join(", ")}: ${configPath}`);
		}
		overrides[phase] = {
			provider: requireNonEmptyString(candidate.provider, `models.${phase}.provider`, configPath),
			model: requireNonEmptyString(candidate.model, `models.${phase}.model`, configPath),
		};
	}
	return overrides;
}

function requireNonEmptyString(value: unknown, field: string, configPath: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} must be a non-empty string: ${configPath}`);
	}
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
