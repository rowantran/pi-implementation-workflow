import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const REVIEW_REPORT_VERSION = 1;

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

export const ContractReviewSchema = Type.Object(
	{
		name: Type.String(),
		kind: StringEnum(["type", "protocol", "interface", "class", "function", "other"] as const),
		signature: Type.String(),
		fields: Type.Array(Type.String()),
		constructionSites: Type.Array(SourceEvidenceSchema),
		consumers: Type.Array(SourceEvidenceSchema),
		bridges: Type.Array(Type.String()),
		assessment: Type.String(),
	},
	{ additionalProperties: false },
);

export const PlannedChangeAnalysisSchema = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		summary: Type.String(),
		necessary: VerdictSchema,
		sufficient: VerdictSchema,
		contracts: Type.Array(ContractReviewSchema),
		concerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const PlanAuditSchema = Type.Object(
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
		id: Type.String(),
		title: Type.String(),
		what: Type.String(),
		why: Type.String(),
		pseudocode: Type.String(),
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
		pullRequestUrl: Type.String(),
		baseCommit: Type.String(),
		headCommit: Type.String(),
		generatedAt: Type.String(),
		overallResult: OverallResultSchema,
		overallConcerns: Type.Array(ConcernSchema),
		plannedChanges: Type.Array(PlannedChangeReportSchema),
		testingCriteria: TestingCriteriaReportSchema,
	},
	{ additionalProperties: false },
);

export type Verdict = Static<typeof VerdictSchema>;
export type SourceEvidence = Static<typeof SourceEvidenceSchema>;
export type Concern = Static<typeof ConcernSchema>;
export type ContractReview = Static<typeof ContractReviewSchema>;
export type PlannedChangeAnalysis = Static<typeof PlannedChangeAnalysisSchema>;
export type PlanAudit = Static<typeof PlanAuditSchema>;
export type TestingCriterionResult = Static<typeof TestingCriterionResultSchema>;
export type TestingCriteriaAnalysis = Static<typeof TestingCriteriaAnalysisSchema>;
export type ReviewSynthesis = Static<typeof ReviewSynthesisSchema>;
export type WorkflowReviewReport = Static<typeof WorkflowReviewReportSchema>;

export function isPlannedChangeAnalysis(value: unknown): value is PlannedChangeAnalysis {
	return Check(PlannedChangeAnalysisSchema, value);
}

export function isPlanAudit(value: unknown): value is PlanAudit {
	return Check(PlanAuditSchema, value);
}

export function isTestingCriteriaAnalysis(value: unknown): value is TestingCriteriaAnalysis {
	return Check(TestingCriteriaAnalysisSchema, value);
}

export function isReviewSynthesis(value: unknown): value is ReviewSynthesis {
	return Check(ReviewSynthesisSchema, value);
}

export function isWorkflowReviewReport(value: unknown): value is WorkflowReviewReport {
	return Check(WorkflowReviewReportSchema, value);
}

export function renderWorkflowReviewMarkdown(report: WorkflowReviewReport): string {
	const lines = [
		"# Implementation review",
		"",
		`Pull request: ${report.pullRequestUrl}`,
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

	for (const change of report.plannedChanges) {
		lines.push(
			`### ${change.id}: ${change.title}`,
			"",
			"#### Planned design",
			"",
			`**What:** ${change.what}`,
			"",
			`**Why:** ${change.why}`,
			"",
			"**Pseudocode:**",
			"",
			indentCode(change.pseudocode),
			"",
			"#### Actual implementation",
			"",
			change.review.summary,
			"",
		);
		if (change.review.contracts.length === 0) lines.push("No core types or protocols were identified.", "");
		for (const contract of change.review.contracts) {
			lines.push(`##### ${contract.name} · ${contract.kind}`, "", indentCode(contract.signature), "");
			if (contract.fields.length > 0) lines.push("Fields:", ...contract.fields.map((field) => `- ${field}`), "");
			if (contract.constructionSites.length > 0) {
				lines.push("Constructed by:", ...contract.constructionSites.map(renderEvidence), "");
			}
			if (contract.consumers.length > 0) lines.push("Consumed by:", ...contract.consumers.map(renderEvidence), "");
			if (contract.bridges.length > 0) lines.push("Bridges:", ...contract.bridges.map((bridge) => `- ${bridge}`), "");
			lines.push(contract.assessment, "");
		}
		lines.push(
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

function indentCode(value: string): string {
	return value
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}
