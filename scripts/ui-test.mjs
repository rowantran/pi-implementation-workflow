import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	PHASE_REMINDER_ENTRY,
	registerWorkflowPhaseReminderRenderer,
	showWorkflowNextNotice,
	WorkflowProgressComponent,
	workflowNextNoticeText,
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
assert.equal(workflowNextNoticeText(), "Send /workflow-next here to start a separate review session.");

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
const cardTheme = {
	bg: (_color, text) => text,
	bold: (text) => text,
	fg: (_color, text) => text,
};
const rendered = renderer({ data: { phase: "review" } }, {}, cardTheme).render(100).join("\n");
assert.match(rendered, /Review ready · Read-only session/);
assert.match(rendered, /Ask me to explain a finding/);
assert.match(rendered, /\/workflow-revise <changes>/);
assert.match(rendered, /\/workflow-next/);
assert.deepEqual(renderer({ data: { phase: "planning" } }, {}, cardTheme).render(100), []);

const widgetCalls = [];
const ctx = {
	ui: {
		setWidget: (...args) => widgetCalls.push(args),
	},
};
showWorkflowNextNotice(ctx, true);
assert.equal(widgetCalls.length, 1);
assert.equal(widgetCalls[0][2].placement, "belowEditor");
assert.deepEqual(widgetCalls[0][1], ["/workflow-next — send here to start a separate review session"]);
showWorkflowNextNotice(ctx, false);
assert.equal(widgetCalls.at(-1)[1], undefined);

const renderRequests = [];
const component = new WorkflowProgressComponent(
	{ requestRender: () => renderRequests.push("render") },
	{
		fg: (_color, text) => text,
		bold: (text) => text,
	},
	"Generating implementation review",
	["Reviewing agents", "Synthesizing overall findings"],
);
component.updateSubstep("planned-change:PC-01", "PC-01: Store the report", "queued");
component.updateSubstep("holistic-review", "Holistic reviewer", "running");
let lines = component.render(80);
assert.ok(lines.includes("   ○ PC-01: Store the report"));
assert.ok(lines.some((line) => /^   ⠋ Holistic reviewer$/.test(line)), "a running agent renders its own spinner");
component.updateSubstep("planned-change:PC-01", "PC-01: Store the report", "complete");
component.updateSubstep("holistic-review", "Holistic reviewer", "reused");
component.complete("Reviewed agents");
component.updateSubstep("synthesizer", "Synthesis agent", "running");
lines = component.render(80);
assert.ok(lines.includes("   ✓ PC-01: Store the report"));
assert.ok(lines.includes("   ↻ Holistic reviewer"));
assert.ok(lines.some((line) => /^   ⠋ Synthesis agent$/.test(line)), "new substeps attach to the next active stage");
assert.ok(renderRequests.length >= 6, "substep changes request live renders");
component.stop();

console.log("UI test passed: workflow guidance, transcript card, and nested agent progress render correctly.");
