import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";

// The production file is an unbundled browser asset, not a TypeScript module.
const { createAnnotations, captureSelection, restoreAnchor, indexText } = await import(
  new URL("../src/lib/annotations/browser.js", import.meta.url).href
);

type Recipient = { id: string; label: string; active: boolean; updatedAt: number; resume?: string };
type Comment = { id: string; documentId: string; documentTitle: string; revision: string; start: number; end: number; quote: string; text: string };
type Reply = { id?: string; commentId: string; author: string; text: string; createdAt: number; role?: "user" | "agent"; delivered?: boolean };
type Resolution = { id: string; commentId: string; resolved: boolean; createdAt: number };
type Batch = { id: string; recipientId: string; comments: Comment[]; delivered: boolean; createdAt: number; replies: Reply[]; resolutions?: Resolution[] };
type ServerData = { token: string; recipient: Recipient | null; batches: Batch[] };
type Submission = { id: string; comments: Comment[] };
type ThreadAction = { id: string; action: "reply"; batchId: string; commentId: string; text: string } |
  { id: string; action: "resolve"; batchId: string; commentId: string; resolved: boolean };
type PostRequest = Submission | ThreadAction;
const active = (id = "one", updatedAt = 1): Recipient => ({ id, label: `Recipient ${id}`, active: true, updatedAt });
const settle = async () => { await setImmediate(); await setImmediate(); };

function dom(html = "<p>Alpha <strong>beta</strong> gamma</p>") {
  return new JSDOM(`<div id="annotations-fixture"><main id="reader">${html}</main><aside id="margin"></aside><aside id="sidebar"></aside></div>`, { url: "http://localhost/reader" });
}
function select(document: Document, start: Node, startOffset: number, end = start, endOffset = startOffset) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
function selectWhole(document: Document, root: HTMLElement) {
  return select(document, root, 0, root, root.childNodes.length);
}
function reader(document: Document, id = "plan/change/example") {
  return { id, title: "Example", root: document.querySelector<HTMLElement>("#reader")! };
}

function mockLayout(window: JSDOM["window"], root: HTMLElement, margin: HTMLElement) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const bounds = { rootTop: 100, marginTop: 100, width: 280, height: 1400, mobile: false };
  window.matchMedia = (query) => ({ matches: bounds.mobile && query.includes("900px"), media: query }) as MediaQueryList;
  const quoteRects = new Map<string, { top: number; height?: number; left?: number; width?: number }[]>();
  const bubbleHeights = new Map<string, number>();
  const box = (top: number, height: number, width = bounds.width) => new window.DOMRect(700, top, width, height);
  const offset = (node: HTMLElement) => {
    const transform = /translate(?:Y|3d)?\([^,]*?(-?[\d.]+)px/.exec(node.style.transform);
    return Number.parseFloat(node.style.top) || Number(transform?.[1]) || 0;
  };
  function height(node: HTMLElement) {
    if (node.hidden) return 0;
    if (node.classList.contains("annotations-composer")) return 180;
    if (node.classList.contains("annotations-bubble")) return bubbleHeights.get(node.dataset.commentId!) ?? 90;
    if (node === root || node === margin) return bounds.height;
    return 60;
  }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === root) return box(bounds.rootTop, bounds.height, 600);
    if (this === margin || margin.contains(this)) {
      let top = bounds.marginTop;
      for (let node: HTMLElement | null = this; node && node !== margin; node = node.parentElement) top += offset(node);
      return box(top, height(this));
    }
    return box(0, height(this));
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return height(this); } });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return height(this); } });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return bounds.width; } });
  window.Range.prototype.getClientRects = function () {
    const rects = (quoteRects.get(this.toString()) ?? [{ top: 400, height: 20 }]).map(({ top, height, left, width }) =>
      new window.DOMRect(left ?? 700, top, width ?? 180, height ?? 20));
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList;
  };
  window.Range.prototype.getBoundingClientRect = function () {
    const rects = [...this.getClientRects()];
    if (!rects.length) return box(0, 0, 0);
    return box(rects[0]!.top, rects.at(-1)!.bottom - rects[0]!.top, 180);
  };
  const resizeObservers = new Set<{ targets: Set<Element>; callback: () => void }>();
  class ResizeObserverMock {
    targets = new Set<Element>();
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; resizeObservers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); resizeObservers.delete(this); }
  }
  Object.defineProperty(window, "ResizeObserver", { configurable: true, value: ResizeObserverMock });
  const fonts = new window.EventTarget();
  let fontsReady!: () => void;
  Object.defineProperty(fonts, "ready", { value: new Promise<void>((resolve) => { fontsReady = resolve; }) });
  Object.defineProperty(window.document, "fonts", { configurable: true, value: fonts });
  return {
    bounds, quoteRects, bubbleHeights, frames, resizeObservers,
    flush() {
      for (let pass = 0; frames.size; pass++) {
        assert.ok(pass < 10, "layout must settle without scheduling an endless animation loop");
        const callbacks = [...frames.values()]; frames.clear();
        for (const callback of callbacks) callback(pass * 16);
      }
    },
    resize() { window.dispatchEvent(new window.Event("resize")); },
    scroll() { window.document.dispatchEvent(new window.Event("scroll", { bubbles: true })); },
    observeResize() { for (const observer of resizeObservers) observer.callback(); },
    fontsReady,
    fontsLoaded() { fonts.dispatchEvent(new window.Event("loadingdone")); },
  };
}

function fixture(options: { html?: string; recipient?: Recipient | null; stored?: string; highlights?: boolean; batches?: Batch[] } = {}) {
  const page = dom(options.html);
  const { window } = page;
  const document = window.document;
  const root = document.querySelector<HTMLElement>("#reader")!;
  // Shared wrapper keeps status assertions independent of which panel owns them.
  const container = document.querySelector<HTMLElement>("#annotations-fixture")!;
  const global = document.querySelector<HTMLElement>("#sidebar")!;
  const margin = document.querySelector<HTMLElement>("#margin")!;
  const layout = mockLayout(window, root, margin);
  const timers = new Set<() => void>();
  window.setInterval = ((callback: () => void) => { timers.add(callback); return 1; }) as typeof window.setInterval;
  window.clearInterval = (() => timers.clear()) as typeof window.clearInterval;
  const highlights = new Map<string, Set<Range>>();
  if (options.highlights !== false) {
    Object.defineProperty(window, "CSS", { value: { highlights } });
    Object.defineProperty(window, "Highlight", { value: class extends Set<Range> {
      constructor(...ranges: Range[]) { super(ranges); }
    } });
  }
  if (options.stored) window.localStorage.setItem("test-annotations", options.stored);
  let activityTime = Math.max(1, ...(options.batches ?? []).flatMap((batch) =>
    [batch.createdAt, ...batch.replies.map((reply) => reply.createdAt), ...(batch.resolutions ?? []).map((resolution) => resolution.createdAt)]));
  const state: { data: ServerData; getError?: string; post: (body: PostRequest) => Promise<Response> } = {
    data: { token: "csrf-token", recipient: options.recipient === undefined ? active() : options.recipient, batches: options.batches ?? [] },
    async post(body) {
      if ("action" in body) {
        const batch = state.data.batches.find((batch) => batch.id === body.batchId);
        if (!batch || !batch.comments.some((comment) => comment.id === body.commentId)) {
          return new Response(JSON.stringify({ error: "Unknown thread" }), { status: 409 });
        }
        if (body.action === "reply" && !batch.replies.some((reply) => reply.id === body.id)) {
          batch.replies.push({ id: body.id, commentId: body.commentId, text: body.text,
            author: "You", role: "user", delivered: false, createdAt: ++activityTime });
        } else if (body.action === "resolve" && !batch.resolutions?.some((resolution) => resolution.id === body.id)) {
          (batch.resolutions ??= []).push({ id: body.id, commentId: body.commentId, resolved: body.resolved, createdAt: ++activityTime });
        }
        return new Response(JSON.stringify(batch));
      }
      const existing = state.data.batches.find((batch) => batch.id === body.id);
      if (existing) return new Response(JSON.stringify(existing));
      const batch: Batch = { ...body, recipientId: state.data.recipient!.id, createdAt: ++activityTime, delivered: false, replies: [] };
      state.data.batches.push(batch);
      return new Response(JSON.stringify(batch));
    },
  };
  const calls: { method: string; body?: string; headers?: HeadersInit; signal?: AbortSignal | null }[] = [];
  window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push({ method, body: init?.body as string | undefined, headers: init?.headers, signal: init?.signal });
    if (method === "POST") return state.post(JSON.parse(init!.body as string));
    if (state.getError) throw new Error(state.getError);
    return new Response(JSON.stringify(state.data));
  };
  const navigations: string[] = [];
  const api = createAnnotations({ container: global, marginContainer: margin, endpoint: "/annotations", storageKey: "test-annotations", navigate: (id: string) => navigations.push(id) });
  api.setDocument(reader(document));
  const byText = (text: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text);
    assert.ok(button, `Missing button: ${text}`);
    return button;
  };
  function startComment(text = "Please clarify") {
    selectWhole(document, root);
    document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }));
    byText("Add comment").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    // Simulate focus stealing the original browser selection before click.
    document.getSelection()!.removeAllRanges();
    byText("Add comment").click();
    const textarea = container.querySelector<HTMLTextAreaElement>('.annotations-composer textarea')!;
    textarea.value = text;
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  function addDraft(text = "Please clarify") {
    startComment(text);
    container.querySelector(".annotations-composer")!.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  }
  return {
    window, document, root, container, global, margin, layout, timers, highlights, state, calls, api, byText, startComment, addDraft, navigations,
    async poll() { for (const callback of timers) callback(); await settle(); },
    stored: () => window.localStorage.getItem("test-annotations")!,
    close() { api.destroy(); window.close(); },
  };
}

test("anchors span headings, inline markup, code, and tables without rewriting DOM", () => {
  const page = dom("<h2>Title</h2><p>Alpha <strong>beta</strong> gamma</p><pre><code>delta</code></pre><table><tbody><tr><td>echo</td></tr></tbody></table>");
  try {
    const document = page.window.document;
    const section = reader(document);
    const before = section.root.innerHTML;
    const bold = section.root.querySelector("strong")!.firstChild!;
    const code = section.root.querySelector("code")!.firstChild!;
    const anchor = captureSelection(section, select(document, bold, 1, code, 3));
    const included = indexText(section.root).text;
    assert.equal(anchor.start, included.indexOf("beta") + 1);
    assert.equal(anchor.end, included.indexOf("delta") + 3);
    assert.equal(anchor.quote, "eta gammadel");
    assert.equal(restoreAnchor(section.root, anchor).toString(), anchor.quote);
    const whole = captureSelection(section, selectWhole(document, section.root));
    assert.equal(whole.quote, "TitleAlpha beta gammadeltaecho");
    assert.equal(whole.start, 0);
    assert.equal(section.root.innerHTML, before);
  } finally { page.window.close(); }
});

test("excluded content rejects crossing selections, including textless elements", () => {
  const exclusions = ["<span class='mermaid'>diagram</span>", "<svg><text>diagram</text></svg>", "<button>Run</button>",
    "<input value='value'>", "<textarea>value</textarea>", "<select><option>one</option></select>", "<span hidden>hidden</span>",
    "<span aria-hidden='true'>hidden</span>", "<span contenteditable='true'>edit</span>", "<span data-annotation-exclude>skip</span>",
    "<svg></svg>", "<img src='image.png'>", "<script>ignore</script>"];
  for (const excluded of exclusions) {
    const page = dom(`<p>left${excluded}right</p>`);
    try {
      const document = page.window.document;
      const section = reader(document);
      const paragraph = section.root.firstChild!;
      assert.equal(captureSelection(section, selectWhole(document, section.root)), null, excluded);
      const right = paragraph.lastChild!;
      const anchor = captureSelection(section, select(document, right, 0, right, 5));
      assert.equal(anchor.quote, "right", excluded);
      assert.equal(anchor.start, 4, excluded);
      assert.equal(restoreAnchor(section.root, anchor).toString(), "right", excluded);
      assert.equal(indexText(section.root).text, "leftright", excluded);
    } finally { page.window.close(); }
  }
});

test("empty and outside selections are rejected", () => {
  const page = dom("<p>  </p>");
  try {
    const document = page.window.document;
    const section = reader(document);
    assert.equal(captureSelection(section, selectWhole(document, section.root)), null);
    assert.equal(captureSelection(section, select(document, section.root, 0)), null);
    const outside = document.createTextNode("outside");
    document.querySelector("aside")!.append(outside);
    assert.equal(captureSelection(section, select(document, outside, 0, outside, 7)), null);
    assert.equal(captureSelection(section, { rangeCount: 2, isCollapsed: false }), null);
  } finally { page.window.close(); }
});

test("normalized anchors survive node splitting, but stale revisions and mismatched quotes never highlight", () => {
  const page = dom("<p>Alpha&nbsp;beta</p>");
  try {
    const document = page.window.document;
    const section = reader(document);
    const anchor = captureSelection(section, selectWhole(document, section.root));
    assert.equal(anchor.quote, "Alpha beta");
    section.root.innerHTML = "<p>Alpha <em>beta</em></p>";
    assert.equal(restoreAnchor(section.root, anchor).toString(), "Alpha beta");
    assert.equal(restoreAnchor(section.root, { ...anchor, quote: "other text" }), null);
    for (const invalid of [{ start: -1 }, { end: 500 }, { start: 1.5 }, { end: 0 }]) {
      assert.equal(restoreAnchor(section.root, { ...anchor, ...invalid }), null);
    }
    section.root.innerHTML = "<p>Omega beta</p>";
    assert.equal(restoreAnchor(section.root, anchor), null);
    section.root.replaceChildren(document.createTextNode("Alpha\rbeta"));
    assert.equal(indexText(section.root).text, "Alpha\nbeta");
    const newline = captureSelection(section, selectWhole(document, section.root));
    section.root.replaceChildren(document.createTextNode("Alpha\nbeta"));
    assert.ok(restoreAnchor(section.root, newline));
  } finally { page.window.close(); }
});

