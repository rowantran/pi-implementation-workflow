import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
	showWorkflowNextNotice,
	workflowNextNoticeText,
	workflowPhaseStatusText,
} = await jiti.import(new URL("../src/ui.ts", import.meta.url).pathname);

assert.equal(workflowPhaseStatusText("planning"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("implementation"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("revision"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("review"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("cleanup"), undefined);
assert.equal(workflowPhaseStatusText("complete"), undefined);
assert.equal(workflowPhaseStatusText(undefined), undefined);
assert.equal(workflowNextNoticeText(), "Send /workflow-next here to start a separate review session.");

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

console.log("UI test passed: active phases and persistent workflow-next guidance render correctly.");
