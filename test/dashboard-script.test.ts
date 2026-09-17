import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { collectDashboardData, renderDashboard } from "../src/dashboard.ts";
import { nodeExec } from "../src/git.ts";
import { createWorkflow } from "../src/workflow.ts";
import { initRepository, VALID_PLAN, writeFiles } from "./helpers.ts";

const require = createRequire(import.meta.url);

class Events {
	listeners: Record<string, Array<(event: unknown) => void>> = {};
	addEventListener(type: string, fn: (event: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
	dispatch(type: string, details: Record<string, unknown> = {}) {
		const event = { target: this, ...details, type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
		for (const fn of this.listeners[type] ?? []) fn(event);
		return event;
	}
}

/** Minimal tree and event APIs, without browser layout or Mermaid's SVG renderer. */
function fakeDocument(html: string) {
	class Element extends Events {
		id = "";
		dataset: Record<string, string> = {};
		hidden = false;
		disabled = false;
		content = "";
		title = "";
		open = false;
		showModalCalls = 0;
		parentElement: Element | null = null;
		children: Element[] = [];
		attributes: Record<string, string> = {};
		classes = new Set<string>();
		private markup = "";
		private text = "";
		classList = {
			toggle: (c: string, on: boolean) => { on ? this.classes.add(c) : this.classes.delete(c); },
			add: (c: string) => this.classes.add(c),
			remove: (c: string) => this.classes.delete(c),
			contains: (c: string) => this.classes.has(c),
		};
		readonly tagName: string;
		constructor(tagName = "DIV") { super(); this.tagName = tagName; }
		get innerHTML() { return this.markup; }
		set innerHTML(value: string) {
			this.textContent = "";
			this.markup = value;
			const stack: Element[] = [this];
			for (const token of value.matchAll(/<\/([\w-]+)\s*>|<([\w-]+)\b([^>]*)>|([^<]+)/g)) {
				if (token[1]) { if (stack.length > 1) stack.pop(); continue; }
				const parent = stack.at(-1)!;
				if (token[4]) { parent.text += token[4]; continue; }
				const element = new Element(token[2]!.toUpperCase());
				for (const attr of token[3]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) element.setAttribute(attr[1]!, attr[2] ?? "");
				parent.appendChild(element);
				if (!/^(BR|HR|IMG|INPUT|META|LINK)$/.test(element.tagName) && !token[3]!.endsWith("/")) stack.push(element);
			}
		}
		get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
		set textContent(value: string) {
			for (const child of this.children) child.parentElement = null;
			this.children = [];
			this.markup = "";
			this.text = value;
		}
		setAttribute(name: string, value: string) {
			this.attributes[name] = value;
			if (name === "id") this.id = value;
			if (name === "class") this.classes = new Set(value.split(/\s+/));
			if (name === "hidden") this.hidden = true;
			if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
		}
		getAttribute(name: string) { return this.attributes[name] ?? null; }
		removeAttribute(name: string) { delete this.attributes[name]; }
		appendChild(child: Element) {
			if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((sibling) => sibling !== child);
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		matches(selector: string): boolean {
			if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
			const not = /:not\(\[([^\]]+)\]\)/.exec(selector);
			if (not) { if (this.getAttribute(not[1]!) !== null) return false; selector = selector.replace(not[0], ""); }
			const tag = /^[\w-]+/.exec(selector)?.[0];
			const id = /#([\w-]+)/.exec(selector)?.[1];
			const className = /\.([\w-]+)/.exec(selector)?.[1];
			const attr = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(selector);
			return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id) && (!className || this.classes.has(className)) &&
				(!attr || (this.getAttribute(attr[1]!) !== null && (attr[2] === undefined || this.getAttribute(attr[1]!) === attr[2])));
		}
		querySelectorAll(selector: string): Element[] {
			const parts = selector.trim().split(/\s+/);
			const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
			return descendants.filter((element) => {
				if (!element.matches(parts.at(-1)!)) return false;
				let ancestor = element.parentElement;
				for (const part of parts.slice(0, -1).reverse()) {
					while (ancestor && !ancestor.matches(part)) ancestor = ancestor.parentElement;
					if (!ancestor) return false;
					ancestor = ancestor.parentElement;
				}
				return true;
			});
		}
		querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
		closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
		click() {
			for (let element: Element | null = this; element; element = element.parentElement) element.dispatch("click", { target: this });
		}
		focus() { document.activeElement = this; }
		showModal() { this.showModalCalls++; this.open = true; this.querySelector("[autofocus]")?.focus(); }
		close() { if (this.open) { this.open = false; this.dispatch("close"); } }
		scrollIntoView() {}
	}
	const documentElement = new Element("HTML");
	const document = Object.assign(new Events(), {
		documentElement,
		activeElement: null as Element | null,
		getElementById: (id: string) => documentElement.querySelector("#" + id),
		querySelector: (selector: string) => selector.includes("workflow-revision") ? revision : documentElement.querySelector(selector),
		querySelectorAll: (selector: string) => documentElement.querySelectorAll(selector),
		createElement: (tag: string) => new Element(tag.toUpperCase()),
		head: { appendChild() {} },
		hidden: false,
	});
	// Parse only static body markup, not JavaScript, CSS, or JSON as HTML.
	documentElement.innerHTML = /<body>([\s\S]*?)<script type="application\/json"/.exec(html)![1]!;
	const data = documentElement.appendChild(new Element("SCRIPT"));
	data.id = "data";
	data.textContent = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)![1]!;
	const revision = new Element("META");
	revision.content = /workflow-revision" content="([^"]+)"/.exec(html)![1]!;
	const elements = new Map(documentElement.querySelectorAll("[id]").map((element) => [element.id, element]));
	elements.set("data", data);
	return { document, elements };
}

function dashboardHarness(html: string, hash = "", options: { renderGate?: Promise<void> } = {}) {
	const { document, elements } = fakeDocument(html);
	const marked = require("marked");
	const hljs = require("@highlightjs/cdn-assets/highlight.min.js");
	const window = Object.assign(new Events(), { scrollTo() {} });
	const location = { hash, pathname: "/w/x", href: "http://127.0.0.1/w/x" };
	let mermaidRuns = 0;
	const context: Record<string, unknown> = {
		document, marked, hljs, console, window, location,
		// Stub the external renderer only; graph wiring, events, fullscreen, and routing run the real script.
		mermaid: {
			initialize() {},
			async run({ nodes }: { nodes: Array<ReturnType<typeof document.createElement>> }) {
				mermaidRuns++;
				if (options.renderGate) await options.renderGate;
				for (const node of nodes) {
					node.innerHTML = '<svg><g class="node" id="flowchart-n0-0"><rect></rect></g><g class="node" id="flowchart-n1-1"><rect></rect></g></svg>';
					node.setAttribute("data-processed", "true");
				}
			},
		},
		localStorage: { getItem: () => null, setItem() {} },
		matchMedia: () => ({ matches: false }),
		fetch: () => Promise.reject(new Error("offline")),
		URL,
	};
	context.globalThis = context;
	vm.createContext(context);
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
	vm.runInContext(script, context);
	return { document, elements, window, location, context, get mermaidRuns() { return mermaidRuns; } };
}

function runDashboard(html: string, hash = "") {
	return dashboardHarness(html, hash).elements;
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

test("dependency graph fullscreen", async (t) => {
	const repo = await initRepository();
	t.after(() => rm(repo, { recursive: true, force: true }));
	const { location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "fullscreen", ask: "Ask" });
	await writeFiles(location.plan, VALID_PLAN);
	const verdict = { status: "yes", explanation: "Verified." };
	const verdicts = { necessary: verdict, sufficient: verdict, testing: verdict };
	await writeFiles(location.review, {
		"review.json": JSON.stringify({ overall: verdicts, changes: { "define-policy": verdicts, "implement-redrive": verdicts } }),
		"summary.md": "Review summary.\n",
		"changes/define-policy.md": "Policy reviewed.\n",
		"changes/implement-redrive.md": "Redrive reviewed.\n",
	});
	const html = renderDashboard(await collectDashboardData(location));

	async function setup(options: { renderGate?: Promise<void> } = {}) {
		const app = dashboardHarness(html, "#plan/graph", options);
		await setImmediate(); // Let the real runMermaid/wireGraph promise chain run.
		const get = (id: string) => { const element = app.document.getElementById(id); assert.ok(element, `Missing #${id}`); return element; };
		const graph = app.document.querySelector("#plan-content .graph");
		assert.ok(graph, "The graph section must render a graph");
		const parent = graph.parentElement;
		assert.ok(parent);
		return { app, graph, parent, trigger: get("graph-expand"), dialog: get("graph-dialog"), fullscreen: get("graph-fullscreen-content"), close: get("graph-close") };
	}

	function assertClosed({ app, dialog, fullscreen }: Awaited<ReturnType<typeof setup>>) {
		assert.equal(dialog.open, false);
		assert.equal(fullscreen.children.length, 0);
		assert.equal(app.document.documentElement.classList.contains("graph-fullscreen-open"), false);
	}

	await t.test("renders an accessible Fullscreen button and a named dialog", async () => {
		const state = await setup();
		const { app, trigger, dialog, close } = state;
		assert.equal(trigger.tagName, "BUTTON");
		assert.equal(trigger.getAttribute("type"), "button");
		assert.equal(trigger.textContent.trim(), "Fullscreen");
		assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
		assert.equal(trigger.getAttribute("aria-controls"), dialog.id);
		assert.equal(dialog.tagName, "DIALOG");
		const label = dialog.getAttribute("aria-labelledby");
		assert.ok(label);
		assert.equal(app.document.getElementById(label)?.textContent, "Dependency graph");
		assert.equal(dialog.querySelector("header button"), close);
		assert.equal(close.getAttribute("type"), "button");
		assert.match(close.textContent, /Exit fullscreen/);
		assertClosed(state);
		const goal = dashboardHarness(html, "#plan/goal");
		assert.equal(goal.document.getElementById("graph-expand"), null, "Other plan sections must not show the graph control");
	});

	for (const exit of ["button", "Escape", "native close"] as const) {
		await t.test(`${exit} restores the same graph, trigger focus, and page scrolling`, async () => {
			const state = await setup();
			const { app, graph, parent, trigger, dialog, fullscreen, close } = state;
			const svg = graph.querySelector("svg");
			assert.ok(svg);
			trigger.click(); // Bubbles to the real delegated plan-content listener.
			assert.equal(dialog.open, true);
			assert.equal(dialog.showModalCalls, 1);
			assert.equal(graph.parentElement, fullscreen);
			assert.equal(fullscreen.querySelector(".graph"), graph);
			assert.equal(parent.querySelector(".graph"), null);
			assert.equal(app.document.documentElement.classList.contains("graph-fullscreen-open"), true);
			close.focus();
			if (exit === "button") close.click();
			// Native Escape dispatches a cancel event; the script must prevent its default action.
			if (exit === "Escape") assert.equal(dialog.dispatch("cancel").defaultPrevented, true);
			if (exit === "native close") dialog.close();
			assertClosed(state);
			assert.equal(graph.parentElement, parent);
			assert.equal(parent.querySelector(".graph"), graph);
			assert.equal(graph.querySelector("svg"), svg);
			assert.equal(app.document.activeElement, trigger);
			assert.equal(app.mermaidRuns, 1, "Opening and closing must not render a replacement graph");
		});
	}

	await t.test("repeated opens reuse the graph and ignore a stale close event", async () => {
		const state = await setup();
		const { app, graph, parent, trigger, dialog, fullscreen, close } = state;
		for (let cycle = 1; cycle <= 3; cycle++) {
			trigger.click();
			trigger.click(); // A duplicate request must not overwrite the saved parent.
			dialog.dispatch("close"); // A queued close event may arrive after the dialog reopens.
			assert.equal(dialog.open, true);
			assert.equal(dialog.showModalCalls, cycle);
			assert.equal(fullscreen.querySelector(".graph"), graph);
			assert.equal(app.document.documentElement.classList.contains("graph-fullscreen-open"), true);
			close.click();
			close.click();
			assertClosed(state);
			assert.equal(graph.parentElement, parent);
			assert.equal(app.document.activeElement, trigger);
		}
		assert.equal(app.mermaidRuns, 1);
	});

	for (const navigation of ["hash", "tab", "theme"] as const) {
		await t.test(`${navigation} navigation closes fullscreen before rendering`, async () => {
			const state = await setup();
			const { app, graph, parent, trigger, dialog } = state;
			trigger.click();
			// Observe cleanup at the render boundary, not only after both operations finish.
			const destination = app.elements.get(navigation === "tab" ? "review-content" : "plan-content")!;
			const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(destination), "innerHTML")!;
			let renders = 0;
			Object.defineProperty(destination, "innerHTML", {
				get: descriptor.get,
				set(value: string) {
					renders++;
					assertClosed(state);
					assert.equal(graph.parentElement, parent, "Restore the old graph before replacing content");
					descriptor.set!.call(this, value);
				},
			});
			if (navigation === "hash") app.location.hash = "#plan/change/define-policy";
			if (navigation === "tab") {
				app.elements.get("review-tab")!.click();
				assert.equal(app.location.hash, "#review");
			}
			if (navigation === "theme") app.elements.get("theme")!.click();
			else app.window.dispatch("hashchange");
			assert.equal(renders, 1);
			assertClosed(state);
			assert.equal(dialog.open, false);
			if (navigation === "hash") assert.match(destination.innerHTML, /Define the redrive policy/);
			if (navigation === "tab") assert.equal(app.elements.get("review-view")!.hidden, false);
			if (navigation === "theme") {
				assert.equal(app.document.documentElement.dataset.theme, "dark");
				assert.notEqual(destination.querySelector(".graph"), graph);
			}
			await setImmediate();
		});
	}

	for (const delayed of [false, true]) {
		await t.test(`graph nodes route to changes ${delayed ? "when Mermaid finishes after opening" : "after opening"} fullscreen`, async () => {
			let finishRender!: () => void;
			const renderGate = delayed ? new Promise<void>((resolve) => { finishRender = resolve; }) : undefined;
			const state = await setup({ renderGate });
			const { app, graph, trigger, fullscreen } = state;
			if (delayed) assert.equal(graph.querySelector("svg"), null);
			trigger.click();
			if (delayed) { finishRender(); await setImmediate(); }
			assert.equal(fullscreen.querySelector(".graph"), graph);
			const node = graph.querySelector("#flowchart-n1-1");
			assert.ok(node);
			node.querySelector("rect")!.click();
			assert.equal(app.location.hash, "#plan/change/implement-redrive");
			app.window.dispatch("hashchange");
			assertClosed(state);
			assert.match(app.elements.get("plan-content")!.innerHTML, /Implement queue redrive/);
		});
	}

	await t.test("fullscreen graph nodes are labelled links activated only by Enter", async () => {
		const state = await setup();
		const { app, graph, trigger, dialog, fullscreen } = state;
		trigger.click();
		assert.equal(dialog.open, true);
		assert.equal(fullscreen.querySelector(".graph"), graph);
		const nodes = graph.querySelectorAll(".node");
		assert.equal(nodes.length, 2);
		for (const [index, label] of ["1. Define the redrive policy", "2. Implement queue redrive"].entries()) {
			assert.equal(nodes[index]!.getAttribute("tabindex"), "0");
			assert.equal(nodes[index]!.getAttribute("role"), "link");
			assert.equal(nodes[index]!.getAttribute("aria-label"), label);
		}
		const node = nodes[1]!;
		node.focus();
		assert.equal(app.document.activeElement, node);
		for (const key of ["ArrowRight", " "]) {
			assert.equal(node.dispatch("keydown", { key }).defaultPrevented, false);
			assert.equal(app.location.hash, "#plan/graph");
			assert.equal(dialog.open, true);
		}
		assert.equal(node.dispatch("keydown", { key: "Enter" }).defaultPrevented, true);
		assert.equal(app.location.hash, "#plan/change/implement-redrive");
		app.window.dispatch("hashchange");
		assertClosed(state);
		assert.match(app.elements.get("plan-content")!.innerHTML, /Implement queue redrive/);
	});

	await t.test("paging keys are suppressed only while fullscreen is open", async () => {
		const state = await setup();
		const { app, trigger, close } = state;
		trigger.click();
		for (const key of ["[", "]"]) {
			app.document.dispatch("keydown", { key, target: close });
			assert.equal(app.location.hash, "#plan/graph");
			assert.equal(app.elements.get("plan-pos")!.textContent, "3 / 6");
		}
		close.click();
		app.document.dispatch("keydown", { key: "[", target: trigger });
		assert.equal(app.location.hash, "#plan/intro");
		app.location.hash = "#plan/graph";
		app.window.dispatch("hashchange");
		app.document.dispatch("keydown", { key: "]", target: app.document.getElementById("graph-expand") });
		assert.equal(app.location.hash, "#plan/change/define-policy");
	});
});
