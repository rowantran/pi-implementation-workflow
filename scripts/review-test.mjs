import assert from "node:assert/strict";
import { createJiti } from "jiti/static";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { generateWorkflowReview } = await jiti.import(new URL("../src/review.ts", import.meta.url).pathname);
const { renderWorkflowReviewMarkdown } = await jiti.import(
  new URL("../src/review-report.ts", import.meta.url).pathname,
);

const plannedChanges = [
  {
    id: "PC-01",
    title: "Store the report",
    what: "Persist structured findings.",
    why: "The review must survive cleanup.",
    pseudocode: "type ReviewReport:\n    findings: Finding[]",
    content: "### PC-01: Store the report\n...",
  },
  {
    id: "PC-02",
    title: "Render the report",
    what: "Show findings in the dashboard.",
    why: "The review should be easy to scan.",
    pseudocode: "procedure RenderReview(report)",
    content: "### PC-02: Render the report\n...",
  },
];

const input = {
  pullRequestUrl: "https://example.test/pull/42",
  baseCommit: "base123",
  headCommit: "head456",
  worktreePath: "/repository/.worktrees/review",
  metadataPath: "/workflow/metadata.json",
  planPath: "/workflow/plan.md",
  clarificationsPath: "/workflow/clarifications.json",
  plannedChanges,
  testingCriteria: "Run the full test suite and verify the dashboard report.",
  generatedAt: "2026-01-02T03:04:05.000Z",
};

function evidence(location, description) {
  return { location, description };
}

function analysis(id, title) {
  return {
    id,
    title,
    summary: `${id} is implemented by one durable contract.`,
    necessary: { status: "yes", explanation: "The implementation maps directly to the planned change." },
    sufficient: { status: id === "PC-01" ? "yes" : "partial", explanation: "The core behavior exists." },
    contracts: [
      {
        name: id === "PC-01" ? "WorkflowReviewReport" : "renderReview",
        kind: id === "PC-01" ? "interface" : "function",
        signature: id === "PC-01" ? "interface WorkflowReviewReport { findings: Finding[] }" : "renderReview(report): string",
        fields: id === "PC-01" ? ["findings: Finding[]"] : [],
        constructionSites: [evidence("src/review.ts:20", "Creates the report.")],
        consumers: [evidence("src/dashboard.ts:30", "Renders the report.")],
        bridges: ["review orchestration → dashboard"],
        assessment: "The contract follows the planned pseudocode.",
      },
    ],
    concerns: id === "PC-02" ? [{ severity: "warning", title: "Partial rendering", details: "One view is missing.", evidence: [] }] : [],
  };
}

const requests = [];
let synthesisStartedAfterAnalysis = false;
const runner = async (request) => {
  requests.push(request);
  if (request.role === "planned-change") {
    const change = plannedChanges.find((candidate) => request.prompt.includes(`Planned change identity: ${candidate.id}:`));
    assert.ok(change);
    return analysis(change.id, change.title);
  }
  if (request.role === "plan-auditor") {
    return {
      summary: "The changes compose cleanly, with one dashboard gap.",
      necessary: { status: "yes", explanation: "No unrelated implementation was found." },
      sufficient: { status: "partial", explanation: "The dashboard gap remains." },
      concerns: [{ severity: "warning", title: "Dashboard gap", details: "One view is missing.", evidence: [] }],
    };
  }
  if (request.role === "testing-criteria") {
    assert.match(request.prompt, /Run the full test suite and verify the dashboard report/);
    return {
      summary: "The automated suite passes, but the dashboard still needs visual confirmation.",
      satisfied: { status: "partial", explanation: "Automated evidence passes; visual evidence is incomplete." },
      criteria: [
        {
          criterion: "Run the full test suite",
          status: "yes",
          explanation: "The complete suite passes.",
          evidence: [evidence("package.json:45", "Defines the complete test command.")],
        },
        {
          criterion: "Verify the dashboard report",
          status: "needs-human-review",
          explanation: "A human must confirm the final visual result.",
          evidence: [evidence("scripts/dashboard-test.mjs:1", "Covers report markup and behavior.")],
        },
      ],
      concerns: [{ severity: "note", title: "Visual check remains", details: "Inspect the dashboard.", evidence: [] }],
    };
  }
  synthesisStartedAfterAnalysis = requests.filter((candidate) => candidate.role !== "synthesizer").length === 4;
  assert.match(request.prompt, /PC-01/);
  assert.match(request.prompt, /Holistic plan audit/);
  assert.match(request.prompt, /Testing criteria review/);
  return {
    overallResult: {
      summary: "The pull request is necessary but only partially sufficient.",
      necessary: { status: "yes", explanation: "All implementation maps to the plan." },
      sufficient: { status: "partial", explanation: "The dashboard gap remains." },
    },
    overallConcerns: [{ severity: "warning", title: "Dashboard gap", details: "One view is missing.", evidence: [] }],
  };
};

const stages = [];
const report = await generateWorkflowReview({ ...input, onStage: (stage) => stages.push(stage) }, runner);
assert.deepEqual(requests.map(({ role }) => role).sort(), ["plan-auditor", "planned-change", "planned-change", "testing-criteria", "synthesizer"].sort());
assert.equal(synthesisStartedAfterAnalysis, true);
assert.deepEqual(stages, ["analysis-complete", "synthesis-complete"]);
assert.deepEqual(report.plannedChanges.map(({ id }) => id), ["PC-01", "PC-02"]);
assert.equal(report.plannedChanges[1].review.sufficient.status, "partial");
assert.equal(report.overallConcerns.length, 1);
assert.equal(report.testingCriteria.originalCriteria, input.testingCriteria);
assert.equal(report.testingCriteria.review.satisfied.status, "partial");
assert.equal(report.testingCriteria.review.criteria.length, 2);

const markdown = renderWorkflowReviewMarkdown(report);
assert.match(markdown, /## Overall result/);
assert.match(markdown, /## Overall concerns/);
assert.match(markdown, /## Review of planned changes/);
assert.match(markdown, /### PC-01: Store the report/);
assert.match(markdown, /interface WorkflowReviewReport/);
assert.match(markdown, /Necessary: \*\*Yes\*\*/);
assert.match(markdown, /## Testing criteria/);
assert.match(markdown, /Run the full test suite/);
assert.match(markdown, /Satisfied: \*\*Partial\*\*/);

await assert.rejects(
  generateWorkflowReview(input, async (request) => {
    if (request.role === "planned-change") return analysis("PC-99", "Wrong change");
    return runner(request);
  }),
  /wrong planned-change identity/,
);
await assert.rejects(
  generateWorkflowReview(input, async (request) => {
    if (request.role === "testing-criteria") {
      return {
        summary: "No criteria checked.",
        satisfied: { status: "yes", explanation: "Unsupported." },
        criteria: [],
        concerns: [],
      };
    }
    return runner(request);
  }),
  /testing criteria reviewer returned an invalid result/,
);

console.log("Review test passed: planned-change, plan, and testing-criteria reviewers feed a final synthesizer and durable report.");
