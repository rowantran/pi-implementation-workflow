import { execFile } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type ExecFn = (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

/** Plain child_process runner with the same shape as pi.exec, for tests and scripts. */
export const nodeExec: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
				? ((error as { code: number }).code)
				: error ? 1 : 0;
			resolve({ stdout: String(stdout), stderr: String(stderr), code });
		});
	});

/** Trimmed stdout of a git command, or undefined when it fails. */
export async function git(exec: ExecFn, cwd: string, args: string[]): Promise<string | undefined> {
	const result = await exec("git", ["-C", cwd, ...args]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export interface RepositoryIdentity {
	/** Top level of the checkout containing cwd (a worktree or the main checkout). */
	worktree: string;
	/** Top level of the main checkout that owns the shared .git directory. */
	repositoryRoot: string;
}

export async function repositoryIdentity(exec: ExecFn, cwd: string): Promise<RepositoryIdentity | undefined> {
	const worktree = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
	const list = await git(exec, cwd, ["worktree", "list", "--porcelain"]);
	const repositoryRoot = list?.split("\n")[0]?.replace(/^worktree /, "");
	if (!worktree || !repositoryRoot) return undefined;
	return { worktree, repositoryRoot };
}

/** `git status --porcelain` output; empty string means clean; undefined means git failed. */
export function worktreeStatus(exec: ExecFn, cwd: string): Promise<string | undefined> {
	return git(exec, cwd, ["status", "--porcelain"]);
}
