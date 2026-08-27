import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { updatePlanToolPromptGuidelines, updatePlanToolPromptSnippet } from "./prompts.ts";

export const WORKFLOW_UPDATE_PLAN_TOOL = "workflow_update_plan";

interface UpdatePlanResult {
	version: number;
}

const Parameters = Type.Object({
	description: Type.String({
		maxLength: 160,
		description:
			"A concise plain-English description of the entire plan as it now stands, in one sentence or sentence fragment of at most 18 words. Note: This title summarizes the whole plan, not just the latest edit",
	}),
});

export function registerWorkflowPlanTool(
	pi: ExtensionAPI,
	onUpdate: (description: string) => Promise<UpdatePlanResult>,
): void {
	pi.registerTool({
		name: WORKFLOW_UPDATE_PLAN_TOOL,
		label: "Update Plan",
		description:
			"Commit working-plan.md as the persistent implementation plan with its concise plain-English description and a new numbered version. Use this for every plan change during workflow planning.",
		promptSnippet: updatePlanToolPromptSnippet(),
		promptGuidelines: updatePlanToolPromptGuidelines(),
		parameters: Parameters,
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			const result = await onUpdate(params.description);
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
