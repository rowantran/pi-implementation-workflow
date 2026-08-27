import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isPathInside, repositoryIdentity, type ExecFn } from "./git.ts";
import {
	IDENTIFIER_PATTERN,
	listCompletedWorkflows,
	pathExists,
	readCompletedWorkflowMetadata,
	type CompletedWorkflowMetadata,
} from "./storage.ts";

export interface ResolveWorkflowOptions {
	exec: ExecFn;
	cwd: string;
	/** Optional explicit identifier argument from the command line. */
	argument?: string;
	/** The workflow identifier already bound to this session, if any. */
	sessionIdentifier?: string;
	/** Human-readable verb for error messages, e.g. "review". */
	verb: string;
	/** Presents an interactive picker; returns the chosen option or undefined when cancelled. */
	select: (title: string, options: string[]) => Promise<string | undefined>;
}

export type ResolveWorkflowResult =
	| { status: "resolved"; workflow: CompletedWorkflowMetadata }
	| { status: "cancelled" }
	| { status: "error"; message: string };

/**
 * Resolves which workflow a verb targets, in priority order: explicit
 * argument, session binding, the worktree containing the current directory,
 * then an interactive pick over this repository's workflows.
 *
 * Every worktree verb requires the workflow worktree to exist; only planning
 * completion creates one.
 */
export async function resolveWorkflow(options: ResolveWorkflowOptions): Promise<ResolveWorkflowResult> {
	const argument = options.argument?.trim();
	if (argument) {
		if (!IDENTIFIER_PATTERN.test(argument)) {
			return { status: "error", message: `${argument} is not a valid workflow identifier.` };
		}
		return loadEligible(argument, options.verb);
	}
	if (options.sessionIdentifier) return loadEligible(options.sessionIdentifier, options.verb);

	const workflows = await listCompletedWorkflows();
	const containing = await filterAsync(workflows, (workflow) =>
		Promise.resolve(isPathInside(options.cwd, workflow.worktreePath)),
	);
	if (containing[0]) return loadEligible(containing[0].identifier, options.verb);

	const repository = await repositoryIdentity(options.exec, options.cwd);
	if (!repository) {
		return {
			status: "error",
			message: `Run /workflow-${options.verb} inside a Git repository, or pass a workflow identifier.`,
		};
	}
	const repositoryWorkflows = workflows.filter(
		(workflow) => workflow.gitCommonDir === repository.commonDir,
	);
	const eligible = await filterAsync(repositoryWorkflows, (workflow) => pathExists(workflow.worktreePath));
	if (eligible.length === 0) {
		return {
			status: "error",
			message:
				repositoryWorkflows.length > 0
					? `Every workflow in this repository has had its worktree cleaned up. Start a new plan with /workflow-plan.`
					: `No workflows exist for this repository. Start one with /workflow-plan.`,
		};
	}
	if (eligible.length === 1) return loadEligible(eligible[0]!.identifier, options.verb);

	const ordered = [...eligible].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const labels = ordered.map(workflowPickerLabel);
	const choice = await options.select(`Select the workflow to ${options.verb}`, labels);
	if (choice === undefined) return { status: "cancelled" };
	const picked = ordered[labels.indexOf(choice)];
	if (!picked) return { status: "cancelled" };
	return loadEligible(picked.identifier, options.verb);
}

export function workflowPickerLabel(workflow: CompletedWorkflowMetadata): string {
	const description = workflow.description.trim();
	return description ? `${workflow.identifier} — ${description}` : workflow.identifier;
}

async function loadEligible(identifier: string, verb: string): Promise<ResolveWorkflowResult> {
	let workflow: CompletedWorkflowMetadata;
	try {
		workflow = await readCompletedWorkflowMetadata(identifier);
	} catch (error) {
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
	if (!(await pathExists(workflow.worktreePath))) {
		return {
			status: "error",
			message:
				`Workflow ${identifier} has no worktree at ${workflow.worktreePath}; it was cleaned up or never created. ` +
				`Cannot ${verb} it.`,
		};
	}
	return { status: "resolved", workflow };
}

/** Autocomplete items for workflow identifier arguments. */
export async function workflowIdentifierCompletions(prefix: string): Promise<AutocompleteItem[] | null> {
	const workflows = await listCompletedWorkflows();
	const trimmed = prefix.trim();
	const items = workflows
		.filter((workflow) => workflow.identifier.startsWith(trimmed))
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.map((workflow) => ({
			value: workflow.identifier,
			label: workflow.identifier,
			...(workflow.description.trim() ? { description: workflow.description.trim() } : {}),
		}));
	return items.length > 0 ? items : null;
}

async function filterAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
	const checks = await Promise.all(items.map(predicate));
	return items.filter((_, index) => checks[index]);
}
