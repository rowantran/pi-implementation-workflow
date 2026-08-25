import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-review-test-"));
const input = {
  pullRequestUrl: "https://example.test/pull/42",
  baseCommit: "base123",
  headCommit: "head456",
  sourceFingerprint: "source789",
  worktreePath: "/repository/.worktrees/review",
  metadataPath: "/workflow/metadata.json",
  planPath: "/workflow/plan.md",
  clarificationsPath: "/workflow/clarifications.json",
  reviewRunsPath: join(temporaryRoot, "review-runs"),
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
let synthesisResultPaths = [];
const runner = async (request) => {
  requests.push(request);
  if (request.role === "planned-change") {
    const change = plannedChanges.find((candidate) => request.prompt.includes(`Planned change identity: ${candidate.id}:`));
    assert.ok(change);
    return analysis(change.id, change.title);
  }
  if (request.role === "holistic-review") {
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
  const plannedChangesDirectory = /Planned-change review directory: (.+)$/m.exec(request.prompt)?.[1];
  const holisticReviewPath = /Holistic review result: (.+)$/m.exec(request.prompt)?.[1];
  const testingCriteriaPath = /Testing criteria review result: (.+)$/m.exec(request.prompt)?.[1];
  assert.ok(plannedChangesDirectory);
  assert.ok(holisticReviewPath);
  assert.ok(testingCriteriaPath);
  synthesisResultPaths = [plannedChangesDirectory, holisticReviewPath, testingCriteriaPath];
  assert.doesNotMatch(request.prompt, /PC-01 is implemented by one durable contract/);
  assert.doesNotMatch(request.prompt, /The changes compose cleanly, with one dashboard gap/);
  assert.doesNotMatch(request.prompt, /The automated suite passes, but the dashboard still needs visual confirmation/);

  const plannedChangeFiles = (await readdir(plannedChangesDirectory)).sort();
  const savedPlannedChanges = await Promise.all(
    plannedChangeFiles.map(async (name) => JSON.parse(await readFile(join(plannedChangesDirectory, name), "utf8"))),
  );
  const [savedHolisticReview, savedTestingCriteria] = await Promise.all([
    readFile(holisticReviewPath, "utf8").then(JSON.parse),
    readFile(testingCriteriaPath, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(plannedChangeFiles, ["PC-01.json", "PC-02.json"]);
  assert.deepEqual(savedPlannedChanges, plannedChanges.map((change) => analysis(change.id, change.title)));
  assert.equal(savedHolisticReview.summary, "The changes compose cleanly, with one dashboard gap.");
  assert.equal(savedTestingCriteria.criteria.length, 2);

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
assert.deepEqual(requests.map(({ role }) => role).sort(), ["holistic-review", "planned-change", "planned-change", "testing-criteria", "synthesizer"].sort());
assert.equal(synthesisStartedAfterAnalysis, true);
assert.equal(synthesisResultPaths.length, 3);
assert.deepEqual(stages, ["analysis-complete", "synthesis-complete"]);
assert.deepEqual(report.plannedChanges.map(({ id }) => id), ["PC-01", "PC-02"]);
assert.equal(report.plannedChanges[1].review.sufficient.status, "partial");
assert.equal(report.overallConcerns.length, 1);
assert.equal(report.sourceFingerprint, input.sourceFingerprint);
assert.equal(report.holisticReview.summary, "The changes compose cleanly, with one dashboard gap.");
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

const reviewRoundPath = join(input.reviewRunsPath, `${input.baseCommit}..${input.headCommit}`, input.sourceFingerprint);
assert.equal(JSON.parse(await readFile(join(reviewRoundPath, "manifest.json"), "utf8")).status, "complete");
assert.ok(JSON.parse(await readFile(join(reviewRoundPath, "synthesis.json"), "utf8")).overallResult);
const reuseStages = [];
const reusedReport = await generateWorkflowReview(
  { ...input, onStage: (stage) => reuseStages.push(stage) },
  async () => {
    throw new Error("A complete review round should not rerun agents.");
  },
);
assert.deepEqual(reusedReport, report);
assert.deepEqual(reuseStages, ["analysis-complete", "synthesis-complete"]);

const resumableInput = { ...input, sourceFingerprint: "resume-after-synthesis-failure" };
const firstAttemptRoles = [];
await assert.rejects(
  generateWorkflowReview(resumableInput, async (request) => {
    firstAttemptRoles.push(request.role);
    if (request.role === "synthesizer") throw new Error("Synthetic synthesis failure");
    return runner(request);
  }),
  /Synthetic synthesis failure/,
);
assert.deepEqual(firstAttemptRoles.sort(), ["holistic-review", "planned-change", "planned-change", "testing-criteria", "synthesizer"].sort());
const retryRoles = [];
await generateWorkflowReview(resumableInput, async (request) => {
  retryRoles.push(request.role);
  assert.equal(request.role, "synthesizer");
  return runner(request);
});
assert.deepEqual(retryRoles, ["synthesizer"], "a synthesis retry must reuse every completed analysis result");

await assert.rejects(
  generateWorkflowReview({ ...input, sourceFingerprint: "wrong-identity" }, async (request) => {
    if (request.role === "planned-change") return analysis("PC-99", "Wrong change");
    return runner(request);
  }),
  /wrong planned-change identity/,
);
await assert.rejects(
  generateWorkflowReview({ ...input, sourceFingerprint: "invalid-testing" }, async (request) => {
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

await rm(temporaryRoot, { recursive: true, force: true });
console.log("Review test passed: durable planned-change, holistic, testing, and synthesis results are reusable by review round.");
