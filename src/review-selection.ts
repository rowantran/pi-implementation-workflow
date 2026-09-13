import { isDeepStrictEqual } from "node:util";
import { validatePlanDocument, type PlanDocument } from "./planned-changes.ts";
import {
	ORIGINAL_TESTING_SOURCE_ID, REVIEW_REPORT_VERSION,
	type PlannedChangeDefinition, type TestingGroup, type WorkflowReviewReport, type WorkflowReviewReportV4,
} from "./review-report.ts";
import { readPlanVersion, readText, readWorkflowMetadata, type WorkflowFiles } from "./storage.ts";
import { readWorkflowScope, requirementFingerprint, workflowScopeFingerprint, type WorkflowScope } from "./workflow-scope.ts";

/** Compatibility entry point; canonicalization belongs to the shared scope reader. */
export function reviewSourceFingerprint(ask: string, plan: PlanDocument | undefined, clarifications: string): string {
	return requirementFingerprint(ask, plan, clarifications);
}

export async function readReviewSourceFingerprint(files: WorkflowFiles, ask: string): Promise<string> {
	const metadata = await readWorkflowMetadata(files);
	if ("approvedPlanVersion" in metadata && metadata.approvedPlanVersion !== undefined) {
		return (await readWorkflowScope(files, metadata)).fingerprint;
	}
	// Cleanup also supports unapproved workflows with no finalized plan.
	const [version, clarifications] = await Promise.all([readPlanVersion(files), readText(files.clarifications)]);
	return reviewSourceFingerprint(ask, version?.document, clarifications);
}

/** Requirement-only inputs. Neither provenance nor implementation assessments select reviews. */
export interface ReviewInputsSnapshot {
	pullRequestUrls: string[];
	baseCommit: string;
	headCommit: string;
	sourceFingerprint: string;
	testingCriteria: string;
	testingGroups: TestingGroup[];
	plannedChanges: PlannedChangeDefinition[];
}

export function reviewInputsFromScope(
	scope: WorkflowScope,
	delivery: Pick<ReviewInputsSnapshot, "pullRequestUrls" | "baseCommit" | "headCommit">,
): ReviewInputsSnapshot {
	const changes = validatePlanDocument({ ...scope.currentPlan.document, changes: scope.changes }, { originalAsk: scope.originalAsk }).changes;
	return {
		...delivery,
		pullRequestUrls: [...delivery.pullRequestUrls],
		sourceFingerprint: workflowScopeFingerprint({ ...scope, changes }),
		testingCriteria: scope.approvedPlan.document.testing,
		testingGroups: [
			{ sourceId: ORIGINAL_TESTING_SOURCE_ID, criteria: scope.approvedPlan.document.testing },
			...changes.filter((change) => change.followup).map((change) => ({ sourceId: `followup:${change.id}`, criteria: change.testing! })),
		],
		plannedChanges: changes.map(({ id, title, dependsOn, content, followup }) => ({
			id, title, dependsOn: [...dependsOn], content,
			...(followup ? { kind: "followup" as const, effect: structuredClone(followup.effect) } : { kind: "original" as const }),
		})),
	};
}

/** True only for a current-format report of exactly this delivery and requirement scope. */
export function reviewIsCurrent(report: WorkflowReviewReport, inputs: ReviewInputsSnapshot): report is WorkflowReviewReportV4 {
	return (
		report.version === REVIEW_REPORT_VERSION &&
		report.headCommit === inputs.headCommit &&
		report.baseCommit === inputs.baseCommit &&
		report.sourceFingerprint === inputs.sourceFingerprint &&
		arraysEqual(report.pullRequestUrls, inputs.pullRequestUrls) &&
		plannedWorkMatches(report, inputs)
	);
}

/** The caller must also check that the earlier content head is a Git ancestor. */
export function reviewCanSeedIncremental(
	report: WorkflowReviewReport,
	inputs: ReviewInputsSnapshot,
): report is WorkflowReviewReportV4 {
	return (
		report.version === REVIEW_REPORT_VERSION &&
		report.headCommit !== inputs.headCommit &&
		report.baseCommit === inputs.baseCommit &&
		report.sourceFingerprint === inputs.sourceFingerprint &&
		plannedWorkMatches(report, inputs)
	);
}

function plannedWorkMatches(report: WorkflowReviewReportV4, inputs: ReviewInputsSnapshot): boolean {
	return (
		report.testingCriteria.originalCriteria === inputs.testingCriteria &&
		isDeepStrictEqual(report.testingCriteria.groups, inputs.testingGroups) &&
		report.plannedChanges.length === inputs.plannedChanges.length &&
		report.plannedChanges.every(({ review, ...definition }, index) => {
			const expected = inputs.plannedChanges[index];
			return expected !== undefined && review.id === expected.id && review.title === expected.title &&
				isDeepStrictEqual({ ...definition, dependsOn: [...definition.dependsOn].sort() }, { ...expected, dependsOn: [...expected.dependsOn].sort() });
		})
	);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
