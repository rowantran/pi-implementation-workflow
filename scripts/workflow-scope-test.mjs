import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { makePlanDocument, writePlanDocument } from "./fixtures/plan-document.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { workflowFiles, createWorkflow } = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const { finalizePlanDraft, preparePlanDraft, readPlanVersion, hasUnsavedPlanDraft } = await jiti.import(new URL("../src/plan-storage.ts", import.meta.url).pathname);
const { readWorkflowScope, workflowScopeFingerprint, requirementFingerprint, selectImplementationWork, canonicalPlanRequirements } = await jiti.import(new URL("../src/workflow-scope.ts", import.meta.url).pathname);
const temporary = await mkdtemp(join(tmpdir(), "pi-workflow-scope-"));
const files = workflowFiles("scope-test", temporary);
const metadata = {
  version: 6, identifier: "scope-test", description: "Scope test", ask: "Use owner-reentrant locking and preserve queue registration ordering.",
  repositoryRoot: temporary, gitCommonDir: join(temporary, ".git"), baseBranch: "main", baseCommit: "base",
  workflowBranch: "workflow/scope-test", worktreePath: temporary, createdAt: new Date().toISOString(),
};
const origin = { reviewNumber: 1, sessionId: "review-session", entryId: "conversation-entry" };
const reviewPolicy = { phase: "review", reviewOrigin: { reviewNumber: 1, sessionId: origin.sessionId, entryIds: [origin.entryId] } };
const implementation = { phase: "implementation" };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
async function save(document, policy) {
  await rm(files.workingPlan, { recursive: true, force: true });
  const draft = await preparePlanDraft(files);
  await writePlanDocument(files.workingPlan, document);
  return finalizePlanDraft(files, "Scope test publication", draft.baseVersion, policy);
}
async function bytes(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) result[entry.name] = entry.isDirectory()
    ? await bytes(join(root, entry.name)) : await readFile(join(root, entry.name), "utf8");
  return result;
}
// Test history evolution separately from the snapshot digest by re-signing a deliberately invalid history fixture.
async function resign(root) {
  const directories = [], contents = [];
  async function visit(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) { directories.push(key); await visit(join(path, entry.name), key + "/"); }
      else if (key !== "version-metadata.json") contents.push([key, await readFile(join(path, entry.name), "utf8")]);
    }
  }
  await visit(root);
  const hash = createHash("sha256").update(JSON.stringify(directories.sort()));
  for (const pair of contents.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify(pair));
  const path = join(root, "version-metadata.json");
  const m = JSON.parse(await readFile(path, "utf8"));
  m.digest = createHash("sha256").update(hash.digest("hex")).update(JSON.stringify([m.schemaVersion, m.number, m.createdAt, m.description])).digest("hex");
  await writeFile(path, json(m));
}
try {
  await createWorkflow(files, metadata);
  await assert.rejects(readWorkflowScope(files, metadata), /requires an approved plan/);
  const legacy = makePlanDocument({ schemaVersion: 1, intro: "Keep requirements and assessment separate.", changes: [
    { id: "locking", title: "Owner-reentrant locking", dependsOn: [], content: "Use owner-reentrant locks." },
    { id: "queue", title: "Queue registration", dependsOn: ["locking"], content: "Register before acquiring the queue lock." },
  ] });
  const baseline = await save(legacy);
  const baselineBytes = await bytes(baseline.path);
  metadata.approvedPlanVersion = baseline.number;
  await writeFile(files.metadata, json(metadata));
  const initial = await readWorkflowScope(files, metadata);
  assert.equal(initial.approvedPlan.path, baseline.path);
  assert.equal(initial.currentPlan.path, baseline.path);
  assert.ok(initial.changes.every((change) => !change.implemented));
  assert.deepEqual(selectImplementationWork(initial).remaining.map((change) => change.id), ["locking", "queue"]);
  assert.equal(initial.fingerprint, requirementFingerprint(metadata.ask, legacy, await readFile(files.clarifications, "utf8")));
  const converted = { ...legacy, schemaVersion: 2, changes: legacy.changes.map((change) => ({ ...change, implemented: false })) };
  assert.equal(requirementFingerprint(metadata.ask, legacy, "clarifications"), requirementFingerprint(metadata.ask, converted, "clarifications"));
  assert.deepEqual(canonicalPlanRequirements(legacy), canonicalPlanRequirements(converted));
  assert.equal(requirementFingerprint(metadata.ask, undefined, "clarifications"), requirementFingerprint(metadata.ask, undefined, "clarifications"));
  const completed = structuredClone(converted); completed.changes.forEach((change) => { change.implemented = true; });
  const marked = await save(completed, implementation);
  const markedScope = await readWorkflowScope(files, metadata);
  assert.equal(markedScope.fingerprint, initial.fingerprint, "format conversion and assessment changes alone do not change requirements");
  assert.equal(markedScope.currentPlan.path, marked.path);
  assert.notEqual(markedScope.currentPlan.path, files.latestPlan);
  assert.equal(markedScope.approvedPlan.path, baseline.path);
  assert.equal(selectImplementationWork(markedScope).remaining.length, 0);
  assert.equal(markedScope.changes.length, 2, "reported-implemented requirements remain review scope");
  assert.deepEqual(await bytes(baseline.path), baselineBytes);

  const addition = {
    id: "lease-retry", title: "Retry lease acquisition", dependsOn: ["locking", "queue"], implemented: false,
    content: "Retry transient lease acquisition failures.", testing: "Simulate a transient acquisition failure and assert one retry.",
    followup: { origin, effect: { type: "addition" } },
  };
  const combined = { ...completed, readingOrder: [...completed.readingOrder, addition.id], changes: [...completed.changes, addition] };
  const draft = await preparePlanDraft(files);
  await writePlanDocument(files.workingPlan, combined);
  assert.equal(await hasUnsavedPlanDraft(files), true);
  assert.equal((await readWorkflowScope(files, metadata)).fingerprint, initial.fingerprint, "unfinished draft suggestions are not active requirements");
  const withAddition = await finalizePlanDraft(files, "Add a finalized followup", draft.baseVersion, reviewPolicy);
  const additionScope = await readWorkflowScope(files, metadata);
  assert.notEqual(additionScope.fingerprint, initial.fingerprint);
  assert.deepEqual(additionScope.followupTesting, [{ followupId: addition.id, criteria: addition.testing }]);
  assert.deepEqual(selectImplementationWork(additionScope).remaining.map((change) => change.id), [addition.id]);
  assert.equal(additionScope.fingerprint, requirementFingerprint(metadata.ask, withAddition.document, additionScope.clarifications));
  assert.equal(additionScope.amendments.length, 0);
  assert.equal(additionScope.changes.length, 3, "plan membership is sufficient; no acceptance states or citations");

  const amendment = {
    id: "registration-order", title: "Acquire before registration", dependsOn: ["locking"], implemented: false,
    content: "Acquire the lock before queue registration.", testing: "Assert registration never runs after failed acquisition.",
    followup: { origin, effect: { type: "amendment", requirements: [
      { source: { type: "change", id: "queue" }, quotedRequirement: "Register before acquiring the queue lock." },
      { source: { type: "plan-section", name: "testing" }, quotedRequirement: legacy.testing },
    ] } },
  };
  const amendmentOnFollowup = {
    id: "retry-backoff", title: "Back off retries", dependsOn: [], implemented: false,
    content: "Wait one second before the retry.", testing: "Assert the retry delay is one second.",
    followup: { origin, effect: { type: "amendment", requirements: [
      { source: { type: "change", id: addition.id }, quotedRequirement: addition.content },
    ] } },
  };
  const amendedDocument = { ...combined, readingOrder: [...combined.readingOrder, amendment.id, amendmentOnFollowup.id], changes: [...combined.changes, amendment, amendmentOnFollowup] };
  await save(amendedDocument, reviewPolicy);
  const amendedScope = await readWorkflowScope(files, metadata);
  assert.deepEqual(amendedScope.amendments.map((change) => change.id), [amendment.id, amendmentOnFollowup.id]);
  assert.equal(amendedScope.changes[1].content, legacy.changes[1].content, "amendments never mechanically replace baseline text");
  assert.equal(amendedScope.followupTesting.length, 3, "testing amendments and each followup's own criteria remain visible");
  assert.equal(amendedScope.changes.length, 5, "amended requirements stay visible");
  assert.equal(amendedScope.fingerprint, requirementFingerprint(metadata.ask, amendedScope.currentPlan.document, amendedScope.clarifications));
  const fingerprint = amendedScope.fingerprint;
  const same = structuredClone(amendedScope);
  same.approvedPlan.document = { ...same.approvedPlan.document, schemaVersion: 2, changes: same.approvedPlan.document.changes.map((change) => ({ ...change, implemented: true })) };
  same.approvedPlan.number = 99; same.currentPlan.number = 100; same.currentPlan.description = "Display only";
  same.changes.forEach((change) => { change.implemented = !change.implemented; if (change.followup) change.followup.origin = { reviewNumber: 99, sessionId: "portable", entryId: "other" }; });
  same.changes.find((change) => change.id === addition.id).dependsOn.reverse();
  same.clarifications.version = 99;
  assert.equal(workflowScopeFingerprint(same), fingerprint, "flags, baseline flags, schema, origin, version metadata, and dependency storage order are not requirements");
  for (const mutate of [
    (s) => { s.originalAsk += " More scope."; },
    (s) => { s.changes[2].content += " More scope."; },
    (s) => { s.changes[2].title += " Changed"; },
    (s) => { s.changes[2].testing += " More coverage."; },
    (s) => { s.changes[2].dependsOn = []; },
    (s) => { [s.changes[2], s.changes[3]] = [s.changes[3], s.changes[2]]; },
    (s) => { s.changes[3].followup.effect.requirements[0].quotedRequirement += " Changed"; },
    (s) => { s.clarifications.entries.push({ question: "Ordering?", answer: "Acquire first" }); },
  ]) { const changed = structuredClone(amendedScope); mutate(changed); assert.notEqual(workflowScopeFingerprint(changed), fingerprint); }
  const allMarked = structuredClone(amendedDocument); allMarked.changes.forEach((change) => { change.implemented = true; });
  await save(allMarked, implementation);
  const allScope = await readWorkflowScope(files, metadata);
  assert.equal(allScope.fingerprint, fingerprint);
  assert.equal(selectImplementationWork(allScope).remaining.length, 0);
  assert.equal(allScope.changes.length, 5);
  assert.deepEqual(await bytes(baseline.path), baselineBytes);

  // An earlier invalid transition must fail even if baseline and latest alone look valid.
  const metadataPath = join(withAddition.path, "planned-changes", addition.id, "change_metadata.json");
  const historicalMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  historicalMetadata.followup.origin.entryId = "rewritten-history";
  await writeFile(metadataPath, json(historicalMetadata));
  await resign(withAddition.path);
  assert.ok(await readPlanVersion(files, withAddition.number), "individual snapshot digest is valid in this deliberately forged fixture");
  await assert.rejects(readWorkflowScope(files, metadata), /published followup origin must remain unchanged/);
  console.log("Workflow scope tests passed: legacy/current paths, finalized membership, amendments, testing groups, assessment-independent fingerprints, and full history validation.");
} finally { await rm(temporary, { recursive: true, force: true }); }
