export const PLAN_TITLE = "# Implementation plan";

export function planningCompletionError(plan: string, description: string): string | undefined {
	if (!plan.trim() || plan.trim() === PLAN_TITLE) return "The plan is empty.";
	if (!description.trim()) {
		return "The plan description is empty. Use workflow_update_plan to set it before advancing to implementation.";
	}
	return undefined;
}
