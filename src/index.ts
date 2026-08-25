import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { parsePlannedChanges, parseTestingCriteria } from "./planned-changes.ts";
import { PLAN_TITLE, planningCompletionError } from "./planning.ts";
import { registerWorkflowPlanTool, WORKFLOW_UPDATE_PLAN_TOOL } from "./plan-tool.ts";
import {
	implementationSystemPrompt,
	implementationUserMessage,
	planSlugSystemPrompt,
	planSlugUserMessage,
	planningSystemPrompt,
	reviewSystemPrompt,
	revisionSystemPrompt,
	revisionUserMessage,
	startPlanningUserMessage,
} from "./prompts.ts";
import {
	registerWorkflowQuestions,
	WORKFLOW_QUESTION_TOOL,
	type WorkflowQuestionnaireResult,
} from "./questions.ts";
import {
	createSpawnReviewAgent,
	generateWorkflowReview,
	type ReviewAgentRunner,
} from "./review.ts";
import {
	appendClarifications,
	createDraft,
	draftFiles,
	ensureWorkflowFiles,
	pathExists,
	promoteDraft,
	readCompletedWorkflowMetadata,
	readText,
	readWorkflowReview,
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
	writeWorkflowReview,
} from "./storage.ts";
import {
	registerWorkflowCompletionRenderer,
	runWorkflowProgress,
	showWorkflowCompletion,
	showWorkflowPhaseStatus,
} from "./ui.ts";
import { transitionWorkflowState, workflowStateName } from "./workflow-state.ts";

type SessionWorkflowPhase = "planning" | "implementation" | "review" | "revision" | "cleanup" | "complete";

interface WorkflowPhaseData {
	phase: SessionWorkflowPhase;
	draftId?: string;
	identifier?: string;
	reviewRound?: number;
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
	headRefOid: string;
}

interface CompletionFailure {
	message: string;
}

const PHASE_ENTRY = "implementation-workflow-phase";
const PHASE_REMINDER_ENTRY = "implementation-workflow-phase-reminder";
const DASHBOARD_SHORTCUT = "ctrl+alt+d";
const WORKFLOW_BRANCH_PREFIX = "workflow/";
const REVIEW_DISABLED_TOOLS = new Set(["edit", "write"]);

export interface ImplementationWorkflowDependencies {
	reviewAgentRunner?: ReviewAgentRunner;
}

