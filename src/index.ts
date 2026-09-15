import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { clampThinkingLevel, type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, type Phase as ConfigPhase, type WorkflowConfig } from "./config.ts";
import { writeDashboard } from "./dashboard.ts";
import { closeDashboardServer, dashboardUrl, ensureDashboardServer, registerDashboard, unregisterDashboard } from "./dashboard-server.ts";
import { git, nodeExec, repositoryIdentity, worktreeStatus, type ExecFn } from "./git.ts";
import { isSlug, loadPlan } from "./plan.ts";
import { phaseSystemPrompt, renderPrompt } from "./prompts.ts";
import { QUESTIONS_TOOL, registerQuestionsTool } from "./questions.ts";
import { loadReview, stampReview, writeReviewSkeleton } from "./review.ts";
import {
	appendClarifications,
	createWorkflow,
	findWorkflowById,
	findWorkflowHere,
	isIdAvailable,
	listWorkflows,
	readWorkflow,
	removeWorkflow,
	workflowLocation,
	type Workflow,
	type WorkflowLocation,
} from "./workflow.ts";

type SessionPhase = "planning" | "implementation" | "review";

interface SessionBinding {
	phase: SessionPhase;
	id: string;
	repositoryRoot: string;
	worktree: string;
}

const BINDING_ENTRY = "implementation-workflow";
const PLAN_SAVE_TOOL = "workflow_plan_save";
const REVIEW_SAVE_TOOL = "workflow_review_save";
const WORKFLOW_TOOLS = [PLAN_SAVE_TOOL, REVIEW_SAVE_TOOL, QUESTIONS_TOOL];
const PHASE_LABEL: Record<SessionPhase, string> = { planning: "Planning", implementation: "Implement", review: "Review" };
const PHASE_CONFIG: Record<SessionPhase, ConfigPhase> = { planning: "planning", implementation: "implementing", review: "reviewing" };

