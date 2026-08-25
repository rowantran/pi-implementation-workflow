export const WORKFLOW_PHASES = ["planning", "implementing", "reviewing", "revising", "complete"] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export type WorkflowState =
	| { phase: "planning"; step: "draft" | "ready" }
	| { phase: "implementing"; step: "active" | "complete" }
	| { phase: "reviewing"; step: "active"; round: number }
	| { phase: "revising"; step: "active" | "complete"; round: number; reviewedHeadCommit: string }
	| { phase: "complete"; step: "cleanup_pending" | "complete" };

export type WorkflowStateName =
	| "planning.draft"
	| "planning.ready"
	| "implementing.active"
	| "implementing.complete"
	| "reviewing.active"
	| "revising.active"
	| "revising.complete"
	| "complete.cleanup_pending"
	| "complete.complete";

/** The only valid lifecycle phase changes. Same-phase step changes are listed below. */
export const VALID_WORKFLOW_PHASE_TRANSITIONS: Readonly<Record<WorkflowPhase, readonly WorkflowPhase[]>> = {
	planning: ["implementing"],
	implementing: ["reviewing"],
	reviewing: ["revising", "complete"],
	revising: ["reviewing"],
	complete: [],
};

/** The complete state machine, including retry-safe steps inside each lifecycle phase. */
export const VALID_WORKFLOW_STATE_TRANSITIONS: Readonly<Record<WorkflowStateName, readonly WorkflowStateName[]>> = {
	"planning.draft": ["planning.ready"],
	"planning.ready": ["implementing.active"],
	"implementing.active": ["implementing.complete"],
	"implementing.complete": ["reviewing.active"],
	"reviewing.active": ["revising.active", "complete.cleanup_pending"],
	"revising.active": ["revising.complete"],
	"revising.complete": ["reviewing.active"],
	"complete.cleanup_pending": ["complete.complete"],
	"complete.complete": [],
};

export function workflowStateName(state: WorkflowState): WorkflowStateName {
	return `${state.phase}.${state.step}` as WorkflowStateName;
}

export function transitionWorkflowState(current: WorkflowState, next: WorkflowState): WorkflowState {
	assertWorkflowState(current);
	assertWorkflowState(next);
	const from = workflowStateName(current);
	const to = workflowStateName(next);
	if (!VALID_WORKFLOW_STATE_TRANSITIONS[from].includes(to)) {
		throw new Error(`Invalid workflow state transition: ${from} -> ${to}.`);
	}
	assertRoundTransition(current, next);
	return next;
}

export function assertWorkflowState(value: unknown): asserts value is WorkflowState {
	if (!value || typeof value !== "object") throw new Error("Workflow state must be an object.");
	const state = value as Partial<WorkflowState>;
	if (!WORKFLOW_PHASES.includes(state.phase as WorkflowPhase) || typeof state.step !== "string") {
		throw new Error("Workflow state has an invalid phase or step.");
	}
	const name = `${state.phase}.${state.step}`;
	if (!(name in VALID_WORKFLOW_STATE_TRANSITIONS)) throw new Error(`Workflow state is invalid: ${name}.`);
	if (state.phase === "reviewing") assertRound(state.round);
	if (state.phase === "revising") {
		assertRound(state.round);
		if (typeof state.reviewedHeadCommit !== "string" || !state.reviewedHeadCommit.trim()) {
			throw new Error("A revision state requires the reviewed head commit.");
		}
	}
}

function assertRoundTransition(current: WorkflowState, next: WorkflowState): void {
	if (current.phase === "implementing" && current.step === "complete" && next.phase === "reviewing") {
		if (next.round !== 1) throw new Error("The first review must use round 1.");
		return;
	}
	if (current.phase === "reviewing" && next.phase === "revising") {
		if (next.round !== current.round) throw new Error("A revision must retain its review round.");
		return;
	}
	if (current.phase === "revising" && next.phase === "revising") {
		if (next.round !== current.round || next.reviewedHeadCommit !== current.reviewedHeadCommit) {
			throw new Error("Completing a revision cannot change its review round or reviewed commit.");
		}
		return;
	}
	if (current.phase === "revising" && current.step === "complete" && next.phase === "reviewing") {
		if (next.round !== current.round + 1) throw new Error("A re-review must advance by exactly one round.");
	}
}

function assertRound(round: unknown): asserts round is number {
	if (!Number.isSafeInteger(round) || (round as number) < 1) throw new Error("Workflow review rounds must be positive integers.");
}
