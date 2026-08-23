import { readFileSync } from "node:fs";
import Mustache from "mustache";

const CONTINUE_PLANNING_USER_TEMPLATE = loadTemplate("injected-user-messages/continue-planning.md");
const IMPLEMENTATION_SYSTEM_TEMPLATE = loadTemplate("system/implementation.md");
const IMPLEMENTATION_USER_TEMPLATE = loadTemplate("injected-user-messages/implementation.md");
const PLAN_SLUG_SYSTEM_TEMPLATE = loadTemplate("system/plan-slug.md");
const PLAN_SLUG_USER_TEMPLATE = loadTemplate("injected-user-messages/plan-slug.md");
const PLANNING_SYSTEM_TEMPLATE = loadTemplate("system/planning.md");
const START_PLANNING_USER_TEMPLATE = loadTemplate("injected-user-messages/start-planning.md");
const REVIEW_SYSTEM_TEMPLATE = loadTemplate("system/review.md");
const REVIEW_USER_TEMPLATE = loadTemplate("injected-user-messages/review.md");
const UPDATE_PLAN_TOOL_GUIDELINE = loadTemplate("system/update-plan-tool-guideline.md");
const UPDATE_PLAN_TOOL_SNIPPET = loadTemplate("system/update-plan-tool-snippet.md");

export function continuePlanningUserMessage(issue: string): string {
	return render(CONTINUE_PLANNING_USER_TEMPLATE, { issue });
}

export function implementationSystemPrompt(values: {
	identifier: string | undefined;
	planPath: string;
	questionTool: string;
	baseBranch: string | undefined;
}): string {
	return render(IMPLEMENTATION_SYSTEM_TEMPLATE, stringifyUndefined(values));
}

export function implementationUserMessage(values: {
	planPath: string;
	worktreePath: string;
	workflowBranch: string;
	baseBranch: string;
}): string {
	return render(IMPLEMENTATION_USER_TEMPLATE, values);
}

export function planSlugSystemPrompt(): string {
	return PLAN_SLUG_SYSTEM_TEMPLATE;
}

export function planSlugUserMessage(plan: string): string {
	return render(PLAN_SLUG_USER_TEMPLATE, { plan });
}

export function planningSystemPrompt(values: { planPath: string; updatePlanTool: string }): string {
	return render(PLANNING_SYSTEM_TEMPLATE, values);
}

export function startPlanningUserMessage(issue: string): string {
	return render(START_PLANNING_USER_TEMPLATE, { issue });
}

export function reviewSystemPrompt(values: {
	identifier: string | undefined;
	pullRequestUrl: string | undefined;
	planPath: string;
}): string {
	return render(REVIEW_SYSTEM_TEMPLATE, stringifyUndefined(values));
}

export function reviewUserMessage(values: { pullRequestUrl: string; planPath: string }): string {
	return render(REVIEW_USER_TEMPLATE, values);
}

export function updatePlanToolPromptGuidelines(): string[] {
	return [UPDATE_PLAN_TOOL_GUIDELINE];
}

export function updatePlanToolPromptSnippet(): string {
	return UPDATE_PLAN_TOOL_SNIPPET;
}

function loadTemplate(name: string): string {
	return readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();
}

function render(template: string, values: Record<string, unknown>): string {
	return Mustache.render(template, values);
}

function stringifyUndefined<T extends Record<string, unknown>>(values: T): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, value === undefined ? "undefined" : value]),
	);
}