export default function implementationWorkflow(pi: ExtensionAPI): void {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	let phase: SessionPhase | undefined;
	let location: WorkflowLocation | undefined;
	let workflow: Workflow | undefined;
	let baseTools: string[] = [];
	let configPromise: Promise<WorkflowConfig> | undefined;
	let knownIds: string[] = [];
	const config = (): Promise<WorkflowConfig> => (configPromise ??= loadConfig(getAgentDir()));

	// ---------- tools ----------

	pi.registerTool({
		name: PLAN_SAVE_TOOL,
		label: "Save plan",
		description: "Validate the workflow plan directory after editing its files and refresh the dashboard. Reports every structural problem (plan.json fields, slugs, reading order, dependency cycles, missing or empty Markdown, missing Testing sections).",
		promptSnippet: "Validate the edited plan directory and refresh the dashboard",
		promptGuidelines: [`Call ${PLAN_SAVE_TOOL} after editing files under the workflow plan directory; fix every reported problem and call it again.`],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const bound = requireBinding();
			const plan = await loadPlan(bound.plan);
			if (!plan.ok) throw new Error(`The plan is not valid yet:\n${plan.errors.map((error) => `- ${error}`).join("\n")}`);
			if (phase) pi.setSessionName(sessionName(phase, bound.id, plan.value.title));
			const url = await publishDashboard(bound);
			const done = plan.value.changes.filter((change) => change.implemented).length;
			return {
				content: [{ type: "text", text: `Saved plan "${plan.value.title}" with ${plan.value.changes.length} changes (${done} marked implemented).${url ? `\nDashboard: ${url}` : ""}` }],
				details: { title: plan.value.title, changes: plan.value.changes.length, implemented: done, url },
			};
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("save plan")), 0, 0),
		renderResult: (result, _options, theme) => new Text(resultText(result, theme), 0, 0),
	});

	pi.registerTool({
		name: REVIEW_SAVE_TOOL,
		label: "Save review",
		description: "Validate the workflow review directory (review.json verdicts, summary.md, and one changes/<slug>.md per reviewed change), stamp the reviewed commit range, and refresh the dashboard.",
		promptSnippet: "Validate the written review directory and refresh the dashboard",
		promptGuidelines: [`Call ${REVIEW_SAVE_TOOL} once review.json, summary.md, and every changes/<slug>.md are written; fix every reported problem and call it again.`],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const bound = requireBinding();
			if (phase !== "review") throw new Error("Reviews can only be saved from a review session.");
			const plan = await loadPlan(bound.plan);
			if (!plan.ok) throw new Error(`The plan is not valid, so the review cannot be checked against it:\n${plan.errors.map((error) => `- ${error}`).join("\n")}`);
			const review = await loadReview(bound.review, plan.value);
			if (!review.ok) throw new Error(`The review is not complete yet:\n${review.errors.map((error) => `- ${error}`).join("\n")}`);
			if (!review.value) throw new Error(`No review directory exists at ${bound.review}.`);
			const headCommit = (await git(exec, bound.worktree, ["rev-parse", "HEAD"])) ?? "unknown";
			await stampReview(bound.review, { baseCommit: (workflow ?? await readWorkflow(bound)).baseCommit, headCommit, reviewedAt: new Date().toISOString() });
			const url = await publishDashboard(bound);
			const overall = review.value.overall;
			return {
				content: [{ type: "text", text: `Saved review of ${review.value.changes.length} changes. Overall: necessary ${overall.necessary.status}, sufficient ${overall.sufficient.status}, testing ${overall.testing.status}.${url ? `\nDashboard: ${url}` : ""}` }],
				details: { changes: review.value.changes.length, url },
			};
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("save review")), 0, 0),
		renderResult: (result, _options, theme) => new Text(resultText(result, theme), 0, 0),
	});

	registerQuestionsTool(pi, async (entries) => {
		const bound = requireBinding();
		await appendClarifications(bound, entries);
		await publishDashboard(bound);
	});

	function requireBinding(): WorkflowLocation {
		if (!location) throw new Error("This session is not bound to a workflow. Run /workflow-plan, /workflow-implement, or /workflow-review first.");
		return location;
	}

	function resultText(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, theme: { fg(color: string, text: string): string }): string {
		const text = result.content.map((item) => item.text ?? "").join("\n");
		return theme.fg(result.details ? "success" : "error", text || "Failed");
	}

	// ---------- dashboard ----------

	async function publishDashboard(bound: WorkflowLocation): Promise<string | undefined> {
		await writeDashboard(bound);
		try {
			const settings = await config();
			await registerDashboard(bound.id, bound.root);
			await ensureDashboardServer(settings.dashboard);
			return dashboardUrl(settings.dashboard, bound.id);
		} catch {
			return undefined;
		}
	}

	async function showDashboard(ctx: ExtensionContext, bound: WorkflowLocation): Promise<void> {
		try {
			await writeDashboard(bound);
			const settings = await config();
			await registerDashboard(bound.id, bound.root);
			await ensureDashboardServer(settings.dashboard);
			const url = dashboardUrl(settings.dashboard, bound.id);
			ctx.ui.notify(`Workflow dashboard: ${ctx.mode === "tui" && getCapabilities().hyperlinks ? hyperlink(url, url) : url}`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not serve the workflow dashboard: ${message(error)}`, "warning");
		}
	}

	// ---------- session binding ----------

	function bindingFrom(entries: SessionEntry[]): SessionBinding | undefined {
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (entry.type === "custom" && entry.customType === BINDING_ENTRY) return entry.data as SessionBinding;
		}
		return undefined;
	}

	async function createPhaseSession(ctx: ExtensionContext, binding: SessionBinding): Promise<string> {
		const manager = SessionManager.create(binding.worktree);
		const sessionFile = manager.getSessionFile();
		const header = manager.getHeader();
		if (!sessionFile || !header) throw new Error("Pi did not allocate a persistent session file.");
		await mkdir(dirname(sessionFile), { recursive: true });
		await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		const persisted = SessionManager.open(sessionFile);
		if (ctx.model) persisted.appendModelChange(ctx.model.provider, ctx.model.id);
		if (ctx.thinkingLevel) persisted.appendThinkingLevelChange(ctx.thinkingLevel);
		persisted.appendCustomEntry(BINDING_ENTRY, binding);
		return sessionFile;
	}

	async function startPhase(ctx: ExtensionCommandContext, bound: WorkflowLocation, nextPhase: SessionPhase, kickoff: string): Promise<void> {
		const sessionFile = await createPhaseSession(ctx, { phase: nextPhase, id: bound.id, repositoryRoot: bound.repositoryRoot, worktree: bound.worktree });
		const result = await ctx.switchSession(sessionFile, {
			withSession: async (next) => { await next.sendUserMessage(kickoff); },
		});
		if (result.cancelled) ctx.ui.notify(`Session saved at ${sessionFile}; resume it to continue.`, "info");
	}

	function applyTools(): void {
		const base = baseTools.filter((name) => !WORKFLOW_TOOLS.includes(name));
		if (!phase || !location) { pi.setActiveTools(base); return; }
		const extra = phase === "planning" ? [PLAN_SAVE_TOOL, QUESTIONS_TOOL]
			: phase === "implementation" ? [PLAN_SAVE_TOOL, QUESTIONS_TOOL]
			: [PLAN_SAVE_TOOL, REVIEW_SAVE_TOOL];
		pi.setActiveTools([...base, ...extra]);
	}

	async function applyModelOverride(ctx: ExtensionContext): Promise<void> {
		if (!phase) return;
		try {
			const settings = await config();
			const override = settings.models[PHASE_CONFIG[phase]];
			if (!override) return;
			let modelReady = true;
			if (override.provider && override.model && (ctx.model?.provider !== override.provider || ctx.model.id !== override.model)) {
				const model = ctx.modelRegistry.find(override.provider, override.model);
				if (!model) throw new Error(`model ${override.provider}/${override.model} is not registered (models.${PHASE_CONFIG[phase]} in ${settings.configPath})`);
				modelReady = await pi.setModel(model);
				if (!modelReady) ctx.ui.notify(`Configured ${phase} model ${override.provider}/${override.model} has no available authentication (${settings.configPath}).`, "error");
			}
			if (override.thinkingLevel && modelReady) pi.setThinkingLevel(override.thinkingLevel);
		} catch (error) {
			ctx.ui.notify(`Could not apply the workflow model override: ${message(error)}`, "error");
		}
	}

	// ---------- target resolution ----------

	async function resolveTarget(ctx: ExtensionCommandContext, argument: string): Promise<WorkflowLocation | undefined> {
		const id = argument.trim();
		const repository = await repositoryIdentity(exec, ctx.cwd);
		if (id) {
			if (!isSlug(id)) { ctx.ui.notify(`${id} is not a valid workflow id.`, "error"); return undefined; }
			const found = repository ? await findWorkflowById(repository.repositoryRoot, id) : undefined;
			if (!found) ctx.ui.notify(`No workflow ${id} exists in this repository.`, "error");
			return found;
		}
		if (location && await exists(location.manifest)) return location;
		if (!repository) { ctx.ui.notify("Run this command inside a Git repository.", "error"); return undefined; }
		const here = await findWorkflowHere(repository.repositoryRoot, repository.worktree);
		if (here) return here;
		const all = await listWorkflows(repository.repositoryRoot);
		if (all.length === 0) { ctx.ui.notify("This repository has no workflows. Start one with /workflow-plan.", "error"); return undefined; }
		if (all.length === 1) return all[0];
		const picked = await ctx.ui.select("Which workflow?", all.map((entry) => entry.id));
		return all.find((entry) => entry.id === picked);
	}

	async function requireValidPlan(ctx: ExtensionContext, bound: WorkflowLocation) {
		const plan = await loadPlan(bound.plan);
		if (!plan.ok) ctx.ui.notify(`The plan for ${bound.id} is not valid yet:\n${plan.errors.map((error) => `- ${error}`).join("\n")}`, "error");
		return plan.ok ? plan.value : undefined;
	}

	const completions = (prefix: string) => {
		const items = knownIds.filter((id) => id.startsWith(prefix.trim())).map((id) => ({ value: id, label: id }));
		return items.length ? items : null;
	};

	// ---------- commands ----------

	pi.registerCommand("workflow-plan", {
		description: "Describe an ask, create its worktree, and start a planning session",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (location) { ctx.ui.notify(`This session already belongs to workflow ${location.id}. Start a new plan from a fresh session (/new) in the main checkout.`, "error"); return; }
			const repository = await repositoryIdentity(exec, ctx.cwd);
			if (!repository) { ctx.ui.notify("Workflow planning must start inside a Git repository.", "error"); return; }
			const ask = await ctx.ui.editor("Describe what this workflow should accomplish", args);
			if (!ask?.trim()) { ctx.ui.notify("Planning did not start because no ask was submitted.", "info"); return; }
			const status = await worktreeStatus(exec, repository.repositoryRoot);
			if (status === undefined) { ctx.ui.notify("Could not read git status.", "error"); return; }
			if (status !== "" && !(await ctx.ui.confirm("Uncommitted changes", "The new worktree starts from HEAD and will not include uncommitted files. Continue?"))) return;
			let created: { workflow: Workflow; location: WorkflowLocation };
			try {
				const id = await uniqueId(ctx, repository.repositoryRoot, ask);
				created = await createWorkflow(exec, { repositoryRoot: repository.repositoryRoot, id, ask });
			} catch (error) {
				ctx.ui.notify(`Could not start planning: ${message(error)}`, "error");
				return;
			}
			await startPhase(ctx, created.location, "planning", renderPrompt("kickoff-planning", { ask }));
		},
	});

	pi.registerCommand("workflow-implement", {
		description: "Start an implementation session for a workflow",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const target = await resolveTarget(ctx, args);
			if (!target || !(await requireValidPlan(ctx, target))) return;
			await startPhase(ctx, target, "implementation", renderPrompt("kickoff-implementation", { root: target.root, hasReview: await hasValidReview(target), questionsTool: QUESTIONS_TOOL }));
		},
	});

	pi.registerCommand("workflow-review", {
		description: "Start a code-read-only review session for a workflow",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const target = await resolveTarget(ctx, args);
			if (!target || !(await requireValidPlan(ctx, target))) return;
			const status = await worktreeStatus(exec, target.worktree);
			if (status && !(await ctx.ui.confirm("Uncommitted changes", "The worktree has uncommitted changes. Review anyway?"))) return;
			const meta = await readWorkflow(target);
			if (!(await exists(resolve(target.review, "review.json")))) await writeReviewSkeleton(target.review);
			await startPhase(ctx, target, "review", renderPrompt("kickoff-review", { root: target.root, baseCommit: meta.baseCommit, saveTool: REVIEW_SAVE_TOOL }));
		},
	});

	pi.registerCommand("workflow-dashboard", {
		description: "Refresh the workflow dashboard and show its link",
		handler: async (_args, ctx) => {
			const target = location ?? await resolveTarget(ctx, "");
			if (target) await showDashboard(ctx, target);
		},
	});

	pi.registerShortcut("ctrl+alt+d", {
		description: "Show the workflow dashboard link",
		handler: async (ctx) => { if (location) await showDashboard(ctx, location); },
	});

	pi.registerCommand("workflow-cleanup", {
		description: "Remove a workflow's worktree and files (branches are kept)",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const target = await resolveTarget(ctx, args);
			if (!target) return;
			if (!(await ctx.ui.confirm("Remove workflow", `Delete ${target.worktree} including the plan, clarifications, and review for ${target.id}? Branches and pull requests are kept.`))) return;
			const status = await worktreeStatus(exec, target.worktree);
			if (status === undefined) { ctx.ui.notify("Could not inspect the worktree.", "error"); return; }
			const force = status !== "";
			if (force && !(await ctx.ui.confirm("Uncommitted changes", "The worktree has uncommitted changes that will be discarded. Continue?"))) return;
			const remove = async (next: ExtensionContext) => {
				const failure = await removeWorkflow(nodeExec, target, force);
				await unregisterDashboard(target.id);
				next.ui.notify(failure ? `Could not remove the worktree: ${failure}` : `Removed workflow ${target.id} and its worktree.`, failure ? "error" : "info");
			};
			if (isInside(ctx.cwd, target.worktree)) {
				// Leave the worktree before deleting it: switch to a fresh session in the main checkout.
				const manager = SessionManager.create(target.repositoryRoot);
				const sessionFile = manager.getSessionFile();
				const header = manager.getHeader();
				if (!sessionFile || !header) { ctx.ui.notify("Pi did not allocate a session file.", "error"); return; }
				await mkdir(dirname(sessionFile), { recursive: true });
				await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
				await ctx.switchSession(sessionFile, { withSession: remove });
				return;
			}
			await remove(ctx);
		},
	});

	// ---------- events ----------

	pi.on("before_agent_start", async (event) => {
		if (!phase || !location) return;
		const meta = workflow ?? (workflow = await readWorkflow(location));
		const values = {
			id: location.id, root: location.root, worktree: location.worktree,
			branch: meta.branch, baseBranch: meta.baseBranch, baseCommit: meta.baseCommit,
			hasReview: await hasValidReview(location),
			saveTool: phase === "review" ? REVIEW_SAVE_TOOL : PLAN_SAVE_TOOL, planSaveTool: PLAN_SAVE_TOOL, questionsTool: QUESTIONS_TOOL,
		};
		return { systemPrompt: `${event.systemPrompt}\n\n${phaseSystemPrompt(phase, values)}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!location || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string") return;
		const target = resolve(ctx.cwd, raw.replace(/^@/, ""));
		if (target === resolve(location.manifest) || target === resolve(location.clarifications)) {
			return { block: true, reason: `${relative(location.root, target)} is managed by the workflow and read-only.` };
		}
		if (phase === "planning" && !isInside(target, location.plan)) {
			return { block: true, reason: `Planning sessions may only edit files under ${location.plan}. Code changes happen in /workflow-implement.` };
		}
		if (phase === "review" && !isInside(target, location.plan) && !isInside(target, location.review)) {
			return { block: true, reason: `Review sessions may only edit files under ${location.plan} (followups) and ${location.review}. Code changes happen in /workflow-implement.` };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		baseTools = pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.includes(name));
		const binding = bindingFrom(ctx.sessionManager.getBranch());
		phase = undefined;
		location = undefined;
		workflow = undefined;
		if (binding) {
			const candidate = workflowLocation(binding.repositoryRoot, binding.worktree, binding.id);
			try {
				workflow = await readWorkflow(candidate);
				location = candidate;
				phase = binding.phase;
			} catch (error) {
				ctx.ui.notify(`This session's workflow ${binding.id} is unavailable: ${message(error)}`, "error");
			}
		}
		applyTools();
		const repository = await repositoryIdentity(exec, ctx.cwd);
		knownIds = repository ? (await listWorkflows(repository.repositoryRoot)).map((entry) => entry.id) : [];
		if (!phase || !location) return;
		const plan = await loadPlan(location.plan);
		pi.setSessionName(sessionName(phase, location.id, plan.ok ? plan.value.title : ""));
		await applyModelOverride(ctx);
		await showDashboard(ctx, location);
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork") return;
		await closeDashboardServer();
	});

	// ---------- helpers ----------

	async function hasValidReview(bound: WorkflowLocation): Promise<boolean> {
		const plan = await loadPlan(bound.plan);
		if (!plan.ok) return false;
		const review = await loadReview(bound.review, plan.value);
		return review.ok && review.value !== undefined;
	}

	async function uniqueId(ctx: ExtensionCommandContext, repositoryRoot: string, ask: string): Promise<string> {
		const slug = await generateSlug(ctx, ask);
		for (let attempt = 0; attempt < 50; attempt++) {
			const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
			if (await isIdAvailable(exec, repositoryRoot, candidate)) return candidate;
		}
		throw new Error(`Could not find a free workflow id for ${slug}.`);
	}

	async function generateSlug(ctx: ExtensionCommandContext, ask: string): Promise<string> {
		if (!ctx.model) throw new Error("No model is selected to name the workflow.");
		const userMessage: Message = { role: "user", content: [{ type: "text", text: `Generate a stable workflow identifier from this request:\n\n${ask}` }], timestamp: Date.now() };
		// Omitting effort can send "none", which always-reasoning models reject; keep the request cheap otherwise.
		const reasoning = ["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(ctx.model.api)
			? clampThinkingLevel(ctx.model, "low") : "off";
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{ systemPrompt: renderPrompt("slug", {}), messages: [userMessage] },
			{ ...(reasoning !== "off" ? { reasoningEffort: reasoning } : {}), cacheRetention: "none", sessionId: uuidv7() },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "The model did not return a workflow id.");
		const text = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n");
		const slug = text.trim().replace(/^```\w*\s*|\s*```$/g, "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.replace(/^slug\s*:\s*/i, "")
			.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") ?? "";
		if (!isSlug(slug)) throw new Error(`The model returned an unusable workflow id: ${JSON.stringify(text)}`);
		return slug;
	}
}

function sessionName(phase: SessionPhase, id: string, title: string): string {
	return `${PHASE_LABEL[phase]}: ${id}${title ? ` · ${title}` : ""}`;
}

function isInside(path: string, directory: string): boolean {
	const rel = relative(resolve(directory), resolve(path));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
