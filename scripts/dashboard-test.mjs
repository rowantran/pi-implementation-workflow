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
    version: 1,
    pullRequestUrl: "https://example.test/pull/1",
    baseCommit: "abc123",
    headCommit: "def456",
    generatedAt: "2026-01-03T00:00:00.000Z",
    overallResult: {
      summary: 'Necessary and sufficient <script>alert("review")</script>.',
      necessary: { status: "yes", explanation: "Within scope." },
      sufficient: { status: "yes", explanation: "Complete." },
    },
    overallConcerns: [],
    plannedChanges: [{
      id: "PC-01",
      title: "Render the review",
      what: "Show the report.",
      why: "Make review easy.",
      pseudocode: "render(report)",
      review: {
        id: "PC-01",
        title: "Render the review",
        summary: "The dashboard renders it.",
        necessary: { status: "yes", explanation: "Required." },
        sufficient: { status: "yes", explanation: "Complete." },
        contracts: [{
          name: "WorkflowReviewReport",
          kind: "interface",
          signature: "interface WorkflowReviewReport {}",
          fields: [],
          constructionSites: [],
          consumers: [],
          bridges: [],
          assessment: "Matches the plan.",
        }],
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

assert.ok(html.startsWith("<!doctype html>"));
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
assert.ok(
  html.includes(
    'const dashboard = JSON.parse(document.getElementById("dashboard-data").content.textContent);',
  ),
);
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
assert.equal(html.match(/aria-keyshortcuts="P"/g)?.length, 2);
assert.equal(html.match(/aria-keyshortcuts="N"/g)?.length, 2);
assert.ok(html.includes('key==="p"'));
assert.ok(html.includes('key==="n"'));
assert.ok(html.indexOf('id="plan-pagination"') < html.indexOf('id="plan-content"'));
assert.ok(html.indexOf('id="review-pagination"') < html.indexOf('id="review-content"'));
assert.ok(html.includes("function renderReader(name,destination,focusContent)"));
assert.ok(html.includes("function setReaderMode(name,mode,destination,focusContent)"));
assert.ok(html.includes("function renderFullReview()"));
assert.ok(html.includes("moveReader(name,offset,true)"));
assert.ok(html.includes("heading.focus({preventScroll:true})"));
assert.ok(html.includes('heading.scrollIntoView({block:"start"})'));
assert.ok(html.includes('id="review-tab" data-view="review"'));
assert.ok(html.includes('aria-label="Review outline"'));
assert.ok(html.includes('class="card review-card"'));
assert.ok(html.includes('class="markdown review-document"'));
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
assert.ok(!html.includes('class="diff-table"'));
const dashboardScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(dashboardScript);
assert.doesNotThrow(() => new Function(dashboardScript));
const helperSource = dashboardScript.slice(
  dashboardScript.indexOf("function escapeHtml"),
  dashboardScript.indexOf("function initialize"),
);
const { hashReaderDestination, initialViewForHash, lineDiff, parsePlanStructure, renderRichDiff } = new Function(
  `${helperSource}; return { hashReaderDestination, initialViewForHash, lineDiff, parsePlanStructure, renderRichDiff };`,
)();
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
const testingReview = renderReviewDestination({ kind: "testing" });
assert.ok(testingReview.includes("Testing criteria"));
assert.ok(testingReview.includes("Run the dashboard test and inspect the report."));
assert.ok(testingReview.includes("scripts/dashboard-test.mjs:1"));

function readerElement() {
  return {
    className: "",
    innerHTML: "",
    textContent: "",
    hidden: true,
    disabled: false,
    dataset: {},
    classList: { toggle() {} },
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
  };
}
const readerElements = {};
for (const name of ["plan", "review"]) {
  for (const suffix of ["content", "previous-section", "next-section", "position", "pagination", "reader", "outline", "guided-mode-button", "full-mode-button"]) {
    readerElements[`${name}-${suffix}`] = readerElement();
  }
}
const readerButtons = ["plan", "review"].flatMap((name) => ["first", "second"].map((destination) => ({
  dataset: { reader: name, readerDestination: destination },
  classList: { toggle() {} },
  setAttribute() {},
  removeAttribute() {},
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
const readerHelpers = new Function(
  "readers",
  "document",
  "location",
  "history",
  "requestAnimationFrame",
  `${helperSource}; return { configureReader, moveReader, renderReader, setReaderMode };`,
)(readerStore, fakeReaderDocument, fakeLocation, fakeHistory, (callback) => callback());
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
assert.ok(richDiff.includes('<li class="diff-line remove" value="2">Show raw source</li>'));
assert.ok(richDiff.includes('<li class="diff-line add" value="2">Show a rich diff</li>'));
assert.ok(richDiff.includes('<span class="diff-code-line remove">const view = &quot;raw&quot;;</span>'));
assert.ok(richDiff.includes('<span class="diff-code-line add">const view = &quot;rich&quot;;</span>'));

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

console.log("Dashboard test passed: review documents, plan navigation, safe content, and rich version comparisons render correctly.");
