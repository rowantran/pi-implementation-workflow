import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { dependencyPlan } from './fixtures/dependency-plan.mjs';
import { writePlanDocument } from './fixtures/plan-document.mjs';

// Use the actual dashboard renderer, HTTP server, and bundled browser assets.
// Keep demo artifacts separate from real workflow storage and configuration.
const root = await mkdtemp(join(tmpdir(), "pi-dependency-preview-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderWorkflowDashboard } = await jiti.import(new URL("../src/dashboard.ts", import.meta.url).pathname);
const { ensureSharedDashboardServer, closeOwnedDashboardServer, dashboardServerConfig } = await jiti.import(
  new URL("../src/dashboard-server.ts", import.meta.url).pathname,
);
const port = Number(process.env.PORT ?? 43123);
const config = dashboardServerConfig({
  configPath: "dependency graph preview (no configuration file)",
  dashboard: { mode: "local", listen_port: port },
});
const storage = await jiti.import(new URL("../src/storage.ts", import.meta.url).pathname);
const id = "plan-dependency-example";
const worktreePath = join(root, "worktree");
const files = storage.workflowFiles(id, worktreePath);
const directory = files.root;
const plan = dependencyPlan;
const earlierPlan = {
  ...plan,
  readingOrder: ['document-format', ...plan.readingOrder.filter((slug) => slug !== 'document-format')],
  changes: plan.changes.map((change) => change.id === 'verify-workflow' ? { ...change, dependsOn: change.dependsOn.filter((slug) => slug !== 'document-format') } : change),
};

async function cleanup() {
  await closeOwnedDashboardServer();
  await rm(root, { recursive: true, force: true });
}

try {
  await mkdir(worktreePath, { recursive: true });
  const metadata = {
    version: storage.WORKFLOW_METADATA_VERSION, identifier: id,
    description: "Show how planned changes fit together", ask: "Demonstrate a branching dependency plan.",
    repositoryRoot: root, gitCommonDir: join(root, ".git"), worktreePath,
    baseBranch: "main", baseCommit: "preview", workflowBranch: `workflow/${id}`,
    createdAt: new Date().toISOString(),
  };
  await storage.createWorkflow(files, metadata);
  await storage.registerWorkflow(metadata);
  for (const [index, document] of [earlierPlan, plan].entries()) {
    await storage.preparePlanDraft(files);
    await writePlanDocument(files.workingPlan, document);
    await storage.finalizePlanDraft(files, 'Show how planned changes fit together', index);
  }
  const versions = await storage.listPlanVersions(files);
  await writeFile(files.dashboard, renderWorkflowDashboard({
    slug: id,
    description: "Show how planned changes fit together",
    ask: "Show independent branches and their dependencies. Keep slug identities stable when the plan's reading order changes.",
    generatedAt: new Date().toISOString(),
    versions,
    clarifications: [],
  }));
  const result = await ensureSharedDashboardServer(config, storage.workflowsRoot());
  if (result.status === "error") throw new Error(result.message);
  console.log(`Dependency graph preview: ${config.publicBaseUrl}/implementation-workflow/workflows/${id}#plan/graph`);
  console.log(`Example plan and rendered dashboard: ${directory}`);
  console.log("In Guided view, navigate Goal → Dependency graph → planned changes. Compare versions shows reading-order moves and dependency changes. Press Ctrl+C to stop.");
} catch (error) {
  await cleanup();
  throw error;
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try { await cleanup(); }
    finally { process.exit(0); }
  });
}
