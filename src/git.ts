import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathExists, type CompletedWorkflowMetadata } from "./storage.ts";

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

/** Keep nested worktrees local. Repositories provide their own .workflows ignore rule. */
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
	].filter((pattern) => !existing.has(pattern));
	if (missing.length === 0) return;
	const prefix = content && !content.endsWith("\n") ? "\n" : "";
	await appendFile(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
}

/** @deprecated Use installWorkflowExcludes. */
export const installWorktreeExclude = installWorkflowExcludes;

/**
 * The latest first-parent commit changing repository content, not .workflows.
 * Legacy artifact-only commits do not count as implementation.
 * Never return a commit before/outside
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
