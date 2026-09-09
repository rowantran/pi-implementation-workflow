import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti/static";

const runFile = promisify(execFile);
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-workflow-artifact-git-")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { commitWorkflowArtifacts, installWorkflowExcludes, workflowContentHead, worktreeStatus } =
	await jiti.import(new URL("../src/git.ts", import.meta.url).pathname);
const { checkDelivery } = await jiti.import(new URL("../src/delivery.ts", import.meta.url).pathname);
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
		version: 1,
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

	const durable = ["plan.md", "versions/0001.md", "clarifications.json", "metadata.json", "review.json", "review.md", "reviews/0001.json", "reviews/0001.md"];
	for (const path of durable) await save(cwd, `${bundle}/${path}`, `Saved ${path}\n`);
	const disposable = [".workflows/active.json", `${bundle}/working-plan.md`, `${bundle}/dashboard.html`, `${bundle}/review-runs/attempt/result.json`];
	for (const path of disposable) {
		await save(cwd, path, "generated\n");
		assert.equal((await exec("git", ["-C", cwd, "check-ignore", "-q", path])).code, 0, `${path} must be ignored`);
	}
	assert.equal(await git(cwd, "ls-files", ".workflows/previous/plan.md"), ".workflows/previous/plan.md");
	await save(cwd, ".workflows/another/plan.md", "Another bundle\n");
	assert.equal((await exec("git", ["-C", cwd, "check-ignore", "-q", ".workflows/another/plan.md"])).code, 1);

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
	await rm(join(cwd, `${bundle}/versions/0001.md`));
	assert.ok(await commitWorkflowArtifacts(exec, workflow, "Remove saved artifacts"), "staged and unstaged durable deletions are committed");
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
	await save(cwd, `${bundle}/plan.md`, "Updated saved plan\n");
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
	await save(stackCwd, `${bundle}/plan.md`, "Stack plan\n");
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
	await save(stackCwd, `${bundle}/plan.md`, "Remote artifact change\n");
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

	assert.ok(!calls.some(([command, ...args]) => command === "git" && args.includes("push")));
	console.log("Artifact Git tests passed (real worktrees, selective commits, meaningful heads, and PR delivery).");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
