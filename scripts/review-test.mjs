import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { writePlanFixture } from "./plan-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-workflow-review-test-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { generateWorkflowReview } = await jiti.import(new URL("../src/review.ts", import.meta.url).pathname);
const {
  isWorkflowReviewReport, isPlannedChangeAnalysis, isIncrementalReviewScope,
  isTestingCriteriaAnalysis, isTestingCriteriaAnalysisForGroups, renderWorkflowReviewMarkdown,
  REVIEW_REPORT_VERSION,
} = await jiti.import(new URL("../src/review-report.ts", import.meta.url).pathname);
const {
  reviewSourceFingerprint, readReviewSourceFingerprint, reviewInputsFromScope, reviewIsCurrent, reviewCanSeedIncremental,
} = await jiti.import(new URL("../src/review-selection.ts", import.meta.url).pathname);
const { readWorkflowScope, workflowScopeFingerprint, requirementFingerprint } = await jiti.import(new URL("../src/workflow-scope.ts", import.meta.url).pathname);
const { validatePlanDocument } = await jiti.import(new URL("../src/planned-changes.ts", import.meta.url).pathname);
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const yes = { status: "yes", explanation: "Supported by repository evidence." };
const evidence = [{ location: "scripts/review-test.mjs:1", description: "Exercises the review contract." }];
const originalAsk = "Review the implementation";
const clarifications = { version: 1, entries: [{
  id: "scope", label: "Scope", question: "Which changes belong in review?", answer: "Every finalized change.",
  custom: true, answeredAt: "2026-01-01T00:00:00.000Z",
}] };
const originalChanges = [
  { id: "store-report", title: "Store the report", dependsOn: [], content: [
    "Persist structured findings so the review survives cleanup.", "", "### Durability constraints", "",
    "- Write atomically; preserve every paragraph and code example.", "- Keep [the report](./review.json).", "",
    "```ts", "type ReviewReport = { findings: Finding[] };", "```", "",
    "> **Decision:** Keep the freeform rationale with the design.", "",
    "| Contract | Requirement |", "| --- | --- |", "| Report | Must survive cleanup |",
  ].join("\n") },
  { id: "render-report", title: "Render the report", dependsOn: ["store-report"], content: "Show findings in the dashboard.\n\nRender every concern in the original dashboard view." },
];
const plan = {
  schemaVersion: 1, readingOrder: originalChanges.map(({ id }) => id),
  goal: "Make implementation reviews durable and readable.", intro: "Preserve complete approved designs, not just code blocks.",
  testing: "Run the full test suite and verify the original dashboard view.",
  changes: [...originalChanges].reverse(),
};
const origin = { reviewNumber: 1, sessionId: "private-origin-session", entryId: "private-origin-entry" };
const followups = [
  { id: "render-followup", title: "Use the guided dashboard", dependsOn: ["render-report"], implemented: true,
    content: "Use a guided dashboard instead of the original dashboard view.", testing: "Verify guided navigation and preserved evidence.",
    followup: { origin, effect: { type: "amendment", requirements: [
      { source: { type: "change", id: "render-report" }, quotedRequirement: "Render every concern in the original dashboard view." },
      { source: { type: "plan-section", name: "testing" }, quotedRequirement: "verify the original dashboard view" },
    ] } } },
  { id: "export-followup", title: "Export the review", dependsOn: ["store-report"], implemented: false,
    content: "Export the review as portable Markdown.", testing: "Verify portable report exports.",
    followup: { origin: { ...origin, entryId: "private-export-entry" }, effect: { type: "addition" } } },
];
const expandedPlan = {
  ...plan, schemaVersion: 2, readingOrder: [...plan.readingOrder, ...followups.map(({ id }) => id)],
  changes: [...originalChanges.map((change) => ({ ...change, implemented: true })), ...followups].reverse(),
};
function version(document, number) {
  return { number, document, path: `/workflow/plan-versions/v${number}`, createdAt: "2026-01-01T00:00:00.000Z", description: "Snapshot title is not a requirement", content: "Generated export must not enter reviewer context." };
}
function scopeFor(document = plan, options = {}) {
  const current = validatePlanDocument(document, { originalAsk });
  const approved = validatePlanDocument(options.baseline ?? (document.changes.some((change) => change.followup) ? plan : document));
  const changes = current.changes;
  const scope = {
    originalAsk, approvedPlan: version(approved, options.baselineNumber ?? 1),
    currentPlan: version(current, options.currentNumber ?? (changes.some((change) => change.followup) ? 2 : 1)),
    clarifications: structuredClone(options.clarifications ?? clarifications), changes,
    amendments: changes.filter((change) => change.followup?.effect.type === "amendment"),
    followupTesting: changes.filter((change) => change.followup).map((change) => ({ followupId: change.id, criteria: change.testing })),
  };
  return { ...scope, fingerprint: workflowScopeFingerprint(scope) };
}
function inputFor(scope = scopeFor(), overrides = {}) {
  return {
    pullRequests: [
      { number: 41, url: "https://example.test/pull/41", baseRefName: "main", headRefName: "workflow/review" },
      { number: 42, url: "https://example.test/pull/42", baseRefName: "workflow/review", headRefName: "workflow/review/dashboard" },
    ],
    baseCommit: "base123", headCommit: "head456", scope,
    worktreePath: "/repository/.worktrees/review", metadataPath: "/workflow/metadata.json",
    clarificationsPath: "/workflow/clarifications.json", reviewRunsPath: join(root, "review-runs"),
    generatedAt: "2026-01-02T03:04:05.000Z", ...overrides,
  };
}
function inputsFor(input) {
  return reviewInputsFromScope(input.scope, { pullRequestUrls: input.pullRequests.map(({ url }) => url), baseCommit: input.baseCommit, headCommit: input.headCommit });
}
function roundPath(input) { return join(input.reviewRunsPath, `${input.baseCommit}..${input.headCommit}`, inputsFor(input).sourceFingerprint); }
function analysis(change) {
  return {
    id: change.id, title: change.title,
    walkthrough: `${change.id} implementation walkthrough.\n\n\`\`\`ts\nsave(report);\n\`\`\`\n\n> **Decision:** Preserve the original design.`,
    necessary: yes,
    sufficient: change.id === "render-followup" ? { status: "no", explanation: "The guided view is missing despite the implementer's assessment." } : yes,
    concerns: change.id === "render-followup" ? [{ severity: "blocking", title: "Missing guided view", details: "Implement the agreed view.", evidence }] : [],
  };
}
function testing(groups) {
  return {
    summary: "Every source was assessed independently.", satisfied: yes,
    criteria: groups.map(({ sourceId, criteria }) => ({
      sourceId, criterion: criteria, status: "yes", evidence,
      explanation: sourceId === "plan:testing" && groups.length > 1 ? "render-followup explicitly amends the original dashboard criterion; verify the guided view instead." : "Verified against the implementation.",
    })), concerns: [],
  };
}
function runnerFor(input, override = async () => undefined) {
  const inputs = inputsFor(input);
  const requests = [];
  let active = 0, maximum = 0;
  const run = async (request) => {
    requests.push(request);
    active++;
    maximum = Math.max(maximum, active);
    try {
      assert.ok(request.prompt.includes(input.scope.originalAsk));
      assert.ok(request.prompt.includes(input.scope.approvedPlan.path));
      assert.ok(request.prompt.includes(input.scope.currentPlan.path));
      assert.ok(request.prompt.includes(input.scope.approvedPlan.document.goal));
      assert.ok(request.prompt.includes(input.scope.clarifications.entries[0]?.answer ?? "Clarifications:"));
      assert.ok(request.prompt.includes(`Reading order: ${inputs.plannedChanges.map(({ id }) => id).join(", ")}`));
      assert.match(request.prompt, /Implementation flags are not evidence of correctness/);
      assert.doesNotMatch(request.prompt, /private-origin|private-export|Generated export|implemented["']?\s*[:=]\s*(?:true|false)|PC-\d+/);
      for (const change of inputs.plannedChanges) {
        assert.ok(request.prompt.includes(change.content));
        assert.ok(request.prompt.includes(`Depends on: ${change.dependsOn.length ? change.dependsOn.join(", ") : "None"}`));
        if (change.kind === "followup") assert.ok(request.prompt.includes(JSON.stringify(change.effect)));
      }
      for (const group of inputs.testingGroups) {
        assert.ok(request.prompt.includes(`Testing source ID: ${group.sourceId}`));
        assert.ok(request.prompt.includes(group.criteria));
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      const replacement = await override(request);
      if (replacement !== undefined) return replacement;
      if (request.role === "planned-change") {
        const assigned = inputs.plannedChanges.find(({ id }) => request.prompt.includes(`Planned change identity: ${id}:`));
        assert.ok(assigned);
        return analysis(assigned);
      }
      if (request.role === "incremental-scope") return { summary: "Rendering changed.", relevantPlannedChanges: [{ id: "render-report", explanation: "The view changed." }] };
      if (request.role === "holistic-review") return { summary: "The aggregate delivery was reviewed.", necessary: yes, sufficient: yes, concerns: [] };
      if (request.role === "testing-criteria") return testing(inputs.testingGroups);
      assert.equal(request.role, "synthesizer");
      const directory = /Planned-change review directory: (.+)$/m.exec(request.prompt)?.[1];
      const holisticPath = /Holistic review result: (.+)$/m.exec(request.prompt)?.[1];
      const testingPath = /Testing criteria review result: (.+)$/m.exec(request.prompt)?.[1];
      assert.ok(directory && holisticPath && testingPath);
      assert.deepEqual((await readdir(directory)).sort(), inputs.plannedChanges.map(({ id }) => `${id}.json`).sort());
      for (const change of inputs.plannedChanges) assert.equal(JSON.parse(await readFile(join(directory, `${change.id}.json`), "utf8")).id, change.id);
      assert.ok(JSON.parse(await readFile(holisticPath, "utf8")).summary);
      assert.ok(isTestingCriteriaAnalysisForGroups(JSON.parse(await readFile(testingPath, "utf8")), inputs.testingGroups));
      assert.doesNotMatch(request.prompt, /implementation walkthrough\./, "synthesis reads findings from files, not injected result bodies");
      return { overallResult: { summary: "Aggregate findings.", necessary: yes, sufficient: yes }, overallConcerns: [] };
    } finally { active--; }
  };
  return { run, requests, get maximum() { return maximum; } };
}
const roles = (runner) => runner.requests.map(({ role }) => role).sort();
const fullRoles = (n) => [...Array(n).fill("planned-change"), "holistic-review", "testing-criteria", "synthesizer"].sort();
const statuses = (events, id) => events.filter((event) => event.id === id).map(({ status }) => status);
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function saveJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
async function snapshotFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshotFiles(path) : { [path]: await readFile(path, "utf8") };
  }));
  return Object.assign({}, ...files);
}

