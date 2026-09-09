import { createHash } from "node:crypto";
import { validatePlanDocument, type PlanDocument } from "./planned-changes.ts";
import { REVIEW_REPORT_VERSION, type WorkflowReviewReport } from "./review-report.ts";
import { readPlanVersion, readText, readWorkflowMetadata, type WorkflowFiles } from "./storage.ts";

/** Hash semantic structure and verbatim prose, never the generated Markdown presentation. */
export function reviewSourceFingerprint(ask: string, plan: PlanDocument | undefined, clarifications: string): string {
	const document = plan === undefined ? undefined : validatePlanDocument(plan);
	const canonicalPlan = document === undefined ? null : {
		schemaVersion: document.schemaVersion,
		readingOrder: document.readingOrder,
		goal: document.goal,
		...(document.intro === undefined ? {} : { intro: document.intro }),
		testing: document.testing,
		changes: [...document.changes]
			.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
			.map(({ id, title, dependsOn, content }) => ({ id, title, dependsOn: [...dependsOn].sort(), content })),
	};
	return createHash("sha256").update(JSON.stringify([ask, canonicalPlan, clarifications])).digest("hex");
}

export async function readReviewSourceFingerprint(files: WorkflowFiles, ask: string): Promise<string> {
	const [metadata, clarifications] = await Promise.all([readWorkflowMetadata(files), readText(files.clarifications)]);
	const approvedVersion = "approvedPlanVersion" in metadata ? metadata.approvedPlanVersion : undefined;
	const version = await readPlanVersion(files, approvedVersion);
	if (approvedVersion !== undefined && !version) {
		throw new Error(`The approved plan version v${approvedVersion} is missing.`);
	}
	// Unapproved workflows may have a latest finalized plan, or no finalized plan yet.
	return reviewSourceFingerprint(ask, version?.document, clarifications);
}

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
		report.version === REVIEW_REPORT_VERSION &&
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
		report.version === REVIEW_REPORT_VERSION &&
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