export default function implementationWorkflow(
	pi: ExtensionAPI,
	dependencies: ImplementationWorkflowDependencies = {},
): void {
	registerWorkflowCompletionRenderer(pi);

	let phase: SessionWorkflowPhase | undefined;
	let draftId: string | undefined;
	let identifier: string | undefined;
	let sessionReviewRound: number | undefined;
	let metadata: CompletedWorkflowMetadata | undefined;
	let draftMetadata: DraftWorkflowMetadata | undefined;
	let activeFiles: WorkflowFiles | undefined;
	let planDescription = "";
	let baseTools: string[] = [];
	let dashboardOpened = false;
	let completionInFlight = false;
	let lastAutomaticFailure: string | undefined;
	let phaseReminderVisible = false;

	registerWorkflowPlanTool(pi, async (rawDescription) => {
		if (phase !== "planning" || !activeFiles) {
			throw new Error("The implementation plan can only be updated during workflow planning.");
		}
		const files = activeFiles;
		return withFileMutationQueue(files.workingPlan, async () => {
			if (!draftMetadata) throw new Error("The workflow draft has no metadata.");
			const plan = await readText(files.workingPlan);
			const description = normalizePlanDescription(rawDescription);
			const version = await savePlanVersion(files, plan);
			draftMetadata = { ...draftMetadata, description };
			await writeDraftWorkflowMetadata(files, draftMetadata);
			planDescription = description;
			pi.setSessionName(workflowSessionName("Planning", undefined, description));
			await writeWorkflowDashboard(files);
			return { version: version.number };
		});
	});

	registerWorkflowQuestions(pi, async (result) => {
		if ((phase !== "implementation" && phase !== "revision") || !activeFiles) {
			throw new Error("Implementation clarifications can only be saved during implementation or revision.");
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
		sessionReviewRound = data.reviewRound;
		phaseReminderVisible = false;
		pi.appendEntry(PHASE_ENTRY, data);
	}

	function updatePhaseStatus(ctx: ExtensionContext): void {
		const activePhase =
			phase === "planning" ||
			(phase === "implementation" && metadata?.state.phase === "implementing" && metadata.state.step === "active") ||
			(phase === "revision" && metadata?.state.phase === "revising" && metadata.state.step === "active") ||
			(phase === "review" && metadata?.state.phase === "reviewing")
				? phase
				: undefined;
		showWorkflowPhaseStatus(ctx, phaseReminderVisible ? activePhase : undefined);
	}

	function revealPhaseReminder(ctx: ExtensionContext): void {
		if (phaseReminderVisible) return;
		if (phase !== "planning" && phase !== "implementation" && phase !== "revision" && phase !== "review") return;
		phaseReminderVisible = true;
		pi.appendEntry(PHASE_REMINDER_ENTRY, { phase, draftId, identifier });
		updatePhaseStatus(ctx);
	}

	function applyPhaseTools(): void {
		const withoutWorkflowTools = baseTools.filter(
			(name) => name !== WORKFLOW_QUESTION_TOOL && name !== WORKFLOW_UPDATE_PLAN_TOOL,
		);
		if (phase === "planning") {
			pi.setActiveTools([...new Set([...withoutWorkflowTools, WORKFLOW_UPDATE_PLAN_TOOL])]);
			return;
		}
		if (
			(phase === "implementation" && metadata?.state.phase === "implementing" && metadata.state.step === "active") ||
			(phase === "revision" && metadata?.state.phase === "revising" && metadata.state.step === "active")
		) {
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

	async function openDashboard(ctx: ExtensionContext, force = false): Promise<void> {
		if (!activeFiles) {
			ctx.ui.notify("No workflow dashboard is available in this session.", "info");
			return;
		}
		const currentHead = metadata ? await gitValue(metadata.worktreePath, ["rev-parse", "HEAD"]) : undefined;
		await writeWorkflowDashboard(activeFiles, currentHead);
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
		planDescription = workflowMetadata.description?.trim() ?? "";
		if ("draftId" in workflowMetadata) {
			draftMetadata = workflowMetadata;
			metadata = undefined;
		} else {
			metadata = workflowMetadata;
			draftMetadata = undefined;
		}
		await writeWorkflowDashboard(files);
	}

	pi.registerCommand("workflow-plan", {
		description: "Capture an ask in the multiline editor and start a persistent WHAT/WHY implementation plan",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (phase === "planning" && draftId) {
				ctx.ui.notify(
					"Workflow planning is already active. Continue planning through normal conversation instead of running /workflow-plan again.",
					"info",
				);
				return;
			}

			const repository = await repositoryIdentity(ctx.cwd);
			if (!repository) {
				ctx.ui.notify("Workflow planning must start inside a Git repository.", "error");
				return;
			}

			const ask = await ctx.ui.editor("Describe what this workflow should accomplish", args);
			if (ask === undefined || !ask.trim()) {
				ctx.ui.notify("Planning did not start because no ask was submitted.", "info");
				return;
			}

			const nextDraftId = ctx.sessionManager.getSessionId().replaceAll(/[^a-zA-Z0-9-]/g, "-");
			const files = draftFiles(nextDraftId);
			if (await pathExists(files.root)) {
				const existing = await ensureWorkflowFiles(files);
				if (!("draftId" in existing) || existing.ask !== ask) {
					ctx.ui.notify(
						"Planning did not start because this session already has a draft with a different immutable original ask.",
						"error",
					);
					return;
				}
			} else {
				const initialMetadata: DraftWorkflowMetadata = {
					version: WORKFLOW_STATE_VERSION,
					state: { phase: "planning", step: "draft" },
					draftId: nextDraftId,
					description: "",
					ask,
					createdAt: new Date().toISOString(),
				};
				await createDraft(files, `${PLAN_TITLE}\n`, initialMetadata);
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
			pi.sendUserMessage(startPlanningUserMessage(ask));
		},
	});

	async function loadCompletedWorkflow(
		ctx: ExtensionContext,
		requestedIdentifier: string,
	): Promise<CompletedWorkflowMetadata | undefined> {
		try {
			return await readCompletedWorkflowMetadata(requestedIdentifier);
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return undefined;
		}
	}

	async function transitionToImplementation(
		ctx: ExtensionCommandContext,
		requestedIdentifier: string,
	): Promise<void> {
		const workflow = await loadCompletedWorkflow(ctx, requestedIdentifier);
		if (!workflow) return;
		const stateName = workflowStateName(workflow.state);
		if (stateName !== "planning.ready" && stateName !== "implementing.active") {
			ctx.ui.notify(`Workflow ${requestedIdentifier} is ${stateName}; it cannot enter implementation.`, "error");
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
		if (workflow.state.phase === "planning") {
			workflow.state = transitionWorkflowState(workflow.state, { phase: "implementing", step: "active" });
		}
		workflow.implementationStartedAt ??= new Date().toISOString();
		await writeCompletedWorkflowMetadata(workflow);
		const files = workflowFiles(requestedIdentifier);
		await ctx.switchSession(sessionFile, {
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(
					implementationUserMessage({
						metadataPath: files.metadata,
						planPath: files.plan,
						clarificationsPath: files.clarifications,
						baseBranch: workflow.baseBranch,
					}),
				);
			},
		});
	}

	async function transitionToReview(ctx: ExtensionCommandContext, requestedIdentifier: string): Promise<void> {
		const workflow = await loadCompletedWorkflow(ctx, requestedIdentifier);
		if (!workflow) return;
		const stateName = workflowStateName(workflow.state);
		if (
			stateName !== "implementing.complete" &&
			stateName !== "revising.complete" &&
			stateName !== "reviewing.active"
		) {
			ctx.ui.notify(`Workflow ${requestedIdentifier} is ${stateName}; it cannot enter review.`, "error");
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

		const files = workflowFiles(requestedIdentifier);
		if (workflow.state.phase === "reviewing") {
			const [existingReport, currentHead] = await Promise.all([
				readWorkflowReview(files),
				gitValue(workflow.worktreePath, ["rev-parse", "HEAD"]),
			]);
			if (existingReport && currentHead && existingReport.headCommit !== currentHead) {
				ctx.ui.notify(
					"The branch changed after this review. Return to the review session and run /workflow-revise.",
					"error",
				);
				return;
			}
		}
		const reviewRound =
			workflow.state.phase === "reviewing"
				? workflow.state.round
				: workflow.state.phase === "revising"
					? workflow.state.round + 1
					: 1;
		try {
			await ensureWorkflowReview(ctx, workflow, files, reviewRound);
		} catch (error) {
			ctx.ui.notify(`Could not generate the implementation review: ${errorMessage(error)}`, "error");
			return;
		}

		const sessionFile = await createPhaseSession(workflow.worktreePath, {
			phase: "review",
			identifier: requestedIdentifier,
			reviewRound,
		});
		if (workflow.state.phase !== "reviewing") {
			workflow.state = transitionWorkflowState(workflow.state, {
				phase: "reviewing",
				step: "active",
				round: reviewRound,
			});
		}
		workflow.reviewStartedAt ??= new Date().toISOString();
		await writeCompletedWorkflowMetadata(workflow);
		await ctx.switchSession(sessionFile, {
			withSession: async (replacementCtx) => {
				replacementCtx.ui.notify("The implementation review is ready in the workflow dashboard.", "info");
			},
		});
	}

	async function ensureWorkflowReview(
		ctx: ExtensionContext,
		workflow: CompletedWorkflowMetadata,
		files: WorkflowFiles,
		reviewRound: number,
	): Promise<void> {
		const [plan, headCommit, existing] = await Promise.all([
			readText(files.plan),
			gitValue(workflow.worktreePath, ["rev-parse", "HEAD"]),
			readWorkflowReview(files),
		]);
		if (!headCommit) throw new Error("Could not identify the pull request head commit.");
		const plannedChanges = parsePlannedChanges(plan);
		const testingCriteria = parseTestingCriteria(plan);
		if (
			existing !== undefined &&
			existing.pullRequestUrl === workflow.pullRequestUrl &&
			existing.baseCommit === workflow.baseCommit &&
			existing.headCommit === headCommit &&
			existing.testingCriteria.originalCriteria === testingCriteria &&
			existing.plannedChanges.length === plannedChanges.length &&
			existing.plannedChanges.every((change, index) => change.id === plannedChanges[index]?.id)
		) {
			await writeWorkflowReview(files, existing, reviewRound);
			await writeWorkflowDashboard(files, headCommit);
			return;
		}

		await runWorkflowProgress(
			ctx,
			"Generating implementation review",
			["Reviewing planned changes, full plan, and testing criteria", "Synthesizing overall findings", "Saving review report"],
			async (progress) => {
				const report = await generateWorkflowReview(
					{
						pullRequestUrl: workflow.pullRequestUrl!,
						baseCommit: workflow.baseCommit,
						headCommit,
						worktreePath: workflow.worktreePath,
						metadataPath: files.metadata,
						planPath: files.plan,
						clarificationsPath: files.clarifications,
						plannedChanges,
						testingCriteria,
						onStage: (stage) => {
							if (stage === "analysis-complete") {
								progress.complete("Reviewed planned changes, full plan, and testing criteria");
							}
							if (stage === "synthesis-complete") progress.complete("Synthesized overall findings");
						},
					},
					dependencies.reviewAgentRunner ??
						createSpawnReviewAgent({
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
							thinkingLevel: ctx.thinkingLevel,
							signal: ctx.signal,
						}),
				);
				await writeWorkflowReview(files, report, reviewRound);
				await writeWorkflowDashboard(files, headCommit);
				progress.complete("Saved review report");
			},
		);
	}

	pi.registerCommand("workflow-revise", {
		description: "Start a separate implementation revision from the current review",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (phase !== "review" || !identifier || !activeFiles) {
				ctx.ui.notify("Revisions can only start from an active workflow review session.", "error");
				return;
			}
			const request = await ctx.ui.editor("Describe the implementation changes to make", args);
			if (request === undefined || !request.trim()) {
				ctx.ui.notify("Revision did not start because no change request was submitted.", "info");
				return;
			}
			await beginRevision(ctx, request);
		},
	});

	async function beginRevision(ctx: ExtensionCommandContext, request: string): Promise<void> {
		if (!identifier || !activeFiles) return;
		const workflow = await loadCompletedWorkflow(ctx, identifier);
		if (!workflow) return;
		const reviewingCurrentRound =
			workflow.state.phase === "reviewing" &&
			(sessionReviewRound === workflow.state.round || (sessionReviewRound === undefined && workflow.state.round === 1));
		const retryingCancelledSwitch =
			workflow.state.phase === "revising" &&
			workflow.state.step === "active" &&
			(sessionReviewRound === workflow.state.round || (sessionReviewRound === undefined && workflow.state.round === 1));
		if (!reviewingCurrentRound && !retryingCancelledSwitch) {
			ctx.ui.notify(
				`This review session cannot start a revision while the workflow is ${workflowStateName(workflow.state)}.`,
				"error",
			);
			return;
		}
		if (!(await requireLaunchRepository(ctx, workflow))) return;
		const validation = await validateWorktree(workflow);
		if (validation) {
			ctx.ui.notify(`Revision cannot start: ${validation.message}.`, "error");
			return;
		}
		const report = await readWorkflowReview(activeFiles);
		if (!report) {
			ctx.ui.notify("Revision cannot start because the workflow has no saved review report.", "error");
			return;
		}
		if (workflow.state.phase !== "reviewing" && workflow.state.phase !== "revising") return;
		const reviewRound = workflow.state.round;
		await writeWorkflowReview(activeFiles, report, reviewRound);
		const sessionFile = await createPhaseSession(workflow.worktreePath, {
			phase: "revision",
			identifier,
			reviewRound,
		});
		if (workflow.state.phase === "reviewing") {
			workflow.state = transitionWorkflowState(workflow.state, {
				phase: "revising",
				step: "active",
				round: reviewRound,
				reviewedHeadCommit: report.headCommit,
			});
			workflow.revisionStartedAt = new Date().toISOString();
			workflow.revisionCompletedAt = undefined;
			await writeCompletedWorkflowMetadata(workflow);
		}
		metadata = workflow;
		await ctx.switchSession(sessionFile, {
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(revisionUserMessage({ request, reviewPath: activeFiles!.review }));
			},
		});
	}

	pi.registerCommand("workflow-next", {
		description: "Advance the active workflow to its next phase",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (phase === "planning") {
				await completePlanning(ctx);
				return;
			}
			if (phase === "implementation") {
				await advanceImplementation(ctx);
				return;
			}
			if (phase === "revision") {
				await advanceRevision(ctx);
				return;
			}
			if (phase === "review") {
				if (await blockStaleReviewCleanup(ctx)) return;
				await beginReviewCleanup(ctx);
				return;
			}
			if (phase === "cleanup" && identifier) {
				await finishReviewCleanup(ctx, identifier);
				return;
			}
			if (phase === "complete" && identifier) {
				const workflow = await loadCompletedWorkflow(ctx, identifier);
				if (
					workflow &&
					(workflowStateName(workflow.state) === "planning.ready" ||
						workflowStateName(workflow.state) === "implementing.active")
				) {
					await transitionToImplementation(ctx, identifier);
					return;
				}
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
		if (currentDraftMetadata.version === WORKFLOW_STATE_VERSION && !currentDraftMetadata.ask?.trim()) {
			ctx.ui.notify("Planning cannot complete without the immutable original ask.", "error");
			return;
		}
		const draft = activeFiles;
		const [plan, workingPlan] = await Promise.all([readText(draft.plan), readText(draft.workingPlan)]);
		if (workingPlan !== plan) {
			ctx.ui.notify(
				`The working plan has uncommitted changes. Call ${WORKFLOW_UPDATE_PLAN_TOOL} before advancing to implementation.`,
				"error",
			);
			return;
		}
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
						version: currentDraftMetadata.version,
						identifier: nextIdentifier,
						description,
						ask: currentDraftMetadata.ask,
						state: transitionWorkflowState(currentDraftMetadata.state, { phase: "planning", step: "ready" }),
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
		await transitionToImplementation(ctx, nextIdentifier);
	}

	async function advanceImplementation(ctx: ExtensionCommandContext): Promise<void> {
		if (!identifier) return;
		const workflow = await loadCompletedWorkflow(ctx, identifier);
		if (!workflow) return;
		if (
			workflowStateName(workflow.state) === "implementing.complete" ||
			workflowStateName(workflow.state) === "reviewing.active"
		) {
			await transitionToReview(ctx, identifier);
			return;
		}
		const completedWorkflow = await completeCodingPhase(ctx, false, "implementation");
		if (completedWorkflow) await transitionToReview(ctx, identifier);
	}

	async function advanceRevision(ctx: ExtensionCommandContext): Promise<void> {
		if (!identifier) return;
		const workflow = await loadCompletedWorkflow(ctx, identifier);
		if (!workflow) return;
		if (
			workflow.state.phase !== "revising" ||
			workflow.state.round !== sessionReviewRound
		) {
			ctx.ui.notify(`This revision session cannot advance workflow state ${workflowStateName(workflow.state)}.`, "error");
			return;
		}
		if (workflow.state.step === "complete") {
			await transitionToReview(ctx, identifier);
			return;
		}
		const completedWorkflow = await completeCodingPhase(ctx, false, "revision");
		if (completedWorkflow) await transitionToReview(ctx, identifier);
	}

	async function completeImplementation(
		ctx: ExtensionContext,
		automatic: boolean,
	): Promise<CompletedWorkflowMetadata | undefined> {
		return completeCodingPhase(ctx, automatic, "implementation");
	}

	async function completeRevision(
		ctx: ExtensionContext,
		automatic: boolean,
	): Promise<CompletedWorkflowMetadata | undefined> {
		return completeCodingPhase(ctx, automatic, "revision");
	}

	async function completeCodingPhase(
		ctx: ExtensionContext,
		automatic: boolean,
		codingPhase: "implementation" | "revision",
	): Promise<CompletedWorkflowMetadata | undefined> {
		if (!identifier || completionInFlight) return undefined;
		completionInFlight = true;
		const phaseLabel = codingPhase === "implementation" ? "Implementation" : "Revision";
		try {
			const workflow = await readCompletedWorkflowMetadata(identifier);
			metadata = workflow;
			if (codingPhase === "implementation") {
				if (workflow.state.phase === "implementing" && workflow.state.step === "complete") return workflow;
				if (workflow.state.phase !== "implementing" || workflow.state.step !== "active") {
					if (!automatic) ctx.ui.notify(`Workflow ${identifier} is ${workflowStateName(workflow.state)}.`, "error");
					return undefined;
				}
			} else {
				if (workflow.state.phase === "revising" && workflow.state.step === "complete") return workflow;
				if (
					workflow.state.phase !== "revising" ||
					workflow.state.step !== "active" ||
					workflow.state.round !== sessionReviewRound
				) {
					if (!automatic) ctx.ui.notify(`Workflow ${identifier} is ${workflowStateName(workflow.state)}.`, "error");
					return undefined;
				}
			}
			const completion = await runWorkflowProgress<
				{ failure: CompletionFailure } | { pullRequest: PullRequestInfo }
			>(ctx, `Completing ${codingPhase}`, ["Checking worktree", "Checking pull request"], async (progress) => {
				const failure = await implementationCompletionFailure(workflow);
				if (failure) {
					progress.fail("Worktree is not ready");
					return { failure };
				}
				const headCommit = await gitValue(workflow.worktreePath, ["rev-parse", "HEAD"]);
				if (!headCommit) {
					progress.fail("Could not identify the branch head");
					return { failure: { message: "could not identify the branch head commit" } };
				}
				if (workflow.state.phase === "revising" && headCommit === workflow.state.reviewedHeadCommit) {
					progress.fail("Revision has no new commit");
					return { failure: { message: "the revision has not created a new commit" } };
				}
				progress.complete("Checked clean worktree");
				const pullRequest = await findPullRequest(workflow);
				if (!pullRequest) {
					progress.fail("Open pull request not found");
					return {
						failure: { message: `no open pull request from ${workflow.workflowBranch} to ${workflow.baseBranch}` },
					};
				}
				if (pullRequest.headRefOid !== headCommit) {
					progress.fail("Pull request does not contain local HEAD");
					return { failure: { message: "the local HEAD commit has not been pushed to the pull request branch" } };
				}
				progress.complete(`Checked pull request #${pullRequest.number}`);
				return { pullRequest };
			});
			if ("failure" in completion) {
				const message = completion.failure.message;
				if (!automatic || lastAutomaticFailure !== message) {
					ctx.ui.notify(`${phaseLabel} is not complete: ${message}.`, automatic ? "warning" : "error");
				}
				lastAutomaticFailure = message;
				return undefined;
			}

			workflow.state = transitionWorkflowState(workflow.state, {
				...workflow.state,
				step: "complete",
			});
			if (codingPhase === "implementation") workflow.implementationCompletedAt = new Date().toISOString();
			else workflow.revisionCompletedAt = new Date().toISOString();
			workflow.pullRequestUrl = completion.pullRequest.url;
			workflow.pullRequestNumber = completion.pullRequest.number;
			await writeCompletedWorkflowMetadata(workflow);
			metadata = workflow;
			lastAutomaticFailure = undefined;
			applyPhaseTools();
			updatePhaseStatus(ctx);
			if (automatic) await showCodingCompletion(ctx, workflow, codingPhase);
			return workflow;
		} catch (error) {
			ctx.ui.notify(`Could not complete ${codingPhase}: ${errorMessage(error)}`, "error");
			return undefined;
		} finally {
			completionInFlight = false;
		}
	}

	async function showCodingCompletion(
		ctx: ExtensionContext,
		workflow: CompletedWorkflowMetadata,
		codingPhase: "implementation" | "revision",
	): Promise<void> {
		const command = "/workflow-next";
		let clipboardError: unknown;
		try {
			await copyToClipboard(command);
		} catch (error) {
			clipboardError = error;
		}
		const title = codingPhase === "implementation" ? "Implementation complete" : "Revision complete";
		showWorkflowCompletion(pi, ctx, {
			title,
			details: workflow.pullRequestUrl ? [`Pull request: ${workflow.pullRequestUrl}`] : undefined,
			command,
			clipboard: clipboardError ? "failed" : "copied",
			instruction: clipboardError
				? `Could not copy the command: ${errorMessage(clipboardError)}. Copy it above and paste it here to start a separate review session.`
				: "Copied to the clipboard. Paste this command here to start a separate review session.",
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
				"number,url,baseRefName,headRefName,headRefOid",
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

	async function blockStaleReviewCleanup(ctx: ExtensionCommandContext): Promise<boolean> {
		if (!identifier || !activeFiles) return false;
		const workflow = await readCompletedWorkflowMetadata(identifier);
		if (
			workflow.state.phase !== "reviewing" ||
			(sessionReviewRound !== workflow.state.round && !(sessionReviewRound === undefined && workflow.state.round === 1))
		) {
			ctx.ui.notify(`This review session cannot advance workflow state ${workflowStateName(workflow.state)}.`, "error");
			return true;
		}
		const report = await readWorkflowReview(activeFiles);
		if (!report) return false;
		const headCommit = await gitValue(workflow.worktreePath, ["rev-parse", "HEAD"]);
		if (!headCommit || report.headCommit === headCommit) return false;
		ctx.ui.notify(
			"The branch changed after this review. Run /workflow-revise to enter the revision phase before generating another review.",
			"warning",
		);
		return true;
	}

	async function beginReviewCleanup(ctx: ExtensionCommandContext): Promise<void> {
		if (!identifier) return;
		let preparation:
			| { workflow: CompletedWorkflowMetadata; sessionFile: string }
			| { failure: CompletionFailure };
		try {
			const workflow = await readCompletedWorkflowMetadata(identifier);
			if (
				workflow.state.phase !== "reviewing" ||
				(sessionReviewRound !== workflow.state.round && !(sessionReviewRound === undefined && workflow.state.round === 1))
			) {
				ctx.ui.notify(`This review session cannot complete workflow state ${workflowStateName(workflow.state)}.`, "error");
				return;
			}
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

					workflow.state = transitionWorkflowState(workflow.state, {
						phase: "complete",
						step: "cleanup_pending",
					});
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
		if (workflowStateName(workflow.state) !== "complete.cleanup_pending") return;
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

		workflow.state = transitionWorkflowState(workflow.state, { phase: "complete", step: "complete" });
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
		description: "Open the active implementation workflow dashboard",
		handler: async (_args, ctx) => {
			await openDashboard(ctx, true);
		},
	});

	pi.registerShortcut(DASHBOARD_SHORTCUT, {
		description: "Open the implementation workflow dashboard",
		handler: async (ctx) => {
			await openDashboard(ctx, true);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeFiles || !phase) return;
		let instructions = "";
		if (phase === "planning") {
			instructions = planningSystemPrompt({
				planPath: activeFiles.plan,
				workingPlanPath: activeFiles.workingPlan,
				updatePlanTool: WORKFLOW_UPDATE_PLAN_TOOL,
			});
		}
		if (phase === "implementation" && metadata?.state.phase === "implementing" && metadata.state.step === "active") {
			instructions = implementationSystemPrompt({
				identifier,
				metadataPath: activeFiles.metadata,
				planPath: activeFiles.plan,
				clarificationsPath: activeFiles.clarifications,
				questionTool: WORKFLOW_QUESTION_TOOL,
				worktreePath: metadata.worktreePath,
				workflowBranch: metadata.workflowBranch,
				baseBranch: metadata.baseBranch,
			});
		}
		if (phase === "revision" && metadata?.state.phase === "revising" && metadata.state.step === "active") {
			instructions = revisionSystemPrompt({
				identifier,
				reviewRound: sessionReviewRound,
				metadataPath: activeFiles.metadata,
				planPath: activeFiles.plan,
				clarificationsPath: activeFiles.clarifications,
				reviewPath: activeFiles.review,
				questionTool: WORKFLOW_QUESTION_TOOL,
				worktreePath: metadata.worktreePath,
				workflowBranch: metadata.workflowBranch,
				baseBranch: metadata.baseBranch,
			});
		}
		if (phase === "review") {
			instructions = reviewSystemPrompt({
				identifier,
				pullRequestUrl: metadata?.pullRequestUrl,
				metadataPath: activeFiles.metadata,
				planPath: activeFiles.plan,
				clarificationsPath: activeFiles.clarifications,
				reviewPath: activeFiles.review,
				reviewMarkdownPath: activeFiles.reviewMarkdown,
			});
		}
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!activeFiles || !phase || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return;
		const target = resolve(ctx.cwd, rawPath.replace(/^@/, ""));
		const reason = workflowWriteBlockReason(phase, activeFiles, target);
		if (reason) return { block: true, reason };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (phase === "implementation" && metadata?.state.phase === "implementing" && metadata.state.step === "active") {
			await completeImplementation(ctx, true);
		}
		if (phase === "revision" && metadata?.state.phase === "revising" && metadata.state.step === "active") {
			await completeRevision(ctx, true);
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
		sessionReviewRound = saved?.reviewRound;
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
		if ((phase === "implementation" || phase === "revision" || phase === "review" || phase === "cleanup" || phase === "complete") && identifier) {
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
		if (phase === "revision" && identifier) {
			pi.setSessionName(workflowSessionName("Revise", identifier, metadata?.description ?? planDescription));
		}
		if (phase === "review" && identifier) {
			pi.setSessionName(workflowSessionName("Review", identifier, metadata?.description ?? planDescription));
		}
		if ((phase === "planning" || phase === "implementation" || phase === "revision" || phase === "review") && activeFiles) {
			await openDashboard(ctx);
		}
		if (phase === "review") revealPhaseReminder(ctx);
		if (phase === "cleanup" && identifier) await finishReviewCleanup(ctx, identifier);
	});
}

export function workflowWriteBlockReason(
	phase: SessionWorkflowPhase,
	files: WorkflowFiles,
	targetPath: string,
): string | undefined {
	if (phase === "planning") {
		if (resolve(targetPath) === resolve(files.workingPlan)) return undefined;
		return `Planning edit/write calls may only change ${files.workingPlan}. Commit it with ${WORKFLOW_UPDATE_PLAN_TOOL}.`;
	}
	if (resolve(targetPath) === resolve(files.metadata)) {
		return "Workflow metadata, including the original ask, is managed by the workflow and read-only.";
	}
	if (resolve(targetPath) === resolve(files.plan)) {
		return "The workflow plan is frozen and read-only in this phase.";
	}
	return undefined;
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