test("new excluded elements invalidate restoration even when included text is unchanged", () => {
  const page = dom("<p>leftright</p>");
  try {
    const document = page.window.document;
    const section = reader(document);
    const anchor = captureSelection(section, selectWhole(document, section.root));
    section.root.innerHTML = "<p>left<svg></svg>right</p>";
    assert.equal(indexText(section.root).revision, anchor.revision);
    assert.equal(restoreAnchor(section.root, anchor), null);
  } finally { page.window.close(); }
});

test("keyboard selection survives button blur; composer and drafts persist without an implicit send", async () => {
  const f = fixture();
  try {
    await settle();
    const before = f.root.innerHTML;
    f.startComment("<img src=x onerror=alert(1)> clarify");
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(f.container.querySelector("form")!.hidden, false);
    assert.equal(f.highlights.get("annotations-draft")!.size, 1);
    assert.equal(JSON.parse(f.stored()).composer.text, "<img src=x onerror=alert(1)> clarify");
    const restored = fixture({ stored: f.stored() });
    try {
      await settle();
      assert.equal(restored.container.querySelector("textarea")!.value, "<img src=x onerror=alert(1)> clarify");
      restored.container.querySelector("form")!.dispatchEvent(new restored.window.Event("submit", { cancelable: true, bubbles: true }));
      assert.equal(JSON.parse(restored.stored()).drafts.length, 1);
      assert.equal(restored.container.querySelectorAll("img").length, 0);
      assert.equal(restored.calls.filter((call) => call.method === "POST").length, 0);
      restored.byText("Delete draft").click();
      assert.equal(restored.api.hasDrafts(), false);
      assert.equal(restored.highlights.has("annotations-draft"), false);
    } finally { restored.close(); }
    assert.equal(f.root.innerHTML, before);
  } finally { f.close(); }
});

test("the server selects the recipient without any recipient selector or resume-path clutter", async () => {
  const f = fixture({ recipient: active("two") });
  try {
    await settle();
    f.addDraft();
    assert.equal(f.byText("Send comments").disabled, false);
    assert.equal(f.container.querySelector("select"), null);
    assert.equal(f.container.querySelector(".annotations-resume"), null);
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Comments go to: Recipient two/);
    assert.equal(f.global.querySelector(".annotations-composer, .annotations-target, .annotations-status"), null);
    assert.equal(f.global.hidden, true, "the inactive global panel may hold the unused shared reply editor");
    assert.ok(f.margin.querySelector(".annotations-composer"));
    for (const label of ["Add comment", "Add to drafts", "Send comments"]) assert.ok(f.margin.contains(f.byText(label)), `${label} belongs beside the reader`);
    for (const key of ["recipient", "recipientId", "explicitRecipient"]) assert.equal(key in JSON.parse(f.stored()), false);
  } finally { f.close(); }
});

test("offline recipients remain sendable and show only the server-provided label", async () => {
  const offline = { ...active("offline"), active: false, resume: "/private/sessions/resume-offline.jsonl" };
  const f = fixture({ recipient: offline });
  try {
    await settle();
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Waiting for Recipient offline to resume\./);
    assert.doesNotMatch(f.container.textContent!, /\/private\/sessions|Resume:|pi --session/);
    assert.equal(f.container.querySelector("select"), null);
    f.addDraft("Queue while the session is offline");
    assert.equal(f.byText("Send comments").disabled, false);
    f.byText("Send comments").click();
    await settle();
    assert.deepEqual(Object.keys(JSON.parse(f.calls.find((call) => call.method === "POST")!.body!)).sort(), ["comments", "id"]);
    assert.equal(f.state.data.batches[0]!.recipientId, "offline");
    assert.equal(f.global.querySelector(".annotations-state")!.textContent, "Pending");
  } finally { f.close(); }
});

test("recipient changes follow the server while preserving unfinished text and existing drafts", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft("Existing draft");
    f.startComment("Unfinished comment");
    const before = JSON.parse(f.stored());
    f.state.data.recipient = { ...active("two"), active: false, resume: "private-session-file" };
    await f.poll();
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Waiting for Recipient two to resume\./);
    assert.equal(f.margin.querySelector("textarea")!.value, "Unfinished comment");
    assert.deepEqual(JSON.parse(f.stored()).drafts, before.drafts);
    assert.deepEqual(JSON.parse(f.stored()).composer, before.composer);
    f.state.data.recipient = active("three");
    await f.poll();
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Comments go to: Recipient three/);
    assert.equal(f.container.querySelector("select"), null);
    f.byText("Send comments").click();
    await settle();
    assert.equal(f.state.data.batches[0]!.recipientId, "three");
    assert.equal("recipientId" in JSON.parse(f.calls.find((call) => call.method === "POST")!.body!), false);
  } finally { f.close(); }
});

test("a missing server recipient permits drafting but disables sending until registration", async () => {
  const f = fixture({ recipient: null });
  try {
    await settle();
    f.addDraft();
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(f.byText("Send comments").disabled, true);
    assert.equal(f.container.querySelector("select"), null);
    f.state.data.recipient = active("registered");
    await f.poll();
    assert.equal(f.byText("Send comments").disabled, false);
    f.state.data.recipient = null;
    await f.poll();
    assert.equal(f.byText("Send comments").disabled, true);
    assert.doesNotMatch(f.margin.querySelector(".annotations-target")!.textContent!, /Recipient registered/);
  } finally { f.close(); }
});

test("explicit send uses the token, clears drafts only after success, and paints saved comments", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    f.byText("Send comments").click();
    assert.equal(f.api.hasDrafts(), true);
    await settle();
    const call = f.calls.find((call) => call.method === "POST")!;
    assert.equal(new Headers(call.headers).get("X-Annotation-Token"), "csrf-token");
    assert.equal(new Headers(call.headers).get("Content-Type"), "application/json");
    const body = JSON.parse(call.body!);
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(body).sort(), ["comments", "id"]);
    assert.equal(body.comments[0].documentId, "plan/change/example");
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(f.highlights.has("annotations-draft"), false);
    assert.equal(f.highlights.get("annotations-saved")!.size, 1);
    assert.equal(f.global.querySelector(".annotations-state")!.textContent, "Pending");
  } finally { f.close(); }
});

test("uncertain failures retain drafts and retry the exact request ID and body after reload", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft("Keep this draft");
    f.state.post = async () => { throw new Error("connection lost"); };
    f.byText("Send comments").click();
    await settle();
    const original = f.calls.find((call) => call.method === "POST")!.body;
    assert.equal(f.api.hasDrafts(), true);
    assert.match(f.container.textContent!, /connection lost/);
    assert.equal(f.byText("Delete draft").disabled, true);
    assert.equal(f.container.querySelector("select"), null);
    const restored = fixture({ stored: f.stored(), recipient: active("two") });
    try {
      await settle();
      assert.equal(restored.api.hasDrafts(), true);
      assert.match(restored.margin.querySelector(".annotations-target")!.textContent!, /Comments go to: Recipient two/);
      restored.byText("Retry Send comments").click();
      await settle();
      assert.equal(restored.calls.find((call) => call.method === "POST")!.body, original);
      assert.equal(restored.api.hasDrafts(), false);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("a confirmed GET resolves an uncertain POST without posting a duplicate", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    f.state.post = async (body) => {
      assert.ok("comments" in body);
      f.state.data.batches.push({ ...body, recipientId: "one", delivered: true, createdAt: 1, replies: [] });
      throw new Error("response lost after storage");
    };
    f.byText("Send comments").click();
    await settle();
    assert.equal(f.api.hasDrafts(), true);
    await f.poll();
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(f.global.querySelector(".annotations-state")!.textContent, "Delivered");
    assert.doesNotMatch(f.container.textContent!, /unconfirmed/);
  } finally { f.close(); }
});

test("HTTP errors and invalid successful responses preserve drafts and the retry identity", async () => {
  for (const response of [new Response(JSON.stringify({ error: "Recipient unavailable" }), { status: 503 }), new Response("not json")]) {
    const f = fixture();
    try {
      await settle();
      f.addDraft();
      f.state.post = async () => response;
      f.byText("Send comments").click();
      await settle();
      assert.equal(f.api.hasDrafts(), true);
      assert.ok(JSON.parse(f.stored()).pending.id);
      assert.equal(f.byText("Retry Send comments").disabled, false);
      assert.match(f.container.textContent!, /Cannot confirm delivery/);
    } finally { f.close(); }
  }
});

test("polling runs only while visible, reports failures, and updates reply text safely", async () => {
  const f = fixture();
  try {
    await settle();
    Object.defineProperty(f.document, "visibilityState", { configurable: true, value: "hidden" });
    const before = f.calls.length;
    await f.poll();
    assert.equal(f.calls.length, before);
    f.state.getError = "offline";
    Object.defineProperty(f.document, "visibilityState", { configurable: true, value: "visible" });
    f.document.dispatchEvent(new f.window.Event("visibilitychange"));
    await settle();
    assert.match(f.container.textContent!, /Cannot load comments: offline/);
    delete f.state.getError;
    await f.poll();
    assert.doesNotMatch(f.container.textContent!, /Cannot load comments/);
    f.addDraft();
    f.byText("Send comments").click();
    await settle();
    const batch = f.state.data.batches[0]!;
    batch.replies.push({ commentId: batch.comments[0]!.id, text: "<script>unsafe()</script>", author: "<b>Display name</b>", createdAt: 2 });
    await f.poll();
    assert.equal(f.global.querySelector(".annotations-state")!.textContent, "Replied");
    const reply = f.global.querySelector(".annotations-reply")!;
    assert.equal(reply.querySelector("strong")!.textContent, "Agent");
    assert.equal(reply.querySelector("p")!.textContent, "<script>unsafe()</script>");
    assert.equal(reply.querySelectorAll("script,b").length, 0);
    const quote = f.container.querySelector(".annotations-quote-button");
    await f.poll();
    assert.equal(f.container.querySelector(".annotations-quote-button"), quote, "unchanged polls must not replace focused controls");
  } finally { f.close(); }
});

test("draft navigation supports generic document IDs, rerenders, and stale anchors", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    const original = f.root.innerHTML;
    f.api.setDocument({ id: "review/change/example", title: "Review", root: f.root });
    assert.equal(f.highlights.has("annotations-draft"), false);
    f.container.querySelector<HTMLButtonElement>(".annotations-quote-button")!.click();
    assert.deepEqual(f.navigations, ["plan/change/example"]);
    f.root.innerHTML = original;
    f.api.setDocument(reader(f.document));
    assert.equal(f.highlights.get("annotations-focus")!.size, 1);
    assert.equal(f.highlights.get("annotations-draft")!.size, 1);
    f.root.innerHTML = "<p>Changed text</p>";
    f.api.setDocument(reader(f.document));
    assert.equal(f.highlights.has("annotations-draft"), false);
    assert.equal(f.highlights.has("annotations-focus"), false);
    assert.equal(f.margin.querySelectorAll(".annotations-bubbles > .annotations-bubble").length, 0);
    assert.match(f.container.textContent!, /Alpha beta gamma/);
    f.api.setDocument(null);
    assert.equal(f.highlights.has("annotations-draft"), false);
    assert.equal(f.api.hasDrafts(), true);
  } finally { f.close(); }
});

test("one batch can contain plan and review drafts with independent document anchors", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft("Plan comment");
    f.root.innerHTML = "<h2>Review verdict</h2><p>Needs another test</p>";
    f.api.setDocument({ id: "review/change/example", title: "Review", root: f.root });
    f.addDraft("Review comment");
    assert.equal(f.highlights.get("annotations-draft")!.size, 1);
    f.byText("Send comments").click();
    await settle();
    const sent = JSON.parse(f.calls.find((call) => call.method === "POST")!.body!);
    assert.deepEqual(sent.comments.map((comment: Comment) => comment.documentId), ["plan/change/example", "review/change/example"]);
    assert.equal(sent.comments[1].quote, "Review verdictNeeds another test");
    assert.equal(f.highlights.get("annotations-saved")!.size, 1);
  } finally { f.close(); }
});

function storedDrafts(count: number, text = "Saved comment", overrides: Partial<Comment> = {}) {
  const page = dom();
  try {
    const document = page.window.document;
    const section = reader(document);
    const anchor = captureSelection(section, selectWhole(document, section.root));
    return JSON.stringify({ version: 2, composer: null, pending: null,
      drafts: Array.from({ length: count }, (_, index) => ({ id: `draft-${index}`, ...anchor, text, ...overrides })) });
  } finally { page.window.close(); }
}

function savedComment(id: string, overrides: Partial<Comment> = {}): Comment {
  return { ...JSON.parse(storedDrafts(1)).drafts[0], id, ...overrides };
}
function savedBatch(id: string, createdAt: number, comments: Comment[], delivered = false): Batch {
  return { id, recipientId: "previous-session", createdAt, comments, delivered, replies: [] };
}
function commentIds(root: ParentNode, selector: string) {
  return [...root.querySelectorAll<HTMLElement>(selector)].map((node) => node.dataset.commentId);
}

