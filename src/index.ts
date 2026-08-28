import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
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
import { writeWorkflowDashboard, writeWorkflowDashboardRedirect } from "./dashboard.ts";
import { checkDelivery } from "./delivery.ts";
import {
	gitValue,
	installWorktreeExclude,
	isAncestor,
	isPathInside,
	repositoryIdentity,
	validateWorktree,
	worktreeStatus,
	type ExecFn,
} from "./git.ts";
import { parsePlannedChanges, parseTestingCriteria } from "./planned-changes.ts";
import { PLAN_TITLE, planningCompletionError } from "./planning.ts";
import { formatPullRequestStack, toWorkflowPullRequests } from "./pull-requests.ts";
import {
	registerWorkflowPlanTool,
	WORKFLOW_UPDATE_PLAN_TOOL,
	type UpdatePlanResult,
} from "./plan-tool.ts";
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
import type { WorkflowReviewReport } from "./review-report.ts";
import {
	reviewCanSeedIncremental,
	reviewIsCurrent,
	type ReviewInputsSnapshot,
} from "./review-selection.ts";
import {
	appendClarifications,
	appendWorkflowReview,
	createDraft,
	draftFiles,
	ensureWorkflowFiles,
	isDraftWorkflowMetadata,
	listSavedReviews,
	pathExists,
	promoteDraft,
	readCompletedWorkflowMetadata,
	readText,
	readWorkflowReview,
	savePlanVersion,
	WORKFLOW_METADATA_VERSION,
	type CompletedWorkflowMetadata,
	type DraftWorkflowMetadata,
	type SavedWorkflowReview,
	type WorkflowClarification,
	type WorkflowFiles,
	workflowFiles,
	workflowsRoot,
	writeCompletedWorkflowMetadata,
	writeDraftWorkflowMetadata,
	writeWorkflowMetadata,
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
	draftId?: string;
	identifier?: string;
	/** Cleanup sessions: remove the worktree with --force after the user confirmed discarding changes. */
	force?: boolean;
}

const PHASE_ENTRY = "implementation-workflow-phase";
const DASHBOARD_SHORTCUT = "ctrl+alt+d";
const WORKFLOW_BRANCH_PREFIX = "workflow/";
const REVIEW_DISABLED_TOOLS = new Set(["edit", "write"]);

