import { lstatSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { clampThinkingLevel, type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SessionManager,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import {
	loadImplementationWorkflowConfig,
	type ImplementationWorkflowConfig,
	type ModelOverridePhase,
} from "./config.ts";
import {
	closeOwnedDashboardServer,
	dashboardReference,
	dashboardServerConfig,
	dashboardUrl,
	ensureSharedDashboardServer,
	type DashboardServerConfig,
} from "./dashboard-server.ts";
import { writeWorkflowDashboard } from "./dashboard.ts";
import { checkDelivery, findCurrentPullRequest } from "./delivery.ts";
import {
	gitValue,
	installWorkflowExcludes,
	workflowContentHead,
	isAncestor,
	isPathInside,
	repositoryIdentity,
	validateWorktree,
	worktreeStatus,
	type ExecFn,
} from "./git.ts";
import { planningCompletionError } from "./planning.ts";
import { readWorkflowScope, selectImplementationWork, type WorkflowScope } from "./workflow-scope.ts";
import type { PlanPublicationPolicy } from "./plan-storage.ts";
import {
	formatPullRequestStack,
	toWorkflowPullRequests,
	type WorkflowPullRequest,
} from "./pull-requests.ts";
import {
	registerWorkflowPlanTool,
	WORKFLOW_UPDATE_PLAN_TOOL,
	type UpdatePlanResult,
} from "./plan-tool.ts";
import {
	briefingSystemPrompt,
	briefingUserMessage,
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
import type { WorkflowReviewReport } from "./review-report.ts";
import {
	readReviewSourceFingerprint,
	reviewCanSeedIncremental,
	reviewIsCurrent,
	reviewSourceFingerprint,
	type ReviewInputsSnapshot,
} from "./review-selection.ts";
import {
	appendClarifications,
	appendWorkflowReview,
	createWorkflow,
	ensureWorkflowFiles,
	listCompletedWorkflows,
	listSavedReviews,
	pathExists,
	readActiveWorkflow,
	registerWorkflow,
	readCompletedWorkflowMetadata,
	readText,
	readWorkflowReview,
	readPlanVersion,
	preparePlanDraft,
	finalizePlanDraft,
	hasUnsavedPlanDraft,
	withPlanLock,
	WORKFLOW_METADATA_VERSION,
	type CompletedWorkflowMetadata,
	type SavedWorkflowReview,
	type WorkflowClarification,
	type WorkflowFiles,
	workflowFiles,
	workflowsRoot,
	writeCompletedWorkflowMetadata,
} from "./storage.ts";
import {
	PHASE_REMINDER_ENTRY,
	registerWorkflowCompletionRenderer,
	registerWorkflowPhaseReminderRenderer,
	runWorkflowProgress,
	showReviewReadyNotice,
	showWorkflowCompletion,
	showWorkflowPhaseStatus,
} from "./ui.ts";
import { resolveWorkflow, workflowIdentifierCompletions } from "./workflow-select.ts";

type SessionWorkflowPhase = "planning" | "implementation" | "review" | "revision" | "cleanup" | "complete";

interface WorkflowPhaseData {
	phase: SessionWorkflowPhase;
	identifier?: string;
	/** Cleanup sessions: remove the worktree with --force after the user confirmed discarding changes. */
	force?: boolean;
}

const PHASE_ENTRY = "implementation-workflow-phase";
const BINDING_ENTRY = "implementation-workflow-binding";
const DASHBOARD_SHORTCUT = "ctrl+alt+d";
const WORKFLOW_BRANCH_PREFIX = "workflow/";
// Shell and delegated agents must not bypass the review assistant's draft-only writes.
const REVIEW_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", WORKFLOW_UPDATE_PLAN_TOOL]);

type WorktreeVerb = "implement" | "review" | "revise" | "cleanup" | "brief";

export interface ImplementationWorkflowDependencies {
	reviewAgentRunner?: ReviewAgentRunner;
}

export default function implementationWorkflow(
	pi: ExtensionAPI,
	dependencies: ImplementationWorkflowDependencies = {},
): void {
	registerWorkflowCompletionRenderer(pi);
	registerWorkflowPhaseReminderRenderer(pi);

	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	let phase: SessionWorkflowPhase | undefined;
	let identifier: string | undefined;
	let briefed = false;
	let cleanupForce = false;
	let metadata: CompletedWorkflowMetadata | undefined;
	let activeFiles: WorkflowFiles | undefined;
	let planDescription = "";
	let baseTools: string[] = [];
	let dashboardAnnounced = false;
	let workflowConfigPromise: Promise<ImplementationWorkflowConfig> | undefined;
	let dashboardConfigPromise: Promise<DashboardServerConfig> | undefined;
	let readinessCheckInFlight = false;
	let phaseReminderVisible = false;
	let currentPullRequest: WorkflowPullRequest | undefined;
	let pullRequestRefreshGeneration = 0;

	registerWorkflowPlanTool(pi, async (input, ctx) => {
		if (!activeFiles || !identifier || (phase !== "planning" && phase !== "review" && phase !== "implementation")) {
			throw new Error("Plan updates require a bound planning, review, or implementation session.");
		}
		const files = activeFiles;
		return withFileMutationQueue(files.workingPlan, async () => {
			if (identifier) metadata = await readCompletedWorkflowMetadata(identifier);
			if (!metadata) throw new Error("The workflow has no metadata.");
			if (phase === "planning" && metadata.approvedPlanVersion !== undefined) throw new Error("Only an unapproved workflow plan can be updated during planning.");
			if (phase !== "planning" && metadata.approvedPlanVersion === undefined) throw new Error("Review and implementation plan updates require approval.");
			let policy: PlanPublicationPolicy = { phase: phase as "planning" | "implementation" };
			let reviewContext: { reviewPath: string; followupOrigin: { reviewNumber: number; sessionId: string; entryId: string } } | undefined;
			if (phase === "review") {
				if (!ctx) throw new Error("Review plan updates require the current session context.");
				const savedReview = (await listSavedReviews(files)).at(-1);
				if (!savedReview) throw new Error("Review followups require an actual saved review.");
				const entryIds = ctx.sessionManager.getBranch().map((entry) => entry.id).filter((id) => typeof id === "string" && id.length > 0);
				const sessionId = ctx.sessionManager.getSessionId();
				if (!entryIds.length) throw new Error("Review followups require a saved conversation entry.");
				policy = { phase: "review", reviewOrigin: { reviewNumber: savedReview.number, sessionId, entryIds } };
				reviewContext = { reviewPath: savedReview.path, followupOrigin: { reviewNumber: savedReview.number, sessionId, entryId: entryIds.at(-1)! } };
			}
			if (input.action === "prepare") {
				const draft = await preparePlanDraft(files);
				return {
					action: "prepare", draftPath: draft.path, baseVersion: draft.baseVersion,
					allowedEdits: phase === "planning" ? "Plan JSON and Markdown; all implemented fields must be false."
						: phase === "implementation" ? "Only implemented booleans in existing change_metadata.json files. Requirements and readingOrder are read-only."
						: "Followup change_metadata.json, change.md, testing.md, and the followup portion of readingOrder. New or revised followups must be false; preserve every other flag. Original files are read-only.",
					...(metadata.approvedPlanVersion === undefined ? {} : { baselinePath: planPathForWorkflow(files, metadata) }),
					...reviewContext,
				};
			}
			const description = normalizePlanDescription(input.description);
			const version = await finalizePlanDraft(files, description, input.expectedBaseVersion, policy);
			// The snapshot owns its description. No fallible durable writes after publication.
			metadata = { ...metadata, description };
			planDescription = description;
			pi.setSessionName(workflowSessionName(phase === "planning" ? "Planning" : phase === "review" ? "Review" : "Implement", identifier, description));
			let dashboardUrl: string | undefined;
			let dashboardError: string | undefined;
			try {
				await writeWorkflowDashboard(files);
				dashboardUrl = await ensureDashboardLink();
			} catch (error) {
				dashboardError = errorMessage(error);
			}
			const result: UpdatePlanResult = {
				action: "finalize",
				version: version.number,
				dashboardUrl,
				dashboardError,
			};
			return result;
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

	function latestBinding(entries: SessionEntry[]): string | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type === "custom" && entry.customType === BINDING_ENTRY) {
				const value = entry.data as { identifier?: unknown };
				if (typeof value?.identifier === "string") return value.identifier;
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
		identifier = data.identifier;
		cleanupForce = data.force ?? false;
		phaseReminderVisible = false;
		pi.appendEntry(PHASE_ENTRY, data);
	}

	function updatePhaseStatus(ctx: ExtensionContext): void {
		const activePhase =
			phase === "planning" || phase === "implementation" || phase === "revision" || phase === "review"
				? phase
				: undefined;
		showWorkflowPhaseStatus(
			ctx,
			phaseReminderVisible || currentPullRequest ? activePhase : undefined,
			currentPullRequest,
			ctx.mode === "tui" && getCapabilities().hyperlinks,
		);
	}

	async function refreshCurrentPullRequest(ctx: ExtensionContext): Promise<void> {
		const generation = ++pullRequestRefreshGeneration;
		const targetPhase = phase;
		const targetMetadata = metadata;
		if (
			(targetPhase !== "implementation" && targetPhase !== "revision" && targetPhase !== "review") ||
			!targetMetadata
		) {
			currentPullRequest = undefined;
			updatePhaseStatus(ctx);
			return;
		}
		let pullRequest: WorkflowPullRequest | undefined;
		try {
			pullRequest = await findCurrentPullRequest(exec, targetMetadata);
		} catch {
			// Pull request status is optional footer guidance; never surface lookup failures.
		}
		if (
			generation !== pullRequestRefreshGeneration ||
			phase !== targetPhase ||
			metadata !== targetMetadata
		) {
			return;
		}
		currentPullRequest = pullRequest;
		updatePhaseStatus(ctx);
	}

	function revealPhaseReminder(ctx: ExtensionContext): void {
		if (phaseReminderVisible) return;
		if (phase !== "planning" && phase !== "implementation" && phase !== "revision" && phase !== "review") return;
		phaseReminderVisible = true;
		pi.appendEntry(PHASE_REMINDER_ENTRY, { phase, identifier });
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
		if (phase === "implementation" || phase === "revision") {
			pi.setActiveTools([...new Set([...withoutWorkflowTools, WORKFLOW_QUESTION_TOOL, WORKFLOW_UPDATE_PLAN_TOOL])]);
			return;
		}
		if (phase === "review") {
			pi.setActiveTools([...new Set([...withoutWorkflowTools, "edit", "write", WORKFLOW_UPDATE_PLAN_TOOL])].filter((name) => REVIEW_TOOLS.has(name)));
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

	function workflowConfig(): Promise<ImplementationWorkflowConfig> {
		workflowConfigPromise ??= loadImplementationWorkflowConfig(getAgentDir());
		return workflowConfigPromise;
	}

	function dashboardConfig(): Promise<DashboardServerConfig> {
		dashboardConfigPromise ??= workflowConfig().then(dashboardServerConfig);
		return dashboardConfigPromise;
	}

	async function configuredPhaseOverride(ctx: ExtensionContext, modelPhase: ModelOverridePhase) {
		const config = await workflowConfig();
		const override = config.models[modelPhase];
		if (!override) return undefined;
		const model = override.provider && override.model
			? ctx.modelRegistry.find(override.provider, override.model)
			: undefined;
		if (override.provider && override.model && !model) {
			throw new Error(
				`Configured ${modelPhase} model ${override.provider}/${override.model} is not registered (models.${modelPhase} in ${config.configPath}).`,
			);
		}
		return { model, thinkingLevel: override.thinkingLevel };
	}

	async function applyPhaseOverride(ctx: ExtensionContext): Promise<void> {
		const modelPhase = phaseModelOverrideName(phase);
		if (!modelPhase) return;
		try {
			const override = await configuredPhaseOverride(ctx, modelPhase);
			if (!override) return;
			const { model, thinkingLevel } = override;
			let modelAvailable = true;
			if (model && (ctx.model?.provider !== model.provider || ctx.model.id !== model.id)) {
				modelAvailable = await pi.setModel(model);
				if (!modelAvailable) {
					const config = await workflowConfig();
					ctx.ui.notify(
						`Could not use configured ${modelPhase} model ${model.provider}/${model.id}: no authentication is available. Configuration: ${config.configPath}`,
						"error",
					);
				}
			}
			if (thinkingLevel !== undefined && modelAvailable) pi.setThinkingLevel(thinkingLevel);
		} catch (error) {
			ctx.ui.notify(`Could not apply the workflow phase override: ${errorMessage(error)}`, "error");
		}
	}

	function activeDashboardReference() {
		if (!activeFiles) return undefined;
		if (identifier) return dashboardReference(activeFiles, "workflow", identifier);
		return undefined;
	}

	async function ensureDashboardLink(): Promise<string> {
		const reference = activeDashboardReference();
		if (!reference) throw new Error("No workflow dashboard is available in this session.");
		const config = await dashboardConfig();
		const result = await ensureSharedDashboardServer(config, workflowsRoot());
		if (result.status === "error") {
			throw new Error(
				`Could not serve the workflow dashboard on ${config.listenHost}:${config.listenPort}. ${result.message}\nConfiguration: ${config.configPath}`,
			);
		}
		return dashboardUrl(reference, config);
	}

	async function presentDashboard(ctx: ExtensionContext, force = false): Promise<void> {
		const reference = activeDashboardReference();
		if (!activeFiles || !reference) {
			ctx.ui.notify("No workflow dashboard is available in this session.", "info");
			return;
		}
		const currentHead = metadata ? await workflowContentHead(exec, metadata) : undefined;
		await writeWorkflowDashboard(activeFiles, currentHead);
		if (dashboardAnnounced && !force) return;

		let url: string;
		try {
			url = await ensureDashboardLink();
		} catch (error) {
			ctx.ui.notify(`Could not configure the workflow dashboard: ${errorMessage(error)}`, "error");
			return;
		}

		const displayLink = ctx.mode === "tui" && getCapabilities().hyperlinks ? hyperlink(url, url) : url;
		ctx.ui.notify(`Workflow dashboard: ${displayLink}`, "info");
		dashboardAnnounced = true;
	}

	async function requireLaunchRepository(ctx: ExtensionContext, workflow: CompletedWorkflowMetadata): Promise<boolean> {
		const current = await repositoryIdentity(exec, ctx.cwd);
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

	async function createPhaseSession(cwd: string, data: WorkflowPhaseData, ctx: ExtensionContext): Promise<string> {
		const manager = SessionManager.create(cwd);
		const sessionFile = manager.getSessionFile();
		const header = manager.getHeader();
		if (!sessionFile || !header) throw new Error("Pi did not allocate a persistent target session.");
		await mkdir(dirname(sessionFile), { recursive: true });
		await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
		const persisted = SessionManager.open(sessionFile);
		if (ctx.model?.provider && ctx.model.id) persisted.appendModelChange(ctx.model.provider, ctx.model.id);
		if (ctx.thinkingLevel) persisted.appendThinkingLevelChange(ctx.thinkingLevel);
		persisted.appendCustomEntry(PHASE_ENTRY, data);
		return sessionFile;
	}

	async function prepareActivePlan(files: WorkflowFiles): Promise<void> {
		const workflowMetadata = await ensureWorkflowFiles(files);
		activeFiles = files;
		planDescription = workflowMetadata.description?.trim() ?? "";
		if (!("identifier" in workflowMetadata)) throw new Error("Legacy planning drafts are not supported.");
		metadata = workflowMetadata;
		currentPullRequest = workflowMetadata.pullRequests?.at(-1);
		await writeWorkflowDashboard(files);
	}

	/**
	 * Resolves the workflow a verb targets and verifies the Isara sandbox was
	 * launched in its repository. Returns undefined after notifying the user.
	 */
	async function resolveTargetWorkflow(
		ctx: ExtensionCommandContext,
		argument: string,
		verb: WorktreeVerb,
	): Promise<CompletedWorkflowMetadata | undefined> {
		const result = await resolveWorkflow({
			exec,
			cwd: ctx.cwd,
			argument,
			sessionIdentifier: identifier,
			verb,
			select: (title, options) => ctx.ui.select(title, options),
		});
		if (result.status === "cancelled") return undefined;
		if (result.status === "error") {
			ctx.ui.notify(result.message, "error");
			return undefined;
		}
		if (verb !== "brief" && !(await requireLaunchRepository(ctx, result.workflow))) return undefined;
		return result.workflow;
	}

	pi.registerCommand("workflow-plan", {
		description: "Capture an ask, create its worktree, and start a persistent implementation plan",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (phase === "planning" && identifier) {
				ctx.ui.notify("Workflow planning is already active. Continue planning through normal conversation instead of running /workflow-plan again.", "info");
				return;
			}
			if (identifier) {
				ctx.ui.notify(`This session belongs to workflow ${identifier}. Start planning from a fresh session (/new) in the original checkout.`, "error");
				return;
			}
			const repository = await repositoryIdentity(exec, ctx.cwd);
			if (!repository) {
				ctx.ui.notify("Workflow planning must start inside a Git repository.", "error");
				return;
			}
			try {
				const active = await readActiveWorkflow(repository.root);
				if (active) {
					ctx.ui.notify(`This worktree already has active workflow ${active.identifier}. Start a new plan in the original checkout.`, "error");
					return;
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			const ask = await ctx.ui.editor("Describe what this workflow should accomplish", args);
			if (ask === undefined || !ask.trim()) {
				ctx.ui.notify("Planning did not start because no ask was submitted.", "info");
				return;
			}
			const [baseBranch, baseCommit, status] = await Promise.all([
				gitValue(exec, repository.root, ["branch", "--show-current"]),
				gitValue(exec, repository.root, ["rev-parse", "HEAD"]),
				worktreeStatus(exec, repository.root),
			]);
			if (!baseBranch || !baseCommit || status === undefined) {
				ctx.ui.notify("Planning requires a named branch with a valid HEAD and readable Git status.", "error");
				return;
			}
			if (status !== "" && !(await ctx.ui.confirm(
				"Original checkout has uncommitted files",
				"The worktree will start from the recorded HEAD and will not include those files. Continue?",
			))) return;

			let workflow: CompletedWorkflowMetadata;
			try {
				workflow = await runWorkflowProgress(ctx, "Starting workflow planning", ["Generating workflow slug", "Creating worktree"], async (progress) => {
					const nextIdentifier = await uniqueIdentifier(ask, ctx, repository.root);
					progress.complete(`Generated workflow slug: ${nextIdentifier}`);
					const worktreePath = join(repository.root, ".worktrees", nextIdentifier);
					const workflowBranch = `${WORKFLOW_BRANCH_PREFIX}${nextIdentifier}`;
					const initial: CompletedWorkflowMetadata = {
						version: WORKFLOW_METADATA_VERSION, identifier: nextIdentifier, description: "", ask,
						repositoryRoot: repository.root, gitCommonDir: repository.commonDir,
						baseBranch, baseCommit, workflowBranch, worktreePath, createdAt: new Date().toISOString(),
					};
					await installWorkflowExcludes(repository.commonDir);
					await mkdir(dirname(worktreePath), { recursive: true });
					const added = await exec("git", ["-C", repository.root, "worktree", "add", "-b", workflowBranch, worktreePath, baseCommit]);
					// A failed add may be a race with another process. Never remove a branch or directory we did not create.
					if (added.code !== 0) throw new Error(`Could not create worktree: ${added.stderr || added.stdout}`);
					try {
						await createWorkflow(workflowFiles(nextIdentifier, worktreePath), initial);
						await registerWorkflow(initial);
					} catch (error) {
						const removed = await exec("git", ["-C", repository.root, "worktree", "remove", "--force", worktreePath]);
						if (removed.code === 0) {
							await exec("git", ["-C", repository.root, "branch", "-D", workflowBranch]);
						}
						throw new Error(`${errorMessage(error)}${removed.code === 0 ? "" : `; could not roll back worktree: ${worktreePath}`}`);
					}
					progress.complete("Created worktree");
					return initial;
				});
			} catch (error) {
				ctx.ui.notify(`Could not start planning: ${errorMessage(error)}`, "error");
				return;
			}
			const sessionFile = await createPhaseSession(workflow.worktreePath, { phase: "planning", identifier: workflow.identifier }, ctx);
			const switched = await ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(startPlanningUserMessage(ask));
				},
			});
			if (switched.cancelled) {
				ctx.ui.notify(`Planning worktree saved at ${workflow.worktreePath}. Resume the planning session at ${sessionFile}.`, "info");
			}
		},
	});

	pi.registerCommand("workflow-implement", {
		description: "Approve the current plan, or start an implementation session for an approved workflow",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (phase === "planning" && identifier && activeFiles) {
				if (args.trim()) {
					ctx.ui.notify(
						"This planning session freezes its own plan. Run /workflow-implement without an identifier.",
						"error",
					);
					return;
				}
				await freezePlanAndImplement(ctx);
				return;
			}
			const workflow = await resolveTargetWorkflow(ctx, args, "implement");
			if (!workflow || !requireApprovedPlan(ctx, workflow)) return;
			const validation = await validateWorktree(exec, workflow);
			if (validation) {
				ctx.ui.notify(`Cannot start implementation: ${validation}.`, "error");
				return;
			}
			await enterImplementationSession(ctx, workflow);
		},
	});

	async function enterImplementationSession(
		ctx: ExtensionCommandContext,
		workflow: CompletedWorkflowMetadata,
	): Promise<void> {
		const files = workflowFiles(workflow.identifier);
		// Handoff selects validated local scope under the publication lock.
		try {
			await withPlanLock(files, async () => {
				await requireFinalizedDraft(files);
				await readWorkflowScope(files, workflow);
				await requireFinalizedDraft(files);
			});
		} catch (error) {
			ctx.ui.notify(`Cannot start implementation before saving its plan: ${errorMessage(error)}`, "error");
			return;
		}
		const sessionFile = await createPhaseSession(workflow.worktreePath, {
			phase: "implementation",
			identifier: workflow.identifier,
		}, ctx);
		await ctx.switchSession(sessionFile, {
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(
					implementationUserMessage({
						metadataPath: files.metadata,
						planPath: planPathForWorkflow(files, workflow),
						clarificationsPath: files.clarifications,
						baseBranch: workflow.baseBranch,
					}),
				);
			},
		});
	}

	async function freezePlanAndImplement(ctx: ExtensionCommandContext): Promise<void> {
		if (!identifier || !activeFiles || !metadata) {
			ctx.ui.notify("This planning session has no workflow metadata.", "error");
			return;
		}
		const files = activeFiles;
		let approved: CompletedWorkflowMetadata;
		try {
			// Share the publication lock across processes. Approval cannot race a
			// finalization between selecting the version and saving its approval.
			approved = await withPlanLock(files, async () => {
				const workflow = await readCompletedWorkflowMetadata(identifier!);
				if (workflow.approvedPlanVersion !== undefined) return workflow;
				if (await hasUnsavedPlanDraft(files)) {
					throw new Error(`The working plan has unsaved changes. Call ${WORKFLOW_UPDATE_PLAN_TOOL} before advancing to implementation.`);
				}
				const latest = await readPlanVersion(files);
				const completionError = planningCompletionError(latest?.document, latest?.description ?? workflow.description);
				if (completionError) throw new Error(completionError);
				if (!latest) throw new Error("Finalize a plan before approving it.");
				const validation = await validateWorktree(exec, workflow);
				if (validation) throw new Error(`Cannot approve plan: ${validation}.`);
				const next = { ...workflow, description: latest.description, approvedPlanVersion: latest.number };
				await writeCompletedWorkflowMetadata(next);
				// Another session may have edited its draft while approval was saved.
				// Approval pins the saved version; never discard those newer edits.
				if (!await hasUnsavedPlanDraft(files)) await rm(files.workingPlan, { recursive: true, force: true });
				else ctx.ui.notify("The working draft changed during approval and was preserved. Implementation uses the approved saved version.", "warning");
				return next;
			});
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
		appendPhase({ phase: "complete", identifier });
		metadata = approved;
		updatePhaseStatus(ctx);
		await enterImplementationSession(ctx, approved);
	}

	function requireApprovedPlan(ctx: ExtensionContext, workflow: CompletedWorkflowMetadata): boolean {
		if (workflow.approvedPlanVersion !== undefined) return true;
		ctx.ui.notify(`Workflow ${workflow.identifier} is still being planned. Approve it with /workflow-implement in its planning session first.`, "error");
		return false;
	}

	pi.registerCommand("workflow-brief", {
		description: "Brief this session on a workflow without assigning a role or changing its tools",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const workflow = await resolveTargetWorkflow(ctx, args, "brief");
			if (!workflow) return;
			if (phase && identifier && identifier !== workflow.identifier) {
				ctx.ui.notify("This session already has a role in another workflow. Brief a fresh session instead.", "error");
				return;
			}
			identifier = workflow.identifier;
			briefed = true;
			metadata = workflow;
			activeFiles = workflowFiles(identifier, workflow.worktreePath);
			pi.appendEntry(BINDING_ENTRY, { identifier });
			pi.sendUserMessage(briefingUserMessage(briefingValues(workflow, activeFiles)));
		},
	});

	function briefingValues(workflow: CompletedWorkflowMetadata, files: WorkflowFiles) {
		return {
			identifier: workflow.identifier,
			metadataPath: files.metadata, planPath: planPathForWorkflow(files, workflow), clarificationsPath: files.clarifications,
			workingPlanPath: files.workingPlan, reviewPath: files.reviewMarkdown,
			worktreePath: workflow.worktreePath,
			approved: workflow.approvedPlanVersion !== undefined,
		};
	}

	pi.registerCommand("workflow-review", {
		description: "Review the workflow's current delivery and open a read-only review session",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const workflow = await resolveTargetWorkflow(ctx, args, "review");
			if (!workflow || !requireApprovedPlan(ctx, workflow)) return;
			const validation = await validateWorktree(exec, workflow);
			if (validation) {
				ctx.ui.notify(`Cannot review: ${validation}.`, "error");
				return;
			}

			const files = workflowFiles(workflow.identifier);
			let outcome: { report: WorkflowReviewReport; reused: boolean };
			try {
				outcome = await ensureWorkflowReview(ctx, workflow, files);
			} catch (error) {
				ctx.ui.notify(`Could not generate the implementation review: ${errorMessage(error)}`, "error");
				return;
			}

			if (outcome.reused && phase === "review" && identifier === workflow.identifier) {
				ctx.ui.notify("The saved review already covers the current commits.", "info");
				return;
			}
			const sessionFile = await createPhaseSession(workflow.worktreePath, {
				phase: "review",
				identifier: workflow.identifier,
			}, ctx);
			await ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("The implementation review is ready in the workflow dashboard.", "info");
				},
			});
		},
	});

	async function ensureWorkflowReview(
		ctx: ExtensionContext,
		workflow: CompletedWorkflowMetadata,
		files: WorkflowFiles,
	): Promise<{ report: WorkflowReviewReport; reused: boolean }> {
		// Do not omit an unfinished followup or assessment from handoff.
		await withPlanLock(files, () => requireFinalizedDraft(files));
		const delivery = await runWorkflowProgress(
			ctx,
			"Checking implementation delivery",
			["Checking worktree", "Checking pull request delivery"],
			async (progress) => {
				const result = await checkDelivery(exec, workflow);
				if (!result.ok) {
					progress.fail(result.stage === "worktree" ? "Worktree is not ready" : "Pull request delivery is incomplete");
					throw new Error(`The delivery is not ready for review: ${result.message}.`);
				}
				progress.complete("Checked clean worktree");
				progress.complete(
					result.pullRequests.length === 1
						? `Checked pull request #${result.pullRequests[0]!.number}`
						: `Checked ${result.pullRequests.length}-pull-request stack`,
				);
				return result;
			},
		);
		workflow.pullRequests = toWorkflowPullRequests(delivery.pullRequests);
		await writeCompletedWorkflowMetadata(workflow);
		if (identifier === workflow.identifier) metadata = workflow;

		const [planVersion, clarifications, existing, savedReviews] = await Promise.all([
			readPlanVersion(files, workflow.approvedPlanVersion),
			readText(files.clarifications),
			readWorkflowReview(files).catch(() => undefined),
			listSavedReviews(files),
		]);
		if (!planVersion) throw new Error("The approved plan version is missing.");
		const plan = planVersion.document;
		const inputs: ReviewInputsSnapshot = {
			pullRequestUrls: delivery.pullRequests.map(({ url }) => url),
			baseCommit: workflow.baseCommit,
			headCommit: delivery.headCommit,
			sourceFingerprint: reviewSourceFingerprint(workflow.ask, plan, clarifications),
			testingCriteria: plan.testing,
			plannedChanges: plan.changes.map(({ id, title }) => ({ id, title })),
		};
		if (existing && reviewIsCurrent(existing, inputs)) {
			await writeWorkflowDashboard(files, delivery.headCommit);
			return { report: existing, reused: true };
		}

		const seed = await findIncrementalSeed(workflow, savedReviews, inputs);
		if (!seed && savedReviews.length > 0) {
			ctx.ui.notify(
				"No earlier review can seed an incremental re-review of these commits; generating a full review.",
				"info",
			);
		}

		const progressSteps = seed
			? [
					"Identifying planned changes affected by the revision",
					"Reviewing affected planned changes, full plan, and testing criteria",
					"Synthesizing overall findings",
					"Saving review report",
				]
			: ["Reviewing planned changes, full plan, and testing criteria", "Synthesizing overall findings", "Saving review report"];
		const reviewOverride = await configuredPhaseOverride(ctx, "reviewing");
		return runWorkflowProgress(
			ctx,
			seed ? "Generating incremental implementation re-review" : "Generating implementation review",
			progressSteps,
			async (progress) => {
				const report = await generateWorkflowReview(
					{
						pullRequests: workflow.pullRequests!,
						baseCommit: workflow.baseCommit,
						headCommit: delivery.headCommit,
						sourceFingerprint: inputs.sourceFingerprint,
						worktreePath: workflow.worktreePath,
						metadataPath: files.metadata,
						planPath: planVersion.path,
						clarificationsPath: files.clarifications,
						reviewRunsPath: files.reviewRuns,
						plan,
						previousReview: seed?.report,
						previousReviewPath: seed?.path,
						onStage: (stage) => {
							if (stage === "scope-complete") {
								progress.complete("Identified planned changes affected by the revision");
							}
							if (stage === "analysis-complete") {
								progress.complete(
									seed
										? "Reviewed affected planned changes, full plan, and testing criteria"
										: "Reviewed planned changes, full plan, and testing criteria",
								);
							}
							if (stage === "synthesis-complete") progress.complete("Synthesized overall findings");
						},
						onAgentProgress: ({ id, label, status }) => {
							progress.updateSubstep(id, label, status);
						},
					},
					dependencies.reviewAgentRunner ??
						createSpawnReviewAgent({
							model: reviewOverride?.model
								? `${reviewOverride.model.provider}/${reviewOverride.model.id}`
								: ctx.model
									? `${ctx.model.provider}/${ctx.model.id}`
									: undefined,
							thinkingLevel: reviewOverride?.thinkingLevel ?? ctx.thinkingLevel,
							signal: ctx.signal,
						}),
				);
				const [headAfterReview, statusAfterReview, sourcesAfterReview] = await Promise.all([
					gitValue(exec, workflow.worktreePath, ["rev-parse", "HEAD"]),
					worktreeStatus(exec, workflow.worktreePath),
					readReviewSourceFingerprint(files, workflow.ask),
				]);
				if (headAfterReview !== delivery.deliveryHeadCommit || statusAfterReview !== "" || sourcesAfterReview !== inputs.sourceFingerprint) {
					// Review agents read the live worktree. Do not cache evidence collected while it changed.
					await rm(join(files.reviewRuns, `${workflow.baseCommit}..${delivery.headCommit}`, inputs.sourceFingerprint), { recursive: true, force: true });
					throw new Error("The worktree or workflow sources changed during review. Wait for other agents to finish and run /workflow-review again.");
				}
				await appendWorkflowReview(files, report);
				await writeWorkflowDashboard(files, delivery.headCommit);
				progress.complete("Saved review report");
				return { report, reused: false };
			},
		);
	}

	/**
	 * Finds the newest saved review that can seed an incremental re-review:
	 * same plan sources and base, with its head commit an ancestor of the
	 * current head. Derived entirely from saved artifacts and Git history.
	 */
	async function findIncrementalSeed(
		workflow: CompletedWorkflowMetadata,
		savedReviews: SavedWorkflowReview[],
		inputs: ReviewInputsSnapshot,
	): Promise<SavedWorkflowReview | undefined> {
		for (let index = savedReviews.length - 1; index >= 0; index--) {
			const candidate = savedReviews[index]!;
			if (!reviewCanSeedIncremental(candidate.report, inputs)) continue;
			if (await isAncestor(exec, workflow.worktreePath, candidate.report.headCommit, inputs.headCommit)) {
				return candidate;
			}
		}
		return undefined;
	}

	pi.registerCommand("workflow-revise", {
		description: "Start a revision session in the workflow worktree from a change request",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const workflow = await resolveTargetWorkflow(ctx, args, "revise");
			if (!workflow || !requireApprovedPlan(ctx, workflow)) return;
			const validation = await validateWorktree(exec, workflow);
			if (validation) {
				ctx.ui.notify(`Revision cannot start: ${validation}.`, "error");
				return;
			}
			const request = await ctx.ui.editor("Describe the implementation changes to make");
			if (request === undefined || !request.trim()) {
				ctx.ui.notify("Revision did not start because no change request was submitted.", "info");
				return;
			}
			const files = workflowFiles(workflow.identifier);
			let review: WorkflowReviewReport | undefined;
			try {
				review = await readWorkflowReview(files);
			} catch (error) {
				ctx.ui.notify(`Ignoring the unreadable saved review: ${errorMessage(error)}`, "warning");
			}
			const sessionFile = await createPhaseSession(workflow.worktreePath, {
				phase: "revision",
				identifier: workflow.identifier,
			}, ctx);
			await ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(
						revisionUserMessage({ request, ...(review ? { reviewPath: files.review } : {}) }),
					);
				},
			});
		},
	});

	pi.registerCommand("workflow-cleanup", {
		description: "Remove the workflow worktree and return to the original checkout",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const workflow = await resolveTargetWorkflow(ctx, args, "cleanup");
			if (!workflow) return;
			const files = workflowFiles(workflow.identifier);
			const discardRecords = await ctx.ui.confirm(
				"Remove local workflow records",
				`Removing ${workflow.worktreePath} will delete its local plans, clarifications, reviews, and working drafts. Copy any records you want to keep outside the worktree first. Continue?`,
			);
			if (!discardRecords) return;
			const status = await worktreeStatus(exec, workflow.worktreePath);
			if (status === undefined) {
				ctx.ui.notify("Could not inspect the workflow worktree.", "error");
				return;
			}
			let force = false;
			if (status !== "") {
				const confirmed = await ctx.ui.confirm(
					"Worktree has uncommitted changes",
					`Removing ${workflow.worktreePath} will discard them. Continue?`,
				);
				if (!confirmed) return;
				force = true;
			}
			const [review, headCommit] = await Promise.all([
				readWorkflowReview(files).catch(() => undefined),
				workflowContentHead(exec, workflow),
			]);
			const sourcesCurrent = review?.sourceFingerprint === await readReviewSourceFingerprint(files, workflow.ask);
			if (!review || !headCommit || review.headCommit !== headCommit || !sourcesCurrent) {
				const confirmed = await ctx.ui.confirm(
					"No up-to-date review",
					review
						? "The branch or workflow sources changed after the latest review. Clean up without re-reviewing?"
						: "This workflow has no saved review. Clean up anyway?",
				);
				if (!confirmed) return;
			}
			if (isPathInside(ctx.cwd, workflow.worktreePath)) {
				const sessionFile = await createPhaseSession(workflow.repositoryRoot, {
					phase: "cleanup",
					identifier: workflow.identifier,
					force,
				}, ctx);
				await ctx.switchSession(sessionFile);
				return;
			}
			await removeWorktree(ctx, workflow, force);
		},
	});

	async function finishCleanup(ctx: ExtensionContext, workflowIdentifier: string, force: boolean): Promise<void> {
		let workflow: CompletedWorkflowMetadata;
		try {
			workflow = await readCompletedWorkflowMetadata(workflowIdentifier);
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return;
		}
		if (!(await pathExists(workflow.worktreePath))) {
			appendPhase({ phase: "complete", identifier: workflowIdentifier });
			updatePhaseStatus(ctx);
			return;
		}
		if (await removeWorktree(ctx, workflow, force)) {
			appendPhase({ phase: "complete", identifier: workflowIdentifier });
			updatePhaseStatus(ctx);
		}
	}

	async function removeWorktree(
		ctx: ExtensionContext,
		workflow: CompletedWorkflowMetadata,
		force: boolean,
	): Promise<boolean> {
		let removeFailure: string | undefined;
		try {
			removeFailure = await runWorkflowProgress(ctx, "Cleaning up workflow", ["Removing worktree"], async (progress) => {
				const result = await pi.exec("git", [
					"-C",
					workflow.repositoryRoot,
					"worktree",
					"remove",
					...(force ? ["--force"] : []),
					workflow.worktreePath,
				]);
				if (result.code !== 0) {
					progress.fail("Could not remove worktree");
					return result.stderr || result.stdout || "Git did not explain why worktree removal failed.";
				}
				progress.complete("Removed worktree");
				return undefined;
			});
		} catch (error) {
			ctx.ui.notify(`Could not remove the worktree: ${errorMessage(error)}`, "error");
			return false;
		}
		if (removeFailure) {
			ctx.ui.notify(`Could not remove the worktree: ${removeFailure}`, "error");
			return false;
		}
		if (identifier === workflow.identifier) activeFiles = undefined;
		showWorkflowCompletion(pi, ctx, {
			title: "Workflow cleanup complete",
			details: [
				`Removed worktree: ${workflow.worktreePath}`,
				"Removed local workflow records with the worktree.",
				"Kept local and remote branches and pull requests.",
			],
		});
		return true;
	}

	async function updateReviewReadiness(ctx: ExtensionContext): Promise<void> {
		if ((phase !== "implementation" && phase !== "revision") || !metadata || !activeFiles || readinessCheckInFlight) {
			return;
		}
		readinessCheckInFlight = true;
		try {
			const [status, headCommit] = await Promise.all([
				worktreeStatus(exec, metadata.worktreePath),
				workflowContentHead(exec, metadata),
			]);
			let ready = status === "" && headCommit !== undefined;
			if (ready && phase === "revision") {
				const review = await readWorkflowReview(activeFiles).catch(() => undefined);
				ready = !review || review.headCommit !== headCommit ||
					review.sourceFingerprint !== await readReviewSourceFingerprint(activeFiles, metadata.ask);
			}
			if (ready && phase === "implementation") {
				ready = headCommit !== metadata.baseCommit;
			}
			showReviewReadyNotice(ctx, ready);
		} catch {
			// Readiness is a suggestion; never surface a failure for it.
		} finally {
			readinessCheckInFlight = false;
		}
	}

	async function uniqueIdentifier(ask: string, ctx: ExtensionCommandContext, repositoryRoot: string): Promise<string> {
		const slug = await generatePlanSlug(ask, ctx);
		const known = new Set((await listCompletedWorkflows()).map((workflow) => workflow.identifier));
		for (let attempt = 0; attempt < 100; attempt++) {
			const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
			if (known.has(candidate) || await pathExists(join(workflowsRoot(), `${candidate}.json`)) ||
				await pathExists(join(repositoryRoot, ".worktrees", candidate)) ||
				await pathExists(join(repositoryRoot, ".workflows", candidate))) continue;
			const branch = await exec("git", ["-C", repositoryRoot, "show-ref", "--verify", "--quiet", `refs/heads/${WORKFLOW_BRANCH_PREFIX}${candidate}`]);
			if (branch.code === 1) return candidate;
			if (branch.code !== 0) throw new Error(`Could not check workflow branch availability: ${branch.stderr || branch.stdout}`);
		}
		throw new Error(`Could not allocate a unique workflow identifier for ${slug}.`);
	}

	async function generatePlanSlug(ask: string, ctx: ExtensionCommandContext): Promise<string> {
		if (!ctx.model) throw new Error("No model is selected to generate a workflow identifier from the ask.");
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: planSlugUserMessage(ask) }],
			timestamp: Date.now(),
		};
		// Omitting effort can send "none", which always-reasoning models reject.
		// Keep this small request cheap without changing the session's thinking level.
		const reasoningLevel = [
			"openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses",
		].includes(ctx.model.api) ? clampThinkingLevel(ctx.model, "low") : "off";
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: planSlugSystemPrompt(),
				messages: [message],
			},
			{
				...(reasoningLevel !== "off" ? { reasoningEffort: reasoningLevel } : {}),
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
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

	pi.registerCommand("workflow-dashboard", {
		description: "Show the active implementation workflow dashboard link",
		handler: async (_args, ctx) => {
			await presentDashboard(ctx, true);
		},
	});

	pi.registerShortcut(DASHBOARD_SHORTCUT, {
		description: "Show the implementation workflow dashboard link",
		handler: async (ctx) => {
			await presentDashboard(ctx, true);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeFiles || !identifier || phase === "cleanup" || (phase === "complete" && !briefed)) return;
		// Refresh approval and artifact paths after another session updates the workflow.
		metadata = await readCompletedWorkflowMetadata(identifier);
		const currentScope = metadata.approvedPlanVersion !== undefined ? await readWorkflowScope(activeFiles, metadata) : undefined;
		let instructions = !phase || (phase === "complete" && briefed) ? briefingSystemPrompt(briefingValues(metadata, activeFiles)) : "";
		if (phase === "planning" && metadata.approvedPlanVersion === undefined) {
			instructions = planningSystemPrompt({
				planPath: planPathForWorkflow(activeFiles, metadata),
				workingPlanPath: activeFiles.workingPlan,
				updatePlanTool: WORKFLOW_UPDATE_PLAN_TOOL,
			});
		}
		if (phase === "implementation" && metadata) {
			instructions = implementationSystemPrompt({
				identifier,
				metadataPath: activeFiles.metadata,
				planPath: planPathForWorkflow(activeFiles, metadata),
				clarificationsPath: activeFiles.clarifications,
				questionTool: WORKFLOW_QUESTION_TOOL,
				worktreePath: metadata.worktreePath,
				workflowBranch: metadata.workflowBranch,
				baseBranch: metadata.baseBranch,
				scopeContext: currentScope ? scopePromptContext(currentScope, activeFiles) : undefined,
			});
		}
		if (phase === "revision" && metadata) {
			const review = await readWorkflowReview(activeFiles).catch(() => undefined);
			instructions = revisionSystemPrompt({
				identifier,
				metadataPath: activeFiles.metadata,
				planPath: planPathForWorkflow(activeFiles, metadata),
				clarificationsPath: activeFiles.clarifications,
				...(review ? { reviewPath: activeFiles.review } : {}),
				questionTool: WORKFLOW_QUESTION_TOOL,
				worktreePath: metadata.worktreePath,
				workflowBranch: metadata.workflowBranch,
				baseBranch: metadata.baseBranch,
			});
		}
		if (phase === "review") {
			instructions = reviewSystemPrompt({
				identifier,
				pullRequestStack: metadata?.pullRequests?.length
					? formatPullRequestStack(metadata.pullRequests)
					: undefined,
				metadataPath: activeFiles.metadata,
				planPath: planPathForWorkflow(activeFiles, metadata),
				clarificationsPath: activeFiles.clarifications,
				reviewPath: activeFiles.review,
				reviewMarkdownPath: activeFiles.reviewMarkdown,
				scopeContext: currentScope ? scopePromptContext(currentScope, activeFiles) : undefined,
			});
		}
		if (!instructions) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!activeFiles) return;
		if (phase === "review" && !REVIEW_TOOLS.has(event.toolName)) return { block: true, reason: "Review is code-read-only. Use read/grep/find/ls and native draft edits; shell, delegation, and other mutation tools cannot bypass this boundary." };
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return;
		const target = resolve(ctx.cwd, rawPath.replace(/^@/, ""));
		const currentMetadata = identifier ? await readCompletedWorkflowMetadata(identifier) : undefined;
		const writePhase = phase === "planning" && currentMetadata?.approvedPlanVersion !== undefined ? "complete" : phase ?? "complete";
		const scope = currentMetadata?.approvedPlanVersion !== undefined ? await readWorkflowScope(activeFiles, currentMetadata) : undefined;
		const reason = workflowWriteBlockReason(writePhase, activeFiles, target, scope ? {
			originalIds: scope.approvedPlan.document.readingOrder, changeIds: scope.currentPlan.document.readingOrder,
		} : undefined);
		if (reason) return { block: true, reason };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await Promise.all([updateReviewReadiness(ctx), refreshCurrentPullRequest(ctx)]);
		revealPhaseReminder(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		baseTools = pi
			.getActiveTools()
			.filter((name) => name !== WORKFLOW_QUESTION_TOOL && name !== WORKFLOW_UPDATE_PLAN_TOOL);
		const branch = ctx.sessionManager.getBranch();
		const saved = latestPhase(branch);
		phase = saved?.phase;
		briefed = latestBinding(branch) !== undefined;
		identifier = saved?.identifier ?? latestBinding(branch);
		cleanupForce = saved?.force ?? false;
		metadata = undefined;
		activeFiles = undefined;
		planDescription = "";
		phaseReminderVisible = phaseReminderWasShown(branch);
		currentPullRequest = undefined;

		if (identifier) {
			try {
				// A bound session in its worktree can restore a missing global locator.
				const repository = await repositoryIdentity(exec, ctx.cwd);
				if (repository) await readActiveWorkflow(repository.root);
				metadata = await readCompletedWorkflowMetadata(identifier);
				activeFiles = workflowFiles(identifier, metadata.worktreePath);
				if (phase) await prepareActivePlan(activeFiles);
				if (phase === "planning") {
					if (metadata.approvedPlanVersion !== undefined) appendPhase({ phase: "complete", identifier });
					pi.setSessionName(workflowSessionName("Planning", identifier, metadata.description));
				}
			} catch (error) {
				activeFiles = undefined;
				ctx.ui.notify(errorMessage(error), "error");
			}
		}

		applyPhaseTools();
		updatePhaseStatus(ctx);
		const description = () => metadata?.description ?? planDescription;
		if (phase === "implementation" && identifier) {
			pi.setSessionName(workflowSessionName("Implement", identifier, description()));
		}
		if (phase === "revision" && identifier) {
			pi.setSessionName(workflowSessionName("Revise", identifier, description()));
		}
		if (phase === "review" && identifier) {
			pi.setSessionName(workflowSessionName("Review", identifier, description()));
		}
		await applyPhaseOverride(ctx);
		await refreshCurrentPullRequest(ctx);
		if ((phase === "implementation" || phase === "revision" || phase === "review") && activeFiles) {
			await presentDashboard(ctx);
		}
		if (phase === "implementation" || phase === "revision") await updateReviewReadiness(ctx);
		if (phase === "review") revealPhaseReminder(ctx);
		if (phase === "cleanup" && identifier) await finishCleanup(ctx, identifier, cleanupForce);
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork") return;
		await closeOwnedDashboardServer();
	});
}

