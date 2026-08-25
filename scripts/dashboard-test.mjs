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
};

const html = renderWorkflowDashboard(data);

assert.ok(html.startsWith("<!doctype html>"));
assert.ok(
  html.includes(
    "<title>Implementation plan · example&lt;&#x2F;title&gt;&lt;script&gt;alert(&quot;unsafe&quot;)&lt;&#x2F;script&gt;</title>",
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
assert.ok(html.includes('id="guided-mode-button"'));
assert.ok(html.includes('id="full-mode-button"'));
assert.ok(html.includes('aria-label="Plan outline"'));
assert.ok(!html.includes('data-plan-destination="overview"'));
assert.ok(html.includes("heading.focus({preventScroll:true})"));
assert.ok(html.includes('heading.scrollIntoView({block:"start"})'));
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
const { initialViewForHash, lineDiff, parsePlanStructure, renderRichDiff } = new Function(
  `${helperSource}; return { initialViewForHash, lineDiff, parsePlanStructure, renderRichDiff };`,
)();
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
assert.equal(initialViewForHash("#compare", "plan"), "diff");
assert.equal(initialViewForHash("#plan/change-1-parse", "diff"), "plan");
assert.equal(initialViewForHash("", "diff"), "diff");

console.log("Dashboard test passed: plan navigation, safe original asks, and rich version comparisons render correctly.");
