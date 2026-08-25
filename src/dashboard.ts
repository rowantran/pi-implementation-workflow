import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import Mustache from "mustache";
import {
	atomicWrite,
	listPlanVersions,
	readClarifications,
	readWorkflowMetadata,
	readWorkflowReview,
	type PlanVersion,
	type WorkflowClarification,
	type WorkflowFiles,
} from "./storage.ts";
import type { WorkflowReviewReport } from "./review-report.ts";

const DASHBOARD_TEMPLATE = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

export interface WorkflowDashboardData {
	slug?: string;
	description?: string;
	ask?: string;
	generatedAt: string;
	versions: Array<Pick<PlanVersion, "number" | "createdAt" | "content">>;
	clarifications: WorkflowClarification[];
	review?: WorkflowReviewReport;
	reviewStale?: boolean;
}

export async function writeWorkflowDashboard(files: WorkflowFiles, currentHeadCommit?: string): Promise<void> {
	const [versions, clarifications, metadata, review] = await Promise.all([
		listPlanVersions(files),
		readClarifications(files),
		readWorkflowMetadata(files),
		readWorkflowReview(files),
	]);
	const data: WorkflowDashboardData = {
		slug: basename(dirname(files.root)) === ".drafts" ? undefined : basename(files.root),
		description: metadata.description?.trim() || undefined,
		ask: metadata.ask ?? undefined,
		generatedAt: new Date().toISOString(),
		versions: versions.map(({ number, createdAt, content }) => ({ number, createdAt, content })),
		clarifications: clarifications.entries,
		review,
		reviewStale: Boolean(review && currentHeadCommit && review.headCommit !== currentHeadCommit),
	};
	await atomicWrite(files.dashboard, renderWorkflowDashboard(data));
}

export async function writeWorkflowDashboardRedirect(from: string, destination: string): Promise<void> {
	const url = pathToFileURL(destination).href;
	const serializedUrl = JSON.stringify(url).replaceAll("<", "\\u003c");
	await atomicWrite(
		from,
		`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">\n<title>Implementation plan moved</title>\n</head>\n<body>\n<p>This implementation plan moved to <a href="${escapeHtml(url)}">its completed workflow dashboard</a>.</p>\n<script>location.replace(${serializedUrl});</script>\n</body>\n</html>\n`,
	);
}

export function renderWorkflowDashboard(data: WorkflowDashboardData): string {
	return Mustache.render(DASHBOARD_TEMPLATE, {
		dashboardData: JSON.stringify(data),
		slug: data.slug,
	});
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
