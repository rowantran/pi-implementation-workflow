import { readFileSync } from "node:fs";
import Mustache from "mustache";
import { parse } from "smol-toml";

/**
 * Everything the model reads lives under src/prompts/: phase system prompts and
 * kickoff messages as Markdown, and all shorter strings (tool metadata, tool
 * results and errors, blocked-tool reasons) in strings.toml.
 */
export type PromptName = "planning" | "implementation" | "review" | "slug" | "kickoff-planning" | "kickoff-implementation" | "kickoff-review";

const cache = new Map<string, string>();
let strings: Record<string, unknown> | undefined;

function template(name: string): string {
	let text = cache.get(name);
	if (text === undefined) {
		text = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
		cache.set(name, text);
	}
	return text;
}

export function renderPrompt(name: PromptName, values: Record<string, unknown>): string {
	return Mustache.render(template(name), values);
}

/** Phase system prompts: the role text followed by the shared description of workflow files. */
export function phaseSystemPrompt(name: "planning" | "implementation" | "review", values: Record<string, unknown>): string {
	return `${Mustache.render(template(name), values)}\n\n${Mustache.render(template("shared"), values)}`;
}

/** A string from strings.toml by dotted key, rendered with Mustache. */
export function text(key: string, values: Record<string, unknown> = {}): string {
	strings ??= parse(readFileSync(new URL("./prompts/strings.toml", import.meta.url), "utf8"));
	let current: unknown = strings;
	for (const part of key.split(".")) current = (current as Record<string, unknown> | undefined)?.[part];
	if (typeof current !== "string") throw new Error(`Missing prompt string: ${key}`);
	return Mustache.render(current, values).trimEnd();
}

export const bulletList = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");
