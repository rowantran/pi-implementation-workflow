import assert from "node:assert/strict";
import { createJiti } from "jiti/static";
import { marked } from "marked";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderWorkflowDashboard } = await jiti.import(
  new URL("../src/dashboard.ts", import.meta.url).pathname,
);

const data = {
  slug: 'example</title><script>alert("unsafe")</script>',
  description: "Extract the dashboard template",
  ask: 'First line\n\nSecond </template><script>alert("ask")</script> line.',
  generatedAt: "2025-01-02T03:04:05.000Z",
  versions: [
    {
      number: 1,
      createdAt: "2025-01-02T03:04:05.000Z",
      content: "# Plan\n\nRender </template><script>unsafe</script> content.",
    },
  ],
  clarifications: [],
  reviewStale: false,
  review: {
    version: 2,
    pullRequestUrls: ["https://example.test/pull/1", "https://example.test/pull/2"],
    baseCommit: "abc123",
    headCommit: "def456",
    sourceFingerprint: "source789",
    generatedAt: "2026-01-03T00:00:00.000Z",
    overallResult: {
      summary: 'Necessary and sufficient <script>alert("review")</script>.',
      necessary: { status: "yes", explanation: "Within scope." },
      sufficient: { status: "yes", explanation: "Complete." },
    },
    overallConcerns: [],
    holisticReview: {
      summary: "The complete change is coherent.",
      necessary: { status: "yes", explanation: "Within scope." },
      sufficient: { status: "yes", explanation: "Complete." },
      concerns: [],
    },
    plannedChanges: [{
      id: "PC-01",
      title: "Render the review",
      what: "Show the report.",
      why: "Make review easy.",
      pseudocode: "render(report)",
      review: {
        id: "PC-01",
        title: "Render the review",
        walkthrough: "The dashboard renders it.\n\n```ts\ninterface WorkflowReviewReport {}\n```\n\n> **Decision:** Matches the plan.",
        necessary: { status: "yes", explanation: "Required." },
        sufficient: { status: "yes", explanation: "Complete." },
        concerns: [],
      },
    }],
    testingCriteria: {
      originalCriteria: "Run the dashboard test and inspect the report.",
      review: {
        summary: "The dashboard test passes; visual inspection remains.",
        satisfied: { status: "partial", explanation: "Automated evidence passes." },
        criteria: [{
          criterion: "Run the dashboard test",
          status: "yes",
          explanation: "The dashboard test passes.",
          evidence: [{ location: "scripts/dashboard-test.mjs:1", description: "Exercises the report reader." }],
        }],
        concerns: [],
      },
    },
  },
};

const html = renderWorkflowDashboard(data);
const revision = /<meta name="implementation-workflow-revision" content="([a-f0-9]{64})">/.exec(html)?.[1];
const timestampOnlyUpdate = renderWorkflowDashboard({ ...data, generatedAt: "2025-01-02T03:05:05.000Z" });
const contentUpdate = renderWorkflowDashboard({ ...data, description: "Updated dashboard content" });

