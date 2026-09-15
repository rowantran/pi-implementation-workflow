import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { nodeExec, repositoryIdentity, worktreeStatus } from "../src/git.ts";
import {
	appendClarifications,
	createWorkflow,
	findWorkflowById,
	findWorkflowHere,
	isIdAvailable,
	listWorkflows,
	readClarifications,
	readWorkflow,
	removeWorkflow,
} from "../src/workflow.ts";
import { initRepository } from "./helpers.ts";

test("creates, lists, resolves, and removes a worktree-backed workflow", async () => {
	const repo = await initRepository();
	assert.equal(await isIdAvailable(nodeExec, repo, "add-redrive"), true);
	const { workflow, location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "add-redrive", ask: "Add redrive" });
	assert.equal(workflow.baseBranch, "main");
	assert.equal(workflow.branch, "workflow/add-redrive");
	assert.equal(location.worktree, join(repo, ".worktrees", "add-redrive"));
	assert.ok((await stat(join(location.plan, "plan.json"))).isFile());
	assert.equal(await readFile(location.clarifications, "utf8"), "[]\n");
	assert.equal(await isIdAvailable(nodeExec, repo, "add-redrive"), false);
	assert.equal(await worktreeStatus(nodeExec, location.worktree), "", "workflow files are excluded from git status");

	assert.equal((await repositoryIdentity(nodeExec, location.worktree))?.worktree, location.worktree);

	assert.deepEqual((await readWorkflow(location)).ask, "Add redrive");
	assert.equal((await findWorkflowHere(repo, location.worktree))?.id, "add-redrive");
	assert.equal(await findWorkflowHere(repo, repo), undefined);
	assert.deepEqual((await listWorkflows(repo)).map((entry) => entry.id), ["add-redrive"]);
	assert.equal((await findWorkflowById(repo, "add-redrive"))?.root, location.root);

	await appendClarifications(location, [{ question: "Q?", answer: "A", custom: false, answeredAt: "now" }]);
	assert.equal((await readClarifications(location))[0]!.answer, "A");

	assert.equal(await removeWorkflow(nodeExec, location, false), undefined);
	assert.deepEqual(await listWorkflows(repo), []);
	const branch = await nodeExec("git", ["-C", repo, "show-ref", "--verify", "--quiet", "refs/heads/workflow/add-redrive"]);
	assert.equal(branch.code, 0, "branch is kept after cleanup");
	await rm(repo, { recursive: true, force: true });
});

test("rejects duplicate ids at the git level", async () => {
	const repo = await initRepository();
	await createWorkflow(nodeExec, { repositoryRoot: repo, id: "dup", ask: "x" });
	await assert.rejects(createWorkflow(nodeExec, { repositoryRoot: repo, id: "dup", ask: "y" }), /Could not create worktree/);
	await rm(repo, { recursive: true, force: true });
});
