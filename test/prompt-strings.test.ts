/**
 * Enforces: every string that reaches the model is defined under src/prompts/.
 *
 * Model-facing sinks checked in every src/*.ts file:
 *   1. pi.registerTool({...}): description, promptSnippet, promptGuidelines[], and every
 *      `description` inside `parameters`.
 *   2. Content parts `{ type: "text", text }` (tool results, model requests).
 *   3. Blocked tool calls `{ block: true, reason }`.
 *   4. `systemPrompt:` values and `sendUserMessage(...)` arguments.
 *   5. `throw` statements inside tool `execute` bodies and inside every function they
 *      call, transitively, across src/ files (resolved through relative imports).
 *
 * A value is acceptable when it is a call to text()/renderPrompt()/phaseSystemPrompt(),
 * a variable or property that is not a same-file `const` string literal, a conditional
 * or ||/?? whose branches are acceptable, or a template literal whose literal chunks
 * contain no letters.
 *
 * Explicit exemptions:
 *   - Validation messages: in VALIDATION_FILES, letter-bearing literals may be pushed into an
 *     `errors` array or returned as `{ ok: false, errors: [...] }`. Anywhere else, that
 *     pattern is reported.
 *   - LOADER_FILES: throws inside the prompt loader itself (a missing strings.toml key).
 * Errors raised by Node itself (fs, JSON.parse) are not string literals in this repository
 * and are therefore outside the check.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const PROMPT_FUNCTIONS = new Set(["text", "renderPrompt", "phaseSystemPrompt"]);
const VALIDATION_FILES = new Set(["plan.ts", "review.ts"]);
/** The prompt loader's own errors mean a missing key: a developer bug, never model guidance. */
const LOADER_FILES = new Set(["prompts.ts"]);
const SOURCE_DIR = new URL("../src/", import.meta.url).pathname;
const MESSAGE = "must come from src/prompts (text/renderPrompt/phaseSystemPrompt)";

interface Module {
	file: string;
	source: ts.SourceFile;
	functions: Map<string, ts.Node>;
	/** Local name -> file it was imported from (relative src imports only). */
	imports: Map<string, string>;
	/** Same-file `const name = "prose"` declarations. */
	proseConstants: Set<string>;
}

function hasLetters(value: string): boolean {
	return /[A-Za-z]/.test(value);
}

function loadModule(file: string, code = readFileSync(file, "utf8")): Module {
	const source = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true);
	const module: Module = { file, source, functions: new Map(), imports: new Map(), proseConstants: new Set() };
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name) module.functions.set(node.name.text, node);
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) module.functions.set(node.name.text, node.initializer);
			else if ((ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) && hasLetters(node.initializer.text)) module.proseConstants.add(node.name.text);
		}
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("./") && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
			const target = resolve(SOURCE_DIR, node.moduleSpecifier.text);
			for (const element of node.importClause.namedBindings.elements) module.imports.set(element.name.text, target);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return module;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
	for (const member of object.properties) {
		if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name) && member.name.text === name) return member.initializer;
	}
	return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
	return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;
}

function isProseLiteral(node: ts.Expression): boolean {
	const inner = unwrap(node);
	if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return hasLetters(inner.text);
	if (ts.isTemplateExpression(inner)) return [inner.head.text, ...inner.templateSpans.map((span) => span.literal.text)].some(hasLetters);
	if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) return isProseLiteral(inner.left) || isProseLiteral(inner.right);
	return false;
}

function acceptable(node: ts.Expression, module: Module): boolean {
	const inner = unwrap(node);
	if (ts.isCallExpression(inner)) {
		if (ts.isIdentifier(inner.expression) && PROMPT_FUNCTIONS.has(inner.expression.text)) return true;
		// Other calls (message(error), bulletList(list)) pass through values; they may not receive prose literals.
		return inner.arguments.every((argument) => acceptable(argument, module));
	}
	if (ts.isIdentifier(inner)) return !module.proseConstants.has(inner.text);
	if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) return true;
	if (ts.isConditionalExpression(inner)) return acceptable(inner.whenTrue, module) && acceptable(inner.whenFalse, module);
	if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(inner.operatorToken.kind)) return acceptable(inner.left, module) && acceptable(inner.right, module);
	if (ts.isTemplateExpression(inner)) {
		return !isProseLiteral(inner) && inner.templateSpans.every((span) => acceptable(span.expression, module));
	}
	if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return !hasLetters(inner.text);
	return false;
}

