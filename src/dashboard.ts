import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { loadPlan, type Plan } from "./plan.ts";
import { loadReview, type Review } from "./review.ts";
import { readClarifications, readWorkflow, type Clarification, type WorkflowLocation } from "./workflow.ts";

const TEMPLATE = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

export interface DashboardData {
	id: string;
	ask: string;
	clarifications: Clarification[];
	/** Absent while the plan is still invalid; `planErrors` explains why. */
	plan?: Plan;
	planErrors: string[];
	review?: Review;
	reviewErrors: string[];
	generatedAt: string;
}

export async function collectDashboardData(location: WorkflowLocation): Promise<DashboardData> {
	const [workflow, clarifications, planResult] = await Promise.all([
		readWorkflow(location),
		readClarifications(location),
		loadPlan(location.plan),
	]);
	const data: DashboardData = {
		id: workflow.id,
		ask: workflow.ask,
		clarifications,
		planErrors: planResult.ok ? [] : planResult.errors,
		reviewErrors: [],
		generatedAt: new Date().toISOString(),
	};
	if (planResult.ok) {
		data.plan = planResult.value;
		const reviewResult = await loadReview(location.review, planResult.value);
		if (reviewResult.ok) data.review = reviewResult.value;
		else data.reviewErrors = reviewResult.errors;
	}
	return data;
}

export function renderDashboard(data: DashboardData): string {
	const { generatedAt: _generatedAt, ...visible } = data;
	const revision = createHash("sha256").update(TEMPLATE).update("\0").update(JSON.stringify(visible)).digest("hex").slice(0, 16);
	const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
	return TEMPLATE
		.replaceAll("__REVISION__", revision)
		.replace("__TITLE__", escapeHtml(data.plan?.title || data.id))
		.replace("__DATA__", json);
}

/** Renders the dashboard file. Never throws for an invalid plan or review; those are shown on the page. */
export async function writeDashboard(location: WorkflowLocation): Promise<DashboardData> {
	const data = await collectDashboardData(location);
	await writeFile(location.dashboard, renderDashboard(data));
	return data;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