try {
  // No-followup workflows retain their full/incremental review behavior, now writing v4.
  const input = inputFor();
  const before = structuredClone(input.scope);
  const events = [], stages = [];
  const runner = runnerFor(input);
  const report = await generateWorkflowReview({ ...input, onAgentProgress: (event) => events.push(event), onStage: (stage) => stages.push(stage) }, runner.run);
  assert.equal(REVIEW_REPORT_VERSION, 4);
  assert.equal(report.version, 4);
  assert.equal(report.baselinePlanVersion, 1);
  assert.equal(report.currentPlanVersion, 1);
  assert.ok(isWorkflowReviewReport(report));
  assert.deepEqual(input.scope, before, "review does not mutate assessments or captured sources");
  assert.deepEqual(roles(runner), fullRoles(2));
  assert.deepEqual(stages, ["analysis-complete", "synthesis-complete"]);
  assert.deepEqual(report.plannedChanges.map(({ review, ...definition }) => definition), inputsFor(input).plannedChanges);
  assert.deepEqual(report.testingCriteria.groups, inputsFor(input).testingGroups);
  assert.equal(report.testingCriteria.originalCriteria, plan.testing);
  assert.equal(report.sourceFingerprint, input.scope.fingerprint);
  assert.deepEqual(report.pullRequestUrls, input.pullRequests.map(({ url }) => url));
  for (const id of ["planned-change:store-report", "planned-change:render-report", "holistic-review", "testing-criteria", "synthesizer"]) {
    assert.deepEqual(statuses(events, id), ["queued", "running", "complete"]);
  }
  assert.equal(events.find(({ id }) => id === "planned-change:store-report").label, "1. Store the report");
  assert.deepEqual((await json(join(roundPath(input), "manifest.json"))).version, 4);
  assert.equal((await json(join(roundPath(input), "manifest.json"))).status, "complete");
  const markdown = renderWorkflowReviewMarkdown(report);
  for (const text of ["## Overall result", "## Overall concerns", "### 1. Store the report", "### 2. Render the report", "Kind: Original", "Source: `plan:testing`", "baseline v1; current v1", ...originalChanges.map(({ content }) => content)]) assert.ok(markdown.includes(text));
  assert.match(markdown, /Pull request stack \(bottom to top\)/);
  assert.doesNotMatch(markdown, /\*\*(?:What|Why|Pseudocode):\*\*/);
  const reusedEvents = [];
  assert.deepEqual(await generateWorkflowReview({ ...input, onAgentProgress: (event) => reusedEvents.push(event) }, async () => assert.fail("complete rounds reuse all valid outputs")), report);
  assert.deepEqual(statuses(reusedEvents, "testing-criteria"), ["queued", "reused"]);

  const incremental = { ...input, headCommit: "head789", previousReview: report, previousReviewPath: "/workflow/reviews/0001.json" };
  const incrementalRunner = runnerFor(incremental);
  const incrementalReport = await generateWorkflowReview(incremental, incrementalRunner.run);
  assert.deepEqual(roles(incrementalRunner), ["incremental-scope", "planned-change", "holistic-review", "testing-criteria", "synthesizer"].sort());
  assert.deepEqual(incrementalReport.plannedChanges[0].review, report.plannedChanges[0].review);
  assert.ok(incrementalRunner.requests[0].prompt.includes("head456..head789"));
  assert.ok(incrementalRunner.requests[0].prompt.includes(incremental.previousReviewPath));
  assert.deepEqual((await json(join(roundPath(incremental), "manifest.json"))).relevantPlannedChangeIds, ["render-report"]);
  assert.deepEqual(await generateWorkflowReview(incremental, async () => assert.fail("incremental cache should be complete")), incrementalReport);
  const emptyScopeInput = { ...incremental, headCommit: "empty-scope" };
  const emptyScopeRunner = runnerFor(emptyScopeInput, async (request) => request.role === "incremental-scope" ? { summary: "No focused verdict changed.", relevantPlannedChanges: [] } : undefined);
  const emptyScopeReport = await generateWorkflowReview(emptyScopeInput, emptyScopeRunner.run);
  assert.deepEqual(roles(emptyScopeRunner), ["incremental-scope", "holistic-review", "testing-criteria", "synthesizer"].sort());
  assert.deepEqual(emptyScopeReport.plannedChanges, report.plannedChanges);

  // Expanded scope at the same content HEAD starts a full review, including marked changes.
  const expanded = inputFor(scopeFor(expandedPlan));
  const expandedBefore = structuredClone(expanded.scope);
  assert.equal(reviewIsCurrent(report, inputsFor(expanded)), false);
  assert.equal(reviewCanSeedIncremental(report, { ...inputsFor(expanded), headCommit: "next-head" }), false);
  await assert.rejects(generateWorkflowReview({ ...expanded, previousReview: report, previousReviewPath: "old.json" }, async () => assert.fail("cross-scope seeds rejected before launching")), /cannot seed/);
  const expandedRunner = runnerFor(expanded);
  const expandedReport = await generateWorkflowReview(expanded, expandedRunner.run);
  assert.deepEqual(roles(expandedRunner), fullRoles(4));
  assert.equal(expandedRunner.maximum, 4, "review concurrency remains four");
  assert.deepEqual(expanded.scope, expandedBefore);
  assert.equal(expandedReport.plannedChanges.find(({ id }) => id === "render-followup").review.sufficient.status, "no");
  assert.equal(expanded.scope.changes.find(({ id }) => id === "render-followup").implemented, true);
  assert.deepEqual(expandedReport.testingCriteria.groups.map(({ sourceId }) => sourceId), ["plan:testing", "followup:render-followup", "followup:export-followup"]);
  const expandedMarkdown = renderWorkflowReviewMarkdown(expandedReport);
  for (const text of ["Kind: Followup", "Amends:", followups[0].testing, followups[1].testing, "Source: `followup:render-followup`", "render-followup explicitly amends"]) assert.ok(expandedMarkdown.includes(text));
  assert.doesNotMatch(JSON.stringify(expandedReport), /"implemented"|"origin"|"decision"/);

  const expandedIncremental = { ...expanded, headCommit: "followup-revision", previousReview: expandedReport, previousReviewPath: "/workflow/reviews/0002.json" };
  const expandedIncrementalRunner = runnerFor(expandedIncremental, async (request) => request.role === "incremental-scope" ? { summary: "Only the followup changed.", relevantPlannedChanges: [{ id: "render-followup", explanation: "Guided rendering changed." }] } : undefined);
  const followupReport = await generateWorkflowReview(expandedIncremental, expandedIncrementalRunner.run);
  assert.deepEqual(roles(expandedIncrementalRunner), ["incremental-scope", "planned-change", "holistic-review", "testing-criteria", "synthesizer"].sort());
  assert.deepEqual(followupReport.plannedChanges[0].review, expandedReport.plannedChanges[0].review);
  assert.ok(expandedIncrementalRunner.requests.some(({ role, prompt }) => role === "planned-change" && prompt.includes("Planned change identity: render-followup:")));

  // Progress-only versions and origin metadata do not change selection, prompts' requirements, or cache keys.
  const toggled = structuredClone(expandedPlan);
  for (const change of toggled.changes) {
    change.implemented = !change.implemented;
    if (change.followup) change.followup.origin = { reviewNumber: 9, sessionId: "private-origin-new", entryId: "private-export-new" };
  }
  const toggledInput = inputFor(scopeFor(toggled, { currentNumber: 3 }));
  assert.equal(inputsFor(toggledInput).sourceFingerprint, expandedReport.sourceFingerprint);
  assert.equal(roundPath(toggledInput), roundPath(expanded));
  assert.equal(reviewIsCurrent(expandedReport, inputsFor(toggledInput)), true);
  assert.equal(reviewCanSeedIncremental(expandedReport, { ...inputsFor(toggledInput), headCommit: "next" }), true);
  const toggledReport = await generateWorkflowReview(toggledInput, async () => assert.fail("flag-only version must reuse agent outputs"));
  assert.equal(toggledReport.currentPlanVersion, 3);
  assert.deepEqual(toggledReport.plannedChanges, expandedReport.plannedChanges);
  assert.equal(expandedReport.currentPlanVersion, 2, "old report provenance stays unchanged");
  const mutableInput = inputFor(scopeFor(expandedPlan), { headCommit: "captured-scope" });
  const capturedInput = structuredClone(mutableInput);
  let mutated = false;
  const mutationRunner = runnerFor(capturedInput, async () => {
    if (!mutated) {
      mutated = true;
      mutableInput.scope.currentPlan.number = 99;
      mutableInput.scope.currentPlan.path = "/workflow/plan-versions/v99";
      mutableInput.scope.changes.find(({ id }) => id === "export-followup").content = "Later input mutation.";
    }
  });
  const capturedReport = await generateWorkflowReview(mutableInput, mutationRunner.run);
  assert.equal(capturedReport.currentPlanVersion, 2);
  assert.deepEqual(capturedReport.plannedChanges, expandedReport.plannedChanges, "all agents and the report use captured scope; publication freshness is checked by orchestration");
  const convertedPlan = { ...plan, schemaVersion: 2, changes: originalChanges.map((change) => ({ ...change, implemented: true })) };
  const convertedInput = inputFor(scopeFor(convertedPlan, { baseline: plan, currentNumber: 2 }));
  assert.equal(inputsFor(convertedInput).sourceFingerprint, report.sourceFingerprint);
  assert.equal(reviewIsCurrent(report, inputsFor(convertedInput)), true);
  const convertedBaseline = scopeFor(convertedPlan);
  assert.equal(convertedBaseline.fingerprint, input.scope.fingerprint, "baseline flags and schema version are not requirements either");

  // Requirement changes include followup prose, titles, dependencies, tests, amendments and reading order.
  for (const mutate of [
    (doc) => { doc.changes.find(({ id }) => id === "export-followup").content += "\nKeep exports portable."; },
    (doc) => { doc.changes.find(({ id }) => id === "export-followup").title += " safely"; },
    (doc) => { doc.changes.find(({ id }) => id === "export-followup").dependsOn = ["render-report"]; },
    (doc) => { doc.changes.find(({ id }) => id === "export-followup").testing += "\nVerify filenames."; },
    (doc) => { doc.changes.find(({ id }) => id === "render-followup").followup.effect.requirements.pop(); },
    (doc) => { doc.readingOrder = [...plan.readingOrder, "export-followup", "render-followup"]; },
  ]) {
    const changed = structuredClone(expandedPlan); mutate(changed);
    const next = inputFor(scopeFor(changed));
    assert.notEqual(inputsFor(next).sourceFingerprint, expandedReport.sourceFingerprint);
    assert.equal(reviewIsCurrent(expandedReport, inputsFor(next)), false);
    assert.equal(reviewCanSeedIncremental(expandedReport, { ...inputsFor(next), headCommit: "next" }), false);
    const changedRunner = runnerFor(next);
    assert.ok(isWorkflowReviewReport(await generateWorkflowReview(next, changedRunner.run)));
    assert.deepEqual(roles(changedRunner), fullRoles(4));
  }
  assert.equal(renderWorkflowReviewMarkdown(expandedReport), expandedMarkdown, "later followup definitions never relabel an older report");

  // Canonicalization is shared with legacy callers, independent of object/storage/dependency order.
  const fingerprint = (document, context = JSON.stringify(clarifications)) => reviewSourceFingerprint(originalAsk, document, context);
  assert.equal(fingerprint(plan), input.scope.fingerprint);
  assert.equal(fingerprint(expandedPlan), expanded.scope.fingerprint);
  assert.equal(fingerprint(plan), requirementFingerprint(originalAsk, plan, clarifications));
  assert.equal(fingerprint({ ...plan, changes: [...plan.changes].reverse() }), fingerprint(plan));
  const multiDependency = { ...expandedPlan, changes: expandedPlan.changes.map((change) => change.id === "export-followup" ? { ...change, dependsOn: ["store-report", "render-report"] } : change) };
  assert.equal(fingerprint(multiDependency), fingerprint({ ...multiDependency, changes: multiDependency.changes.map((change) => ({ ...change, dependsOn: [...change.dependsOn].reverse() })) }));
  const changedClarifications = structuredClone(clarifications);
  changedClarifications.entries[0].answeredAt = "2030-01-01";
  changedClarifications.entries[0].id = "ui-metadata-only";
  assert.equal(fingerprint(plan, JSON.stringify(changedClarifications)), fingerprint(plan));
  changedClarifications.entries[0].answer += " New requirement.";
  assert.notEqual(fingerprint(plan, JSON.stringify(changedClarifications)), fingerprint(plan));
  assert.notEqual(reviewSourceFingerprint("Different ask", plan, JSON.stringify(clarifications)), fingerprint(plan));
  for (const change of [
    { ...plan, goal: plan.goal + " More." }, { ...plan, intro: plan.intro + " More." }, { ...plan, testing: plan.testing + " More." },
    { ...plan, readingOrder: [...plan.readingOrder].reverse() },
    { ...plan, changes: plan.changes.map((change) => ({ ...change, dependsOn: [] })) },
    { ...plan, changes: plan.changes.map((change) => ({ ...change, content: change.content + "\nMore." })) },
  ]) assert.notEqual(fingerprint(change), fingerprint(plan));

  // Invalid agent output is rejected, including recognized syntax with unknown source IDs.
  const groups = inputsFor(expanded).testingGroups;
  const multiResult = testing(groups);
  multiResult.criteria.push({ ...multiResult.criteria[0], criterion: "Another original criterion." });
  assert.equal(isTestingCriteriaAnalysisForGroups(multiResult, groups), true);
  const invalidTesting = [
    { ...testing(groups), criteria: [] },
    { ...testing(groups), criteria: testing(groups).criteria.slice(1) },
    { ...testing(groups), criteria: testing(groups).criteria.slice(0, -1) },
    { ...testing(groups), criteria: testing(groups).criteria.map((criterion, index) => index ? criterion : { ...criterion, sourceId: "followup:unknown-change" }) },
    { ...testing(groups), criteria: testing(groups).criteria.map(({ sourceId, ...criterion }) => criterion) },
    { ...testing(groups), criteria: testing(groups).criteria.map((criterion) => ({ ...criterion, evidence: [] })) },
  ];
  for (const [index, value] of invalidTesting.entries()) {
    assert.equal(isTestingCriteriaAnalysisForGroups(value, groups), false);
    const invalidInput = { ...expanded, headCommit: `invalid-testing-${index}` };
    const invalidRunner = runnerFor(invalidInput, async (request) => request.role === "testing-criteria" ? value : undefined);
    await assert.rejects(generateWorkflowReview(invalidInput, invalidRunner.run), /testing criteria reviewer returned an invalid result/);
    assert.equal(invalidRunner.requests.some(({ role }) => role === "synthesizer"), false);
    const validRetry = runnerFor(invalidInput);
    assert.ok(isWorkflowReviewReport(await generateWorkflowReview(invalidInput, validRetry.run)));
    assert.deepEqual(roles(validRetry), ["testing-criteria", "synthesizer"].sort(), "retry retains completed analyses after testing validation fails");
  }
  assert.equal(isTestingCriteriaAnalysis(testing(groups)), true);
  assert.equal(isTestingCriteriaAnalysisForGroups(testing(groups), [...groups, groups[0]]), false);
  for (const [index, ids] of [["unknown-change"], ["render-report", "render-report"]].entries()) {
    const invalidInput = { ...incremental, headCommit: `invalid-scope-${index}` };
    const invalidRunner = runnerFor(invalidInput, async (request) => request.role === "incremental-scope" ? { summary: "Invalid selection.", relevantPlannedChanges: ids.map((id) => ({ id, explanation: "Selected." })) } : undefined);
    await assert.rejects(generateWorkflowReview(invalidInput, invalidRunner.run), /incremental review scope agent returned an invalid result/);
  }
  const wrongInput = { ...input, headCommit: "wrong-identity" };
  const failedEvents = [];
  const wrongRunner = runnerFor(wrongInput, async (request) => request.role === "planned-change" ? analysis({ id: "unknown-change", title: "Wrong change" }) : undefined);
  await assert.rejects(generateWorkflowReview({ ...wrongInput, onAgentProgress: (event) => failedEvents.push(event) }, wrongRunner.run), /wrong planned-change identity/);
  assert.deepEqual(statuses(failedEvents, "planned-change:store-report"), ["queued", "running", "failed"]);
  for (const invalidId of ["PC-01", "1", "01-store-report", "Store-Report", "store_report", "store--report", "store-", "../escape", "a/b", "a".repeat(81)]) {
    assert.equal(isPlannedChangeAnalysis(analysis({ id: invalidId, title: "Invalid" })), false);
    assert.equal(isIncrementalReviewScope({ summary: "Invalid", relevantPlannedChanges: [{ id: invalidId, explanation: "Invalid" }] }), false);
    const badScope = structuredClone(input.scope);
    badScope.changes[0].id = invalidId;
    badScope.currentPlan.document.readingOrder[0] = invalidId;
    await assert.rejects(generateWorkflowReview({ ...input, scope: badScope }, async () => assert.fail("invalid IDs rejected before agents run")), /invalid.*ID|unknown change/);
  }

  // Retry caches validate testing coverage too, and regenerate synthesis after replacing invalid results.
  const resumeInput = { ...expanded, headCommit: "resume-synthesis" };
  const firstTry = runnerFor(resumeInput, async (request) => { if (request.role === "synthesizer") throw new Error("Synthetic synthesis failure"); });
  await assert.rejects(generateWorkflowReview(resumeInput, firstTry.run), /Synthetic synthesis failure/);
  const retry = runnerFor(resumeInput);
  await generateWorkflowReview(resumeInput, retry.run);
  assert.deepEqual(roles(retry), ["synthesizer"]);
  const testingPath = join(roundPath(resumeInput), "testing-criteria-review.json");
  for (const value of invalidTesting) {
    await saveJson(testingPath, value);
    const corruptRetry = runnerFor(resumeInput);
    const repaired = await generateWorkflowReview(resumeInput, corruptRetry.run);
    assert.deepEqual(roles(corruptRetry), ["testing-criteria", "synthesizer"].sort(), "invalid/missing cached source IDs and incomplete coverage are never reused");
    assert.ok(isTestingCriteriaAnalysisForGroups(repaired.testingCriteria.review, groups));
  }
  await saveJson(testingPath, invalidTesting[2]);
  await saveJson(join(roundPath(resumeInput), "holistic-review.json"), {});
  const partialReplacement = runnerFor(resumeInput, async (request) => {
    if (request.role === "holistic-review") throw new Error("Replacement holistic failure");
  });
  await assert.rejects(generateWorkflowReview(resumeInput, partialReplacement.run), /Replacement holistic failure/);
  assert.ok(isTestingCriteriaAnalysisForGroups(await json(testingPath), groups), "completed replacement analyses survive another worker's failure");
  await assert.rejects(readFile(join(roundPath(resumeInput), "synthesis.json")), { code: "ENOENT" }, "synthesis invalidation survives a partially failed attempt");
  const replacementRetry = runnerFor(resumeInput);
  await generateWorkflowReview(resumeInput, replacementRetry.run);
  assert.deepEqual(roles(replacementRetry), ["holistic-review", "synthesizer"].sort());
  // Repaired evidence must invalidate an old synthesis across a failed retry, not only in memory.
  await saveJson(testingPath, invalidTesting[4]);
  const replacementTesting = { ...testing(groups), summary: "Corrected evidence after an invalid cached testing result." };
  const replacementFailure = runnerFor(resumeInput, async (request) => {
    if (request.role === "testing-criteria") return replacementTesting;
    if (request.role === "synthesizer") throw new Error("Replacement synthesis failed");
  });
  await assert.rejects(generateWorkflowReview(resumeInput, replacementFailure.run), /Replacement synthesis failed/);
  assert.deepEqual(roles(replacementFailure), ["testing-criteria", "synthesizer"].sort());
  assert.deepEqual(await json(testingPath), replacementTesting);
  const synthesisReplacementRetry = runnerFor(resumeInput);
  assert.deepEqual((await generateWorkflowReview(resumeInput, synthesisReplacementRetry.run)).testingCriteria.review, replacementTesting);
  assert.deepEqual(roles(synthesisReplacementRetry), ["synthesizer"], "never reuse the synthesis from before cached evidence was repaired");
  const manifestPath = join(roundPath(resumeInput), "manifest.json");
  await saveJson(manifestPath, { ...await json(manifestPath), version: 3 });
  const oldCacheRunner = runnerFor(resumeInput);
  await generateWorkflowReview(resumeInput, oldCacheRunner.run);
  assert.deepEqual(roles(oldCacheRunner), fullRoles(4), "v3 cache manifests cannot seed a v4 run");
  const invalidScopeCache = join(roundPath(incremental), "incremental-review-scope.json");
  await saveJson(invalidScopeCache, { summary: "Corrupt", relevantPlannedChanges: [{ id: "unknown-change", explanation: "Invalid" }] });
  const scopeRetry = runnerFor(incremental);
  await generateWorkflowReview(incremental, scopeRetry.run);
  assert.deepEqual(roles(scopeRetry), ["incremental-scope", "planned-change", "holistic-review", "testing-criteria", "synthesizer"].sort());

  // V3 is readable as-is, never considered current or an incremental seed.
  const legacy = {
    ...report, version: 3,
    plannedChanges: report.plannedChanges.map(({ kind, ...change }) => change),
    testingCriteria: { originalCriteria: report.testingCriteria.originalCriteria, review: {
      ...report.testingCriteria.review, criteria: report.testingCriteria.review.criteria.map(({ sourceId, ...criterion }) => criterion),
    } },
  };
  delete legacy.baselinePlanVersion; delete legacy.currentPlanVersion;
  assert.ok(isWorkflowReviewReport(legacy));
  assert.ok(isWorkflowReviewReport({ ...legacy, sourceFingerprint: undefined, holisticReview: undefined }));
  assert.equal(reviewIsCurrent(legacy, inputsFor(input)), false);
  assert.equal(reviewCanSeedIncremental(legacy, { ...inputsFor(input), headCommit: "next" }), false);
  await assert.rejects(generateWorkflowReview({ ...incremental, previousReview: legacy }, async () => assert.fail("legacy seeds rejected")), /cannot seed/);
  assert.ok(renderWorkflowReviewMarkdown(legacy).includes(originalChanges[0].content));
  assert.equal(isWorkflowReviewReport({ ...legacy, version: 2 }), false);
  for (const mutate of [
    (value) => { value.plannedChanges[0].review.id = "wrong-change"; },
    (value) => { value.plannedChanges[0].review.title = "Wrong title"; },
    (value) => { value.plannedChanges[0].dependsOn = ["unknown-change"]; },
    (value) => { value.plannedChanges[0].dependsOn = ["store-report"]; },
    (value) => { value.plannedChanges[0].dependsOn = ["render-report"]; },
    (value) => { value.plannedChanges.push(value.plannedChanges[0]); },
    (value) => { value.plannedChanges[0].implemented = true; },
    (value) => { delete value.plannedChanges[0].content; },
    (value) => { delete value.sourceFingerprint; },
    (value) => { value.currentPlanVersion = 0; },
    (value) => { value.baselinePlanVersion = 99; },
    (value) => { value.testingCriteria.groups.push(value.testingCriteria.groups[0]); },
    (value) => { value.testingCriteria.groups[0].criteria = "Wrong original text"; },
    (value) => { value.testingCriteria.review.criteria.pop(); },
    (value) => { value.plannedChanges[2].effect.requirements[0].source.id = "unknown-change"; },
    (value) => { value.plannedChanges[2].effect.requirements[0].quotedRequirement = "Unrecognized original requirement"; },
    (value) => { value.plannedChanges[2].effect.requirements[0].source.id = "render-followup"; },
    (value) => { value.plannedChanges[2].kind = "original"; },
  ]) {
    const invalid = structuredClone(expandedReport); mutate(invalid);
    assert.equal(isWorkflowReviewReport(invalid), false);
  }
  const wrongDefinition = structuredClone(expandedReport);
  wrongDefinition.plannedChanges[2].content += " Changed.";
  assert.equal(reviewIsCurrent(wrongDefinition, inputsFor(expanded)), false, "matching fingerprint alone cannot hide a mismatched report definition");
  await assert.rejects(generateWorkflowReview({ ...input, pullRequests: [] }, async () => assert.fail("empty delivery")), /no pull requests/);
  await assert.rejects(generateWorkflowReview({ ...input, previousReview: report }, async () => assert.fail("missing previous path")), /both the previous review and its path/);

  // Persisted workflows exercise selection/generation together, not just synthetic scope objects.
  const repositoryRoot = join(root, "repository");
  const metadata = {
    version: storage.WORKFLOW_METADATA_VERSION, identifier: "fingerprint-test", description: "Fingerprint test", ask: originalAsk,
    repositoryRoot, gitCommonDir: join(repositoryRoot, ".git"), worktreePath: join(repositoryRoot, ".worktrees", "fingerprint-test"),
    baseBranch: "main", baseCommit: "base123", workflowBranch: "workflow/fingerprint-test", createdAt: "2026-01-01T00:00:00.000Z",
  };
  await mkdir(metadata.gitCommonDir, { recursive: true });
  await mkdir(metadata.worktreePath, { recursive: true });
  const files = storage.workflowFiles(metadata.identifier, metadata.worktreePath);
  await storage.createWorkflow(files, metadata);
  await storage.registerWorkflow(metadata);
  await saveJson(files.clarifications, clarifications);
  assert.equal(await readReviewSourceFingerprint(files, originalAsk), reviewSourceFingerprint(originalAsk, undefined, JSON.stringify(clarifications)));
  await writePlanFixture(files.workingPlan, plan);
  await storage.finalizePlanDraft(files, "Legacy original", 0);
  assert.equal(await readReviewSourceFingerprint(files, originalAsk), input.scope.fingerprint);
  metadata.approvedPlanVersion = 1;
  await storage.writeCompletedWorkflowMetadata(metadata);
  const diskInputFor = async (overrides = {}) => inputFor(await readWorkflowScope(files, metadata), {
    worktreePath: metadata.worktreePath, metadataPath: files.metadata, clarificationsPath: files.clarifications,
    headCommit: "disk-review", reviewRunsPath: files.reviewRuns, ...overrides,
  });
  const savedLegacy = await storage.appendWorkflowReview(files, legacy);
  const legacyFiles = await snapshotFiles(files.reviews);
  const diskOriginalInput = await diskInputFor();
  assert.deepEqual(await storage.readWorkflowReview(files), legacy, "legacy reports remain readable from the latest export");
  assert.equal(reviewIsCurrent((await storage.listSavedReviews(files))[0].report, inputsFor(diskOriginalInput)), false);
  assert.equal(reviewCanSeedIncremental(legacy, { ...inputsFor(diskOriginalInput), headCommit: "disk-next" }), false);
  const diskOriginalRunner = runnerFor(diskOriginalInput);
  const diskOriginalReport = await generateWorkflowReview(diskOriginalInput, diskOriginalRunner.run);
  assert.deepEqual(roles(diskOriginalRunner), fullRoles(2));
  const savedOriginal = await storage.appendWorkflowReview(files, diskOriginalReport);
  const baselineFiles = await snapshotFiles(join(files.versions, "v1"));

  // A real v1 -> v2 conversion, with unchanged requirements, reuses the same round.
  await storage.preparePlanDraft(files);
  await writePlanFixture(files.workingPlan, { ...plan, schemaVersion: 2, changes: plan.changes.map((change) => ({ ...change, implemented: false })) });
  await storage.finalizePlanDraft(files, "Convert assessment metadata", 1, { phase: "implementation" });
  const diskConverted = await diskInputFor();
  assert.equal(roundPath(diskConverted), roundPath(diskOriginalInput));
  assert.equal(reviewIsCurrent(diskOriginalReport, inputsFor(diskConverted)), true);
  assert.equal((await generateWorkflowReview(diskConverted, async () => assert.fail("persisted conversion must reuse the original round"))).currentPlanVersion, 2);

  await storage.preparePlanDraft(files);
  const publishedExpanded = { ...expandedPlan, changes: expandedPlan.changes.map((change) => ({ ...change, implemented: false })) };
  await writePlanFixture(files.workingPlan, publishedExpanded);
  await storage.finalizePlanDraft(files, "Finalize followups", 2, { phase: "review", reviewOrigin: { reviewNumber: savedLegacy.number, sessionId: origin.sessionId, entryIds: [origin.entryId, "private-export-entry"] } });
  const diskScope = await readWorkflowScope(files, metadata);
  assert.equal(diskScope.approvedPlan.number, 1);
  assert.equal(diskScope.currentPlan.number, 3);
  assert.equal(await readReviewSourceFingerprint(files, originalAsk), expandedReport.sourceFingerprint);
  await writeFile(join(files.root, "plan.md"), "Generated presentation cannot change requirements.");
  await storage.preparePlanDraft(files);
  await writeFile(join(files.workingPlan, "planned-changes", "export-followup", "change.md"), "Unsaved draft is not review scope.");
  assert.equal(await readReviewSourceFingerprint(files, originalAsk), expandedReport.sourceFingerprint);
  await writePlanFixture(files.workingPlan, { ...publishedExpanded, changes: publishedExpanded.changes.map((change) => ({ ...change, implemented: true })) });
  await storage.finalizePlanDraft(files, "Implementation assessments only", 3, { phase: "implementation" });
  const diskInput = await diskInputFor();
  assert.equal(inputsFor(diskInput).sourceFingerprint, expandedReport.sourceFingerprint);
  assert.equal(diskInput.headCommit, diskOriginalReport.headCommit, "scope expands without changing the content HEAD");
  assert.equal(reviewIsCurrent(diskOriginalReport, inputsFor(diskInput)), false);
  assert.equal(reviewCanSeedIncremental(diskOriginalReport, { ...inputsFor(diskInput), headCommit: "disk-next" }), false);
  await assert.rejects(generateWorkflowReview({ ...diskInput, previousReview: diskOriginalReport, previousReviewPath: savedOriginal.path }, async () => assert.fail("old persisted scope cannot seed review")), /cannot seed/);
  const versionFiles = await snapshotFiles(files.versions);
  const contextFiles = await Promise.all([files.metadata, files.clarifications].map((path) => readFile(path, "utf8")));
  const diskRunner = runnerFor(diskInput);
  const diskReport = await generateWorkflowReview(diskInput, diskRunner.run);
  assert.deepEqual(roles(diskRunner), fullRoles(4), "every original and finalized followup gets a full same-HEAD review");
  assert.ok(diskInput.scope.changes.every(({ implemented }) => implemented));
  assert.equal(diskReport.plannedChanges.find(({ id }) => id === "render-followup").review.sufficient.status, "no");
  assert.deepEqual(diskReport.plannedChanges.map(({ kind }) => kind), ["original", "original", "followup", "followup"]);
  assert.deepEqual(diskReport.testingCriteria.groups, inputsFor(diskInput).testingGroups);
  assert.equal(diskReport.testingCriteria.originalCriteria, plan.testing);
  assert.equal(diskReport.baselinePlanVersion, 1);
  assert.equal(diskReport.currentPlanVersion, 4);
  assert.deepEqual(await snapshotFiles(files.versions), versionFiles, "review leaves every persisted flag and requirement byte unchanged");
  assert.deepEqual(await Promise.all([files.metadata, files.clarifications].map((path) => readFile(path, "utf8"))), contextFiles);
  const savedExpanded = await storage.appendWorkflowReview(files, diskReport);
  assert.deepEqual((await storage.listSavedReviews(files)).map(({ report }) => report.version), [3, 4, 4]);
  assert.deepEqual(await storage.readWorkflowReview(files), diskReport);

  // Persisted flag toggles reuse the expanded cache without changing saved provenance.
  await storage.preparePlanDraft(files);
  await writePlanFixture(files.workingPlan, publishedExpanded);
  await storage.finalizePlanDraft(files, "Reset assessments only", 4, { phase: "implementation" });
  const diskToggled = await diskInputFor();
  assert.equal(roundPath(diskToggled), roundPath(diskInput));
  assert.equal(reviewIsCurrent(diskReport, inputsFor(diskToggled)), true);
  const diskToggledReport = await generateWorkflowReview(diskToggled, async () => assert.fail("persisted flag toggles must reuse the expanded round"));
  assert.equal(diskToggledReport.currentPlanVersion, 5);
  assert.deepEqual(diskToggledReport.plannedChanges, diskReport.plannedChanges);
  assert.equal((await storage.readWorkflowReview(files)).currentPlanVersion, 4);

  // A later content HEAD can seed from persisted v4 scope; retries retain valid analyses.
  const diskIncremental = await diskInputFor({ headCommit: "disk-next", previousReview: diskReport, previousReviewPath: savedExpanded.path });
  assert.equal(reviewCanSeedIncremental(diskReport, inputsFor(diskIncremental)), true);
  const diskIncrementalRunner = runnerFor(diskIncremental, async (request) => {
    if (request.role === "incremental-scope") return { summary: "The guided view changed.", relevantPlannedChanges: [{ id: "render-followup", explanation: "Recheck the amendment." }] };
    if (request.role === "synthesizer") throw new Error("Persisted synthesis retry");
  });
  await assert.rejects(generateWorkflowReview(diskIncremental, diskIncrementalRunner.run), /Persisted synthesis retry/);
  assert.deepEqual(roles(diskIncrementalRunner), ["incremental-scope", "planned-change", "holistic-review", "testing-criteria", "synthesizer"].sort());
  const diskRetry = runnerFor(diskIncremental);
  const diskIncrementalReport = await generateWorkflowReview(diskIncremental, diskRetry.run);
  assert.deepEqual(roles(diskRetry), ["synthesizer"]);
  assert.deepEqual(diskIncrementalReport.plannedChanges[0].review, diskReport.plannedChanges[0].review);
  assert.deepEqual(await generateWorkflowReview(diskIncremental, async () => assert.fail("persisted incremental retry is fully cached")), diskIncrementalReport);
  assert.deepEqual(await snapshotFiles(join(files.versions, "v1")), baselineFiles);
  for (const [path, bytes] of Object.entries({ ...legacyFiles, ...versionFiles })) assert.equal(await readFile(path, "utf8"), bytes, `immutable history changed: ${path}`);
  assert.deepEqual(await json(savedExpanded.path), diskReport);
  await storage.writeCompletedWorkflowMetadata({ ...metadata, approvedPlanVersion: 99 });
  await assert.rejects(readReviewSourceFingerprint(files, originalAsk), /approved plan version v99 is missing/i);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("Review test passed: v4 scope snapshots, original/followup testing coverage, flag-independent caches, and immutable v3 history.");
