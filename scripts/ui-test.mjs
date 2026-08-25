import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	PHASE_REMINDER_ENTRY,
	registerWorkflowPhaseReminderRenderer,
	workflowPhaseStatusText,
	workflowReviewTranscriptCardContent,
} = await jiti.import(new URL("../src/ui.ts", import.meta.url).pathname);

assert.equal(workflowPhaseStatusText("planning"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("implementation"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("revision"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("review"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("cleanup"), undefined);
assert.equal(workflowPhaseStatusText("complete"), undefined);
assert.equal(workflowPhaseStatusText(undefined), undefined);

assert.equal(PHASE_REMINDER_ENTRY, "implementation-workflow-phase-reminder");
assert.deepEqual(workflowReviewTranscriptCardContent("review"), {
	title: "Review ready · Read-only session",
	description: "The generated review is open in the workflow dashboard.",
	guidance: "Ask me to explain a finding, inspect its cited code, or assess whether a concern is valid.",
	actions: [
		{ label: "Request changes", command: "/workflow-revise <changes>" },
		{ label: "Accept and clean up", command: "/workflow-next" },
	],
});
for (const phase of ["planning", "implementation", "revision", "cleanup", "complete", undefined]) {
	assert.equal(workflowReviewTranscriptCardContent(phase), undefined);
}

const renderers = new Map();
registerWorkflowPhaseReminderRenderer({
	registerEntryRenderer(customType, renderer) {
		renderers.set(customType, renderer);
	},
});
const renderer = renderers.get(PHASE_REMINDER_ENTRY);
assert.ok(renderer);
const theme = {
	bg: (_color, text) => text,
	bold: (text) => text,
	fg: (_color, text) => text,
};
const rendered = renderer({ data: { phase: "review" } }, {}, theme).render(100).join("\n");
assert.match(rendered, /Review ready · Read-only session/);
assert.match(rendered, /Ask me to explain a finding/);
assert.match(rendered, /\/workflow-revise <changes>/);
assert.match(rendered, /\/workflow-next/);
assert.deepEqual(renderer({ data: { phase: "planning" } }, {}, theme).render(100), []);

console.log("UI test passed: active phases show footer guidance and review has a transcript card.");
