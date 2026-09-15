import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Stable, path-safe change identifiers. Display numbers come from readingOrder. */
export const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 80;

export interface PlanChange {
	slug: string;
	title: string;
	dependsOn: string[];
	/** The implementer's assessment, not a review verdict. */
	implemented: boolean;
	/** Added during review rather than in the original plan. */
	followup: boolean;
	/** Full Markdown of changes/<slug>.md, including its Testing section. */
	content: string;
	/** Body of the required `## Testing` section. */
	testing: string;
}

export interface Plan {
	title: string;
	readingOrder: string[];
	goal: string;
	intro?: string;
	testing: string;
	/** In reading order. */
	changes: PlanChange[];
}

export interface PlanPaths {
	root: string;
	manifest: string;
	goal: string;
	intro: string;
	testing: string;
	changes: string;
}

export type LoadResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function planPaths(root: string): PlanPaths {
	return {
		root,
		manifest: join(root, "plan.json"),
		goal: join(root, "goal.md"),
		intro: join(root, "intro.md"),
		testing: join(root, "testing.md"),
		changes: join(root, "changes"),
	};
}

export function changePath(root: string, slug: string): string {
	return join(root, "changes", `${slug}.md`);
}

export function isSlug(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

export async function writePlanSkeleton(root: string): Promise<void> {
	const paths = planPaths(root);
	await mkdir(paths.changes, { recursive: true });
	await writeFile(paths.manifest, `${JSON.stringify({ title: "", readingOrder: [], changes: {} }, null, 2)}\n`, { flag: "wx" });
	await writeFile(paths.goal, "", { flag: "wx" });
	await writeFile(paths.testing, "", { flag: "wx" });
}

/** Reads and validates the plan directory. Every independent problem is reported at once. */
export async function loadPlan(root: string): Promise<LoadResult<Plan>> {
	const paths = planPaths(root);
	const errors: string[] = [];
	const manifestText = await readOptional(paths.manifest);
	if (manifestText === undefined) return { ok: false, errors: ["plan.json: missing"] };
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestText);
	} catch {
		return { ok: false, errors: ["plan.json: invalid JSON"] };
	}
	if (!isRecord(manifest)) return { ok: false, errors: ["plan.json: expected an object"] };
	errors.push(...unknownFields(manifest, ["title", "readingOrder", "changes"], "plan.json"));

	const title = typeof manifest.title === "string" ? manifest.title.trim() : "";
	if (!title) errors.push("plan.json: title must be a nonempty string");
	if (title.length > 160) errors.push("plan.json: title must be at most 160 characters");

	const readingOrder: string[] = [];
	if (!Array.isArray(manifest.readingOrder)) errors.push("plan.json: readingOrder must be an array of slugs");
	else {
		for (const slug of manifest.readingOrder) {
			if (!isSlug(slug)) errors.push(`plan.json: readingOrder entry ${JSON.stringify(slug)} is not a valid slug (lowercase kebab-case, starts with a letter, at most ${MAX_SLUG_LENGTH} characters)`);
			else if (readingOrder.includes(slug)) errors.push(`plan.json: readingOrder repeats ${slug}`);
			else readingOrder.push(slug);
		}
	}

	const goal = await readOptional(paths.goal);
	if (!goal?.trim()) errors.push("goal.md: must contain nonempty prose");
	const intro = await readOptional(paths.intro);
	if (intro !== undefined && !intro.trim()) errors.push("intro.md: must contain nonempty prose or be removed");
	const testing = await readOptional(paths.testing);
	if (!testing?.trim()) errors.push("testing.md: must contain nonempty prose");

	const definitions = isRecord(manifest.changes) ? manifest.changes : undefined;
	if (!definitions) errors.push("plan.json: changes must be an object keyed by slug");
	const changes = new Map<string, PlanChange>();
	for (const [slug, definition] of Object.entries(definitions ?? {})) {
		const path = `plan.json changes.${slug}`;
		if (!isSlug(slug)) { errors.push(`${path}: invalid slug`); continue; }
		if (!isRecord(definition)) { errors.push(`${path}: expected an object`); continue; }
		errors.push(...unknownFields(definition, ["title", "dependsOn", "implemented", "followup"], path));
		const changeTitle = typeof definition.title === "string" ? definition.title.trim() : "";
		if (!changeTitle || /[\r\n]/.test(changeTitle)) errors.push(`${path}: title must be a nonempty single line`);
		if (typeof definition.implemented !== "boolean") errors.push(`${path}: implemented must be a boolean`);
		if (definition.followup !== undefined && typeof definition.followup !== "boolean") errors.push(`${path}: followup must be a boolean when present`);
		const dependsOn: string[] = [];
		if (!Array.isArray(definition.dependsOn)) errors.push(`${path}: dependsOn must be an array of slugs`);
		else {
			for (const dependency of definition.dependsOn) {
				if (!isSlug(dependency)) errors.push(`${path}: dependency ${JSON.stringify(dependency)} is not a valid slug`);
				else if (dependency === slug) errors.push(`${path}: cannot depend on itself`);
				else if (dependsOn.includes(dependency)) errors.push(`${path}: repeats dependency ${dependency}`);
				else dependsOn.push(dependency);
			}
		}
		const content = await readOptional(changePath(root, slug));
		if (!content?.trim()) errors.push(`changes/${slug}.md: must contain nonempty prose`);
		const changeTesting = content === undefined ? undefined : testingSection(content);
		if (content !== undefined && !changeTesting) errors.push(`changes/${slug}.md: must end with a nonempty "## Testing" section`);
		changes.set(slug, {
			slug,
			title: changeTitle,
			dependsOn,
			implemented: definition.implemented === true,
			followup: definition.followup === true,
			content: content ?? "",
			testing: changeTesting ?? "",
		});
	}
	if (definitions && changes.size === 0) errors.push("plan.json: add at least one change");

	for (const slug of readingOrder) if (!changes.has(slug)) errors.push(`plan.json: readingOrder references unknown change ${slug}`);
	for (const slug of changes.keys()) if (!readingOrder.includes(slug)) errors.push(`plan.json: readingOrder is missing ${slug}`);
	for (const change of changes.values()) {
		for (const dependency of change.dependsOn) {
			if (!changes.has(dependency)) errors.push(`plan.json changes.${change.slug}: depends on unknown change ${dependency}`);
		}
	}
	errors.push(...dependencyCycles(changes));
	for (const name of await listMarkdown(paths.changes)) {
		if (!changes.has(name)) errors.push(`changes/${name}.md: has no entry in plan.json`);
	}

	if (errors.length) return { ok: false, errors: [...new Set(errors)] };
	return {
		ok: true,
		value: {
			title,
			readingOrder,
			goal: goal!,
			...(intro === undefined ? {} : { intro }),
			testing: testing!,
			changes: readingOrder.map((slug) => changes.get(slug)!),
		},
	};
}

/** Body of the `## Testing` section: from that heading to the next `##` heading or end of file. */
export function testingSection(markdown: string): string | undefined {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+testing\s*$/i.test(line));
	if (start < 0) return undefined;
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line)) break;
		body.push(line);
	}
	const text = body.join("\n").trim();
	return text || undefined;
}

function dependencyCycles(changes: Map<string, PlanChange>): string[] {
	const errors: string[] = [];
	const state = new Map<string, "active" | "done">();
	const visit = (slug: string, path: string[]): void => {
		const current = state.get(slug);
		if (current === "done") return;
		if (current === "active") {
			errors.push(`plan.json: dependency cycle ${[...path.slice(path.indexOf(slug)), slug].join(" -> ")}`);
			return;
		}
		state.set(slug, "active");
		for (const dependency of changes.get(slug)?.dependsOn ?? []) {
			if (changes.has(dependency)) visit(dependency, [...path, slug]);
		}
		state.set(slug, "done");
	};
	for (const slug of changes.keys()) visit(slug, []);
	return errors;
}

async function listMarkdown(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unknownFields(value: Record<string, unknown>, allowed: string[], path: string): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${path}: unknown field ${JSON.stringify(key)}`);
}
