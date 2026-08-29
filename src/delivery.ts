import { gitValue, isAncestor, worktreeStatus, type ExecFn } from "./git.ts";
import {
	buildPullRequestStack,
	parseOpenPullRequests,
	type OpenPullRequest,
	type WorkflowPullRequest,
} from "./pull-requests.ts";
import type { CompletedWorkflowMetadata } from "./storage.ts";

export type DeliveryCheckResult =
	| { ok: true; headCommit: string; pullRequests: OpenPullRequest[] }
	| { ok: false; stage: "worktree" | "pull-requests"; message: string };

/**
 * Checks the live state of the workflow delivery: a clean worktree whose
 * checked-out branch is the tip of a complete open pull request chain from
 * the recorded base branch. A normal single pull request is a one-item chain.
 */
export async function checkDelivery(
	exec: ExecFn,
	workflow: CompletedWorkflowMetadata,
): Promise<DeliveryCheckResult> {
	const status = await worktreeStatus(exec, workflow.worktreePath);
	if (status === undefined) return { ok: false, stage: "worktree", message: "could not inspect the worktree" };
	if (status !== "") return { ok: false, stage: "worktree", message: "the worktree has uncommitted changes" };
	const headCommit = await gitValue(exec, workflow.worktreePath, ["rev-parse", "HEAD"]);
	if (!headCommit) {
		return { ok: false, stage: "worktree", message: "could not identify the branch head commit" };
	}

	const stack = await findPullRequestStack(exec, workflow);
	if (!stack) return { ok: false, stage: "pull-requests", message: "could not inspect open pull requests" };
	if ("error" in stack) return { ok: false, stage: "pull-requests", message: stack.error };
	const pullRequests = stack.pullRequests;
	if (pullRequests[0]?.headRefName !== workflow.workflowBranch) {
		return {
			ok: false,
			stage: "pull-requests",
			message: `the bottom pull request must use workflow branch ${workflow.workflowBranch}`,
		};
	}
	const tip = pullRequests.at(-1)!;
	if (tip.headRefOid !== headCommit) {
		return {
			ok: false,
			stage: "pull-requests",
			message: "the local HEAD commit has not been pushed to the stack tip branch",
		};
	}
	let previousCommit = workflow.baseCommit;
	for (const pullRequest of pullRequests) {
		if (!(await isAncestor(exec, workflow.worktreePath, previousCommit, pullRequest.headRefOid))) {
			return {
				ok: false,
				stage: "pull-requests",
				message: `pull request #${pullRequest.number} does not contain the current branch below it`,
			};
		}
		previousCommit = pullRequest.headRefOid;
	}
	return { ok: true, headCommit, pullRequests };
}

/** Finds the open pull request for the checked-out branch, which is the workflow stack tip. */
export async function findCurrentPullRequest(
	exec: ExecFn,
	workflow: CompletedWorkflowMetadata,
): Promise<WorkflowPullRequest | undefined> {
	const branch = await gitValue(exec, workflow.worktreePath, ["branch", "--show-current"]);
	if (!branch) return undefined;
	const result = await exec(
		"gh",
		[
			"pr",
			"list",
			"--state",
			"open",
			"--head",
			branch,
			"--limit",
			"2",
			"--json",
			"number,url,baseRefName,headRefName",
		],
		{ cwd: workflow.worktreePath, timeout: 15_000 },
	);
	if (result.code !== 0) return undefined;
	try {
		const pullRequests = parseOpenPullRequests(JSON.parse(result.stdout));
		const matches = pullRequests?.filter((pullRequest) => pullRequest.headRefName === branch) ?? [];
		return matches.length === 1 ? matches[0] : undefined;
	} catch {
		return undefined;
	}
}

async function findPullRequestStack(exec: ExecFn, workflow: CompletedWorkflowMetadata) {
	const [branch, result] = await Promise.all([
		gitValue(exec, workflow.worktreePath, ["branch", "--show-current"]),
		exec(
			"gh",
			["pr", "list", "--state", "open", "--limit", "100", "--json", "number,url,baseRefName,headRefName"],
			{ cwd: workflow.worktreePath, timeout: 15_000 },
		),
	]);
	if (!branch || result.code !== 0) return undefined;
	try {
		const openPullRequests = parseOpenPullRequests(JSON.parse(result.stdout));
		if (!openPullRequests) return undefined;
		const stack = buildPullRequestStack(openPullRequests, branch, workflow.baseBranch);
		if ("error" in stack) return stack;

		const pullRequests: OpenPullRequest[] = [];
		for (const pullRequest of stack.pullRequests) {
			// Older gh releases do not expose headRefOid through `pr list`; the REST field is stable.
			const head = await exec(
				"gh",
				["api", `repos/{owner}/{repo}/pulls/${pullRequest.number}`, "--jq", ".head.sha"],
				{ cwd: workflow.worktreePath, timeout: 15_000 },
			);
			const headRefOid = head.code === 0 ? head.stdout.trim() : "";
			if (!headRefOid) return undefined;
			pullRequests.push({ ...pullRequest, headRefOid });
		}
		return { pullRequests };
	} catch {
		return undefined;
	}
}
