/**
 * Enforces: every string that reaches the model is defined under src/prompts/.
 *
 * Model-facing sinks checked in every src/*.ts file:
 *   1. pi.registerTool({...}): description, promptSnippet, promptGuidelines[], and every
 *      `description` inside `parameters`.
 *   2. Content parts `{ type: "text", text }` (tool results, model requests).
 *   3. Blocked tool calls `{ block: true, reason }`.
 *   4. `systemPrompt:` values and `sendUserMessage(...)` arguments.
 *   5. `throw` statements inside tool `execute` bodies and inside any same-file function
 *      those bodies call (transitively).
 *
 * A value is acceptable when it is a call to text()/renderPrompt()/phaseSystemPrompt(),
 * a variable or property (not a literal), a conditional whose branches are acceptable,
 * or a template literal whose literal chunks contain no letters. Strings produced by
 * lower-level code (validation lists, fs/git errors) are outside these sinks by design.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const PROMPT_FUNCTIONS = new Set(["text", "renderPrompt", "phaseSystemPrompt"]);
const SOURCE_DIR = new URL("../src/", import.meta.url).pathname;

function acceptable(node: ts.Expression): boolean {
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return acceptable(node.expression);
	if (ts.isCallExpression(node)) return ts.isIdentifier(node.expression) && PROMPT_FUNCTIONS.has(node.expression.text);
	if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true;
	if (ts.isConditionalExpression(node)) return acceptable(node.whenTrue) && acceptable(node.whenFalse);
	if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return acceptable(node.left) && acceptable(node.right);
	if (ts.isTemplateExpression(node)) {
		const chunks = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
		return chunks.every((chunk) => !/[A-Za-z]/.test(chunk)) && node.templateSpans.every((span) => acceptable(span.expression));
	}
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return !/[A-Za-z]/.test(node.text);
	return false;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
	for (const member of object.properties) {
		if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === name) return member.initializer;
	}
	return undefined;
}

function isLiteral(node: ts.Expression, value: string): boolean {
	const inner = ts.isAsExpression(node) ? node.expression : node;
	return ts.isStringLiteral(inner) && inner.text === value;
}

function lint(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
	const problems: string[] = [];
	const report = (node: ts.Node, what: string) => {
		const { line } = source.getLineAndCharacterOfPosition(node.getStart());
		problems.push(`${file}:${line + 1}: ${what} must come from src/prompts (text/renderPrompt/phaseSystemPrompt)`);
	};
	const check = (node: ts.Expression | undefined, what: string) => { if (node && !acceptable(node)) report(node, what); };

	const functions = new Map<string, ts.Node>();
	const executeBodies: ts.Node[] = [];

	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) functions.set(node.name.text, node.initializer);

		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerTool" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
			const tool = node.arguments[0];
			check(property(tool, "description"), "tool description");
			check(property(tool, "promptSnippet"), "tool promptSnippet");
			const guidelines = property(tool, "promptGuidelines");
			if (guidelines && ts.isArrayLiteralExpression(guidelines)) guidelines.elements.forEach((element) => check(element, "tool promptGuidelines entry"));
			const parameters = property(tool, "parameters");
			if (parameters) {
				const walk = (inner: ts.Node): void => {
					if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === "description") check(inner.initializer, "tool parameter description");
					ts.forEachChild(inner, walk);
				};
				walk(parameters);
			}
			for (const member of tool.properties) {
				if ((ts.isMethodDeclaration(member) || ts.isPropertyAssignment(member)) && ts.isIdentifier(member.name) && member.name.text === "execute") executeBodies.push(member);
			}
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "sendUserMessage") check(node.arguments[0], "sendUserMessage argument");
		if (ts.isObjectLiteralExpression(node)) {
			const type = property(node, "type");
			if (type && isLiteral(type, "text")) check(property(node, "text"), "text content part");
			const block = property(node, "block");
			if (block && block.kind === ts.SyntaxKind.TrueKeyword) check(property(node, "reason"), "tool block reason");
			check(property(node, "systemPrompt"), "systemPrompt");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	// Throws inside execute bodies and everything they call within this file.
	const pending = [...executeBodies];
	const seen = new Set<ts.Node>();
	while (pending.length) {
		const body = pending.pop()!;
		if (seen.has(body)) continue;
		seen.add(body);
		const walk = (node: ts.Node): void => {
			if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression) && node.expression.arguments?.[0]) check(node.expression.arguments[0], "error thrown to the model");
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) { const target = functions.get(node.expression.text); if (target) pending.push(target); }
			ts.forEachChild(node, walk);
		};
		walk(body);
	}
	return problems;
}

test("every model-facing string is defined under src/prompts", () => {
	const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".ts")).map((name) => join(SOURCE_DIR, name));
	const problems = files.flatMap(lint);
	assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("the lint catches an inline string in each sink", () => {
	const sample = `
		pi.registerTool({ description: "inline", promptGuidelines: ["inline"], parameters: Type.Object({ a: Type.String({ description: "inline" }) }),
			async execute() { helper(); throw new Error("inline " + x); } });
		function helper() { throw new Error(\`Saved \${n} things\`); }
		pi.sendUserMessage("inline");
		return { block: true, reason: "inline" };
		const ok = [{ type: "text", text: text("k") }, { type: "text", text: \`\${a}\\n\${text("k")}\` }, { systemPrompt: \`\${event.systemPrompt}\\n\\n\${phaseSystemPrompt("p", v)}\` }];
		const bad = { type: "text" as const, text: "inline" };
	`;
	const file = join(SOURCE_DIR, "..", "test", ".lint-sample.ts");
	writeFileSync(file, sample);
	try {
		const problems = lint(file).map((problem) => problem.replace(/^.*?:\d+: /, ""));
		assert.deepEqual(problems, [
			"tool description must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"tool promptGuidelines entry must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"tool parameter description must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"sendUserMessage argument must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"tool block reason must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"text content part must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"error thrown to the model must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
			"error thrown to the model must come from src/prompts (text/renderPrompt/phaseSystemPrompt)",
		]);
	} finally {
		rmSync(file, { force: true });
	}
});
