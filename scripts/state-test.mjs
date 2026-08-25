import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	VALID_WORKFLOW_PHASE_TRANSITIONS,
	VALID_WORKFLOW_STATE_TRANSITIONS,
	transitionWorkflowState,
	workflowStateName,
} = await jiti.import(new URL("../src/workflow-state.ts", import.meta.url).pathname);

assert.deepEqual(VALID_WORKFLOW_PHASE_TRANSITIONS, {
	planning: ["implementing"],
	implementing: ["reviewing"],
	reviewing: ["revising", "complete"],
	revising: ["reviewing"],
	complete: [],
});
assert.deepEqual(VALID_WORKFLOW_STATE_TRANSITIONS["reviewing.active"], [
	"revising.active",
	"complete.cleanup_pending",
]);

let state = { phase: "planning", step: "draft" };
state = transitionWorkflowState(state, { phase: "planning", step: "ready" });
state = transitionWorkflowState(state, { phase: "implementing", step: "active" });
state = transitionWorkflowState(state, { phase: "implementing", step: "complete" });
state = transitionWorkflowState(state, { phase: "reviewing", step: "active", round: 1 });
state = transitionWorkflowState(state, {
	phase: "revising",
	step: "active",
	round: 1,
	reviewedHeadCommit: "abc123",
});
state = transitionWorkflowState(state, {
	phase: "revising",
	step: "complete",
	round: 1,
	reviewedHeadCommit: "abc123",
});
state = transitionWorkflowState(state, { phase: "reviewing", step: "active", round: 2 });
assert.equal(workflowStateName(state), "reviewing.active");
state = transitionWorkflowState(state, { phase: "complete", step: "cleanup_pending" });
state = transitionWorkflowState(state, { phase: "complete", step: "complete" });
assert.equal(workflowStateName(state), "complete.complete");

assert.throws(
	() => transitionWorkflowState(
		{ phase: "reviewing", step: "active", round: 1 },
		{ phase: "reviewing", step: "active", round: 2 },
	),
	/Invalid workflow state transition/,
);
assert.throws(
	() => transitionWorkflowState(
		{ phase: "revising", step: "complete", round: 1, reviewedHeadCommit: "abc123" },
		{ phase: "reviewing", step: "active", round: 3 },
	),
	/exactly one round/,
);
assert.throws(
	() => transitionWorkflowState(
		{ phase: "reviewing", step: "active", round: 1 },
		{ phase: "revising", step: "active", round: 2, reviewedHeadCommit: "abc123" },
	),
	/retain its review round/,
);

console.log("State test passed: the typed workflow lifecycle permits only the declared implementation-review revision loop.");
