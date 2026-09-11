import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanDocument } from "./fixtures/plan-document.mjs";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti/static";
import { marked } from "marked";

// Exercise the same precompiled browser library that the HTTP server serves.
globalThis.hljs = runInNewContext(readFileSync(new URL(import.meta.resolve("@highlightjs/cdn-assets/highlight.min.js")), "utf8") + ";hljs;");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderWorkflowDashboard, writeWorkflowDashboard } = await jiti.import(
  new URL("../src/dashboard.ts", import.meta.url).pathname,
);

const { renderPlanMarkdown } = await jiti.import(new URL('../src/planned-changes.ts', import.meta.url).pathname);
function planWithNodes(nodes, overrides = {}) {
  return {
    schemaVersion: 1,
    readingOrder: nodes.map((node) => node.id),
    goal: 'Ship the graph.',
    testing: 'Verify the graph and guided reader.',
    changes: nodes.map((node) => ({ content: `Implement **${node.id}** safely.\n\n### A heading inside freeform prose\n\nNo prescribed fields are needed.`, ...node })),
    ...overrides,
  };
}
function version(document, number = 1) {
  return { number, createdAt: '2025-01-02T03:04:05.000Z', content: renderPlanMarkdown(document), document };
}
const baseDocument = planWithNodes([{ id: 'render-review', title: 'Render the review', dependsOn: [], content: 'Render </template><script>unsafe</script> content.' }]);
const data = {
  slug: 'example</title><script>alert("unsafe")</script>',
  description: "Extract the dashboard template",
  ask: 'First line\n\nSecond </template><script>alert("ask")</script> line.',
  generatedAt: "2025-01-02T03:04:05.000Z",
  versions: [version(baseDocument)],
  clarifications: [],
  reviewStale: false,
  review: {
    version: 3,
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
      id: "render-review",
      title: "Render the review",
      dependsOn: [],
      content: "Show the **report**, so review is easy.\n\n```ts\nrender(report)\n```",
      review: {
        id: "render-review",
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
assert.ok(html.includes('src="../assets/highlight.min.js"'));
assert.ok(html.indexOf('src="../assets/highlight.min.js"') < html.indexOf('<script id="dashboard-app">'));
assert.ok(html.includes('.markdown .hljs-keyword'));
assert.equal(html.match(/--syntax-keyword:/g)?.length, 2, 'light and dark themes define syntax colors');
assert.ok(html.includes('new URL("../assets/mermaid.min.js",location.href)'));
assert.ok(html.includes("function loadMermaidLibrary()"));
assert.ok(html.includes('function renderMarkdown(markdown,context)'));
assert.ok(html.includes("new marked.Renderer()"));
assert.ok(html.includes("function renderMermaidDiagrams(root)"));
assert.ok(html.includes('library.run({nodes:nodes,suppressErrors:true})'));
assert.ok(html.includes('function renderRichDiff(rows, before, after, contexts)'));
assert.ok(html.includes("function planDocumentStructure(document)"));
assert.ok(!html.includes('parsePlanStructure'), 'generated Markdown is not parsed for plan structure');
assert.ok(!html.includes('id="plan-graph-mode-button"'), "Graph is a guided section, not a reading mode");
assert.ok(html.includes('data-reader="plan" data-reader-destination="graph">Dependency graph</button>'));
assert.ok(html.includes('id="plan-intro-link" type="button" data-reader="plan" data-reader-destination="intro" hidden>Introduction</button>'));
assert.ok(html.includes("document.getElementById('plan-intro-link').hidden=!destinations.some(function(section){return section.kind==='intro';});"));
assert.ok(html.includes('id="plan-version"'));
assert.ok(html.includes('id="implementation-summary"'));
assert.ok(!html.includes('/workflow-revise'));
assert.ok(html.indexOf('data-reader-destination="goal"') < html.indexOf('data-reader-destination="intro"'));
assert.ok(html.indexOf('data-reader-destination="intro"') < html.indexOf('data-reader-destination="graph"'));
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
assert.ok(html.includes('function comparePlanDocuments(before,after)'));
assert.ok(html.includes('function renderPlanComparison(before,after)'));
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
const { comparePlanDocuments, createReviewDestinations, createPlanDestinations, dependencyChanges, dependencyRelations, diffBlockStartIndexes, generateDependencyDiagram, hashReaderDestination, initialViewForHash, lineDiff, mermaidGraphText, planDocumentStructure, planModeForState, planDestinationForState, renderDependencyChanges, renderMarkdown, renderPlanComparison, renderRichDiff, wrapGraphTitle } = new Function(
  "marked",
  `${helperSource}; return { comparePlanDocuments, createReviewDestinations, createPlanDestinations, dependencyChanges, dependencyRelations, diffBlockStartIndexes, generateDependencyDiagram, hashReaderDestination, initialViewForHash, lineDiff, mermaidGraphText, planDocumentStructure, planModeForState, planDestinationForState, renderDependencyChanges, renderMarkdown, renderPlanComparison, renderRichDiff, wrapGraphTitle };`,
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
// Explicit languages and standard aliases work in every Markdown renderer.
for (const [language, source, token] of [
  ['typescript', 'interface Plan { count: number }', 'keyword'],
  ['ts', 'interface Plan { count: number }', 'keyword'],
  ['JS title="example"', 'const count = 1;', 'keyword'],
  ['bash', 'echo "$HOME"', 'string'],
  ['python', 'def run():\n    return True', 'keyword'],
  ['json', '{"count": 1}', 'attr'],
  ['html', '<div title="code">safe</div>', 'tag'],
]) {
  const code = renderMarkdown('```' + language + '\n' + source + '\n```');
  assert.ok(code.includes(`class="hljs-${token}"`), language);
  assert.ok(code.includes('class="hljs language-' + language.toLowerCase().split(' ')[0] + '"'));
}
assert.ok(renderMarkdown('~~~ts\nconst n: number = 1;\n~~~').includes('hljs-keyword'));
assert.ok(renderMarkdown('```ts\nconst unfinished = "value').includes('hljs-keyword'), 'unfinished fences remain readable');
for (const language of ['', 'unknown-language', 'text', 'plaintext']) {
  const code = renderMarkdown('```' + language + '\nconst x = "<script>&";\n```');
  assert.ok(!code.includes('class="hljs-'), `${language || 'unlabeled'} code is not autodetected`);
  assert.ok(code.includes('&lt;script&gt;&amp;'));
}
assert.equal(renderMarkdown('`const x = 1`').trim(), '<p><code>const x = 1</code></p>', 'inline code is unchanged');
const unsafeCode = renderMarkdown('```html\n</code><script>alert("unsafe")</script><img src=x onerror=alert(1)>\n```');
assert.ok(unsafeCode.includes('hljs-tag'));
assert.ok(!unsafeCode.includes('<script>'));
assert.ok(!unsafeCode.includes('<img'));
assert.ok(!renderMarkdown('```ts"><img/src=x/onerror=alert(1)>\nunsafe\n```').includes('<img'));
for (const highlighter of [undefined, { getLanguage() { throw new Error('broken'); } }, { getLanguage() { return true; }, highlight() { throw new Error('broken'); } }]) {
  const fallback = new Function('marked', 'globalThis', `${helperSource};return renderMarkdown;`)(marked, { hljs: highlighter });
  assert.ok(fallback('```ts\nconst x = "<script>";\n```').includes('const x = &quot;&lt;script&gt;&quot;;'));
  assert.ok(fallback('```mermaid\nflowchart LR\nA --> B\n```').includes('class="mermaid"'), 'diagrams do not depend on the highlighter');
}
const { highlightedCodeLines, analyzeMarkdown } = new Function(`${helperSource};return { highlightedCodeLines, analyzeMarkdown };`)();
function codeText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_entity, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" })[name]);
}
const multilineSource = '/* <script> & comment\n\n  still a comment */\nconst value = `first\n${String(1)} <b>\nlast`;\n';
const highlightedLines = highlightedCodeLines(multilineSource, 'js');
assert.equal(highlightedLines.map(codeText).join('\n'), multilineSource, 'multiline highlighting preserves the exact code');
for (const line of highlightedLines) {
  let depth = 0;
  for (const tag of line.match(/<\/?span\b[^>]*>/g) || []) {
    depth += tag.startsWith('</') ? -1 : 1;
    assert.ok(depth >= 0, 'a syntax span cannot escape its diff row');
  }
  assert.equal(depth, 0, 'every highlighted row has balanced spans');
}
assert.ok(highlightedLines[2].includes('class="hljs-comment"'), 'comments retain their multiline context');
const multilineBefore = '```js\n/* before\n  old comment\n*/\nconst value = 1;\n```';
const multilineAfter = multilineBefore.replace('old comment', 'new comment');
const multilineDiff = renderRichDiff(lineDiff(multilineBefore, multilineAfter), multilineBefore, multilineAfter);
assert.match(multilineDiff, /class="diff-code-line remove"[^>]*><span class="hljs-comment">  old comment<\/span><\/span>/);
assert.match(multilineDiff, /class="diff-code-line add"[^>]*><span class="hljs-comment">  new comment<\/span><\/span>/);
for (const [beforeCode, afterCode] of [['', multilineAfter], [multilineBefore, '']]) {
  const diff = renderRichDiff(lineDiff(beforeCode, afterCode), beforeCode, afterCode);
  assert.ok(diff.includes('hljs-keyword'), 'wholly added or removed blocks are highlighted');
  assert.ok(diff.includes('data-diff-block-index="0"'), 'code changes retain diff navigation');
}
const blocks = analyzeMarkdown('~~~ts extra-info\nconst n = 1;\n~~~\n\n```text\nconst plain = 1;\n```\n\n```js\n/* unfinished\ncomment');
assert.ok(blocks[1].html.includes('hljs-keyword'));
assert.equal(blocks[5].html, 'const plain = 1;', 'separate blocks use their own language');
assert.ok(blocks.at(-1).html.includes('hljs-comment'), 'unclosed blocks keep multiline highlighting');
assert.ok(!renderMarkdown('<script>alert("unsafe")</script>').includes("<script>"));
assert.ok(!renderMarkdown("[unsafe](javascript:alert(1))").includes("javascript:"));
const diagramBefore = '```mermaid\nflowchart LR\n A --> B\n```';
const diagramAfter = '```mermaid\nflowchart LR\n A --> C\n```';
const diagramDiff = renderRichDiff(lineDiff(diagramBefore, diagramAfter), diagramBefore, diagramAfter);
assert.equal(diagramDiff.match(/class="mermaid"/g)?.length, 2, 'changed diagrams keep rich before/after renderings');
assert.ok(diagramDiff.includes('A --&gt; C'));
for (const nested of [
  '> ```ts\n> const count: number = 1;\n> ```',
  '- Example:\n\n  ```ts\n  const count: number = 1;\n  ```',
]) {
  const changed = nested.replace('= 1', '= 2');
  const diff = renderRichDiff(lineDiff(nested, changed), nested, changed);
  assert.equal(diff.match(/class="hljs-keyword"/g)?.length, 2, 'nested fences use rich highlighted before/after blocks');
  assert.ok(diff.includes('data-diff-block-index="0"'));
}
const indentedBefore = '    const x = "<script>";';
const indentedAfter = indentedBefore.replace('const', 'let');
assert.equal(renderRichDiff(lineDiff(indentedBefore, indentedAfter), indentedBefore, indentedAfter).match(/<pre><code/g)?.length, 2, 'legacy indented code stays code, without guessing a language');
const tableBefore = '| Name | State |\n| --- | --- |\n| Reader | Draft |';
const tableAfter = tableBefore.replace('Draft', 'Finalized');
assert.equal(renderRichDiff(lineDiff(tableBefore, tableAfter), tableBefore, tableAfter).match(/<table>/g)?.length, 2, 'changed tables stay tables');
const fencedBefore = '~~~~text\n### Not a heading\n~~~~';
const fencedAfter = fencedBefore.replace('Not a heading', 'Still code');
assert.match(renderRichDiff(lineDiff(fencedBefore, fencedAfter), fencedBefore, fencedAfter), /class="diff-code-line add"[^>]*>### Still code/);
const linkedBefore = '[Read](#render-review)';
const linkedAfter = '[Read the design](#render-review)';
const linkedDiff = renderRichDiff(lineDiff(linkedBefore, linkedAfter), linkedBefore, linkedAfter, { before: { document: baseDocument }, after: { document: baseDocument } });
assert.ok(linkedDiff.includes('href="#plan/change/render-review"'));
assert.ok(!renderRichDiff(lineDiff('', '[Unsafe](javascript:alert(1))'), '', '[Unsafe](javascript:alert(1))').includes('javascript:'));
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
assert.ok(plannedChangeReview.includes('id="review-change-render-review"'));
assert.ok(plannedChangeReview.includes('<span class="planned-review-id">1.</span>'));
assert.ok(plannedChangeReview.includes('Show the <strong>report</strong>'));
assert.ok(codeText(plannedChangeReview).includes('render(report)'));
assert.ok(plannedChangeReview.includes('<span class="hljs-keyword">interface</span>'), 'review walkthroughs highlight code');
assert.ok(!plannedChangeReview.includes('<h4>What</h4>'));
assert.ok(!plannedChangeReview.includes('<h4>Pseudocode</h4>'));
assert.ok(!plannedChangeReview.includes('undefined'));
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
assert.ok(richDiff.includes('<span class="diff-code-line remove"><span class="hljs-keyword">const</span> view = <span class="hljs-string">&quot;raw&quot;</span>;</span>'));
assert.ok(richDiff.includes('<span class="diff-code-line add"><span class="hljs-keyword">const</span> view = <span class="hljs-string">&quot;rich&quot;</span>;</span>'));
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

const structuredPlan = planWithNodes([
  { id: 'render-change', title: 'Render each change', dependsOn: ['read-document'], content: 'Freeform prose, without labeled fields.' },
  { id: 'read-document', title: 'Read the document', dependsOn: [], content: '# Not a document title\n\n## Testing\n\n### Not another change\n\n```text\n## Goal\n```\n\n**Depends on**\n\nnot-a-dependency\n\n| A | B |\n| - | - |\n| C | D |' },
], { readingOrder: ['read-document', 'render-change'], goal: 'Ship a guided reader.', intro: 'Additional **context**.', testing: 'Verify guided and full-document modes.' });
const structure = planDocumentStructure(structuredPlan);
assert.equal(structure.canUseGuidedView, true);
assert.equal(structure.goal, 'Ship a guided reader.');
assert.equal(structure.intro, 'Additional **context**.');
assert.equal(structure.changes.length, 2);
assert.equal(structure.changes[0].id, 'read-document');
assert.equal(structure.changes[0].number, 1);
assert.ok(structure.changes[0].content.includes('Not another change'));
assert.equal(structure.changes[1].id, 'render-change');
assert.equal(structure.changes[1].number, 2);
assert.equal(structure.testing, 'Verify guided and full-document modes.');
assert.deepEqual(planDocumentStructure(null), { canUseGuidedView: false, changes: [] });
assert.equal(hashReaderDestination("#review/full", "review"), "full");
assert.equal(hashReaderDestination("#plan/testing", "plan"), "testing");
assert.equal(hashReaderDestination("#plan/intro", "plan"), "intro");
assert.equal(initialViewForHash("#plan/intro", "review", true), "plan");
const introDestinations = createPlanDestinations(structure);
assert.deepEqual(introDestinations.map(({ id }) => id), ['goal', 'intro', 'graph', 'change/read-document', 'change/render-change', 'testing']);
assert.equal(introDestinations[1].label, 'Introduction');
for (const intro of [undefined, '']) {
  assert.ok(!createPlanDestinations({ ...structure, intro }).some(({ id }) => id === 'intro'), 'omit the optional introduction when absent');
}
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
  { id: 'read-schema', title: 'Read shared schema', dependsOn: ['define-schema'] }, // Forward references are not reading order.
  { id: 'render-graph', title: 'Render graph', dependsOn: ['define-schema'] },
  { id: 'define-schema', title: 'Define shared schema', dependsOn: [] },
  { id: 'integrate', title: 'Integrate both branches', dependsOn: ['read-schema', 'render-graph'] },
  { id: 'document', title: 'Independent documentation', dependsOn: [] },
  { id: 'escape-labels', title: 'Escape "quotes" <script>alert(1)</script> %%{init: evil}%% `text` & labels', dependsOn: ['integrate'] },
];
const graphPlan = planWithNodes(graphNodes);
const invalidGraphPlan = planWithNodes(graphNodes.map((node) => node.id === 'integrate' ? { ...node, dependsOn: ['unknown-change'] } : node));
const graphData = {
  ...data,
  versions: [data.versions[0], { ...version(graphPlan, 2), document: invalidGraphPlan }, { ...version(graphPlan, 3), document: { ...graphPlan, changes: [...graphPlan.changes].reverse() }, content: '# Ignore this generated export\n\n## Planned Changes\n\n### Not a structural change' }],
};
const serializedBeforeRender = JSON.stringify(graphData);
const graphHtml = renderWorkflowDashboard(graphData);
const normalized = snapshotFromHtml(graphHtml);
assert.equal(JSON.stringify(graphData), serializedBeforeRender, "normalization must not mutate callers' snapshots");
assert.equal(normalized.versions[0].dependencyGraph.status, 'valid');
assert.ok(!Object.hasOwn(normalized.versions[0], "changeDetails"));
assert.equal(normalized.versions[1].dependencyGraph.status, "unavailable");
assert.match(normalized.versions[1].dependencyGraph.reason, /unknown-change/);
const graph = normalized.versions[2].dependencyGraph;
assert.deepEqual(graph, { status: "valid", nodes: graphNodes });
assert.ok(!Object.hasOwn(normalized.versions[2], "changeDetails"), "graph snapshots no longer duplicate change details");
assert.ok(!graphHtml.includes('<script>alert(1)</script>'));
assert.deepEqual(snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [] })).versions, []);
const staleGraph = { ...data.versions[0], dependencyGraph: graph };
assert.deepEqual(snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [staleGraph] })).versions[0].dependencyGraph.nodes, [{ id: 'render-review', title: 'Render the review', dependsOn: [] }], 'caller-provided graph data is not trusted');
const unavailableGraph = snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [{ ...data.versions[0], document: undefined }] })).versions[0].dependencyGraph;
assert.equal(unavailableGraph.status, 'unavailable', 'missing documents must not imply an edgeless graph');
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
assert.equal(generateDependencyDiagram(unavailableGraph), '');
assert.ok(diagram.includes('dag_0["Change 1<br/>Read shared schema"]'), 'graph labels retain reading numbers and titles');
for (const node of graphNodes) assert.ok(!diagram.includes(`<br/>${node.id}"]`), `graph labels omit the slug line for ${node.id}`);
assert.deepEqual([...dependencyRelations(graph, 'integrate').ancestors].sort(), ['define-schema', 'read-schema', 'render-graph']);
assert.deepEqual([...dependencyRelations(graph, 'define-schema').downstream].sort(), ['escape-labels', 'integrate', 'read-schema', 'render-graph']);
assert.equal(dependencyRelations(graph, 'document').ancestors.size, 0);
assert.equal(dependencyRelations(graph, 'document').downstream.size, 0);
assert.equal(dependencyRelations(unavailableGraph, 'read-schema').ancestors.size, 0);
const graphStructure = planDocumentStructure(graphPlan);
const sectionHelpers = new Function("latestPlan", "planStructure", "marked", `${helperSource};return { renderPlanGraph, renderDependencyRelations, renderPlanDestination };`)(normalized.versions[2], graphStructure, marked);
const graphSection = sectionHelpers.renderPlanGraph();
assert.ok(graphSection.includes('class="dependency-legend"'));
assert.match(graphSection, /Drawing dependency graph…<\/p><\/div><\/section>$/, "the graph canvas is the last element in its section");
assert.ok(!graphSection.includes("Selected change"));
assert.ok(!graphSection.includes("Dependency list"));
const changeSection = sectionHelpers.renderPlanDestination({ kind: "change", change: graphStructure.changes[0] });
assert.ok(changeSection.includes('A heading inside freeform prose'));
assert.ok(changeSection.includes('id="plan-change-read-schema"'));
assert.ok(changeSection.includes('Implement <strong>read-schema</strong> safely.'), 'planned-change details remain in their own guided section');
assert.ok(!changeSection.includes('<strong>What</strong>'));
const guidedLinks = sectionHelpers.renderDependencyRelations(graph, 'integrate');
assert.ok(guidedLinks.includes('href="#plan/change/read-schema"'));
assert.ok(guidedLinks.includes('1. Read shared schema</a>'));
assert.ok(guidedLinks.includes('data-dependency-node="escape-labels"'));
assert.equal(hashReaderDestination("#plan-graph", "plan"), "graph");
assert.equal(hashReaderDestination('#plan-graph/render-graph', 'plan'), 'graph/render-graph');
assert.equal(hashReaderDestination('#plan/graph/render-graph', 'plan'), 'graph/render-graph');
assert.equal(hashReaderDestination('#plan/render-graph', 'plan'), 'render-graph');
assert.equal(hashReaderDestination('#plan/change/render-graph', 'plan'), 'change/render-graph');
assert.equal(initialViewForHash("#plan-graph", "review", true), "plan");
assert.equal(planModeForState(null, undefined, true), "guided", "new visits start at Goal in Guided view");
assert.equal(planModeForState(null, "guided", true), "guided");
assert.equal(planModeForState(null, "full", true), "full");
assert.equal(planModeForState("goal", "graph", true), "guided");
assert.equal(planModeForState('render-graph', 'graph', true), 'guided');
assert.equal(planModeForState('graph/render-graph', 'full', true), 'guided');
assert.equal(planModeForState(null, "graph", true), "guided", "restore old Graph mode as Guided view");
assert.equal(planModeForState(null, undefined, false), "full");
assert.equal(planModeForState('graph', 'full', false), 'full', 'no saved document shows the empty full-document view');
assert.equal(planModeForState(null, "garbage", true), "guided");
assert.equal(planDestinationForState(null, undefined, undefined), "goal");
assert.equal(planDestinationForState(null, "graph", "goal"), "graph");
assert.equal(planDestinationForState("goal", "graph", "graph"), "goal");
assert.equal(planDestinationForState('graph/render-graph', 'full', 'goal'), 'graph/render-graph');
assert.equal(planDestinationForState(null, "guided", "graph"), "graph");
assert.equal(planDestinationForState("full", "guided", "graph"), "graph");
const guidedDestinations = createPlanDestinations(graphStructure);
assert.deepEqual(guidedDestinations.map((section) => section.kind), ["goal", "graph", ...graphNodes.map(() => "change"), "testing"]);
assert.equal(guidedDestinations[1].id, "graph");
assert.equal(guidedDestinations[1].label, "Dependency graph");
assert.deepEqual(createPlanDestinations({ canUseGuidedView: false }), []);
assert.deepEqual(dependencyChanges(graph, graph), { addedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
const changedGraph = { status: 'valid', nodes: graphNodes.map((node) => node.id === 'integrate' ? { ...node, dependsOn: ['define-schema'] } : node) };
assert.deepEqual(dependencyChanges(graph, changedGraph), { addedNodes: [], removedNodes: [], addedEdges: ['define-schema → integrate'], removedEdges: ['read-schema → integrate', 'render-graph → integrate'] });
assert.deepEqual(dependencyChanges(graph, { status: 'valid', nodes: graph.nodes.slice(0, -1) }), { addedNodes: [], removedNodes: ['escape-labels'], addedEdges: [], removedEdges: ['integrate → escape-labels'] });
assert.equal(dependencyChanges(unavailableGraph, graph), null);
assert.ok(renderDependencyChanges(unavailableGraph, graph).includes('comparison unavailable'));
assert.ok(renderDependencyChanges(graph, graph).includes('No dependency changes'));
assert.ok(renderDependencyChanges(graph, changedGraph).includes('Dependency removed: read-schema → integrate'));

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
const graphBrowser = new Function("latestPlan", "planStructure", "globalThis", "document", "location", "history", "marked", `let selectedGraphNode="integrate",graphRenderSequence=0,navigationSidebarCollapsed=false;const readers={plan:{mode:"guided",currentDestination:"graph",destinations:[{id:"goal"},{id:"graph"}]}};${helperSource};return { renderDependencyGraphDiagram, renderPlanGraph, selectGraphNode, handleDependencyNavigation, configureReader, createPlanDestinations, renderPlanDestination, renderFullPlan, renderReader, setReaderMode, moveReader, readers };`)(normalized.versions[2], graphStructure, { mermaid: mermaidStub }, graphDocument, fakeLocation, fakeHistory, marked);
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
assert.match(svgNodes[0].attributes['aria-label'], /Change 1: Read shared schema \(read-schema\). Requires: define-schema/);
assert.equal(svgNodes[3].classList.contains("graph-node--selected"), true);
assert.equal(svgNodes[2].classList.contains("graph-node--ancestor"), true);
assert.equal(svgNodes[5].classList.contains("graph-node--downstream"), true);
svgNodes[2].listeners.click();
assert.equal(svgNodes[2].classList.contains("graph-node--selected"), true);
assert.equal(svgNodes[3].classList.contains("graph-node--downstream"), true);
assert.match(svgNodes[2].attributes["aria-label"], /Highlight prerequisites and downstream changes/);
assert.ok(fakeLocation.href.endsWith('#plan/graph/define-schema'));
let preventedKey = false;
svgNodes[4].listeners.keydown({ key: " ", preventDefault() { preventedKey = true; } });
assert.equal(preventedKey, true);
assert.equal(svgNodes[4].attributes["aria-pressed"], "true");
assert.equal(svgNodes[3].classList.contains("graph-node--downstream"), false);
const selectedHash = fakeLocation.href;
graphBrowser.selectGraphNode('unknown-change" onclick="evil');
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
graphBrowser.selectGraphNode('define-schema');
assert.equal(graphBrowser.readers.plan.currentDestination, "graph", "node selection does not replace the guided destination");
graphBrowser.moveReader("plan", 1, false);
assert.equal(graphBrowser.readers.plan.currentDestination, guidedDestinations[2].id);
assert.equal(graphElements["plan-previous-section"].dataset.destination, "graph");
assert.equal(graphElements["plan-reader"].classList.contains("plan-reader--dependencies"), false);
graphBrowser.moveReader("plan", -1, false);
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.ok(fakeLocation.href.endsWith('#plan/graph/define-schema'), 'returning to the graph keeps node selection');
graphBrowser.renderReader('plan', 'graph/render-graph', false);
assert.equal(graphBrowser.readers.plan.currentDestination, 'graph');
assert.ok(fakeLocation.href.endsWith('#plan/graph/render-graph'));
graphBrowser.setReaderMode("plan", "full");
assert.equal(graphElements["plan-reader"].classList.contains("plan-reader--dependencies"), false);
assert.equal(graphElements["plan-pagination"].hidden, true);
graphBrowser.setReaderMode("plan", "guided", undefined, false);
assert.equal(graphBrowser.readers.plan.currentDestination, "graph");
assert.equal(graphElements["plan-pagination"].hidden, false);

// Full rendering also uses the document. An unrelated generated Markdown export cannot create anchors.
graphBrowser.setReaderMode('plan', 'full');
assert.ok(graphElements['plan-content'].innerHTML.includes('id="plan-change-read-schema"'));
assert.ok(graphElements['plan-content'].innerHTML.includes('1. Read shared schema'));
assert.ok(!graphElements['plan-content'].innerHTML.includes('Ignore this generated export'));
assert.ok(!graphElements['plan-content'].innerHTML.includes('Not a structural change'));
graphBrowser.setReaderMode('plan', 'guided', 'read-schema', false);
assert.equal(graphBrowser.readers.plan.currentDestination, 'change/read-schema', 'direct slug deep links resolve without numbered IDs');
assert.ok(fakeLocation.href.endsWith('#plan/change/read-schema'));

// Arbitrary section-looking Markdown never affects structure, dependency edges, or identity.
const prosePlan = { ...version(structuredPlan), dependencyGraph: snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [version(structuredPlan)] })).versions[0].dependencyGraph };
const proseRenderer = new Function('latestPlan', 'planStructure', 'marked', 'document', 'location', 'history', 'globalThis', `const readers={};let navigationSidebarCollapsed=false,selectedGraphNode=null,graphRenderSequence=0;${helperSource};return {renderPlanDestination,renderFullPlan,configureReader,setReaderMode,moveReader,readers};`)(prosePlan, structure, marked, graphDocument, fakeLocation, fakeHistory, { mermaid: mermaidStub });
for (const fullDocument of [false, true]) {
  const goalSection = proseRenderer.renderPlanDestination({ kind: 'goal' }, fullDocument);
  assert.ok(goalSection.includes('<h2>Goal</h2>'));
  assert.ok(!goalSection.includes('Introduction'));
  assert.ok(!goalSection.includes('Additional'));
  const introSection = proseRenderer.renderPlanDestination({ kind: 'intro' }, fullDocument);
  assert.ok(introSection.includes('<h2>Introduction</h2>'));
  assert.ok(introSection.includes('Additional <strong>context</strong>.'));
  assert.ok(!introSection.includes('Ship a guided reader.'));
}
proseRenderer.configureReader('plan', introDestinations, proseRenderer.renderPlanDestination, proseRenderer.renderFullPlan);
proseRenderer.setReaderMode('plan', 'guided', 'goal', false);
assert.equal(graphElements['plan-next-section'].dataset.destination, 'intro');
proseRenderer.moveReader('plan', 1, false);
assert.equal(proseRenderer.readers.plan.currentDestination, 'intro');
assert.equal(graphElements['plan-position'].textContent, 'Introduction');
assert.equal(graphElements['plan-previous-section'].dataset.destination, 'goal');
assert.equal(graphElements['plan-next-section'].dataset.destination, 'graph');
assert.ok(fakeLocation.href.endsWith('#plan/intro'));
proseRenderer.moveReader('plan', 1, false);
assert.equal(proseRenderer.readers.plan.currentDestination, 'graph');
assert.equal(graphElements['plan-previous-section'].dataset.destination, 'intro');
proseRenderer.moveReader('plan', -1, false);
assert.equal(proseRenderer.readers.plan.currentDestination, 'intro');
proseRenderer.setReaderMode('plan', 'full');
const fullPlan = graphElements['plan-content'].innerHTML;
assert.match(fullPlan, /<section class="plan-full-section"><h2>Goal<\/h2>[\s\S]*?<\/section><section class="plan-full-section"><h2>Introduction<\/h2>/);
assert.equal(fullPlan.match(/<h2>Introduction<\/h2>/g)?.length, 1);
assert.ok(!fullPlan.includes('<h3>Introduction</h3>'));
assert.ok(!fullPlan.includes('id="plan-dependency-graph"'));
proseRenderer.setReaderMode('plan', 'guided', 'intro', false);
assert.equal(proseRenderer.readers.plan.currentDestination, 'intro', 'introduction deep links restore guided mode');
const proseSection = proseRenderer.renderPlanDestination({ kind: 'change', change: structure.changes[0] });
assert.ok(proseSection.includes('<table>'));
assert.ok(proseSection.includes('<h3>Not another change</h3>'));
assert.ok(proseSection.includes('<h2>Testing</h2>'));
assert.deepEqual(prosePlan.dependencyGraph.nodes[0].dependsOn, []);
assert.equal(createPlanDestinations(structure).filter((destination) => destination.kind === 'change').length, 2);
for (const target of ['#read-document', '#plan-change-read-document', 'read-document.md', 'changes/read-document.md', 'planned-changes/read-document/change.md', '../read-document/change.md']) {
  assert.ok(renderMarkdown(`[Read](${target})`, { document: structuredPlan, reader: 'plan' }).includes('href="#plan/change/read-document"'), `slug link resolves: ${target}`);
  assert.ok(renderMarkdown(`[Read](${target})`, { document: structuredPlan, reader: 'review' }).includes('href="#review/change/read-document"'), `review slug link stays in the review: ${target}`);
}
assert.ok(renderMarkdown('[Other](#unknown)', { document: structuredPlan }).includes('href="#unknown"'));
assert.ok(!renderMarkdown('[Unsafe](javascript:alert(1))', { document: structuredPlan }).includes('javascript:'));
const reservedSlugs = planWithNodes(['goal', 'intro', 'graph', 'testing', 'full', 'overall'].map((id) => ({ id, title: id, dependsOn: [] })), { intro: 'Background.' });
assert.equal(new Set(createPlanDestinations(planDocumentStructure(reservedSlugs)).map((destination) => destination.id)).size, 10, 'section names cannot collide with valid change slugs');
assert.ok(renderMarkdown('[Introduction change](#intro)', { document: reservedSlugs }).includes('href="#plan/change/intro"'));
assert.ok(renderMarkdown('[Graph change](#graph)', { document: reservedSlugs }).includes('href="#plan/change/graph"'));