type WorktreeVerb = "implement" | "review" | "revise" | "cleanup";

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
	let draftId: string | undefined;
	let identifier: string | undefined;
	let cleanupForce = false;
	let metadata: CompletedWorkflowMetadata | undefined;
	let draftMetadata: DraftWorkflowMetadata | undefined;
	let activeFiles: WorkflowFiles | undefined;
	let planDescription = "";
	let baseTools: string[] = [];
	let dashboardAnnounced = false;
	let workflowConfigPromise: Promise<ImplementationWorkflowConfig> | undefined;
	let dashboardConfigPromise: Promise<DashboardServerConfig> | undefined;
	let readinessCheckInFlight = false;
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
			let dashboardUrl: string | undefined;
			let dashboardError: string | undefined;
			try {
				dashboardUrl = await ensureDashboardLink();
			} catch (error) {
				dashboardError = errorMessage(error);
			}
			const result: UpdatePlanResult = { version: version.number, dashboardUrl, dashboardError };
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
		cleanupForce = data.force ?? false;
		phaseReminderVisible = false;
		pi.appendEntry(PHASE_ENTRY, data);
	}

	function updatePhaseStatus(ctx: ExtensionContext): void {
		const activePhase =
			phase === "planning" || phase === "implementation" || phase === "revision" || phase === "review"
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
		if (phase === "implementation" || phase === "revision") {
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
		if (draftId) return dashboardReference(activeFiles, "draft", draftId);
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
		const currentHead = metadata ? await gitValue(exec, metadata.worktreePath, ["rev-parse", "HEAD"]) : undefined;
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
		if (isDraftWorkflowMetadata(workflowMetadata)) {
			draftMetadata = workflowMetadata;
			metadata = undefined;
		} else {
			metadata = workflowMetadata;
			draftMetadata = undefined;
		}
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
		if (!(await requireLaunchRepository(ctx, result.workflow))) return undefined;
		return result.workflow;
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
			if (identifier) {
				ctx.ui.notify(
					`This session belongs to workflow ${identifier}. Start planning from a fresh session (/new).`,
					"error",
				);
				return;
			}

			const repository = await repositoryIdentity(exec, ctx.cwd);
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
				if (!isDraftWorkflowMetadata(existing) || existing.ask !== ask) {
					ctx.ui.notify(
						"Planning did not start because this session already has a draft with a different immutable original ask.",
						"error",
					);
					return;
				}
			} else {
				const initialMetadata: DraftWorkflowMetadata = {
					version: WORKFLOW_METADATA_VERSION,
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
			await applyPhaseOverride(ctx);
			applyPhaseTools();
			updatePhaseStatus(ctx);
			pi.setSessionName("");
			await prepareActivePlan(files);
			pi.sendUserMessage(startPlanningUserMessage(ask));
		},
	});

	pi.registerCommand("workflow-implement", {
		description: "Freeze the current plan into a worktree, or start an implementation session for a workflow",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (phase === "planning" && draftId && activeFiles) {
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
			if (!workflow) return;
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
		const sessionFile = await createPhaseSession(workflow.worktreePath, {
			phase: "implementation",
			identifier: workflow.identifier,
		});
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

	async function freezePlanAndImplement(ctx: ExtensionCommandContext): Promise<void> {
		if (!draftId || !activeFiles || !draftMetadata) {
			ctx.ui.notify("This planning session has no workflow draft metadata.", "error");
			return;
		}
		const currentDraftMetadata = draftMetadata;
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
		const repository = await repositoryIdentity(exec, ctx.cwd);
		if (!repository) {
			ctx.ui.notify("The planning session is no longer inside a Git repository.", "error");
			return;
		}
		const [baseBranch, baseCommit] = await Promise.all([
			gitValue(exec, repository.root, ["branch", "--show-current"]),
			gitValue(exec, repository.root, ["rev-parse", "HEAD"]),
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
						const config = await dashboardConfig();
						const completedReference = dashboardReference(destination, "workflow", nextIdentifier);
						await writeWorkflowDashboardRedirect(draft.dashboard, dashboardUrl(completedReference, config));
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
		await enterImplementationSession(ctx, nextMetadata);
	}

	pi.registerCommand("workflow-review", {
		description: "Review the workflow's current delivery and open a read-only review session",
		getArgumentCompletions: (prefix) => workflowIdentifierCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const workflow = await resolveTargetWorkflow(ctx, args, "review");
			if (!workflow) return;
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
			});
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

		const [plan, clarifications, existing, savedReviews] = await Promise.all([
			readText(files.plan),
			readText(files.clarifications),
			readWorkflowReview(files).catch(() => undefined),
			listSavedReviews(files),
		]);
		const inputs: ReviewInputsSnapshot = {
			pullRequestUrls: delivery.pullRequests.map(({ url }) => url),
			baseCommit: workflow.baseCommit,
			headCommit: delivery.headCommit,
			sourceFingerprint: createHash("sha256")
				.update(JSON.stringify([workflow.ask, plan, clarifications]))
				.digest("hex"),
			testingCriteria: parseTestingCriteria(plan),
			plannedChanges: parsePlannedChanges(plan).map(({ id, title }) => ({ id, title })),
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

		const plannedChanges = parsePlannedChanges(plan);
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
						planPath: files.plan,
						clarificationsPath: files.clarifications,
						reviewRunsPath: files.reviewRuns,
						plannedChanges,
						testingCriteria: inputs.testingCriteria,
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
			if (!workflow) return;
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
			});
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
			const files = workflowFiles(workflow.identifier);
			const [review, headCommit] = await Promise.all([
				readWorkflowReview(files).catch(() => undefined),
				gitValue(exec, workflow.worktreePath, ["rev-parse", "HEAD"]),
			]);
			if (!review || !headCommit || review.headCommit !== headCommit) {
				const confirmed = await ctx.ui.confirm(
					"No up-to-date review",
					review
						? "The branch changed after the latest review. Clean up without re-reviewing?"
						: "This workflow has no saved review. Clean up anyway?",
				);
				if (!confirmed) return;
			}
			if (isPathInside(ctx.cwd, workflow.worktreePath)) {
				const sessionFile = await createPhaseSession(workflow.repositoryRoot, {
					phase: "cleanup",
					identifier: workflow.identifier,
					force,
				});
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
		showWorkflowCompletion(pi, ctx, {
			title: "Workflow cleanup complete",
			details: [
				`Removed worktree: ${workflow.worktreePath}`,
				"Kept the branches, pull requests, and saved workflow state.",
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
				gitValue(exec, metadata.worktreePath, ["rev-parse", "HEAD"]),
			]);
			let ready = status === "" && headCommit !== undefined;
			if (ready && phase === "revision") {
				const review = await readWorkflowReview(activeFiles).catch(() => undefined);
				ready = !review || review.headCommit !== headCommit;
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
		if (!activeFiles || !phase) return;
		let instructions = "";
		if (phase === "planning") {
			instructions = planningSystemPrompt({
				planPath: activeFiles.plan,
				workingPlanPath: activeFiles.workingPlan,
				updatePlanTool: WORKFLOW_UPDATE_PLAN_TOOL,
			});
		}
		if (phase === "implementation" && metadata) {
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
		if (phase === "revision" && metadata) {
			const review = await readWorkflowReview(activeFiles).catch(() => undefined);
			instructions = revisionSystemPrompt({
				identifier,
				metadataPath: activeFiles.metadata,
				planPath: activeFiles.plan,
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
		await updateReviewReadiness(ctx);
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
		cleanupForce = saved?.force ?? false;
		metadata = undefined;
		draftMetadata = undefined;
		activeFiles = undefined;
		planDescription = "";
		phaseReminderVisible = phaseReminderWasShown(branch);

		if (phase === "planning" && draftId) {
			try {
				const files = draftFiles(draftId);
				await ensureWorkflowFiles(files);
				await prepareActivePlan(files);
				pi.setSessionName(planDescription ? workflowSessionName("Planning", undefined, planDescription) : "");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		}
		if ((phase === "implementation" || phase === "revision" || phase === "review" || phase === "cleanup" || phase === "complete") && identifier) {
			try {
				await prepareActivePlan(workflowFiles(identifier));
			} catch (error) {
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
