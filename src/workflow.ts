import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, type ExecFn } from "./git.ts";
import { isRecord, isSlug, readOptional, writePlanSkeleton } from "./plan.ts";
import { text } from "./prompts.ts";

export const WORKFLOWS_DIR = ".workflows";
export const WORKTREES_DIR = ".worktrees";
export const BRANCH_PREFIX = "workflow/";

export interface Workflow {
	id: string;
	/** Verbatim user ask. Never edited after creation. */
	ask: string;
	baseBranch: string;
	baseCommit: string;
	branch: string;
	createdAt: string;
}

export interface WorkflowLocation {
	id: string;
	repositoryRoot: string;
	worktree: string;
	/** <worktree>/.workflows/<id> */
	root: string;
	manifest: string;
	plan: string;
	review: string;
	clarifications: string;
	dashboard: string;
}

export interface Clarification {
	question: string;
	answer: string;
	/** True when the user typed a free-text answer instead of picking an option. */
	custom: boolean;
	answeredAt: string;
}

export function workflowLocation(repositoryRoot: string, worktree: string, id: string): WorkflowLocation {
	const root = join(worktree, WORKFLOWS_DIR, id);
	return {
		id,
		repositoryRoot,
		worktree,
		root,
		manifest: join(root, "workflow.json"),
		plan: join(root, "plan"),
		review: join(root, "review"),
		clarifications: join(root, "clarifications.json"),
		dashboard: join(root, "dashboard.html"),
	};
}

export async function readWorkflow(location: WorkflowLocation): Promise<Workflow> {
	const raw = await readFile(location.manifest, "utf8");
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value) || value.id !== location.id || typeof value.ask !== "string" || typeof value.baseBranch !== "string" ||
		typeof value.baseCommit !== "string" || typeof value.branch !== "string" || typeof value.createdAt !== "string") {
		throw new Error(text("messages.invalid_workflow_file", { path: location.manifest }));
	}
	return { id: value.id, ask: value.ask, baseBranch: value.baseBranch, baseCommit: value.baseCommit, branch: value.branch, createdAt: value.createdAt };
}

/** True when no worktree directory, workflow directory, or branch already uses the id. */
export async function isIdAvailable(exec: ExecFn, repositoryRoot: string, id: string): Promise<boolean> {
	if (await exists(join(repositoryRoot, WORKTREES_DIR, id)) || await exists(join(repositoryRoot, WORKFLOWS_DIR, id))) return false;
	const branch = await exec("git", ["-C", repositoryRoot, "show-ref", "--verify", "--quiet", `refs/heads/${BRANCH_PREFIX}${id}`]);
	return branch.code === 1;
}

/**
 * Creates the branch, worktree, and workflow directory. The worktree starts at
 * the current HEAD of `repositoryRoot`. Rolls back the worktree and branch if
 * the workflow files cannot be written.
 */
export async function createWorkflow(
	exec: ExecFn,
	input: { repositoryRoot: string; id: string; ask: string },
): Promise<{ workflow: Workflow; location: WorkflowLocation }> {
	const { repositoryRoot, id, ask } = input;
	if (!isSlug(id)) throw new Error(`Invalid workflow id: ${id}`);
	const [baseBranch, baseCommit] = await Promise.all([
		git(exec, repositoryRoot, ["branch", "--show-current"]),
		git(exec, repositoryRoot, ["rev-parse", "HEAD"]),
	]);
	if (!baseBranch || !baseCommit) throw new Error("The repository needs a checked-out branch with at least one commit.");
	const worktree = join(repositoryRoot, WORKTREES_DIR, id);
	const branch = `${BRANCH_PREFIX}${id}`;
	await installExcludes(exec, repositoryRoot);
	await mkdir(join(repositoryRoot, WORKTREES_DIR), { recursive: true });
	const added = await exec("git", ["-C", repositoryRoot, "worktree", "add", "-b", branch, worktree, baseCommit]);
	if (added.code !== 0) throw new Error(`Could not create worktree: ${added.stderr || added.stdout}`);
	const location = workflowLocation(repositoryRoot, worktree, id);
	const workflow: Workflow = { id, ask, baseBranch, baseCommit, branch, createdAt: new Date().toISOString() };
	try {
		await mkdir(location.root, { recursive: true });
		await writeFile(location.manifest, `${JSON.stringify(workflow, null, 2)}\n`, { flag: "wx" });
		await writeFile(location.clarifications, "[]\n", { flag: "wx" });
		await writePlanSkeleton(location.plan);
	} catch (error) {
		await exec("git", ["-C", repositoryRoot, "worktree", "remove", "--force", worktree]);
		await exec("git", ["-C", repositoryRoot, "branch", "-D", branch]);
		throw error;
	}
	return { workflow, location };
}

