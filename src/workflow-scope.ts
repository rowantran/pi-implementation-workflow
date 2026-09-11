import { createHash } from "node:crypto";
import { isPlanObject, validatePlanDocument, type FollowupDefinition, type PlanDocument, type PlannedChange, type ScopeEffect } from "./planned-changes.ts";
import { readPlanVersion, validatePublishedHistory, type PlanVersion } from "./plan-storage.ts";
import { readClarifications, type WorkflowClarifications, type WorkflowFiles } from "./storage.ts";

export type FollowupChange = PlannedChange & { followup: FollowupDefinition; testing: string };
export interface WorkflowScope {
	originalAsk: string;
	/** Exact immutable baseline path, never latest-plan. */
	approvedPlan: PlanVersion;
	/** Exact immutable current path, resolved once for this operation. */
	currentPlan: PlanVersion;
	clarifications: WorkflowClarifications;
	/** Every finalized change is agreed scope; implemented never filters requirements. */
	changes: PlannedChange[];
	amendments: FollowupChange[];
	followupTesting: Array<{ followupId: string; criteria: string }>;
	fingerprint: string;
}

/** Draft edits are deliberately not consulted. Callers block handoff on unsaved drafts separately. */
export async function readWorkflowScope(
	files: WorkflowFiles,
	metadata: { ask: string; approvedPlanVersion?: number },
): Promise<WorkflowScope> {
	if (!Number.isSafeInteger(metadata.approvedPlanVersion) || metadata.approvedPlanVersion! < 1) throw new Error("Workflow scope requires an approved plan.");
	// readPlanVersion follows latest-plan only here. All history reads below use exact numbers.
	const [approvedPlan, currentPlan, clarifications] = await Promise.all([
		readPlanVersion(files, metadata.approvedPlanVersion), readPlanVersion(files), readClarifications(files),
	]);
	if (!approvedPlan) throw new Error(`The approved plan version v${metadata.approvedPlanVersion} is missing.`);
	if (!currentPlan) throw new Error("The current finalized plan is missing.");
	await validatePublishedHistory(files, approvedPlan, currentPlan, metadata.ask);
	const changes = validatePlanDocument(currentPlan.document, { originalAsk: metadata.ask }).changes;
	const followups = changes.filter((change): change is FollowupChange => change.followup !== undefined);
	const scope = {
		originalAsk: metadata.ask, approvedPlan, currentPlan, clarifications, changes,
		amendments: followups.filter((change) => change.followup.effect.type === "amendment"),
		followupTesting: followups.map((change) => ({ followupId: change.id, criteria: change.testing })),
	};
	return { ...scope, fingerprint: workflowScopeFingerprint(scope) };
}

/** Fixed field order, dependency sets, and verbatim prose. No schema, origin, or assessment fields. */
export function canonicalPlanRequirements(input: PlanDocument): unknown {
	const plan = validatePlanDocument(input);
	return {
		readingOrder: plan.readingOrder, goal: plan.goal, intro: plan.intro ?? null, testing: plan.testing,
		changes: plan.changes.map(canonicalChangeRequirements),
	};
}

function canonicalEffect(effect: ScopeEffect): unknown {
	if (effect.type === "addition") return { type: "addition" };
	return { type: "amendment", requirements: effect.requirements.map(({ source, quotedRequirement }) => ({
		source: source.type === "change" ? { type: source.type, id: source.id }
			: source.type === "plan-section" ? { type: source.type, name: source.name } : { type: source.type },
		quotedRequirement,
	})) };
}

function canonicalChangeRequirements(change: PlannedChange): unknown {
	return {
		id: change.id, title: change.title, dependsOn: [...change.dependsOn].sort(), content: change.content,
		...(change.followup ? { followup: { effect: canonicalEffect(change.followup.effect) }, testing: change.testing } : {}),
	};
}

/** Saved question/answer text is requirement context; timestamps and UI/citation metadata are not. */
export function canonicalClarificationRequirements(clarifications: WorkflowClarifications): unknown {
	return clarifications.entries.map(({ question, answer }) => ({ question, answer }));
}

/** Also usable before approval, including old callers holding raw clarification text. */
export function requirementFingerprint(ask: string, input: PlanDocument | undefined, clarifications: WorkflowClarifications | string): string {
	const plan = input === undefined ? undefined : validatePlanDocument(input);
	const originals = plan?.changes.filter((change) => !change.followup);
	let context: unknown = clarifications;
	if (typeof context === "string") {
		try { context = JSON.parse(context); } catch { /* Historical callers can supply plain text. */ }
	}
	const canonicalClarifications = isPlanObject(context) && Array.isArray(context.entries) && context.entries.every((entry) => isPlanObject(entry) && typeof entry.question === "string" && typeof entry.answer === "string")
		? canonicalClarificationRequirements(context as unknown as WorkflowClarifications) : clarifications;
	return createHash("sha256").update(JSON.stringify([
		ask,
		plan ? canonicalPlanRequirements({ ...plan, readingOrder: originals!.map((change) => change.id), changes: originals! }) : null,
		canonicalClarifications,
		plan?.changes.filter((change) => change.followup).map(canonicalChangeRequirements) ?? [],
	])).digest("hex");
}

export function workflowScopeFingerprint(scope: Pick<WorkflowScope, "originalAsk" | "approvedPlan" | "clarifications" | "changes">): string {
	const canonical = [
		scope.originalAsk,
		canonicalPlanRequirements(scope.approvedPlan.document),
		canonicalClarificationRequirements(scope.clarifications),
		scope.changes.filter((change) => change.followup).map(canonicalChangeRequirements),
	];
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** False means no current claim of completion, not proof that code is absent. */
export function selectImplementationWork(scope: Pick<WorkflowScope, "changes">): { remaining: PlannedChange[]; reportedImplemented: PlannedChange[] } {
	const remaining: PlannedChange[] = [];
	const reportedImplemented: PlannedChange[] = [];
	for (const change of scope.changes) (change.implemented ? reportedImplemented : remaining).push(change);
	return { remaining, reportedImplemented };
}
