import { readFileSync } from "node:fs";
import Mustache from "mustache";

const IMPLEMENTATION_SYSTEM_TEMPLATE = loadTemplate("system/implementation.md");
const IMPLEMENTATION_USER_TEMPLATE = loadTemplate("injected-user-messages/implementation.md");
const PLAN_SLUG_SYSTEM_TEMPLATE = loadTemplate("system/plan-slug.md");
const PLAN_SLUG_USER_TEMPLATE = loadTemplate("injected-user-messages/plan-slug.md");
const PLANNING_SYSTEM_TEMPLATE = loadTemplate("system/planning.md");
const START_PLANNING_USER_TEMPLATE = loadTemplate("injected-user-messages/start-planning.md");
const REVIEW_SYSTEM_TEMPLATE = loadTemplate("system/review.md");
const REVIEW_AGENT_SYSTEM_TEMPLATE = loadTemplate("system/review-agent.md");
const REVIEW_PLANNED_CHANGE_TEMPLATE = loadTemplate("system/review-planned-change.md");
const REVIEW_PLAN_AUDIT_TEMPLATE = loadTemplate("system/review-plan-audit.md");
const REVIEW_TESTING_CRITERIA_TEMPLATE = loadTemplate("system/review-testing-criteria.md");
const REVIEW_SYNTHESIS_TEMPLATE = loadTemplate("system/review-synthesis.md");
const REVIEW_AGENT_USER_TEMPLATE = loadTemplate("injected-user-messages/review-agent.md");
const REVISION_SYSTEM_TEMPLATE = loadTemplate("system/revision.md");
const REVISION_USER_TEMPLATE = loadTemplate("injected-user-messages/revision.md");
const UPDATE_PLAN_TOOL_GUIDELINE = loadTemplate("system/update-plan-tool-guideline.md");
const UPDATE_PLAN_TOOL_SNIPPET = loadTemplate("system/update-plan-tool-snippet.md");

export function implementationSystemPrompt(values: {
	identifier: string | undefined;
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
	questionTool: string;
	worktreePath: string;
	workflowBranch: string;
	baseBranch: string | undefined;
}): string {
	return render(IMPLEMENTATION_SYSTEM_TEMPLATE, stringifyUndefined(values));
}

export function implementationUserMessage(values: {
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
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

export function planningSystemPrompt(values: {
	planPath: string;
	workingPlanPath: string;
	updatePlanTool: string;
}): string {
	return render(PLANNING_SYSTEM_TEMPLATE, values);
}

export function startPlanningUserMessage(ask: string): string {
	return render(START_PLANNING_USER_TEMPLATE, { ask });
}

export function reviewSystemPrompt(values: {
	identifier: string | undefined;
	pullRequestUrl: string | undefined;
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
	reviewPath: string;
	reviewMarkdownPath: string;
}): string {
	return render(REVIEW_SYSTEM_TEMPLATE, stringifyUndefined(values));
}

export function revisionSystemPrompt(values: {
	identifier: string | undefined;
	reviewRound: number | undefined;
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
	reviewPath: string;
	questionTool: string;
	worktreePath: string;
	workflowBranch: string;
	baseBranch: string;
}): string {
	return render(REVISION_SYSTEM_TEMPLATE, stringifyUndefined(values));
}

export function revisionUserMessage(values: { request: string; reviewPath: string }): string {
	return render(REVISION_USER_TEMPLATE, values);
}

export function reviewAgentSystemPrompt(outputTool: string): string {
	return render(REVIEW_AGENT_SYSTEM_TEMPLATE, { outputTool });
}

export function plannedChangeReviewPrompt(values: {
	id: string;
	title: string;
	content: string;
	metadataPath: string;
	clarificationsPath: string;
	planPath: string;
	baseCommit: string;
	headCommit: string;
	pullRequestUrl: string;
}): string {
	return render(REVIEW_PLANNED_CHANGE_TEMPLATE, values);
}

export function planAuditReviewPrompt(values: {
	metadataPath: string;
	clarificationsPath: string;
	planPath: string;
	baseCommit: string;
	headCommit: string;
	pullRequestUrl: string;
	plannedChanges: string;
}): string {
	return render(REVIEW_PLAN_AUDIT_TEMPLATE, values);
}

export function testingCriteriaReviewPrompt(values: {
	testingCriteria: string;
	metadataPath: string;
	clarificationsPath: string;
	planPath: string;
	baseCommit: string;
	headCommit: string;
	pullRequestUrl: string;
}): string {
	return render(REVIEW_TESTING_CRITERIA_TEMPLATE, values);
}

export function reviewSynthesisPrompt(values: {
	pullRequestUrl: string;
	baseCommit: string;
	headCommit: string;
	plannedChangeReviews: string;
	planAudit: string;
	testingCriteriaReview: string;
	outputTool: string;
}): string {
	return render(REVIEW_SYNTHESIS_TEMPLATE, values);
}

export function reviewAgentUserMessage(values: { role: string; outputTool: string }): string {
	return render(REVIEW_AGENT_USER_TEMPLATE, values);
}

export function updatePlanToolPromptGuidelines(): string[] {
	return [UPDATE_PLAN_TOOL_GUIDELINE];
}

export function updatePlanToolPromptSnippet(): string {
	return UPDATE_PLAN_TOOL_SNIPPET;
}

function loadTemplate(name: string): string {
	const source = readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8");
	return stripHtmlComments(source, name).trim();
}

export function stripHtmlComments(template: string, name = "<inline template>"): string {
	let result = "";
	let cursor = 0;

	while (cursor < template.length) {
		const opening = template.indexOf("<!--", cursor);
		const closing = template.indexOf("-->", cursor);
		if (closing !== -1 && (opening === -1 || closing < opening)) {
			throw new Error(
				`Malformed HTML comment in prompt template "${name}": found closing marker "-->" without an opening marker.`,
			);
		}
		if (opening === -1) {
			result += template.slice(cursor);
			break;
		}

		result += template.slice(cursor, opening);
		const commentClosing = template.indexOf("-->", opening + 4);
		if (commentClosing === -1) {
			throw new Error(
				`Malformed HTML comment in prompt template "${name}": opening marker "<!--" is unterminated.`,
			);
		}
		const nestedOpening = template.indexOf("<!--", opening + 4);
		if (nestedOpening !== -1 && nestedOpening < commentClosing) {
			throw new Error(
				`Malformed HTML comment in prompt template "${name}": found a nested opening marker "<!--".`,
			);
		}
		cursor = commentClosing + 3;
	}

	return result;
}

function render(template: string, values: Record<string, unknown>): string {
	return Mustache.render(template, values);
}

function stringifyUndefined<T extends Record<string, unknown>>(values: T): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, value === undefined ? "undefined" : value]),
	);
}
