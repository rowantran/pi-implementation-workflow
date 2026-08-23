import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { PLAN_TITLE, planningCompletionError } = await jiti.import(
  new URL("../src/planning.ts", import.meta.url).pathname,
);

assert.equal(planningCompletionError("", "A description"), "The plan is empty.");
assert.equal(planningCompletionError(`${PLAN_TITLE}\n`, "A description"), "The plan is empty.");
assert.equal(
  planningCompletionError(`${PLAN_TITLE}\n\n## Scope\n\nChange the workflow.\n`, "   "),
  "The plan description is empty. Use workflow_update_plan to set it before advancing to implementation.",
);
assert.equal(
  planningCompletionError(
    `${PLAN_TITLE}\n\n## Scope\n\nChange the workflow.\n`,
    "Require a saved plan description",
  ),
  undefined,
);

console.log("Planning test passed: completion requires both plan content and a saved description.");
