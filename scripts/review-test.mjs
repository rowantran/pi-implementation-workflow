import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-workflow-review-test-"));
process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { generateWorkflowReview } = await jiti.import(new URL("../src/review.ts", import.meta.url).pathname);
const { isWorkflowReviewReport, isPlannedChangeAnalysis, isIncrementalReviewScope, renderWorkflowReviewMarkdown, REVIEW_REPORT_VERSION } = await jiti.import(
  new URL("../src/review-report.ts", import.meta.url).pathname,
);

const { reviewSourceFingerprint, readReviewSourceFingerprint, reviewIsCurrent, reviewCanSeedIncremental } = await jiti.import(
  new URL("../src/review-selection.ts", import.meta.url).pathname,
);

const plannedChanges = [
  {
    id: "store-report",
    title: "Store the report",
    dependsOn: [],
    content: [
      "**What**",
      "",
      "Persist structured findings so the review survives cleanup.",
      "",
      "### Durability constraints",
      "",
      "- Write atomically; preserve every paragraph and code example.",
      "- Keep links such as [the report](./review.json).",
      "",
      "```ts",
      "type ReviewReport = { findings: Finding[] };",
      "```",
      "",
      "**Why**",
      "",
      "> **Decision:** Keep the freeform rationale with the design.",
      "",
      "| Contract | Requirement |",
      "| --- | --- |",
      "| Report | Must survive cleanup |",
    ].join("\n"),
  },
  {
    id: "render-report",
    title: "Render the report",
    dependsOn: ["store-report"],
    content: "**What**\n\nShow findings in the dashboard so the review is easy to scan.\n\nRender all original Markdown, including the design sections.\n\n**Why**\n\nReaders need the complete approved design beside the review findings.",
  },
];
const plan = {
  schemaVersion: 1,
  readingOrder: plannedChanges.map(({ id }) => id),
  goal: "Make implementation reviews durable and readable.",
  intro: "Preserve complete approved designs, including prose outside code blocks.",
  testing: "Run the full test suite and verify the dashboard report.",
  // Storage array order is deliberately not display order or slug sort order.
  changes: [...plannedChanges].reverse(),
};

const input = {
  pullRequests: [
    {
      number: 41,
      url: "https://example.test/pull/41",
      baseRefName: "main",
      headRefName: "workflow/review",
    },
    {
      number: 42,
      url: "https://example.test/pull/42",
      baseRefName: "workflow/review",
      headRefName: "workflow/review/dashboard",
    },
  ],
  baseCommit: "base123",
  headCommit: "head456",
  sourceFingerprint: reviewSourceFingerprint("Review the implementation", plan, "clarifications"),
  worktreePath: "/repository/.worktrees/review",
  metadataPath: "/workflow/metadata.json",
  planPath: "/workflow/plan-versions/1.json",
  clarificationsPath: "/workflow/clarifications.json",
  reviewRunsPath: join(temporaryRoot, "review-runs"),
  plan,
  generatedAt: "2026-01-02T03:04:05.000Z",
};

function evidence(location, description) {
  return { location, description };
}

function analysis(id, title) {
  return {
    id,
    title,
    walkthrough: [
      `${id} is implemented by one durable contract.`,
      "",
      "```ts",
      id === "store-report" ? "interface WorkflowReviewReport { findings: Finding[] }" : "renderReview(report): string",
      "```",
      "",
      "> The implementation follows the approved design.",
    ].join("\n"),
    necessary: { status: "yes", explanation: "The implementation maps directly to the planned change." },
    sufficient: { status: id === "store-report" ? "yes" : "partial", explanation: "The core behavior exists." },
    concerns: id === "render-report" ? [{ severity: "warning", title: "Partial rendering", details: "One view is missing.", evidence: [] }] : [],
  };
}

