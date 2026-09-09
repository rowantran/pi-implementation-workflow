import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { updatePlanToolPromptGuidelines, updatePlanToolPromptSnippet } from "./prompts.ts";

export const WORKFLOW_UPDATE_PLAN_TOOL = "workflow_update_plan";

export type UpdatePlanInput =
	| { action: "prepare" }
	| { action: "finalize"; description: string; expectedBaseVersion: number };

export type UpdatePlanResult =
	| { action: "prepare"; draftPath: string; baseVersion: number }
	| { action: "finalize"; version: number; dashboardUrl?: string; dashboardError?: string };

const Parameters = Type.Object({
	action: StringEnum(["prepare", "finalize"] as const, {
		description: "Prepare an editable copy of the latest plan, or validate and publish the edited draft as a new immutable version.",
	}),
	description: Type.Optional(Type.String({
		maxLength: 160,
		description: "Required for finalize: a concise English title for the entire plan, at most 18 words, not a description of the latest edit.",
	})),
	expectedBaseVersion: Type.Optional(Type.Integer({
		minimum: 0,
		description: "Required for finalize: the baseVersion returned by prepare. Zero means no plan has been finalized yet.",
	})),
}, { additionalProperties: false });

export function registerWorkflowPlanTool(
	pi: ExtensionAPI,
	onUpdate: (input: UpdatePlanInput) => Promise<UpdatePlanResult>,
): void {
	pi.registerTool({
		name: WORKFLOW_UPDATE_PLAN_TOOL,
		label: "Update Plan",
		description: "Prepare an editable plan directory, then finalize it after native edit/write calls. Finalize validates JSON metadata, required Markdown files, reading order, and dependencies before publishing a new numbered snapshot. It does not create a Git commit.",
		promptSnippet: updatePlanToolPromptSnippet(),
		promptGuidelines: updatePlanToolPromptGuidelines(),
		parameters: Parameters,
		executionMode: "sequential",

		async execute(_toolCallId, params) {
			let input: UpdatePlanInput;
			if (params.action === "prepare") {
				if (params.description !== undefined || params.expectedBaseVersion !== undefined) {
					throw new Error("prepare accepts only action; provide description and expectedBaseVersion when finalizing.");
				}
				input = { action: "prepare" };
			} else {
				if (typeof params.description !== "string" || !Number.isInteger(params.expectedBaseVersion) || params.expectedBaseVersion! < 0) {
					throw new Error("finalize requires description and the expectedBaseVersion returned by prepare.");
				}
				input = { action: "finalize", description: params.description, expectedBaseVersion: params.expectedBaseVersion! };
			}
			const result = await onUpdate(input);
			return { content: [{ type: "text", text: resultText(result) }], details: result };
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`${args.action === "prepare" ? "prepare" : "finalize"} implementation plan`)), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as UpdatePlanResult | undefined;
			if (!details) return new Text(theme.fg("error", result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "Plan update failed"), 0, 0);
			return new Text(theme.fg("success", resultText(details, true)), 0, 0);
		},
	});
}

function resultText(result: UpdatePlanResult, terminal = false): string {
	if (result.action === "prepare") {
		return `Editable plan directory: ${result.draftPath}\nBase version: ${result.baseVersion}\nEdit the draft files, then call workflow_update_plan with action=finalize, expectedBaseVersion=${result.baseVersion}, and a description of the entire plan. Existing unsaved edits are preserved.`;
	}
	const url = result.dashboardUrl;
	const dashboard = url
		? `\nWorkflow dashboard: ${terminal && getCapabilities().hyperlinks ? hyperlink(url, url) : url}`
		: result.dashboardError ? `\nWorkflow dashboard unavailable: ${result.dashboardError}` : "";
	return `Finalized implementation plan version ${result.version}.${dashboard}`;
}
