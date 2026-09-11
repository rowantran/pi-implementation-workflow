import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { PLANNED_CHANGE_ID_PATTERN } from "./planned-changes.ts";

export const REVIEW_REPORT_VERSION = 4;
export const ORIGINAL_TESTING_SOURCE_ID = "plan:testing";

export const PlannedChangeIdSchema = Type.String({
	pattern: PLANNED_CHANGE_ID_PATTERN.source,
	maxLength: 80,
	description: "Stable lowercase hyphen-separated slug from the original or followup plan scope, not a display number",
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

const LegacyTestingCriterionResultSchema = Type.Object(
	{
		criterion: Type.String(),
		status: StringEnum(["yes", "partial", "no", "needs-human-review"] as const),
		explanation: Type.String(),
		evidence: Type.Array(SourceEvidenceSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const LegacyTestingCriteriaAnalysisSchema = Type.Object(
	{
		summary: Type.String(),
		satisfied: VerdictSchema,
		criteria: Type.Array(LegacyTestingCriterionResultSchema, { minItems: 1 }),
		concerns: Type.Array(ConcernSchema),
	},
	{ additionalProperties: false },
);

export const TestingSourceIdSchema = Type.Union([
	Type.Literal(ORIGINAL_TESTING_SOURCE_ID),
	Type.String({ pattern: `^followup:${PLANNED_CHANGE_ID_PATTERN.source.slice(1, -1)}$`, maxLength: 89 }),
]);
export const TestingGroupSchema = Type.Object({
	sourceId: TestingSourceIdSchema,
	criteria: Type.String({ minLength: 1, pattern: "\\S" }),
}, { additionalProperties: false });
export const TestingCriterionResultSchema = Type.Object({
	...LegacyTestingCriterionResultSchema.properties,
	sourceId: TestingSourceIdSchema,
}, { additionalProperties: false });
export const TestingCriteriaAnalysisSchema = Type.Object({
	...LegacyTestingCriteriaAnalysisSchema.properties,
	criteria: Type.Array(TestingCriterionResultSchema, { minItems: 1 }),
}, { additionalProperties: false });

export const ScopeEffectSchema = Type.Union([
	Type.Object({ type: Type.Literal("addition") }, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("amendment"),
		requirements: Type.Array(Type.Object({
			source: Type.Union([
				Type.Object({ type: Type.Literal("original-ask") }, { additionalProperties: false }),
				Type.Object({ type: Type.Literal("plan-section"), name: StringEnum(["goal", "intro", "testing"] as const) }, { additionalProperties: false }),
				Type.Object({ type: Type.Literal("change"), id: PlannedChangeIdSchema }, { additionalProperties: false }),
			]),
			quotedRequirement: Type.String({ minLength: 1, pattern: "\\S" }),
		}, { additionalProperties: false }), { minItems: 1, uniqueItems: true }),
	}, { additionalProperties: false }),
]);

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

const LegacyPlannedChangeReportSchema = Type.Object(
	{
		id: PlannedChangeIdSchema,
		title: Type.String(),
		dependsOn: Type.Array(PlannedChangeIdSchema, { uniqueItems: true }),
		content: Type.String({ description: "Complete original freeform Markdown from the approved planned change" }),
		review: PlannedChangeAnalysisSchema,
	},
	{ additionalProperties: false },
);

const definitionFields = {
	id: PlannedChangeIdSchema,
	title: Type.String(),
	dependsOn: Type.Array(PlannedChangeIdSchema, { uniqueItems: true }),
	content: Type.String(),
};
const originalDefinition = { ...definitionFields, kind: Type.Literal("original") };
const followupDefinition = { ...definitionFields, kind: Type.Literal("followup"), effect: ScopeEffectSchema };
export const PlannedChangeDefinitionSchema = Type.Union([
	Type.Object(originalDefinition, { additionalProperties: false }),
	Type.Object(followupDefinition, { additionalProperties: false }),
]);
export const PlannedChangeReportSchema = Type.Union([
	Type.Object({ ...originalDefinition, review: PlannedChangeAnalysisSchema }, { additionalProperties: false }),
	Type.Object({ ...followupDefinition, review: PlannedChangeAnalysisSchema }, { additionalProperties: false }),
]);
export const TestingCriteriaReportSchema = Type.Object({
	originalCriteria: Type.String(),
	groups: Type.Array(TestingGroupSchema, { minItems: 1 }),
	review: TestingCriteriaAnalysisSchema,
}, { additionalProperties: false });

export const WorkflowReviewReportV3Schema = Type.Object(
	{
		version: Type.Literal(3),
		pullRequestUrls: Type.Array(Type.String(), { minItems: 1 }),
		baseCommit: Type.String(),
		headCommit: Type.String(),
		sourceFingerprint: Type.Optional(Type.String()),
		generatedAt: Type.String(),
		overallResult: OverallResultSchema,
		overallConcerns: Type.Array(ConcernSchema),
		holisticReview: Type.Optional(HolisticReviewSchema),
		plannedChanges: Type.Array(LegacyPlannedChangeReportSchema),
		testingCriteria: Type.Object({
			originalCriteria: Type.String(),
			review: LegacyTestingCriteriaAnalysisSchema,
		}, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);

export const WorkflowReviewReportV4Schema = Type.Object({
	...WorkflowReviewReportV3Schema.properties,
	version: Type.Literal(REVIEW_REPORT_VERSION),
	sourceFingerprint: Type.String({ minLength: 1 }),
	baselinePlanVersion: Type.Integer({ minimum: 1 }),
	currentPlanVersion: Type.Integer({ minimum: 1 }),
	holisticReview: HolisticReviewSchema,
	plannedChanges: Type.Array(PlannedChangeReportSchema),
	testingCriteria: TestingCriteriaReportSchema,
}, { additionalProperties: false });
export const WorkflowReviewReportSchema = Type.Union([WorkflowReviewReportV3Schema, WorkflowReviewReportV4Schema]);

export type PlannedChangeDefinition = Static<typeof PlannedChangeDefinitionSchema>;
export type TestingGroup = Static<typeof TestingGroupSchema>;
export type WorkflowReviewReportV3 = Static<typeof WorkflowReviewReportV3Schema>;
export type WorkflowReviewReportV4 = Static<typeof WorkflowReviewReportV4Schema>;
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

/** Shape checks alone cannot establish coverage of the supplied testing sources. */
export function isTestingCriteriaAnalysisForGroups(value: unknown, groups: readonly TestingGroup[]): value is TestingCriteriaAnalysis {
	if (!isTestingCriteriaAnalysis(value) || !groups.every((group) => Check(TestingGroupSchema, group))) return false;
	const known = new Set(groups.map(({ sourceId }) => sourceId));
	const covered = new Set(value.criteria.map(({ sourceId }) => sourceId));
	return known.size === groups.length && known.size === covered.size && [...covered].every((id) => known.has(id));
}

export function isReviewSynthesis(value: unknown): value is ReviewSynthesis {
	return Check(ReviewSynthesisSchema, value);
}

export function isWorkflowReviewReport(value: unknown): value is WorkflowReviewReport {
	if (!Check(WorkflowReviewReportSchema, value)) return false;
	const byId = new Map(value.plannedChanges.map((change) => [change.id, change]));
	const ids = new Set(byId.keys());
	if (ids.size !== value.plannedChanges.length || !value.plannedChanges.every((change) =>
		change.review.id === change.id &&
		change.review.title === change.title &&
		change.dependsOn.every((id) => id !== change.id && ids.has(id)),
	)) return false;
	if (value.version === 3) return true;
	if (value.currentPlanVersion < value.baselinePlanVersion) return false;
	const expectedSources = [ORIGINAL_TESTING_SOURCE_ID, ...value.plannedChanges
		.filter((change) => change.kind === "followup").map(({ id }) => `followup:${id}`)];
	const groups = value.testingCriteria.groups;
	if (groups.length !== expectedSources.length || groups.some((group, index) => group.sourceId !== expectedSources[index]) ||
		groups[0]?.criteria !== value.testingCriteria.originalCriteria ||
		!isTestingCriteriaAnalysisForGroups(value.testingCriteria.review, groups)) return false;
	const edges = new Map(value.plannedChanges.map((change) => [change.id, [...change.dependsOn]]));
	for (const change of value.plannedChanges) {
		if (change.kind !== "followup" || change.effect.type !== "amendment") continue;
		for (const { source, quotedRequirement } of change.effect.requirements) {
			if (source.type === "change") {
				const target = byId.get(source.id);
				if (!target || target.id === change.id || !target.content.includes(quotedRequirement)) return false;
				edges.get(change.id)!.push(target.id);
			} else if (source.type === "plan-section" && source.name === "testing" && !value.testingCriteria.originalCriteria.includes(quotedRequirement)) return false;
		}
	}
	// Kahn's algorithm checks combined dependency/amendment cycles without recursion.
	const incoming = new Map([...ids].map((id) => [id, 0]));
	for (const targets of edges.values()) for (const id of targets) incoming.set(id, incoming.get(id)! + 1);
	const ready = [...ids].filter((id) => incoming.get(id) === 0);
	for (let index = 0; index < ready.length; index++) for (const id of edges.get(ready[index]!)!) {
		incoming.set(id, incoming.get(id)! - 1);
		if (incoming.get(id) === 0) ready.push(id);
	}
	return ready.length === ids.size;
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
		...(report.version === 4 ? [`Plan versions: baseline v${report.baselinePlanVersion}; current v${report.currentPlanVersion}`] : []),
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
		const definition = report.version === 4 ? report.plannedChanges[index] : undefined;
		lines.push(
			`### ${index + 1}. ${change.title}`,
			"",
			`Stable ID: \`${change.id}\``,
			...(definition ? [`Kind: ${definition.kind === "followup" ? "Followup" : "Original"}`] : []),
			...(definition?.kind === "followup" && definition.effect.type === "amendment" ? definition.effect.requirements.flatMap(({ source, quotedRequirement }) => [
				`Amends: ${JSON.stringify(source)}`, `> ${quotedRequirement.replace(/\n/g, "\n> ")}`,
			]) : []),
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
		...(report.version === 4 ? report.testingCriteria.groups.slice(1).flatMap(({ sourceId, criteria }) => [
			`### Followup criteria: ${sourceId.slice("followup:".length)}`, "", criteria, "",
		]) : []),
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
			...("sourceId" in criterion ? [`Source: \`${criterion.sourceId}\``] : []),
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