type Fixture = ReturnType<typeof fixture>;
function threadCard(f: Fixture, key: string, view: "local" | "global" = "local") {
  const host = view === "local" ? f.margin : f.global;
  const card = [...host.querySelectorAll<HTMLElement>(".annotations-comment[data-thread-key]")].find((node) => node.dataset.threadKey === key);
  assert.ok(card, `Missing ${view} thread card: ${key}`);
  return card;
}
function openThread(f: Fixture, key: string, view: "local" | "global" = "local") {
  f.api.setView(view);
  threadCard(f, key, view).querySelector<HTMLElement>(".annotations-comment-text")!.click();
  f.layout.flush();
  return replyEditor(f);
}
function replyEditor(f: Fixture) {
  const forms = f.container.querySelectorAll<HTMLFormElement>("form.annotations-thread-editor");
  assert.equal(forms.length, 1, "one shared reply editor must belong to the focused thread");
  const form = forms[0]!;
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]');
  assert.ok(textarea, "reply editor has an accessible textarea");
  assert.equal(form.hidden, false);
  return { form, textarea };
}
function writeReply(f: Fixture, text: string) {
  const editor = replyEditor(f);
  editor.textarea.value = text;
  editor.textarea.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  return editor;
}
function submitReply(f: Fixture) {
  replyEditor(f).form.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
}
function pointer(f: Fixture, type: string, x = 720, y = 410, target: Element = f.root, buttons = 0) {
  target.dispatchEvent(new f.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons, button: 0 }));
  f.layout.flush();
}
function clickHighlight(f: Fixture, x = 720, y = 410) {
  pointer(f, "pointerdown", x, y, f.root, 1);
  pointer(f, "pointerup", x, y);
  pointer(f, "click", x, y);
}
function showResolved(f: Fixture) {
  const toggle = [...f.global.querySelectorAll<HTMLElement>("button,label,input")].find((node) =>
    node.getAttribute("aria-label") === "Show resolved" || node.textContent?.trim() === "Show resolved");
  assert.ok(toggle, "global view offers a Show resolved toggle");
  toggle.click();
}
function threadPosts(f: Fixture) {
  return f.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!) as PostRequest)
    .filter((body): body is ThreadAction => "action" in body);
}


test("clicking unannotated document, page, or sidebar space deselects threads without losing reply drafts", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle();
    for (const view of ["local", "global"] as const) {
      for (const target of [f.root, f.document.body, view === "local" ? f.margin : f.global]) {
        openThread(f, "batch/comment", view); writeReply(f, "Keep this unfinished reply");
        pointer(f, "pointermove");
        assert.equal(f.highlights.get("annotations-focus")!.size, 1);
        assert.equal(f.highlights.get("annotations-hover")!.size, 1);
        pointer(f, "click", 10, 50, target);
        assert.equal(f.highlights.has("annotations-focus"), false);
        assert.equal(f.highlights.has("annotations-hover"), false);
        assert.equal(f.container.querySelector('.annotations-comment[data-focused="true"]'), null);
        assert.equal(f.container.querySelector('.annotations-comment[data-hovered="true"]'), null);
        assert.ok(replyEditor(f).form.closest("[hidden]"));
        assert.notEqual(f.document.activeElement, replyEditor(f).textarea);
        assert.equal(JSON.parse(f.stored()).focusedKey, null);
        assert.equal(JSON.parse(f.stored()).replyDrafts["batch/comment"], "Keep this unfinished reply");
        assert.equal(f.api.hasDrafts(), true);
        await f.poll(); f.layout.flush();
        assert.equal(f.highlights.has("annotations-focus"), false, "polling must not restore the selection");
        assert.equal(openThread(f, "batch/comment", view).textarea.value, "Keep this unfinished reply");
      }
    }
    assert.equal(threadPosts(f).length, 0);
  } finally { f.close(); }
});

test("outside clicks cancel queued editor focus but leave an unfinished root composer intact", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle();
    threadCard(f, "batch/comment").querySelector<HTMLElement>(".annotations-comment-text")!.click();
    assert.ok(f.layout.frames.size, "the editor focus has not run yet");
    pointer(f, "click", 10, 50, f.document.body);
    assert.equal(f.highlights.has("annotations-focus"), false);
    assert.notEqual(f.document.activeElement, replyEditor(f).textarea);
    f.startComment("Keep this unfinished root comment");
    pointer(f, "click", 10, 50, f.root);
    assert.equal(JSON.parse(f.stored()).focusedKey, null);
    assert.equal(JSON.parse(f.stored()).composer.text, "Keep this unfinished root comment");
    assert.equal(f.container.querySelector<HTMLTextAreaElement>('.annotations-composer textarea')!.value, "Keep this unfinished root comment");
    assert.equal(f.highlights.has("annotations-focus"), false);
    assert.equal(f.highlights.get("annotations-draft")!.size, 1);
    assert.equal(f.api.hasDrafts(), true);
  } finally { f.close(); }
});

test("deselecting a pending reply preserves its immutable request and remains deselected after reload", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    openThread(f, "batch/comment"); writeReply(f, "Unconfirmed reply");
    f.state.post = async () => { throw new Error("offline"); };
    submitReply(f); await settle();
    const pending = JSON.parse(f.stored()).threadPending;
    pointer(f, "click", 10, 50, f.document.body);
    assert.deepEqual(JSON.parse(f.stored()).threadPending, pending);
    assert.equal(JSON.parse(f.stored()).focusedKey, null);
    const restored = fixture({ batches: [batch], stored: f.stored() });
    try {
      await settle(); restored.layout.flush();
      assert.equal(restored.container.querySelector('.annotations-comment[data-focused="true"]'), null);
      assert.equal(restored.highlights.has("annotations-focus"), false);
      assert.equal(openThread(restored, "batch/comment").textarea.value, "Unconfirmed reply");
      restored.byText("Retry reply").click(); await settle();
      assert.deepEqual(threadPosts(restored), [pending]);
      assert.equal(JSON.parse(restored.stored()).threadPending, null);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("text selections, drags, and secondary clicks do not dismiss the current thread", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); openThread(f, "batch/comment");
    selectWhole(f.document, f.root);
    pointer(f, "click", 10, 50);
    assert.equal(threadCard(f, "batch/comment").dataset.focused, "true");
    f.document.getSelection()!.removeAllRanges();
    pointer(f, "pointerdown", 10, 50, f.root, 1);
    pointer(f, "pointermove", 100, 50, f.root, 1);
    pointer(f, "pointerup", 100, 50);
    pointer(f, "click", 100, 50);
    assert.equal(threadCard(f, "batch/comment").dataset.focused, "true");
    pointer(f, "pointerdown", 10, 50);
    f.root.dispatchEvent(new f.window.MouseEvent("click", { bubbles: true, button: 2, clientX: 10, clientY: 50 }));
    assert.equal(threadCard(f, "batch/comment").dataset.focused, "true");
  } finally { f.close(); }
});

test("reply headers use Agent or You plus datetime, with matching typography and the agent accent color", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")], true);
  batch.replies = [
    { commentId: "comment", author: "Review: comments-preview · Dashboard annotations", text: "Legacy answer", createdAt: 2 },
    { id: "new", commentId: "comment", author: "Planning: a long session name", role: "agent", text: "New answer", createdAt: 3 },
    { id: "user", commentId: "comment", author: "User metadata", role: "user", delivered: true, text: "A follow-up", createdAt: 4 },
  ];
  const f = fixture({ batches: [batch] });
  try {
    const style = f.document.createElement("style");
    style.textContent = await readFile(new URL("../src/lib/annotations/annotations.css", import.meta.url), "utf8");
    f.document.head.append(style);
    await settle();
    for (const view of ["local", "global"] as const) {
      f.api.setView(view);
      const card = threadCard(f, "batch/comment", view);
      const names = card.querySelectorAll<HTMLElement>(".annotations-reply .annotations-comment-meta strong");
      assert.deepEqual([...names].map((name) => name.textContent), ["Agent", "Agent", "You"]);
      for (const [index, name] of [...names].entries()) {
        assert.deepEqual([...name.parentElement!.children].map((node) => node.tagName), ["STRONG", "TIME"]);
        assert.equal(name.nextElementSibling!.getAttribute("datetime"), new Date(index + 2).toISOString());
        assert.equal(name.classList.contains("annotations-author-agent"), index < 2);
        const rootStyle = f.window.getComputedStyle(card.querySelector<HTMLElement>(".annotations-comment-meta strong")!);
        const nameStyle = f.window.getComputedStyle(name);
        assert.equal(nameStyle.fontSize, rootStyle.fontSize);
        assert.equal(nameStyle.fontWeight, rootStyle.fontWeight);
      }
      assert.doesNotMatch(card.textContent!, /Review:|Planning:|User metadata|Dashboard annotations/);
    }
    const accentRule = [...style.sheet!.cssRules].find((rule) =>
      "selectorText" in rule && rule.selectorText === ".annotations-comment-meta .annotations-author-agent") as CSSStyleRule;
    assert.match(accentRule.style.color, /var\(--accent,/);
  } finally { f.close(); }
});

function editorKey(f: Fixture, target: HTMLElement, init: KeyboardEventInit) {
  const event = new f.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event); f.layout.flush(); return event;
}

test("collapsed threads count the messages between the root and latest reply, and the indicator expands them", async () => {
  const css = await readFile(new URL("../src/lib/annotations/annotations.css", import.meta.url), "utf8");
  for (const count of [0, 1, 2, 4]) {
    const batch = savedBatch("batch", 1, [savedComment("comment")]);
    batch.replies = Array.from({ length: count }, (_, index) => ({
      id: `reply-${index}`, commentId: "comment", author: "Agent", text: `Message ${index}`, createdAt: index + 2,
    }));
    const f = fixture({ batches: [batch] });
    try {
      const style = f.document.createElement("style"); style.textContent = css; f.document.head.append(style);
      await settle();
      const card = threadCard(f, "batch/comment");
      const replies = [...card.querySelectorAll<HTMLElement>(".annotations-reply")];
      const visible = () => replies.filter((node) => f.window.getComputedStyle(node).display !== "none");
      const indicator = card.querySelector<HTMLButtonElement>(".annotations-hidden-messages");
      assert.equal(visible().length, Math.min(count, 1));
      if (count <= 1) assert.equal(indicator, null, "no hidden-message claim when nothing is omitted");
      else {
        assert.ok(indicator);
        const label = `${count - 1} hidden message${count === 2 ? "" : "s"}`;
        assert.equal(indicator.textContent, label);
        assert.equal(indicator.getAttribute("aria-label"), `Show ${label}`);
        assert.equal(indicator.hidden, false);
        assert.notEqual(f.window.getComputedStyle(indicator).display, "none");
        assert.equal(indicator.previousElementSibling!.className, "annotations-comment-text");
        assert.ok(indicator.compareDocumentPosition(replies.at(-1)!) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
        indicator.click(); f.layout.flush();
        assert.equal(card.dataset.focused, "true");
        assert.equal(indicator.hidden, true);
        assert.equal(f.window.getComputedStyle(indicator).display, "none");
        assert.equal(visible().length, count);
        assert.equal(f.document.activeElement, replyEditor(f).textarea);
        card.querySelector<HTMLButtonElement>(".annotations-expand")!.click(); f.layout.flush();
        assert.equal(indicator.hidden, false);
        assert.equal(visible().length, 1);
      }
      f.api.setView("global");
      const global = threadCard(f, "batch/comment", "global");
      assert.equal(global.querySelector(".annotations-hidden-messages"), null, "the global view shows the full history");
      for (const reply of global.querySelectorAll(".annotations-reply")) assert.notEqual(f.window.getComputedStyle(reply).display, "none");
    } finally { f.close(); }
  }
});

test("hidden-message counts follow incoming replies and remain hidden while the thread is expanded", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const appendReply = () => batch.replies.push({ commentId: "comment", author: "Agent", text: "Answer", createdAt: batch.replies.length + 2 });
  appendReply(); appendReply();
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    const indicator = () => threadCard(f, "batch/comment").querySelector<HTMLButtonElement>(".annotations-hidden-messages")!;
    assert.equal(indicator().textContent, "1 hidden message");
    appendReply(); await f.poll();
    assert.equal(indicator().textContent, "2 hidden messages");
    openThread(f, "batch/comment"); writeReply(f, "Unfinished reply");
    appendReply(); await f.poll(); f.layout.flush();
    assert.equal(indicator().textContent, "3 hidden messages");
    assert.equal(indicator().hidden, true);
    assert.equal(replyEditor(f).textarea.value, "Unfinished reply");
    pointer(f, "click", 10, 50, f.document.body);
    assert.equal(indicator().hidden, false);
  } finally { f.close(); }
});

test("Ctrl+Enter and Cmd+Enter add or save root drafts in either view without sending the batch", async () => {
  for (const view of ["local", "global"] as const) for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const f = fixture();
    try {
      await settle(); f.api.setView(view); f.startComment("A new comment");
      const textarea = f.container.querySelector<HTMLTextAreaElement>('.annotations-composer textarea')!;
      assert.equal(f.byText("Add to drafts").getAttribute("aria-keyshortcuts"), "Control+Enter Meta+Enter");
      assert.equal(editorKey(f, textarea, modifiers).defaultPrevented, true);
      const saved = JSON.parse(f.stored()).drafts[0];
      assert.equal(saved.text, "A new comment");
      assert.equal(JSON.parse(f.stored()).composer, null);
      const send = f.byText("Send comments");
      assert.equal(f.document.activeElement, send);
      assert.equal(editorKey(f, send, { ...modifiers, repeat: true }).defaultPrevented, true,
        "holding the shortcut must not activate Send comments after focus moves out of the composer");
      threadCard(f, `draft/${saved.id}`, view).querySelector<HTMLElement>(".annotations-comment-text")!.click();
      textarea.value = "Edited comment"; textarea.dispatchEvent(new f.window.Event("input", { bubbles: true }));
      assert.equal(editorKey(f, textarea, modifiers).defaultPrevented, true);
      assert.deepEqual(JSON.parse(f.stored()).drafts, [{ ...saved, text: "Edited comment" }]);
      assert.equal(f.calls.filter((call) => call.method === "POST").length, 0, "the shortcut follows Add/Save draft, not Send comments");
    } finally { f.close(); }
  }
});

