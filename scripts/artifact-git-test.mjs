import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti/static";
import { makePlanDocument, writePlanDocument } from "./fixtures/plan-document.mjs";

const runFile = promisify(execFile);
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-workflow-artifact-git-")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { commitWorkflowArtifacts, installWorkflowExcludes, workflowContentHead, worktreeStatus } =
	await jiti.import(new URL("../src/git.ts", import.meta.url).pathname);
const { checkDelivery } = await jiti.import(new URL("../src/delivery.ts", import.meta.url).pathname);
const { createWorkflow, workflowFiles, preparePlanDraft, finalizePlanDraft, readPlanVersion } =
	await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const calls = [];

async function exec(command, args, options = {}) {
	calls.push([command, ...args]);
	assert.notEqual(args[2], "push", "helpers must never push");
	try {
		const result = await runFile(command, args, {
			cwd: options.cwd,
			timeout: options.timeout ?? 10_000,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (typeof error.code !== "number") throw error;
		return { code: error.code, stdout: error.stdout, stderr: error.stderr };
	}
}

async function git(cwd, ...args) {
	const result = await exec("git", ["-C", cwd, ...args]);
	assert.equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

async function save(cwd, path, content) {
	await mkdir(dirname(join(cwd, path)), { recursive: true });
	await writeFile(join(cwd, path), content);
}

async function fixture(name) {
	const root = join(temporaryRoot, name);
	await mkdir(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Artifact Test");
	await git(root, "config", "user.email", "artifact-test@example.invalid");
	await git(root, "config", "commit.gpgSign", "false");
	await save(root, "code.txt", "original code\n");
	await save(root, "partial.txt", "original partial\n");
	await save(root, "removed.txt", "original removed\n");
	await save(root, ".gitignore", "*.json\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "Initial content");
	const initialContent = await git(root, "rev-parse", "HEAD");
	await save(root, ".workflows/previous/plan.md", "Prior workflow plan\n");
	await git(root, "add", ".workflows/previous/plan.md");
	await git(root, "commit", "-m", "Prior workflow artifacts");
	const baseCommit = await git(root, "rev-parse", "HEAD");
	const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	await writeFile(join(commonDir, "info", "exclude"), "# Keep user excludes\n/local-user-file");
	await installWorkflowExcludes(commonDir);
	const worktreePath = join(root, ".worktrees", "current");
	await git(root, "worktree", "add", "-b", "workflow/current", worktreePath, "HEAD");
	const workflow = {
		version: 6,
		identifier: "current",
		ask: "Test artifacts",
		description: "Test artifact persistence",
		repositoryRoot: root,
		gitCommonDir: commonDir,
		baseBranch: "main",
		baseCommit,
		workflowBranch: "workflow/current",
		worktreePath,
		createdAt: new Date().toISOString(),
	};
	return { root, workflow, cwd: worktreePath, commonDir, initialContent, baseCommit };
}

function pr(number, headRefName, baseRefName, headRefOid) {
	return { number, url: `https://example.invalid/repo/pull/${number}`, headRefName, baseRefName, headRefOid };
}

function withPullRequests(pullRequests) {
	return async (command, args, options) => {
		if (command !== "gh") return exec(command, args, options);
		if (args[0] === "pr" && args[1] === "list") {
			return { code: 0, stdout: JSON.stringify(pullRequests), stderr: "" };
		}
		assert.equal(args[0], "api");
		const item = pullRequests.find((candidate) => candidate.number === Number(args[1].split("/").at(-1)));
		return item ? { code: 0, stdout: `${item.headRefOid}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "missing PR" };
	};
}

try {
	const { root, workflow, cwd, commonDir, initialContent, baseCommit } = await fixture("persistence");
	const bundle = ".workflows/current";
	const excludePath = join(commonDir, "info", "exclude");
	const excludes = await readFile(excludePath, "utf8");
	await installWorkflowExcludes(commonDir);
	assert.equal(await readFile(excludePath, "utf8"), excludes, "exclude installation is idempotent");
	assert.ok(excludes.startsWith("# Keep user excludes\n/local-user-file\n"));
	assert.ok(!excludes.split("\n").includes("/.workflows/"), "prior bundles must not be globally ignored");
	assert.ok(excludes.split("\n").includes("/.workflows/active.json"), "active marker has its own local ignore");
	assert.equal(await worktreeStatus(exec, root), "", "nested worktrees do not dirty the original checkout");
	assert.equal(await workflowContentHead(exec, workflow), baseCommit, "an artifact-only base bounds older content history");
	assert.notEqual(initialContent, baseCommit);
	assert.equal(await commitWorkflowArtifacts(exec, workflow, "No saved artifacts yet"), undefined);
	assert.equal(await git(cwd, "rev-parse", "HEAD"), baseCommit);

	const durable = ["latest-plan", "plan-versions/v1/plan.json", "plan-versions/v1/goal.md", "plan-versions/v1/intro.md", "plan-versions/v1/testing.md", "plan-versions/v1/version-metadata.json", "plan-versions/v1/planned-changes/store-report/change_metadata.json", "plan-versions/v1/planned-changes/store-report/change.md", "clarifications.json", "metadata.json", "review.json", "review.md", "reviews/0001.json", "reviews/0001.md"];
	const files = workflowFiles(workflow.identifier, cwd);
	await createWorkflow(files, workflow);
	await writePlanDocument(files.workingPlan, makePlanDocument({
		intro: "Validate saved plan artifacts before committing them.",
		changes: [{ id: "store-report", title: "Store the report", dependsOn: [], content: "**What**\n\nKeep the report with the workflow.\n\n**Why**\n\nPreserve review findings in the committed workflow artifacts." }],
	}));
	await finalizePlanDraft(files, "First saved plan", 0);
	for (const path of ["review.json", "review.md", "reviews/0001.json", "reviews/0001.md"]) await save(cwd, `${bundle}/${path}`, `Saved ${path}\n`);
	const disposable = [".workflows/active.json", `${bundle}/working-plan/plan.json`, `${bundle}/working-plan/goal.md`, `${bundle}/working-plan/planned-changes/store-report/change.md`, `${bundle}/plan.md`, `${bundle}/.plan-draft-base.json`, `${bundle}/.plan.lock`, `${bundle}/.plan-publish-example/goal.md`, `${bundle}/.plan-prepare-example/goal.md`, `${bundle}/.plan-base-example.tmp`, `${bundle}/.latest-plan-example.tmp`, `${bundle}/dashboard.html`, `${bundle}/review-runs/attempt/result.json`];
	for (const path of disposable) {
		await save(cwd, path, "generated\n");
		assert.equal((await exec("git", ["-C", cwd, "check-ignore", "-q", path])).code, 0, `${path} must be ignored`);
	}
	assert.equal(await git(cwd, "ls-files", ".workflows/previous/plan.md"), ".workflows/previous/plan.md");
	await save(cwd, ".workflows/another/plan-versions/v1/goal.md", "Another bundle\n");
	assert.equal((await exec("git", ["-C", cwd, "check-ignore", "-q", ".workflows/another/plan-versions/v1/goal.md"])).code, 1);

	await save(cwd, "code.txt", "staged code\n");
	await save(cwd, "partial.txt", "staged partial\n");
	await save(cwd, "new file.txt", "staged new file\n");
	await save(cwd, ".workflows/previous/plan.md", "Staged unrelated prior workflow\n");
	await save(cwd, `${bundle}/scratch.txt`, "Not a managed artifact\n");
	await git(cwd, "add", "code.txt", "partial.txt", "new file.txt", ".workflows/previous/plan.md", `${bundle}/scratch.txt`);
	await git(cwd, "add", "--force", ".workflows/active.json", `${bundle}/dashboard.html`);
	await git(cwd, "rm", "removed.txt");
	await save(cwd, "partial.txt", "unstaged partial\n");
	const unrelated = ["code.txt", "partial.txt", "new file.txt", "removed.txt", ".workflows/previous/plan.md", `${bundle}/scratch.txt`, ".workflows/active.json", `${bundle}/dashboard.html`];
	const stagedBefore = await git(cwd, "diff", "--cached", "--binary", "--", ...unrelated);
	const unstagedBefore = await git(cwd, "diff", "--binary", "--", ...unrelated);
	const indexBefore = await git(cwd, "ls-files", "--stage", "-z", "--", ...unrelated);
	const initialArtifacts = await commitWorkflowArtifacts(exec, workflow, "Freeze approved workflow artifacts");
	assert.ok(initialArtifacts);
	assert.equal(await git(cwd, "rev-parse", "HEAD"), initialArtifacts);
	assert.deepEqual((await git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).split("\n").sort(), durable.map((path) => `${bundle}/${path}`).sort());
	assert.match(await git(cwd, "ls-files", "--stage", `${bundle}/latest-plan`), /^120000 /, "the managed alias is tracked as a symlink");
	assert.equal(await git(cwd, "show", `HEAD:${bundle}/latest-plan`), "plan-versions/v1");
	assert.equal(await git(cwd, "ls-files", `${bundle}/working-plan`, `${bundle}/plan.md`, `${bundle}/.plan-draft-base.json`, `${bundle}/.plan.lock`), "");
	assert.equal(await git(cwd, "diff", "--cached", "--binary", "--", ...unrelated), stagedBefore, "unrelated staged diff is preserved");
	assert.equal(await git(cwd, "diff", "--binary", "--", ...unrelated), unstagedBefore, "partially staged working files are preserved");
	assert.equal(await git(cwd, "ls-files", "--stage", "-z", "--", ...unrelated), indexBefore, "unrelated index entries are preserved exactly");
	assert.equal(await workflowContentHead(exec, workflow), baseCommit, "initial approved artifacts are not implementation");
	assert.equal(await commitWorkflowArtifacts(exec, workflow, "No-op save"), undefined);
	assert.equal(await git(cwd, "rev-parse", "HEAD"), initialArtifacts);
	assert.equal(await git(cwd, "diff", "--cached", "--binary", "--", ...unrelated), stagedBefore);
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", baseCommit)]), workflow)).stage, "worktree", "artifact commits must not hide unrelated dirty code");

	await git(cwd, "reset", "--hard", "HEAD");
	await rm(join(cwd, ".workflows/another"), { recursive: true });
	assert.equal(await worktreeStatus(exec, cwd), "");
	await save(cwd, "code.txt", "implemented code\n");
	await git(cwd, "add", "code.txt");
	await git(cwd, "commit", "-m", "Implement content");
	const contentHead = await git(cwd, "rev-parse", "HEAD");
	assert.equal(await workflowContentHead(exec, workflow), contentHead, "real code commits advance the content head");
	let delivery = await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", contentHead)]), workflow);
	assert.equal(delivery.ok, true);
	assert.equal(delivery.headCommit, contentHead);
	assert.equal(delivery.deliveryHeadCommit, contentHead);
	assert.equal(delivery.artifactsUnpushed, false);

	// Code hooks may stage unrelated files. Artifact bookkeeping must not run them.
	const hook = join(commonDir, "hooks", "pre-commit");
	await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' > code.txt\ngit add code.txt\n");
	await chmod(hook, 0o755);
	await save(cwd, `${bundle}/clarifications.json`, "{\"answer\":\"yes\"}\n");
	await save(cwd, `${bundle}/review.json`, `${JSON.stringify({ headCommit: contentHead })}\n`);
	await save(cwd, `${bundle}/reviews/0002.json`, `${JSON.stringify({ headCommit: contentHead })}\n`);
	await save(cwd, `${bundle}/reviews/odd [name]\nreport.md`, "Literal filenames are safe\n");
	const reportCommit = await commitWorkflowArtifacts(exec, workflow, "Save review report");
	await rm(hook);
	assert.notEqual(reportCommit, contentHead);
	assert.equal(await readFile(join(cwd, "code.txt"), "utf8"), "implemented code\n");
	assert.equal(await worktreeStatus(exec, cwd), "");
	assert.equal(await workflowContentHead(exec, workflow), contentHead, "saving a report cannot invalidate its own content head");
	assert.equal(JSON.parse(await readFile(join(cwd, `${bundle}/review.json`), "utf8")).headCommit, contentHead);
	assert.equal(await commitWorkflowArtifacts(exec, workflow, "Repeat report save"), undefined);
	delivery = await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", contentHead)]), workflow);
	assert.equal(delivery.ok, true, JSON.stringify(delivery));
	assert.equal(delivery.headCommit, contentHead);
	assert.equal(delivery.deliveryHeadCommit, reportCommit);
	assert.equal(delivery.artifactsUnpushed, true, "callers can warn that local artifacts are not pushed");
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", reportCommit)]), workflow)).artifactsUnpushed, false);
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", initialArtifacts)]), workflow)).ok, false, "unpushed code must still block delivery");

	await git(cwd, "rm", `${bundle}/review.md`);
	await rm(join(cwd, `${bundle}/reviews/0001.md`));
	assert.ok(await commitWorkflowArtifacts(exec, workflow, "Remove saved artifacts"), "staged and unstaged review deletions are committed");
	assert.equal(await worktreeStatus(exec, cwd), "");
	assert.equal(await workflowContentHead(exec, workflow), contentHead);
	assert.equal(await commitWorkflowArtifacts(exec, workflow, "Repeat deletion"), undefined);
	await save(cwd, "hidden-by-config.txt", "untracked code\n");
	await git(cwd, "config", "status.showUntrackedFiles", "no");
	assert.match(await worktreeStatus(exec, cwd), /hidden-by-config/);
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", contentHead)]), workflow)).stage, "worktree");
	await rm(join(cwd, "hidden-by-config.txt"));

	// Every failure must preserve unrelated staged content and leave saved files retryable.
	await save(cwd, "code.txt", "staged during failed save\n");
	await git(cwd, "add", "code.txt");
	await save(cwd, `${bundle}/review.json`, "Updated saved review\n");
	const failureIndex = await git(cwd, "ls-files", "--stage", "code.txt");
	const failureHead = await git(cwd, "rev-parse", "HEAD");
	for (const failure of ["add", "diff", "commit"]) {
		const failingExec = async (command, args, options) => {
			const fails = failure === "diff" ? args.includes("--quiet") : args.includes(failure);
			if (fails) return { code: 128, stdout: "", stderr: `simulated ${failure} failure` };
			return exec(command, args, options);
		};
		await assert.rejects(commitWorkflowArtifacts(failingExec, workflow, "Fail safely"), new RegExp(`workflow artifacts.*simulated ${failure} failure`));
		assert.equal(await git(cwd, "rev-parse", "HEAD"), failureHead);
		assert.equal(await git(cwd, "ls-files", "--stage", "code.txt"), failureIndex);
	}
	const indexLock = await git(cwd, "rev-parse", "--git-path", "index.lock");
	await writeFile(indexLock, "Another process owns this lock\n");
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Locked index"), /workflow artifacts.*index.lock/s);
	assert.equal(await readFile(indexLock, "utf8"), "Another process owns this lock\n", "must not remove another Git process's lock");
	await rm(indexLock);
	await git(cwd, "config", "user.name", "");
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Missing author"), /workflow artifacts.*empty ident name/s);
	await git(cwd, "config", "user.name", "Artifact Test");
	assert.equal(await git(cwd, "rev-parse", "HEAD"), failureHead);
	assert.equal(await git(cwd, "ls-files", "--stage", "code.txt"), failureIndex);
	assert.ok(await commitWorkflowArtifacts(exec, workflow, "Retry saved plan"));
	assert.equal(await git(cwd, "ls-files", "--stage", "code.txt"), failureIndex);
	assert.equal(await workflowContentHead(exec, workflow), contentHead);
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "  "), /non-empty message/);
	await assert.rejects(commitWorkflowArtifacts(exec, { ...workflow, identifier: "../../escape" }, "Unsafe identifier"), /identifiers/);
	await assert.rejects(commitWorkflowArtifacts(exec, { ...workflow, gitCommonDir: root }, "Wrong repository"), /different Git repository/);
	await assert.rejects(commitWorkflowArtifacts(exec, { ...workflow, worktreePath: root }, "Base branch"), /base branch/);
	await assert.rejects(commitWorkflowArtifacts(exec, { ...workflow, worktreePath: join(cwd, "missing") }, "Missing"), /missing/);
	await assert.rejects(commitWorkflowArtifacts(exec, { ...workflow, worktreePath: join(cwd, ".workflows") }, "Nested path"), /not the worktree root/);
	const latestPointer = join(cwd, bundle, "latest-plan");
	for (const target of [root, "../outside", "plan-versions/../outside", "plan-versions/v01", "plan-versions/v999"]) {
		await rm(latestPointer);
		await symlink(target, latestPointer, "dir");
		await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Unsafe latest alias"), /Unsafe latest-plan|target is missing/);
		assert.equal(await readlink(latestPointer), target, "validation never repairs a caller's pointer");
	}
	await rm(latestPointer);
	await symlink("plan-versions/v1", latestPointer, "dir");
	const changeFile = join(cwd, bundle, "plan-versions/v1/planned-changes/store-report/change.md");
	const originalChange = await readFile(changeFile, "utf8");
	await rm(changeFile);
	await symlink(join(root, "code.txt"), changeFile);
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Unsafe nested artifact"), /symbolic links/);
	await rm(changeFile);
	await writeFile(changeFile, originalChange);
	await symlink(root, join(cwd, bundle, "plan-versions/v2"), "dir");
	await rm(latestPointer);
	await symlink("plan-versions/v2", latestPointer, "dir");
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Unsafe alias target"), /symbolic links/);
	await rm(latestPointer);
	await rm(join(cwd, bundle, "plan-versions/v2"));
	await symlink("plan-versions/v1", latestPointer, "dir");
	await rm(join(cwd, `${bundle}/reviews`), { recursive: true });
	await symlink(root, join(cwd, `${bundle}/reviews`), "dir");
	await assert.rejects(commitWorkflowArtifacts(exec, workflow, "Symlink escape"), /not a real directory/);
	assert.equal(await workflowContentHead(async (command, args, options) => args.includes("log") ? { code: 128, stdout: "", stderr: "bad history" } : exec(command, args, options), workflow), undefined);
	assert.equal(await workflowContentHead(exec, { ...workflow, baseCommit: "0000000000000000000000000000000000000000" }), undefined);

	// PR ancestry and stack structure still matter when local report commits are allowed.
	const stackFixture = await fixture("stack");
	const stackCwd = stackFixture.cwd;
	const stackWorkflow = stackFixture.workflow;
	await save(stackCwd, "code.txt", "bottom implementation\n");
	await git(stackCwd, "commit", "-am", "Bottom code");
	const bottom = await git(stackCwd, "rev-parse", "HEAD");
	await git(stackCwd, "switch", "-c", "workflow/top");
	await save(stackCwd, "partial.txt", "top implementation\n");
	await git(stackCwd, "commit", "-am", "Top code");
	const top = await git(stackCwd, "rev-parse", "HEAD");
	await save(stackCwd, `${bundle}/clarifications.json`, "Stack clarifications\n");
	const localTop = await commitWorkflowArtifacts(exec, stackWorkflow, "Stack artifacts");
	const stackPrs = [pr(1, "workflow/current", "main", bottom), pr(2, "workflow/top", "workflow/current", top)];
	delivery = await checkDelivery(withPullRequests(stackPrs), stackWorkflow);
	assert.equal(delivery.ok, true, JSON.stringify(delivery));
	assert.equal(delivery.headCommit, top);
	assert.equal(delivery.deliveryHeadCommit, localTop);
	assert.equal(delivery.artifactsUnpushed, true);
	assert.deepEqual(delivery.pullRequests.map((item) => item.number), [1, 2]);
	assert.match((await checkDelivery(withPullRequests([pr(2, "workflow/top", "main", top)]), stackWorkflow)).message, /bottom pull request/);
	assert.match((await checkDelivery(withPullRequests([pr(2, "workflow/top", "missing", top)]), stackWorkflow)).message, /no open pull request/);
	assert.match((await checkDelivery(withPullRequests([stackPrs[0], stackPrs[1], { ...stackPrs[1], number: 3 }]), stackWorkflow)).message, /multiple/);
	assert.match((await checkDelivery(withPullRequests([pr(1, "workflow/current", "workflow/top", bottom), stackPrs[1]]), stackWorkflow)).message, /cycle/);

	await git(stackCwd, "switch", "-c", "other", stackWorkflow.baseCommit);
	await save(stackCwd, "unrelated.txt", "diverged code\n");
	await git(stackCwd, "add", "unrelated.txt");
	await git(stackCwd, "commit", "-m", "Unrelated branch");
	const diverged = await git(stackCwd, "rev-parse", "HEAD");
	await git(stackCwd, "switch", "workflow/top");
	assert.match((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", diverged), stackPrs[1]]), stackWorkflow)).message, /does not contain/);
	assert.match((await checkDelivery(withPullRequests([stackPrs[0], pr(2, "workflow/top", "workflow/current", diverged)]), stackWorkflow)).message, /diverged/);
	await git(stackCwd, "switch", "-c", "remote-ahead", localTop);
	await save(stackCwd, `${bundle}/clarifications.json`, "Remote artifact change\n");
	const remoteAhead = await commitWorkflowArtifacts(exec, stackWorkflow, "Remote artifacts");
	await git(stackCwd, "switch", "workflow/top");
	assert.equal((await checkDelivery(withPullRequests([stackPrs[0], pr(2, "workflow/top", "workflow/current", remoteAhead)]), stackWorkflow)).ok, false, "remote-ahead artifact commits are not a local delivery");

	// Merges introducing content count; artifact-only merges do not.
	await git(stackCwd, "merge", "--no-ff", "other", "-m", "Merge code");
	const mergeHead = await git(stackCwd, "rev-parse", "HEAD");
	assert.equal(await workflowContentHead(exec, stackWorkflow), mergeHead);
	await git(stackCwd, "merge", "--no-ff", "remote-ahead", "-m", "Merge only artifacts");
	assert.equal(await workflowContentHead(exec, stackWorkflow), mergeHead);
	assert.equal(await workflowContentHead(exec, { ...stackWorkflow, baseCommit: diverged }), mergeHead, "base may be on merged ancestry");

	// If the base enters via an ours merge, bounded first-parent history can
	// return the base even though the local tree differs. Delivery must reject it.
	const unusual = await fixture("unusual-merge");
	await git(unusual.cwd, "switch", "-c", "alternate-base");
	await save(unusual.cwd, "code.txt", "alternate base content\n");
	await git(unusual.cwd, "commit", "-am", "Alternate base content");
	const alternateBase = await git(unusual.cwd, "rev-parse", "HEAD");
	await git(unusual.cwd, "switch", "workflow/current");
	await git(unusual.cwd, "merge", "--no-ff", "-s", "ours", "alternate-base", "-m", "Merge base without its content");
	const unusualWorkflow = { ...unusual.workflow, baseCommit: alternateBase };
	assert.equal(await workflowContentHead(exec, unusualWorkflow), alternateBase, "an out-of-base candidate falls back to the base");
	assert.match((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", alternateBase)]), unusualWorkflow)).message, /content differs/);

	// Exercise actual storage publication, not just the durable-path allowlist.
	const published = await fixture("directory-snapshots");
	const publishedFiles = workflowFiles(published.workflow.identifier, published.cwd);
	await createWorkflow(publishedFiles, published.workflow);
	assert.equal(await readPlanVersion(publishedFiles), undefined);
	await commitWorkflowArtifacts(exec, published.workflow, "Initialize planning metadata");
	assert.equal(await git(published.cwd, "ls-files", `${bundle}/plan-versions`, `${bundle}/latest-plan`), "", "initialization commits no placeholder version");
	const document = makePlanDocument();
	await writePlanDocument(publishedFiles.workingPlan, document);
	await finalizePlanDraft(publishedFiles, "First finalized snapshot", 0);
	const savedFirst = await commitWorkflowArtifacts(exec, published.workflow, "Save first finalized plan");
	assert.equal(await git(published.cwd, "show", `HEAD:${bundle}/latest-plan`), "plan-versions/v1");
	assert.equal(await git(published.cwd, "show", `HEAD:${bundle}/plan-versions/v1/goal.md`), document.goal);
	assert.match(await git(published.cwd, "show", `HEAD:${bundle}/plan-versions/v1/version-metadata.json`), /First finalized snapshot/);
	await preparePlanDraft(publishedFiles);
	await writePlanDocument(publishedFiles.workingPlan, { ...document, goal: "Publish a second immutable snapshot." });
	await finalizePlanDraft(publishedFiles, "Second finalized snapshot", 1);
	const savedSecond = await commitWorkflowArtifacts(exec, published.workflow, "Save second finalized plan");
	assert.notEqual(savedSecond, savedFirst);
	assert.equal(await git(published.cwd, "diff", savedFirst, savedSecond, "--", `${bundle}/plan-versions/v1`), "", "later saves never alter tracked version history");
	assert.equal(await git(published.cwd, "show", `HEAD:${bundle}/latest-plan`), "plan-versions/v2");
	assert.equal(await git(published.cwd, "ls-files", `${bundle}/working-plan`, `${bundle}/.plan-draft-base.json`, `${bundle}/plan.md`), "");
	assert.equal(await worktreeStatus(exec, published.cwd), "", "mutable drafts and lock bookkeeping stay ignored");

	// Every invalid history fails before staging, even when only an old version
	// was changed or the whole history and pointer were deleted together.
	await save(published.cwd, "code.txt", "Preserve unrelated staged code\n");
	await git(published.cwd, "add", "code.txt");
	const safeIndex = await git(published.cwd, "ls-files", "--stage", "-z");
	async function rejectHistory(pattern) {
		const start = calls.length;
		await assert.rejects(commitWorkflowArtifacts(exec, published.workflow, "Reject unsafe history"), pattern);
		assert.ok(!calls.slice(start).some(([command, ...args]) => command === "git" && (args.includes("add") || args.includes("commit"))), "history validation happens before staging");
		assert.equal(await git(published.cwd, "ls-files", "--stage", "-z"), safeIndex);
		assert.equal(await git(published.cwd, "rev-parse", "HEAD"), savedSecond);
	}
	const oldGoal = join(publishedFiles.versions, "v1", "goal.md");
	await writeFile(oldGoal, "A direct edit to an older finalized version.");
	await rejectHistory(/immutable finalized plan was modified/);
	await writeFile(oldGoal, document.goal);
	await rm(oldGoal);
	await rejectHistory(/goal.md: required file is missing/);
	await writeFile(oldGoal, document.goal);
	const snapshotBackup = join(publishedFiles.root, ".plan-publish-backup");
	await rename(join(publishedFiles.versions, "v1"), snapshotBackup);
	await rejectHistory(/v1.*ENOENT/s);
	await rename(snapshotBackup, join(publishedFiles.versions, "v1"));
	for (const name of ["v3", "v99", "v01", "notes"]) {
		const path = join(publishedFiles.versions, name);
		await mkdir(path);
		await writeFile(join(path, "keep.md"), "Preserve orphan recovery data");
		await rejectHistory(/unexpected or unpublished plan version path.*move the unexpected entry outside plan-versions/s);
		assert.equal(await readFile(join(path, "keep.md"), "utf8"), "Preserve orphan recovery data");
		await rm(path, { recursive: true });
	}
	await writeFile(join(publishedFiles.versions, "v3"), "Not a version directory");
	await rejectHistory(/unexpected or unpublished plan version path/);
	await rm(join(publishedFiles.versions, "v3"));
	await rm(publishedFiles.latestPlan);
	await rejectHistory(/unexpected or unpublished plan version path/);
	await rename(publishedFiles.versions, snapshotBackup);
	await rejectHistory(/missing or is not part of the published plan history/);
	await rename(snapshotBackup, publishedFiles.versions);
	await symlink("plan-versions/v2", publishedFiles.latestPlan, "dir");
	assert.equal(await commitWorkflowArtifacts(exec, published.workflow, "History restored"), undefined);
	assert.equal(await git(published.cwd, "ls-files", "--stage", "-z"), safeIndex);

	assert.ok(!calls.some(([command, ...args]) => command === "git" && args.includes("push")));
	console.log("Artifact Git tests passed (real worktrees, selective commits, meaningful heads, and PR delivery).");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
