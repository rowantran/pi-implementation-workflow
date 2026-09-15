import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan } from "../src/plan.ts";
import { loadReview, reviewableChanges, stampReview } from "../src/review.ts";
import { temporaryDirectory, VALID_PLAN, writeFiles } from "./helpers.ts";

const verdict = (status = "yes") => ({ status, explanation: "Checked." });
const verdicts = () => ({ necessary: verdict(), sufficient: verdict("partial"), testing: verdict() });

async function loadFixturePlan(root: string, manifestOverride?: object): Promise<Plan> {
	await writeFiles(join(root, "plan"), { ...VALID_PLAN, ...(manifestOverride ? { "plan.json": JSON.stringify(manifestOverride) } : {}) });
	const result = await loadPlan(join(root, "plan"));
	assert.ok(result.ok, JSON.stringify(result));
	return result.value;
}

test("absent review directory is not an error", async () => {
	const root = await temporaryDirectory();
	const plan = await loadFixturePlan(root);
	const result = await loadReview(join(root, "review"), plan);
	assert.deepEqual(result, { ok: true, value: undefined });
	await rm(root, { recursive: true, force: true });
});

test("loads a complete review and stamps commits", async () => {
	const root = await temporaryDirectory();
	const plan = await loadFixturePlan(root);
	await writeFiles(join(root, "review"), {
		"review.json": JSON.stringify({ overall: verdicts(), changes: { "define-policy": verdicts(), "implement-redrive": verdicts() } }),
		"summary.md": "Overall fine.\n",
		"changes/define-policy.md": "Walkthrough one.\n",
		"changes/implement-redrive.md": "Walkthrough two.\n",
	});
	await stampReview(join(root, "review"), { baseCommit: "aaa", headCommit: "bbb", reviewedAt: "2026-01-01T00:00:00.000Z" });
	const result = await loadReview(join(root, "review"), plan);
	assert.ok(result.ok, JSON.stringify(result));
	assert.equal(result.value?.baseCommit, "aaa");
	assert.equal(result.value?.changes.length, 2);
	assert.equal(result.value?.changes[1]!.sufficient.status, "partial");
	const stamped = JSON.parse(await readFile(join(root, "review", "review.json"), "utf8"));
	assert.deepEqual(Object.keys(stamped), ["baseCommit", "headCommit", "reviewedAt", "overall", "changes"]);
	await rm(root, { recursive: true, force: true });
});

test("unimplemented followups are exempt; everything else must be covered", async () => {
	const root = await temporaryDirectory();
	const plan = await loadFixturePlan(root, {
		title: "t",
		readingOrder: ["define-policy", "implement-redrive"],
		changes: {
			"define-policy": { title: "Define", dependsOn: [], implemented: true },
			"implement-redrive": { title: "Implement", dependsOn: [], implemented: false, followup: true },
		},
	});
	assert.deepEqual(reviewableChanges(plan), ["define-policy"]);
	await writeFiles(join(root, "review"), {
		"review.json": JSON.stringify({ overall: verdicts(), changes: { "define-policy": verdicts() } }),
		"summary.md": "Fine.\n",
		"changes/define-policy.md": "Walkthrough.\n",
	});
	const ok = await loadReview(join(root, "review"), plan);
	assert.ok(ok.ok, JSON.stringify(ok));

	await writeFiles(join(root, "review"), {
		"review.json": JSON.stringify({ overall: { necessary: verdict("maybe") }, changes: { unknown: verdicts() } }),
		"changes/stray.md": "Stray.\n",
	});
	const bad = await loadReview(join(root, "review"), plan);
	assert.ok(!bad.ok);
	const errors = bad.errors.join("\n");
	assert.match(errors, /overall\.necessary: status must be one of/);
	assert.match(errors, /overall\.sufficient: expected/);
	assert.match(errors, /changes\.unknown: not a change in the plan/);
	assert.match(errors, /missing verdicts for define-policy/);
	assert.match(errors, /changes\/stray\.md: has no entry/);
	await rm(root, { recursive: true, force: true });
});