assert.ok(html.startsWith("<!doctype html>"));
assert.equal(revision?.length, 64);
assert.equal(
  /<meta name="implementation-workflow-revision" content="([a-f0-9]{64})">/.exec(timestampOnlyUpdate)?.[1],
  revision,
  "regenerating unchanged visible data keeps the same revision",
);
assert.notEqual(
  /<meta name="implementation-workflow-revision" content="([a-f0-9]{64})">/.exec(contentUpdate)?.[1],
  revision,
  "visible dashboard changes create a new revision",
);
assert.ok(
  html.includes(
    "<title>Implementation workflow · example&lt;&#x2F;title&gt;&lt;script&gt;alert(&quot;unsafe&quot;)&lt;&#x2F;script&gt;</title>",
  ),
);
assert.ok(html.includes('<template id="dashboard-data">{&quot;slug&quot;:'));
assert.ok(
  html.includes(
    "Render &lt;&#x2F;template&gt;&lt;script&gt;unsafe&lt;&#x2F;script&gt; content.",
  ),
);
assert.ok(
  html.includes(
    "First line\\n\\nSecond &lt;&#x2F;template&gt;&lt;script&gt;alert(\\&quot;ask\\&quot;)&lt;&#x2F;script&gt; line.",
  ),
);
assert.ok(html.includes("originalAskText.textContent=dashboard.ask"));
assert.equal(data.versions[0].content.includes(data.ask), false);
assert.ok(html.includes('const dashboardSnapshot = dashboardDataElement.content.textContent;'));
assert.ok(html.includes("const dashboard = JSON.parse(dashboardSnapshot);"));
assert.ok(html.includes('id="review-pull-requests"'));
assert.ok(html.includes("pullRequestUrls.length===1 ? \"Open pull request\" : \"Open PR \"+(index+1)"));
assert.ok(html.includes("async function refreshDashboardIfChanged()"));
assert.ok(html.includes('fetch(location.href,{method:"HEAD",cache:"no-store"})'));
assert.ok(html.includes('head.headers.get("x-implementation-workflow-revision")'));
assert.ok(html.includes("if(latestRevision!==dashboardRevision)reloadDashboard()"));
assert.ok(!html.includes("{{dashboard"));
assert.ok(!html.includes("</title><script>"));
assert.ok(!html.includes("</template><script>"));
assert.ok(html.includes('src="../assets/marked.umd.js"'));
assert.ok(html.includes('new URL("../assets/mermaid.min.js",location.href)'));
assert.ok(html.includes("function loadMermaidLibrary()"));
assert.ok(html.includes("function renderMarkdown(markdown)"));
assert.ok(html.includes("new marked.Renderer()"));
assert.ok(html.includes("function renderMermaidDiagrams(root)"));
assert.ok(html.includes('library.run({nodes:nodes,suppressErrors:true})'));
assert.ok(html.includes("function renderRichDiff(rows, before, after)"));
assert.ok(html.includes("function parsePlanStructure(markdown)"));
assert.ok(!html.includes('id="plan-graph-mode-button"'), "Graph is a guided section, not a reading mode");
assert.ok(html.includes('data-reader="plan" data-reader-destination="graph">Dependency graph</button>'));
assert.ok(html.indexOf('data-reader-destination="goal"') < html.indexOf('data-reader-destination="graph"'));
assert.ok(html.indexOf('data-reader-destination="graph"') < html.indexOf('id="plan-change-links"'));
assert.ok(!html.includes('plan-reader--graph{display:block}'), "the graph must preserve the guided outline");
assert.ok(html.includes('.guided-pagination[hidden]{display:none}'));
assert.ok(html.includes('.ds-tabs__tab[hidden]{display:none}'));
assert.ok(html.includes('.plan-layout>.plan-card{min-width:0}'), "diagram overflow stays inside the card on narrow screens");
assert.ok(html.includes('#plan-dependency-canvas .node.graph-node--selected .label *'));
assert.ok(html.includes('class="dependency-goal"'));
assert.ok(html.includes('id="plan-guided-mode-button"'));
assert.ok(html.includes('id="plan-dependency-graph"'));
for (const removed of ["plan-dependency-list", "plan-graph-selection", "plan-graph-detail", "plan-graph-render-status", "data-graph-select", "data-graph-open", "renderDependencyList", "renderGraphDetail"]) {
  assert.ok(!html.includes(removed), `${removed} is removed, not hidden`);
}
assert.ok(!html.includes("Prerequisites and downstream changes are highlighted."));
assert.ok(html.includes('id="plan-graph-unavailable"'));
assert.ok(html.includes('id="dependency-diff"'));
assert.ok(html.includes('securityLevel:"strict"'));
assert.ok(html.includes('htmlLabels:false,useMaxWidth:false'));
assert.ok(html.includes('window.addEventListener("hashchange",applyDashboardHash)'));
assert.ok(!html.includes('.bindFunctions('));
assert.ok(html.includes('.dependency-canvas{overflow:auto;max-width:100%'));
assert.ok(html.includes('.dependency-canvas svg{display:block;height:auto;'));
assert.ok(!html.includes('.dependency-canvas svg{display:block;max-width:none!important'), "CSS must not override the responsive diagram width");
assert.ok(html.includes('id="plan-full-mode-button"'));
assert.ok(html.includes('id="review-guided-mode-button"'));
assert.ok(html.includes('id="review-full-mode-button"'));
assert.ok(!html.includes('getElementById("guided-mode-button")'));
assert.ok(html.includes('aria-label="Plan outline"'));
assert.ok(!html.includes('data-plan-destination="overview"'));
assert.ok(html.includes('data-reader="plan" data-reader-destination="goal"'));
assert.ok(html.includes('data-reader="review" data-reader-destination="testing"'));
assert.ok(html.includes('class="plan-outline-button plan-outline-button--section"'));
assert.equal(html.match(/aria-keyshortcuts="\["/g)?.length, 3);
assert.equal(html.match(/aria-keyshortcuts="\]"/g)?.length, 3);
assert.equal(html.match(/aria-keyshortcuts="S"/g)?.length, 2);
assert.equal(html.match(/aria-keyshortcuts="C"/g)?.length, 1);
assert.ok(html.includes('id="plan-navigation-sidebar-button"'));
assert.ok(html.includes('id="review-navigation-sidebar-button"'));
assert.ok(html.includes('id="context-sidebar-button"'));
assert.ok(html.includes('id="workflow-context-sidebar"'));
assert.ok(html.includes('<kbd class="shortcut-key">S</kbd>'));
assert.ok(html.includes('<kbd class="shortcut-key">C</kbd>'));
assert.ok(html.includes('event.key==="["'));
assert.ok(html.includes('event.key==="]"'));
assert.ok(html.includes('key==="s"'));
assert.ok(!html.includes('key==="p"'));
assert.ok(!html.includes('key==="n"'));
assert.ok(html.includes('key==="c"'));
assert.ok(html.indexOf('id="plan-pagination"') < html.indexOf('id="plan-content"'));
assert.ok(html.indexOf('id="review-pagination"') < html.indexOf('id="review-content"'));
assert.ok(html.includes("function renderReader(name,destination,focusContent,scrollContent)"));
assert.ok(html.includes("function setReaderMode(name,mode,destination,focusContent)"));
assert.ok(html.includes("function renderFullReview()"));
assert.ok(html.includes("moveReader(name,offset,false,false,true,true)"));
assert.ok(html.includes('window.scrollTo({top:0,left:0,behavior:"auto"})'));
assert.ok(html.includes("heading.focus({preventScroll:true})"));
assert.ok(html.includes('if(scrollContent!==false)heading.scrollIntoView({block:"start"})'));
assert.ok(html.includes(".plan-card{overflow:clip}"));
assert.ok(html.includes(".review-card{overflow:clip}"));
assert.ok(html.includes(".plan-layout--context-collapsed{grid-template-columns:minmax(0,1fr)}"));
assert.ok(html.includes(".plan-reader--sidebar-collapsed{grid-template-columns:minmax(0,1fr)}"));
assert.ok(html.includes(".sidebar-toggle{gap:7px}"));
assert.ok(html.includes(".plan-outline-sticky{position:sticky;top:84px"));
assert.ok(html.includes(".plan-outline{position:sticky;top:60px;z-index:10;align-self:start;overflow:auto"));
assert.ok(html.includes(".plan-outline-sticky{position:static;max-height:none;overflow:visible;padding:10px}"));
assert.equal(html.match(/class="plan-outline-sticky"/g)?.length, 2);
assert.equal(html.match(/role="status" aria-live="polite" aria-atomic="true"/g)?.length, 2);
assert.ok(html.includes('id="review-tab" data-view="review"'));
assert.ok(html.includes('aria-label="Review outline"'));
assert.ok(html.includes('class="card review-card"'));
assert.ok(html.includes('class="markdown review-document"'));
assert.ok(!html.includes('href="review.md"'));
assert.ok(!html.includes('class="review-layout"'));
assert.ok(!html.includes('class="planned-review-body"'));
assert.ok(!html.includes("function focusReviewSection"));
assert.ok(html.includes("function prepareReview()"));
assert.ok(html.includes("function renderReviewDestination(selected,fullDocument)"));
assert.ok(html.includes('const unseenReview=dashboard.review && state.reviewHead !== dashboard.review.headCommit'));
assert.ok(html.includes('initialView=unseenReview && !planHashDestination ? "review"'), "explicit plan deep links win over an unseen review");
assert.ok(!html.includes('<script>alert("review")</script>'));
assert.ok(html.includes('class="markdown diff-document"'));
assert.ok(html.includes("renderRichDiff(rows,before.content,after.content)"));
assert.ok(html.includes('id="diff-previous-block"'));
assert.ok(html.includes('id="diff-next-block"'));
assert.ok(html.includes("function diffBlockStartIndexes(rows, contextLines = 3)"));
assert.ok(html.includes("function moveDiffBlock(offset)"));
assert.ok(!html.includes('class="diff-table"'));
const dashboardScript = html.match(/<script id="dashboard-app">([\s\S]*?)<\/script>/)?.[1];
assert.ok(dashboardScript);
assert.doesNotThrow(() => new Function(dashboardScript));
const helperSource = dashboardScript.slice(
  dashboardScript.indexOf("function escapeHtml"),
  dashboardScript.indexOf("function initialize"),
);
const { createPlanDestinations, dependencyChanges, dependencyRelations, diffBlockStartIndexes, generateDependencyDiagram, hashReaderDestination, initialViewForHash, lineDiff, mermaidGraphText, parsePlanStructure, planModeForState, planDestinationForState, renderDependencyChanges, renderMarkdown, renderRichDiff, wrapGraphTitle } = new Function(
  "marked",
  `${helperSource}; return { createPlanDestinations, dependencyChanges, dependencyRelations, diffBlockStartIndexes, generateDependencyDiagram, hashReaderDestination, initialViewForHash, lineDiff, mermaidGraphText, parsePlanStructure, planModeForState, planDestinationForState, renderDependencyChanges, renderMarkdown, renderRichDiff, wrapGraphTitle };`,
)(marked);
function normalizeRenderedMarkdown(value) { return value.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim(); }
const softWrappedMarkdown = `A paragraph with **strong text** wraps
onto a second source line.

A second paragraph.`;
assert.equal(
  normalizeRenderedMarkdown(renderMarkdown(softWrappedMarkdown)),
  "<p>A paragraph with <strong>strong text</strong> wraps onto a second source line.</p><p>A second paragraph.</p>",
);
const softWrappedList = `- A list item wraps
  onto a second source line.
- A second item.`;
assert.equal(
  normalizeRenderedMarkdown(renderMarkdown(softWrappedList)),
  "<ul><li>A list item wraps onto a second source line.</li><li>A second item.</li></ul>",
);
const tableMarkdown = renderMarkdown("| Name | Status |\n| --- | :---: |\n| Parser | Ready |");
assert.ok(tableMarkdown.includes("<table>"));
assert.ok(tableMarkdown.includes("<thead>"));
assert.ok(tableMarkdown.includes('<th align="center">Status</th>'));
const mermaidMarkdown = renderMarkdown("```mermaid\nflowchart LR\n  A --> B\n```");
assert.ok(mermaidMarkdown.includes('<div class="mermaid">flowchart LR\n  A --&gt; B</div>'));
assert.ok(!renderMarkdown('<script>alert("unsafe")</script>').includes("<script>"));
assert.ok(!renderMarkdown("[unsafe](javascript:alert(1))").includes("javascript:"));
const { renderReviewDestination } = new Function(
  "dashboard",
  "marked",
  `${helperSource}; return { renderReviewDestination };`,
)(data, marked);
const overallReview = renderReviewDestination({ kind: "overall" });
assert.ok(overallReview.includes("Overall result"));
assert.ok(overallReview.includes("&lt;script&gt;alert(&quot;review&quot;)&lt;/script&gt;"));
const plannedChangeReview = renderReviewDestination({ kind: "change", number: 1, change: data.review.plannedChanges[0] });
assert.ok(plannedChangeReview.includes('<details class="review-collapsible"><summary>Planned design</summary>'));
assert.ok(!plannedChangeReview.includes('<details class="review-collapsible" open>'));
assert.ok(plannedChangeReview.includes('class="review-planned-design"'));
assert.ok(plannedChangeReview.includes("PC-01:"));
assert.ok(plannedChangeReview.includes("<h4>Pseudocode</h4>"));
const changeWithoutPseudocode = { ...data.review.plannedChanges[0] };
delete changeWithoutPseudocode.pseudocode;
const reviewWithoutPseudocode = renderReviewDestination({ kind: "change", number: 1, change: changeWithoutPseudocode });
assert.ok(!reviewWithoutPseudocode.includes("<h4>Pseudocode</h4>"));
assert.ok(!reviewWithoutPseudocode.includes("undefined"));
const testingReview = renderReviewDestination({ kind: "testing" });
assert.ok(testingReview.includes("Testing criteria"));
assert.ok(testingReview.includes('<details class="review-collapsible"><summary>Planned tests</summary>'));
assert.ok(!testingReview.includes('<details class="review-collapsible" open>'));
assert.ok(testingReview.includes("Run the dashboard test and inspect the report."));
assert.ok(testingReview.includes("scripts/dashboard-test.mjs:1"));

