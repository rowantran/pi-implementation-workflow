import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const prompts = await jiti.import(new URL("../src/prompts.ts", import.meta.url).pathname);

// Test rendering behavior, not instruction wording or copies of the templates.
assert.equal(
  prompts.stripHtmlComments("<!-- leading -->\nFirst line.\n<!-- other -->\nSecond line."),
  "\nFirst line.\n\nSecond line.",
);
for (const source of ["Text <!-- unfinished", "Text --> stray", "<!-- outer <!-- nested -->"]) {
  assert.throws(() => prompts.stripHtmlComments(source));
}

const values = {
  identifier: "workflow-example",
  metadataPath: "/tmp/a & b/<metadata>.json",
  planPath: "/tmp/a & b/{{literal}}/v2",
  clarificationsPath: "/tmp/a & b/<clarifications>.json",
  questionTool: "questions",
  worktreePath: "/tmp/worktree",
  workflowBranch: "workflow/example",
  baseBranch: "release/next",
};
const implementation = prompts.implementationSystemPrompt(values);
for (const value of [values.metadataPath, values.planPath, values.clarificationsPath]) {
  assert.ok(implementation.includes(value), "paths must survive interpolation without HTML escaping or recursive expansion");
}

const content = "Literal <Type> & {{not_a_variable}}\n<!-- This is user evidence, not a template comment. -->";
const review = prompts.plannedChangeReviewPrompt({
  ...values, id: "example", title: "Example", content,
  baseCommit: "abc", headCommit: "def", pullRequestStack: "PR example",
});
assert.ok(review.includes(content), "interpolated evidence must remain verbatim, including HTML-like text");
assert.ok(prompts.startPlanningUserMessage(content).includes(content));

console.log("Prompt rendering tests passed: comment parsing and verbatim input interpolation.");