/** The workflow stored in the given checkout, when there is exactly one. */
export async function findWorkflowHere(repositoryRoot: string, worktree: string): Promise<WorkflowLocation | undefined> {
	const ids = await workflowIds(join(worktree, WORKFLOWS_DIR));
	return ids.length === 1 ? workflowLocation(repositoryRoot, worktree, ids[0]!) : undefined;
}

/** Every workflow in the repository: the main checkout plus each worktree under .worktrees. */
export async function listWorkflows(repositoryRoot: string): Promise<WorkflowLocation[]> {
	const checkouts = [repositoryRoot];
	try {
		for (const name of await readdir(join(repositoryRoot, WORKTREES_DIR))) checkouts.push(join(repositoryRoot, WORKTREES_DIR, name));
	} catch { /* no worktrees directory */ }
	const locations: WorkflowLocation[] = [];
	for (const checkout of checkouts) {
		for (const id of await workflowIds(join(checkout, WORKFLOWS_DIR))) locations.push(workflowLocation(repositoryRoot, checkout, id));
	}
	return locations;
}

export async function findWorkflowById(repositoryRoot: string, id: string): Promise<WorkflowLocation | undefined> {
	return (await listWorkflows(repositoryRoot)).find((location) => location.id === id);
}

/** Removes the workflow files and the worktree. Keeps the branch. */
export async function removeWorkflow(exec: ExecFn, location: WorkflowLocation, force: boolean): Promise<string | undefined> {
	await rm(location.root, { recursive: true, force: true });
	if (resolve(location.worktree) === resolve(location.repositoryRoot)) return undefined;
	const result = await exec("git", ["-C", location.repositoryRoot, "worktree", "remove", ...(force ? ["--force"] : []), location.worktree]);
	return result.code === 0 ? undefined : result.stderr || result.stdout || "git worktree remove failed";
}

export async function readClarifications(location: WorkflowLocation): Promise<Clarification[]> {
	const raw = await readOptional(location.clarifications);
	if (!raw?.trim()) return [];
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value)) throw new Error(text("messages.invalid_clarifications_file", { path: location.clarifications }));
	return value.filter((entry): entry is Clarification =>
		isRecord(entry) && typeof entry.question === "string" && typeof entry.answer === "string" &&
		typeof entry.custom === "boolean" && typeof entry.answeredAt === "string");
}

export async function appendClarifications(location: WorkflowLocation, entries: Clarification[]): Promise<void> {
	const current = await readClarifications(location);
	await writeFile(location.clarifications, `${JSON.stringify([...current, ...entries], null, 2)}\n`);
}

/** Keeps .workflows and .worktrees out of git status without touching the tracked .gitignore. */
async function installExcludes(exec: ExecFn, repositoryRoot: string): Promise<void> {
	const commonDir = await git(exec, repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonDir) return;
	const path = join(commonDir, "info", "exclude");
	const current = (await readOptional(path)) ?? "";
	const missing = [`${WORKFLOWS_DIR}/`, `${WORKTREES_DIR}/`].filter((line) => !current.split(/\r?\n/).includes(line));
	if (!missing.length) return;
	await mkdir(join(commonDir, "info"), { recursive: true });
	await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

async function workflowIds(directory: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return [];
	}
	const ids: string[] = [];
	for (const name of names.sort()) {
		if (isSlug(name) && await exists(join(directory, name, "workflow.json"))) ids.push(name);
	}
	return ids;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
