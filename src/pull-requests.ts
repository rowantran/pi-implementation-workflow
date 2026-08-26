export interface WorkflowPullRequest {
	number: number;
	url: string;
	baseRefName: string;
	headRefName: string;
}

export interface OpenPullRequest extends WorkflowPullRequest {
	headRefOid: string;
}

export type PullRequestStackResult =
	| { pullRequests: OpenPullRequest[] }
	| { error: string };

export function parseOpenPullRequests(value: unknown): OpenPullRequest[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const pullRequests: OpenPullRequest[] = [];
	for (const item of value) {
		if (!isOpenPullRequest(item)) return undefined;
		pullRequests.push(item);
	}
	return pullRequests;
}

export function buildPullRequestStack(
	openPullRequests: OpenPullRequest[],
	topBranch: string,
	baseBranch: string,
): PullRequestStackResult {
	if (!topBranch) return { error: "could not identify the checked-out stack tip branch" };
	if (topBranch === baseBranch) return { error: `the checked-out branch is the base branch ${baseBranch}` };

	const byHeadBranch = new Map<string, OpenPullRequest[]>();
	for (const pullRequest of openPullRequests) {
		const candidates = byHeadBranch.get(pullRequest.headRefName) ?? [];
		candidates.push(pullRequest);
		byHeadBranch.set(pullRequest.headRefName, candidates);
	}

	const reversed: OpenPullRequest[] = [];
	const visited = new Set<string>();
	let branch = topBranch;
	while (branch !== baseBranch) {
		if (visited.has(branch)) return { error: `the pull request chain contains a cycle at ${branch}` };
		visited.add(branch);
		const candidates = byHeadBranch.get(branch) ?? [];
		if (candidates.length === 0) return { error: `no open pull request has head branch ${branch}` };
		if (candidates.length > 1) return { error: `multiple open pull requests use head branch ${branch}` };
		const pullRequest = candidates[0]!;
		reversed.push(pullRequest);
		branch = pullRequest.baseRefName;
	}

	return { pullRequests: reversed.reverse() };
}

export function toWorkflowPullRequests(pullRequests: OpenPullRequest[]): WorkflowPullRequest[] {
	return pullRequests.map(({ number, url, baseRefName, headRefName }) => ({
		number,
		url,
		baseRefName,
		headRefName,
	}));
}

export function formatPullRequestStack(pullRequests: WorkflowPullRequest[]): string {
	return pullRequests
		.map(
			(pullRequest, index) =>
				`${index + 1}. #${pullRequest.number} (${pullRequest.baseRefName} ← ${pullRequest.headRefName}): ${pullRequest.url}`,
		)
		.join("\n");
}

export function isWorkflowPullRequest(value: unknown): value is WorkflowPullRequest {
	if (!value || typeof value !== "object") return false;
	const pullRequest = value as Partial<WorkflowPullRequest>;
	return (
		Number.isSafeInteger(pullRequest.number) &&
		(pullRequest.number as number) > 0 &&
		typeof pullRequest.url === "string" &&
		Boolean(pullRequest.url) &&
		typeof pullRequest.baseRefName === "string" &&
		Boolean(pullRequest.baseRefName) &&
		typeof pullRequest.headRefName === "string" &&
		Boolean(pullRequest.headRefName)
	);
}

function isOpenPullRequest(value: unknown): value is OpenPullRequest {
	return (
		isWorkflowPullRequest(value) &&
		typeof (value as Partial<OpenPullRequest>).headRefOid === "string" &&
		Boolean((value as Partial<OpenPullRequest>).headRefOid)
	);
}
