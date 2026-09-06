import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";

// Use the actual dashboard renderer, HTTP server, and bundled browser assets.
// Keep demo artifacts separate from real workflow storage and configuration.
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
const root = await mkdtemp(join(tmpdir(), "pi-dependency-preview-"));
const id = "plan-dependency-example";
const directory = join(root, id);
const plan = await readFile(new URL("./fixtures/dependency-plan.md", import.meta.url), "utf8");
const earlierPlan = plan.replace("PC-02, PC-04, PC-05, PC-06", "PC-02, PC-04, PC-05");
const versions = [earlierPlan, plan].map((content, index) => ({
  number: index + 1,
  createdAt: `2026-06-01T12:0${index}:00.000Z`,
  content,
}));

async function cleanup() {
  await closeOwnedDashboardServer();
  await rm(root, { recursive: true, force: true });
}

try {
  await mkdir(join(directory, "versions"), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "plan.md"), plan),
    ...versions.map((version) => writeFile(join(directory, "versions", `${String(version.number).padStart(4, "0")}.md`), version.content)),
    writeFile(join(directory, "dashboard.html"), renderWorkflowDashboard({
      slug: id,
      description: "Show how planned changes fit together",
      ask: "Require a dependency graph within each implementation plan. Make the order of work and independent branches clear, while keeping the graph in the versioned plan Markdown.",
      generatedAt: new Date().toISOString(),
      versions,
      clarifications: [],
    })),
  ]);
  const result = await ensureSharedDashboardServer(config, root);
  if (result.status === "error") throw new Error(result.message);
  console.log(`Dependency graph preview: ${config.publicBaseUrl}/implementation-workflow/workflows/${id}#plan/graph`);
  console.log(`Example plan and rendered dashboard: ${directory}`);
  console.log("In Guided view, navigate Goal → Dependency graph → planned changes. Compare versions shows dependency changes. Press Ctrl+C to stop.");
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
