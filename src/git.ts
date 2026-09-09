import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertIdentifier, pathExists, type CompletedWorkflowMetadata } from "./storage.ts";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export interface RepositoryIdentity {
	root: string;
	commonDir: string;
}

export async function repositoryIdentity(exec: ExecFn, cwd: string): Promise<RepositoryIdentity | undefined> {
	const [rootResult, commonResult] = await Promise.all([
		exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
		exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
	]);
	if (rootResult.code !== 0 || commonResult.code !== 0) return undefined;
	return {
		root: resolve(rootResult.stdout.trim()),
		commonDir: resolve(commonResult.stdout.trim()),
	};
}

export async function gitOutput(exec: ExecFn, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await exec("git", ["-C", cwd, ...args]);
	if (result.code !== 0) return undefined;
	return result.stdout.trim();
}

export async function gitValue(exec: ExecFn, cwd: string, args: string[]): Promise<string | undefined> {
	const output = await gitOutput(exec, cwd, args);
	return output || undefined;
}

export async function isAncestor(
	exec: ExecFn,
	cwd: string,
	ancestor: string,
	descendant: string,
): Promise<boolean> {
	const result = await exec("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant]);
	return result.code === 0;
}

/** Returns a failure message when the recorded worktree is unusable, or undefined when valid. */
export async function validateWorktree(
	exec: ExecFn,
	workflow: CompletedWorkflowMetadata,
): Promise<string | undefined> {
	if (!(await pathExists(workflow.worktreePath))) return `worktree is missing: ${workflow.worktreePath}`;
	const [branch, commonDir, containsBaseCommit] = await Promise.all([
		gitValue(exec, workflow.worktreePath, ["branch", "--show-current"]),
		gitValue(exec, workflow.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		isAncestor(exec, workflow.worktreePath, workflow.baseCommit, "HEAD"),
	]);
	if (!branch) return "the workflow worktree has no checked-out branch";
	if (branch === workflow.baseBranch) return `the workflow worktree is on base branch ${branch}`;
	if (!commonDir || resolve(commonDir) !== resolve(workflow.gitCommonDir)) {
		return "the recorded worktree belongs to a different Git repository";
	}
	if (!containsBaseCommit) {
		return "the checked-out branch does not contain the recorded base commit";
	}
	return undefined;
}

/** Returns the porcelain status output, or undefined when the worktree cannot be inspected. */
export async function worktreeStatus(exec: ExecFn, worktreePath: string): Promise<string | undefined> {
	return gitOutput(exec, worktreePath, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
}

/** Only local/disposable files are ignored; every workflow's durable bundle stays trackable. */
export async function installWorkflowExcludes(commonDir: string): Promise<void> {
	const excludePath = join(commonDir, "info", "exclude");
	await mkdir(dirname(excludePath), { recursive: true });
	let content = "";
	try {
		content = await readFile(excludePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const existing = new Set(content.split("\n").map((line) => line.trim()));
	const missing = [
		"/.worktrees/",
		"/.workflows/active.json",
		"/.workflows/*/working-plan.md",
		"/.workflows/*/dashboard.html",
		"/.workflows/*/review-runs/",
	].filter((pattern) => !existing.has(pattern));
	if (missing.length === 0) return;
	const prefix = content && !content.endsWith("\n") ? "\n" : "";
	await appendFile(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
}

/** @deprecated Use installWorkflowExcludes, which also excludes disposable workflow files. */
export const installWorktreeExclude = installWorkflowExcludes;

/**
 * Commits the saved durable files of this workflow, never the caller's other
 * staged changes. Returns the new commit ID, or undefined if saved files match
 * HEAD. Does not push. Failures leave the durable files available for retry.
 */
export async function commitWorkflowArtifacts(
	exec: ExecFn,
	workflow: CompletedWorkflowMetadata,
	message: string,
): Promise<string | undefined> {
	assertIdentifier(workflow.identifier);
	if (!message.trim()) throw new Error("Workflow artifact commits require a non-empty message.");
	const cwd = workflow.worktreePath;
	const invalid = await validateWorktree(exec, workflow);
	if (invalid) throw new Error(`Cannot commit workflow artifacts: ${invalid}.`);
	const root = await gitValue(exec, cwd, ["rev-parse", "--show-toplevel"]);
	if (!root || resolve(root) !== resolve(cwd)) {
		throw new Error("Cannot commit workflow artifacts: the recorded path is not the worktree root.");
	}

	const bundle = `.workflows/${workflow.identifier}`;
	// Do not follow a replaced bundle/history directory outside the worktree.
	for (const path of [".workflows", bundle, `${bundle}/versions`, `${bundle}/reviews`]) {
		try {
			const info = await lstat(join(cwd, path));
			if (!info.isDirectory() || info.isSymbolicLink()) {
				throw new Error(`Cannot commit workflow artifacts: ${path} is not a real directory.`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	const durable = ["plan.md", "versions", "clarifications.json", "metadata.json", "reviews", "review.json", "review.md"]
		.map((path) => `:(top,literal)${bundle}/${path}`);
	// Enumerate existing/tracked paths first: absent optional exports must not
	// make git add/commit fail, and tracked deletions must still be committed.
	const listed = await artifactGit(exec, cwd, ["ls-files", "--cached", "--others", "-z", "--", ...durable]);
	const changed = await artifactGit(exec, cwd, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--", ...durable]);
	const listedPaths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
	const paths = [...new Set([...listedPaths, ...changed.stdout.split("\0").filter(Boolean)])]
		.map((path) => `:(top,literal)${path}`);
	if (paths.length === 0) return undefined;
	// Force only these allowlisted paths: a repository-wide *.json ignore must
	// not silently discard saved metadata/reports. Already-staged deletions
	// are absent from ls-files and must not be passed to git add again.
	if (listedPaths.length > 0) {
		await artifactGit(exec, cwd, ["add", "--all", "--force", "--", ...listedPaths.map((path) => `:(top,literal)${path}`)]);
	}
	const diff = await exec("git", ["-C", cwd, "diff", "--cached", "--quiet", "HEAD", "--", ...paths]);
	if (diff.code === 0) return undefined;
	if (diff.code !== 1) throw artifactGitError("inspect changes", diff);

	// --only builds the commit from HEAD plus these worktree paths, preserving
	// unrelated index entries (including partially staged implementation files).
	// Artifact bookkeeping must not run code hooks that can modify/stage code.
	await artifactGit(exec, cwd, ["-c", "core.hooksPath=/dev/null", "commit", "--only", "-m", message, "--", ...paths]);
	const committed = await artifactGit(exec, cwd, ["rev-parse", "HEAD"]);
	const head = committed.stdout.trim();
	if (!head) throw new Error("Workflow artifacts were committed, but Git did not return the new commit ID.");
	return head;
}

async function artifactGit(exec: ExecFn, cwd: string, args: string[]): Promise<ExecResult> {
	const result = await exec("git", ["-C", cwd, ...args]);
	if (result.code !== 0) throw artifactGitError(args.includes("commit") ? "commit saved files" : args[0]!, result);
	return result;
}

function artifactGitError(action: string, result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim() || `Git exited with status ${result.code}`;
	return new Error(`Could not ${action} for workflow artifacts: ${detail}`);
}

/**
 * The latest first-parent commit changing repository content, not .workflows.
 * Artifact-only preparation/report commits must not invalidate their own
 * reviews or count as implementation. Never return a commit before/outside
 * the recorded base, even when that base is itself an artifact-only commit.
 * Returns undefined when HEAD/history cannot be inspected or lacks the base.
 */
export async function workflowContentHead(
	exec: ExecFn,
	workflow: CompletedWorkflowMetadata,
): Promise<string | undefined> {
	const cwd = workflow.worktreePath;
	const head = await gitValue(exec, cwd, ["rev-parse", "HEAD"]);
	if (!head || !(await isAncestor(exec, cwd, workflow.baseCommit, head))) return undefined;
	const candidate = await gitOutput(exec, cwd, [
		"log", "-1", "--format=%H", "--first-parent", head, "--", ":(top)**", ":(top,exclude).workflows",
	]);
	if (candidate === undefined) return undefined;
	if (!candidate || !(await isAncestor(exec, cwd, workflow.baseCommit, candidate))) return workflow.baseCommit;
	return candidate;
}

export function isPathInside(candidate: string, parent: string): boolean {
	const resolvedParent = resolve(parent);
	const resolvedCandidate = resolve(candidate);
	return (
		resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}/`)
	);
}
