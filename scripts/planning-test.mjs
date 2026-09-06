import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { PLAN_TITLE, planningCompletionError } = await jiti.import(
  new URL("../src/planning.ts", import.meta.url).pathname,
);
const { getPlanDependencyGraph, parsePlannedChanges, parseTestingCriteria } = await jiti.import(
  new URL("../src/planned-changes.ts", import.meta.url).pathname,
);

const validPlan = `${PLAN_TITLE}

## Goal

Generate a durable implementation review.

## Planned Changes

### PC-01: Store the report

**Depends on**
None

**What**
Store a structured review.

**Why**
The report must survive the review session.

**Pseudocode**
\`\`\`text
type ReviewReport:
    findings: Finding[]
\`\`\`

### PC-02: Document the report

**Depends on**
PC-01

**What**
Document each planned change in the README.

**Why**
The reviewer needs a clear usage guide.

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
  planningCompletionError(
    validPlan.replace("**Why**\nThe reviewer needs a clear usage guide.", "The reviewer needs a clear usage guide."),
    "A description",
  ),
  /must contain \*\*What\*\* and \*\*Why\*\* once/,
);
assert.match(
  planningCompletionError(validPlan.replace("**Pseudocode**", "**Pseudocode**\n\n**Pseudocode**"), "A description"),
  /at most one optional \*\*Pseudocode\*\* field/,
);
assert.match(
  planningCompletionError(
    validPlan.replace("```text\ntype ReviewReport:\n    findings: Finding[]\n```", ""),
    "A description",
  ),
  /empty Pseudocode field; remove it when it is not useful/,
);
assert.match(
  planningCompletionError(validPlan.replace("Verify the saved report and dashboard.", ""), "A description"),
  /add explicit verification criteria/,
);
assert.equal(planningCompletionError(validPlan, "Generate planned-change implementation reviews"), undefined);
assert.equal(parseTestingCriteria(validPlan), "Verify the saved report and dashboard.");

const plannedChanges = parsePlannedChanges(validPlan);
assert.deepEqual(
  plannedChanges.map(({ id, title, what, why }) => ({ id, title, what, why })),
  [
    {
      id: "PC-01",
      title: "Store the report",
      what: "Store a structured review.",
      why: "The report must survive the review session.",
    },
    {
      id: "PC-02",
      title: "Document the report",
      what: "Document each planned change in the README.",
      why: "The reviewer needs a clear usage guide.",
    },
  ],
);
assert.equal(plannedChanges[0].pseudocode, "```text\ntype ReviewReport:\n    findings: Finding[]\n```");
assert.equal(plannedChanges[1].pseudocode, undefined);
assert.ok(!Object.hasOwn(plannedChanges[1], "pseudocode"));

assert.deepEqual(plannedChanges.map(({ dependsOn }) => dependsOn), [[], ["PC-01"]]);
assert.deepEqual(parsePlannedChanges(validPlan, { requireDependencies: true }), plannedChanges);
assert.deepEqual(parsePlannedChanges(validPlan.replaceAll("\n", "\r\n")), plannedChanges);
assert.ok(plannedChanges[0].content.includes("**Depends on**\nNone"));
assert.ok(plannedChanges[1].content.includes("**Depends on**\nPC-01"));
assert.deepEqual(getPlanDependencyGraph(validPlan), {
  status: "valid",
  nodes: [
    { id: "PC-01", title: "Store the report", dependsOn: [] },
    { id: "PC-02", title: "Document the report", dependsOn: ["PC-01"] },
  ],
});

const legacyPlan = validPlan.replaceAll(/\*\*Depends on\*\*\n[^\n]+\n\n/g, "");
for (const options of [undefined, {}, { requireDependencies: false }]) {
  const legacyChanges = parsePlannedChanges(legacyPlan, options);
  assert.ok(legacyChanges.every((change) => !Object.hasOwn(change, "dependsOn")));
  assert.equal(legacyChanges[0].what, plannedChanges[0].what);
  assert.equal(legacyChanges[0].pseudocode, plannedChanges[0].pseudocode);
}
assert.throws(() => parsePlannedChanges(legacyPlan, { requireDependencies: true }), /PC-01 is missing \*\*Depends on\*\*/);
assert.match(planningCompletionError(legacyPlan, "Review reports"), /PC-01 is missing \*\*Depends on\*\*/);
assert.match(getPlanDependencyGraph(legacyPlan).reason, /standalone field before \*\*What\*\*/);

const mixedPlan = validPlan.replace("**Depends on**\nNone\n\n", "");
assert.deepEqual(parsePlannedChanges(mixedPlan)[1].dependsOn, ["PC-01"]);
assert.ok(!Object.hasOwn(parsePlannedChanges(mixedPlan)[0], "dependsOn"));
assert.equal(getPlanDependencyGraph(mixedPlan).status, "unavailable");
const partlyDeclaredPlan = validPlan.replace("**Depends on**\nPC-01\n\n", "");
assert.match(planningCompletionError(partlyDeclaredPlan, "Review reports"), /PC-02 is missing/);

function entry(id, dependencies = "None") {
  return `### ${id}: Change ${id}\n\n**Depends on**\n${dependencies}\n\n**What**\nImplement ${id}.\n\n**Why**\nDeliver ${id}.`;
}
function planWithDependencies(...values) {
  return `## Planned Changes\n\n${values.map((value, index) => entry(`PC-${String(index + 1).padStart(2, "0")}`, value)).join("\n\n")}\n\n## Testing\n\nVerify integration.\n`;
}
function invalid(plan, pattern) {
  // Even permissive legacy parsing must reject invalid declarations when present.
  for (const options of [undefined, { requireDependencies: false }, { requireDependencies: true }]) {
    assert.throws(() => parsePlannedChanges(plan, options), pattern);
  }
  const graph = getPlanDependencyGraph(plan);
  assert.equal(graph.status, "unavailable");
  assert.deepEqual(Object.keys(graph).sort(), ["reason", "status"], "never expose a partial graph");
  assert.match(graph.reason, pattern);
  assert.equal(planningCompletionError(plan, "Check dependencies"), `The plan cannot advance: ${graph.reason}.`);
}

