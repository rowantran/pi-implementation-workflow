import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

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
assert.ok(html.includes("function renderRichDiff(rows, before, after)"));
assert.ok(html.includes("function parsePlanStructure(markdown)"));
assert.ok(html.includes('id="plan-guided-mode-button"'));
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
assert.ok(html.includes('initialView=unseenReview ? "review"'));
assert.ok(!html.includes('<script>alert("review")</script>'));
assert.ok(html.includes('class="markdown diff-document"'));
assert.ok(html.includes("renderRichDiff(rows,before.content,after.content)"));
assert.ok(html.includes('id="diff-previous-block"'));
assert.ok(html.includes('id="diff-next-block"'));
assert.ok(html.includes("function diffBlockStartIndexes(rows, contextLines = 3)"));
assert.ok(html.includes("function moveDiffBlock(offset)"));
assert.ok(!html.includes('class="diff-table"'));
const dashboardScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(dashboardScript);
assert.doesNotThrow(() => new Function(dashboardScript));
const helperSource = dashboardScript.slice(
  dashboardScript.indexOf("function escapeHtml"),
  dashboardScript.indexOf("function initialize"),
);
const { diffBlockStartIndexes, hashReaderDestination, initialViewForHash, lineDiff, parsePlanStructure, renderMarkdown, renderRichDiff } = new Function(
  `${helperSource}; return { diffBlockStartIndexes, hashReaderDestination, initialViewForHash, lineDiff, parsePlanStructure, renderMarkdown, renderRichDiff };`,
)();
const softWrappedMarkdown = `A paragraph with **strong text** wraps
onto a second source line.

A second paragraph.`;
assert.equal(
  renderMarkdown(softWrappedMarkdown),
  "<p>A paragraph with <strong>strong text</strong> wraps onto a second source line.</p><p>A second paragraph.</p>",
);
const softWrappedList = `- A list item wraps
  onto a second source line.
- A second item.`;
assert.equal(
  renderMarkdown(softWrappedList),
  "<ul><li>A list item wraps onto a second source line.</li><li>A second item.</li></ul>",
);
const { renderReviewDestination } = new Function(
  "dashboard",
  `${helperSource}; return { renderReviewDestination };`,
)(data);
const overallReview = renderReviewDestination({ kind: "overall" });
assert.ok(overallReview.includes("Overall result"));
assert.ok(overallReview.includes("&lt;script&gt;alert(&quot;review&quot;)&lt;/script&gt;"));
const plannedChangeReview = renderReviewDestination({ kind: "change", number: 1, change: data.review.plannedChanges[0] });
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

console.log("Dashboard test passed: plan, review, and grouped diff navigation render and behave correctly.");