// Reordering matches by slug, not by number, title, or source heading. It produces no prose deletions/additions.
const reordered = { ...structuredPlan, readingOrder: [...structuredPlan.readingOrder].reverse() };
const comparison = comparePlanDocuments(structuredPlan, reordered);
assert.equal(comparison.moves.length, 2);
assert.equal(comparison.added.length, 0);
assert.equal(comparison.removed.length, 0);
assert.equal(comparison.modified.length, 0);
assert.deepEqual(comparison.moves.map(({ id, oldNumber, newNumber }) => ({ id, oldNumber, newNumber })), [
  { id: 'render-change', oldNumber: 2, newNumber: 1 },
  { id: 'read-document', oldNumber: 1, newNumber: 2 },
]);
assert.equal(comparePlanDocuments(structuredPlan, { ...structuredPlan, changes: [...structuredPlan.changes].reverse() }).moves.length, 0, 'storage array order is not reading order');
const reorderDiff = renderPlanComparison(version(structuredPlan, 1), version(reordered, 2));
assert.equal(reorderDiff.added, 0);
assert.equal(reorderDiff.removed, 0);
assert.ok(reorderDiff.html.includes('Reading order changes'));
assert.ok(reorderDiff.html.includes('Version 1: 1 → Version 2: 2'));
assert.ok(reorderDiff.html.includes('Version 1: 2 → Version 2: 1'));
assert.ok(reorderDiff.html.includes('<table>'), 'unchanged moved Markdown remains rich, not delete/add text');
assert.ok(!/class="diff-line (add|remove)"/.test(reorderDiff.html));
assert.equal((reorderDiff.html.match(/data-change-id="read-document"/g) || []).length, 1, 'each slug has one matched comparison section');
const reorderedGraph = snapshotFromHtml(renderWorkflowDashboard({ ...data, versions: [version(reordered)] })).versions[0].dependencyGraph;
assert.equal(reorderedGraph.nodes[0].id, 'render-change');
assert.ok(generateDependencyDiagram(reorderedGraph).includes('dag_0["Change 1<br/>Render each change"]'));
assert.deepEqual(dependencyChanges(prosePlan.dependencyGraph, reorderedGraph), { addedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });

const editedReorder = { ...reordered, changes: reordered.changes.map((change) => change.id === 'read-document' ? { ...change, title: 'Renamed without changing identity', content: change.content + '\n\nNew **prose**.' } : change) };
const editedDiff = renderPlanComparison(version(structuredPlan, 1), version(editedReorder, 2));
assert.equal(editedDiff.comparison.modified.length, 1);
assert.equal(editedDiff.comparison.modified[0].id, 'read-document');
assert.equal(editedDiff.comparison.added.length, 0);
assert.equal(editedDiff.comparison.removed.length, 0);
assert.ok(editedDiff.html.includes('New <strong>prose</strong>.'));
const diffIndexes = [...editedDiff.html.matchAll(/data-diff-block-index="(\d+)"/g)].map((match) => Number(match[1]));
assert.deepEqual(diffIndexes, diffIndexes.map((_value, index) => index), 'semantic sections share one diff-navigation sequence');
const replacement = planWithNodes([{ id: 'replacement', title: 'Different identity', dependsOn: [], content: 'New content.' }]);
const replacedDiff = comparePlanDocuments(structuredPlan, replacement);
assert.deepEqual(replacedDiff.added.map((change) => change.id), ['replacement']);
assert.deepEqual(replacedDiff.removed.map((change) => change.id).sort(), ['read-document', 'render-change']);
assert.equal(renderPlanComparison({ ...version(structuredPlan), content: 'untrusted export' }, version(structuredPlan)).html, '', 'generated Markdown is not comparison authority');

