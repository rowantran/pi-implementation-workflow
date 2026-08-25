import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { PLAN_TITLE, planningCompletionError } = await jiti.import(
  new URL("../src/planning.ts", import.meta.url).pathname,
);
const { parsePlannedChanges, parseTestingCriteria } = await jiti.import(
  new URL("../src/planned-changes.ts", import.meta.url).pathname,
);

const validPlan = `${PLAN_TITLE}

## Goal

Generate a durable implementation review.

## Planned Changes

### PC-01: Store the report

**What**
Store a structured review.

**Why**
The report must survive the review session.

**Pseudocode**
\`\`\`text
type ReviewReport:
    findings: Finding[]
\`\`\`

### PC-02: Render the report

**What**
Show each planned change in the dashboard.

**Why**
The reviewer needs a focused browser view.

**Pseudocode**
\`\`\`text
for each plannedChange:
    render plannedChange.review
\`\`\`

## Testing

Verify the saved report and dashboard.
`;

assert.equal(planningCompletionError("", "A description"), "The plan is empty.");
assert.equal(planningCompletionError(`${PLAN_TITLE}\n`, "A description"), "The plan is empty.");
assert.equal(
  planningCompletionError(validPlan, "   "),
  "The plan description is empty. Use workflow_update_plan to set it before advancing to implementation.",
);
assert.match(
  planningCompletionError(`${PLAN_TITLE}\n\n## Goal\n\nChange the workflow.\n`, "A description"),
  /add a second-level "Planned Changes" section/,
);
assert.match(
  planningCompletionError(validPlan.replace("PC-02", "PC-03"), "A description"),
  /expected PC-02, found PC-03/,
);
assert.match(
  planningCompletionError(validPlan.replace("**Pseudocode**", "**Design**"), "A description"),
  /must contain \*\*What\*\*, \*\*Why\*\*, and \*\*Pseudocode\*\*/,
);
assert.match(
  planningCompletionError(validPlan.replace("Verify the saved report and dashboard.", ""), "A description"),
  /add explicit verification criteria/,
);
assert.equal(planningCompletionError(validPlan, "Generate planned-change implementation reviews"), undefined);
assert.equal(parseTestingCriteria(validPlan), "Verify the saved report and dashboard.");

assert.deepEqual(
  parsePlannedChanges(validPlan).map(({ id, title, what, why }) => ({ id, title, what, why })),
  [
    {
      id: "PC-01",
      title: "Store the report",
      what: "Store a structured review.",
      why: "The report must survive the review session.",
    },
    {
      id: "PC-02",
      title: "Render the report",
      what: "Show each planned change in the dashboard.",
      why: "The reviewer needs a focused browser view.",
    },
  ],
);

console.log("Planning test passed: planned changes and testing criteria are stable, explicit, and parseable.");