function readerElement() {
  const classes = new Set();
  return {
    className: "",
    innerHTML: "",
    textContent: "",
    hidden: true,
    disabled: false,
    dataset: {},
    attributes: {},
    sidebarLabel: { textContent: "" },
    classList: {
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) {
      if (selector === "h2") return this.heading || null;
      if (selector === ".sidebar-toggle-label") return this.sidebarLabel;
      return null;
    },
    querySelectorAll() { return []; },
  };
}
const readerElements = {};
for (const name of ["plan", "review"]) {
  for (const suffix of ["content", "previous-section", "next-section", "position", "pagination", "reader", "outline", "guided-mode-button", "full-mode-button", "navigation-sidebar-button"]) {
    readerElements[`${name}-${suffix}`] = readerElement();
  }
}
const readerButtons = ["plan", "review"].flatMap((name) => ["first", "second"].map((destination) => ({
  dataset: { reader: name, readerDestination: destination },
  classList: { toggle() {} },
  setAttribute() {},
  removeAttribute() {},
  focus(options) { this.focusOptions = options; },
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; },
})));
const fakeReaderDocument = {
  getElementById(id) { return readerElements[id]; },
  querySelectorAll(selector) {
    const name = /data-reader="([^"]+)"/.exec(selector)?.[1];
    return readerButtons.filter((button) => button.dataset.reader === name);
  },
};
const fakeLocation = { href: "https://example.test/dashboard.html", hash: "" };
const fakeHistory = { replaceState(_state, _title, url) { fakeLocation.href = url; } };
const readerStore = {};
const pageScrolls = [];
const fakeWindow = { scrollTo(options) { pageScrolls.push(options); } };
const readerHelpers = new Function(
  "readers",
  "document",
  "location",
  "history",
  "requestAnimationFrame",
  "window",
  `let navigationSidebarCollapsed=false,contextSidebarCollapsed=false;${helperSource}; return { configureReader, moveReader, renderReader, setNavigationSidebarCollapsed, setReaderMode };`,
)(readerStore, fakeReaderDocument, fakeLocation, fakeHistory, (callback) => callback(), fakeWindow);
for (const name of ["plan", "review"]) {
  readerHelpers.configureReader(name, [
    { id: "first", label: "First" },
    { id: "second", label: "Second" },
  ], (selected) => `<h2>${selected.label}</h2>`, () => {
    readerElements[`${name}-content`].innerHTML = "<h2>Full document</h2>";
    readerElements[`${name}-pagination`].hidden = true;
  });
  readerHelpers.setReaderMode(name, "guided", "first", false);
  assert.equal(readerElements[`${name}-content`].innerHTML, "<h2>First</h2>");
  assert.equal(readerElements[`${name}-previous-section`].disabled, true);
  assert.equal(readerElements[`${name}-next-section`].dataset.destination, "second");
  readerHelpers.moveReader(name, 1, false);
  assert.equal(readerElements[`${name}-content`].innerHTML, "<h2>Second</h2>");
  assert.equal(readerElements[`${name}-previous-section`].dataset.destination, "first");
  assert.equal(readerElements[`${name}-next-section`].disabled, true);
  readerHelpers.setReaderMode(name, "full", undefined, false);
  assert.equal(readerElements[`${name}-content`].innerHTML, "<h2>Full document</h2>");
  assert.equal(readerElements[`${name}-outline`].hidden, true);
  assert.equal(readerElements[`${name}-pagination`].hidden, true);
}

