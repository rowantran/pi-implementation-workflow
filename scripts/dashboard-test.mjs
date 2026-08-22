import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderWorkflowDashboard } = await jiti.import(
  new URL("../src/dashboard.ts", import.meta.url).pathname,
);

const data = {
  slug: 'example</title><script>alert("unsafe")</script>',
  description: "Extract the dashboard template",
  generatedAt: "2025-01-02T03:04:05.000Z",
  versions: [
    {
      number: 1,
      createdAt: "2025-01-02T03:04:05.000Z",
      content: "# Plan\n\nRender <safe> content.",
    },
  ],
  clarifications: [],
};

const html = renderWorkflowDashboard(data);

assert.ok(html.startsWith("<!doctype html>"));
assert.ok(
  html.includes(
    "<title>Implementation plan · example&lt;/title&gt;&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;</title>",
  ),
);
assert.ok(html.includes('"description":"Extract the dashboard template"'));
assert.ok(html.includes("Render \\u003csafe> content."));
assert.ok(!html.includes("{{DASHBOARD_"));
assert.ok(!html.includes("</title><script>alert"));

console.log("Dashboard test passed: the HTML template rendered data and escaped dynamic values.");