// Forward references, fan-in, fan-out, independent nodes, and original reading order.
const diamond = planWithDependencies("PC-03, PC-04", "None", "PC-02", "PC-02", "None");
assert.deepEqual(getPlanDependencyGraph(diamond), {
  status: "valid",
  nodes: [
    { id: "PC-01", title: "Change PC-01", dependsOn: ["PC-03", "PC-04"] },
    { id: "PC-02", title: "Change PC-02", dependsOn: [] },
    { id: "PC-03", title: "Change PC-03", dependsOn: ["PC-02"] },
    { id: "PC-04", title: "Change PC-04", dependsOn: ["PC-02"] },
    { id: "PC-05", title: "Change PC-05", dependsOn: [] },
  ],
});
assert.equal(planningCompletionError(diamond, "Check dependencies"), undefined);
assert.deepEqual(getPlanDependencyGraph(planWithDependencies("None", "None")).nodes.map((node) => node.dependsOn), [[], []]);
assert.deepEqual(parsePlannedChanges(planWithDependencies("  PC-03,\tPC-02  ", "None", "None"))[0].dependsOn, ["PC-03", "PC-02"]);
assert.deepEqual(
  parsePlannedChanges(validPlan.replaceAll("**Depends on**", "**dEpEnDs On**:")),
  plannedChanges.map((change) => ({ ...change, content: change.content.replace("**Depends on**", "**dEpEnDs On**:") })),
);

