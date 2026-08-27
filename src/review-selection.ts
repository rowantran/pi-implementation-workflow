import type { WorkflowReviewReport } from "./review-report.ts";

/** The live inputs that a review of the current delivery would be generated from. */
export interface ReviewInputsSnapshot {
	pullRequestUrls: string[];
	baseCommit: string;
	headCommit: string;
	sourceFingerprint: string;
	testingCriteria: string;
	plannedChanges: Array<{ id: string; title: string }>;
}

/**
 * True when the saved report already reviews exactly the current delivery, so
 * no new review needs to be generated.
 */
export function reviewIsCurrent(report: WorkflowReviewReport, inputs: ReviewInputsSnapshot): boolean {
	return (
		report.headCommit === inputs.headCommit &&
		report.baseCommit === inputs.baseCommit &&
		report.sourceFingerprint === inputs.sourceFingerprint &&
		arraysEqual(report.pullRequestUrls, inputs.pullRequestUrls) &&
		plannedWorkMatches(report, inputs)
	);
}

/**
 * True when the saved report reviewed an earlier state of the same plan, so
 * its per-planned-change results can seed an incremental re-review. The
 * caller must additionally verify with Git that the report's head commit is
 * an ancestor of the current head. Pull requests may differ: a revision can
 * add or remove stack entries without invalidating prior planned-change
 * reviews.
 */
export function reviewCanSeedIncremental(
	report: WorkflowReviewReport,
	inputs: ReviewInputsSnapshot,
): boolean {
	return (
		report.headCommit !== inputs.headCommit &&
		report.baseCommit === inputs.baseCommit &&
		report.sourceFingerprint === inputs.sourceFingerprint &&
		plannedWorkMatches(report, inputs)
	);
}

function plannedWorkMatches(report: WorkflowReviewReport, inputs: ReviewInputsSnapshot): boolean {
	return (
		report.testingCriteria.originalCriteria === inputs.testingCriteria &&
		report.plannedChanges.length === inputs.plannedChanges.length &&
		report.plannedChanges.every((change, index) => {
			const expected = inputs.plannedChanges[index];
			return (
				change.id === expected?.id &&
				change.title === expected.title &&
				change.review.id === expected.id &&
				change.review.title === expected.title
			);
		})
	);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