let headingFocusOptions;
let headingScrolls = 0;
readerElements["plan-content"].heading = {
  focus(options) { headingFocusOptions = options; },
  scrollIntoView() { headingScrolls++; },
};
readerHelpers.setReaderMode("plan", "guided", "first", false);
readerHelpers.moveReader("plan", 1, false, false, true, true);
assert.equal(headingFocusOptions, undefined);
assert.equal(headingScrolls, 0);
assert.deepEqual(readerButtons.find((button) => button.dataset.reader === "plan" && button.dataset.readerDestination === "second").focusOptions, { preventScroll: true });
assert.deepEqual(pageScrolls, [{ top: 0, left: 0, behavior: "auto" }]);
readerHelpers.renderReader("plan", "first", true);
assert.deepEqual(headingFocusOptions, { preventScroll: true });
assert.equal(headingScrolls, 1);
readerHelpers.setNavigationSidebarCollapsed(true);
assert.equal(readerElements["plan-outline"].hidden, true);
assert.equal(readerElements["plan-reader"].classList.contains("plan-reader--sidebar-collapsed"), true);
assert.equal(readerElements["plan-navigation-sidebar-button"].attributes["aria-expanded"], "false");
assert.equal(readerElements["plan-navigation-sidebar-button"].sidebarLabel.textContent, "Show navigation");
readerHelpers.setNavigationSidebarCollapsed(false);
assert.equal(readerElements["plan-outline"].hidden, false);
assert.equal(readerElements["plan-reader"].classList.contains("plan-reader--sidebar-collapsed"), false);
assert.equal(readerElements["plan-navigation-sidebar-button"].attributes["aria-expanded"], "true");
assert.equal(readerElements["plan-navigation-sidebar-button"].sidebarLabel.textContent, "Hide navigation");

const contextLayout = readerElement();
const contextSidebar = readerElement();
const contextButton = readerElement();
const { setContextSidebarCollapsed } = new Function(
  "document",
  `let navigationSidebarCollapsed=false,contextSidebarCollapsed=false;${helperSource}; return { setContextSidebarCollapsed };`,
)({
  querySelector(selector) {
    assert.equal(selector, ".plan-layout");
    return contextLayout;
  },
  getElementById(id) {
    if (id === "workflow-context-sidebar") return contextSidebar;
    if (id === "context-sidebar-button") return contextButton;
    throw new Error(`Unexpected context sidebar element: ${id}`);
  },
});
setContextSidebarCollapsed(true);
assert.equal(contextSidebar.hidden, true);
assert.equal(contextLayout.classList.contains("plan-layout--context-collapsed"), true);
assert.equal(contextButton.attributes["aria-expanded"], "false");
assert.equal(contextButton.sidebarLabel.textContent, "Show context");
setContextSidebarCollapsed(false);
assert.equal(contextSidebar.hidden, false);
assert.equal(contextLayout.classList.contains("plan-layout--context-collapsed"), false);
assert.equal(contextButton.attributes["aria-expanded"], "true");
assert.equal(contextButton.sidebarLabel.textContent, "Hide context");