test("Ctrl+Enter and Cmd+Enter send a reply once from either view", async () => {
  for (const view of ["local", "global"] as const) for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
    try {
      await settle(); openThread(f, "batch/comment", view);
      const { textarea } = writeReply(f, "  Reply from the keyboard  ");
      assert.equal(f.byText("Send reply").getAttribute("aria-keyshortcuts"), "Control+Enter Meta+Enter");
      assert.equal(editorKey(f, textarea, modifiers).defaultPrevented, true);
      editorKey(f, textarea, { ...modifiers, repeat: true });
      await settle();
      const posts = threadPosts(f);
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.action === "reply" && posts[0]!.text, "Reply from the keyboard");
      assert.equal(f.api.hasDrafts(), false);
      assert.equal(replyEditor(f).textarea.value, "");
    } finally { f.close(); }
  }
});

test("submission shortcuts preserve plain Enter, IME input, and disabled or hidden editors", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); openThread(f, "batch/comment");
    const { textarea } = writeReply(f, "Do not send yet");
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, altKey: true },
      { ctrlKey: true, isComposing: true }, { metaKey: true, keyCode: 229 }]) {
      assert.equal(editorKey(f, textarea, modifiers).defaultPrevented, false);
    }
    assert.equal(editorKey(f, textarea, { ctrlKey: true, repeat: true }).defaultPrevented, true);
    assert.equal(threadPosts(f).length, 0);
    for (const text of ["   ", "x".repeat(8001)]) {
      writeReply(f, text);
      assert.equal(f.byText("Send reply").disabled, true);
      editorKey(f, textarea, { metaKey: true });
    }
    writeReply(f, "Keep this draft");
    f.state.data.recipient = null; await f.poll();
    editorKey(f, textarea, { ctrlKey: true });
    assert.equal(threadPosts(f).length, 0);
    f.state.data.recipient = active(); await f.poll();
    pointer(f, "click", 10, 50, f.document.body);
    editorKey(f, textarea, { ctrlKey: true });
    assert.equal(threadPosts(f).length, 0, "a parked editor cannot submit");
    assert.equal(JSON.parse(f.stored()).replyDrafts["batch/comment"], "Keep this draft");
    assert.equal(editorKey(f, f.document.body, { ctrlKey: true }).defaultPrevented, false, "the shortcut is editor-scoped");
  } finally { f.close(); }
});

test("the shortcut can retry from the focused reply button without changing the pending request", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); openThread(f, "batch/comment");
    const { textarea } = writeReply(f, "Retry this reply");
    const success = f.state.post;
    f.state.post = async () => { throw new Error("offline"); };
    editorKey(f, textarea, { ctrlKey: true }); await settle();
    const pending = threadPosts(f)[0];
    assert.equal(textarea.disabled, true);
    editorKey(f, textarea, { ctrlKey: true });
    assert.equal(threadPosts(f).length, 1, "disabled input cannot trigger another request");
    f.state.post = success;
    const retry = f.byText("Retry reply"); retry.focus();
    editorKey(f, retry, { metaKey: true }); await settle();
    assert.deepEqual(threadPosts(f), [pending, pending]);
    assert.equal(f.api.hasDrafts(), false);
  } finally { f.close(); }
});

test("the global sidebar orders each thread by newest root or reply activity, with drafts last", async () => {
  const first = savedBatch("first", 10, [savedComment("first-b"), savedComment("first-a")], true);
  first.replies.push({ commentId: "first-a", author: "Author", text: "Answer", createdAt: 40 });
  const latest = savedBatch("latest", 30, [savedComment("latest", { documentId: "review/other", revision: "stale" })]);
  const middle = savedBatch("middle", 20, [savedComment("middle")]);
  const f = fixture({ batches: [latest, middle, first], stored: storedDrafts(2) });
  try {
    await settle();
    const list = f.global.querySelector(".annotations-global-list")!;
    assert.ok(list);
    const expected = ["first-a", "latest", "middle", "first-b", "draft-0", "draft-1"];
    assert.deepEqual(commentIds(list, ".annotations-comment"), expected);
    assert.equal(list.children.length, expected.length, "batch wrapper elements must not surround the comments");
    for (const child of list.children) assert.ok(child.matches(".annotations-comment"));
    assert.deepEqual([...list.querySelectorAll(".annotations-state")].map((node) => node.textContent), ["Replied", "Pending", "Pending", "Delivered", "Draft", "Draft"]);
    assert.equal(list.querySelectorAll(".annotations-quote-button").length, expected.length);
    assert.equal(f.global.querySelector(".annotations-batch, .annotations-batches, select"), null);
    assert.doesNotMatch(list.textContent!, /previous-session|Recipient one/);
    const quote = list.querySelector<HTMLButtonElement>('[data-comment-id="latest"] .annotations-quote-button')!;
    quote.click();
    assert.deepEqual(f.navigations, ["review/other"]);
  } finally { f.close(); }
});

test("the margin contains only current-document bubbles with valid anchors; stale comments remain global", async () => {
  const comments = [savedComment("valid"), savedComment("other", { documentId: "review/other" }),
    savedComment("revision", { revision: "stale" }), savedComment("quote", { quote: "wrong quote" }),
    savedComment("offset", { end: 500 })];
  const f = fixture({ batches: [savedBatch("mixed", 1, comments)] });
  try {
    await settle(); f.layout.flush();
    assert.deepEqual(commentIds(f.margin, ".annotations-bubbles > .annotations-bubble"), ["valid"]);
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), comments.map((comment) => comment.id).sort());
    f.api.setDocument({ id: "review/other", title: "Other", root: f.root });
    f.layout.flush();
    assert.deepEqual(commentIds(f.margin, ".annotations-bubbles > .annotations-bubble"), ["other"], "identical text in another document must not attach its comments here");
    f.root.innerHTML = "<p>Changed text</p>";
    f.api.setDocument(reader(f.document));
    f.layout.flush();
    assert.deepEqual(commentIds(f.margin, ".annotations-bubbles > .annotations-bubble"), []);
    assert.equal(f.global.querySelectorAll(".annotations-comment").length, comments.length);
    f.api.setDocument(null); f.layout.flush();
    assert.deepEqual(commentIds(f.margin, ".annotations-bubbles > .annotations-bubble"), []);
  } finally { f.close(); }
});

test("bubbles align with the first quote rectangle and nearby quotes do not overlap", async () => {
  const alpha = savedComment("alpha", { start: 0, end: 5, quote: "Alpha" });
  const beta = savedComment("beta", { start: 6, end: 10, quote: "beta" });
  const f = fixture({ batches: [savedBatch("adjacent", 1, [beta, alpha])] });
  try {
    f.layout.bounds.marginTop = 130;
    f.layout.quoteRects.set("Alpha", [{ top: 400 }, { top: 430 }]);
    f.layout.quoteRects.set("beta", [{ top: 410 }]);
    f.layout.bubbleHeights.set("alpha", 100);
    f.layout.bubbleHeights.set("beta", 120);
    await settle(); f.layout.flush();
    const first = f.margin.querySelector<HTMLElement>('.annotations-bubble[data-comment-id="alpha"]')!;
    const second = f.margin.querySelector<HTMLElement>('.annotations-bubble[data-comment-id="beta"]')!;
    assert.ok(first); assert.ok(second);
    assert.equal(first.getBoundingClientRect().top, 400, "use the first text rectangle, not the whole paragraph or multiline midpoint");
    assert.ok(second.getBoundingClientRect().top >= first.getBoundingClientRect().bottom, "adjacent quote bubbles must not overlap");
    const before = second.getBoundingClientRect().top;
    f.layout.bubbleHeights.set("alpha", 180);
    f.layout.observeResize(); f.layout.flush();
    assert.ok(second.getBoundingClientRect().top > before, "bubble height changes must move later bubbles down");
    assert.ok(second.getBoundingClientRect().top >= first.getBoundingClientRect().bottom);
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["alpha", "beta"], "equal-activity threads keep deterministic global ordering");
  } finally { f.close(); }
});

test("scrolling and resizing recompute bubble offsets from the range and rail rectangles", async () => {
  const f = fixture({ batches: [savedBatch("one", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    const bubble = () => f.margin.querySelector<HTMLElement>(".annotations-bubbles > .annotations-bubble")!;
    assert.equal(bubble().getBoundingClientRect().top, 400);
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 270 }]);
    f.layout.bounds.marginTop = 20;
    f.layout.scroll(); f.layout.flush();
    assert.equal(bubble().getBoundingClientRect().top, 270);
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 500 }]);
    f.layout.bounds.marginTop = 60;
    f.layout.bounds.width = 240;
    f.layout.resize(); f.layout.flush();
    assert.equal(bubble().getBoundingClientRect().top, 500);
  } finally { f.close(); }
});

test("element resize and font loading update bubble geometry and observers are removed on destroy", async () => {
  const f = fixture({ batches: [savedBatch("one", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    assert.ok(f.layout.resizeObservers.size > 0, "observe reader and bubble size changes");
    const observed = new Set([...f.layout.resizeObservers].flatMap((observer) => [...observer.targets]));
    assert.ok(observed.has(f.root), "observe reader reflow");
    assert.ok(observed.has(f.margin), "observe margin width and content changes");
    const bubbleTop = () => f.margin.querySelector<HTMLElement>(".annotations-bubbles > .annotations-bubble")!.getBoundingClientRect().top;
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 440 }]);
    f.layout.observeResize(); f.layout.flush();
    assert.equal(bubbleTop(), 440);
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 480 }]);
    f.layout.fontsReady(); await settle(); f.layout.flush();
    assert.equal(bubbleTop(), 480);
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 520 }]);
    f.layout.fontsLoaded(); f.layout.flush();
    assert.equal(bubbleTop(), 520);
    f.layout.resize();
    f.api.destroy();
    assert.equal(f.layout.frames.size, 0);
    assert.equal(f.layout.resizeObservers.size, 0);
    f.layout.resize(); f.layout.scroll(); f.layout.fontsLoaded();
    assert.equal(f.layout.frames.size, 0, "destroy removes all geometry update listeners");
  } finally { f.close(); }
});

test("empty quote rectangles stay hidden instead of attaching a bubble to invented coordinates", async () => {
  const f = fixture({ batches: [savedBatch("one", 1, [savedComment("comment")])] });
  try {
    f.layout.quoteRects.set("Alpha beta gamma", []);
    await settle(); f.layout.flush();
    const bubble = f.margin.querySelector<HTMLElement>(".annotations-bubbles > .annotations-bubble")!;
    assert.equal(bubble.hidden, true);
    assert.equal(f.global.querySelectorAll(".annotations-comment").length, 1);
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 250 }]);
    f.root.dispatchEvent(new f.window.Event("toggle", { bubbles: true }));
    f.layout.flush();
    assert.equal(bubble.hidden, false);
    assert.equal(bubble.getBoundingClientRect().top, 250);
  } finally { f.close(); }
});

test("reader mutations invalidate and restore bubbles without a navigation call", async () => {
  const f = fixture({ batches: [savedBatch("one", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    assert.equal(f.margin.querySelectorAll(".annotations-bubbles > .annotations-bubble").length, 1);
    const original = f.root.innerHTML;
    f.root.innerHTML = "<p>Changed after render</p>";
    await settle(); f.layout.flush();
    assert.equal(f.margin.querySelectorAll(".annotations-bubbles > .annotations-bubble").length, 0);
    assert.equal(f.highlights.has("annotations-saved"), false);
    assert.equal(f.global.querySelectorAll(".annotations-comment").length, 1);
    f.root.innerHTML = original;
    await settle(); f.layout.flush();
    assert.equal(f.margin.querySelectorAll(".annotations-bubbles > .annotations-bubble").length, 1);
    assert.equal(f.highlights.get("annotations-saved")!.size, 1);
  } finally { f.close(); }
});

test("narrow screens switch bubbles to stacked flow and desktop resize restores quote alignment", async () => {
  const f = fixture({ batches: [savedBatch("one", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    const rail = f.margin.querySelector<HTMLElement>(".annotations-rail")!;
    const bubble = f.margin.querySelector<HTMLElement>(".annotations-bubbles > .annotations-bubble")!;
    assert.equal(rail.hasAttribute("data-positioned"), true);
    assert.notEqual(bubble.style.top, "");
    f.layout.bounds.mobile = true;
    f.layout.resize(); f.layout.flush();
    assert.equal(rail.hasAttribute("data-positioned"), false);
    assert.equal(bubble.style.top, "");
    assert.equal(rail.style.minHeight, "");
    assert.equal(bubble.hidden, false);
    f.layout.bounds.mobile = false;
    f.layout.resize(); f.layout.flush();
    assert.equal(rail.hasAttribute("data-positioned"), true);
    assert.equal(bubble.getBoundingClientRect().top, 400);
  } finally { f.close(); }
});

test("the margin composer stays visible with a safe fallback when its quote is offscreen or in another section", async () => {
  const f = fixture();
  try {
    await settle();
    f.startComment("Keep this text while navigating"); f.layout.flush();
    const composer = f.margin.querySelector<HTMLElement>(".annotations-composer")!;
    const assertVisible = () => {
      assert.equal(composer.hidden, false);
      assert.notEqual(composer.style.display, "none");
      assert.ok(composer.getBoundingClientRect().top >= 0);
      assert.ok(composer.getBoundingClientRect().top < f.window.innerHeight);
      assert.equal(f.margin.querySelector("textarea")!.value, "Keep this text while navigating");
    };
    assertVisible();
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: -300 }]);
    f.layout.scroll(); f.layout.flush(); assertVisible();
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: f.window.innerHeight + 300 }]);
    f.layout.scroll(); f.layout.flush(); assertVisible();
    f.api.setDocument({ id: "review/another", title: "Another", root: f.root });
    f.layout.flush(); assertVisible();
    assert.equal(f.margin.querySelectorAll(".annotations-bubbles > .annotations-bubble").length, 0);
    f.api.setDocument(null); f.layout.flush(); assertVisible();
    assert.deepEqual(JSON.parse(f.stored()).composer.text, "Keep this text while navigating");
  } finally { f.close(); }
});

