import { validatePlanDocument, type PlanDocument } from "./planned-changes.ts";

export const PLAN_TITLE = "# Implementation plan";

/** Finalized directory documents, not Markdown exports, determine completion. */
export function planningCompletionError(plan: PlanDocument | undefined, description: string): string | undefined {
	if (!plan) return "No finalized plan exists. Prepare and finalize the working plan before advancing to implementation.";
	if (!description.trim()) return "The plan description is empty. Finalize the working plan with a description before advancing to implementation.";
	try {
		validatePlanDocument(plan);
	} catch (error) {
		return `The plan cannot advance: ${error instanceof Error ? error.message : String(error)}`;
	}
	return undefined;
}
