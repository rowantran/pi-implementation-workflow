import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	SessionManager,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { writeWorkflowDashboard, writeWorkflowDashboardRedirect } from "./dashboard.ts";
import { PLAN_TITLE, planningCompletionError } from "./planning.ts";
import { registerWorkflowPlanTool, WORKFLOW_UPDATE_PLAN_TOOL } from "./plan-tool.ts";
import {
	continuePlanningUserMessage,
	implementationSystemPrompt,
	implementationUserMessage,
	planSlugSystemPrompt,
	planSlugUserMessage,
	planningSystemPrompt,
	reviewSystemPrompt,
	reviewUserMessage,
	startPlanningUserMessage,
} from "./prompts.ts";
import {
	registerWorkflowQuestions,
	WORKFLOW_QUESTION_TOOL,
	type WorkflowQuestionnaireResult,
} from "./questions.ts";
import {
	appendClarifications,
	assertIdentifier,
	createDraft,
	draftFiles,
	ensureWorkflowFiles,
	pathExists,
	promoteDraft,
	readCompletedWorkflowMetadata,
	readText,
	savePlanVersion,
	WORKFLOW_STATE_VERSION,
	type CompletedWorkflowMetadata,
	type DraftWorkflowMetadata,
	type WorkflowClarification,
	type WorkflowFiles,
	workflowFiles,
	writeCompletedWorkflowMetadata,
	writeDraftWorkflowMetadata,
	writeWorkflowMetadata,
} from "./storage.ts";
import {
	registerWorkflowCompletionRenderer,
	runWorkflowProgress,
	showWorkflowCompletion,
	showWorkflowPhaseStatus,
} from "./ui.ts";

type WorkflowPhase = "planning" | "implementation" | "review" | "cleanup" | "complete";

interface WorkflowPhaseData {
	phase: WorkflowPhase;
	draftId?: string;
	identifier?: string;
}

interface RepositoryIdentity {
	root: string;
	commonDir: string;
}

interface PullRequestInfo {
	number: number;
	url: string;
	baseRefName: string;
	headRefName: string;
}

interface CompletionFailure {
	message: string;
}

const PHASE_ENTRY = "implementation-workflow-phase";
const PHASE_REMINDER_ENTRY = "implementation-workflow-phase-reminder";
const DASHBOARD_SHORTCUT = "ctrl+alt+d";
const WORKFLOW_BRANCH_PREFIX = "workflow/";
const REVIEW_DISABLED_TOOLS = new Set(["edit", "write"]);