test("a detached composer does not pull saved bubbles away from offscreen quotes", async () => {
  const comment = savedComment("saved-beta", { start: 6, end: 10, quote: "beta" });
  const f = fixture({ batches: [savedBatch("offscreen", 1, [comment])] });
  try {
    await settle();
    f.startComment("Keep editing while the page scrolls");
    f.layout.bounds.marginTop = -800;
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: -400 }]);
    f.layout.quoteRects.set("beta", [{ top: -300 }]);
    f.layout.scroll(); f.layout.flush();
    const composer = f.margin.querySelector<HTMLElement>(".annotations-composer")!;
    const bubble = f.margin.querySelector<HTMLElement>('.annotations-bubbles [data-comment-id="saved-beta"]')!;
    assert.equal(composer.hasAttribute("data-detached"), true);
    assert.ok(composer.getBoundingClientRect().top >= 0);
    assert.equal(bubble.getBoundingClientRect().top, -300, "saved comments stay with their quote, not the floating editor");
  } finally { f.close(); }
});

test("selection quotes allow 16,000 characters but reject longer selections visibly", async () => {
  const f = fixture({ html: `<p>${"q".repeat(16001)}</p>` });
  try {
    await settle();
    selectWhole(f.document, f.root);
    assert.equal(captureSelection(reader(f.document)), null);
    f.document.dispatchEvent(new f.window.Event("selectionchange"));
    assert.equal(f.byText("Add comment").disabled, true);
    assert.match(f.container.textContent!, /Select at most 16,000 characters/);
    const text = f.root.querySelector("p")!.firstChild!;
    select(f.document, text, 0, text, 16000);
    assert.equal(captureSelection(reader(f.document)).quote.length, 16000);
    f.document.dispatchEvent(new f.window.Event("selectionchange"));
    assert.equal(f.byText("Add comment").disabled, false);
  } finally { f.close(); }
});

test("textarea and submit guards enforce 8,000 characters without losing composer text", async () => {
  const f = fixture();
  try {
    await settle();
    f.startComment("x".repeat(8001));
    const textarea = f.container.querySelector("textarea")!;
    assert.equal(textarea.maxLength, 8000);
    assert.equal(f.byText("Add to drafts").disabled, true);
    assert.match(f.container.textContent!, /at most 8,000 characters/);
    f.container.querySelector("form")!.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
    assert.equal(JSON.parse(f.stored()).drafts.length, 0);
    assert.equal(JSON.parse(f.stored()).composer.text.length, 8001);
    textarea.value = "x".repeat(8000);
    textarea.dispatchEvent(new f.window.Event("input", { bubbles: true }));
    assert.equal(f.byText("Add to drafts").disabled, false);
    f.container.querySelector("form")!.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
    assert.equal(JSON.parse(f.stored()).drafts[0].text.length, 8000);
  } finally { f.close(); }
});

test("50 drafts prevent another addition but can be sent as one batch", async () => {
  const stored = JSON.parse(storedDrafts(50));
  stored.composer = { ...stored.drafts[0], id: "extra", text: "Keep this composer" };
  const f = fixture({ stored: JSON.stringify(stored) });
  try {
    await settle();
    assert.equal(f.byText("Add comment").disabled, true);
    assert.equal(f.byText("Add to drafts").disabled, true);
    assert.match(f.container.textContent!, /Draft limit reached \(50\)/);
    f.container.querySelector("form")!.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
    assert.equal(JSON.parse(f.stored()).drafts.length, 50);
    assert.equal(JSON.parse(f.stored()).composer.text, "Keep this composer");
    f.byText("Send comments").click();
    await settle();
    assert.equal(JSON.parse(f.calls.find((call) => call.method === "POST")!.body!).comments.length, 50);
    assert.equal(JSON.parse(f.stored()).drafts.length, 0);
    assert.equal(f.byText("Add to drafts").disabled, false);
  } finally { f.close(); }
});

test("oversized persisted drafts are rejected before creating or freezing a request", async () => {
  for (const stored of [storedDrafts(51), storedDrafts(1, "x".repeat(8001)), storedDrafts(1, "Comment", { quote: "q".repeat(16001) })]) {
    const f = fixture({ stored });
    try {
      await settle();
      f.byText("Send comments").click();
      await settle();
      assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
      assert.equal(JSON.parse(f.stored()).pending, null);
      assert.equal(f.byText("Delete draft").disabled, false);
      assert.equal(f.container.querySelector("select"), null);
      assert.equal(f.api.hasDrafts(), true);
      assert.match(f.container.textContent!, /at most/);
    } finally { f.close(); }
  }
});

test("the 256 KiB body guard measures UTF-8 bytes and leaves drafts adjustable", async () => {
  const f = fixture({ stored: storedDrafts(12, "界".repeat(8000)) });
  try {
    await settle();
    const drafts = JSON.parse(f.stored()).drafts;
    const proposed = JSON.stringify({ id: "12345678-1234-4234-8234-123456789012", comments: drafts });
    assert.ok(proposed.length < 256 * 1024, "UTF-16 string length would incorrectly permit this body");
    assert.ok(Buffer.byteLength(proposed, "utf8") > 256 * 1024);
    f.byText("Send comments").click();
    await settle();
    assert.match(f.container.textContent!, /256 KiB request limit/);
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
    assert.equal(JSON.parse(f.stored()).pending, null);
    assert.equal(f.byText("Delete draft").disabled, false);
    assert.equal(f.container.querySelector("select"), null);
    for (let i = 0; i < 4; i++) f.byText("Delete draft").click();
    f.byText("Send comments").click();
    await settle();
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(f.api.hasDrafts(), false);
  } finally { f.close(); }
});

test("definitive 400, 413, and 415 rejections unlock drafts and composer, including non-JSON errors", async () => {
  for (const status of [400, 413, 415]) {
    const f = fixture();
    try {
      await settle();
      f.addDraft();
      f.startComment("Unfinished second comment");
      const success = f.state.post;
      f.state.post = async () => new Response(status === 413 ? "Payload too large" : JSON.stringify({ error: "Rejected input" }), { status });
      f.byText("Send comments").click();
      await settle();
      assert.equal(f.api.hasDrafts(), true);
      assert.equal(JSON.parse(f.stored()).pending, null);
      assert.equal(JSON.parse(f.stored()).drafts.length, 1);
      assert.equal(f.byText("Delete draft").disabled, false);
      assert.equal(f.container.querySelector("select"), null);
      const textarea = f.container.querySelector("textarea")!;
      assert.equal(textarea.disabled, false);
      assert.match(f.container.textContent!, /Comments were rejected/);
      assert.doesNotMatch(f.container.textContent!, /Delivery is unconfirmed/);
      textarea.value = "Revised second comment";
      textarea.dispatchEvent(new f.window.Event("input", { bubbles: true }));
      f.container.querySelector("form")!.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
      f.state.post = success;
      f.byText("Send comments").click();
      await settle();
      const posts = f.calls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!));
      assert.notEqual(posts[0].id, posts[1].id);
      assert.equal(posts[1].comments[1].text, "Revised second comment");
      assert.equal(f.api.hasDrafts(), false);
    } finally { f.close(); }
  }
});

test("503 failures keep immutable pending requests and retry the identical body", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    const success = f.state.post;
    f.state.post = async () => new Response(JSON.stringify({ error: "Try later" }), { status: 503 });
    f.byText("Send comments").click();
    await settle();
    assert.ok(JSON.parse(f.stored()).pending);
    assert.equal(f.byText("Delete draft").disabled, true);
    assert.equal(f.container.querySelector("select"), null);
    f.state.data.recipient = active("two");
    await f.poll();
    f.state.post = success;
    f.byText("Retry Send comments").click();
    await settle();
    const posts = f.calls.filter((call) => call.method === "POST");
    assert.equal(posts[0]!.body, posts[1]!.body);
    assert.equal(f.api.hasDrafts(), false);
  } finally { f.close(); }
});

test("reply states belong to individual comments and ignore replies for unknown IDs", async () => {
  const f = fixture({ stored: storedDrafts(2) });
  try {
    await settle();
    f.byText("Send comments").click();
    await settle();
    const batch = f.state.data.batches[0]!;
    const reply = { commentId: batch.comments[0]!.id, text: "First answer", author: "Reader", createdAt: 1 };
    batch.replies.push(reply, { ...reply, text: "Additional answer" }, { ...reply, commentId: "unknown" });
    await f.poll();
    assert.deepEqual([...f.global.querySelectorAll(".annotations-state")].map((node) => node.textContent), ["Replied", "Pending"]);
    assert.equal(f.global.querySelector(".annotations-batch"), null);
    const comments = f.global.querySelectorAll(".annotations-global-list .annotations-comment");
    assert.equal(comments[0]!.querySelectorAll(".annotations-reply").length, 2);
    assert.equal(comments[1]!.querySelectorAll(".annotations-reply").length, 0);
    batch.replies.push({ ...reply, commentId: batch.comments[1]!.id });
    await f.poll();
    assert.deepEqual([...f.global.querySelectorAll(".annotations-state")].map((node) => node.textContent), ["Replied", "Replied"]);
  } finally { f.close(); }
});

test("heartbeat-only updates preserve focused global-comment controls", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    f.byText("Send comments").click();
    await settle();
    const quote = f.global.querySelector<HTMLButtonElement>(".annotations-quote-button")!;
    quote.focus();
    f.state.data.recipient = { ...f.state.data.recipient!, updatedAt: 100 };
    await f.poll();
    assert.equal(f.document.activeElement, quote);
    assert.equal(f.global.querySelector(".annotations-quote-button"), quote);
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Comments go to: Recipient one/);
    assert.equal(f.container.querySelector("select"), null);
  } finally { f.close(); }
});

test("legacy explicit recipient choices are ignored while drafts and composer migrate to version 3", async () => {
  const stored = JSON.parse(storedDrafts(1, "Legacy draft"));
  stored.version = 1;
  stored.recipient = { ...active("legacy"), resume: "private-legacy-session" };
  stored.explicitRecipient = true;
  stored.composer = { ...stored.drafts[0], id: "unfinished", text: "Legacy composer" };
  const f = fixture({ stored: JSON.stringify(stored), recipient: active("current") });
  try {
    await settle();
    const migrated = JSON.parse(f.stored());
    assert.equal(migrated.version, 3);
    for (const key of ["recipient", "recipientId", "explicitRecipient"]) assert.equal(key in migrated, false);
    assert.equal(migrated.threadPending, null);
    assert.deepEqual(migrated.drafts, stored.drafts);
    assert.deepEqual(migrated.composer, stored.composer);
    assert.equal(f.margin.querySelector("textarea")!.value, "Legacy composer");
    assert.match(f.margin.querySelector(".annotations-target")!.textContent!, /Comments go to: Recipient current/);
    assert.doesNotMatch(f.container.textContent!, /Recipient legacy|private-legacy-session/);
    assert.equal(f.container.querySelector("select"), null);
  } finally { f.close(); }
});

test("legacy pending retries preserve the request ID and comments but remove client routing metadata", async () => {
  const stored = JSON.parse(storedDrafts(1, "Legacy pending comment"));
  stored.version = 1;
  stored.recipient = active("legacy");
  stored.explicitRecipient = true;
  stored.pending = { id: "old-request-id", recipientId: "legacy", comments: stored.drafts };
  const f = fixture({ stored: JSON.stringify(stored), recipient: active("current") });
  try {
    await settle();
    const expected = { id: "old-request-id", comments: stored.drafts };
    assert.deepEqual(JSON.parse(f.stored()).pending, expected);
    assert.equal(JSON.parse(f.stored()).version, 3);
    assert.equal(f.byText("Delete draft").disabled, true);
    f.byText("Retry Send comments").click();
    await settle();
    assert.deepEqual(JSON.parse(f.calls.find((call) => call.method === "POST")!.body!), expected);
    assert.equal(f.state.data.batches[0]!.recipientId, "current");
    assert.equal(f.api.hasDrafts(), false);
  } finally { f.close(); }
});

test("source quotes, comments, and recipient labels render as plain text in both panels", async () => {
  const quote = '<img src=x onerror="alert(1)">';
  const text = "<script>unsafe()</script>";
  const f = fixture({ html: `<p>&lt;img src=x onerror="alert(1)"&gt;</p>`, recipient: { ...active(), label: "<b>Session</b>" } });
  try {
    await settle();
    f.addDraft(text); f.layout.flush();
    for (const host of [f.global, f.margin]) {
      assert.equal(host.querySelector(".annotations-comment-text")!.textContent, text);
      assert.ok(host.querySelector(".annotations-quote-button")!.textContent!.includes(quote));
      assert.equal(host.querySelector("script, img, b"), null);
    }
    assert.equal(f.margin.querySelector(".annotations-target")!.textContent, "Comments go to: <b>Session</b>");
    assert.equal(f.root.querySelector("img"), null);
  } finally { f.close(); }
});

