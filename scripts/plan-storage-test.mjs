import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile, lstat, link } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { makePlanDocument, writePlanDocument } from "./fixtures/plan-document.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
const temporary = await mkdtemp(join(tmpdir(), "pi-directory-plan-"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { workflowFiles, createWorkflow, finalizePlanDraft, preparePlanDraft, readPlanVersion, listPlanVersions, hasUnsavedPlanDraft, planDirectory, readText, atomicWrite, withPlanLock } =
  await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const plan = {
  schemaVersion: 1, readingOrder: ["wire-storage", "define-schema"], goal: "Store plans as directories.",
  intro: "Allow freeform prose without parsing Markdown headings.", testing: "Run storage and validation tests.",
  changes: [
    { id: "define-schema", title: "Define the schema", dependsOn: [], content: "Accept a manifest and change metadata.\n\n## Testing\n\nThis is change prose, not global testing.\n" },
    { id: "wire-storage", title: "Wire storage", dependsOn: ["define-schema"], content: "Snapshot and validate a draft before publishing it.\n\n```ts\nfinalize(draft);\n```\n" },
  ],
};
const files = workflowFiles("directory-plan", temporary);
const metadata = {
  version: 6, identifier: "directory-plan", description: "", ask: "Build directory storage", repositoryRoot: temporary,
  gitCommonDir: join(temporary, ".git"), baseBranch: "main", baseCommit: "abc", workflowBranch: "workflow/directory-plan", worktreePath: temporary, createdAt: new Date().toISOString(),
};
async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
async function populate(document = plan) {
  await rm(files.workingPlan, { recursive: true, force: true });
  await mkdir(join(files.workingPlan, "planned-changes"), { recursive: true });
  await writeJson(join(files.workingPlan, "plan.json"), { schemaVersion: document.schemaVersion, readingOrder: document.readingOrder });
  await writeFile(join(files.workingPlan, "goal.md"), document.goal);
  await writeFile(join(files.workingPlan, "testing.md"), document.testing);
  if (document.intro !== undefined) await writeFile(join(files.workingPlan, "intro.md"), document.intro);
  for (const change of document.changes) {
    const root = join(files.workingPlan, "planned-changes", change.id);
    await mkdir(root);
    await writeJson(join(root, "change_metadata.json"), { title: change.title, dependsOn: change.dependsOn });
    await writeFile(join(root, "change.md"), change.content);
  }
}
async function tree(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    result[entry.name] = entry.isSymbolicLink() ? { link: await readlink(path) }
      : entry.isDirectory() ? await tree(path) : await readFile(path, "utf8");
  }
  return result;
}
async function invalid(mutate, pattern, base = 1, unreadableHistory = false) {
  await populate();
  await mutate();
  const draft = await tree(files.workingPlan);
  const history = await tree(files.versions);
  const pointer = await readlink(files.latestPlan);
  await assert.rejects(finalizePlanDraft(files, "Attempt invalid plan", base), pattern);
  assert.deepEqual(await tree(files.workingPlan), draft, "invalid finalization never repairs or discards edits");
  assert.deepEqual(await tree(files.versions), history, "invalid finalization never changes published history");
  assert.equal(await readlink(files.latestPlan), pointer);
  if (unreadableHistory) await assert.rejects(hasUnsavedPlanDraft(files), /Hard links/);
  else assert.equal(await hasUnsavedPlanDraft(files), true);
}
async function testFollowupStorage() {
  const f = workflowFiles("followup-storage", temporary);
  const m = { ...metadata, identifier: "followup-storage", workflowBranch: "workflow/followup-storage", ask: "Use a queue and preserve registration ordering." };
  await createWorkflow(f, m);
  const original = makePlanDocument({ changes: [{ id: "queue", title: "Queue", dependsOn: [], content: "Use a queue with owner-reentrant locking." }] });
  const review = { phase: "review", reviewOrigin: { reviewNumber: 1, sessionId: "review-session", entryIds: ["finding", "discussion"] } };
  const implementation = { phase: "implementation" };
  async function draft(document) {
    await rm(f.workingPlan, { recursive: true, force: true });
    const prepared = await preparePlanDraft(f);
    await writePlanDocument(f.workingPlan, document);
    return prepared.baseVersion;
  }
  async function reject(document, pattern, policy = review) {
    const base = await draft(document);
    const beforeDraft = await tree(f.workingPlan), beforeHistory = await tree(f.versions);
    const pointer = await readlink(f.latestPlan).catch(() => undefined);
    await assert.rejects(finalizePlanDraft(f, "Invalid attempt", base, policy), pattern);
    assert.deepEqual(await tree(f.workingPlan), beforeDraft);
    assert.deepEqual(await tree(f.versions), beforeHistory);
    assert.equal(await readlink(f.latestPlan).catch(() => undefined), pointer);
  }
  async function save(document, policy) { const base = await draft(document); return finalizePlanDraft(f, "Publish requirements or assessment", base, policy); }
  for (const flag of [undefined, "false", 0, null]) {
    const candidate = structuredClone(original); candidate.changes[0].implemented = flag;
    await reject(candidate, /implemented must be boolean/, { phase: "planning" });
  }
  const prematurelyDone = structuredClone(original); prematurelyDone.changes[0].implemented = true;
  await reject(prematurelyDone, /Initial planning cannot/, { phase: "planning" });
  const baseline = await save(original);
  const baselineTree = await tree(baseline.path);
  await writeJson(f.metadata, { ...m, approvedPlanVersion: baseline.number });
  await reject(original, /approved and cannot be finalized/, { phase: "planning" });
  const implemented = structuredClone(original); implemented.changes[0].implemented = true;
  const marked = await save(implemented, implementation);
  assert.equal(marked.document.changes[0].implemented, true, "marking needs no Git commit or evidence file");
  await reject(original, /review cannot change implemented/);
  const origin = { reviewNumber: 1, sessionId: "review-session", entryId: "finding" };
  const followup = {
    id: "registration-order", title: "Register after acquisition", dependsOn: ["queue"], implemented: false,
    content: "Register only after acquiring the lock.", testing: "Test acquisition failure before registration.",
    followup: { origin, effect: { type: "amendment", requirements: [{ source: { type: "original-ask" }, quotedRequirement: "preserve registration ordering" }] } },
  };
  const combined = { ...implemented, readingOrder: ["queue", followup.id], changes: [...implemented.changes, followup] };
  await reject(combined, /only implemented fields/, implementation);
  const addedDone = structuredClone(combined); addedDone.changes[1].implemented = true;
  await reject(addedDone, /new followups must start/);
  for (const changedOrigin of [{ ...origin, reviewNumber: 2 }, { ...origin, sessionId: "foreign" }, { ...origin, entryId: "unknown" }]) {
    const candidate = structuredClone(combined); candidate.changes[1].followup.origin = changedOrigin;
    await reject(candidate, /new followup origin must reference/);
  }
  const decisions = structuredClone(combined); decisions.changes[1].followup.decision = { type: "accepted" };
  await reject(decisions, /unknown field "decision"/);
  const missingTesting = structuredClone(combined); delete missingTesting.changes[1].testing;
  await reject(missingTesting, /require nonempty testing/);
  for (const source of [{ type: "change", id: "unknown" }, { type: "change", id: followup.id }, { type: "plan-section", name: "intro" }]) {
    const candidate = structuredClone(combined); candidate.changes[1].followup.effect.requirements[0].source = source;
    await reject(candidate, /unknown change|cannot target itself|missing plan section/);
  }
  const badQuote = structuredClone(combined); badQuote.changes[1].followup.effect.requirements[0].quotedRequirement = "not in the ask";
  await reject(badQuote, /does not occur verbatim/);
  const badDependency = structuredClone(combined); badDependency.changes[1].dependsOn = ["missing"];
  await reject(badDependency, /depends on unknown change/);
  const originalEdits = [
    (p) => { p.goal += "changed"; }, (p) => { p.testing += "changed"; }, (p) => { p.intro = "Added intro"; },
    (p) => { p.changes[0].content += "changed"; }, (p) => { p.changes[0].content = "\ufeff" + p.changes[0].content; }, (p) => { p.changes[0].title += "changed"; },
    (p) => { p.changes[0].dependsOn = [followup.id]; p.changes[1].dependsOn = []; },
    (p) => { p.readingOrder.reverse(); },
    (p) => { p.changes[0].followup = { origin, effect: { type: "addition" } }; p.changes[0].testing = "Testing"; },
    (p) => { p.changes.push({ id: "unlabelled", title: "Unlabelled", content: "New requirement", dependsOn: [], implemented: false }); p.readingOrder.push("unlabelled"); },
  ];
  for (const mutate of originalEdits) { const candidate = structuredClone(combined); mutate(candidate); await reject(candidate, /Original|original requirements|new requirements must be followups/); }
  const published = await save(combined, review);
  const combinedTree = await tree(published.path);
  assert.equal(published.document.changes[1].testing, followup.testing);
  assert.equal(JSON.parse(await readFile(f.metadata, "utf8")).approvedPlanVersion, baseline.number);
  const deleted = structuredClone(implemented);
  await reject(deleted, /published IDs must be retained/);
  const newOrigin = structuredClone(combined); newOrigin.changes[1].followup.origin.entryId = "discussion";
  await reject(newOrigin, /published followup origin must remain unchanged/);
  const done = structuredClone(combined); done.changes[1].implemented = true;
  await save(done, implementation);
  const changed = structuredClone(done); changed.changes[1].content += " Preserve retries.";
  await reject(changed, /must explicitly reset implemented to false/);
  changed.changes[1].implemented = false;
  await reject(changed, /only implemented fields/, implementation);
  await save(changed, review);
  const noChange = structuredClone(changed); noChange.changes[0].implemented = false;
  await save(noChange, implementation);
  assert.equal((await readPlanVersion(f)).document.changes[0].implemented, false, "implementer can clear a flag explicitly");
  assert.deepEqual(await tree(baseline.path), baselineTree);
  assert.deepEqual(await tree(published.path), combinedTree, "old definitions and old assessments remain immutable");
  // A followup can amend a followup without hiding either requirement.
  const second = { id: "registration-retry", title: "Retry registration", dependsOn: [], implemented: false, content: "Retry after a transient registration failure.", testing: "Test one transient failure.", followup: { origin: { ...origin, entryId: "discussion" }, effect: { type: "amendment", requirements: [{ source: { type: "change", id: followup.id }, quotedRequirement: "Register only after acquiring the lock." }] } } };
  const extended = { ...noChange, readingOrder: [...noChange.readingOrder, second.id], changes: [...noChange.changes, second] };
  const cycle = structuredClone(extended);
  cycle.changes[1].followup.effect.requirements = [{ source: { type: "change", id: second.id }, quotedRequirement: second.content }];
  await reject(cycle, /amendment cycle/);
  const mixedCycle = structuredClone(extended); mixedCycle.changes[1].dependsOn.push(second.id);
  await reject(mixedCycle, /dependency\/amendment cycle/);
  await save(extended, review);
  // Changing a raw draft after capture must fail even though it passed field validation.
  const newAddition = { ...second, id: "another-followup", followup: { origin, effect: { type: "addition" } } };
  const concurrent = { ...extended, readingOrder: [...extended.readingOrder, newAddition.id], changes: [...extended.changes, newAddition] };
  const base = await draft(concurrent);
  const beforeHistory = await tree(f.versions);
  const mutatingContext = { ...review.reviewOrigin, get sessionId() { writeFileSync(join(f.workingPlan, "planned-changes", newAddition.id, "testing.md"), "Concurrent native edit."); return "review-session"; } };
  await assert.rejects(finalizePlanDraft(f, "Concurrent draft", base, { phase: "review", reviewOrigin: mutatingContext }), /working plan changed during finalize/);
  assert.deepEqual(await tree(f.versions), beforeHistory);
  assert.equal(await readFile(join(f.workingPlan, "planned-changes", newAddition.id, "testing.md"), "utf8"), "Concurrent native edit.");
  // Invalid/edited legacy drafts are preserved rather than mechanically upgraded.
  const legacy = { ...plan, goal: "User edits in a legacy draft." };
  await writePlanDocument(f.workingPlan, legacy);
  const legacyTree = await tree(f.workingPlan);
  await preparePlanDraft(f);
  assert.deepEqual(await tree(f.workingPlan), legacyTree);
}

try {
  await createWorkflow(files, metadata);
  assert.equal(files.workingPlan, join(files.root, "working-plan"));
  assert.equal(planDirectory(files), files.latestPlan);
  assert.equal(planDirectory(files, 2), join(files.versions, "v2"));
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => planDirectory(files, value), /Invalid plan version/);
  assert.deepEqual(await listPlanVersions(files), []);
  assert.equal(await readPlanVersion(files), undefined);
  assert.equal(await readPlanVersion(files, 1), undefined);
  await assert.rejects(lstat(files.latestPlan), /ENOENT/);
  assert.equal(files.plan, files.latestPlan);
  await assert.rejects(lstat(join(files.root, "plan.md")), /ENOENT/, "no generated root Markdown is needed");
  assert.deepEqual(JSON.parse(await readFile(join(files.workingPlan, "plan.json"), "utf8")), { schemaVersion: 2, readingOrder: [] });
  assert.deepEqual(await readdir(join(files.workingPlan, "planned-changes")), []);
  assert.deepEqual(await preparePlanDraft(files), { path: files.workingPlan, baseVersion: 0 });
  await assert.rejects(finalizePlanDraft(files, "", 0), (error) => {
    for (const pattern of [/goal.md/, /testing.md/, /at least one/, /description/]) assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(await readdir(files.versions), []);
  await populate();
  const beforePrepare = await tree(files.workingPlan);
  const beforeTime = (await stat(join(files.workingPlan, "goal.md"))).mtimeMs;
  await preparePlanDraft(files);
  assert.deepEqual(await tree(files.workingPlan), beforePrepare);
  assert.equal((await stat(join(files.workingPlan, "goal.md"))).mtimeMs, beforeTime);
  const metadataBeforeFinalize = await readFile(files.metadata, "utf8");
  const first = await finalizePlanDraft(files, " First usable plan ", 0);
  assert.equal(await readFile(files.metadata, "utf8"), metadataBeforeFinalize, "description publication needs no separate mutable metadata write");
  assert.equal(first.number, 1);
  assert.equal(first.description, "First usable plan");
  assert.equal(first.path, join(files.versions, "v1"));
  assert.deepEqual(first.document.changes.map(({ id }) => id), plan.readingOrder);
  assert.equal(first.document.testing, plan.testing, "headings inside change prose are not structure");
  assert.equal(first.document.schemaVersion, 1);
  assert.ok(first.document.changes.every((change) => change.implemented === false), "legacy reads normalize missing flags to false");
  assert.equal(JSON.parse(await readFile(join(first.path, "plan.json"), "utf8")).schemaVersion, 1, "legacy reads never rewrite files");
  assert.ok(first.content.includes(plan.changes[0].content));
  assert.equal(await readlink(files.latestPlan), "plan-versions/v1");
  assert.deepEqual(await readPlanVersion(files), first);
  assert.equal(await hasUnsavedPlanDraft(files), false);
  assert.notEqual((await stat(join(first.path, "goal.md"))).ino, (await stat(join(files.workingPlan, "goal.md"))).ino, "draft and version never share hard links");
  assert.equal(await preparePlanDraft(files).then(({ baseVersion }) => baseVersion), 1);
  assert.equal(JSON.parse(await readFile(join(files.workingPlan, "plan.json"), "utf8")).schemaVersion, 2, "unchanged legacy drafts upgrade during prepare");
  assert.ok(JSON.parse(await readFile(join(files.workingPlan, "planned-changes", "wire-storage", "change_metadata.json"), "utf8")).implemented === false);
  assert.equal(await hasUnsavedPlanDraft(files), false, "mechanical conversion alone is not unsaved scope");
  const immutable = await tree(first.path);
  const metadataFile = JSON.parse(await readFile(join(first.path, "version-metadata.json"), "utf8"));
  assert.equal(metadataFile.description, first.description);
  assert.equal(metadataFile.createdAt, first.createdAt);
  assert.equal(metadataFile.digest.length, 64);
  assert.equal((await readdir(files.workingPlan)).includes("version-metadata.json"), false);
  await writeFile(join(files.root, "plan.md"), "# Untrusted display export\n");
  assert.deepEqual(await readPlanVersion(files), first, "root Markdown is never authority");
  await assert.rejects(readText(files.latestPlan), /symbolic links/, "general read helpers never allow the alias");
  await assert.rejects(atomicWrite(files.latestPlan, "not a pointer"), /symbolic links/);

  const changeRoot = join(files.workingPlan, "planned-changes", "wire-storage");
  await invalid(async () => {
    await writeFile(join(files.workingPlan, "plan.json"), "{broken");
    await writeFile(join(files.workingPlan, "goal.md"), " ");
    await writeFile(join(files.workingPlan, "testing.md"), "");
    await writeJson(join(changeRoot, "change_metadata.json"), { title: "", dependsOn: ["missing", "missing"], unexpected: true });
    await writeFile(join(changeRoot, "change.md"), " ");
    await writeFile(join(files.workingPlan, "extra.md"), "Unknown prose");
  }, (error) => {
    for (const pattern of [/invalid JSON/, /goal.md/, /testing.md/, /title must/, /repeats dependency/, /unknown change/, /unknown field/, /change.md/, /extra.md/]) assert.match(error.message, pattern);
    assert.ok(error.errors.length >= 9);
    return true;
  });
  await invalid(() => writeJson(join(files.workingPlan, "plan.json"), { schemaVersion: 1, readingOrder: ["wire-storage", "wire-storage", "absent"], title: "Unknown" }), /readingOrder repeats wire-storage/);
  await invalid(() => writeJson(join(files.workingPlan, "plan.json"), { schemaVersion: 3, readingOrder: plan.readingOrder }), /schemaVersion must be 1 or 2/);
  await invalid(() => writeJson(join(changeRoot, "change_metadata.json"), { title: "Wire", dependsOn: "define-schema" }), /dependsOn must be an array/);
  await invalid(() => writeJson(join(changeRoot, "change_metadata.json"), { title: "Wire", dependsOn: ["wire-storage"] }), /cannot depend on itself/);
  await invalid(() => writeJson(join(files.workingPlan, "planned-changes", "define-schema", "change_metadata.json"), { title: "Define", dependsOn: ["wire-storage"] }), /dependency cycle/);
  await invalid(() => writeFile(join(files.workingPlan, "intro.md"), "\n"), /intro.md: must contain nonempty prose/);
  await invalid(() => rm(join(changeRoot, "change.md")), /change.md: required file is missing/);
  await invalid(() => mkdir(join(files.workingPlan, "planned-changes", "PC-01")), /unexpected path.*lowercase kebab-case/);
  await invalid(() => writeJson(join(files.workingPlan, "version-metadata.json"), metadataFile), /version-metadata.json: unexpected path/);
  await invalid(async () => {
    await rm(join(files.workingPlan, "goal.md"));
    await mkdir(join(files.workingPlan, "goal.md"));
  }, /expected a regular file/);
  const outside = join(temporary, "outside.md");
  await writeFile(outside, "Keep this file unchanged.");
  await invalid(async () => {
    await rm(join(changeRoot, "change.md"));
    await symlink(outside, join(changeRoot, "change.md"));
  }, /symbolic links/);
  assert.equal(await readFile(outside, "utf8"), "Keep this file unchanged.");
  await invalid(async () => {
    await rm(join(changeRoot, "change.md"));
    await link(outside, join(changeRoot, "change.md"));
  }, /Hard links/);
  await invalid(async () => {
    await rm(join(changeRoot, "change.md"));
    await link(join(first.path, "planned-changes", "wire-storage", "change.md"), join(changeRoot, "change.md"));
  }, /Hard links/, 1, true);
  await invalid(async () => {
    await rm(changeRoot, { recursive: true });
    await symlink(temporary, changeRoot, "dir");
  }, /symbolic links/);
  await populate();
  await assert.rejects(finalizePlanDraft(files, "Stale client", 0), /Stale plan draft/);
  await assert.rejects(finalizePlanDraft(files, "Missing expected base"), /expectedBaseVersion/);
  const lock = join(files.root, ".plan.lock");
  await writeFile(lock, "Owned by another process");
  await assert.rejects(finalizePlanDraft(files, "Busy", 1), /locked by another/);
  assert.equal(await readFile(lock, "utf8"), "Owned by another process");
  await rm(lock);
  await mkdir(join(files.versions, "v2"));
  await writeFile(join(files.versions, "v2", "keep"), "Unpublished snapshot");
  assert.deepEqual((await listPlanVersions(files)).map(({ number }) => number), [1], "unpublished directories do not enter history");
  await assert.rejects(finalizePlanDraft(files, "Never overwrite", 1), /Cannot overwrite immutable/);
  assert.equal(await readFile(join(files.versions, "v2", "keep"), "utf8"), "Unpublished snapshot");
  await rm(join(files.versions, "v2"), { recursive: true });

  await populate({ ...plan, readingOrder: [...plan.readingOrder].reverse() });
  const second = await finalizePlanDraft(files, "Reorder the same stable IDs", 1);
  assert.equal(second.number, 2);
  assert.deepEqual(second.document.changes.map(({ id }) => id), [...plan.readingOrder].reverse());
  assert.deepEqual(await tree(first.path), immutable, "finalized snapshots are never rewritten");
  assert.deepEqual(await readPlanVersion(files, 1), first, "explicit approved versions never follow latest");
  assert.deepEqual((await listPlanVersions(files)).map(({ number }) => number), [1, 2]);
  await writeFile(join(files.workingPlan, "goal.md"), "Unsaved edits based on an old prepare");
  assert.equal(await preparePlanDraft(files).then(({ baseVersion }) => baseVersion), 1, "prepare never silently rebases edits");
  await assert.rejects(finalizePlanDraft(files, "Stale draft", 1), /Stale plan draft/);
  assert.equal(await readFile(join(files.workingPlan, "goal.md"), "utf8"), "Unsaved edits based on an old prepare");
  await rm(files.workingPlan, { recursive: true });
  assert.equal(await hasUnsavedPlanDraft(files), false);
  assert.equal(await preparePlanDraft(files).then(({ baseVersion }) => baseVersion), 2);
  assert.equal(await hasUnsavedPlanDraft(files), false);
  await writeFile(join(files.workingPlan, "goal.md"), "Concurrent writers compete for one version number.");

  // Separate Node processes share only filesystem locks, not in-process state.
  async function worker() {
    const child = fork(new URL("./fixtures/plan-finalize-worker.mjs", import.meta.url), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    return child;
  }
  const children = await Promise.all([worker(), worker()]);
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject);
    child.send({ files, expectedBaseVersion: 2 });
  })));
  assert.equal(results.filter(({ ok }) => ok).length, 1, JSON.stringify(results));
  assert.match(results.find(({ ok }) => !ok).message, /locked by another|Stale plan draft/);
  assert.equal(await readlink(files.latestPlan), "plan-versions/v3");
  assert.deepEqual((await listPlanVersions(files)).map(({ number }) => number), [1, 2, 3]);
  assert.deepEqual(await tree(first.path), immutable);
  assert.equal((await readdir(files.root)).some((name) => name.startsWith(".plan-publish-") || name.endsWith(".tmp") || name === ".plan.lock"), false);

  // Tampering with either a saved file, version description, or special pointer is detected.
  await writeJson(join(first.path, "version-metadata.json"), { ...metadataFile, description: "Edited description" });
  await assert.rejects(readPlanVersion(files, 1), /immutable finalized plan was modified/);
  await writeJson(join(first.path, "version-metadata.json"), metadataFile);
  await writeFile(join(first.path, "goal.md"), "Edited immutable version");
  await assert.rejects(readPlanVersion(files, 1), /immutable finalized plan was modified/);
  await writeFile(join(first.path, "goal.md"), plan.goal);
  for (const target of [temporary, "../outside", "plan-versions/../outside", "plan-versions/v01", "plan-versions/v999"]) {
    await rm(files.latestPlan);
    await symlink(target, files.latestPlan, "dir");
    await assert.rejects(readPlanVersion(files), /Unsafe latest-plan|target is missing/);
    assert.deepEqual(await readPlanVersion(files, 1), first, "explicit approved reads do not inspect the mutable latest alias");
    await assert.rejects(finalizePlanDraft(files, "Unsafe pointer", 2), /Unsafe latest-plan|target is missing/);
  }
  await rm(files.latestPlan);
  await symlink("plan-versions/v3", files.latestPlan, "dir");
  await assert.rejects(readPlanVersion({ ...files, versions: temporary }), /Invalid workflow plan path/);

  // Approval uses the same exported cross-process lock as finalization. A
  // finalize caller that checked metadata earlier cannot publish after approval.
  await preparePlanDraft(files);
  const beforeApproval = await tree(files.versions);
  const beforeApprovedDraft = await tree(files.workingPlan);
  await withPlanLock(files, async () => {
    await writeJson(files.metadata, { ...metadata, approvedPlanVersion: 3 });
    await assert.rejects(finalizePlanDraft(files, "Racing approval", 3), /locked by another/);
  });
  await assert.rejects(finalizePlanDraft(files, "Already approved", 3), /approved and cannot be finalized/);
  assert.deepEqual(await tree(files.versions), beforeApproval);
  assert.deepEqual(await tree(files.workingPlan), beforeApprovedDraft);
  assert.equal(await readlink(files.latestPlan), "plan-versions/v3");
  await rm(files.workingPlan, { recursive: true });
  await symlink(temporary, files.workingPlan, "dir");
  await assert.rejects(preparePlanDraft(files), /symbolic links/);
  await rm(files.workingPlan);
  await rm(files.versions, { recursive: true });
  await symlink(temporary, files.versions, "dir");
  await assert.rejects(listPlanVersions(files), /symbolic links/);
  await testFollowupStorage();
  console.log("Directory plan storage tests passed: schema v2, legacy upgrades, phase policies, followups, amendments, immutable history, concurrency, and link safety.");
} finally { await rm(temporary, { recursive: true, force: true }); }
