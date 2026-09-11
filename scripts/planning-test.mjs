import assert from "node:assert/strict";
import { createJiti } from "jiti/static";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { planningCompletionError } = await jiti.import(new URL("../src/planning.ts", import.meta.url).pathname);
const { getPlanDependencyGraph, parsePlannedChanges, parseTestingCriteria, validatePlanDocument, renderPlanMarkdown, PlanValidationError } =
  await jiti.import(new URL("../src/planned-changes.ts", import.meta.url).pathname);

const plan = {
  schemaVersion: 1,
  readingOrder: ["document-report", "store-report"],
  goal: "Generate a durable implementation review.",
  intro: "Keep structure in JSON and prose in Markdown.",
  testing: "Verify the saved report and dashboard.",
  changes: [
    { id: "store-report", title: "Store the report", dependsOn: [], content: "Store a structured review.\n\n## Any heading is fine\n\n```ts\nsave(report);\n```" },
    { id: "document-report", title: "Document the report", dependsOn: ["store-report"], content: "Explain how the reviewer reads the saved report. No mandatory fields." },
  ],
};
assert.match(planningCompletionError(undefined, "Description"), /No finalized plan exists/);
assert.match(planningCompletionError(plan, " "), /description is empty/);
assert.equal(planningCompletionError(plan, "Review reports"), undefined);
assert.equal(parseTestingCriteria(plan), plan.testing);
assert.deepEqual(parsePlannedChanges(plan).map(({ id }) => id), plan.readingOrder);
assert.equal(parsePlannedChanges(plan)[1].content, plan.changes[0].content);
assert.equal(Object.hasOwn(parsePlannedChanges(plan)[0], "what"), false);
assert.deepEqual(getPlanDependencyGraph(plan), {
  status: "valid", nodes: [
    { id: "document-report", title: "Document the report", dependsOn: ["store-report"] },
    { id: "store-report", title: "Store the report", dependsOn: [] },
  ],
});
const markdown = renderPlanMarkdown(plan);
assert.ok(markdown.indexOf("### document-report:") < markdown.indexOf("### store-report:"));
assert.ok(markdown.includes(plan.changes[0].content));
assert.ok(markdown.includes("## Introduction\n\n" + plan.intro));
assert.throws(() => parsePlannedChanges(markdown), /expected an object/, "Markdown is never parsed back into authoritative structure");
const reversed = { ...plan, readingOrder: [...plan.readingOrder].reverse() };
assert.deepEqual(parsePlannedChanges(reversed).map(({ id }) => id), reversed.readingOrder);
assert.deepEqual(getPlanDependencyGraph(reversed).nodes.map(({ dependsOn }) => dependsOn), [[], ["store-report"]]);

function invalid(value, pattern) {
  assert.throws(() => validatePlanDocument(value), pattern);
  const graph = getPlanDependencyGraph(value);
  assert.equal(graph.status, "unavailable");
  assert.deepEqual(Object.keys(graph).sort(), ["reason", "status"]);
  assert.match(graph.reason, pattern);
}
for (const id of ["../escape", "a/b", "a\\b", ".", "..", "-bad", "bad-", "bad--id", "PC-01", "01-store", "Store", "bad_id", "bad.id", "a".repeat(81), "with space", "é", "x\0y"]) {
  invalid({ ...plan, readingOrder: [id], changes: [{ ...plan.changes[0], id }] }, /invalid.*ID/);
}
invalid({ ...plan, changes: [{ ...plan.changes[0], id: { toString: null } }] }, /invalid change ID/);
for (const field of ["goal", "testing", "intro"]) invalid({ ...plan, [field]: " \n " }, /nonempty prose/);
invalid({ ...plan, schemaVersion: 3 }, /schemaVersion must be 1 or 2/);
invalid({ ...plan, schemaVersion: 2 }, /implemented must be boolean/);
assert.ok(validatePlanDocument(plan).changes.every((change) => change.implemented === false), "legacy flags normalize to false");
invalid({ ...plan, extra: true }, /unknown field "extra"/);
invalid({ ...plan, readingOrder: "store-report" }, /readingOrder must be an array/);
invalid({ ...plan, readingOrder: ["store-report", "store-report", "absent"] }, /readingOrder repeats store-report/);
invalid({ ...plan, readingOrder: ["store-report"] }, /readingOrder is missing document-report/);
invalid({ ...plan, readingOrder: [...plan.readingOrder, "absent"] }, /readingOrder references unknown change absent/);
invalid({ ...plan, changes: [] }, /at least one planned change/);
invalid({ ...plan, changes: [plan.changes[0], plan.changes[0]] }, /duplicate change ID/);
for (const title of ["", "  ", "line\nbreak", 1, { toString: null }]) invalid({ ...plan, changes: [{ ...plan.changes[0], title }] }, /title must be a nonempty single-line string/);
invalid({ ...plan, changes: [{ ...plan.changes[0], content: " " }] }, /nonempty prose/);
invalid({ ...plan, changes: [{ ...plan.changes[0], dependsOn: undefined }] }, /dependsOn must be an array/);
invalid({ ...plan, changes: [{ ...plan.changes[0], dependsOn: ["store-report"] }] }, /cannot depend on itself/);
invalid({ ...plan, changes: [{ ...plan.changes[0], dependsOn: ["missing"] }] }, /depends on unknown change missing/);
invalid({ ...plan, changes: [{ ...plan.changes[0], dependsOn: ["missing", "missing"] }] }, /repeats dependency missing/);
invalid({ ...plan, changes: [{ ...plan.changes[0], what: "Legacy field" }] }, /unknown field "what"/);
invalid({ ...plan, changes: [{ ...plan.changes[0], dependsOn: ["document-report"] }, plan.changes[1]] }, /dependency cycle: store-report -> document-report -> store-report/);
try {
  validatePlanDocument({ ...plan, schemaVersion: 3, goal: "", testing: "", readingOrder: ["missing", "missing"], changes: [{ ...plan.changes[0], title: "", dependsOn: ["store-report", "unknown"] }] });
  assert.fail("Expected aggregated validation errors");
} catch (error) {
  assert.ok(error instanceof PlanValidationError);
  assert.ok(error.errors.length >= 8, error.message);
}
const withoutIntro = { ...plan };
delete withoutIntro.intro;
assert.equal(validatePlanDocument(withoutIntro).intro, undefined);
// Long forward chains do not hit recursion limits; no numbering rules affect identity.
const changes = Array.from({ length: 12000 }, (_, index) => ({
  id: `change-${index}`, title: `Change ${index}`, dependsOn: index === 11999 ? [] : [`change-${index + 1}`], content: "Implement this change.",
}));
const chain = { ...withoutIntro, readingOrder: changes.map(({ id }) => id), changes };
assert.equal(getPlanDependencyGraph(chain).nodes.length, 12000);
console.log("Planning tests passed: structured plans, freeform prose, stable slugs, reading order, aggregated validation, and dependency DAGs.");