export function phaseModelOverrideName(phase: SessionWorkflowPhase | undefined): ModelOverridePhase | undefined {
	if (phase === "planning") return "planning";
	if (phase === "implementation") return "implementing";
	if (phase === "review") return "reviewing";
	if (phase === "revision") return "revising";
	return undefined;
}

export function workflowWriteBlockReason(
	phase: SessionWorkflowPhase,
	files: WorkflowFiles,
	targetPath: string,
	permissions?: { originalIds: readonly string[]; changeIds: readonly string[] },
): string | undefined {
	const target = resolve(targetPath);
	if (phase === "planning" || phase === "review" || (phase === "implementation" && isPathInside(target, files.workingPlan))) {
		const path = relative(resolve(files.workingPlan), target).split(sep).join("/");
		const changePath = /^planned-changes\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(change_metadata\.json|change\.md|testing\.md)$/.exec(path);
		const allowed = phase === "planning"
			? /^(?:plan\.json|goal\.md|intro\.md|testing\.md)$/.test(path) || Boolean(changePath && changePath[2] !== "testing.md")
			: phase === "implementation"
				? Boolean(changePath && changePath[2] === "change_metadata.json" && permissions?.changeIds.includes(changePath[1]!))
				: Boolean(permissions && (path === "plan.json" || (changePath && !permissions.originalIds.includes(changePath[1]!))));
		if (allowed && isPathInside(target, files.workingPlan)) {
			// Native file edits must not follow a draft link into frozen or unrelated files.
			let current = target;
			const boundary = dirname(dirname(files.root));
			while (isPathInside(current, boundary)) {
				try {
					const info = lstatSync(current);
					if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) return "Plan draft edits cannot follow symbolic or hard links.";
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `Cannot inspect plan draft path: ${errorMessage(error)}`;
				}
				if (current === resolve(boundary)) break;
				current = dirname(current);
			}
			return undefined;
		}
		return phase === "planning"
			? `Planning edit/write calls may only change plan JSON and Markdown files inside ${files.workingPlan}. Prepare and finalize drafts with ${WORKFLOW_UPDATE_PLAN_TOOL}.`
			: phase === "review"
				? `Review code and original requirements are frozen and read-only. Edit only followup files and readingOrder inside ${files.workingPlan}; prepare and finalize with ${WORKFLOW_UPDATE_PLAN_TOOL}.`
				: `Implementation may edit only implemented booleans in existing change_metadata.json files inside ${files.workingPlan}. Finalization rejects all requirement edits.`;
	}
	const physicalTarget = resolveExistingPath(target);
	if (target === resolve(files.metadata) || physicalTarget === resolveExistingPath(files.metadata)) {
		return "Workflow metadata, including the original ask, is managed by the workflow and read-only.";
	}
	if (isPathInside(target, files.root) || isPathInside(physicalTarget, resolveExistingPath(files.root))) {
		return "Finalized plans, reports, clarifications, and workflow bookkeeping are tool-managed and read-only. Use workflow tools for permitted updates.";
	}
	return undefined;
}

function resolveExistingPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(resolveExistingPath(parent), relative(parent, path));
	}
}

async function requireFinalizedDraft(files: WorkflowFiles): Promise<void> {
	if (await hasUnsavedPlanDraft(files)) throw new Error(`The working plan has unsaved changes. Finalize or discard/reconcile ${files.workingPlan} before handoff; saved followups and flag edits must not be omitted.`);
}

function scopePromptContext(scope: WorkflowScope, files: WorkflowFiles): string {
	const work = selectImplementationWork(scope);
	return [
		`Original approved baseline: ${scope.approvedPlan.path}`,
		`Current finalized plan: ${scope.currentPlan.path}. Read this exact version, not latest-plan.`,
		`Working draft, if present: ${files.workingPlan}. Draft edits are not active requirements until finalized.`,
		`Not marked implemented: ${work.remaining.map(({ id }) => id).join(", ") || "None"}.`,
		`Marked implemented: ${work.reportedImplemented.map(({ id }) => id).join(", ") || "None"}.`,
		`Followup amendments: ${scope.amendments.map(({ id }) => id).join(", ") || "None"}. Read their cited requirements and testing criteria.`,
		"Every finalized followup is included when the user advances to the next phase. There are no per-followup decision states. Flags are the implementer's assessment, not independent verification.",
	].join("\n");
}

function planPathForWorkflow(files: WorkflowFiles, workflow: CompletedWorkflowMetadata): string {
	return workflow.approvedPlanVersion === undefined ? files.plan : join(files.versions, `v${workflow.approvedPlanVersion}`);
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
