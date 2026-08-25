import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HolisticReviewSchema,
	IncrementalReviewScopeSchema,
	PlannedChangeAnalysisSchema,
	ReviewSynthesisSchema,
	TestingCriteriaAnalysisSchema,
} from "./review-report.ts";

export const PLANNED_CHANGE_OUTPUT_TOOL = "submit_planned_change_review";
export const INCREMENTAL_REVIEW_SCOPE_OUTPUT_TOOL = "submit_incremental_review_scope";
export const HOLISTIC_REVIEW_OUTPUT_TOOL = "submit_holistic_review";
export const TESTING_CRITERIA_OUTPUT_TOOL = "submit_testing_criteria_review";
export const REVIEW_SYNTHESIS_OUTPUT_TOOL = "submit_review_synthesis";

export default function reviewAgentOutput(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: PLANNED_CHANGE_OUTPUT_TOOL,
			label: "Submit Planned Change Review",
			description: "Submit the final structured review for one assigned planned change.",
			parameters: PlannedChangeAnalysisSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `Submitted review for ${params.id}.` }],
					details: params,
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: INCREMENTAL_REVIEW_SCOPE_OUTPUT_TOOL,
			label: "Submit Incremental Review Scope",
			description: "Submit the planned changes whose prior reviews may be affected by the revision.",
			parameters: IncrementalReviewScopeSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `Submitted ${params.relevantPlannedChanges.length} relevant planned changes.` }],
					details: params,
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: HOLISTIC_REVIEW_OUTPUT_TOOL,
			label: "Submit Holistic Review",
			description: "Submit the final structured holistic review of the pull request against the complete plan.",
			parameters: HolisticReviewSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: "Submitted holistic review." }],
					details: params,
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: TESTING_CRITERIA_OUTPUT_TOOL,
			label: "Submit Testing Criteria Review",
			description: "Submit the evidence-based verification of the approved plan's Testing criteria.",
			parameters: TestingCriteriaAnalysisSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: "Submitted testing criteria review." }],
					details: params,
					terminate: true,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: REVIEW_SYNTHESIS_OUTPUT_TOOL,
			label: "Submit Review Synthesis",
			description: "Submit the final overall result and deduplicated overall concerns.",
			parameters: ReviewSynthesisSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: "Submitted final review synthesis." }],
					details: params,
					terminate: true,
				};
			},
		}),
	);
}
