import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { collectDashboardData, renderDashboard } from "../src/dashboard.ts";
import { nodeExec } from "../src/git.ts";
import { createWorkflow } from "../src/workflow.ts";
import { initRepository, VALID_PLAN, writeFiles } from "./helpers.ts";

const require = createRequire(import.meta.url);

/** Just enough DOM for the dashboard script's render paths; no layout, no events. */
function fakeDocument(html: string) {
	class Element {
		id = "";
		dataset: Record<string, string> = {};
		hidden = false;
		innerHTML = "";
		textContent = "";
		disabled = false;
		content = "";
		title = "";
		classes = new Set<string>();
		listeners: Record<string, Array<(event: unknown) => void>> = {};
		classList = { toggle: (c: string, on: boolean) => { on ? this.classes.add(c) : this.classes.delete(c); }, add: (c: string) => this.classes.add(c) };
		addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
		querySelectorAll() { return []; }
		querySelector() { return null; }
		closest() { return null; }
		scrollIntoView() {}
		removeAttribute() {}
	}
	const elements = new Map<string, Element>();
	for (const match of html.matchAll(/<[a-z]+([^>]*)\bid="([a-z-]+)"([^>]*)>/g)) {
		const element = new Element();
		element.id = match[2]!;
		element.hidden = /\bhidden\b/.test(`${match[1]} ${match[3]}`);
		const view = /data-view="([a-z]+)"/.exec(`${match[1]} ${match[3]}`);
		if (view) element.dataset.view = view[1]!;
		elements.set(match[2]!, element);
	}
	const data = elements.get("data")!;
	data.textContent = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1]!;
	const revision = new Element();
	revision.content = /workflow-revision" content="([^"]+)"/.exec(html)![1]!;
	const tabs = new Element();
	const documentElement = new Element();
	return {
		elements,
		document: {
			documentElement,
			getElementById: (id: string) => elements.get(id) ?? null,
			querySelector: (selector: string) => selector.includes("workflow-revision") ? revision : selector === ".tabs" ? tabs : null,
			querySelectorAll: (selector: string) => selector === ".tabs button" ? [...elements.values()].filter((element) => element.dataset.view) : [],
			addEventListener() {},
			createElement: () => new Element(),
			head: { appendChild() {} },
			hidden: false,
		},
	};
}

function runDashboard(html: string, hash = "") {
	const { document, elements } = fakeDocument(html);
	const marked = require("marked");
	const hljs = require("@highlightjs/cdn-assets/highlight.min.js");
	const context: Record<string, unknown> = {
		document, marked, hljs, console,
		window: { addEventListener() {}, scrollTo() {} },
		location: { hash, pathname: "/w/x", href: "http://127.0.0.1/w/x" },
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false }),
		fetch: () => Promise.reject(new Error("offline")),
		URL,
	};
	context.globalThis = context;
	vm.createContext(context);
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
	vm.runInContext(script, context);
	return elements;
}

test("dashboard script renders plan and review sections without runtime errors", async () => {
	const repo = await initRepository();
	const { location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "script", ask: "Ask" });
	await writeFiles(location.plan, VALID_PLAN);
	const verdict = { status: "partial", explanation: "Mostly." };
	await writeFiles(location.review, {
		"review.json": JSON.stringify({ overall: { necessary: verdict, sufficient: verdict, testing: verdict }, changes: { "define-policy": { necessary: verdict, sufficient: verdict, testing: verdict }, "implement-redrive": { necessary: verdict, sufficient: verdict, testing: verdict } } }),
		"summary.md": "Summary **bold**.\n",
		"changes/define-policy.md": "> **Gotcha:** something\n\n```ts\nconst x = 1;\n```\n",
		"changes/implement-redrive.md": "Plain.\n",
	});
	const html = renderDashboard(await collectDashboardData(location));
	const elements = runDashboard(html);
	assert.equal(elements.get("plan-title")!.textContent, "Queue redrive with retry policy");
	assert.match(elements.get("plan-content")!.innerHTML, /Goal/);
	assert.match(elements.get("plan-outline")!.innerHTML, /1\. Define the redrive policy/);
	assert.match(elements.get("plan-outline")!.innerHTML, /Dependency graph/);
	assert.equal(elements.get("review-tab")!.hidden, false);
	assert.equal(elements.get("plan-pos")!.textContent, "1 / 6");
	const review = runDashboard(html, "#review/change/define-policy");
	assert.match(review.get("review-outline")!.innerHTML, /2\. Implement queue redrive/);
	assert.match(review.get("review-content")!.innerHTML, /Gotcha/);
	assert.match(review.get("review-content")!.innerHTML, /hljs-keyword/);
	assert.equal(review.get("review-pos")!.textContent, "2 / 3");
	const overall = runDashboard(html, "#review");
	assert.match(overall.get("review-content")!.innerHTML, /Summary <strong>bold<\/strong>/);

	// A plan that is still invalid shows its errors instead of crashing.
	await writeFiles(location.plan, { "plan.json": "{ not json" });
	const broken = runDashboard(renderDashboard(await collectDashboardData(location)));
	assert.match(broken.get("plan-content")!.innerHTML, /plan\.json: invalid JSON/);
	assert.equal(broken.get("review-tab")!.hidden, true);
	await rm(repo, { recursive: true, force: true });
});
