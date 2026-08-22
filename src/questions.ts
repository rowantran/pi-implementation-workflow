import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface WorkflowChoice {
	label: string;
	description?: string;
}

export interface WorkflowQuestion {
	id: string;
	label: string;
	question: string;
	options: WorkflowChoice[];
	allowOther: boolean;
}

export interface WorkflowAnswer {
	id: string;
	answer: string;
	index?: number;
	custom: boolean;
}

export interface WorkflowQuestionnaireResult {
	questions: WorkflowQuestion[];
	answers: WorkflowAnswer[];
	cancelled: boolean;
}

const ChoiceSchema = Type.Object({
	label: Type.String({ description: "Short answer label" }),
	description: Type.Optional(Type.String({ description: "Trade-off or consequence of this answer" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Short stable id, such as scope or compatibility" }),
	label: Type.Optional(Type.String({ description: "Short tab label" })),
	question: Type.String({ description: "One concrete clarification question" }),
	options: Type.Array(ChoiceSchema, {
		minItems: 2,
		maxItems: 6,
		description: "Mutually exclusive, concrete answers; put the recommended answer first when appropriate",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text answer; defaults to true" })),
});

const Parameters = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 8,
		description: "All remaining implementation-plan questions, preferably in one batch",
	}),
});

export const WORKFLOW_QUESTION_TOOL = "workflow_questions";

export function registerWorkflowQuestions(
	pi: ExtensionAPI,
	onAnswered?: (result: WorkflowQuestionnaireResult) => Promise<void>,
): void {
	pi.registerTool({
		name: WORKFLOW_QUESTION_TOOL,
		label: "Implementation Questions",
		description:
			"Ask the user one or more multiple-choice questions that must be resolved before implementing the approved plan. Use one batch when possible. Each option should explain its consequence.",
		parameters: Parameters,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult("The implementation questionnaire requires interactive terminal mode.");
			}

			const questions: WorkflowQuestion[] = params.questions.map((question, index) => ({
				...question,
				label: question.label?.trim() || `Q${index + 1}`,
				allowOther: question.allowOther !== false,
			}));
			if (questions.length === 0) return errorResult("No questions were provided.");

			const result = await ctx.ui.custom<WorkflowQuestionnaireResult>((tui, theme, _keybindings, done) => {
				let current = 0;
				let selected = 0;
				let customInput = false;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, WorkflowAnswer>();
				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				const refresh = () => {
					cachedLines = undefined;
					tui.requestRender();
				};
				const finish = (cancelled: boolean) =>
					done({ questions, answers: [...answers.values()], cancelled });
				const allAnswered = () => questions.every((question) => answers.has(question.id));
				const choices = (): WorkflowChoice[] => {
					const question = questions[current];
					if (!question) return [];
					return question.allowOther ? [...question.options, { label: "Type another answer." }] : question.options;
				};
				const advance = () => {
					const next = questions.findIndex((question, index) => index > current && !answers.has(question.id));
					current = next >= 0 ? next : questions.length;
					selected = 0;
					customInput = false;
					refresh();
				};

				const handleInput = (data: string) => {
					if (customInput) {
						if (matchesKey(data, Key.escape)) {
							customInput = false;
							editor.setText("");
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const question = questions[current];
							const answer = editor.getExpandedText();
							if (!question || !answer.trim()) return;
							answers.set(question.id, { id: question.id, answer, custom: true });
							editor.setText("");
							advance();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						finish(true);
						return;
					}
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						current = (current + 1) % (questions.length + 1);
						selected = 0;
						refresh();
						return;
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						current = (current - 1 + questions.length + 1) % (questions.length + 1);
						selected = 0;
						refresh();
						return;
					}
					if (current === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) finish(false);
						return;
					}
					const options = choices();
					if (matchesKey(data, Key.up)) {
						selected = Math.max(0, selected - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						selected = Math.min(options.length - 1, selected + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const question = questions[current];
						const option = options[selected];
						if (!question || !option) return;
						if (question.allowOther && selected === options.length - 1) {
							customInput = true;
							refresh();
							return;
						}
						answers.set(question.id, {
							id: question.id,
							answer: option.label,
							index: selected + 1,
							custom: false,
						});
						advance();
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					const renderWidth = Math.max(1, width);
					const lines: string[] = [];
					const add = (text: string, prefix = " ") => {
						const available = Math.max(1, renderWidth - visibleWidth(prefix));
						const wrapped = wrapTextWithAnsi(text, available);
						for (let index = 0; index < wrapped.length; index++) {
							lines.push(`${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${wrapped[index]}`);
						}
					};

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					add(theme.bold(theme.fg("accent", "Clarify the approved implementation plan")));
					const tabs = questions.map((question, index) => {
						const marker = answers.has(question.id) ? "■" : "□";
						const text = ` ${marker} ${question.label} `;
						return index === current
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(answers.has(question.id) ? "success" : "muted", text);
					});
					const submit = " ✓ Submit ";
					tabs.push(
						current === questions.length
							? theme.bg("selectedBg", theme.fg("text", submit))
							: theme.fg(allAnswered() ? "success" : "dim", submit),
					);
					add(tabs.join(" "));
					lines.push("");

					if (current === questions.length) {
						add(theme.bold("Review answers"));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							add(`${theme.fg("muted", `${question.label}: `)}${answer?.answer ?? theme.fg("warning", "unanswered")}`);
						}
						lines.push("");
						add(
							allAnswered()
								? theme.fg("success", "Press Enter to submit all answers.")
								: theme.fg("warning", "Answer every question before submitting."),
						);
					} else {
						const question = questions[current];
						add(question.question);
						lines.push("");
						const options = choices();
						for (let index = 0; index < options.length; index++) {
							const option = options[index];
							const active = index === selected;
							add(
								theme.fg(active ? "accent" : "text", `${index + 1}. ${option.label}`),
								active ? theme.fg("accent", "> ") : "  ",
							);
							if (option.description) add(theme.fg("muted", option.description), "     ");
						}
						if (customInput) {
							lines.push("");
							add(theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
						}
					}

					lines.push("");
					add(theme.fg("dim", "Tab/←→ questions • ↑↓ options • Enter select • Esc cancel"));
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				};

				return { render, handleInput, invalidate: () => (cachedLines = undefined) };
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "The user cancelled the implementation questionnaire." }],
					details: result,
				};
			}
			await onAnswered?.(result);
			const text = result.answers
				.map((answer) => {
					const label = questions.find((question) => question.id === answer.id)?.label ?? answer.id;
					return `${label}: ${answer.custom ? "user wrote" : `user selected ${answer.index}`}: ${answer.answer}`;
				})
				.join("\n");
			return { content: [{ type: "text", text }], details: result };
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("implementation questions"))} ${theme.fg("muted", `(${count})`)}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as WorkflowQuestionnaireResult | undefined;
			if (!details || details.cancelled) return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
			return new Text(
				details.answers.map((answer) => `${theme.fg("success", "✓")} ${answer.id}: ${answer.answer}`).join("\n"),
				0,
				0,
			);
		},
	});
}

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { questions: [], answers: [], cancelled: true } satisfies WorkflowQuestionnaireResult,
	};
}