// Reviews use the exact approved plan, including its order, freeform design, titles, and testing.
const report = {
  ...data.review,
  plannedChanges: structuredPlan.readingOrder.map((id) => ({ ...data.review.plannedChanges[0], ...structuredPlan.changes.find((change) => change.id === id) })),
  testingCriteria: { ...data.review.testingCriteria, originalCriteria: structuredPlan.testing },
};
const approvedDashboard = { ...data, approvedPlanVersion: 1, versions: [version(structuredPlan, 1), version(editedReorder, 2)], review: report };
const reviewHelpers = new Function('dashboard', 'marked', `${helperSource};return {createReviewDestinations,reviewPlanSnapshot,renderReviewDestination};`)(approvedDashboard, marked);
const approvedSnapshot = reviewHelpers.reviewPlanSnapshot();
assert.equal(approvedSnapshot.number, 1);
const approvedDestinations = reviewHelpers.createReviewDestinations(report).filter((item) => item.kind === 'change');
assert.deepEqual(approvedDestinations.map(({ id, number }) => ({ id, number })), [{ id: 'change/read-document', number: 1 }, { id: 'change/render-change', number: 2 }]);
const approvedSection = reviewHelpers.renderReviewDestination(approvedDestinations[0]);
assert.ok(approvedSection.includes('id="review-change-read-document"'));
assert.ok(approvedSection.includes('<span class="planned-review-id">1.</span> Read the document'));
assert.ok(approvedSection.includes('<table>'));
assert.ok(!approvedSection.includes('Newer content'));
assert.ok(!approvedSection.includes('Renamed without changing identity'));
assert.ok(reviewHelpers.renderReviewDestination({ kind: 'testing' }).includes(structuredPlan.testing));
const reportOnlyDestinations = createReviewDestinations({ ...report, plannedChanges: [...report.plannedChanges].reverse() }).filter((item) => item.kind === 'change');
assert.equal(reportOnlyDestinations[0].id, 'change/render-change', 'standalone reports retain their saved array order');
assert.equal(reportOnlyDestinations[0].number, 1);
const missingApproved = new Function('dashboard', `${helperSource};return reviewPlanSnapshot();`)({ ...approvedDashboard, approvedPlanVersion: 99 });
assert.equal(missingApproved, null, 'an unavailable approved snapshot is never replaced with the newest version');
const laterApprovalHelpers = new Function('dashboard', 'marked', `${helperSource};return {reviewPlanSnapshot,renderReviewDestination};`)({ ...approvedDashboard, approvedPlanVersion: 2 }, marked);
assert.equal(laterApprovalHelpers.reviewPlanSnapshot(), null, 'a later approval cannot relabel an older report');
assert.equal(laterApprovalHelpers.renderReviewDestination(approvedDestinations[0]), approvedSection, 'later approvals cannot replace the reviewed design or its display number');