test("unsupported native highlights still permit selections and quoted comments", async () => {
  const f = fixture({ highlights: false });
  try {
    await settle();
    f.addDraft();
    assert.equal(f.api.hasDrafts(), true);
    assert.match(f.container.textContent!, /shows quotes without highlights/);
    assert.match(f.container.textContent!, /Alpha beta gamma/);
  } finally { f.close(); }
});

test("destroy removes polling, selection listeners, highlights, UI, and pending requests", async () => {
  const f = fixture();
  try {
    await settle();
    f.addDraft();
    f.state.post = () => new Promise(() => {});
    f.byText("Send comments").click();
    const request = f.calls.find((call) => call.method === "POST")!;
    const oldAdd = f.byText("Add comment");
    const removed: string[] = [];
    const remove = f.document.removeEventListener.bind(f.document);
    f.document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removed.push(type); remove(type, listener, options);
    }) as typeof f.document.removeEventListener;
    f.api.destroy();
    assert.equal(request.signal!.aborted, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.highlights.size, 0);
    assert.equal(f.global.childNodes.length, 0);
    assert.equal(f.margin.childNodes.length, 0);
    for (const type of ["keyup", "pointerup", "selectionchange", "visibilitychange"]) assert.ok(removed.includes(type), `Missing cleanup for ${type}`);
    const stored = f.stored();
    oldAdd.click();
    f.document.dispatchEvent(new f.window.Event("selectionchange"));
    f.api.setDocument(reader(f.document));
    f.api.destroy();
    f.layout.fontsReady(); await settle();
    assert.equal(f.layout.frames.size, 0);
    assert.equal(f.stored(), stored);
  } finally { f.close(); }
});

test("local and global views are exclusive and move the same toolbar and unfinished root composer", async () => {
  const f = fixture();
  try {
    await settle();
    assert.equal(f.margin.hidden, false);
    assert.equal(f.global.hidden, true);
    f.startComment("Keep this unfinished root comment");
    const toolbar = f.margin.querySelector(".annotations-toolbar")!;
    const composer = f.margin.querySelector<HTMLFormElement>(".annotations-composer")!;
    const textarea = composer.querySelector("textarea")!;
    const stored = f.stored();
    f.api.setView("global");
    assert.equal(f.margin.hidden, true);
    assert.equal(f.global.hidden, false);
    assert.equal(f.global.querySelector(".annotations-toolbar"), toolbar);
    assert.equal(f.global.querySelector(".annotations-composer"), composer);
    assert.equal(textarea.value, "Keep this unfinished root comment");
    for (const label of ["Add comment", "Add to drafts", "Send comments"]) assert.ok(f.global.contains(f.byText(label)));
    assert.equal(f.container.querySelectorAll(".annotations-toolbar").length, 1);
    assert.equal(f.container.querySelectorAll(".annotations-composer").length, 1);
    f.api.setView("local");
    assert.equal(f.margin.hidden, false);
    assert.equal(f.global.hidden, true);
    assert.equal(f.margin.querySelector(".annotations-toolbar"), toolbar);
    assert.equal(f.margin.querySelector(".annotations-composer"), composer);
    assert.equal(f.stored(), stored, "changing views does not change unfinished text");
  } finally { f.close(); }
});

test("clicking the card body opens and focuses one shared reply editor in either view", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("one"), savedComment("two")])] });
  try {
    await settle();
    const first = openThread(f, "batch/one");
    assert.ok(threadCard(f, "batch/one").contains(first.form));
    assert.equal(f.document.activeElement, first.textarea);
    writeReply(f, "A first reply draft");
    f.api.setView("global");
    assert.equal(replyEditor(f).form, first.form);
    assert.ok(threadCard(f, "batch/one", "global").contains(first.form));
    assert.equal(first.textarea.value, "A first reply draft");
    const second = openThread(f, "batch/two", "global");
    assert.equal(second.form, first.form, "switching threads moves rather than duplicates the form");
    assert.equal(second.textarea.value, "");
    assert.equal(f.document.activeElement, second.textarea);
    const again = openThread(f, "batch/one");
    assert.equal(again.textarea.value, "A first reply draft");
    assert.ok(threadCard(f, "batch/one").contains(again.form));
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  } finally { f.close(); }
});

test("thread cards support Enter and Space but ignore keyboard and click events from nested controls", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle();
    for (const view of ["local", "global"] as const) {
      f.api.setView(view);
      for (const key of ["Enter", " "]) {
        const card = threadCard(f, "batch/comment", view);
        assert.equal(card.tabIndex, 0);
        assert.equal(card.getAttribute("role"), "group");
        card.focus();
        const event = new f.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        card.dispatchEvent(event);
        f.layout.flush();
        assert.equal(event.defaultPrevented, true, "keyboard activation prevents Space from scrolling");
        assert.equal(f.document.activeElement, replyEditor(f).textarea);
      }
      const { textarea } = replyEditor(f);
      const before = f.navigations.length;
      textarea.click();
      textarea.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      textarea.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      f.byText("Cancel reply").dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      assert.equal(f.navigations.length, before, "typing and nested button keys do not activate the card");
      assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
    }
  } finally { f.close(); }
});

test("selecting card text does not activate the thread or steal a native selection", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle();
    for (const view of ["local", "global"] as const) {
      f.api.setView(view);
      const text = threadCard(f, "batch/comment", view).querySelector<HTMLElement>(".annotations-comment-text")!;
      const selection = select(f.document, text.firstChild!, 0, text.firstChild!, 5);
      const before = f.navigations.length;
      text.click();
      assert.equal(f.navigations.length, before);
      assert.equal(selection.toString(), "Saved");
      assert.notEqual(f.document.activeElement?.getAttribute("aria-label"), "Reply");
      selection.removeAllRanges();
    }
  } finally { f.close(); }
});

test("clicking an existing root draft edits that draft instead of creating a reply or duplicate", async () => {
  for (const view of ["local", "global"] as const) {
    const f = fixture({ stored: storedDrafts(1, "Original draft") });
    try {
      await settle();
      f.api.setView(view);
      threadCard(f, "draft/draft-0", view).querySelector<HTMLElement>(".annotations-comment-text")!.click();
      f.layout.flush();
      const form = f.container.querySelector<HTMLFormElement>(".annotations-composer")!;
      const textarea = form.querySelector("textarea")!;
      assert.equal(form.hidden, false);
      assert.equal(textarea.value, "Original draft");
      assert.equal(f.document.activeElement, textarea);
      textarea.value = "Edited existing draft";
      textarea.dispatchEvent(new f.window.Event("input", { bubbles: true }));
      form.dispatchEvent(new f.window.Event("submit", { cancelable: true, bubbles: true }));
      const stored = JSON.parse(f.stored());
      assert.equal(stored.drafts.length, 1);
      assert.equal(stored.drafts[0].id, "draft-0");
      assert.equal(stored.drafts[0].text, "Edited existing draft");
      assert.equal(stored.composer, null);
      assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
      assert.equal(f.highlights.get("annotations-draft")!.size, 1);
    } finally { f.close(); }
  }
});

test("reply drafts use batch and comment identity, persist independently, and survive reload", async () => {
  const batches = [savedBatch("older", 1, [savedComment("same")]), savedBatch("newer", 2, [savedComment("same")])];
  const f = fixture({ batches });
  try {
    await settle();
    openThread(f, "older/same"); writeReply(f, "Reply for the older batch");
    openThread(f, "newer/same"); writeReply(f, "Reply for the newer batch");
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(JSON.parse(f.stored()).version, 3);
    const restored = fixture({ batches, stored: f.stored() });
    try {
      await settle();
      assert.equal(restored.api.hasDrafts(), true);
      assert.equal(openThread(restored, "older/same", "global").textarea.value, "Reply for the older batch");
      assert.equal(openThread(restored, "newer/same").textarea.value, "Reply for the newer batch");
      assert.equal(restored.calls.filter((call) => call.method === "POST").length, 0);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("version 2 drafts, composer, and root retry identity migrate intact to version 3", async () => {
  const stored = JSON.parse(storedDrafts(1, "Keep the root draft"));
  stored.composer = { ...stored.drafts[0], id: "unfinished", text: "Keep the composer" };
  stored.pending = { id: "pending-root", comments: stored.drafts };
  const f = fixture({ stored: JSON.stringify(stored) });
  try {
    await settle();
    const migrated = JSON.parse(f.stored());
    assert.equal(migrated.version, 3);
    assert.deepEqual(migrated.drafts, stored.drafts);
    assert.deepEqual(migrated.composer, stored.composer);
    assert.deepEqual(migrated.pending, stored.pending);
    assert.equal(migrated.threadPending, null);
    assert.equal(f.api.hasDrafts(), true);
  } finally { f.close(); }
});

test("hovering quoted text paints a stronger native highlight and marks only its matching cards", async () => {
  const alpha = savedComment("alpha", { start: 0, end: 5, quote: "Alpha" });
  const beta = savedComment("beta", { start: 6, end: 10, quote: "beta" });
  const f = fixture({ batches: [savedBatch("batch", 1, [alpha, beta])] });
  try {
    f.layout.quoteRects.set("Alpha", [{ top: 400 }]);
    f.layout.quoteRects.set("beta", [{ top: 450 }]);
    await settle(); f.layout.flush();
    const html = f.root.innerHTML;
    pointer(f, "pointermove");
    assert.deepEqual([...f.highlights.get("annotations-hover")!].map((range) => range.toString()), ["Alpha"]);
    for (const view of ["local", "global"] as const) {
      assert.equal(threadCard(f, "batch/alpha", view).dataset.hovered, "true");
      assert.equal(threadCard(f, "batch/beta", view).dataset.hovered, "false");
    }
    assert.equal(f.navigations.length, 0, "hover does not navigate or open the reply editor");
    pointer(f, "pointermove", 720, 460);
    assert.deepEqual([...f.highlights.get("annotations-hover")!].map((range) => range.toString()), ["beta"]);
    assert.equal(threadCard(f, "batch/alpha").dataset.hovered, "false");
    assert.equal(threadCard(f, "batch/beta").dataset.hovered, "true");
    pointer(f, "pointermove", 950, 600);
    assert.equal(f.highlights.has("annotations-hover"), false);
    assert.equal(threadCard(f, "batch/beta").dataset.hovered, "false");
    assert.equal(f.root.innerHTML, html, "hover highlights never wrap document text");
  } finally { f.close(); }
});

test("highlight hit testing chooses the smallest overlapping range with deterministic ties", async () => {
  const comments = [savedComment("wide"), savedComment("beta-b", { start: 6, end: 10, quote: "beta" }),
    savedComment("beta-a", { start: 6, end: 10, quote: "beta" })];
  const batch = savedBatch("batch", 1, comments);
  const f = fixture({ batches: [batch] });
  try {
    await settle(); f.layout.flush();
    pointer(f, "pointermove");
    const hovered = () => [...f.margin.querySelectorAll<HTMLElement>('[data-hovered="true"]')].map((node) => node.dataset.threadKey);
    const first = hovered();
    assert.equal(first.length, 1);
    assert.ok(["batch/beta-a", "batch/beta-b"].includes(first[0]!));
    assert.equal(threadCard(f, "batch/wide").dataset.hovered, "false");
    batch.comments.reverse();
    await f.poll(); f.layout.flush();
    pointer(f, "pointermove", 950, 600);
    pointer(f, "pointermove");
    assert.deepEqual(hovered(), first, "input order does not change equal-range hit selection");
    clickHighlight(f);
    assert.ok(threadCard(f, first[0]!).contains(replyEditor(f).form));
    assert.equal(f.document.activeElement, replyEditor(f).textarea);
  } finally { f.close(); }
});

test("hit testing uses individual range rectangles, not gaps in a multiline bounding box", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    f.layout.quoteRects.set("Alpha beta gamma", [{ top: 400, left: 710, width: 60 }, { top: 450, left: 740, width: 80 }]);
    await settle(); f.layout.flush();
    for (const [x, y] of [[720, 435], [800, 410], [700, 460]]) {
      pointer(f, "pointermove", x, y);
      assert.equal(f.highlights.has("annotations-hover"), false);
      clickHighlight(f, x, y);
    }
    assert.equal(f.navigations.length, 0);
    pointer(f, "pointermove", 760, 460);
    assert.equal(f.highlights.get("annotations-hover")!.size, 1);
    clickHighlight(f, 760, 460);
    assert.ok(threadCard(f, "batch/comment").contains(replyEditor(f).form));
    assert.equal(f.document.activeElement, replyEditor(f).textarea);
  } finally { f.close(); }
});

test("stale, resolved, off-document, and empty-geometry anchors never receive pointer focus", async () => {
  const comments = [savedComment("stale", { revision: "stale" }), savedComment("other", { documentId: "review/other" }),
    savedComment("resolved"), savedComment("empty", { start: 0, end: 5, quote: "Alpha" })];
  const batch = savedBatch("batch", 1, comments);
  batch.resolutions = [{ id: "resolution", commentId: "resolved", resolved: true, createdAt: 2 }];
  const f = fixture({ batches: [batch] });
  try {
    f.layout.quoteRects.set("Alpha", []);
    await settle(); f.layout.flush();
    pointer(f, "pointermove");
    clickHighlight(f);
    assert.equal(f.highlights.has("annotations-hover"), false);
    assert.equal(f.highlights.has("annotations-focus"), false);
    assert.equal(f.navigations.length, 0);
    assert.notEqual(f.document.activeElement?.getAttribute("aria-label"), "Reply");
  } finally { f.close(); }
});

test("dragging a native text selection across a highlight does not open a thread", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    pointer(f, "pointerdown", 720, 410, f.root, 1);
    pointer(f, "pointermove", 780, 410, f.root, 1);
    selectWhole(f.document, f.root);
    pointer(f, "pointerup", 780, 410);
    pointer(f, "click", 780, 410);
    assert.equal(f.document.getSelection()!.toString(), "Alpha beta gamma");
    assert.equal(f.navigations.length, 0);
    assert.notEqual(f.document.activeElement?.getAttribute("aria-label"), "Reply");
    f.document.getSelection()!.removeAllRanges();
    clickHighlight(f);
    assert.equal(f.document.activeElement, replyEditor(f).textarea);
  } finally { f.close(); }
});

