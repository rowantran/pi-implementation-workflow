import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { PLANNED_CHANGE_ID_PATTERN } from "./planned-changes.ts";

export const REVIEW_REPORT_VERSION = 3;

export const PlannedChangeIdSchema = Type.String({
	pattern: PLANNED_CHANGE_ID_PATTERN.source,
	maxLength: 80,
	description: "Stable lowercase hyphen-separated slug from the approved structured plan, not a display number",
});

export const VerdictSchema = Type.Object(
	{
		status: StringEnum(["yes", "partial", "no", "needs-human-review"] as const),
		explanation: Type.String(),
	},
	{ additionalProperties: false },
);

export const SourceEvidenceSchema = Type.Object(
	{
		location: Type.String({ description: "Repository-relative path and line or line range" }),
		description: Type.String(),
	},
	{ additionalProperties: false },
);

export const ConcernSchema = Type.Object(
	{
		severity: StringEnum(["blocking", "warning", "note"] as const),
		title: Type.String(),
		details: Type.String(),
		evidence: Type.Array(SourceEvidenceSchema),
	},
	{ additionalProperties: false },
);

export const PlannedChangeAnalysisSchema = Type.Object(
	{
		id: PlannedChangeIdSchema,
		title: Type.String(),
		walkthrough: Type.String({
			description:
				"Literate Markdown walkthrough of what was actually implemented, interleaving prose, code excerpts, and callouts",
		}),
		necessary: VerdictSchema,
		sufficient: VerdictSchema,
		concerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const RelevantPlannedChangeSchema = Type.Object(
	{
		id: PlannedChangeIdSchema,
		explanation: Type.String(),
	},
	{ additionalProperties: false },
);

export const IncrementalReviewScopeSchema = Type.Object(
	{
		summary: Type.String(),
		relevantPlannedChanges: Type.Array(RelevantPlannedChangeSchema),
	},
	{ additionalProperties: false },
);

export const HolisticReviewSchema = Type.Object(
	{
		summary: Type.String(),
		necessary: VerdictSchema,
		sufficient: VerdictSchema,
		concerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const TestingCriterionResultSchema = Type.Object(
	{
		criterion: Type.String(),
		status: StringEnum(["yes", "partial", "no", "needs-human-review"] as const),
		explanation: Type.String(),
		evidence: Type.Array(SourceEvidenceSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const TestingCriteriaAnalysisSchema = Type.Object(
	{
		summary: Type.String(),
		satisfied: VerdictSchema,
		criteria: Type.Array(TestingCriterionResultSchema, { minItems: 1 }),
		concerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const OverallResultSchema = Type.Object(
	{
		summary: Type.String(),
		necessary: VerdictSchema,
		sufficient: VerdictSchema,
	},
	{ additionalProperties: false },
);

export const ReviewSynthesisSchema = Type.Object(
	{
		overallResult: OverallResultSchema,
		overallConcerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const PlannedChangeReportSchema = Type.Object(
	{
		id: PlannedChangeIdSchema,
		title: Type.String(),
		dependsOn: Type.Array(PlannedChangeIdSchema, { uniqueItems: true }),
		content: Type.String({ description: "Complete original freeform Markdown from the approved planned change" }),
		review: PlannedChangeAnalysisSchema,
	},
	{ additionalProperties: false },
);

export const TestingCriteriaReportSchema = Type.Object(
	{
		originalCriteria: Type.String(),
		review: TestingCriteriaAnalysisSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowReviewReportSchema = Type.Object(
	{
		version: Type.Literal(REVIEW_REPORT_VERSION),
		pullRequestUrls: Type.Array(Type.String(), { minItems: 1 }),
		baseCommit: Type.String(),
		headCommit: Type.String(),
		sourceFingerprint: Type.Optional(Type.String()),
		generatedAt: Type.String(),
		overallResult: OverallResultSchema,
		overallConcerns: Type.Array(ConcernSchema),
		holisticReview: Type.Optional(HolisticReviewSchema),
		plannedChanges: Type.Array(PlannedChangeReportSchema),
		testingCriteria: TestingCriteriaReportSchema,
	},
	{ additionalProperties: false },
);

export type Verdict = Static<typeof VerdictSchema>;
export type SourceEvidence = Static<typeof SourceEvidenceSchema>;
export type Concern = Static<typeof ConcernSchema>;
export type PlannedChangeAnalysis = Static<typeof PlannedChangeAnalysisSchema>;
export type RelevantPlannedChange = Static<typeof RelevantPlannedChangeSchema>;
export type IncrementalReviewScope = Static<typeof IncrementalReviewScopeSchema>;
export type HolisticReview = Static<typeof HolisticReviewSchema>;
export type TestingCriterionResult = Static<typeof TestingCriterionResultSchema>;
export type TestingCriteriaAnalysis = Static<typeof TestingCriteriaAnalysisSchema>;
export type ReviewSynthesis = Static<typeof ReviewSynthesisSchema>;
export type WorkflowReviewReport = Static<typeof WorkflowReviewReportSchema>;

export function isPlannedChangeAnalysis(value: unknown): value is PlannedChangeAnalysis {
	return Check(PlannedChangeAnalysisSchema, value);
}

export function isIncrementalReviewScope(value: unknown): value is IncrementalReviewScope {
	return Check(IncrementalReviewScopeSchema, value);
}

export function isHolisticReview(value: unknown): value is HolisticReview {
	return Check(HolisticReviewSchema, value);
}

export function isTestingCriteriaAnalysis(value: unknown): value is TestingCriteriaAnalysis {
	return Check(TestingCriteriaAnalysisSchema, value);
}

export function isReviewSynthesis(value: unknown): value is ReviewSynthesis {
	return Check(ReviewSynthesisSchema, value);
}

export function isWorkflowReviewReport(value: unknown): value is WorkflowReviewReport {
	if (!Check(WorkflowReviewReportSchema, value)) return false;
	const ids = new Set(value.plannedChanges.map(({ id }) => id));
	return ids.size === value.plannedChanges.length && value.plannedChanges.every((change) =>
		change.review.id === change.id &&
		change.review.title === change.title &&
		change.dependsOn.every((id) => id !== change.id && ids.has(id)),
	);
}

export function renderWorkflowReviewMarkdown(report: WorkflowReviewReport): string {
	const pullRequestUrls = report.pullRequestUrls;
	const pullRequestLines =
		pullRequestUrls.length === 1
			? [`Pull request: ${pullRequestUrls[0]}`]
			: ["Pull request stack (bottom to top):", ...pullRequestUrls.map((url, index) => `${index + 1}. ${url}`)];
	const lines = [
		"# Implementation review",
		"",
		...pullRequestLines,
		`Compared: ${report.baseCommit} → ${report.headCommit}`,
		`Generated: ${report.generatedAt}`,
		"",
		"## Overall result",
		"",
		`- Necessary: **${verdictLabel(report.overallResult.necessary.status)}** — ${report.overallResult.necessary.explanation}`,
		`- Sufficient: **${verdictLabel(report.overallResult.sufficient.status)}** — ${report.overallResult.sufficient.explanation}`,
		"",
		report.overallResult.summary,
		"",
		"## Overall concerns",
		"",
	];
	appendConcerns(lines, report.overallConcerns);
	lines.push("", "## Review of planned changes", "");

	for (const [index, change] of report.plannedChanges.entries()) {
		lines.push(
			`### ${index + 1}. ${change.title}`,
			"",
			`Stable ID: \`${change.id}\``,
			`Depends on: ${change.dependsOn.length ? change.dependsOn.map((id) => `\`${id}\``).join(", ") : "None"}`,
			"",
			"#### Planned design",
			"",
			change.content,
			"",
			"#### Actual implementation",
			"",
			change.review.walkthrough,
			"",
			"#### Verdict",
			"",
			`- Necessary: **${verdictLabel(change.review.necessary.status)}** — ${change.review.necessary.explanation}`,
			`- Sufficient: **${verdictLabel(change.review.sufficient.status)}** — ${change.review.sufficient.explanation}`,
			"",
			"#### Concerns",
			"",
		);
		appendConcerns(lines, change.review.concerns);
		lines.push("");
	}

	lines.push(
		"## Testing criteria",
		"",
		"### Original criteria",
		"",
		report.testingCriteria.originalCriteria,
		"",
		"### Verification result",
		"",
		`- Satisfied: **${verdictLabel(report.testingCriteria.review.satisfied.status)}** — ${report.testingCriteria.review.satisfied.explanation}`,
		"",
		report.testingCriteria.review.summary,
		"",
	);
	for (const criterion of report.testingCriteria.review.criteria) {
		lines.push(
			`#### ${verdictLabel(criterion.status)}: ${criterion.criterion}`,
			"",
			criterion.explanation,
			"",
			...criterion.evidence.map(renderEvidence),
			"",
		);
	}
	lines.push("### Testing concerns", "");
	appendConcerns(lines, report.testingCriteria.review.concerns);
	return `${lines.join("\n").trim()}\n`;
}

function verdictLabel(status: Verdict["status"]): string {
	if (status === "needs-human-review") return "Needs human review";
	return status[0]!.toUpperCase() + status.slice(1);
}

function appendConcerns(lines: string[], concerns: Concern[]): void {
	if (concerns.length === 0) {
		lines.push("No concerns.");
		return;
	}
	for (const concern of concerns) {
		lines.push(`- **${concern.severity.toUpperCase()}: ${concern.title}** — ${concern.details}`);
		for (const evidence of concern.evidence) lines.push(`  ${renderEvidence(evidence)}`);
	}
}

function renderEvidence(evidence: SourceEvidence): string {
	return `- \`${evidence.location}\` — ${evidence.description}`;
}
