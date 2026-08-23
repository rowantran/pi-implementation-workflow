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
assert.ok(html.includes('originalAskText.textContent = dashboard.ask'));
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
const { lineDiff, renderRichDiff } = new Function(
  `${helperSource}; return { lineDiff, renderRichDiff };`,
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

console.log("Dashboard test passed: original asks remain safe and version comparisons use the rich diff view.");
