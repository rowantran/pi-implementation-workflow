import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { loadPlan, testingSection, writePlanSkeleton } from "../src/plan.ts";
import { temporaryDirectory, VALID_PLAN, writeFiles } from "./helpers.ts";

test("loads a valid plan in reading order with testing sections", async () => {
	const root = await temporaryDirectory();
	await writeFiles(root, VALID_PLAN);
	const result = await loadPlan(root);
	assert.ok(result.ok, JSON.stringify(result));
	const plan = result.value;
	assert.equal(plan.title, "Queue redrive with retry policy");
	assert.deepEqual(plan.changes.map((change) => change.slug), ["define-policy", "implement-redrive"]);
	assert.equal(plan.changes[1]!.dependsOn[0], "define-policy");
	assert.equal(plan.changes[1]!.testing, "- Redrive retries three times.");
	assert.equal(plan.changes[0]!.followup, false);
	assert.equal(plan.intro, "The queue currently drops failed messages.\n");
	await rm(root, { recursive: true, force: true });
});

test("reports every structural problem at once", async () => {
	const root = await temporaryDirectory();
	await writeFiles(root, {
		...VALID_PLAN,
		"plan.json": JSON.stringify({
			title: "",
			readingOrder: ["define-policy", "define-policy", "ghost"],
			changes: {
				"define-policy": { title: "Define", dependsOn: ["implement-redrive"], implemented: false, extra: 1 },
				"implement-redrive": { title: "Implement", dependsOn: ["define-policy", "define-policy"], implemented: "no" },
				"Bad Slug": { title: "x", dependsOn: [], implemented: false },
			},
		}),
		"goal.md": "",
		"changes/implement-redrive.md": "No testing heading here.\n",
		"changes/orphan.md": "Orphan.\n\n## Testing\n\n- x\n",
	});
	const result = await loadPlan(root);
	assert.ok(!result.ok);
	const errors = result.errors.join("\n");
	for (const expected of [
		"title must be a nonempty",
		"readingOrder repeats define-policy",
		"unknown change ghost",
		"unknown field \"extra\"",
		"implemented must be a boolean",
		"repeats dependency define-policy",
		"changes.Bad Slug: invalid slug",
		"goal.md: must contain nonempty prose",
		"readingOrder is missing implement-redrive",
		"dependency cycle define-policy -> implement-redrive -> define-policy",
		"changes/implement-redrive.md: must end with a nonempty \"## Testing\" section",
		"changes/orphan.md: has no entry in plan.json",
	]) assert.match(errors, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing: ${expected}\n${errors}`);
	await rm(root, { recursive: true, force: true });
});

test("skeleton is a recognizable but incomplete plan", async () => {
	const root = await temporaryDirectory();
	await writePlanSkeleton(root);
	const result = await loadPlan(root);
	assert.ok(!result.ok);
	assert.ok(result.errors.some((error) => error.includes("add at least one change")));
	assert.ok(!result.errors.some((error) => error.includes("invalid JSON")));
	await rm(root, { recursive: true, force: true });
});

test("testing section ends at the next level-two heading", () => {
	assert.equal(testingSection("intro\n\n## Testing\n\n- a\n- b\n\n## Notes\n\nmore"), "- a\n- b");
	assert.equal(testingSection("## testing\n\n### Manual\n\n- a"), "### Manual\n\n- a");
	assert.equal(testingSection("no heading"), undefined);
	assert.equal(testingSection("## Testing\n\n"), undefined);
});

test("prompt strings render from strings.toml", async () => {
	const { text } = await import("../src/prompts.ts");
	assert.equal(text("tools.workflow_plan_save.saved", { title: "T", changes: 2, implemented: 1 }), 'Saved plan "T" with 2 changes (1 marked implemented).');
	assert.match(text("tools.workflow_plan_save.saved", { title: "T", changes: 2, implemented: 1, url: "http://x" }), /\nDashboard: http:\/\/x$/);
	assert.equal(text("tools.workflow_questions.answered", { entries: [{ question: "Q1", answer: "A1" }, { question: "Q2", answer: "A2" }] }), "Q: Q1\nA: A1\n\nQ: Q2\nA: A2");
	assert.throws(() => text("tools.nope"), /Missing prompt string/);
});
