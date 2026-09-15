import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, isSlug, readOptional, unknownFields, type LoadResult, type Plan } from "./plan.ts";

export const VERDICT_STATUSES = ["yes", "partial", "no", "needs-human-review"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export interface Verdict {
	status: VerdictStatus;
	explanation: string;
}

export interface Verdicts {
	/** Was everything the plan asked for actually done? */
	necessary: Verdict;
	/** Is what was done enough, and is nothing out of scope? */
	sufficient: Verdict;
	/** Were the testing criteria verified? */
	testing: Verdict;
}

export interface ChangeReview extends Verdicts {
	slug: string;
	/** Literate walkthrough from review/changes/<slug>.md. */
	content: string;
}

export interface Review {
	reviewedAt?: string;
	baseCommit?: string;
	headCommit?: string;
	overall: Verdicts;
	/** review/summary.md */
	summary: string;
	changes: ChangeReview[];
}

export interface ReviewPaths {
	root: string;
	manifest: string;
	summary: string;
	changes: string;
}

export function reviewPaths(root: string): ReviewPaths {
	return { root, manifest: join(root, "review.json"), summary: join(root, "summary.md"), changes: join(root, "changes") };
}

export async function writeReviewSkeleton(root: string): Promise<void> {
	const paths = reviewPaths(root);
	await mkdir(paths.changes, { recursive: true });
	await writeFile(paths.manifest, `${JSON.stringify({ overall: {}, changes: {} }, null, 2)}\n`, { flag: "wx" });
}

/**
 * Which plan changes a saved review must cover: every change except followups
 * that are not yet marked implemented (those were added by a review and have
 * no implementation to inspect).
 */
export function reviewableChanges(plan: Plan): string[] {
	return plan.changes.filter((change) => !(change.followup && !change.implemented)).map((change) => change.slug);
}

/** Reads and validates review/ against the plan. Missing directory means no review. */
export async function loadReview(root: string, plan: Plan): Promise<LoadResult<Review | undefined>> {
	const paths = reviewPaths(root);
	const manifestText = await readOptional(paths.manifest);
	if (manifestText === undefined) return { ok: true, value: undefined };
	const errors: string[] = [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		return { ok: false, errors: ["review.json: invalid JSON"] };
	}
	if (!isRecord(manifest)) return { ok: false, errors: ["review.json: expected an object"] };
	errors.push(...unknownFields(manifest, ["reviewedAt", "baseCommit", "headCommit", "overall", "changes"], "review.json"));
	for (const field of ["reviewedAt", "baseCommit", "headCommit"] as const) {
		if (manifest[field] !== undefined && typeof manifest[field] !== "string") errors.push(`review.json: ${field} must be a string`);
	}
	const overall = readVerdicts(manifest.overall, "review.json overall", errors);
	const summary = await readOptional(paths.summary);
	if (!summary?.trim()) errors.push("summary.md: must contain nonempty prose");

	const entries = isRecord(manifest.changes) ? manifest.changes : undefined;
	if (!entries) errors.push("review.json: changes must be an object keyed by slug");
	const known = new Set(plan.changes.map((change) => change.slug));
	const required = reviewableChanges(plan);
	const reviews = new Map<string, ChangeReview>();
	for (const [slug, value] of Object.entries(entries ?? {})) {
		const path = `review.json changes.${slug}`;
		if (!isSlug(slug) || !known.has(slug)) { errors.push(`${path}: not a change in the plan`); continue; }
		const verdicts = readVerdicts(value, path, errors);
		const content = await readOptional(join(paths.changes, `${slug}.md`));
		if (!content?.trim()) errors.push(`changes/${slug}.md: must contain a nonempty walkthrough`);
		if (verdicts) reviews.set(slug, { slug, ...verdicts, content: content ?? "" });
	}
	for (const slug of required) {
		if (entries && !(slug in entries)) errors.push(`review.json: missing verdicts for ${slug}`);
	}
	for (const name of await listMarkdown(paths.changes)) {
		if (!entries || !(name in entries)) errors.push(`changes/${name}.md: has no entry in review.json`);
	}
	if (errors.length) return { ok: false, errors: [...new Set(errors)] };
	return {
		ok: true,
		value: {
			...(typeof manifest.reviewedAt === "string" ? { reviewedAt: manifest.reviewedAt } : {}),
			...(typeof manifest.baseCommit === "string" ? { baseCommit: manifest.baseCommit } : {}),
			...(typeof manifest.headCommit === "string" ? { headCommit: manifest.headCommit } : {}),
			overall: overall!,
			summary: summary!,
			changes: plan.changes.filter((change) => reviews.has(change.slug)).map((change) => reviews.get(change.slug)!),
		},
	};
}

/** Rewrites review.json with the commit range and timestamp, preserving the agent's verdicts. */
export async function stampReview(root: string, stamps: { baseCommit: string; headCommit: string; reviewedAt: string }): Promise<void> {
	const paths = reviewPaths(root);
	const manifest = JSON.parse((await readOptional(paths.manifest)) ?? "{}") as Record<string, unknown>;
	const { overall, changes } = manifest;
	await writeFile(paths.manifest, `${JSON.stringify({ ...stamps, overall, changes }, null, 2)}\n`);
}

function readVerdicts(value: unknown, path: string, errors: string[]): Verdicts | undefined {
	if (!isRecord(value)) { errors.push(`${path}: expected an object with necessary, sufficient, and testing verdicts`); return undefined; }
	errors.push(...unknownFields(value, ["necessary", "sufficient", "testing"], path));
	const result: Partial<Verdicts> = {};
	for (const key of ["necessary", "sufficient", "testing"] as const) {
		const verdict = value[key];
		if (!isRecord(verdict)) { errors.push(`${path}.${key}: expected { status, explanation }`); continue; }
		errors.push(...unknownFields(verdict, ["status", "explanation"], `${path}.${key}`));
		if (!VERDICT_STATUSES.includes(verdict.status as VerdictStatus)) errors.push(`${path}.${key}: status must be one of ${VERDICT_STATUSES.join(", ")}`);
		if (typeof verdict.explanation !== "string" || !verdict.explanation.trim()) errors.push(`${path}.${key}: explanation must be nonempty`);
		result[key] = { status: verdict.status as VerdictStatus, explanation: String(verdict.explanation ?? "") };
	}
	return result.necessary && result.sufficient && result.testing ? (result as Verdicts) : undefined;
}

async function listMarkdown(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