const requests = [];
let synthesisStartedAfterAnalysis = false;
let synthesisResultPaths = [];
const runner = async (request) => {
  requests.push(request);
  assert.ok(request.prompt.includes(plan.goal), `${request.role} sees the approved goal`);
  assert.ok(request.prompt.includes(plan.intro), `${request.role} sees the approved introduction`);
  assert.ok(request.prompt.includes(plan.testing), `${request.role} sees the approved testing criteria`);
  assert.match(request.prompt, /Reading order: store-report, render-report/);
  assert.match(request.prompt, /Depends on: store-report/);
  for (const change of plannedChanges) {
    assert.ok(request.prompt.includes(change.content), `${request.role} sees every word of ${change.id}`);
  }
  assert.doesNotMatch(request.prompt, /PC-\d+|PC-\*/);
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
  assert.doesNotMatch(request.prompt, /store-report is implemented by one durable contract/);
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
  assert.deepEqual(plannedChangeFiles, ["render-report.json", "store-report.json"]);
  assert.deepEqual(savedPlannedChanges, [...plannedChanges].sort((a, b) => a.id.localeCompare(b.id)).map((change) => analysis(change.id, change.title)));
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

function agentStatuses(events, id) {
  return events.filter((event) => event.id === id).map(({ status }) => status);
}

const stages = [];
const agentProgress = [];
const report = await generateWorkflowReview(
  {
    ...input,
    onStage: (stage) => stages.push(stage),
    onAgentProgress: (progress) => agentProgress.push(progress),
  },
  runner,
);
assert.deepEqual(requests.map(({ role }) => role).sort(), ["holistic-review", "planned-change", "planned-change", "testing-criteria", "synthesizer"].sort());
assert.equal(synthesisStartedAfterAnalysis, true);
assert.equal(synthesisResultPaths.length, 3);
assert.deepEqual(stages, ["analysis-complete", "synthesis-complete"]);
for (const id of ["planned-change:store-report", "planned-change:render-report", "holistic-review", "testing-criteria", "synthesizer"]) {
  assert.deepEqual(agentStatuses(agentProgress, id), ["queued", "running", "complete"], `${id} reports its full lifecycle`);
}
assert.deepEqual(report.plannedChanges.map(({ id }) => id), ["store-report", "render-report"]);
assert.equal(agentProgress.find(({ id }) => id === "planned-change:store-report").label, "1. Store the report");
assert.equal(agentProgress.find(({ id }) => id === "planned-change:render-report").label, "2. Render the report");
assert.equal(report.plannedChanges[1].review.sufficient.status, "partial");
assert.equal(report.overallConcerns.length, 1);
assert.equal(report.sourceFingerprint, input.sourceFingerprint);
assert.deepEqual(report.pullRequestUrls, input.pullRequests.map(({ url }) => url));
assert.equal(report.holisticReview.summary, "The changes compose cleanly, with one dashboard gap.");
assert.equal(report.testingCriteria.originalCriteria, plan.testing);
assert.equal(report.testingCriteria.review.satisfied.status, "partial");
assert.equal(report.testingCriteria.review.criteria.length, 2);
assert.ok(isWorkflowReviewReport(report));
assert.equal(report.version, REVIEW_REPORT_VERSION);
assert.equal(REVIEW_REPORT_VERSION, 3);
assert.deepEqual(report.plannedChanges.map(({ review, ...original }) => original), plannedChanges);
for (const change of report.plannedChanges) {
  for (const legacyField of ["what", "why", "pseudocode"]) assert.ok(!Object.hasOwn(change, legacyField));
}

const markdown = renderWorkflowReviewMarkdown(report);
assert.match(markdown, /Pull request stack \(bottom to top\):/);
assert.match(markdown, /1\. https:\/\/example\.test\/pull\/41/);
assert.match(markdown, /2\. https:\/\/example\.test\/pull\/42/);
assert.match(markdown, /## Overall result/);
assert.match(markdown, /## Overall concerns/);
assert.match(markdown, /## Review of planned changes/);
assert.match(markdown, /### 1\. Store the report/);
assert.match(markdown, /### 2\. Render the report/);
assert.match(markdown, /Stable ID: `store-report`/);
assert.match(markdown, /Depends on: `store-report`/);
for (const change of plannedChanges) assert.ok(markdown.includes(change.content));
assert.doesNotMatch(markdown, /\*\*(?:What|Why|Pseudocode):\*\*/);
assert.match(markdown, /interface WorkflowReviewReport/);
assert.match(markdown, /Necessary: \*\*Yes\*\*/);
assert.match(markdown, /## Testing criteria/);
assert.match(markdown, /Run the full test suite/);
assert.match(markdown, /Satisfied: \*\*Partial\*\*/);

const reviewRoundPath = join(input.reviewRunsPath, `${input.baseCommit}..${input.headCommit}`, input.sourceFingerprint);
assert.equal(JSON.parse(await readFile(join(reviewRoundPath, "manifest.json"), "utf8")).status, "complete");
assert.ok(JSON.parse(await readFile(join(reviewRoundPath, "synthesis.json"), "utf8")).overallResult);
const reuseStages = [];
const reuseAgentProgress = [];
const reusedReport = await generateWorkflowReview(
  {
    ...input,
    onStage: (stage) => reuseStages.push(stage),
    onAgentProgress: (progress) => reuseAgentProgress.push(progress),
  },
  async () => {
    throw new Error("A complete review round should not rerun agents.");
  },
);
assert.deepEqual(reusedReport, report);
assert.deepEqual(reuseStages, ["analysis-complete", "synthesis-complete"]);
for (const id of ["planned-change:store-report", "planned-change:render-report", "holistic-review", "testing-criteria", "synthesizer"]) {
  assert.deepEqual(agentStatuses(reuseAgentProgress, id), ["queued", "reused"], `${id} reports cached reuse`);
}

const incrementalInput = {
  ...input,
  headCommit: "head789",
  previousReview: report,
  previousReviewPath: "/workflow/review.json",
  generatedAt: "2026-01-03T03:04:05.000Z",
};
const incrementalRequests = [];
const incrementalStages = [];
const incrementalAgentProgress = [];
const incrementalReport = await generateWorkflowReview(
  {
    ...incrementalInput,
    onStage: (stage) => incrementalStages.push(stage),
    onAgentProgress: (progress) => incrementalAgentProgress.push(progress),
  },
  async (request) => {
    incrementalRequests.push(request);
    if (request.role === "incremental-scope") {
      assert.match(request.prompt, /head456\.\.head789/);
      assert.match(request.prompt, /Previous structured review: \/workflow\/review\.json/);
      assert.ok(request.prompt.includes(plan.intro));
      for (const change of plannedChanges) assert.ok(request.prompt.includes(change.content));
      assert.match(request.prompt, /Depends on: store-report/);
      assert.doesNotMatch(request.prompt, /PC-\d+|PC-\*/);
      return {
        summary: "Only rendering behavior changed.",
        relevantPlannedChanges: [{ id: "render-report", explanation: "The revision changes report rendering." }],
      };
    }
    return runner(request);
  },
);
assert.deepEqual(incrementalRequests.map(({ role }) => role).sort(), [
  "incremental-scope",
  "planned-change",
  "holistic-review",
  "testing-criteria",
  "synthesizer",
].sort());
assert.equal(
  incrementalRequests.filter(({ role, prompt }) => role === "planned-change" && prompt.includes("Planned change identity: store-report:")).length,
  0,
  "an unaffected planned change must not be re-reviewed",
);
assert.equal(
  incrementalRequests.filter(({ role, prompt }) => role === "planned-change" && prompt.includes("Planned change identity: render-report:")).length,
  1,
  "an affected planned change must be re-reviewed",
);
assert.deepEqual(incrementalReport.plannedChanges[0].review, report.plannedChanges[0].review);
assert.deepEqual(incrementalStages, ["scope-complete", "analysis-complete", "synthesis-complete"]);
for (const id of ["incremental-scope", "planned-change:render-report", "holistic-review", "testing-criteria", "synthesizer"]) {
  assert.deepEqual(agentStatuses(incrementalAgentProgress, id), ["queued", "running", "complete"], `${id} reports re-review progress`);
}
assert.deepEqual(agentStatuses(incrementalAgentProgress, "planned-change:store-report"), [], "unaffected changes do not show a rerun agent");
const incrementalRoundPath = join(
  input.reviewRunsPath,
  `${input.baseCommit}..${incrementalInput.headCommit}`,
  input.sourceFingerprint,
);
assert.deepEqual(
  JSON.parse(await readFile(join(incrementalRoundPath, "incremental-review-scope.json"), "utf8"))
    .relevantPlannedChanges.map(({ id }) => id),
  ["render-report"],
);
assert.deepEqual(
  JSON.parse(await readFile(join(incrementalRoundPath, "manifest.json"), "utf8")).relevantPlannedChangeIds,
  ["render-report"],
);
const incrementalReuseAgentProgress = [];
await generateWorkflowReview(
  { ...incrementalInput, onAgentProgress: (progress) => incrementalReuseAgentProgress.push(progress) },
  async () => {
    throw new Error("A completed incremental review must reuse its scope and all completed results.");
  },
);
for (const id of ["incremental-scope", "planned-change:render-report", "holistic-review", "testing-criteria", "synthesizer"]) {
  assert.deepEqual(agentStatuses(incrementalReuseAgentProgress, id), ["queued", "reused"], `${id} reports re-review cache reuse`);
}
assert.deepEqual(agentStatuses(incrementalReuseAgentProgress, "planned-change:store-report"), []);

const noPlannedChangeRequests = [];
const noPlannedChangeReport = await generateWorkflowReview(
  { ...incrementalInput, headCommit: "head-no-planned-change" },
  async (request) => {
    noPlannedChangeRequests.push(request);
    if (request.role === "incremental-scope") {
      return { summary: "The revision does not affect an individual planned change.", relevantPlannedChanges: [] };
    }
    return runner(request);
  },
);
assert.deepEqual(noPlannedChangeRequests.map(({ role }) => role).sort(), [
  "incremental-scope",
  "holistic-review",
  "testing-criteria",
  "synthesizer",
].sort());
assert.deepEqual(
  noPlannedChangeReport.plannedChanges.map(({ review }) => review),
  report.plannedChanges.map(({ review }) => review),
);

await assert.rejects(
  generateWorkflowReview(
    { ...incrementalInput, headCommit: "head-invalid-scope" },
    async (request) => {
      if (request.role === "incremental-scope") {
        return {
          summary: "Invalid selection.",
          relevantPlannedChanges: [{ id: "unknown-change", explanation: "Not in the plan." }],
        };
      }
      return runner(request);
    },
  ),
  /incremental review scope agent returned an invalid result/,
);

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

const failedAgentProgress = [];
await assert.rejects(
  generateWorkflowReview(
    {
      ...input,
      sourceFingerprint: "wrong-identity",
      onAgentProgress: (progress) => failedAgentProgress.push(progress),
    },
    async (request) => {
      if (request.role === "planned-change") return analysis("unknown-change", "Wrong change");
      return runner(request);
    },
  ),
  /wrong planned-change identity/,
);
assert.deepEqual(agentStatuses(failedAgentProgress, "planned-change:store-report"), ["queued", "running", "failed"]);
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

// Slug identity validation is shared by reviewer output, incremental scope, reports, and artifact paths.
for (const invalidId of ["PC-01", "1", "01-store-report", "Store-Report", "store_report", "store--report", "store-", "../escape", "a/b", "a".repeat(81)]) {
  assert.equal(isPlannedChangeAnalysis(analysis(invalidId, "Invalid identity")), false, invalidId);
  assert.equal(isIncrementalReviewScope({ summary: "Invalid identity", relevantPlannedChanges: [{ id: invalidId, explanation: "Invalid" }] }), false, invalidId);
  const invalidReport = structuredClone(report);
  invalidReport.plannedChanges[0].id = invalidId;
  invalidReport.plannedChanges[0].review.id = invalidId;
  assert.equal(isWorkflowReviewReport(invalidReport), false, invalidId);
  await assert.rejects(generateWorkflowReview({
    ...input,
    plan: { ...plan, readingOrder: [invalidId], changes: [{ ...plannedChanges[0], id: invalidId }] },
  }, async () => assert.fail("Invalid slug IDs must be rejected before launching reviewers.")), /invalid.*ID|invalid change ID/);
}
assert.equal(isWorkflowReviewReport({ ...report, version: 2 }), false, "legacy reports cannot silently pass the new schema");
for (const mutate of [
  (value) => { value.plannedChanges[0].review.id = "wrong-change"; },
  (value) => { value.plannedChanges[0].review.title = "Wrong title"; },
  (value) => { value.plannedChanges[0].dependsOn = ["unknown-change"]; },
  (value) => { value.plannedChanges[0].dependsOn = ["store-report"]; },
  (value) => { value.plannedChanges.push(value.plannedChanges[0]); },
  (value) => { value.plannedChanges[0].what = "Legacy field"; },
  (value) => { delete value.plannedChanges[0].content; },
]) {
  const invalidReport = structuredClone(report);
  mutate(invalidReport);
  assert.equal(isWorkflowReviewReport(invalidReport), false);
}
await assert.rejects(generateWorkflowReview({ ...incrementalInput, headCommit: "head-duplicate-scope" }, async (request) => {
  assert.equal(request.role, "incremental-scope");
  return { summary: "Duplicate scope", relevantPlannedChanges: [
    { id: "render-report", explanation: "First" },
    { id: "render-report", explanation: "Repeated" },
  ] };
}), /incremental review scope agent returned an invalid result/);

// Canonical fingerprints use structured semantic fields and preserve every byte of prose.
const fingerprint = (document) => reviewSourceFingerprint("Review the implementation", document, "clarifications");
const snapshot = {
  pullRequestUrls: report.pullRequestUrls,
  baseCommit: input.baseCommit,
  headCommit: input.headCommit,
  sourceFingerprint: input.sourceFingerprint,
  testingCriteria: plan.testing,
  plannedChanges: plannedChanges.map(({ id, title }) => ({ id, title })),
};
assert.equal(reviewIsCurrent(report, snapshot), true);
assert.equal(reviewCanSeedIncremental(report, { ...snapshot, headCommit: "new-head" }), true);
assert.equal(reviewIsCurrent({ ...report, version: 2 }, snapshot), false);
assert.equal(reviewCanSeedIncremental({ ...report, version: 2 }, { ...snapshot, headCommit: "new-head" }), false);
assert.equal(fingerprint({
  changes: [...plan.changes].reverse().map(({ id, title, dependsOn, content }) => ({ content, dependsOn, title, id })),
  testing: plan.testing, intro: plan.intro, goal: plan.goal, readingOrder: plan.readingOrder, schemaVersion: 1,
}), input.sourceFingerprint, "object key and change storage order do not affect the fingerprint");
const multiDependencyPlan = {
  ...plan,
  readingOrder: [...plan.readingOrder, "shared-types"],
  changes: [
    { ...plannedChanges[0] },
    { ...plannedChanges[1], dependsOn: ["store-report", "shared-types"] },
    { id: "shared-types", title: "Shared types", dependsOn: [], content: "**What**\n\nDefine the shared contracts.\n\n**Why**\n\nKeep report storage and rendering compatible." },
  ],
};
assert.equal(fingerprint(multiDependencyPlan), fingerprint({
  ...multiDependencyPlan,
  changes: multiDependencyPlan.changes.map((change) => ({ ...change, dependsOn: [...change.dependsOn].reverse() })),
}), "dependency edge order does not change the graph");
const proseChangedPlan = { ...plan, changes: plan.changes.map((change) => change.id === "store-report" ? { ...change, content: `${change.content}\n\nKeep reports after cleanup too.` } : change) };
const graphChangedPlan = { ...plan, changes: plan.changes.map((change) => ({ ...change, dependsOn: [] })) };
const reorderedPlan = { ...plan, readingOrder: [...plan.readingOrder].reverse() };
for (const changedPlan of [
  proseChangedPlan, graphChangedPlan, reorderedPlan,
  { ...plan, goal: `${plan.goal}\nNew requirement.` },
  { ...plan, intro: `${plan.intro}\nMore context.` },
  { ...plan, intro: undefined },
  { ...plan, testing: `${plan.testing}\nAnother criterion.` },
  { ...plan, changes: plan.changes.map((change) => ({ ...change, title: `${change.title} carefully` })) },
]) {
  if (changedPlan.intro === undefined) delete changedPlan.intro;
  const sourceFingerprint = fingerprint(changedPlan);
  assert.notEqual(sourceFingerprint, input.sourceFingerprint);
  assert.equal(reviewIsCurrent(report, { ...snapshot, sourceFingerprint }), false);
  assert.equal(reviewCanSeedIncremental(report, { ...snapshot, sourceFingerprint, headCommit: "new-head" }), false);
}
assert.notEqual(reviewSourceFingerprint("Changed ask", plan, "clarifications"), input.sourceFingerprint);
assert.notEqual(reviewSourceFingerprint("Review the implementation", plan, "Changed clarifications"), input.sourceFingerprint);

// A prose-only change, an edge-only change, and reading-order changes each start a fresh cache round.
for (const changedPlan of [proseChangedPlan, graphChangedPlan, reorderedPlan]) {
  const roles = [];
  const changedReport = await generateWorkflowReview({ ...input, plan: changedPlan, sourceFingerprint: fingerprint(changedPlan) }, async (request) => {
    roles.push(request.role);
    if (request.role === "planned-change") {
      const change = changedPlan.changes.find(({ id }) => request.prompt.includes(`Planned change identity: ${id}:`));
      assert.ok(request.prompt.includes(change.content));
      return analysis(change.id, change.title);
    }
    if (request.role === "holistic-review") return report.holisticReview;
    if (request.role === "testing-criteria") return report.testingCriteria.review;
    return { overallResult: report.overallResult, overallConcerns: report.overallConcerns };
  });
  assert.deepEqual(roles.sort(), ["planned-change", "planned-change", "holistic-review", "testing-criteria", "synthesizer"].sort());
  assert.deepEqual(changedReport.plannedChanges.map(({ id }) => id), changedPlan.readingOrder);
  assert.deepEqual(changedReport.plannedChanges.map(({ review, ...original }) => original), changedPlan.readingOrder.map((id) => changedPlan.changes.find((change) => change.id === id)));
  assert.ok(isWorkflowReviewReport(changedReport));
  if (changedPlan === reorderedPlan) {
    assert.match(renderWorkflowReviewMarkdown(changedReport), /### 1\. Render the report/);
    assert.match(renderWorkflowReviewMarkdown(changedReport), /### 2\. Store the report/);
  }
}

// File-backed source selection uses the approved immutable version, not latest-plan or a generated Markdown export.
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const repositoryRoot = join(temporaryRoot, "repository");
const metadata = {
  version: storage.WORKFLOW_METADATA_VERSION,
  identifier: "fingerprint-test", description: "Fingerprint test", ask: "Review the implementation",
  repositoryRoot, gitCommonDir: join(repositoryRoot, ".git"),
  worktreePath: join(repositoryRoot, ".worktrees", "fingerprint-test"),
  baseBranch: "main", baseCommit: "base123", workflowBranch: "workflow/fingerprint-test",
  createdAt: "2026-01-01T00:00:00.000Z",
};
await mkdir(metadata.gitCommonDir, { recursive: true });
await mkdir(metadata.worktreePath, { recursive: true });
const files = storage.workflowFiles(metadata.identifier, metadata.worktreePath);
await storage.createWorkflow(files, metadata);
await storage.registerWorkflow(metadata);
const storedClarifications = await readFile(files.clarifications, "utf8");
assert.equal(await readReviewSourceFingerprint(files, metadata.ask), reviewSourceFingerprint(metadata.ask, undefined, storedClarifications), "unapproved workflows with no finalized plan can be cleaned up");
async function writeWorkingPlan(document) {
  await writeFile(join(files.workingPlan, "plan.json"), JSON.stringify({ schemaVersion: 1, readingOrder: document.readingOrder }));
  await writeFile(join(files.workingPlan, "goal.md"), document.goal);
  await writeFile(join(files.workingPlan, "intro.md"), document.intro);
  await writeFile(join(files.workingPlan, "testing.md"), document.testing);
  for (const change of document.changes) {
    const directory = join(files.workingPlan, "planned-changes", change.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "change_metadata.json"), JSON.stringify({ title: change.title, dependsOn: change.dependsOn }));
    await writeFile(join(directory, "change.md"), change.content);
  }
}
await writeWorkingPlan(plan);
await storage.finalizePlanDraft(files, "Initial plan", 0);
const approvedFingerprint = reviewSourceFingerprint(metadata.ask, plan, storedClarifications);
assert.equal(await readReviewSourceFingerprint(files, metadata.ask), approvedFingerprint, "unapproved workflows use the latest finalized plan when present");
await storage.preparePlanDraft(files);
await writeWorkingPlan(proseChangedPlan);
await storage.finalizePlanDraft(files, "Newer unapproved plan", 1);
metadata.approvedPlanVersion = 1;
await storage.writeCompletedWorkflowMetadata(metadata);
await writeFile(join(files.root, "plan.md"), "A generated Markdown export must never define review inputs.");
assert.equal(await readReviewSourceFingerprint(files, metadata.ask), approvedFingerprint, "newer unapproved versions and Markdown exports cannot replace the approved source");
metadata.approvedPlanVersion = 2;
await storage.writeCompletedWorkflowMetadata(metadata);
assert.equal(await readReviewSourceFingerprint(files, metadata.ask), reviewSourceFingerprint(metadata.ask, proseChangedPlan, storedClarifications));
metadata.approvedPlanVersion = 99;
await storage.writeCompletedWorkflowMetadata(metadata);
await assert.rejects(readReviewSourceFingerprint(files, metadata.ask), /approved plan version v99 is missing/i);

await rm(temporaryRoot, { recursive: true, force: true });
console.log("Review test passed: slug-based full/incremental review caches preserve freeform plans and fingerprint exact approved structure and prose.");