test("hover state clears when navigation or reader mutations invalidate its anchor", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); f.layout.flush();
    pointer(f, "pointermove");
    assert.equal(f.highlights.get("annotations-hover")!.size, 1);
    f.api.setDocument({ id: "review/other", title: "Other", root: f.root });
    assert.equal(f.highlights.has("annotations-hover"), false);
    assert.equal(threadCard(f, "batch/comment", "global").dataset.hovered, "false");
    f.api.setDocument(reader(f.document)); f.layout.flush();
    pointer(f, "pointermove");
    f.root.innerHTML = "<p>Changed quote</p>";
    await settle(); f.layout.flush();
    assert.equal(f.highlights.has("annotations-hover"), false);
    f.api.destroy();
    pointer(f, "pointermove");
    assert.equal(f.highlights.size, 0);
  } finally { f.close(); }
});

test("sending a thread reply posts the thread action and preserves its root, history, and unrelated drafts", async () => {
  const batch = savedBatch("batch", 10, [savedComment("comment")], true);
  batch.replies.push({ commentId: "comment", author: "Agent", text: "Earlier answer", createdAt: 20 });
  const f = fixture({ batches: [batch], stored: storedDrafts(1, "Unrelated root draft") });
  try {
    await settle();
    openThread(f, "batch/comment");
    writeReply(f, "  A follow-up question  ");
    assert.equal(f.byText("Send reply").disabled, false);
    submitReply(f);
    assert.equal(replyEditor(f).textarea.disabled, true);
    assert.equal(f.byText("Cancel reply").disabled, true);
    await settle();
    const action = threadPosts(f)[0]!;
    assert.equal(action.action, "reply");
    assert.match(action.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(action, { id: action.id, action: "reply", batchId: "batch", commentId: "comment", text: "A follow-up question" });
    const call = f.calls.find((call) => call.method === "POST")!;
    assert.equal(new Headers(call.headers).get("X-Annotation-Token"), "csrf-token");
    assert.equal(new Headers(call.headers).get("Content-Type"), "application/json");
    assert.equal(f.state.data.batches.length, 1, "replies are not new root batches");
    assert.equal(batch.recipientId, "previous-session");
    assert.equal(batch.comments[0]!.text, "Saved comment");
    assert.deepEqual(batch.replies.map((reply) => reply.text), ["Earlier answer", "A follow-up question"]);
    assert.equal(batch.replies[1]!.role, "user");
    assert.equal(replyEditor(f).textarea.value, "");
    assert.equal(replyEditor(f).textarea.disabled, false);
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(JSON.parse(f.stored()).drafts[0].text, "Unrelated root draft");
    assert.equal(f.api.hasDrafts(), true);
  } finally { f.close(); }
});

test("global activity sorting is per thread while timestamped user and agent replies stay oldest first", async () => {
  const batch = savedBatch("older", 100, [savedComment("active"), savedComment("quiet")], true);
  batch.replies = [
    { id: "last", commentId: "active", author: "Agent", role: "agent", text: "Newest answer", createdAt: 500 },
    { id: "first", commentId: "active", author: "Agent", text: "First answer", createdAt: 110 },
    { id: "middle", commentId: "active", author: "You", role: "user", delivered: true, text: "Follow-up", createdAt: 300 },
    { id: "unknown", commentId: "missing", author: "Agent", text: "Not part of a known thread", createdAt: 9000 },
  ];
  const f = fixture({ batches: [batch, savedBatch("newer", 200, [savedComment("newer")])], stored: storedDrafts(1) });
  try {
    await settle();
    f.api.setView("global");
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["active", "newer", "quiet", "draft-0"]);
    const card = threadCard(f, "older/active", "global");
    const replies = [...card.querySelectorAll(".annotations-reply")];
    assert.deepEqual(replies.map((reply) => reply.querySelector("p")!.textContent), ["First answer", "Follow-up", "Newest answer"]);
    assert.deepEqual(replies.map((reply) => reply.querySelector<HTMLTimeElement>("time")!.dateTime),
      [110, 300, 500].map((time) => new Date(time).toISOString()));
    for (const reply of replies) assert.ok(reply.querySelector("time")!.textContent!.trim());
    assert.doesNotMatch(f.global.textContent!, /Not part of a known thread/);
    batch.replies.push({ id: "quiet-answer", commentId: "quiet", author: "Agent", text: "Now the latest", createdAt: 600 });
    await f.poll();
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["quiet", "active", "newer", "draft-0"]);
    assert.equal(threadCard(f, "older/active", "global").querySelectorAll(".annotations-reply").length, 3, "polling appends rather than replaces reply history");
  } finally { f.close(); }
});

test("polling new replies and reordering global threads preserves the editor, focus, caret, and reply draft", async () => {
  const batch = savedBatch("batch", 1, [savedComment("one"), savedComment("two")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    const { textarea, form } = openThread(f, "batch/one", "global");
    writeReply(f, "Keep typing this reply");
    textarea.setSelectionRange(5, 11);
    batch.replies.push({ id: "answer", commentId: "two", author: "Agent", role: "agent", text: "A new answer", createdAt: 50 });
    await f.poll(); f.layout.flush();
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["two", "one"]);
    assert.equal(replyEditor(f).form, form);
    assert.equal(replyEditor(f).textarea, textarea);
    assert.equal(f.document.activeElement, textarea);
    assert.equal(textarea.value, "Keep typing this reply");
    assert.equal(textarea.selectionStart, 5);
    assert.equal(textarea.selectionEnd, 11);
    assert.ok(threadCard(f, "batch/one", "global").contains(form));
    f.state.data.recipient = active("another-session", 100);
    await f.poll();
    assert.equal(f.document.activeElement, textarea);
    assert.equal(textarea.value, "Keep typing this reply");
  } finally { f.close(); }
});

test("changed polls preserve focused reply buttons and restore card, quote, and resolve focus after reordering", async () => {
  const batch = savedBatch("batch", 1, [savedComment("one"), savedComment("two")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    openThread(f, "batch/one", "global"); writeReply(f, "Keep this reply draft");
    const { form, textarea } = replyEditor(f);
    let activity = 10;
    for (const view of ["local", "global"] as const) {
      f.api.setView(view); f.layout.flush();
      for (const control of ["Send reply", "Cancel reply", "card", "quote", "resolve"] as const) {
        const card = threadCard(f, "batch/one", view);
        const before = control === "card" ? card : control === "quote" ? card.querySelector<HTMLButtonElement>(".annotations-quote-button")! :
          control === "resolve" ? card.querySelector<HTMLButtonElement>(".annotations-resolve")! : f.byText(control);
        before.focus();
        assert.equal(f.document.activeElement, before);
        // Alternate activity between the threads so every changed poll also
        // reverses the global list, rather than merely updating text in place.
        const latest = f.global.querySelector<HTMLElement>(".annotations-comment")!.dataset.commentId === "one" ? "two" : "one";
        batch.replies.push({ id: `answer-${activity}`, commentId: latest, author: "Agent", role: "agent", text: `Answer ${activity}`, createdAt: activity++ });
        batch.delivered = !batch.delivered;
        await f.poll(); f.layout.flush();
        assert.equal(f.global.querySelector<HTMLElement>(".annotations-comment")!.dataset.commentId, latest);
        const updatedCard = threadCard(f, "batch/one", view);
        const after = control === "card" ? updatedCard : control === "quote" ? updatedCard.querySelector<HTMLButtonElement>(".annotations-quote-button")! :
          control === "resolve" ? updatedCard.querySelector<HTMLButtonElement>(".annotations-resolve")! : f.byText(control);
        if (control === "Send reply" || control === "Cancel reply") assert.equal(after, before, "shared reply controls retain their DOM identity");
        assert.equal(f.document.activeElement, after, `${view} ${control} must retain focus after a changed poll`);
        assert.equal(replyEditor(f).form, form);
        assert.equal(replyEditor(f).textarea, textarea);
        assert.equal(textarea.value, "Keep this reply draft");
        assert.ok(updatedCard.contains(form));
      }
    }
    assert.equal(threadPosts(f).length, 0, "restoring focus must not activate controls");
  } finally { f.close(); }
});

test("uncertain thread failures retain an immutable reply request across reload and exact retry", async () => {
  for (const failure of ["network", "503", "invalid-json", "unconfirmed-root"]) {
    const batch = savedBatch("batch", 1, [savedComment("comment")]);
    const f = fixture({ batches: [batch] });
    try {
      await settle();
      openThread(f, "batch/comment"); writeReply(f, "Keep this pending reply");
      f.state.post = async () => {
        if (failure === "network") throw new Error("connection lost");
        if (failure === "503") return new Response(JSON.stringify({ error: "Try later" }), { status: 503 });
        if (failure === "invalid-json") return new Response("not json");
        return new Response(JSON.stringify(batch));
      };
      submitReply(f); await settle();
      const original = f.calls.find((call) => call.method === "POST")!.body!;
      assert.deepEqual(JSON.parse(f.stored()).threadPending, JSON.parse(original), failure);
      assert.equal(f.api.hasDrafts(), true, failure);
      assert.equal(replyEditor(f).textarea.disabled, true, failure);
      assert.equal(f.byText("Cancel reply").disabled, true, failure);
      assert.equal(f.byText("Retry reply").disabled, false, failure);
      const restored = fixture({ batches: [batch], stored: f.stored(), recipient: active("new-session") });
      try {
        await settle();
        openThread(restored, "batch/comment");
        assert.equal(replyEditor(restored).textarea.value, "Keep this pending reply");
        assert.equal(replyEditor(restored).textarea.disabled, true);
        restored.byText("Retry reply").click(); await settle();
        assert.equal(restored.calls.find((call) => call.method === "POST")!.body, original, failure);
        assert.equal(restored.state.data.batches[0]!.replies.length, 1);
        assert.equal(JSON.parse(restored.stored()).threadPending, null);
        assert.equal(restored.api.hasDrafts(), false);
      } finally { restored.close(); }
    } finally { f.close(); }
  }
});

test("a pending reply can retry after another client resolves the thread, then a 409 unlocks reopening without losing its draft", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment"), savedComment("other")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    openThread(f, "batch/comment"); writeReply(f, "Keep this unconfirmed reply");
    f.state.post = async () => { throw new Error("request failed before storage"); };
    submitReply(f); await settle();
    const original = f.calls.find((call) => call.method === "POST")!.body!;
    assert.equal(batch.replies.length, 0);
    batch.resolutions = [{ id: "other-client-resolved", commentId: "comment", resolved: true, createdAt: 2 }];
    await f.poll();
    assert.deepEqual(JSON.parse(f.stored()).threadPending, JSON.parse(original), "resolution alone cannot confirm the pending reply");
    f.api.setView("global"); showResolved(f);
    openThread(f, "batch/comment", "global");
    assert.equal(threadCard(f, "batch/comment", "global").dataset.resolved, "true");
    assert.equal(replyEditor(f).textarea.disabled, true);
    assert.equal(f.byText("Cancel reply").disabled, true);
    assert.equal(f.byText("Reopen thread").disabled, true);
    assert.equal(f.byText("Retry reply").disabled, false, "the immutable reply must remain retryable even though the thread is now resolved");
    f.state.post = async () => new Response(JSON.stringify({ error: "Thread is resolved" }), { status: 409 });
    f.byText("Retry reply").click();
    assert.equal(replyEditor(f).textarea.disabled, true, "pending text stays locked until the server returns a definitive result");
    await settle();
    const posts = f.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[1]!.body, original, "retry must not change the request ID or body");
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(replyEditor(f).textarea.value, "Keep this unconfirmed reply");
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(f.byText("Cancel reply").disabled, false);
    assert.equal(f.byText("Reopen thread").disabled, false);
    assert.equal(threadCard(f, "batch/other", "global").querySelector<HTMLButtonElement>(".annotations-resolve")!.disabled, false);
    f.state.post = async (body) => {
      assert.ok("action" in body && body.action === "resolve");
      assert.equal(body.resolved, false);
      batch.resolutions!.push({ id: body.id, commentId: body.commentId, resolved: body.resolved, createdAt: 3 });
      return new Response(JSON.stringify(batch));
    };
    f.byText("Reopen thread").click(); await settle(); f.layout.flush();
    assert.equal(threadCard(f, "batch/comment", "global").dataset.resolved, "false");
    assert.equal(replyEditor(f).textarea.disabled, false);
    assert.equal(replyEditor(f).textarea.value, "Keep this unconfirmed reply");
    assert.equal(f.byText("Send reply").disabled, false);
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(batch.replies.length, 0, "a definitive rejection never publishes a reply");
  } finally { f.close(); }
});

test("GET confirms a pending reply by operation ID, not merely matching text or a root batch ID", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    openThread(f, "batch/comment"); writeReply(f, "Repeated text");
    f.state.post = async () => { throw new Error("lost response"); };
    submitReply(f); await settle();
    const operation = threadPosts(f)[0]!;
    batch.replies.push({ id: "different-operation", commentId: "comment", author: "You", role: "user", text: "Repeated text", createdAt: 2 });
    await f.poll();
    assert.equal(JSON.parse(f.stored()).threadPending.id, operation.id);
    assert.equal(f.api.hasDrafts(), true);
    batch.replies.push({ id: operation.id, commentId: "comment", author: "You", role: "user", text: "Repeated text", createdAt: 3 });
    await f.poll();
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(replyEditor(f).textarea.value, "");
    assert.equal(replyEditor(f).textarea.disabled, false);
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(threadPosts(f).length, 1, "confirmation must not create another POST");
  } finally { f.close(); }
});

