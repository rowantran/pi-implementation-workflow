import { parsePlannedChanges, parseTestingCriteria } from "./planned-changes.ts";

export const PLAN_TITLE = "# Implementation plan";

export function planningCompletionError(plan: string, description: string): string | undefined {
	if (!plan.trim() || plan.trim() === PLAN_TITLE) return "The plan is empty.";
	if (!description.trim()) {
		return "The plan description is empty. Use workflow_update_plan to set it before advancing to implementation.";
	}
	try {
		parsePlannedChanges(plan);
		parseTestingCriteria(plan);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `The plan cannot advance: ${detail}.`;
	}
	return undefined;
}