for (const value of ["", "none", "NONE", "None, PC-02", "PC-2", "pc-02", "PC-002", "PC-00", "PC-0", "PC--02", "PC-02.0", "PC-02; PC-03", "PC-02 PC-03", "PC-02,", ",PC-02", "PC-02,,PC-03", "[PC-02](#pc-02)", "`PC-02`", "- PC-02", "PC-02 (first)", "PC-02,\nPC-03", "```text\nPC-02\n```", "None\nExtra prose"]) {
  invalid(planWithDependencies(value, "None", "None"), /PC-01 has invalid \*\*Depends on\*\* value.*use None or comma-separated canonical PC IDs/);
}
invalid(planWithDependencies("PC-02, PC-02", "None"), /PC-01 repeats dependency PC-02; list each dependency only once/);
invalid(planWithDependencies("PC-01"), /PC-01 cannot depend on itself/);
invalid(planWithDependencies("PC-99"), /PC-01 depends on unknown ID PC-99; reference an existing planned change/);
invalid(planWithDependencies("PC-02", "PC-01"), /dependency cycle: PC-01 -> PC-02 -> PC-01/);
invalid(planWithDependencies("PC-03", "PC-01", "PC-02"), /dependency cycle: PC-01 -> PC-03 -> PC-02 -> PC-01/);
invalid(planWithDependencies("None", "PC-03", "PC-04", "PC-03"), /dependency cycle: PC-03 -> PC-04 -> PC-03/);
invalid(validPlan.replace("**Depends on**\nNone", "**Depends on** None"), /PC-01 must put \*\*Depends on\*\* on its own line before \*\*What\*\*/);
invalid(validPlan.replace("**Depends on**\nNone", "**Depends on:** None"), /PC-01 must put \*\*Depends on\*\* on its own line/);
invalid(validPlan.replace("**Depends on**\nNone", "**Depends on**\nNone\n\n**Depends on**\nNone"), /PC-01 must contain \*\*Depends on\*\* exactly once, before \*\*What\*\*/);
invalid(validPlan.replace("**Depends on**\nNone\n\n**What**\nStore a structured review.", "**What**\nStore a structured review.\n\n**Depends on**\nNone"), /PC-01 must contain \*\*Depends on\*\* exactly once, before \*\*What\*\*/);

// Existing content-field rules and numbering remain unchanged.
invalid(validPlan.replace("Store a structured review.", ""), /PC-01 has an empty What or Why field/);
invalid(validPlan.replace("The report must survive the review session.", ""), /PC-01 has an empty What or Why field/);
invalid(validPlan.replace("**Why**", "**What**"), /PC-01 must contain \*\*What\*\* and \*\*Why\*\* once/);
invalid(validPlan.replace("### PC-01:", "### PC-1:"), /expected PC-01, found PC-1/);
invalid(validPlan.replace("### PC-02:", "### PC-01:"), /expected PC-02, found PC-01/);
invalid(validPlan.replace("### PC-01:", "### First:"), /use the heading format/);
invalid(validPlan.replace("## Planned Changes", "## Planned Changes\n\nUnnumbered content."), /place all Planned Changes content inside PC-numbered entries/);

// Field names and PC headings in backtick or tilde fences are not declarations.
for (const fence of ["```", "~~~"]) {
  const example = `${fence}markdown\n**Depends on**\nPC-999\n**What**\n## Planned Changes\n### PC-99: Not an entry\n${fence}`;
  const fenced = validPlan.replace("```text\ntype ReviewReport:\n    findings: Finding[]\n```", example);
  assert.deepEqual(getPlanDependencyGraph(fenced), getPlanDependencyGraph(validPlan));
  assert.equal(parsePlannedChanges(fenced)[0].pseudocode, example);
  assert.deepEqual(getPlanDependencyGraph(`${example}\n\n${validPlan}`), getPlanDependencyGraph(validPlan));
  assert.equal(getPlanDependencyGraph(legacyPlan.replace("```text\ntype ReviewReport:\n    findings: Finding[]\n```", example)).status, "unavailable");
}

// Graph availability depends on planned changes, not unrelated completion criteria.
assert.equal(getPlanDependencyGraph(validPlan.split("## Testing")[0]).status, "valid");
assert.match(planningCompletionError(validPlan.split("## Testing")[0], "Review reports"), /add a second-level "Testing" section/);
for (const draft of ["", PLAN_TITLE, "## Planned Changes\n", "## Goal\n\nAn unfinished draft."]) {
  const graph = getPlanDependencyGraph(draft);
  assert.equal(graph.status, "unavailable");
  assert.ok(graph.reason.length > 0);
}

// Canonical IDs extend past two digits; long forward chains do not hit recursion limits.
const chainSize = 12000;
const chain = planWithDependencies(...Array.from({ length: chainSize }, (_, index) =>
  index === chainSize - 1 ? "None" : `PC-${String(index + 2).padStart(2, "0")}`,
));
const chainGraph = getPlanDependencyGraph(chain);
assert.equal(chainGraph.status, "valid");
assert.equal(chainGraph.nodes.length, chainSize);
assert.deepEqual(chainGraph.nodes[98].dependsOn, ["PC-100"]);
assert.deepEqual(chainGraph.nodes.at(-1).dependsOn, []);

console.log("Planning test passed: strict dependency DAGs, legacy parsing, actionable diagnostics, optional pseudocode, and testing criteria.");