export default function implementationWorkflow(pi: ExtensionAPI): void {
	registerWorkflowCompletionRenderer(pi);

	let phase: WorkflowPhase | undefined;
	let draftId: string | undefined;
	let identifier: string | undefined;
	let metadata: CompletedWorkflowMetadata | undefined;
	let draftMetadata: DraftWorkflowMetadata | undefined;
	let activeFiles: WorkflowFiles | undefined;
	let planDescription = "";
	let baseTools: string[] = [];
	let trackedPlan = "";
	let watcher: FSWatcher | undefined;
	let watcherTimer: NodeJS.Timeout | undefined;
	let dashboardOpened = false;
	let completionInFlight = false;
	let lastAutomaticFailure: string | undefined;
	let phaseReminderVisible = false;

	registerWorkflowPlanTool(pi, async (plan, rawDescription) => {
		if (phase !== "planning" || !activeFiles) {
			throw new Error("The implementation plan can only be updated during workflow planning.");
		}
		const files = activeFiles;
		return withFileMutationQueue(files.plan, async () => {
			if (!draftMetadata) throw new Error("The workflow draft has no metadata.");
			const description = normalizePlanDescription(rawDescription);
			const version = await savePlanVersion(files, plan);
			draftMetadata = { ...draftMetadata, description };
			await writeDraftWorkflowMetadata(files, draftMetadata);
			trackedPlan = plan;
			planDescription = description;
			pi.setSessionName(workflowSessionName("Planning", undefined, description));
			await writeWorkflowDashboard(files);
			return { version: version.number };
		});
	});

	registerWorkflowQuestions(pi, async (result) => {
		if (phase !== "implementation" || !activeFiles) {
			throw new Error("Implementation clarifications can only be saved during implementation.");
		}
		await saveClarifications(activeFiles, result);
		await writeWorkflowDashboard(activeFiles);
	});

	function latestPhase(entries: SessionEntry[]): WorkflowPhaseData | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type === "custom" && entry.customType === PHASE_ENTRY) {
				return entry.data as WorkflowPhaseData;
			}
		}
		return undefined;
	}

	function phaseReminderWasShown(entries: SessionEntry[]): boolean {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom") continue;
			if (entry.customType === PHASE_REMINDER_ENTRY) return true;
			if (entry.customType === PHASE_ENTRY) return false;
		}
		return false;
	}

	function appendPhase(data: WorkflowPhaseData): void {
		phase = data.phase;
		draftId = data.draftId;
		identifier = data.identifier;
		phaseReminderVisible = false;
		pi.appendEntry(PHASE_ENTRY, data);
	}

	function updatePhaseStatus(ctx: ExtensionContext): void {
		const activePhase =
			phase === "planning" ||
			(phase === "implementation" && metadata?.status === "implementing") ||
			(phase === "review" && metadata?.status === "reviewing")
				? phase
				: undefined;
		showWorkflowPhaseStatus(ctx, phaseReminderVisible ? activePhase : undefined);
	}

	function revealPhaseReminder(ctx: ExtensionContext): void {
		if (phaseReminderVisible) return;
		if (phase !== "planning" && phase !== "implementation" && phase !== "review") return;
		phaseReminderVisible = true;
		pi.appendEntry(PHASE_REMINDER_ENTRY, { phase, draftId, identifier });
		updatePhaseStatus(ctx);
	}

	function applyPhaseTools(): void {
		const withoutWorkflowTools = baseTools.filter(
			(name) => name !== WORKFLOW_QUESTION_TOOL && name !== WORKFLOW_UPDATE_PLAN_TOOL,
		);
		if (phase === "planning") {
			const readOnlyTools = withoutWorkflowTools.filter((name) => !REVIEW_DISABLED_TOOLS.has(name));
			pi.setActiveTools([...new Set([...readOnlyTools, WORKFLOW_UPDATE_PLAN_TOOL])]);
			return;
		}
		if (phase === "implementation" && metadata?.status !== "implementation_complete") {
			pi.setActiveTools([...new Set([...withoutWorkflowTools, WORKFLOW_QUESTION_TOOL])]);
			return;
		}
		if (phase === "review") {
			pi.setActiveTools(withoutWorkflowTools.filter((name) => !REVIEW_DISABLED_TOOLS.has(name)));
			return;
		}
		pi.setActiveTools(withoutWorkflowTools);
	}

	async function saveClarifications(files: WorkflowFiles, result: WorkflowQuestionnaireResult): Promise<void> {
		const answeredAt = new Date().toISOString();
		await appendClarifications(
			files,
			result.answers.map((answer) => {
				const question = result.questions.find((candidate) => candidate.id === answer.id);
				if (!question) throw new Error(`No implementation question found for answer ${answer.id}.`);
				const clarification: WorkflowClarification = {
					id: answer.id,
					label: question.label,
					question: question.question,
					answer: answer.answer,
					custom: answer.custom,
					answeredAt,
				};
				if (answer.index !== undefined) clarification.optionIndex = answer.index;
				return clarification;
			}),
		);
	}

	async function recordExternalRevision(): Promise<void> {
		if (!activeFiles || phase !== "planning") return;
		const files = activeFiles;
		await withFileMutationQueue(files.plan, async () => {
			const current = await readText(files.plan);
			if (current === trackedPlan) return;
			await savePlanVersion(files, current);
			trackedPlan = current;
			await writeWorkflowDashboard(files);
		});
	}

	function startPlanWatcher(): void {
		watcher?.close();
		watcher = undefined;
		if (!activeFiles || phase !== "planning") return;
		try {
			watcher = watch(activeFiles.root, (_event, filename) => {
				if (filename?.toString() !== basename(activeFiles!.plan)) return;
				if (watcherTimer) clearTimeout(watcherTimer);
				watcherTimer = setTimeout(() => void recordExternalRevision(), 120);
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
			});
		} catch {
			// The dashboard also refreshes when it opens or planning completes.
		}
	}

	async function openDashboard(ctx: ExtensionContext, force = false): Promise<void> {
		if (!activeFiles) {
			ctx.ui.notify("No workflow dashboard is available in this session.", "info");
			return;
		}
		await writeWorkflowDashboard(activeFiles);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`Workflow dashboard: ${activeFiles.dashboard}`, "info");
			return;
		}
		if (dashboardOpened && !force) return;

		const url = pathToFileURL(activeFiles.dashboard).href;
		let command = "xdg-open";
		let args = [url];
		if (process.platform === "darwin") command = "open";
		if (process.platform === "win32") {
			command = "cmd";
			args = ["/c", "start", "", url];
		}
		const result = await pi.exec(command, args, { timeout: 10_000 });
		if (result.code !== 0) {
			ctx.ui.notify(`Could not open the workflow dashboard. Open this file manually:\n${url}`, "error");
			return;
		}
		dashboardOpened = true;
	}

	async function repositoryIdentity(cwd: string): Promise<RepositoryIdentity | undefined> {
		const [rootResult, commonResult] = await Promise.all([
			pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
			pi.exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
		]);
		if (rootResult.code !== 0 || commonResult.code !== 0) return undefined;
		return {
			root: resolve(rootResult.stdout.trim()),
			commonDir: resolve(commonResult.stdout.trim()),
		};
	}

	async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
		const result = await pi.exec("git", ["-C", cwd, ...args]);
		if (result.code !== 0) return undefined;
		return result.stdout.trim();
	}

	async function gitValue(cwd: string, args: string[]): Promise<string | undefined> {
		const output = await gitOutput(cwd, args);
		return output || undefined;
	}

	async function requireLaunchRepository(ctx: ExtensionContext, workflow: CompletedWorkflowMetadata): Promise<boolean> {
		const current = await repositoryIdentity(ctx.cwd);
		const allowedLaunchRoots = new Set([resolve(workflow.repositoryRoot), resolve(workflow.worktreePath)]);
		if (
			current?.commonDir === resolve(workflow.gitCommonDir) &&
			allowedLaunchRoots.has(resolve(current.root))
		) {
			return true;
		}
		ctx.ui.notify(
			`This Isara sandbox was not started inside the workflow repository.\nRun:\n\ncd ${workflow.repositoryRoot}\nisara pi run\n\nThen paste the workflow command again.`,
			"error",
		);
		return false;
	}

	async function createPhaseSession(cwd: string, data: WorkflowPhaseData): Promise<string> {
		const manager = SessionManager.create(cwd);
		const sessionFile = manager.getSessionFile();
		const header = manager.getHeader();
		if (!sessionFile || !header) throw new Error("Pi did not allocate a persistent target session.");
		await mkdir(dirname(sessionFile), { recursive: true });
		await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
		const persisted = SessionManager.open(sessionFile);
		persisted.appendCustomEntry(PHASE_ENTRY, data);
		return sessionFile;
	}

	async function prepareActivePlan(files: WorkflowFiles): Promise<void> {
		const workflowMetadata = await ensureWorkflowFiles(files);
		activeFiles = files;
		trackedPlan = await readText(files.plan);
		planDescription = workflowMetadata.description?.trim() ?? "";
		if (workflowMetadata.status === "planning") {
			draftMetadata = workflowMetadata;
			metadata = undefined;
		} else {
			metadata = workflowMetadata;
			draftMetadata = undefined;
		}
		await writeWorkflowDashboard(files);
		startPlanWatcher();
	}

	pi.registerCommand("workflow-plan", {
		description: "Start or resume a persistent WHAT/WHY implementation plan",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const issue = args.trim();

			if (phase === "planning" && draftId) {
				await prepareActivePlan(draftFiles(draftId));
				await openDashboard(ctx);
				if (issue) pi.sendUserMessage(continuePlanningUserMessage(issue));
				return;
			}

			const repository = await repositoryIdentity(ctx.cwd);
			if (!repository) {
				ctx.ui.notify("Workflow planning must start inside a Git repository.", "error");
				return;
			}
			const nextDraftId = ctx.sessionManager.getSessionId().replaceAll(/[^a-zA-Z0-9-]/g, "-");
			const files = draftFiles(nextDraftId);
			if (await pathExists(files.root)) await ensureWorkflowFiles(files);
			else {
				const initial = issue ? `${PLAN_TITLE}\n\n## Issue\n\n${issue}\n` : `${PLAN_TITLE}\n`;
				const initialMetadata: DraftWorkflowMetadata = {
					version: WORKFLOW_STATE_VERSION,
					status: "planning",
					draftId: nextDraftId,
					description: "",
					createdAt: new Date().toISOString(),
				};
				await createDraft(files, initial, initialMetadata);
			}

			appendPhase({ phase: "planning", draftId: nextDraftId });
			metadata = undefined;
			draftMetadata = undefined;
			baseTools = pi
				.getActiveTools()
				.filter((name) => name !== WORKFLOW_QUESTION_TOOL && name !== WORKFLOW_UPDATE_PLAN_TOOL);
			applyPhaseTools();
			updatePhaseStatus(ctx);
			pi.setSessionName("");
			await prepareActivePlan(files);
			await openDashboard(ctx);

			if (issue) {
				pi.sendUserMessage(startPlanningUserMessage(issue));
			} else {
				ctx.ui.notify(`Planning started. Advance to implementation with /workflow-next.`, "info");
			}
		},
	});

	pi.registerCommand("workflow-implement", {
		description: "Enter a workflow worktree and implement its frozen plan",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const requestedIdentifier = args.trim();
			try {
				assertIdentifier(requestedIdentifier);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			let workflow: CompletedWorkflowMetadata;
			try {
				workflow = await readCompletedWorkflowMetadata(requestedIdentifier);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (workflow.status !== "ready_for_implementation" && workflow.status !== "implementing") {
				ctx.ui.notify(`Workflow ${requestedIdentifier} is ${workflow.status}; it cannot enter implementation.`, "error");
				return;
			}
			if (!(await requireLaunchRepository(ctx, workflow))) return;
			const validation = await validateWorktree(workflow);
			if (validation) {
				ctx.ui.notify(validation.message, "error");
				return;
			}

			const sessionFile = await createPhaseSession(workflow.worktreePath, {
				phase: "implementation",
				identifier: requestedIdentifier,
			});
			workflow.status = "implementing";
			workflow.implementationStartedAt ??= new Date().toISOString();
			await writeCompletedWorkflowMetadata(workflow);
			await ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						implementationUserMessage({
							planPath: workflowFiles(requestedIdentifier).plan,
							worktreePath: workflow.worktreePath,
							workflowBranch: workflow.workflowBranch,
							baseBranch: workflow.baseBranch,
						}),
					);
				},
			});
		},
	});

	pi.registerCommand("workflow-review", {
		description: "Enter a workflow worktree and review its pull request against the frozen plan",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const requestedIdentifier = args.trim();
			try {
				assertIdentifier(requestedIdentifier);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}

			let workflow: CompletedWorkflowMetadata;
			try {
				workflow = await readCompletedWorkflowMetadata(requestedIdentifier);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (workflow.status !== "implementation_complete" && workflow.status !== "reviewing") {
				ctx.ui.notify(`Workflow ${requestedIdentifier} is ${workflow.status}; it cannot enter review.`, "error");
				return;
			}
			if (!workflow.pullRequestUrl) {
				ctx.ui.notify(`Workflow ${requestedIdentifier} has no recorded pull request.`, "error");
				return;
			}
			if (!(await requireLaunchRepository(ctx, workflow))) return;
			const validation = await validateWorktree(workflow);
			if (validation) {
				ctx.ui.notify(validation.message, "error");
				return;
			}

			const sessionFile = await createPhaseSession(workflow.worktreePath, {
				phase: "review",
				identifier: requestedIdentifier,
			});
			workflow.status = "reviewing";
			workflow.reviewStartedAt ??= new Date().toISOString();
			await writeCompletedWorkflowMetadata(workflow);
			await ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						reviewUserMessage({
								pullRequestUrl: workflow.pullRequestUrl!,
								planPath: workflowFiles(requestedIdentifier).plan,
							}),
					);
				},
			});
		},
	});

	pi.registerCommand("workflow-next", {
		description: "Advance the active workflow to its next phase",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (phase === "planning") {
				await completePlanning(ctx);
				return;
			}
			if (phase === "implementation") {
				await completeImplementation(ctx, false);
				return;
			}
			if (phase === "review") {
				await beginReviewCleanup(ctx);
				return;
			}
			if (phase === "cleanup" && identifier) {
				await finishReviewCleanup(ctx, identifier);
				return;
			}
			ctx.ui.notify("No active workflow phase can advance in this session.", "error");
		},
	});

	async function completePlanning(ctx: ExtensionCommandContext): Promise<void> {
		if (!draftId || !activeFiles || !draftMetadata) {
			ctx.ui.notify("This planning session has no workflow draft metadata.", "error");
			return;
		}
		const currentDraftMetadata = draftMetadata;
		await recordExternalRevision();
		const draft = activeFiles;
		const plan = await readText(draft.plan);
		const completionError = planningCompletionError(plan, planDescription);
		if (completionError) {
			ctx.ui.notify(completionError, "error");
			return;
		}
		const description = planDescription.trim();
		const repository = await repositoryIdentity(ctx.cwd);
		if (!repository) {
			ctx.ui.notify("The planning session is no longer inside a Git repository.", "error");
			return;
		}
		const [baseBranch, baseCommit] = await Promise.all([
			gitValue(repository.root, ["branch", "--show-current"]),
			gitValue(repository.root, ["rev-parse", "HEAD"]),
		]);
		if (!baseBranch || !baseCommit) {
			ctx.ui.notify("Planning completion requires a named branch with a valid HEAD.", "error");
			return;
		}

		const statusResult = await pi.exec("git", ["-C", repository.root, "status", "--porcelain", "--untracked-files=all"]);
		if (statusResult.code !== 0) {
			ctx.ui.notify("Could not inspect the original checkout.", "error");
			return;
		}
		const meaningfulChanges = statusResult.stdout
			.split("\n")
			.filter((line) => line && !line.slice(3).startsWith(".worktrees/"));
		if (meaningfulChanges.length > 0) {
			const confirmed = await ctx.ui.confirm(
				"Original checkout has uncommitted files",
				"The worktree will start from the recorded HEAD and will not include those files. Continue?",
			);
			if (!confirmed) return;
		}

		let result: {
			nextIdentifier: string;
			destination: WorkflowFiles;
			nextMetadata: CompletedWorkflowMetadata;
			dashboardWarnings: string[];
		};
		try {
			result = await runWorkflowProgress(
				ctx,
				"Completing planning",
				["generating final plan slug", "creating worktree"],
				async (progress) => {
					let nextIdentifier: string;
					try {
						nextIdentifier = await uniqueIdentifier(plan, ctx);
					} catch (error) {
						progress.fail("Could not generate final plan slug");
						throw new Error(`Could not generate final plan slug: ${errorMessage(error)}`);
					}
					progress.complete(`generated plan slug: ${nextIdentifier}`);

					const destination = workflowFiles(nextIdentifier);
					const worktreePath = join(repository.root, ".worktrees", nextIdentifier);
					const workflowBranch = `${WORKFLOW_BRANCH_PREFIX}${nextIdentifier}`;
					const nextMetadata: CompletedWorkflowMetadata = {
						version: WORKFLOW_STATE_VERSION,
						identifier: nextIdentifier,
						description,
						status: "ready_for_implementation",
						repositoryRoot: repository.root,
						gitCommonDir: repository.commonDir,
						baseBranch,
						baseCommit,
						workflowBranch,
						worktreePath,
						createdAt: currentDraftMetadata.createdAt,
					};

					await installWorktreeExclude(repository.commonDir);
					await mkdir(dirname(worktreePath), { recursive: true });
					const addResult = await pi.exec("git", [
						"-C",
						repository.root,
						"worktree",
						"add",
						"-b",
						workflowBranch,
						worktreePath,
						baseCommit,
					]);
					if (addResult.code !== 0) {
						await pi.exec("git", ["-C", repository.root, "worktree", "remove", "--force", worktreePath]);
						await pi.exec("git", ["-C", repository.root, "branch", "-D", workflowBranch]);
						progress.fail("Could not create worktree");
						throw new Error(`Could not create worktree:\n${addResult.stderr || addResult.stdout}`);
					}
					try {
						await writeWorkflowMetadata(draft, nextMetadata);
						await promoteDraft(draft, destination);
					} catch (error) {
						let restoreError: unknown;
						if (await pathExists(draft.root)) {
							try {
								await writeDraftWorkflowMetadata(draft, currentDraftMetadata);
							} catch (candidate) {
								restoreError = candidate;
							}
						}
						await pi.exec("git", ["-C", repository.root, "worktree", "remove", "--force", worktreePath]);
						await pi.exec("git", ["-C", repository.root, "branch", "-D", workflowBranch]);
						progress.fail("Could not save completed plan");
						const restoreDetail = restoreError
							? `; could not restore draft metadata: ${errorMessage(restoreError)}`
							: "";
						throw new Error(`Could not save completed plan: ${errorMessage(error)}${restoreDetail}`);
					}

					const dashboardWarnings: string[] = [];
					try {
						await writeWorkflowDashboardRedirect(draft.dashboard, destination.dashboard);
					} catch (error) {
						dashboardWarnings.push(`could not preserve the planning dashboard URL: ${errorMessage(error)}`);
					}
					try {
						await writeWorkflowDashboard(destination);
					} catch (error) {
						dashboardWarnings.push(`could not refresh the completed workflow dashboard: ${errorMessage(error)}`);
					}
					progress.complete("created worktree");
					return { nextIdentifier, destination, nextMetadata, dashboardWarnings };
				},
			);
		} catch (error) {
			ctx.ui.notify(`Could not complete planning: ${errorMessage(error)}`, "error");
			return;
		}

		const { nextIdentifier, destination, nextMetadata, dashboardWarnings } = result;
		appendPhase({ phase: "complete", identifier: nextIdentifier });
		metadata = nextMetadata;
		draftMetadata = undefined;
		activeFiles = destination;
		updatePhaseStatus(ctx);
		pi.setSessionName(workflowSessionName("Planning", nextIdentifier, nextMetadata.description));
		if (dashboardWarnings.length > 0) ctx.ui.notify(dashboardWarnings.join("\n"), "warning");

		const command = `/workflow-implement ${nextIdentifier}`;
		let clipboardError: unknown;
		try {
			await copyToClipboard(command);
		} catch (error) {
			clipboardError = error;
		}
		showWorkflowCompletion(pi, ctx, {
			title: "Planning complete",
			details: [
				`Generated plan slug: ${nextIdentifier}`,
				`Plan description: ${nextMetadata.description}`,
				`Created worktree: ${nextMetadata.worktreePath}`,
			],
			command,
			clipboard: clipboardError ? "failed" : "copied",
			instruction: clipboardError
				? `Could not copy the command: ${errorMessage(clipboardError)}. Copy it above and paste it here to start a separate implementation session. This planning session stays saved.`
				: "Copied to the clipboard. Paste this command here to start a separate implementation session. This planning session stays saved.",
		});
	}

	async function completeImplementation(ctx: ExtensionContext, readinessCheckOnly: boolean): Promise<void> {
		if (!identifier) return;
		if (completionInFlight) return;
		completionInFlight = true;
		try {
			const workflow = await readCompletedWorkflowMetadata(identifier);
			metadata = workflow;
			if (workflow.status === "implementation_complete") {
				if (!readinessCheckOnly) await copyReviewCommand(ctx, workflow);
				return;
			}
			if (workflow.status !== "implementing") {
				if (!readinessCheckOnly) ctx.ui.notify(`Workflow ${identifier} is ${workflow.status}.`, "error");
				return;
			}
			const completion = await runWorkflowProgress<
				{ failure: CompletionFailure } | { pullRequest: PullRequestInfo }
			>(
				ctx,
				readinessCheckOnly ? "Checking implementation readiness" : "Completing implementation",
				["Checking worktree", "Finding pull request"],
				async (progress) => {
					const failure = await implementationCompletionFailure(workflow);
					if (failure) {
						progress.fail("Worktree is not ready");
						return { failure };
					}
					progress.complete("Checked clean worktree");
					const pullRequest = await findPullRequest(workflow);
					if (!pullRequest) {
						const failure = {
							message: `no open pull request from ${workflow.workflowBranch} to ${workflow.baseBranch}`,
						};
						progress.fail("Open pull request not found");
						return { failure };
					}
					progress.complete(`Found pull request #${pullRequest.number}`);
					return { pullRequest };
				},
			);
			if ("failure" in completion) {
				const message = completion.failure.message;
				if (!readinessCheckOnly || lastAutomaticFailure !== message) {
					ctx.ui.notify(`Implementation is not complete: ${message}.`, readinessCheckOnly ? "warning" : "error");
				}
				lastAutomaticFailure = message;
				return;
			}
			const { pullRequest } = completion;
			lastAutomaticFailure = undefined;
			if (readinessCheckOnly) return;

			workflow.status = "implementation_complete";
			workflow.implementationCompletedAt = new Date().toISOString();
			workflow.pullRequestUrl = pullRequest.url;
			workflow.pullRequestNumber = pullRequest.number;
			await writeCompletedWorkflowMetadata(workflow);
			metadata = workflow;
			applyPhaseTools();
			updatePhaseStatus(ctx);
			await copyReviewCommand(ctx, workflow);
		} catch (error) {
			ctx.ui.notify(`Could not complete implementation: ${errorMessage(error)}`, "error");
		} finally {
			completionInFlight = false;
		}
	}

	async function copyReviewCommand(ctx: ExtensionContext, workflow: CompletedWorkflowMetadata): Promise<void> {
		const command = `/workflow-review ${workflow.identifier}`;
		let clipboardError: unknown;
		try {
			await copyToClipboard(command);
		} catch (error) {
			clipboardError = error;
		}
		showWorkflowCompletion(pi, ctx, {
			title: "Implementation complete",
			details: workflow.pullRequestUrl ? [`Pull request: ${workflow.pullRequestUrl}`] : undefined,
			command,
			clipboard: clipboardError ? "failed" : "copied",
			instruction: clipboardError
				? `Could not copy the command: ${errorMessage(clipboardError)}. Copy it above and paste it here to start a separate review session. This implementation session stays saved.`
				: "Copied to the clipboard. Paste this command here to start a separate review session. This implementation session stays saved.",
		});
	}

	async function implementationCompletionFailure(workflow: CompletedWorkflowMetadata): Promise<CompletionFailure | undefined> {
		const validation = await validateWorktree(workflow);
		if (validation) return validation;
		const status = await gitOutput(workflow.worktreePath, ["status", "--porcelain"]);
		if (status === undefined) return { message: "could not inspect the worktree" };
		if (status !== "") return { message: "the worktree has uncommitted changes" };
		return undefined;
	}

	async function findPullRequest(workflow: CompletedWorkflowMetadata): Promise<PullRequestInfo | undefined> {
		const result = await pi.exec(
			"gh",
			[
				"pr",
				"list",
				"--state",
				"open",
				"--head",
				workflow.workflowBranch,
				"--json",
				"number,url,baseRefName,headRefName",
			],
			{ cwd: workflow.worktreePath, timeout: 15_000 },
		);
		if (result.code !== 0) return undefined;
		try {
			const pullRequests = JSON.parse(result.stdout) as PullRequestInfo[];
			return pullRequests.find(
				(pullRequest) =>
					pullRequest.baseRefName === workflow.baseBranch && pullRequest.headRefName === workflow.workflowBranch,
			);
		} catch {
			return undefined;
		}
	}

	async function beginReviewCleanup(ctx: ExtensionCommandContext): Promise<void> {
		if (!identifier) return;
		let preparation:
			| { workflow: CompletedWorkflowMetadata; sessionFile: string }
			| { failure: CompletionFailure };
		try {
			const workflow = await readCompletedWorkflowMetadata(identifier);
			preparation = await runWorkflowProgress(
				ctx,
				"Completing review",
				["Checking review worktree", "Preparing original checkout"],
				async (progress) => {
					const validation = await validateWorktree(workflow);
					if (validation) {
						progress.fail("Review worktree is not ready");
						return { failure: validation };
					}
					const status = await gitOutput(workflow.worktreePath, ["status", "--porcelain"]);
					if (status === undefined) {
						progress.fail("Could not inspect review worktree");
						return { failure: { message: "Could not inspect the review worktree." } };
					}
					if (status !== "") {
						progress.fail("Review worktree has uncommitted changes");
						return {
							failure: { message: "Review cleanup refused because the worktree has uncommitted changes." },
						};
					}
					progress.complete("Checked clean review worktree");

					workflow.status = "cleanup_pending";
					await writeCompletedWorkflowMetadata(workflow);
					const sessionFile = await createPhaseSession(workflow.repositoryRoot, {
						phase: "cleanup",
						identifier: workflow.identifier,
					});
					progress.complete("Prepared original checkout");
					return { workflow, sessionFile };
				},
			);
		} catch (error) {
			ctx.ui.notify(`Could not prepare review cleanup: ${errorMessage(error)}`, "error");
			return;
		}
		if ("failure" in preparation) {
			ctx.ui.notify(preparation.failure.message, "error");
			return;
		}
		await ctx.switchSession(preparation.sessionFile);
	}

	async function finishReviewCleanup(ctx: ExtensionContext, workflowIdentifier: string): Promise<void> {
		const workflow = await readCompletedWorkflowMetadata(workflowIdentifier);
		if (workflow.status !== "cleanup_pending") return;
		let removeFailure: string | undefined;
		try {
			removeFailure = await runWorkflowProgress(
				ctx,
				"Cleaning up review",
				["Removing worktree"],
				async (progress) => {
					const result = await pi.exec("git", [
						"-C",
						workflow.repositoryRoot,
						"worktree",
						"remove",
						workflow.worktreePath,
					]);
					if (result.code !== 0) {
						progress.fail("Could not remove worktree");
						return result.stderr || result.stdout || "Git did not explain why worktree removal failed.";
					}
					progress.complete("Removed worktree");
					return undefined;
				},
			);
		} catch (error) {
			ctx.ui.notify(`Could not remove the worktree: ${errorMessage(error)}`, "error");
			return;
		}
		if (removeFailure) {
			ctx.ui.notify(`Could not remove the worktree: ${removeFailure}`, "error");
			return;
		}

		workflow.status = "review_complete";
		workflow.reviewCompletedAt = new Date().toISOString();
		await writeCompletedWorkflowMetadata(workflow);
		metadata = workflow;
		appendPhase({ phase: "complete", identifier: workflowIdentifier });
		updatePhaseStatus(ctx);
		showWorkflowCompletion(pi, ctx, {
			title: "Review complete",
			details: [
				`Removed worktree: ${workflow.worktreePath}`,
				"Retained the branch and saved plan.",
			],
			clipboard: "none",
		});
	}

	async function validateWorktree(workflow: CompletedWorkflowMetadata): Promise<CompletionFailure | undefined> {
		if (!(await pathExists(workflow.worktreePath))) return { message: `worktree is missing: ${workflow.worktreePath}` };
		const [branch, commonDir] = await Promise.all([
			gitValue(workflow.worktreePath, ["branch", "--show-current"]),
			gitValue(workflow.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		]);
		if (branch !== workflow.workflowBranch) {
			return { message: `expected branch ${workflow.workflowBranch}, found ${branch ?? "none"}` };
		}
		if (!commonDir || resolve(commonDir) !== resolve(workflow.gitCommonDir)) {
			return { message: "the recorded worktree belongs to a different Git repository" };
		}
		return undefined;
	}

	async function uniqueIdentifier(plan: string, ctx: ExtensionCommandContext): Promise<string> {
		const slug = await generatePlanSlug(plan, ctx);
		for (let attempt = 0; attempt < 100; attempt++) {
			const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
			if (!(await pathExists(workflowFiles(candidate).root))) return candidate;
		}
		throw new Error(`Could not allocate a unique workflow identifier for ${slug}.`);
	}

	async function generatePlanSlug(plan: string, ctx: ExtensionCommandContext): Promise<string> {
		if (!ctx.model) throw new Error("No model is selected to generate a workflow identifier from the plan.");
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: planSlugUserMessage(plan) }],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: planSlugSystemPrompt(),
				messages: [message],
			},
			{ cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || "The model did not generate a workflow identifier.");
		}
		const text = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		return normalizePlanSlug(text);
	}

	async function installWorktreeExclude(commonDir: string): Promise<void> {
		const excludePath = join(commonDir, "info", "exclude");
		await mkdir(dirname(excludePath), { recursive: true });
		let content = "";
		try {
			content = await readFile(excludePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (content.split("\n").some((line) => line.trim() === "/.worktrees/")) return;
		const prefix = content && !content.endsWith("\n") ? "\n" : "";
		await appendFile(excludePath, `${prefix}/.worktrees/\n`, "utf8");
	}

	pi.registerCommand("workflow-dashboard", {
		description: "Open the active workflow plan dashboard",
		handler: async (_args, ctx) => {
			if (phase === "planning") await recordExternalRevision();
			await openDashboard(ctx, true);
		},
	});

	pi.registerShortcut(DASHBOARD_SHORTCUT, {
		description: "Open the workflow plan dashboard",
		handler: async (ctx) => {
			if (phase === "planning") await recordExternalRevision();
			await openDashboard(ctx, true);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeFiles || !phase) return;
		let instructions = "";
		if (phase === "planning") {
			instructions = planningSystemPrompt({
				planPath: activeFiles.plan,
				updatePlanTool: WORKFLOW_UPDATE_PLAN_TOOL,
			});
		}
		if (phase === "implementation" && metadata?.status !== "implementation_complete") {
			instructions = implementationSystemPrompt({
				identifier,
				planPath: activeFiles.plan,
				questionTool: WORKFLOW_QUESTION_TOOL,
				baseBranch: metadata?.baseBranch,
			});
		}
		if (phase === "review") {
			instructions = reviewSystemPrompt({
				identifier,
				pullRequestUrl: metadata?.pullRequestUrl,
				planPath: activeFiles.plan,
			});
		}
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!activeFiles || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return;
		const target = resolve(ctx.cwd, rawPath.replace(/^@/, ""));
		const planPath = resolve(activeFiles.plan);
		if (phase === "planning") {
			return {
				block: true,
				reason: `Planning file changes must use ${WORKFLOW_UPDATE_PLAN_TOOL}; direct edit/write calls are disabled.`,
			};
		}
		if (target === planPath) {
			return { block: true, reason: "The workflow plan is frozen and read-only in this phase." };
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (phase === "implementation" && metadata?.status === "implementing") {
			await completeImplementation(ctx, true);
		}
		revealPhaseReminder(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		baseTools = pi
			.getActiveTools()
			.filter((name) => name !== WORKFLOW_QUESTION_TOOL && name !== WORKFLOW_UPDATE_PLAN_TOOL);
		const branch = ctx.sessionManager.getBranch();
		const saved = latestPhase(branch);
		phase = saved?.phase;
		draftId = saved?.draftId;
		identifier = saved?.identifier;
		metadata = undefined;
		draftMetadata = undefined;
		activeFiles = undefined;
		planDescription = "";
		phaseReminderVisible = phaseReminderWasShown(branch);

		if (phase === "planning" && draftId) {
			const files = draftFiles(draftId);
			await ensureWorkflowFiles(files);
			await prepareActivePlan(files);
			pi.setSessionName(planDescription ? workflowSessionName("Planning", undefined, planDescription) : "");
		}
		if ((phase === "implementation" || phase === "review" || phase === "cleanup" || phase === "complete") && identifier) {
			try {
				metadata = await readCompletedWorkflowMetadata(identifier);
				await prepareActivePlan(workflowFiles(identifier));
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		}

		applyPhaseTools();
		updatePhaseStatus(ctx);
		if (phase === "implementation" && identifier) {
			pi.setSessionName(workflowSessionName("Implement", identifier, metadata?.description ?? planDescription));
		}
		if (phase === "review" && identifier) {
			pi.setSessionName(workflowSessionName("Review", identifier, metadata?.description ?? planDescription));
		}
		if ((phase === "planning" || phase === "implementation" || phase === "review") && activeFiles) {
			await openDashboard(ctx);
		}
		if (phase === "cleanup" && identifier) await finishReviewCleanup(ctx, identifier);
	});

	pi.on("session_shutdown", async () => {
		if (watcherTimer) clearTimeout(watcherTimer);
		watcher?.close();
		watcher = undefined;
	});
}

function normalizePlanSlug(response: string): string {
	const unfenced = response
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/\s*```$/, "");
	const line = unfenced
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find(Boolean);
	const slug = (line ?? "")
		.replace(/^slug\s*:\s*/i, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	if (!slug) throw new Error("The model did not return a usable workflow identifier.");
	return slug;
}

function normalizePlanDescription(response: string): string {
	const unfenced = response
		.trim()
		.replace(/^```(?:text)?\s*/i, "")
		.replace(/\s*```$/, "");
	const line = unfenced
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find(Boolean);
	const description = (line ?? "")
		.replace(/^(?:description|summary)\s*:\s*/i, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!description) throw new Error("No usable workflow description was provided.");
	if (description.length > 160) throw new Error("The workflow description is longer than 160 characters.");
	if (description.split(/\s+/).length > 18) throw new Error("The workflow description is longer than 18 words.");
	return description;
}

function workflowSessionName(phase: string, identifier?: string, description?: string): string {
	const slug = identifier?.trim();
	const summary = description?.trim();
	const details = slug && summary ? `${slug} · ${summary}` : slug ?? summary;
	return details ? `${phase}: ${details}` : phase;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