function lint(modules: Map<string, Module>): string[] {
	const problems: string[] = [];
	const report = (module: Module, node: ts.Node, what: string) => {
		const { line } = module.source.getLineAndCharacterOfPosition(node.getStart());
		problems.push(`${module.file}:${line + 1}: ${what} ${MESSAGE}`);
	};
	const check = (module: Module, node: ts.Expression | undefined, what: string) => { if (node && !acceptable(node, module)) report(module, node, what); };

	const reachable: Array<{ module: Module; body: ts.Node }> = [];
	for (const module of modules.values()) {
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerTool" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
				const tool = node.arguments[0];
				check(module, property(tool, "description"), "tool description");
				check(module, property(tool, "promptSnippet"), "tool promptSnippet");
				const guidelines = property(tool, "promptGuidelines");
				if (guidelines && ts.isArrayLiteralExpression(guidelines)) guidelines.elements.forEach((element) => check(module, element, "tool promptGuidelines entry"));
				const parameters = property(tool, "parameters");
				if (parameters) {
					const walk = (inner: ts.Node): void => {
						if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === "description") check(module, inner.initializer, "tool parameter description");
						ts.forEachChild(inner, walk);
					};
					walk(parameters);
				}
				for (const member of tool.properties) {
					if ((ts.isMethodDeclaration(member) || ts.isPropertyAssignment(member)) && ts.isIdentifier(member.name) && member.name.text === "execute") reachable.push({ module, body: member });
				}
			}
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "sendUserMessage") check(module, node.arguments[0], "sendUserMessage argument");
			if (ts.isObjectLiteralExpression(node)) {
				const type = property(node, "type");
				if (type && ts.isStringLiteral(unwrap(type)) && (unwrap(type) as ts.StringLiteral).text === "text") check(module, property(node, "text"), "text content part");
				const block = property(node, "block");
				if (block && block.kind === ts.SyntaxKind.TrueKeyword) check(module, property(node, "reason"), "tool block reason");
				check(module, property(node, "systemPrompt"), "systemPrompt");
				// Validation messages are allowed only in VALIDATION_FILES.
				const errors = property(node, "errors");
				if (errors && ts.isArrayLiteralExpression(errors) && !VALIDATION_FILES.has(basename(module.file))) {
					errors.elements.forEach((element) => { if (isProseLiteral(element)) report(module, element, "validation message outside VALIDATION_FILES"); });
				}
			}
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "push" && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "errors" && !VALIDATION_FILES.has(basename(module.file))) {
				node.arguments.forEach((argument) => { if (isProseLiteral(argument)) report(module, argument, "validation message outside VALIDATION_FILES"); });
			}
			ts.forEachChild(node, visit);
		};
		visit(module.source);
	}

	// Throws inside execute bodies and everything they call, following same-file functions and relative imports.
	const seen = new Set<ts.Node>();
	while (reachable.length) {
		const { module, body } = reachable.pop()!;
		if (seen.has(body)) continue;
		seen.add(body);
		const walk = (node: ts.Node): void => {
			if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression) && node.expression.arguments?.[0] && !LOADER_FILES.has(basename(module.file))) check(module, node.expression.arguments[0], "error thrown to the model");
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				const name = node.expression.text;
				const local = module.functions.get(name);
				if (local) reachable.push({ module, body: local });
				else {
					const imported = module.imports.get(name);
					const target = imported ? modules.get(imported) : undefined;
					const fn = target?.functions.get(name);
					if (target && fn) reachable.push({ module: target, body: fn });
				}
			}
			ts.forEachChild(node, walk);
		};
		walk(body);
	}
	return problems;
}

function sourceModules(): Map<string, Module> {
	return new Map(readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".ts")).map((name) => join(SOURCE_DIR, name)).map((file) => [file, loadModule(file)]));
}

test("every model-facing string is defined under src/prompts", () => {
	const problems = lint(sourceModules());
	assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("the lint catches an inline string in each sink, across files and through constants", () => {
	const sample = `
		import { helperFromWorkflow } from "./workflow.ts";
		import { loadPlan } from "./plan.ts";
		const PROSE = "inline prose";
		pi.registerTool({ description: "inline", promptGuidelines: ["inline"], parameters: Type.Object({ a: Type.String({ description: "inline" }) }),
			async execute() { helper(); helperFromWorkflow(); loadPlan(); throw new Error("inline " + x); } });
		function helper() { throw new Error(\`Saved \${n} things\`); }
		pi.sendUserMessage("inline");
		return { block: true, reason: PROSE };
		const ok = [{ type: "text", text: text("k") }, { type: "text", text: \`\${a}\\n\${text("k")}\` }, { systemPrompt: \`\${event.systemPrompt}\\n\\n\${phaseSystemPrompt("p", v)}\` }, { type: "text", text: message(error) }];
		const bad = [{ type: "text" as const, text: "inline" }, { type: "text", text: format("prose", x) }];
		errors.push("plan.json: looks like validation");
	`;
	const sampleFile = join(SOURCE_DIR, ".lint-sample.ts");
	// Stubs stand in for the real src files that the sample imports.
	const modules = new Map<string, Module>([
		[join(SOURCE_DIR, "workflow.ts"), loadModule(join(SOURCE_DIR, "workflow.ts"), `export function helperFromWorkflow() { throw new Error("Invalid workflow file"); }`)],
		[join(SOURCE_DIR, "plan.ts"), loadModule(join(SOURCE_DIR, "plan.ts"), `export function loadPlan() { const errors = []; errors.push("plan.json: allowed here"); if (x) throw new Error("not allowed even here"); return { ok: false, errors: ["also allowed"] }; }`)],
		[sampleFile, loadModule(sampleFile, sample)],
	]);
	const problems = lint(modules).map((problem) => problem.replace(/^.*?([a-z.-]+\.ts):\d+: /, "$1: ").replace(` ${MESSAGE}`, ""));
	assert.deepEqual(problems, [
		".lint-sample.ts: tool description",
		".lint-sample.ts: tool promptGuidelines entry",
		".lint-sample.ts: tool parameter description",
		".lint-sample.ts: sendUserMessage argument",
		".lint-sample.ts: tool block reason",
		".lint-sample.ts: text content part",
		".lint-sample.ts: text content part",
		".lint-sample.ts: validation message outside VALIDATION_FILES",
		".lint-sample.ts: error thrown to the model",
		"plan.ts: error thrown to the model",
		"workflow.ts: error thrown to the model",
		".lint-sample.ts: error thrown to the model",
	]);
});