test("a late successful reply POST cannot replace newer GET history or clear a newly typed draft", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment"), savedComment("other")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    openThread(f, "batch/comment", "global"); writeReply(f, "The submitted reply");
    let finishPost!: () => void;
    f.state.post = async (body) => {
      assert.ok("action" in body && body.action === "reply");
      batch.replies.push({ id: body.id, commentId: body.commentId, author: "You", role: "user", text: body.text, createdAt: 2 });
      // Freeze the successful response before GET observes later history.
      const staleResponse = new Response(JSON.stringify(batch));
      return new Promise<Response>((resolve) => { finishPost = () => resolve(staleResponse); });
    };
    submitReply(f);
    const operation = threadPosts(f)[0]!;
    assert.equal(JSON.parse(f.stored()).threadPending.id, operation.id);
    batch.replies.push({ id: "newer-answer", commentId: "comment", author: "Agent", role: "agent", text: "The newer agent answer", createdAt: 3 });
    batch.resolutions = [{ id: "newer-resolution", commentId: "other", resolved: true, createdAt: 4 }];
    await f.poll(); f.layout.flush();
    assert.equal(JSON.parse(f.stored()).threadPending, null, "GET confirms the same operation while its POST is still in flight");
    assert.equal(replyEditor(f).textarea.disabled, false);
    assert.equal(replyEditor(f).textarea.value, "");
    const assertLatestHistory = () => {
      const card = threadCard(f, "batch/comment", "global");
      assert.deepEqual([...card.querySelectorAll(".annotations-reply p")].map((node) => node.textContent),
        ["The submitted reply", "The newer agent answer"]);
      assert.equal(card.querySelector(".annotations-state")!.textContent, "Replied");
      assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["comment"], "the newer resolution must keep the other thread hidden");
      assert.equal(f.highlights.get("annotations-saved")!.size, 1);
    };
    assertLatestHistory();
    writeReply(f, "A new draft written after GET confirmation");
    const drafts = JSON.parse(f.stored()).replyDrafts;
    finishPost(); await settle(); f.layout.flush();
    assertLatestHistory();
    assert.equal(replyEditor(f).textarea.value, "A new draft written after GET confirmation");
    assert.deepEqual(JSON.parse(f.stored()).replyDrafts, drafts);
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(f.byText("Send reply").disabled, false);
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(threadPosts(f).length, 1);
  } finally { f.close(); }
});

test("400, 409, 413, and 415 thread rejections unlock and preserve the reply draft for a new request", async () => {
  for (const status of [400, 409, 413, 415]) {
    const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
    try {
      await settle();
      const success = f.state.post;
      openThread(f, "batch/comment"); writeReply(f, "Needs correction");
      f.state.post = async () => new Response(status === 413 ? "Too large" : JSON.stringify({ error: "Rejected" }), { status });
      submitReply(f); await settle();
      assert.equal(JSON.parse(f.stored()).threadPending, null, String(status));
      assert.equal(replyEditor(f).textarea.disabled, false);
      assert.equal(replyEditor(f).textarea.value, "Needs correction");
      assert.equal(f.byText("Cancel reply").disabled, false);
      assert.equal(f.byText("Send reply").disabled, false);
      assert.equal(f.api.hasDrafts(), true);
      writeReply(f, "Corrected reply"); f.state.post = success;
      submitReply(f); await settle();
      const posts = threadPosts(f);
      assert.equal(posts.length, 2);
      assert.notEqual(posts[0]!.id, posts[1]!.id);
      assert.equal(posts[1]!.action === "reply" && posts[1]!.text, "Corrected reply");
      assert.equal(f.api.hasDrafts(), false);
    } finally { f.close(); }
  }
});

test("root submission and thread reply requests can remain pending and complete independently", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])], stored: storedDrafts(1) });
  try {
    await settle();
    const success = f.state.post;
    let finishRoot!: () => void, finishReply!: () => void;
    f.state.post = async (body) => {
      await new Promise<void>((resolve) => { if ("action" in body) finishReply = resolve; else finishRoot = resolve; });
      return success(body);
    };
    f.byText("Send comments").click();
    openThread(f, "batch/comment"); writeReply(f, "Independent follow-up");
    assert.equal(f.byText("Send reply").disabled, false);
    submitReply(f);
    const pending = JSON.parse(f.stored());
    assert.ok(pending.pending?.id);
    assert.ok(pending.threadPending?.id);
    assert.notEqual(pending.pending.id, pending.threadPending.id);
    finishReply(); await settle();
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(JSON.parse(f.stored()).pending.id, pending.pending.id);
    assert.equal(JSON.parse(f.stored()).drafts.length, 1);
    finishRoot(); await settle();
    assert.equal(JSON.parse(f.stored()).pending, null);
    assert.equal(JSON.parse(f.stored()).drafts.length, 0);
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(f.state.data.batches.find((batch) => batch.id === "batch")!.replies.length, 1);
  } finally { f.close(); }
});

test("reply length and empty-text guards preserve drafts without creating a pending operation", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle(); openThread(f, "batch/comment");
    assert.equal(replyEditor(f).textarea.maxLength, 8000);
    for (const text of ["   ", "x".repeat(8001)]) {
      writeReply(f, text);
      assert.equal(f.byText("Send reply").disabled, true);
      submitReply(f); await settle();
      assert.equal(threadPosts(f).length, 0);
      assert.equal(JSON.parse(f.stored()).threadPending, null);
      assert.equal(replyEditor(f).textarea.value, text);
    }
    writeReply(f, "x".repeat(8000));
    assert.equal(f.byText("Send reply").disabled, false);
    submitReply(f); await settle();
    assert.equal(f.state.data.batches[0]!.replies[0]!.text.length, 8000);
  } finally { f.close(); }
});

test("resolve and reopen update the original thread and hide resolved anchors and local cards", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle(); f.layout.flush();
    pointer(f, "pointermove");
    assert.equal(f.highlights.get("annotations-hover")!.size, 1);
    f.byText("Resolve thread").click(); await settle(); f.layout.flush();
    const resolve = threadPosts(f)[0]!;
    assert.deepEqual(resolve, { id: resolve.id, action: "resolve", batchId: "batch", commentId: "comment", resolved: true });
    assert.equal(f.state.data.batches.length, 1);
    assert.equal(f.margin.querySelector(".annotations-comment"), null);
    assert.equal(f.global.querySelector(".annotations-comment"), null);
    assert.equal(f.highlights.has("annotations-saved"), false);
    assert.equal(f.highlights.has("annotations-hover"), false);
    f.api.setView("global"); showResolved(f);
    const resolved = threadCard(f, "batch/comment", "global");
    assert.equal(resolved.dataset.resolved, "true");
    assert.equal(resolved.querySelector(".annotations-state")!.textContent, "Resolved");
    openThread(f, "batch/comment", "global");
    assert.equal(replyEditor(f).textarea.disabled, true);
    assert.equal(f.byText("Send reply").disabled, true);
    f.byText("Reopen thread").click(); await settle(); f.layout.flush();
    const reopen = threadPosts(f)[1]!;
    assert.deepEqual(reopen, { id: reopen.id, action: "resolve", batchId: "batch", commentId: "comment", resolved: false });
    assert.notEqual(reopen.id, resolve.id);
    assert.equal(batch.resolutions!.length, 2, "keep both resolution operations for retry confirmation");
    assert.equal(threadCard(f, "batch/comment", "global").dataset.resolved, "false");
    assert.equal(f.highlights.get("annotations-saved")!.size, 1);
    f.api.setView("local"); f.layout.flush();
    assert.ok(threadCard(f, "batch/comment"));
    assert.equal(replyEditor(f).textarea.disabled, false);
  } finally { f.close(); }
});

test("resolution state uses the newest timestamp and operation ID, independent of history order", async () => {
  const batch = savedBatch("batch", 1, [savedComment("reopened"), savedComment("resolved"), savedComment("tie-open"), savedComment("tie-closed")]);
  batch.resolutions = [
    { id: "new", commentId: "reopened", resolved: false, createdAt: 30 },
    { id: "old", commentId: "reopened", resolved: true, createdAt: 10 },
    { id: "new", commentId: "resolved", resolved: true, createdAt: 30 },
    { id: "old", commentId: "resolved", resolved: false, createdAt: 10 },
    { id: "z", commentId: "tie-open", resolved: false, createdAt: 20 },
    { id: "a", commentId: "tie-open", resolved: true, createdAt: 20 },
    { id: "z", commentId: "tie-closed", resolved: true, createdAt: 20 },
    { id: "a", commentId: "tie-closed", resolved: false, createdAt: 20 },
  ];
  const f = fixture({ batches: [batch] });
  try {
    await settle(); f.layout.flush();
    assert.deepEqual(commentIds(f.margin, ".annotations-comment"), ["reopened", "tie-open"]);
    assert.deepEqual(commentIds(f.global, ".annotations-comment"), ["reopened", "tie-open"]);
    assert.equal(f.highlights.get("annotations-saved")!.size, 2);
    f.api.setView("global"); showResolved(f);
    assert.equal(f.global.querySelectorAll(".annotations-comment").length, 4);
    assert.equal(f.margin.querySelectorAll(".annotations-comment").length, 2, "Show resolved affects only the global list");
    assert.equal(f.highlights.get("annotations-saved")!.size, 2, "showing resolved cards never restores their highlights");
    batch.resolutions.reverse(); await f.poll();
    assert.equal(threadCard(f, "batch/tie-open", "global").dataset.resolved, "false");
    assert.equal(threadCard(f, "batch/tie-closed", "global").dataset.resolved, "true");
  } finally { f.close(); }
});

test("uncertain resolution retries preserve the exact operation after reload", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    f.state.post = async () => { throw new Error("connection lost"); };
    f.byText("Resolve thread").click(); await settle();
    const original = f.calls.find((call) => call.method === "POST")!.body!;
    assert.deepEqual(JSON.parse(f.stored()).threadPending, JSON.parse(original));
    assert.equal(f.api.hasDrafts(), true);
    const restored = fixture({ batches: [batch], stored: f.stored() });
    try {
      await settle();
      restored.byText("Retry thread update").click(); await settle();
      assert.equal(restored.calls.find((call) => call.method === "POST")!.body, original);
      assert.equal(batch.resolutions!.length, 1);
      assert.equal(JSON.parse(restored.stored()).threadPending, null);
      assert.equal(restored.api.hasDrafts(), false);
      assert.equal(restored.margin.querySelector(".annotations-comment"), null);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("GET confirms an earlier resolution operation even when a later operation already reopened the thread", async () => {
  const batch = savedBatch("batch", 1, [savedComment("comment")]);
  const f = fixture({ batches: [batch] });
  try {
    await settle();
    f.state.post = async () => { throw new Error("response lost"); };
    f.byText("Resolve thread").click(); await settle();
    const operation = threadPosts(f)[0]!;
    batch.resolutions = [{ id: "different", commentId: "comment", resolved: true, createdAt: 2 }];
    await f.poll();
    assert.equal(JSON.parse(f.stored()).threadPending.id, operation.id, "same resolution value does not confirm a different operation");
    batch.resolutions.push(
      { id: operation.id, commentId: "comment", resolved: true, createdAt: 3 },
      { id: "later-reopen", commentId: "comment", resolved: false, createdAt: 4 },
    );
    await f.poll(); f.layout.flush();
    assert.equal(JSON.parse(f.stored()).threadPending, null);
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(threadPosts(f).length, 1);
    assert.equal(threadCard(f, "batch/comment").dataset.resolved, "false");
    assert.equal(f.highlights.get("annotations-saved")!.size, 1);
  } finally { f.close(); }
});

test("Cancel reply removes only the focused reply draft and leaves other thread drafts intact", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("one"), savedComment("two")])] });
  try {
    await settle();
    openThread(f, "batch/one"); writeReply(f, "Keep the first draft");
    openThread(f, "batch/two"); writeReply(f, "Cancel the second draft");
    f.byText("Cancel reply").click();
    assert.equal(f.api.hasDrafts(), true);
    assert.equal(openThread(f, "batch/two").textarea.value, "");
    assert.equal(openThread(f, "batch/one").textarea.value, "Keep the first draft");
    f.byText("Cancel reply").click();
    assert.equal(f.api.hasDrafts(), false);
    assert.equal(threadPosts(f).length, 0);
  } finally { f.close(); }
});

test("destroy aborts a pending thread request, removes hover listeners, and keeps the retry record", async () => {
  const f = fixture({ batches: [savedBatch("batch", 1, [savedComment("comment")])] });
  try {
    await settle();
    openThread(f, "batch/comment"); writeReply(f, "Keep for retry after closing");
    f.state.post = () => new Promise(() => {});
    submitReply(f);
    const call = f.calls.find((call) => call.method === "POST")!;
    const stored = f.stored();
    assert.ok(JSON.parse(stored).threadPending);
    f.api.destroy();
    assert.equal(call.signal!.aborted, true);
    pointer(f, "pointermove"); clickHighlight(f);
    assert.equal(f.highlights.size, 0);
    assert.equal(f.layout.frames.size, 0);
    assert.equal(f.container.querySelector(".annotations-thread-editor"), null);
    assert.equal(f.stored(), stored);
  } finally { f.close(); }
});