// A skeleton working draft does not fabricate a saved version or a graph.
const emptyElements = Object.fromEntries(['plan-content', 'plan-pagination', 'diff-summary', 'dependency-diff', 'diff-content', 'from-version', 'to-version', 'diff-previous-block', 'diff-next-block'].map((id) => [id, readerElement()]));
const emptyBrowser = new Function('dashboard', 'document', `let latestPlan=null,planStructure=planDocumentStructure(null),currentDiffBlockIndex=-1;${helperSource};return {renderFullPlan,renderDiff};`)({ versions: [] }, { getElementById(id) { return emptyElements[id]; }, querySelectorAll() { return []; } });
emptyBrowser.renderFullPlan();
emptyBrowser.renderDiff();
assert.ok(emptyElements['plan-content'].innerHTML.includes('No saved plan yet'));
assert.equal(emptyElements['plan-pagination'].hidden, true);
assert.ok(emptyElements['diff-content'].innerHTML.includes('No saved plan yet'));
assert.equal(emptyElements['diff-previous-block'].disabled, true);
assert.equal(emptyElements['diff-next-block'].disabled, true);

// Every finalized original and followup is in the checklist, regardless of flag or verdict.
const followupOrigin = { reviewNumber: 2, sessionId: 'review-session', entryId: 'followup-entry' };
const mixedOriginals = [
  { id: 'store-records', title: 'Store records', dependsOn: [], implemented: true, content: 'Persist each record.' },
  { id: 'load-records', title: 'Load records', dependsOn: ['store-records'], implemented: false, content: 'Load all records.' },
];
const mixedFollowups = [
  { id: 'retry-storage', title: 'Retry storage', dependsOn: ['store-records'], implemented: true, content: 'Retry a transient storage failure.', testing: 'Assert one retry after a transient failure.', followup: { origin: followupOrigin, effect: { type: 'addition' } } },
  { id: 'page-records', title: 'Page records', dependsOn: ['load-records'], implemented: false, content: 'Load one page of records at a time. See [storage](../retry-storage/change.md).', testing: 'Assert each page contains at most ten records.', followup: { origin: followupOrigin, effect: { type: 'amendment', requirements: [
    { source: { type: 'change', id: 'load-records' }, quotedRequirement: 'Load all records.' },
    { source: { type: 'original-ask' }, quotedRequirement: 'Read every record.' },
    { source: { type: 'plan-section', name: 'testing' }, quotedRequirement: 'Verify the graph and guided reader.' },
  ] } } },
];
const mixedBaseline = planWithNodes(mixedOriginals.map((change) => ({ ...change, implemented: false })), { schemaVersion: 2 });
const mixedPlan = planWithNodes([...mixedOriginals, ...mixedFollowups], { schemaVersion: 2 });
const assessmentOnly = structuredClone(mixedPlan);
assessmentOnly.changes[0].implemented = false;
assessmentOnly.changes[3].implemented = true;
const revisedFollowup = structuredClone(assessmentOnly);
revisedFollowup.changes[2].implemented = false;
revisedFollowup.changes[2].testing = 'Assert two retries before giving up.';
revisedFollowup.changes[2].content = 'Retry a transient storage failure twice.';
const mixedVersions = [version(mixedBaseline, 1), version(mixedPlan, 2), version(assessmentOnly, 3), version(revisedFollowup, 4)];
const groups = [{ sourceId: 'plan:testing', criteria: mixedPlan.testing }, ...mixedFollowups.map((change) => ({ sourceId: 'followup:' + change.id, criteria: change.testing }))];
const mixedReport = {
  ...data.review, version: 4, baselinePlanVersion: 1, currentPlanVersion: 2,
  plannedChanges: mixedPlan.changes.map(({ id, title, content, dependsOn, followup }) => ({
    id, title, content, dependsOn, kind: followup ? 'followup' : 'original', ...(followup ? { effect: followup.effect } : {}),
    review: { ...data.review.plannedChanges[0].review, id, title, sufficient: { status: 'no', explanation: 'The implementation is incomplete despite its assessment.' } },
  })),
  testingCriteria: { originalCriteria: mixedPlan.testing, groups, review: {
    ...data.review.testingCriteria.review,
    criteria: groups.map(({ sourceId, criteria }) => ({ sourceId, criterion: criteria, status: 'no', explanation: 'Missing coverage.', evidence: [{ location: 'scripts/dashboard-test.mjs:1', description: 'The required failure case is not covered.' }] })),
  } },
};
const mixedDashboard = snapshotFromHtml(renderWorkflowDashboard({ ...data, ask: 'Read every record.', approvedPlanVersion: 1, versions: mixedVersions, review: mixedReport, reviewStale: true }));
const selectedPlanElements = Object.fromEntries(['version-badge', 'plan-title', 'implementation-summary', 'plan-change-links', 'plan-intro-link', 'plan-content', 'plan-pagination', 'plan-reader', 'plan-outline', 'plan-navigation-sidebar-button', 'plan-guided-mode-button', 'plan-full-mode-button', 'plan-previous-section', 'plan-next-section', 'plan-position'].map((id) => [id, readerElement()]));
selectedPlanElements['plan-change-links'].children = [];
selectedPlanElements['plan-change-links'].appendChild = function(child) { this.children.push(child); };
const selectedPlanDocument = { getElementById(id) { return selectedPlanElements[id]; }, createElement() { return readerElement(); }, querySelectorAll() { return []; } };
const mixedBrowser = new Function('dashboard', 'marked', 'document', 'location', 'history', `let latestPlan=null,planStructure=null,navigationSidebarCollapsed=false,selectedGraphNode=null;const readers={};${helperSource};return {selectPlanSnapshot,renderPlanDestination,renderFullPlan,renderReviewDestination,reviewPlanSnapshot,renderImplementationSummary,createReviewDestinations,renderImplemented,setReaderMode,readers};`)(mixedDashboard, marked, selectedPlanDocument, fakeLocation, fakeHistory);
mixedBrowser.selectPlanSnapshot();
assert.equal(selectedPlanElements['version-badge'].textContent, 'Version 4', 'selection defaults to the latest finalized snapshot, not the baseline');
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /Marked implemented: 1 · Not marked implemented: 3/);
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /Original approved baseline: version 1/);
mixedBrowser.selectPlanSnapshot(2);
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /Marked implemented: 2 · Not marked implemented: 2/);
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /not independent verification/);
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /False is not proof that code is missing/);
assert.equal(selectedPlanElements['plan-change-links'].children.at(-1).dataset.readerDestination, 'change/page-records');
assert.match(selectedPlanElements['plan-change-links'].children.at(-1).textContent, /Followup/);
for (const [index, change] of mixedPlan.changes.entries()) {
  const section = mixedBrowser.renderPlanDestination({ kind: 'change', change: { ...change, number: index + 1 } });
  assert.match(section, new RegExp(`<span class="implementation-flag">${change.implemented ? 'Marked implemented' : 'Not marked implemented'}</span>`));
  assert.match(section, /Independent review verdicts/);
  assert.match(section, /Sufficient: No/);
  assert.ok(section.indexOf('implementation-flag') < section.indexOf('Independent review verdicts'));
  if (change.followup) {
    assert.match(section, /Followup · Source review 2/);
    assert.ok(section.includes(change.testing));
    if (change.followup.effect.type === 'amendment') {
      assert.match(section, /Scope effect:<\/strong> Amendment/);
      assert.match(section, /Amends Original ask/);
      assert.match(section, /Amends Plan section: testing/);
      assert.match(section, /href="#plan\/change\/load-records"/);
      assert.match(section, /Load all records\./);
      assert.match(section, /href="#plan\/change\/retry-storage"/);
    }
  }
}
const snapshotTesting = mixedBrowser.renderPlanDestination({ kind: 'testing' });
assert.match(snapshotTesting, /Original testing criteria/);
for (const group of groups) assert.ok(snapshotTesting.includes(group.criteria));
mixedBrowser.renderFullPlan();
assert.equal(selectedPlanElements['plan-content'].innerHTML.match(/class="implementation-flag"/g).length, 4);
assert.match(selectedPlanElements['plan-content'].innerHTML, /id="plan-change-page-records"/);
mixedBrowser.setReaderMode('plan', 'guided', 'change/retry-storage', false);
assert.match(selectedPlanElements['plan-content'].innerHTML, /Marked implemented/);
assert.match(selectedPlanElements['plan-content'].innerHTML, /Sufficient: No/);
mixedBrowser.selectPlanSnapshot(4);
assert.equal(mixedBrowser.readers.plan.currentDestination, 'change/retry-storage', 'stable slug selection survives version changes');
assert.match(selectedPlanElements['plan-content'].innerHTML, /Not marked implemented/);
assert.match(selectedPlanElements['plan-content'].innerHTML, /Assert two retries/);
assert.doesNotMatch(selectedPlanElements['plan-content'].innerHTML, /Independent review verdicts/, 'an older report is not applied to revised followup requirements');
assert.doesNotMatch(mixedBrowser.renderPlanDestination({ kind: 'change', change: { ...revisedFollowup.changes[0], number: 1 } }), /Independent review verdicts/, 'unchanged originals cannot inherit verdicts from a different overall requirement scope');
mixedBrowser.selectPlanSnapshot(3);
assert.match(selectedPlanElements['plan-content'].innerHTML, /Independent review verdicts/, 'flag-only scope changes can still show separate verdicts');
mixedBrowser.selectPlanSnapshot(2);
assert.match(selectedPlanElements['plan-content'].innerHTML, /Assert one retry/);
assert.doesNotMatch(selectedPlanElements['plan-content'].innerHTML, /Assert two retries/);
assert.match(fakeLocation.href, /#plan\/change\/retry-storage$/);
mixedBrowser.selectPlanSnapshot(1);
assert.match(selectedPlanElements['implementation-summary'].innerHTML, /Marked implemented: 0 · Not marked implemented: 2/);
mixedBrowser.renderFullPlan();
assert.doesNotMatch(selectedPlanElements['plan-content'].innerHTML, /Source review 2|Retry storage|Page records/);
assert.doesNotMatch(selectedPlanElements['plan-content'].innerHTML, /Independent review verdicts/, 'a pre-followup snapshot does not receive amended-scope verdicts');
assert.deepEqual(mixedDashboard.versions[1].dependencyGraph.nodes.map(({ id }) => id), mixedPlan.readingOrder);
assert.match(generateDependencyDiagram(mixedDashboard.versions[1].dependencyGraph), /dag_0 --> dag_2/);

// Flag-only snapshots compare as assessments, not changed requirements or passing reviews.
const flagComparison = renderPlanComparison(mixedVersions[1], mixedVersions[2]);
assert.equal(flagComparison.comparison.modified.length, 0);
assert.equal(flagComparison.comparison.flags.length, 2);
assert.equal(flagComparison.added, 0);
assert.equal(flagComparison.removed, 0);
assert.match(flagComparison.html, /Implementation flag changes/);
assert.match(flagComparison.html, /Flag-only edit/);
assert.match(flagComparison.html, /Version 2: Marked implemented → Version 3: Not marked implemented/);
assert.match(flagComparison.html, /Version 2: Not marked implemented → Version 3: Marked implemented/);
assert.doesNotMatch(flagComparison.html, /Requirements changed|Sufficient:|Review passed/);
const followupComparison = renderPlanComparison(mixedVersions[2], mixedVersions[3]);
assert.deepEqual(followupComparison.comparison.modified.map(({ id }) => id), ['retry-storage']);
assert.match(followupComparison.html, /Requirements also changed/);
assert.match(followupComparison.html, /Followup definition before · Version 3/);
assert.match(followupComparison.html, /Assert one retry/);
assert.match(followupComparison.html, /Followup definition after · Version 4/);
assert.match(followupComparison.html, /Assert two retries/);
const onlyTestingChange = structuredClone(mixedPlan);
onlyTestingChange.changes[2].testing += ' Also assert the delay.';
assert.deepEqual(comparePlanDocuments(mixedPlan, onlyTestingChange).modified.map(({ id }) => id), ['retry-storage']);
const onlyAmendmentChange = structuredClone(mixedPlan);
onlyAmendmentChange.changes[3].followup.effect.requirements.pop();
assert.deepEqual(comparePlanDocuments(mixedPlan, onlyAmendmentChange).modified.map(({ id }) => id), ['page-records']);
const addedFollowups = renderPlanComparison(mixedVersions[0], mixedVersions[1]);
assert.equal(addedFollowups.comparison.added.length, 2);
assert.match(addedFollowups.html, /Followup · Source review 2/);
assert.match(addedFollowups.html, /Scope effect:<\/strong> Amendment/);
const amendmentDiff = renderPlanComparison(mixedVersions[1], version(onlyAmendmentChange, 5));
assert.match(amendmentDiff.html, /Amends Plan section: testing/);
assert.match(amendmentDiff.html, /Requirements changed/);
const mixedDiffIndexes = [...followupComparison.html.matchAll(/data-diff-block-index="(\d+)"/g)].map((match) => Number(match[1]));
assert.deepEqual(mixedDiffIndexes, mixedDiffIndexes.map((_value, index) => index));

// V4 reports show their own exact historical flags and definitions, never latest-plan's.
assert.equal(mixedBrowser.reviewPlanSnapshot().number, 2);
const reviewHeaderElements = Object.fromEntries(['review-tab', 'review-meta', 'review-pull-requests', 'review-change-links'].map((id) => [id, { ...readerElement(), appendChild() {} }]));
const reviewHeaderBrowser = new Function('dashboard', 'document', `${helperSource};const readers={};return {prepareReview};`)(mixedDashboard, { getElementById(id) { return reviewHeaderElements[id]; }, createElement() { return readerElement(); } });
reviewHeaderBrowser.prepareReview();
assert.match(reviewHeaderElements['review-meta'].textContent, /Original approved baseline: version 1 · Reviewed plan version 2/);
const reviewedFollowup = mixedBrowser.createReviewDestinations(mixedReport).find(({ id }) => id === 'change/retry-storage');
for (const fullDocument of [false, true]) {
  const reviewSection = mixedBrowser.renderReviewDestination(reviewedFollowup, fullDocument);
  assert.match(reviewSection, /Marked implemented/);
  assert.match(reviewSection, /reviewed plan version 2/);
  assert.match(reviewSection, /Sufficient: No/);
  assert.match(reviewSection, /Followup · Source review 2/);
  assert.match(reviewSection, /Retry a transient storage failure\./);
  assert.doesNotMatch(reviewSection, /twice|Not marked implemented/);
}
const reviewedTesting = mixedBrowser.renderReviewDestination({ kind: 'testing' });
for (const group of groups) {
  assert.ok(reviewedTesting.includes(group.sourceId));
  assert.ok(reviewedTesting.includes(group.criteria));
}
assert.match(reviewedTesting, /Original testing criteria/);
assert.match(reviewedTesting, /Followup testing: retry-storage/);
const reviewedAmendment = mixedBrowser.renderReviewDestination(mixedBrowser.createReviewDestinations(mixedReport).at(-2));
assert.match(reviewedAmendment, /Not marked implemented/);
assert.match(reviewedAmendment, /href="#review\/change\/load-records"/);
const noHistoricalSnapshot = new Function('dashboard', 'marked', `${helperSource};return {reviewPlanSnapshot,renderReviewDestination};`)({ ...mixedDashboard, versions: [mixedDashboard.versions.at(-1)] }, marked);
assert.equal(noHistoricalSnapshot.reviewPlanSnapshot(), null);
const standaloneReview = noHistoricalSnapshot.renderReviewDestination(reviewedFollowup);
assert.doesNotMatch(standaloneReview, /implementation-flag|Source review/, 'missing review snapshots do not borrow flags or origins from a later version');
assert.match(standaloneReview, /Sufficient: No/);
assert.match(standaloneReview, /Followup/);
assert.match(mixedBrowser.renderReviewDestination({ kind: 'overall' }), /requirements, or report format/);
assert.doesNotMatch(mixedBrowser.renderReviewDestination({ kind: 'overall' }), /workflow-revise/);
assert.equal(snapshotFromHtml(html).versions[0].document.changes[0].implemented, false, 'legacy missing flags normalize to false without changing saved files');
assert.equal(Object.hasOwn(baseDocument.changes[0], 'implemented'), false, 'normalizing for the dashboard does not mutate the input');
const legacyExplicitFalse = { ...baseDocument, changes: baseDocument.changes.map((change) => ({ ...change, implemented: false })) };
assert.equal(comparePlanDocuments(baseDocument, legacyExplicitFalse).flags.length, 0);
assert.equal(renderPlanComparison(version(baseDocument), version(legacyExplicitFalse, 2)).html, '');

// Disk dashboard generation must use the shared scope reader even without a report.
const { workflowFiles, createWorkflow, writeWorkflowMetadata } = await jiti.import(new URL('../src/storage.ts', import.meta.url).pathname);
const { preparePlanDraft, finalizePlanDraft } = await jiti.import(new URL('../src/plan-storage.ts', import.meta.url).pathname);
const { requirementFingerprint } = await jiti.import(new URL('../src/workflow-scope.ts', import.meta.url).pathname);
const temporary = await mkdtemp(join(tmpdir(), 'pi-dashboard-followups-'));
const files = workflowFiles('dashboard-followups', temporary);
const metadata = { version: 6, identifier: 'dashboard-followups', description: 'Dashboard followups', ask: 'Read every record.', repositoryRoot: temporary, gitCommonDir: join(temporary, '.git'), baseBranch: 'main', baseCommit: 'base', workflowBranch: 'workflow/dashboard-followups', worktreePath: temporary, createdAt: '2026-01-01T00:00:00.000Z' };
const json = (value) => JSON.stringify(value, null, 2) + '\n';
async function publishDashboardFixture(document, policy) {
  const draft = await preparePlanDraft(files);
  await writePlanDocument(files.workingPlan, document);
  return finalizePlanDraft(files, 'Dashboard followups', draft.baseVersion, policy);
}
try {
  await createWorkflow(files, metadata);
  // Keep this rendering fixture local: no global locator or Git registration is needed.
  await writeFile(join(temporary, '.workflows', 'active.json'), json({ version: 6, identifier: metadata.identifier, repositoryRoot: temporary, gitCommonDir: metadata.gitCommonDir, worktreePath: temporary }));
  await publishDashboardFixture(mixedBaseline, { phase: 'planning' });
  await writeWorkflowDashboard(files);
  assert.equal(snapshotFromHtml(await readFile(files.dashboard, 'utf8')).approvedPlanVersion, undefined, 'unapproved finalized plans remain readable');
  metadata.approvedPlanVersion = 1;
  await writeWorkflowMetadata(files, metadata);
  await writeWorkflowDashboard(files);
  assert.equal(snapshotFromHtml(await readFile(files.dashboard, 'utf8')).approvedPlanVersion, 1);
  const validDashboard = await readFile(files.dashboard, 'utf8');
  await writeWorkflowMetadata(files, { ...metadata, approvedPlanVersion: 99 });
  await assert.rejects(writeWorkflowDashboard(files), /Approved plan version v99 is missing/, 'approval validation is not conditional on review existence');
  assert.equal(await readFile(files.dashboard, 'utf8'), validDashboard, 'failed validation preserves the prior dashboard');
  await writeWorkflowMetadata(files, metadata);
  const unmarkedFollowups = { ...mixedPlan, changes: mixedPlan.changes.map((change) => ({ ...change, implemented: false })) };
  await publishDashboardFixture(unmarkedFollowups, { phase: 'review', reviewOrigin: { ...followupOrigin, entryIds: [followupOrigin.entryId] } });
  await writeWorkflowMetadata(files, { ...metadata, approvedPlanVersion: 2 });
  await assert.rejects(writeWorkflowDashboard(files), /original approved plan cannot contain followups/, 'the shared scope reader validates original/followup history without any review');
  await writeWorkflowMetadata(files, metadata);
  await publishDashboardFixture(mixedPlan, { phase: 'implementation' });
  const persistedReport = { ...mixedReport, currentPlanVersion: 3, sourceFingerprint: requirementFingerprint(metadata.ask, mixedPlan, await readFile(files.clarifications, 'utf8')) };
  await writeFile(files.review, json(persistedReport));
  await writeWorkflowDashboard(files, persistedReport.headCommit);
  const beforeFlags = snapshotFromHtml(await readFile(files.dashboard, 'utf8'));
  assert.equal(beforeFlags.reviewStale, false, 'v4 is fresh for the exact requirement scope');
  await publishDashboardFixture(assessmentOnly, { phase: 'implementation' });
  await writeWorkflowDashboard(files, persistedReport.headCommit);
  const afterFlags = snapshotFromHtml(await readFile(files.dashboard, 'utf8'));
  assert.equal(afterFlags.reviewStale, false, 'flag-only changes do not stale a v4 report');
  assert.equal(afterFlags.versions.at(-1).document.changes[0].implemented, false);
  assert.equal(afterFlags.versions[2].document.changes[0].implemented, true, 'historical flags are preserved');
  await writeWorkflowDashboard(files, 'new-code-head');
  assert.equal(snapshotFromHtml(await readFile(files.dashboard, 'utf8')).reviewStale, true, 'code changes still stale a report');
  await writeFile(files.review, json(data.review));
  await writeWorkflowDashboard(files, data.review.headCommit);
  assert.equal(snapshotFromHtml(await readFile(files.dashboard, 'utf8')).reviewStale, true, 'legacy v3 reports remain readable but stale');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Dashboard test passed: original/followup assessments, independent verdicts, historical scope, comparisons, stable links, safe DAGs, and rich Markdown readers.');
