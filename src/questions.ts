import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Clarification } from "./workflow.ts";

export const QUESTIONS_TOOL = "workflow_questions";
const OTHER = "Other (type an answer)";

const Parameters = Type.Object({
	questions: Type.Array(Type.Object({
		question: Type.String({ description: "One concrete question, phrased so the options answer it directly" }),
		options: Type.Array(Type.Object({
			label: Type.String({ description: "Short answer" }),
			description: Type.Optional(Type.String({ description: "Trade-off or consequence, one sentence" })),
		}), { minItems: 2, maxItems: 6, description: "Mutually exclusive answers; put the recommended one first" }),
		allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-text answer as well; default true" })),
	}), { minItems: 1, maxItems: 8, description: "Every open question, in one batch" }),
}, { additionalProperties: false });

/**
 * Asks the user structured questions one at a time with pi's built-in select
 * and input dialogs, then records each answer verbatim through `onAnswered`.
 */
export function registerQuestionsTool(pi: ExtensionAPI, onAnswered: (entries: Clarification[]) => Promise<void>): void {
	pi.registerTool({
		name: QUESTIONS_TOOL,
		label: "Ask the user",
		description: "Ask the user one or more multiple-choice questions and record the exact answers as workflow clarifications. Use it for decisions that change the plan or implementation; do not use it for questions you can answer by reading the repository.",
		promptSnippet: "Ask the user structured clarification questions and record the answers",
		promptGuidelines: [`Use ${QUESTIONS_TOOL} for material ambiguity before finalizing the plan or changing code; batch every open question into one call.`],
		parameters: Parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("Clarification questions need an interactive session.");
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
				content: [{ type: "text", text: entries.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n") }],
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
			content: [{ type: "text" as const, text: entries.length ? `The user stopped early. Recorded answers:\n${entries.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n")}` : "The user cancelled without answering. Continue the conversation instead of asking again immediately." }],
			details: { entries, cancelled: true },
		};
	}
}
