import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti/static";
import { makePlanDocument, writePlanDocument } from "./fixtures/plan-document.mjs";

const runFile = promisify(execFile);
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-workflow-artifact-git-")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { installWorkflowExcludes, workflowContentHead, worktreeStatus } =
	await jiti.import(new URL("../src/git.ts", import.meta.url).pathname);
const { checkDelivery } = await jiti.import(new URL("../src/delivery.ts", import.meta.url).pathname);
const {
	appendClarifications, appendWorkflowReview, createWorkflow, workflowFiles,
	preparePlanDraft, finalizePlanDraft, readClarifications, readPlanVersion, readWorkflowReview,
} = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const calls = [];
const bundle = ".workflows/current";

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

async function fixture(name, { legacyBase = false } = {}) {
	const root = join(temporaryRoot, name);
	await mkdir(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Artifact Test");
	await git(root, "config", "user.email", "artifact-test@example.invalid");
	await git(root, "config", "commit.gpgSign", "false");
	await save(root, "code.txt", "original code\n");
	await save(root, "partial.txt", "original partial\n");
	await save(root, "removed.txt", "original removed\n");
	// Consumer repositories already ignore every workflow bundle themselves.
	await save(root, ".gitignore", ".workflows/\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "Initial content");
	const initialContent = await git(root, "rev-parse", "HEAD");
	if (legacyBase) {
		await save(root, ".workflows/previous/plan.md", "Prior workflow plan\n");
		// Force-add only to reconstruct history from releases that tracked artifacts.
		await git(root, "add", "--force", ".workflows/previous/plan.md");
		await git(root, "commit", "-m", "Legacy workflow artifacts");
	}
	const baseCommit = await git(root, "rev-parse", "HEAD");
	const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	await writeFile(join(commonDir, "info", "exclude"), "# Keep user excludes\n/local-user-file");
	await installWorkflowExcludes(commonDir);
	const worktreePath = join(root, ".worktrees", "current");
	await git(root, "worktree", "add", "-b", "workflow/current", worktreePath, "HEAD");
	const workflow = {
		version: 6,
		identifier: "current",
		ask: "Test local workflow artifacts",
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

async function gitState(cwd) {
	return {
		head: await git(cwd, "rev-parse", "HEAD"),
		staged: await git(cwd, "diff", "--cached", "--binary"),
		unstaged: await git(cwd, "diff", "--binary"),
		entries: await git(cwd, "ls-files", "--stage", "-z"),
		index: await readFile(await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index")),
	};
}

async function storageOnly(cwd, action, message) {
	const before = await gitState(cwd);
	const result = await action();
	assert.deepEqual(await gitState(cwd), before, `${message}: HEAD, index bytes, and code diffs must not change`);
	return result;
}

async function assertIgnoredArtifacts(cwd, directory = ".workflows") {
	const paths = [];
	for (const entry of await readdir(join(cwd, directory), { withFileTypes: true })) {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) paths.push(...await assertIgnoredArtifacts(cwd, path));
		else {
			assert.equal(await git(cwd, "check-ignore", "--verbose", "--", path), `.gitignore:1:.workflows/\t${path}`, `${path} is ignored by the consumer repository`);
			paths.push(path);
		}
	}
	return paths;
}

function clarification(id) {
	return { id, label: "Artifact storage", question: "Where are artifacts saved?", answer: "Locally, outside Git history.", custom: true, answeredAt: new Date().toISOString() };
}

function review(workflow, headCommit) {
	const verdict = { status: "yes", explanation: "The focused tests pass." };
	return {
		version: 3,
		pullRequestUrls: [pr(1, "workflow/current", "main", headCommit).url],
		baseCommit: workflow.baseCommit,
		headCommit,
		generatedAt: new Date().toISOString(),
		overallResult: { summary: "Local workflow storage verified.", necessary: verdict, sufficient: verdict },
		overallConcerns: [],
		plannedChanges: [],
		testingCriteria: {
			originalCriteria: "Run the focused tests.",
			review: {
				summary: "Tests passed.", satisfied: verdict, concerns: [],
				criteria: [{ criterion: "Focused tests pass", status: "yes", explanation: "Verified locally.", evidence: [{ location: "code.txt:1", description: "Implemented content" }] }],
			},
		},
	};
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

function assertDelivered(delivery, headCommit, deliveryHeadCommit = headCommit) {
	assert.equal(delivery.ok, true, JSON.stringify(delivery));
	assert.equal(delivery.headCommit, headCommit);
	assert.equal(delivery.deliveryHeadCommit, deliveryHeadCommit);
	assert.equal(delivery.artifactsUnpushed, deliveryHeadCommit !== headCommit);
}

try {
	const { root, workflow, cwd, commonDir, baseCommit } = await fixture("local-storage");
	const excludePath = join(commonDir, "info", "exclude");
	const excludes = await readFile(excludePath, "utf8");
	assert.equal(excludes, "# Keep user excludes\n/local-user-file\n/.worktrees/\n", "installation only adds the nested-worktree exclusion");
	await storageOnly(cwd, () => installWorkflowExcludes(commonDir), "exclude installation");
	assert.equal(await readFile(excludePath, "utf8"), excludes, "exclude installation is idempotent");
	assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ".workflows/\n", "consumer ignore rules are not rewritten");
	assert.equal(await worktreeStatus(exec, root), "", "nested worktrees do not dirty the original checkout");
	assert.equal(await workflowContentHead(exec, workflow), baseCommit);

	// Exercise storage publication directly: nothing stages or commits these files.
	const files = workflowFiles(workflow.identifier, cwd);
	await storageOnly(cwd, () => createWorkflow(files, workflow), "workflow initialization");
	assert.equal(await readPlanVersion(files), undefined, "initialization creates no placeholder version");
	const document = makePlanDocument({ intro: "Save plans and reports locally." });
	await storageOnly(cwd, async () => {
		await writePlanDocument(files.workingPlan, document);
		await finalizePlanDraft(files, "First finalized snapshot", 0);
	}, "first plan finalization");
	const firstPlan = await readPlanVersion(files, 1);
	assert.ok(firstPlan);
	assert.equal(await readlink(files.latestPlan), "plan-versions/v1");
	assert.equal(await readFile(join(files.versions, "v1", "goal.md"), "utf8"), document.goal);
	await storageOnly(cwd, async () => {
		await appendClarifications(files, [clarification("first")]);
		assert.equal((await appendWorkflowReview(files, review(workflow, baseCommit))).number, 1);
	}, "clarification and review persistence");
	assert.equal((await readClarifications(files)).entries[0].answer, "Locally, outside Git history.");
	assert.equal((await readWorkflowReview(files)).headCommit, baseCommit);
	assert.equal(await worktreeStatus(exec, cwd), "", "finalized plans, reports, and clarifications are local, ignored files");
	assert.equal(await git(cwd, "ls-files", ".workflows"), "");
	assert.equal(await git(cwd, "rev-parse", "HEAD"), baseCommit);

	// Storage also leaves staged additions/deletions and partial staging untouched.
	await save(cwd, "code.txt", "staged code\n");
	await save(cwd, "partial.txt", "staged partial\n");
	await save(cwd, "new file.txt", "staged new file\n");
	await git(cwd, "add", "code.txt", "partial.txt", "new file.txt");
	await git(cwd, "rm", "removed.txt");
	await save(cwd, "partial.txt", "unstaged partial\n");
	const hook = join(commonDir, "hooks", "pre-commit");
	await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' > code.txt\ngit add code.txt\nexit 1\n");
	await chmod(hook, 0o755);
	const indexLock = await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
	await writeFile(indexLock, "Another process owns this lock\n");
	await storageOnly(cwd, async () => {
		await preparePlanDraft(files);
		await writePlanDocument(files.workingPlan, { ...document, goal: "Publish a second immutable local snapshot." });
		await finalizePlanDraft(files, "Second finalized snapshot", 1);
		await appendClarifications(files, [clarification("second")]);
		assert.equal((await appendWorkflowReview(files, review(workflow, baseCommit))).number, 2);
	}, "storage with a dirty index, Git lock, and commit hook");
	assert.equal(await readFile(indexLock, "utf8"), "Another process owns this lock\n", "storage never removes another Git process's lock");
	assert.equal(await readFile(join(cwd, "code.txt"), "utf8"), "staged code\n", "storage never runs Git hooks");
	await rm(indexLock);
	await rm(hook);
	assert.deepEqual(await readPlanVersion(files, 1), firstPlan, "later finalization preserves the first immutable snapshot");
	assert.equal(await readlink(files.latestPlan), "plan-versions/v2");
	assert.match(await readFile(join(files.versions, "v2", "version-metadata.json"), "utf8"), /Second finalized snapshot/);
	assert.equal(await workflowContentHead(exec, workflow), baseCommit);
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", baseCommit)]), workflow)).stage, "worktree", "local artifacts cannot hide dirty code");
	await git(cwd, "reset", "--hard", "HEAD");
	assert.equal(await readlink(files.latestPlan), "plan-versions/v2", "Git reset leaves local plans intact");

	// The repository-wide rule covers all bundles and generated files, not an allowlist.
	for (const path of [
		".workflows/active.json", ".workflows/another/plan-versions/v1/goal.md",
		`${bundle}/plan.md`, `${bundle}/scratch.txt`, `${bundle}/dashboard.html`,
		`${bundle}/.plan.lock`, `${bundle}/.plan-publish-example/goal.md`,
		`${bundle}/.plan-prepare-example/goal.md`, `${bundle}/.plan-base-example.tmp`,
		`${bundle}/.latest-plan-example.tmp`, `${bundle}/review-runs/attempt/result.json`,
	]) await save(cwd, path, "generated\n");
	const ignored = await assertIgnoredArtifacts(cwd);
	for (const path of ["latest-plan", "plan-versions/v1/goal.md", "plan-versions/v2/goal.md", "clarifications.json", "metadata.json", "review.json", "review.md", "reviews/0001.json", "reviews/0002.md", "working-plan/plan.json", ".plan-draft-base.json"]) {
		assert.ok(ignored.includes(`${bundle}/${path}`), `${path} exists and stays ignored`);
	}
	await git(cwd, "add", ".");
	assert.equal(await git(cwd, "diff", "--cached", "--name-only"), "", "ordinary git add . stages no workflow files");
	assert.equal(await git(cwd, "ls-files", ".workflows"), "");
	assert.equal(await worktreeStatus(exec, cwd), "");
	await save(root, ".workflows/local-note.md", "Local note in the original checkout\n");
	await git(root, "add", ".");
	assert.equal(await worktreeStatus(exec, root), "", "ordinary git add . in the original checkout ignores artifacts and nested worktrees");

	await save(cwd, "code.txt", "implemented code\n");
	await git(cwd, "add", ".");
	assert.equal(await git(cwd, "diff", "--cached", "--name-only"), "code.txt", "normal staging includes only implementation content");
	await git(cwd, "commit", "-m", "Implement content");
	const contentHead = await git(cwd, "rev-parse", "HEAD");
	assert.equal(await git(cwd, "ls-tree", "-r", "--name-only", "HEAD", "--", ".workflows"), "", "implementation commits contain no workflow artifacts");
	assert.equal(await workflowContentHead(exec, workflow), contentHead);
	const contentPrs = [pr(1, "workflow/current", "main", contentHead)];
	assertDelivered(await checkDelivery(withPullRequests(contentPrs), workflow), contentHead);
	await storageOnly(cwd, async () => {
		await appendWorkflowReview(files, review(workflow, contentHead));
		await appendClarifications(files, [clarification("after-review")]);
	}, "saving a review of delivered content");
	assert.equal((await readWorkflowReview(files)).headCommit, contentHead);
	assert.equal(await workflowContentHead(exec, workflow), contentHead, "saving a report cannot invalidate its content head");
	assertDelivered(await checkDelivery(withPullRequests(contentPrs), workflow), contentHead);

	await save(cwd, "hidden-by-config.txt", "untracked code\n");
	await git(cwd, "config", "status.showUntrackedFiles", "no");
	assert.match(await worktreeStatus(exec, cwd), /hidden-by-config/);
	assert.equal((await checkDelivery(withPullRequests(contentPrs), workflow)).stage, "worktree", "untracked code blocks delivery even when user config hides it");
	await rm(join(cwd, "hidden-by-config.txt"));
	await save(cwd, "code.txt", "unpushed implementation\n");
	assert.equal((await checkDelivery(withPullRequests(contentPrs), workflow)).stage, "worktree", "unstaged code blocks delivery");
	await git(cwd, "commit", "-am", "Unpushed code");
	assert.match((await checkDelivery(withPullRequests(contentPrs), workflow)).message, /not been pushed/);
	const unpushedHead = await git(cwd, "rev-parse", "HEAD");
	assertDelivered(await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", unpushedHead)]), workflow), unpushedHead);
	assert.equal(await workflowContentHead(async (command, args, options) => args.includes("log") ? { code: 128, stdout: "", stderr: "bad history" } : exec(command, args, options), workflow), undefined);
	assert.equal(await workflowContentHead(exec, { ...workflow, baseCommit: "0000000000000000000000000000000000000000" }), undefined);

	// Existing artifact-only history remains readable, but is never created by storage.
	const legacy = await fixture("legacy-history", { legacyBase: true });
	assert.notEqual(legacy.initialContent, legacy.baseCommit);
	assert.equal(await workflowContentHead(exec, legacy.workflow), legacy.baseCommit, "an artifact-only base bounds older content history");
	await save(legacy.cwd, `${bundle}/plan.md`, "Legacy approved plan\n");
	await git(legacy.cwd, "add", "--force", `${bundle}/plan.md`);
	await git(legacy.cwd, "commit", "-m", "Legacy approved artifacts");
	const legacyPreparation = await git(legacy.cwd, "rev-parse", "HEAD");
	assert.equal(await workflowContentHead(exec, legacy.workflow), legacy.baseCommit, "legacy planning commits are not implementation");
	assertDelivered(await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", legacy.baseCommit)]), legacy.workflow), legacy.baseCommit, legacyPreparation);
	await save(legacy.cwd, "code.txt", "legacy implementation\n");
	await git(legacy.cwd, "commit", "-am", "Legacy implementation");
	const legacyContent = await git(legacy.cwd, "rev-parse", "HEAD");
	await save(legacy.cwd, `${bundle}/review.json`, `${JSON.stringify({ headCommit: legacyContent })}\n`);
	await git(legacy.cwd, "add", "--force", `${bundle}/review.json`);
	await git(legacy.cwd, "commit", "-m", "Legacy saved report");
	const legacyReport = await git(legacy.cwd, "rev-parse", "HEAD");
	assert.equal(await workflowContentHead(exec, legacy.workflow), legacyContent);
	assertDelivered(await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", legacyContent)]), legacy.workflow), legacyContent, legacyReport);
	const fullyPushedLegacy = await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", legacyReport)]), legacy.workflow);
	assert.equal(fullyPushedLegacy.ok, true);
	assert.equal(fullyPushedLegacy.headCommit, legacyContent);
	assert.equal(fullyPushedLegacy.artifactsUnpushed, false);
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", legacyPreparation)]), legacy.workflow)).ok, false, "legacy report commits cannot excuse unpushed code");
	await save(legacy.cwd, `${bundle}/review.json`, "Modified tracked legacy report\n");
	assert.equal((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", legacyContent)]), legacy.workflow)).stage, "worktree", "ignore rules do not hide modifications to already-tracked legacy files");
	await git(legacy.cwd, "rm", "--force", `${bundle}/review.json`);
	await git(legacy.cwd, "commit", "-m", "Remove legacy report");
	assert.equal(await workflowContentHead(exec, legacy.workflow), legacyContent, "legacy artifact-only deletions do not advance content head");

	// Modern PR stacks deliver code without any artifact commits.
	const stack = await fixture("stack");
	await save(stack.cwd, "code.txt", "bottom implementation\n");
	await git(stack.cwd, "commit", "-am", "Bottom code");
	const bottom = await git(stack.cwd, "rev-parse", "HEAD");
	await git(stack.cwd, "switch", "-c", "workflow/top");
	await save(stack.cwd, "partial.txt", "top implementation\n");
	await git(stack.cwd, "commit", "-am", "Top code");
	const top = await git(stack.cwd, "rev-parse", "HEAD");
	await save(stack.cwd, `${bundle}/clarifications.json`, "Local stack clarifications\n");
	const stackPrs = [pr(1, "workflow/current", "main", bottom), pr(2, "workflow/top", "workflow/current", top)];
	const stackDelivery = await checkDelivery(withPullRequests(stackPrs), stack.workflow);
	assertDelivered(stackDelivery, top);
	assert.deepEqual(stackDelivery.pullRequests.map((item) => item.number), [1, 2]);
	assert.equal(await git(stack.cwd, "ls-tree", "-r", "--name-only", "HEAD", "--", ".workflows"), "");
	assert.match((await checkDelivery(withPullRequests([pr(2, "workflow/top", "main", top)]), stack.workflow)).message, /bottom pull request/);
	assert.match((await checkDelivery(withPullRequests([pr(2, "workflow/top", "missing", top)]), stack.workflow)).message, /no open pull request/);
	assert.match((await checkDelivery(withPullRequests([stackPrs[0], stackPrs[1], { ...stackPrs[1], number: 3 }]), stack.workflow)).message, /multiple/);
	assert.match((await checkDelivery(withPullRequests([pr(1, "workflow/current", "workflow/top", bottom), stackPrs[1]]), stack.workflow)).message, /cycle/);

	await git(stack.cwd, "switch", "-c", "other", stack.workflow.baseCommit);
	await save(stack.cwd, "unrelated.txt", "diverged code\n");
	await git(stack.cwd, "add", "unrelated.txt");
	await git(stack.cwd, "commit", "-m", "Unrelated branch");
	const diverged = await git(stack.cwd, "rev-parse", "HEAD");
	await git(stack.cwd, "switch", "workflow/top");
	assert.match((await checkDelivery(withPullRequests([pr(1, "workflow/current", "main", diverged), stackPrs[1]]), stack.workflow)).message, /does not contain/);
	assert.match((await checkDelivery(withPullRequests([stackPrs[0], pr(2, "workflow/top", "workflow/current", diverged)]), stack.workflow)).message, /diverged/);

	// Reconstruct old stack/report history explicitly for ancestry compatibility.
	await save(stack.cwd, ".workflows/legacy/report.md", "Legacy stack report\n");
	await git(stack.cwd, "add", "--force", ".workflows/legacy/report.md");
	await git(stack.cwd, "commit", "-m", "Legacy stack report");
	const localTop = await git(stack.cwd, "rev-parse", "HEAD");
	assertDelivered(await checkDelivery(withPullRequests(stackPrs), stack.workflow), top, localTop);
	await git(stack.cwd, "switch", "-c", "remote-ahead", localTop);
	await save(stack.cwd, ".workflows/legacy/remote-report.md", "Remote legacy report\n");
	await git(stack.cwd, "add", "--force", ".workflows/legacy/remote-report.md");
	await git(stack.cwd, "commit", "-m", "Remote legacy artifacts");
	const remoteAhead = await git(stack.cwd, "rev-parse", "HEAD");
	await git(stack.cwd, "switch", "workflow/top");
	assert.equal((await checkDelivery(withPullRequests([stackPrs[0], pr(2, "workflow/top", "workflow/current", remoteAhead)]), stack.workflow)).ok, false, "remote-ahead artifact commits are not a local delivery");

	// Merges introducing content count; legacy artifact-only merges do not.
	await git(stack.cwd, "merge", "--no-ff", "other", "-m", "Merge code");
	const mergeHead = await git(stack.cwd, "rev-parse", "HEAD");
	assert.equal(await workflowContentHead(exec, stack.workflow), mergeHead);
	await git(stack.cwd, "merge", "--no-ff", "remote-ahead", "-m", "Merge only legacy artifacts");
	assert.equal(await workflowContentHead(exec, stack.workflow), mergeHead);
	assert.equal(await workflowContentHead(exec, { ...stack.workflow, baseCommit: diverged }), mergeHead, "base may be on merged ancestry");

	// Bounded first-parent history alone cannot validate an ours merge of the base.
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
	console.log("Artifact Git tests passed (ignored local storage, unchanged Git state, legacy content heads, and PR delivery).");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
