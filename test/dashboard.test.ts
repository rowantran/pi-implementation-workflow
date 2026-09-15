import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { collectDashboardData, renderDashboard, writeDashboard } from "../src/dashboard.ts";
import { dashboardUrl, ensureDashboardServer, closeDashboardServer, readIndex, registerDashboard, unregisterDashboard } from "../src/dashboard-server.ts";
import { nodeExec } from "../src/git.ts";
import { createWorkflow } from "../src/workflow.ts";
import { initRepository, temporaryDirectory, VALID_PLAN, writeFiles } from "./helpers.ts";

test("renders plan errors, then a valid plan and review, into a self-contained page", async () => {
	const repo = await initRepository();
	const { location } = await createWorkflow(nodeExec, { repositoryRoot: repo, id: "dash", ask: "Make <dashboards> work" });
	const empty = await collectDashboardData(location);
	assert.equal(empty.plan, undefined);
	assert.ok(empty.planErrors.length > 0);
	const emptyHtml = renderDashboard(empty);
	assert.match(emptyHtml, /<title>dash · Implementation workflow<\/title>/);
	assert.ok(!emptyHtml.includes("<dashboards>"), "ask is JSON-escaped inside the script tag");
	assert.ok(emptyHtml.includes("Make \\u003cdashboards> work"));

	await writeFiles(location.plan, VALID_PLAN);
	await writeFiles(location.review, {
		"review.json": JSON.stringify({ overall: verdicts(), changes: { "define-policy": verdicts(), "implement-redrive": verdicts() } }),
		"summary.md": "Looks good.\n",
		"changes/define-policy.md": "Walkthrough.\n",
		"changes/implement-redrive.md": "Walkthrough.\n",
	});
	const data = await writeDashboard(location);
	assert.equal(data.plan?.title, "Queue redrive with retry policy");
	assert.equal(data.review?.changes.length, 2);
	const html = await readFile(location.dashboard, "utf8");
	assert.match(html, /<title>Queue redrive with retry policy · Implementation workflow<\/title>/);
	assert.match(html, /name="workflow-revision" content="[0-9a-f]{16}"/);
	assert.ok(!html.includes("__DATA__"));
	await rm(repo, { recursive: true, force: true });
});

test("index file and server route dashboards by id", async () => {
	const directory = await temporaryDirectory();
	const index = join(directory, "index.json");
	await registerDashboard("alpha", join(directory, "alpha"), index);
	await registerDashboard("beta", join(directory, "beta"), index);
	assert.deepEqual(await readIndex(index), { alpha: join(directory, "alpha"), beta: join(directory, "beta") });
	await unregisterDashboard("alpha", index);
	assert.deepEqual(Object.keys(await readIndex(index)), ["beta"]);
	await writeFiles(join(directory, "beta"), { "dashboard.html": "<html>beta</html>" });

	const port = 43900 + Math.floor(Math.random() * 100);
	const config = { listenHost: "127.0.0.1", listenPort: port, publicBaseUrl: `http://127.0.0.1:${port}` };
	await ensureDashboardServer(config, index);
	await ensureDashboardServer(config, index);
	try {
		const url = dashboardUrl(config, "beta");
		assert.equal(url, `http://127.0.0.1:${port}/w/beta`);
		const page = await fetch(url);
		assert.equal(page.status, 200);
		assert.equal(await page.text(), "<html>beta</html>");
		assert.equal((await fetch(dashboardUrl(config, "alpha"))).status, 404);
		const asset = await fetch(`http://127.0.0.1:${port}/assets/marked.umd.js`);
		assert.equal(asset.status, 200);
		assert.match(asset.headers.get("content-type") ?? "", /javascript/);
		assert.equal((await fetch(`http://127.0.0.1:${port}/assets/evil.js`)).status, 404);
	} finally {
		await closeDashboardServer();
		await rm(directory, { recursive: true, force: true });
	}
});

function verdicts() {
	const verdict = { status: "yes", explanation: "Checked." };
	return { necessary: verdict, sufficient: verdict, testing: verdict };
}
