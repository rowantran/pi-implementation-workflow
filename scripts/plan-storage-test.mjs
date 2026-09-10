import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
const temporary = await mkdtemp(join(tmpdir(), "pi-directory-plan-"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { workflowFiles, createWorkflow, finalizePlanDraft, preparePlanDraft, readPlanVersion, listPlanVersions, hasUnsavedPlanDraft, planDirectory, readText, atomicWrite, withPlanLock } =
  await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const plan = {
  schemaVersion: 1, readingOrder: ["wire-storage", "define-schema"], goal: "Store plans as directories.",
  intro: "Keep plan metadata separate from Markdown explanations.", testing: "Run storage and validation tests.",
  changes: [
    { id: "define-schema", title: "Define the schema", dependsOn: [], content: "**What**\nAccept a manifest and change metadata.\n\n## Testing\n\nThis is change prose, not global testing.\n\n**Why**\nKeep identity and dependencies separate from prose.\n" },
    { id: "wire-storage", title: "Wire storage", dependsOn: ["define-schema"], content: "**What**\nSnapshot and validate a draft before publishing it.\n\n**Why**\nKeep invalid drafts out of published history.\n\n**Pseudocode**\n```ts\nfinalize(draft);\n```\n" },
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
async function invalid(mutate, pattern, base = 1) {
  await populate();
  await mutate();
  const draft = await tree(files.workingPlan);
  const history = await tree(files.versions);
  const pointer = await readlink(files.latestPlan);
  await assert.rejects(finalizePlanDraft(files, "Attempt invalid plan", base), pattern);
  assert.deepEqual(await tree(files.workingPlan), draft, "invalid finalization never repairs or discards edits");
  assert.deepEqual(await tree(files.versions), history, "invalid finalization never changes published history");
  assert.equal(await readlink(files.latestPlan), pointer);
  assert.equal(await hasUnsavedPlanDraft(files), true);
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
  assert.deepEqual(JSON.parse(await readFile(join(files.workingPlan, "plan.json"), "utf8")), { schemaVersion: 1, readingOrder: [] });
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
  assert.ok(first.content.includes(plan.changes[0].content));
  assert.equal(await readlink(files.latestPlan), "plan-versions/v1");
  assert.deepEqual(await readPlanVersion(files), first);
  assert.equal(await hasUnsavedPlanDraft(files), false);
  assert.notEqual((await stat(join(first.path, "goal.md"))).ino, (await stat(join(files.workingPlan, "goal.md"))).ino, "draft and version never share hard links");
  assert.equal(await preparePlanDraft(files).then(({ baseVersion }) => baseVersion), 1);
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
  // Finalization enforces the same authoring format as planning approval. Every
  // rejection must preserve the editable draft, history, and latest pointer.
  for (const content of [
    "A freeform explanation without sections.",
    "**What**\nDescription without a reason.",
    "**Why**\nReason.\n\n**What**\nChange.",
    "**What**\nChange.\n\n**Why**\nReason.\n\n**Why**\nDuplicate.",
    "**What**\n\n**Why**\nReason.",
    "**What**\nChange.\n\n**Why**\n\n**Pseudocode**\nDesign.",
    "**What**\nChange.\n\n**Why**\nReason.\n\n**Pseudocode**\n",
    "**What**\nChange.\n\n**Why**\nReason.\n\n**Pseudocode**\n```text\n```",
    "**What**\n\n<!-- Write the change later. -->\n\n**Why**\nReason.",
    "**What**\nChange.\n\n**Why**\n\n<!-- Write the reason later. -->",
    "```markdown\n**What**\nChange.\n\n**Why**\nReason.\n```",
  ]) await invalid(() => writeFile(join(changeRoot, "change.md"), content), /wire-storage\/change.md:.*(?:standalone|section is empty)/);
  await invalid(async () => {
    await writeFile(join(changeRoot, "change.md"), "Missing sections.");
    await writeFile(join(files.workingPlan, "goal.md"), " ");
    await writeJson(join(changeRoot, "change_metadata.json"), { title: "Wire", dependsOn: ["missing"] });
  }, (error) => {
    for (const pattern of [/goal.md/, /unknown change missing/, /wire-storage\/change.md: must contain standalone/]) assert.match(error.message, pattern);
    return true;
  });
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
  await invalid(() => writeJson(join(files.workingPlan, "plan.json"), { schemaVersion: 2, readingOrder: plan.readingOrder }), /schemaVersion must be 1/);
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
  // Reproduce a schema-version-1 freeform snapshot from before section enforcement.
  // Do not use finalizePlanDraft: the historical writer allowed this content.
  const historical = workflowFiles("historical-freeform", temporary);
  await createWorkflow(historical, { ...metadata, identifier: "historical-freeform" });
  const legacyContent = "Keep this approved explanation exactly as originally saved.\n";
  const entries = new Map([
    ["plan.json", JSON.stringify({ schemaVersion: 1, readingOrder: ["legacy-change"] }) + "\n"],
    ["goal.md", "Keep existing plans readable.\n"],
    ["testing.md", "Read the original plan without rewriting it.\n"],
    ["planned-changes/legacy-change/change_metadata.json", JSON.stringify({ title: "Legacy change", dependsOn: [] }) + "\n"],
    ["planned-changes/legacy-change/change.md", legacyContent],
  ]);
  const legacyPath = planDirectory(historical, 1);
  await mkdir(join(legacyPath, "planned-changes", "legacy-change"), { recursive: true });
  const digest = createHash("sha256").update(JSON.stringify(["planned-changes", "planned-changes/legacy-change"]));
  for (const [name, content] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    await writeFile(join(legacyPath, name), content);
    digest.update(JSON.stringify([name, content]));
  }
  const facts = { schemaVersion: 1, number: 1, createdAt: "2026-09-09T00:00:00.000Z", description: "Original freeform plan" };
  await writeJson(join(legacyPath, "version-metadata.json"), {
    ...facts,
    digest: createHash("sha256").update(digest.digest("hex")).update(JSON.stringify([facts.schemaVersion, facts.number, facts.createdAt, facts.description])).digest("hex"),
  });
  await symlink("plan-versions/v1", historical.latestPlan, "dir");
  const legacyTree = await tree(legacyPath);
  assert.equal((await readPlanVersion(historical)).document.changes[0].content, legacyContent);
  assert.equal((await listPlanVersions(historical)).length, 1);
  await rm(historical.workingPlan, { recursive: true });
  assert.equal((await preparePlanDraft(historical)).baseVersion, 1);
  await assert.rejects(finalizePlanDraft(historical, "Still missing sections", 1), /legacy-change\/change.md: must contain standalone/);
  const repairedContent = "**What**\nKeep this explanation.\n\n**Why**\nPreserve the original design.\n";
  await writeFile(join(historical.workingPlan, "planned-changes", "legacy-change", "change.md"), repairedContent);
  assert.equal((await finalizePlanDraft(historical, "Restore the explanation format", 1)).number, 2);
  await writeJson(historical.metadata, { ...metadata, identifier: "historical-freeform", approvedPlanVersion: 1 });
  assert.equal((await readPlanVersion(historical, 1)).document.changes[0].content, legacyContent, "approved historical scope remains readable");
  assert.deepEqual(await tree(legacyPath), legacyTree, "upgrading the draft never rewrites historical snapshots");
  assert.equal((await listPlanVersions(historical)).length, 2);
  console.log("Directory plan storage tests passed: section enforcement, historical compatibility, aggregated validation, stale bases, cross-process locking, immutable history, pointer safety, and reorder.");
} finally { await rm(temporary, { recursive: true, force: true }); }
