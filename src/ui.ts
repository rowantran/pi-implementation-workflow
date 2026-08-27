import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const COMPLETION_ENTRY = "implementation-workflow-completion";
export const PHASE_REMINDER_ENTRY = "implementation-workflow-phase-reminder";
const PHASE_STATUS_ID = "implementation-workflow-phase";
const REVIEW_READY_NOTICE_ID = "implementation-workflow-review-ready-notice";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const COMPLETION_DELAY_MS = 300;
const FAILURE_DELAY_MS = 600;

type ProgressStatus = "pending" | "active" | "complete" | "failed";
export type WorkflowSubstepStatus = "queued" | "running" | "complete" | "failed" | "reused";
export type WorkflowStatusPhase = "planning" | "implementation" | "revision" | "review" | "cleanup" | "complete";

interface ProgressSubstep {
	id: string;
	label: string;
	status: WorkflowSubstepStatus;
}

interface ProgressStep {
	label: string;
	status: ProgressStatus;
	substeps: ProgressSubstep[];
}

export interface WorkflowProgress {
	complete(label?: string): void;
	fail(label?: string): void;
	updateSubstep(id: string, label: string, status: WorkflowSubstepStatus): void;
}

export interface WorkflowCompletionData {
	title: string;
	details?: string[];
	command?: string;
	instruction?: string;
}

export interface WorkflowPhaseReminderData {
	phase: WorkflowStatusPhase;
	draftId?: string;
	identifier?: string;
}

export interface WorkflowReviewTranscriptCardContent {
	title: string;
	description: string;
	guidance: string;
	actions: Array<{ label: string; command: string }>;
}

type ProgressResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export class WorkflowProgressComponent implements Component, WorkflowProgress {
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly steps: ProgressStep[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		labels: string[],
	) {
		this.steps = labels.map((label, index) => ({
			label,
			status: index === 0 ? "active" : "pending",
			substeps: [],
		}));
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, 80);
	}

	complete(label?: string): void {
		const index = this.steps.findIndex((step) => step.status === "active");
		if (index < 0) return;
		const step = this.steps[index];
		if (!step) return;
		step.status = "complete";
		if (label) step.label = label;
		const next = this.steps[index + 1];
		if (next) next.status = "active";
		else this.stop();
		this.tui.requestRender();
	}

	fail(label?: string): void {
		const step = this.steps.find((candidate) => candidate.status === "active");
		if (step) {
			step.status = "failed";
			if (label) step.label = label;
		}
		this.stop();
		this.tui.requestRender();
	}

	updateSubstep(id: string, label: string, status: WorkflowSubstepStatus): void {
		const existing = this.steps.flatMap((step) => step.substeps).find((substep) => substep.id === id);
		if (existing) {
			existing.label = label;
			existing.status = status;
		} else {
			const activeStep = this.steps.find((step) => step.status === "active");
			if (!activeStep) return;
			activeStep.substeps.push({ id, label, status });
		}
		this.tui.requestRender();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {
		// Rendering is not cached.
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const lines = [
			this.theme.fg("borderAccent", "─".repeat(renderWidth)),
			"",
			` ${this.theme.fg("accent", this.theme.bold(this.title))}`,
			"",
		];
		for (const step of this.steps) {
			let marker = this.theme.fg("dim", "○");
			let label = this.theme.fg("dim", step.label);
			if (step.status === "active") {
				marker = this.theme.fg("accent", SPINNER_FRAMES[this.frame] ?? "⠋");
				label = this.theme.fg("text", step.label);
			}
			if (step.status === "complete") {
				marker = this.theme.fg("success", "✓");
				label = this.theme.fg("success", step.label);
			}
			if (step.status === "failed") {
				marker = this.theme.fg("error", "✗");
				label = this.theme.fg("error", step.label);
			}
			lines.push(` ${marker} ${label}`);
			for (const substep of step.substeps) {
				let substepMarker = this.theme.fg("dim", "○");
				let substepLabel = this.theme.fg("dim", substep.label);
				if (substep.status === "running") {
					substepMarker = this.theme.fg("accent", SPINNER_FRAMES[this.frame] ?? "⠋");
					substepLabel = this.theme.fg("text", substep.label);
				}
				if (substep.status === "complete") {
					substepMarker = this.theme.fg("success", "✓");
					substepLabel = this.theme.fg("success", substep.label);
				}
				if (substep.status === "reused") {
					substepMarker = this.theme.fg("muted", "↻");
					substepLabel = this.theme.fg("muted", substep.label);
				}
				if (substep.status === "failed") {
					substepMarker = this.theme.fg("error", "✗");
					substepLabel = this.theme.fg("error", substep.label);
				}
				lines.push(`   ${substepMarker} ${substepLabel}`);
			}
		}
		lines.push("", this.theme.fg("borderAccent", "─".repeat(renderWidth)));
		return lines.map((line) => truncateToWidth(line, renderWidth, ""));
	}
}

const NOOP_PROGRESS: WorkflowProgress = {
	complete: () => {},
	fail: () => {},
	updateSubstep: () => {},
};

