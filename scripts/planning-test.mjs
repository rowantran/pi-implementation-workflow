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
    { id: "store-report", title: "Store the report", dependsOn: [], content: "**What**\nStore a structured review.\n\n**Why**\nThe report must survive the review session.\n\n**Pseudocode**\n```ts\nsave(report);\n```" },
    { id: "document-report", title: "Document the report", dependsOn: ["store-report"], content: "**What**\nExplain how the reviewer reads the saved report.\n\n**Why**\nReaders need to find the review results." },
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

// Section rules apply to authoring, not the stored schema or historical readers.
const historicalPlan = { ...plan, changes: plan.changes.map((change) => ({ ...change, content: "An existing freeform explanation." })) };
assert.deepEqual(parsePlannedChanges(historicalPlan).map(({ content }) => content), ["An existing freeform explanation.", "An existing freeform explanation."]);
assert.ok(renderPlanMarkdown(historicalPlan).includes("An existing freeform explanation."));
assert.equal(getPlanDependencyGraph(historicalPlan).status, "valid");
assert.match(planningCompletionError(historicalPlan, "Existing unapproved plan"), /standalone \*\*What\*\* and \*\*Why\*\*/);

const basicContent = "**What**\nSave the report.\n\n**Why**\nKeep it available.";
function withContent(content) {
  return { ...plan, changes: [{ ...plan.changes[0], content }, plan.changes[1]] };
}
function invalidContent(content, pattern) {
  const value = withContent(content);
  assert.throws(() => validatePlanDocument(value, { requireChangeSections: true }), pattern);
  assert.match(planningCompletionError(value, "Review reports"), pattern);
  // This must not invalidate an already-approved snapshot or change graph.
  assert.equal(getPlanDependencyGraph(value).status, "valid");
}
const sectionOrder = /standalone \*\*What\*\* and \*\*Why\*\* sections exactly once, in that order/;
for (const content of [
  "Freeform prose has no required sections.",
  "**What**\nOnly a change description.",
  "**Why**\nOnly a reason.",
  "**Why**\nReason first.\n\n**What**\nChange second.",
  "**What**\nChange.\n\n**Pseudocode**\nDesign.\n\n**Why**\nReason.",
  basicContent + "\n\n**What**\nRepeated description.",
  basicContent + "\n\n**Why**\nRepeated reason.",
  basicContent + "\n\n**Pseudocode**\nDesign.\n\n**Pseudocode**\nRepeated design.",
  "**What** inline description.\n\n**Why** inline reason.",
  "## What\nChange.\n\n## Why\nReason.",
  "```markdown\n" + basicContent + "\n```",
  "~~~markdown\n" + basicContent + "\n~~~",
  basicContent.split("\n").map((line) => "    " + line).join("\n"),
  basicContent.split("\n").map((line) => "> " + line).join("\n"),
  "<pre>\n" + basicContent + "\n</pre>",
  "**What**\nChange.\n\n`example\n**Why**\nNot a real label.\n`",
]) invalidContent(content, sectionOrder);
invalidContent(basicContent.replace("Save the report.", " \t"), /store-report\/change.md: What section is empty/);
invalidContent(basicContent.replace("Keep it available.", "\n"), /store-report\/change.md: Why section is empty/);
invalidContent(basicContent + "\n\n**Pseudocode**\n\t", /Pseudocode section is empty; omit it/);
for (const emptyBody of [
  "```text\n```", "~~~text\n \t\n~~~", "<!-- Write this later. -->",
  "<!-- First comment. -->\n\n<!-- Second comment. -->", "> <!-- Quoted comment. -->",
  "- <!-- List comment. -->", "---", "##", "| | |\n| --- | --- |\n| | |",
]) {
  invalidContent(`**What**\n\n${emptyBody}\n\n**Why**\n\nKeep the report available.`, /What section is empty/);
  invalidContent(`**What**\n\nSave the report.\n\n**Why**\n\n${emptyBody}`, /Why section is empty/);
  invalidContent(`${basicContent}\n\n**Pseudocode**\n\n${emptyBody}`, /Pseudocode section is empty; omit it/);
}
invalidContent("Unsectioned explanation.\n\n" + basicContent, /begin with \*\*What\*\*/);

const validContents = [basicContent, basicContent.replaceAll("\n", "\r\n"),
  basicContent + "\n\n**Pseudocode**\n\n<!-- Design note. -->\n\n```text\nsave(report)\n```",
  basicContent + "\n\n**Pseudocode**\n\n![Design diagram](design.png)",
  basicContent + "\n\n**Pseudocode**\n\n> - Call `save(report)`.",
  basicContent + "\n\n**Pseudocode**\n\n```html\n<!-- A literal comment in a code example. -->\n```",
  basicContent + "\n\n**Pseudocode**\n\nExplain the `ReviewReport` type <!-- Inline note. --> before saving.",
  basicContent.replace("**What**", "**wHaT**:").replace("**Why**", "**WHY**:"),
  basicContent + "\n\n**Pseudocode**\n```text\nsave(report)\n```",
  basicContent + "\n\n### Details\n\n| Field | Value |\n| --- | --- |\n| stable | slug |\n\n```mermaid\ngraph TD; A-->B;\n```",
];
for (const fence of ["```", "~~~", "````", "~~~~"]) {
  // Labels inside examples cannot create duplicate sections. Shorter fences and
  // apparent closing fences with text do not end the surrounding code block.
  validContents.push(basicContent + `\n\n**Pseudocode**\n${fence}markdown\n**What**\nExample.\n${fence}still-code\n${fence.slice(0, -1)}\n**Why**\nExample.\n${fence}`);
}
validContents.push(basicContent + "\n\nAn inline example: `\n**What**\n**Why**\n**Pseudocode**\n`.");
validContents.push(basicContent + "\n\n    **What**\n    Example in indented code.\n\n> **Why**\n> Quoted example.\n\n- **Pseudocode**\n  List example.\n\n<pre>\n**What**\nHTML example.\n</pre>");
for (const content of validContents) {
  const value = withContent(content);
  assert.equal(planningCompletionError(value, "Review reports"), undefined, content);
  const result = validatePlanDocument(value, { requireChangeSections: true });
  assert.equal(result.changes.find(({ id }) => id === "store-report").content, content, "validation preserves Markdown verbatim");
}

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
invalid({ ...plan, schemaVersion: 2 }, /schemaVersion must be 1/);
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
console.log("Planning tests passed: What/Why/optional Pseudocode, historical prose, stable slugs, reading order, aggregated validation, and dependency DAGs.");
