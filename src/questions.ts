import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { text } from "./prompts.ts";
import type { Clarification } from "./workflow.ts";

export const QUESTIONS_TOOL = "workflow_questions";
const OTHER = "Other (type an answer)";

const Parameters = Type.Object({
	questions: Type.Array(Type.Object({
		question: Type.String({ description: text("tools.workflow_questions.parameters.question") }),
		options: Type.Array(Type.Object({
			label: Type.String({ description: text("tools.workflow_questions.parameters.label") }),
			description: Type.Optional(Type.String({ description: text("tools.workflow_questions.parameters.option_description") })),
		}), { minItems: 2, maxItems: 6, description: text("tools.workflow_questions.parameters.options") }),
		allowOther: Type.Optional(Type.Boolean({ description: text("tools.workflow_questions.parameters.allow_other") })),
	}), { minItems: 1, maxItems: 8, description: text("tools.workflow_questions.parameters.questions") }),
}, { additionalProperties: false });

/**
 * Asks the user structured questions one at a time with pi's built-in select
 * and input dialogs, then records each answer verbatim through `onAnswered`.
 */
export function registerQuestionsTool(pi: ExtensionAPI, onAnswered: (entries: Clarification[]) => Promise<void>): void {
	pi.registerTool({
		name: QUESTIONS_TOOL,
		label: "Ask the user",
		description: text("tools.workflow_questions.description"),
		promptSnippet: text("tools.workflow_questions.snippet"),
		promptGuidelines: [text("tools.workflow_questions.guideline")],
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error(text("tools.workflow_questions.no_ui"));
			const entries: Clarification[] = [];
			for (const question of params.questions) {
				const labels = question.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
				const choices = question.allowOther === false ? labels : [...labels, OTHER];
				const picked = await ctx.ui.select(question.question, choices);
				if (picked === undefined) return cancelled(entries);
				let answer: string;
				let custom = false;
				if (picked === OTHER) {
					const typed = await ctx.ui.input(question.question);
					if (typed === undefined) return cancelled(entries);
					answer = typed.trim();
					custom = true;
					if (!answer) return cancelled(entries);
				} else {
					answer = question.options[labels.indexOf(picked)]!.label;
				}
				entries.push({ question: question.question, answer, custom, answeredAt: new Date().toISOString() });
			}
			await onAnswered(entries);
			return {
				content: [{ type: "text", text: text("tools.workflow_questions.answered", { entries }) }],
				details: { entries, cancelled: false },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`ask ${args.questions.length} question${args.questions.length === 1 ? "" : "s"}`)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { entries?: Clarification[]; cancelled?: boolean } | undefined;
			if (!details?.entries?.length) return new Text(theme.fg("warning", "No answers recorded"), 0, 0);
			const lines = details.entries.map((entry) => `${theme.fg("muted", entry.question)}\n  ${theme.fg("success", entry.answer)}`);
			if (details.cancelled) lines.push(theme.fg("warning", "Cancelled before answering every question."));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	async function cancelled(entries: Clarification[]) {
		if (entries.length) await onAnswered(entries);
		return {
			content: [{ type: "text" as const, text: entries.length ? text("tools.workflow_questions.stopped_early", { entries }) : text("tools.workflow_questions.cancelled") }],
			details: { entries, cancelled: true },
		};
	}
}
