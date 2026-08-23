import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { workflowPhaseStatusText } = await jiti.import(
	new URL("../src/ui.ts", import.meta.url).pathname,
);

assert.equal(workflowPhaseStatusText("planning"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("implementation"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("review"), "/workflow-next when ready");
assert.equal(workflowPhaseStatusText("cleanup"), undefined);
assert.equal(workflowPhaseStatusText("complete"), undefined);
assert.equal(workflowPhaseStatusText(undefined), undefined);

console.log("UI test passed: active phases show the correct footer guidance.");