let activeButtonRect = { top: 220, bottom: 250, left: 110, right: 190 };
const outlineScroller = {
  scrollHeight: 400,
  clientHeight: 100,
  scrollTop: 20,
  getBoundingClientRect() { return { top: 100, bottom: 200 }; },
};
const outlineElement = {
  scrollWidth: 100,
  clientWidth: 100,
  scrollLeft: 0,
  querySelector() { return outlineScroller; },
  getBoundingClientRect() { return { left: 100, right: 200 }; },
};
const { revealOutlineButton } = new Function(
  "document",
  `${helperSource}; return { revealOutlineButton };`,
)({
  getElementById(id) {
    assert.equal(id, "plan-outline");
    return outlineElement;
  },
});
const activeButton = { getBoundingClientRect() { return activeButtonRect; } };
revealOutlineButton("plan", activeButton);
assert.equal(outlineScroller.scrollTop, 70);
activeButtonRect = { top: 70, bottom: 90, left: 110, right: 190 };
revealOutlineButton("plan", activeButton);
assert.equal(outlineScroller.scrollTop, 40);
outlineScroller.scrollHeight = 100;
outlineElement.scrollWidth = 400;
outlineElement.scrollLeft = 10;
activeButtonRect = { top: 110, bottom: 140, left: 230, right: 270 };
revealOutlineButton("plan", activeButton);
assert.equal(outlineElement.scrollLeft, 80);
activeButtonRect = { top: 110, bottom: 140, left: 70, right: 90 };
revealOutlineButton("plan", activeButton);
assert.equal(outlineElement.scrollLeft, 50);

const before = `# Delivery plan

## Steps

1. Keep **formatted text**
2. Show raw source

\`\`\`js
const view = "raw";
\`\`\``;
const after = `# Delivery plan

## Steps

1. Keep **formatted text**
2. Show a rich diff

\`\`\`js
const view = "rich";
\`\`\``;
const richDiff = renderRichDiff(lineDiff(before, after), before, after);
assert.ok(richDiff.includes('<h2 class="diff-line context">Steps</h2>'));
assert.ok(richDiff.includes('<strong>formatted text</strong>'));
assert.match(richDiff, /<li class="diff-line remove"[^>]* value="2">Show raw source<\/li>/);
assert.match(richDiff, /<li class="diff-line add"[^>]* value="2">Show a rich diff<\/li>/);
assert.ok(richDiff.includes('<span class="diff-code-line remove">const view = &quot;raw&quot;;</span>'));
assert.ok(richDiff.includes('<span class="diff-code-line add">const view = &quot;rich&quot;;</span>'));
assert.equal(richDiff.match(/data-diff-block-index=/g)?.length, 1, "nearby list and code changes form one block");
const contextRow = { kind: "context", old: 1, new: 1, text: "same" };
const changedRow = { kind: "add", old: null, new: 1, text: "changed" };
assert.deepEqual([...diffBlockStartIndexes([changedRow, ...Array(6).fill(contextRow), changedRow]).entries()], [[0, 0]]);
assert.deepEqual([...diffBlockStartIndexes([changedRow, ...Array(7).fill(contextRow), changedRow]).entries()], [[0, 0], [8, 1]]);

const diffAnchors = [0, 1].map(() => {
  const classes = new Set();
  return {
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
    focus(options) { this.focusOptions = options; },
    scrollIntoView(options) { this.scrollOptions = options; },
  };
});
const diffButtons = { "diff-previous-block": {}, "diff-next-block": {} };
const diffNavigation = new Function(
  "document",
  `let currentDiffBlockIndex=-1;${helperSource}; return { moveDiffBlock, updateDiffBlockNavigation };`,
)({
  querySelectorAll(selector) { assert.equal(selector, "[data-diff-block-index]"); return diffAnchors; },
  getElementById(id) { return diffButtons[id]; },
});
diffNavigation.updateDiffBlockNavigation();
assert.equal(diffButtons["diff-previous-block"].disabled, true);
assert.equal(diffButtons["diff-next-block"].disabled, false);
diffNavigation.moveDiffBlock(1);
assert.equal(diffAnchors[0].classList.contains("diff-block--active"), true);
assert.deepEqual(diffAnchors[0].focusOptions, { preventScroll: true });
assert.deepEqual(diffAnchors[0].scrollOptions, { block: "start", behavior: "auto" });
diffNavigation.moveDiffBlock(1);
assert.equal(diffAnchors[0].classList.contains("diff-block--active"), false);
assert.equal(diffAnchors[1].classList.contains("diff-block--active"), true);
assert.equal(diffButtons["diff-next-block"].disabled, true);
diffNavigation.moveDiffBlock(-1);
assert.equal(diffAnchors[0].classList.contains("diff-block--active"), true);

const structuredPlan = `# Delivery plan

## Goal

Ship a guided reader.

## Planned Changes

### Parse the plan

**What**: Split structured sections.

\`\`\`text
### This is code, not another change
\`\`\`

### Render each change

**Why**: Readers can focus on one idea.

## Testing

Verify guided and full-document modes.`;
const structure = parsePlanStructure(structuredPlan);
assert.equal(structure.canUseGuidedView, true);
assert.equal(structure.title, "Delivery plan");
assert.equal(structure.goal, "Ship a guided reader.");
assert.equal(structure.changes.length, 2);
assert.equal(structure.changes[0].title, "Parse the plan");
assert.ok(structure.changes[0].content.includes("This is code, not another change"));
assert.equal(structure.changes[1].id, "change-2-render-each-change");
assert.equal(structure.testing, "Verify guided and full-document modes.");
const tildeStructure = parsePlanStructure(structuredPlan.replaceAll("```", "~~~~"));
assert.equal(tildeStructure.changes.length, 2, "tilde-fenced headings are not planned changes");
const nestedFenceStructure = parsePlanStructure(structuredPlan.replace("```text", "````text\n```").replace("```\n\n### Render", "```\n````\n\n### Render"));
assert.equal(nestedFenceStructure.changes.length, 2, "shorter code fences cannot close longer fences");
const legacyStructure = parsePlanStructure("# Legacy plan\n\nOne long document.");
assert.equal(legacyStructure.canUseGuidedView, false);
assert.equal(legacyStructure.title, "Legacy plan");
assert.equal(hashReaderDestination("#review/full", "review"), "full");
assert.equal(hashReaderDestination("#plan/testing", "plan"), "testing");
assert.equal(initialViewForHash("#review/testing", "plan", true), "review");
assert.equal(initialViewForHash("#review", "plan", false), "plan");
assert.equal(initialViewForHash("#compare", "plan", true), "diff");
assert.equal(initialViewForHash("#plan/change-1-parse", "review", true), "plan");
assert.equal(initialViewForHash("", "review", true), "review");
assert.equal(initialViewForHash("", "diff", false), "diff");