export function workflowPhaseStatusText(phase: WorkflowStatusPhase | undefined): string | undefined {
	if (phase === "planning") return "/workflow-implement when the plan is ready";
	if (phase === "implementation" || phase === "revision") return "/workflow-review when ready";
	if (phase === "review") return "/workflow-revise to request changes · /workflow-cleanup to finish";
	return undefined;
}

export function showWorkflowPhaseStatus(ctx: ExtensionContext, phase: WorkflowStatusPhase | undefined): void {
	const status = workflowPhaseStatusText(phase);
	ctx.ui.setStatus(PHASE_STATUS_ID, status ? ctx.ui.theme.fg("dim", status) : undefined);
}

export function workflowReviewTranscriptCardContent(
	phase: WorkflowStatusPhase | undefined,
): WorkflowReviewTranscriptCardContent | undefined {
	if (phase !== "review") return undefined;
	return {
		title: "Review ready · Read-only session",
		description: "The generated review is open in the workflow dashboard.",
		guidance: "Ask me to explain a finding, inspect its cited code, or assess whether a concern is valid.",
		actions: [
			{ label: "Request changes", command: "/workflow-revise" },
			{ label: "Accept and clean up", command: "/workflow-cleanup" },
		],
	};
}

export function registerWorkflowPhaseReminderRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<WorkflowPhaseReminderData>(PHASE_REMINDER_ENTRY, (entry, _options, theme) => {
		const content = workflowReviewTranscriptCardContent(entry.data?.phase);
		if (!content) return new Container();

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const borderColor = (text: string) => theme.fg("accent", text);
		box.addChild(new DynamicBorder(borderColor));
		box.addChild(new Text(theme.fg("accent", theme.bold(content.title)), 0, 1));
		box.addChild(new Text(`${content.description}\n\n${content.guidance}`, 0, 0));
		box.addChild(
			new Text(
				content.actions
					.map(
						(action) =>
							`${theme.fg("muted", `${action.label}:`)} ${theme.fg("accent", theme.bold(action.command))}`,
					)
					.join("\n"),
				0,
				1,
			),
		);
		box.addChild(new DynamicBorder(borderColor));
		return box;
	});
}

export function reviewReadyNoticeText(): string {
	return "Run /workflow-review here to generate the implementation review in a separate session.";
}

export function showReviewReadyNotice(ctx: ExtensionContext, visible: boolean): void {
	if (!visible) {
		ctx.ui.setWidget(REVIEW_READY_NOTICE_ID, undefined);
		return;
	}
	ctx.ui.setWidget(
		REVIEW_READY_NOTICE_ID,
		["/workflow-review — run here to generate the implementation review"],
		{ placement: "belowEditor" },
	);
}

export async function runWorkflowProgress<T>(
	ctx: ExtensionContext,
	title: string,
	steps: string[],
	operation: (progress: WorkflowProgress) => Promise<T>,
): Promise<T> {
	if (ctx.mode !== "tui" || steps.length === 0) return operation(NOOP_PROGRESS);

	const result = await ctx.ui.custom<ProgressResult<T>>((tui, theme, _keybindings, done) => {
		const component = new WorkflowProgressComponent(tui, theme, title, steps);
		void operation(component).then(
			(value) => {
				component.stop();
				tui.requestRender();
				setTimeout(() => done({ ok: true, value }), COMPLETION_DELAY_MS);
			},
			(error) => {
				component.fail();
				tui.requestRender();
				setTimeout(() => done({ ok: false, error }), FAILURE_DELAY_MS);
			},
		);
		return component;
	});

	if (!result) throw new Error("The workflow progress display closed before the operation completed.");
	if (!result.ok) throw result.error;
	return result.value;
}

export function registerWorkflowCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<WorkflowCompletionData>(COMPLETION_ENTRY, (entry, _options, theme) => {
		const data = entry.data ?? {
			title: "Workflow phase complete",
		};
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		const borderColor = (text: string) => theme.fg("success", text);
		box.addChild(new DynamicBorder(borderColor));
		box.addChild(new Text(`${theme.fg("success", "✓")} ${theme.bold(data.title)}`, 0, 1));
		if (data.details?.length) {
			box.addChild(new Text(data.details.map((detail) => `• ${detail}`).join("\n"), 0, 0));
		}
		if (data.command) {
			box.addChild(new Text(theme.fg("accent", theme.bold(data.command)), 0, 1));
		}
		if (data.instruction) {
			box.addChild(new Text(data.instruction, 0, 0));
		}
		box.addChild(new DynamicBorder(borderColor));
		return box;
	});
}

export function showWorkflowCompletion(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	data: WorkflowCompletionData,
): void {
	pi.appendEntry<WorkflowCompletionData>(COMPLETION_ENTRY, data);
	if (ctx.mode === "tui") return;
	const lines = [data.title, ...(data.details ?? [])];
	if (data.command) lines.push(data.command);
	if (data.instruction) lines.push(data.instruction);
	ctx.ui.notify(lines.join("\n"), "info");
}
