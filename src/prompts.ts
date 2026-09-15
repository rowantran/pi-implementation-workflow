import { readFileSync } from "node:fs";
import Mustache from "mustache";

export type PromptName = "planning" | "implementation" | "review" | "slug" | "kickoff-planning" | "kickoff-implementation" | "kickoff-review";

const cache = new Map<string, string>();

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