// The render entrypoint, not only the disk writer, must normalize every version.
function snapshotFromHtml(rendered) {
  const serialized = /<template id="dashboard-data">([\s\S]*?)<\/template>/.exec(rendered)?.[1];
  assert.ok(serialized);
  return JSON.parse(serialized.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot);/gi, (_entity, code) => {
    if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"' }[code];
  }));
}
const graphNodes = [
  { id: "PC-01", title: "Read shared schema", dependsOn: ["PC-03"] }, // Forward references are not reading order.
  { id: "PC-02", title: "Render graph", dependsOn: ["PC-03"] },
  { id: "PC-03", title: "Define shared schema", dependsOn: [] },
  { id: "PC-04", title: "Integrate both branches", dependsOn: ["PC-01", "PC-02"] },
  { id: "PC-05", title: "Independent documentation", dependsOn: [] },
  { id: "PC-06", title: 'Escape "quotes" <script>alert(1)</script> %%{init: evil}%% `text` & labels', dependsOn: ["PC-04"] },
];
function planWithNodes(nodes) {
  return '# Dependency plan\n\n## Goal\n\nShip the graph.\n\n## Planned Changes\n\n' + nodes.map((node) =>
    `### ${node.id}: ${node.title}\n\n**Depends on**\n\n${node.dependsOn.join(", ") || "None"}\n\n**What**\n\nImplement **${node.id}** safely.\n\n**Why**\n\nKeep readers informed.\n`,
  ).join("\n") + '\n## Testing\n\nVerify the graph and legacy reader.\n';
}
const graphPlan = planWithNodes(graphNodes);
const invalidGraphPlan = graphPlan.replace("PC-01, PC-02", "PC-99");
const graphData = {
  ...data,
  versions: [data.versions[0], { number: 2, createdAt: data.generatedAt, content: invalidGraphPlan }, { number: 3, createdAt: data.generatedAt, content: graphPlan }],
};
const serializedBeforeRender = JSON.stringify(graphData);
const graphHtml = renderWorkflowDashboard(graphData);
const normalized = snapshotFromHtml(graphHtml);
assert.equal(JSON.stringify(graphData), serializedBeforeRender, "normalization must not mutate callers' snapshots");
assert.equal(normalized.versions[0].dependencyGraph.status, "unavailable");
assert.ok(!Object.hasOwn(normalized.versions[0], "changeDetails"));
assert.equal(normalized.versions[1].dependencyGraph.status, "unavailable");
assert.match(normalized.versions[1].dependencyGraph.reason, /PC-99/);
const graph = normalized.versions[2].dependencyGraph;
assert.deepEqual(graph, { status: "valid", nodes: graphNodes });
assert.ok(!Object.hasOwn(normalized.versions[2], "changeDetails"), "graph snapshots no longer duplicate change details");
assert.ok(!graphHtml.includes('<script>alert(1)</script>'));
assert.deepEqual(snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [] })).versions, []);
const staleGraph = { ...data.versions[0], dependencyGraph: graph };
assert.equal(snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [staleGraph] })).versions[0].dependencyGraph.status, "unavailable", "caller-provided graph data is not trusted");
const legacyGraph = snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [{ ...data.versions[0], content: graphPlan.replace(/\*\*Depends on\*\*\n\n[^\n]+\n\n/g, "") }] })).versions[0].dependencyGraph;
assert.equal(legacyGraph.status, "unavailable", "missing legacy dependencies must not imply an edgeless graph");
const diagram = generateDependencyDiagram(graph);
assert.ok(diagram.startsWith("flowchart TD\n"));
assert.equal(diagram.match(/dag_\d+\["/g)?.length, graphNodes.length, "roots and isolated nodes are rendered explicitly");
assert.ok(diagram.includes("dag_2 --> dag_0"), "edges point from prerequisite to dependent");
assert.ok(!diagram.includes("dag_0 --> dag_2"));
assert.equal(diagram.match(/ --> /g)?.length, 5);
assert.ok(diagram.includes("dag_4["), "isolated node is present");
assert.ok(!diagram.includes("%%{init:"));
assert.ok(!diagram.includes("<script>"));
assert.ok(!diagram.includes('"quotes"'));
assert.ok(!diagram.includes("click "));
assert.ok(diagram.includes("#34;quotes#34;"));
assert.equal(mermaidGraphText('"<>`&#;\\'), "#34;#60;#62;#96;#38;#35;#59;#92;");
assert.ok(wrapGraphTitle("x".repeat(140)).every((line) => line.length <= 28));
assert.equal(wrapGraphTitle("x".repeat(140)).join(""), "x".repeat(140), "long labels are wrapped, never truncated");
assert.ok(wrapGraphTitle("😀".repeat(80)).every((line) => Array.from(line).length <= 28));
assert.equal(generateDependencyDiagram(legacyGraph), "");
assert.deepEqual([...dependencyRelations(graph, "PC-04").ancestors].sort(), ["PC-01", "PC-02", "PC-03"]);
assert.deepEqual([...dependencyRelations(graph, "PC-03").downstream].sort(), ["PC-01", "PC-02", "PC-04", "PC-06"]);
assert.equal(dependencyRelations(graph, "PC-05").ancestors.size, 0);
assert.equal(dependencyRelations(graph, "PC-05").downstream.size, 0);
assert.equal(dependencyRelations(legacyGraph, "PC-01").ancestors.size, 0);
const graphStructure = parsePlanStructure(graphPlan);
const sectionHelpers = new Function("latestPlan", "planStructure", "marked", `${helperSource};return { renderPlanGraph, renderDependencyRelations, renderPlanDestination };`)(normalized.versions[2], graphStructure, marked);
const graphSection = sectionHelpers.renderPlanGraph();
assert.ok(graphSection.includes('class="dependency-legend"'));
assert.match(graphSection, /Drawing dependency graph…<\/p><\/div><\/section>$/, "the graph canvas is the last element in its section");
assert.ok(!graphSection.includes("Selected change"));
assert.ok(!graphSection.includes("Dependency list"));
const changeSection = sectionHelpers.renderPlanDestination({ kind: "change", change: graphStructure.changes[0] });
assert.ok(changeSection.includes("<strong>What</strong>"));
assert.ok(changeSection.includes("<strong>Why</strong>"));
assert.ok(changeSection.includes("Implement <strong>PC-01</strong> safely."), "planned-change details remain in their own guided section");
const guidedLinks = sectionHelpers.renderDependencyRelations(graph, "PC-04");
assert.ok(guidedLinks.includes('href="#plan/change-1-pc-01-read-shared-schema"'));
assert.ok(guidedLinks.includes("PC-06</a>"));
assert.equal(hashReaderDestination("#plan-graph", "plan"), "graph");
assert.equal(hashReaderDestination("#plan-graph/PC-02", "plan"), "graph/PC-02");
assert.equal(hashReaderDestination("#plan/graph/PC-02", "plan"), "graph/PC-02");
assert.equal(hashReaderDestination("#plan/PC-02", "plan"), "PC-02");
assert.equal(initialViewForHash("#plan-graph", "review", true), "plan");
assert.equal(planModeForState(null, undefined, true), "guided", "new visits start at Goal in Guided view");
assert.equal(planModeForState(null, "guided", true), "guided");
assert.equal(planModeForState(null, "full", true), "full");
assert.equal(planModeForState("goal", "graph", true), "guided");
assert.equal(planModeForState("PC-02", "graph", true), "guided");
assert.equal(planModeForState("graph/PC-02", "full", true), "guided");
assert.equal(planModeForState(null, "graph", true), "guided", "restore old Graph mode as Guided view");
assert.equal(planModeForState(null, undefined, false), "full");
assert.equal(planModeForState("graph", "full", false), "full", "unstructured legacy documents retain the full-document fallback");
assert.equal(planModeForState(null, "garbage", true), "guided");
assert.equal(planDestinationForState(null, undefined, undefined), "goal");
assert.equal(planDestinationForState(null, "graph", "goal"), "graph");
assert.equal(planDestinationForState("goal", "graph", "graph"), "goal");
assert.equal(planDestinationForState("graph/PC-02", "full", "goal"), "graph/PC-02");
assert.equal(planDestinationForState(null, "guided", "graph"), "graph");
assert.equal(planDestinationForState("full", "guided", "graph"), "graph");
const guidedDestinations = createPlanDestinations(graphStructure);
assert.deepEqual(guidedDestinations.map((section) => section.kind), ["goal", "graph", ...graphNodes.map(() => "change"), "testing"]);
assert.equal(guidedDestinations[1].id, "graph");
assert.equal(guidedDestinations[1].label, "Dependency graph");
assert.deepEqual(createPlanDestinations({ canUseGuidedView: false }), []);
assert.deepEqual(dependencyChanges(graph, graph), { addedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
const changedGraph = { status: "valid", nodes: graphNodes.map((node) => node.id === "PC-04" ? { ...node, dependsOn: ["PC-03"] } : node) };
assert.deepEqual(dependencyChanges(graph, changedGraph), { addedNodes: [], removedNodes: [], addedEdges: ["PC-03 → PC-04"], removedEdges: ["PC-01 → PC-04", "PC-02 → PC-04"] });
assert.deepEqual(dependencyChanges(graph, { status: "valid", nodes: graph.nodes.slice(0, -1) }), { addedNodes: [], removedNodes: ["PC-06"], addedEdges: [], removedEdges: ["PC-04 → PC-06"] });
assert.equal(dependencyChanges(legacyGraph, graph), null);
assert.ok(renderDependencyChanges(legacyGraph, graph).includes("comparison unavailable"));
assert.ok(renderDependencyChanges(graph, graph).includes("No dependency changes"));
assert.ok(renderDependencyChanges(graph, changedGraph).includes("Dependency removed: PC-01 → PC-04"));

// Exercise the browser-owned SVG handlers and async rendering without trusting Mermaid callbacks.
const graphElements = {};
for (const id of ["plan-content", "plan-pagination", "plan-dependency-canvas", "plan-reader", "plan-outline", "plan-navigation-sidebar-button", "plan-guided-mode-button", "plan-full-mode-button", "plan-position", "plan-previous-section", "plan-next-section"]) graphElements[id] = readerElement();
const svg = { ...readerElement(), style: {}, viewBox: { baseVal: { width: 960, height: 820 } } };
const svgNodes = graph.nodes.map(() => ({ ...readerElement(), listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } }));
graphElements["plan-dependency-canvas"].querySelector = (selector) => selector === "svg" ? svg : svgNodes[Number(/dag-node-(\d+)/.exec(selector)?.[1])];
let mermaidOptions, mermaidSource, boundCallbacks = 0;
const mermaidStub = {
  initialize(options) { mermaidOptions = options; },
  async render(_id, source) { mermaidSource = source; return { svg: "<svg>trusted generated graph</svg>", bindFunctions() { boundCallbacks++; } }; },
};
const graphDocument = {
  documentElement: { dataset: { theme: "dark" } },
  getElementById(id) { return graphElements[id]; },
  querySelectorAll() { return []; },
};
const graphBrowser = new Function("latestPlan", "planStructure", "globalThis", "document", "location", "history", "marked", `let selectedGraphNode="PC-04",graphRenderSequence=0,navigationSidebarCollapsed=false;const readers={plan:{mode:"guided",currentDestination:"graph",destinations:[{id:"goal"},{id:"graph"}]}};${helperSource};return { renderDependencyGraphDiagram, renderPlanGraph, selectGraphNode, handleDependencyNavigation, configureReader, createPlanDestinations, renderPlanDestination, renderFullPlan, renderReader, setReaderMode, moveReader, readers };`)(normalized.versions[2], graphStructure, { mermaid: mermaidStub }, graphDocument, fakeLocation, fakeHistory, marked);
await graphBrowser.renderDependencyGraphDiagram(graph);
assert.equal(mermaidOptions.securityLevel, "strict");
assert.equal(mermaidOptions.theme, "dark");
assert.equal(mermaidOptions.htmlLabels, false, "root htmlLabels takes precedence in newer Mermaid releases");
assert.equal(mermaidOptions.flowchart.htmlLabels, false);
assert.equal(mermaidSource, diagram);
assert.equal(boundCallbacks, 0);
assert.equal(svg.style.width, "100%", "graphs fit the guided column when there is enough room");
assert.equal(svg.style.maxWidth, "960px");
assert.equal(svg.style.minWidth, "720px", "labels never shrink below 75%; narrow screens scroll instead");
assert.equal(svg.style.height, "auto");
assert.equal(svgNodes[0].attributes.role, "button");
assert.equal(svgNodes[0].attributes.tabindex, "0");
assert.match(svgNodes[0].attributes["aria-label"], /Requires: PC-03/);
assert.equal(svgNodes[3].classList.contains("graph-node--selected"), true);
assert.equal(svgNodes[2].classList.contains("graph-node--ancestor"), true);
assert.equal(svgNodes[5].classList.contains("graph-node--downstream"), true);
svgNodes[2].listeners.click();
assert.equal(svgNodes[2].classList.contains("graph-node--selected"), true);
assert.equal(svgNodes[3].classList.contains("graph-node--downstream"), true);
assert.match(svgNodes[2].attributes["aria-label"], /Highlight prerequisites and downstream changes/);
assert.ok(fakeLocation.href.endsWith("#plan/graph/PC-03"));
let preventedKey = false;
svgNodes[4].listeners.keydown({ key: " ", preventDefault() { preventedKey = true; } });
assert.equal(preventedKey, true);
assert.equal(svgNodes[4].attributes["aria-pressed"], "true");
assert.equal(svgNodes[3].classList.contains("graph-node--downstream"), false);
const selectedHash = fakeLocation.href;
graphBrowser.selectGraphNode('PC-99" onclick="evil');
assert.equal(fakeLocation.href, selectedHash, "unknown node IDs cannot drive browser navigation");
assert.equal(svgNodes[4].attributes["aria-pressed"], "true");
mermaidStub.render = async () => { throw new Error("offline"); };
await graphBrowser.renderDependencyGraphDiagram(graph);
assert.match(graphElements["plan-dependency-canvas"].innerHTML, /role="status"/);
assert.match(graphElements["plan-dependency-canvas"].innerHTML, /Use the plan outline or Next/);
assert.ok(!graphElements["plan-dependency-canvas"].innerHTML.includes("below"), "render failures do not refer to the removed list");
const pendingRenders = [];
mermaidStub.render = () => new Promise((resolve) => pendingRenders.push(resolve));
const oldRender = graphBrowser.renderDependencyGraphDiagram(graph);
await Promise.resolve();
const newRender = graphBrowser.renderDependencyGraphDiagram(graph);
await Promise.resolve();
pendingRenders[1]({ svg: "new render" });
await newRender;
pendingRenders[0]({ svg: "stale render" });
await oldRender;
assert.equal(graphElements["plan-dependency-canvas"].innerHTML, "new render", "stale async renders cannot replace a newer theme or selection");
const unavailableBrowser = new Function("latestPlan", `${helperSource};return {renderPlanGraph};`)({ dependencyGraph: { status: "unavailable", reason: '<script>unsafe legacy reason</script>' } });
const unavailableSection = unavailableBrowser.renderPlanGraph();
assert.match(unavailableSection, /Graph unavailable/);
assert.match(unavailableSection, /&lt;script&gt;/);
assert.ok(!unavailableSection.includes("<script>"));
assert.match(unavailableSection, /data-graph-fallback="full"/);
assert.ok(!unavailableSection.includes('data-graph-fallback="guided"'));

// The graph participates in the same guided sequence, sidebar, pagination and saved state as prose.
mermaidStub.render = async () => ({ svg: "<svg>guided graph</svg>" });
graphBrowser.configureReader("plan", guidedDestinations, graphBrowser.renderPlanDestination, graphBrowser.renderFullPlan);
graphBrowser.setReaderMode("plan", "guided", "goal", false);
assert.equal(graphElements["plan-next-section"].dataset.destination, "graph");
graphBrowser.moveReader("plan", 1, false);
assert.equal(graphBrowser.readers.plan.mode, "guided");
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.equal(graphElements["plan-outline"].hidden, false);
assert.equal(graphElements["plan-pagination"].hidden, false);
assert.equal(graphElements["plan-position"].textContent, "Dependency graph");
assert.equal(graphElements["plan-previous-section"].dataset.destination, "goal");
assert.equal(graphElements["plan-next-section"].dataset.destination, guidedDestinations[2].id);
assert.equal(graphElements["plan-reader"].classList.contains("plan-reader--dependencies"), true);
assert.equal(graphElements["plan-guided-mode-button"].attributes["aria-pressed"], "true");
assert.match(graphElements["plan-content"].innerHTML, /id="plan-dependency-graph"/);
graphBrowser.selectGraphNode("PC-03");
assert.equal(graphBrowser.readers.plan.currentDestination, "graph", "node selection does not replace the guided destination");
graphBrowser.moveReader("plan", 1, false);
assert.equal(graphBrowser.readers.plan.currentDestination, guidedDestinations[2].id);
assert.equal(graphElements["plan-previous-section"].dataset.destination, "graph");
assert.equal(graphElements["plan-reader"].classList.contains("plan-reader--dependencies"), false);
graphBrowser.moveReader("plan", -1, false);
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.ok(fakeLocation.href.endsWith("#plan/graph/PC-03"), "returning to the graph keeps node selection");
graphBrowser.renderReader("plan", "graph/PC-02", false);
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.ok(fakeLocation.href.endsWith("#plan/graph/PC-02"));
graphBrowser.setReaderMode("plan", "full");
assert.equal(graphElements["plan-reader"].classList.contains("plan-reader--dependencies"), false);
assert.equal(graphElements["plan-pagination"].hidden, true);
graphBrowser.setReaderMode("plan", "guided", undefined, false);
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.equal(graphElements["plan-pagination"].hidden, false);

console.log("Dashboard test passed: normalized DAGs, safe graph navigation, legacy fallback, plan/review readers, and semantic version comparison.");
