import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import Mustache from "mustache";
import {
	atomicWrite,
	listPlanVersions,
	readClarifications,
	readPlanVersion,
	readWorkflowMetadata,
	readWorkflowReview,
	type PlanVersion,
	type WorkflowClarification,
	type WorkflowFiles,
} from "./storage.ts";
import { REVIEW_REPORT_VERSION, type WorkflowReviewReport } from "./review-report.ts";
import { getPlanDependencyGraph } from "./planned-changes.ts";
import { readWorkflowScope, requirementFingerprint } from "./workflow-scope.ts";

const DASHBOARD_TEMPLATE = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

export interface WorkflowDashboardData {
	slug?: string;
	description?: string;
	ask?: string;
	generatedAt: string;
	versions: Array<Pick<PlanVersion, "number" | "createdAt" | "content" | "document" | "description">>;
	/** Exact saved snapshot approved for implementation, never the latest draft. */
	approvedPlanVersion?: number;
	clarifications: WorkflowClarification[];
	review?: WorkflowReviewReport;
	reviewStale?: boolean;
}

export async function writeWorkflowDashboard(files: WorkflowFiles, currentHeadCommit?: string): Promise<void> {
	const [metadata, review] = await Promise.all([readWorkflowMetadata(files), readWorkflowReview(files)]);
	// Resolve scope once, even without a report. Exact history reads keep the
	// visible definitions, flags, clarifications, and freshness on that snapshot
	// if another session publishes a new latest-plan during rendering.
	const scope = "approvedPlanVersion" in metadata && metadata.approvedPlanVersion !== undefined
		? await readWorkflowScope(files, metadata) : undefined;
	const [versions, clarifications] = scope ? [
		await Promise.all(Array.from({ length: scope.currentPlan.number }, async (_, index) => {
			const version = await readPlanVersion(files, index + 1);
			if (!version) throw new Error(`Plan version v${index + 1} is missing.`);
			return version;
		})),
		scope.clarifications,
	] as const : await Promise.all([listPlanVersions(files), readClarifications(files)]);
	const fingerprint = scope?.fingerprint ?? requirementFingerprint(metadata.ask, versions.at(-1)?.document, clarifications);
	const data: WorkflowDashboardData = {
		slug: basename(dirname(files.root)) === ".drafts" ? undefined : basename(files.root),
		description: metadata.description?.trim() || undefined,
		ask: metadata.ask ?? undefined,
		generatedAt: new Date().toISOString(),
		versions: versions.map(({ number, createdAt, content, document, description }) => ({ number, createdAt, content, document, description })),
		approvedPlanVersion: "approvedPlanVersion" in metadata ? metadata.approvedPlanVersion : undefined,
		clarifications: clarifications.entries,
		review,
		reviewStale: Boolean(review && (
			review.version !== REVIEW_REPORT_VERSION ||
			(currentHeadCommit && review.headCommit !== currentHeadCommit) ||
			review.sourceFingerprint !== fingerprint
		)),
	};
	await atomicWrite(files.dashboard, renderWorkflowDashboard(data));
}

export async function writeWorkflowDashboardRedirect(from: string, destinationUrl: string): Promise<void> {
	const serializedUrl = JSON.stringify(destinationUrl).replaceAll("<", "\\u003c");
	await atomicWrite(
		from,
		`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${escapeHtml(destinationUrl)}">\n<title>Implementation plan moved</title>\n</head>\n<body>\n<p>This implementation plan moved to <a href="${escapeHtml(destinationUrl)}">its completed workflow dashboard</a>.</p>\n<script>location.replace(${serializedUrl});</script>\n</body>\n</html>\n`,
	);
}

export function renderWorkflowDashboard(data: WorkflowDashboardData): string {
	// Structural fields come only from the saved document, never its generated Markdown.
	// Normalize here too for callers that render without writing to disk.
	const normalizedData = {
		...data,
		versions: data.versions.map((version) => ({
			...version,
			document: version.document ? {
				...version.document,
				changes: version.document.changes.map((change) => ({ ...change, implemented: change.implemented ?? false })),
			} : version.document,
			dependencyGraph: getPlanDependencyGraph(version.document),
		})),
	};
	const dashboardData = JSON.stringify(normalizedData);
	const { generatedAt: _generatedAt, ...visibleData } = normalizedData;
	const dashboardRevision = createHash("sha256")
		.update(DASHBOARD_TEMPLATE)
		.update("\0")
		.update(JSON.stringify(visibleData))
		.digest("hex");
	return Mustache.render(DASHBOARD_TEMPLATE, {
		dashboardData,
		dashboardRevision,
		slug: data.slug,
	});
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
