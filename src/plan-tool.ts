import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const WORKFLOW_UPDATE_PLAN_TOOL = "workflow_update_plan";

interface UpdatePlanResult {
	version: number;
}

const Parameters = Type.Object({
	description: Type.String({
		maxLength: 160,
		description: "A concise plain-English description of the plan in one sentence or sentence fragment of at most 18 words",
	}),
	plan: Type.String({
		description: "The complete updated implementation plan in Markdown. This replaces plan.md and creates a new numbered version.",
	}),
});

export function registerWorkflowPlanTool(
	pi: ExtensionAPI,
	onUpdate: (plan: string, description: string) => Promise<UpdatePlanResult>,
): void {
	pi.registerTool({
		name: WORKFLOW_UPDATE_PLAN_TOOL,
		label: "Update Plan",
		description:
			"Replace the persistent implementation plan and its concise plain-English description, then save a new numbered plan version. Use this for every plan change during workflow planning.",
		promptSnippet: "Update the persistent workflow plan, its English description, and its numbered version",
		promptGuidelines: [
			"Use workflow_update_plan for every implementation-plan change during workflow planning; provide the complete updated Markdown plan and a one-sentence-or-less English description.",
		],
		parameters: Parameters,
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			const result = await onUpdate(params.plan, params.description);
			return {
				content: [{ type: "text", text: `Saved implementation plan version ${result.version}.` }],
				details: result,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("update implementation plan")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as UpdatePlanResult | undefined;
			if (!details) return new Text(theme.fg("error", "Plan update failed"), 0, 0);
			return new Text(theme.fg("success", `Saved version ${details.version}`), 0, 0);
		},
	});
}
