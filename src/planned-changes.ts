export const PLAN_SCHEMA_VERSION = 1;
/** Stable, path-safe names, independent of display order. Numeric prefixes are not IDs. */
export const PLANNED_CHANGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface PlannedChange {
	id: string;
	title: string;
	dependsOn: string[];
	/** Freeform Markdown. No prescribed What/Why/Pseudocode fields. */
	content: string;
}

export interface PlanDocument {
	schemaVersion: 1;
	readingOrder: string[];
	goal: string;
	intro?: string;
	testing: string;
	changes: PlannedChange[];
}

export interface PlanDependencyNode {
	id: string;
	title: string;
	dependsOn: string[];
}

export type PlanDependencyGraph =
	| { status: "valid"; nodes: PlanDependencyNode[] }
	| { status: "unavailable"; reason: string };

export class PlanValidationError extends Error {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(`The plan is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
		this.name = "PlanValidationError";
		this.errors = errors;
	}
}

export function isPlanObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unknownFieldErrors(value: Record<string, unknown>, allowed: string[], path: string): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${path}: unknown field ${JSON.stringify(key)}`);
}

export function isPlannedChangeId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 80 && PLANNED_CHANGE_ID_PATTERN.test(value);
}

/** Collect independent errors rather than requiring one edit/finalize cycle per error. */
export function planValidationErrors(value: unknown): string[] {
	if (!isPlanObject(value)) return ["plan: expected an object"];
	const errors = unknownFieldErrors(value, ["schemaVersion", "readingOrder", "goal", "intro", "testing", "changes"], "plan");
	if (value.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push("plan.json: schemaVersion must be 1");
	for (const field of ["goal", "testing", ...(Object.hasOwn(value, "intro") ? ["intro"] : [])]) {
		if (typeof value[field] !== "string" || !value[field].trim()) errors.push(`${field}.md: must contain nonempty prose`);
	}
	const readingOrder = Array.isArray(value.readingOrder) ? value.readingOrder : [];
	if (!Array.isArray(value.readingOrder)) errors.push("plan.json: readingOrder must be an array of change IDs");
	const orderIds = new Set<string>();
	for (const id of readingOrder) {
		if (!isPlannedChangeId(id)) errors.push(`plan.json: invalid readingOrder ID ${JSON.stringify(id)}; use lowercase kebab-case slugs starting with a letter (at most 80 characters)`);
		else if (orderIds.has(id)) errors.push(`plan.json: readingOrder repeats ${id}`);
		else orderIds.add(id);
	}
	const changes = Array.isArray(value.changes) ? value.changes : [];
	if (!Array.isArray(value.changes) || changes.length === 0) errors.push("planned-changes/: add at least one planned change");
	const byId = new Map<string, PlanDependencyNode>();
	for (const [index, change] of changes.entries()) {
		if (!isPlanObject(change)) { errors.push(`changes[${index}]: expected an object`); continue; }
		const path = `planned-changes/${typeof change.id === "string" ? change.id : `<entry-${index}>`}`;
		errors.push(...unknownFieldErrors(change, ["id", "title", "dependsOn", "content"], path));
		if (!isPlannedChangeId(change.id)) errors.push(`${path}: invalid change ID; use lowercase kebab-case slugs starting with a letter (at most 80 characters)`);
		if (typeof change.title !== "string" || !change.title.trim() || /[\r\n\0]/.test(change.title)) errors.push(`${path}/change_metadata.json: title must be a nonempty single-line string`);
		if (typeof change.content !== "string" || !change.content.trim()) errors.push(`${path}/change.md: must contain nonempty prose`);
		if (!Array.isArray(change.dependsOn)) errors.push(`${path}/change_metadata.json: dependsOn must be an array of change IDs`);
		const dependencies: string[] = [];
		const seen = new Set<string>();
		for (const dependency of Array.isArray(change.dependsOn) ? change.dependsOn : []) {
			if (!isPlannedChangeId(dependency)) errors.push(`${path}/change_metadata.json: invalid dependency ID ${JSON.stringify(dependency)}`);
			else if (seen.has(dependency)) errors.push(`${path}/change_metadata.json: repeats dependency ${dependency}`);
			else { seen.add(dependency); dependencies.push(dependency); }
		}
		if (isPlannedChangeId(change.id)) {
			if (byId.has(change.id)) errors.push(`planned-changes/: duplicate change ID ${change.id}`);
			else byId.set(change.id, { id: change.id, title: typeof change.title === "string" ? change.title : "", dependsOn: dependencies });
		}
	}
	for (const id of byId.keys()) if (!orderIds.has(id)) errors.push(`plan.json: readingOrder is missing ${id}`);
	for (const id of orderIds) if (!byId.has(id)) errors.push(`plan.json: readingOrder references unknown change ${id}`);
	for (const change of byId.values()) {
		for (const dependency of change.dependsOn) {
			if (dependency === change.id) errors.push(`${change.id}: cannot depend on itself`);
			else if (!byId.has(dependency)) errors.push(`${change.id}: depends on unknown change ${dependency}`);
		}
	}
	// Iterative DFS handles long plans without a call-stack limit. Invalid edges
	// are skipped so that a separate validly-shaped cycle is still reported.
	const visited = new Set<string>();
	const active = new Map<string, number>();
	for (const id of byId.keys()) {
		if (visited.has(id)) continue;
		const path = [{ id, next: 0 }];
		active.set(id, 0);
		while (path.length) {
			const current = path[path.length - 1]!;
			const dependency = byId.get(current.id)!.dependsOn[current.next++];
			if (dependency === undefined) { visited.add(current.id); active.delete(current.id); path.pop(); continue; }
			if (dependency === current.id || !byId.has(dependency)) continue;
			const cycleStart = active.get(dependency);
			if (cycleStart !== undefined) {
				errors.push(`dependency cycle: ${[...path.slice(cycleStart).map((node) => node.id), dependency].join(" -> ")}`);
				continue;
			}
			if (visited.has(dependency)) continue;
			active.set(dependency, path.length);
			path.push({ id: dependency, next: 0 });
		}
	}
	return errors;
}

export function validatePlanDocument(value: unknown): PlanDocument {
	const errors = planValidationErrors(value);
	if (errors.length) throw new PlanValidationError(errors);
	const document = value as PlanDocument;
	const byId = new Map(document.changes.map((change) => [change.id, change]));
	return { ...document, readingOrder: [...document.readingOrder], changes: document.readingOrder.map((id) => ({ ...byId.get(id)!, dependsOn: [...byId.get(id)!.dependsOn] })) };
}

/** Structured inputs only: rendered Markdown is a display export, never authority. */
export function parsePlannedChanges(plan: PlanDocument): PlannedChange[] {
	return validatePlanDocument(plan).changes;
}

export function parseTestingCriteria(plan: PlanDocument): string {
	return validatePlanDocument(plan).testing;
}

/** Nodes are in reading order, not dependency/execution order. */
export function getPlanDependencyGraph(plan: PlanDocument): PlanDependencyGraph {
	try {
		return { status: "valid", nodes: parsePlannedChanges(plan).map(({ id, title, dependsOn }) => ({ id, title, dependsOn })) };
	} catch (error) {
		return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}

export function renderPlanMarkdown(plan: PlanDocument): string {
	const document = validatePlanDocument(plan);
	const sections = ["# Implementation plan", "## Goal", document.goal];
	if (document.intro !== undefined) sections.push("## Introduction", document.intro);
	sections.push("## Planned Changes");
	for (const change of document.changes) {
		sections.push(`### ${change.id}: ${change.title}`, `**Depends on:** ${change.dependsOn.length ? change.dependsOn.join(", ") : "None"}`, change.content);
	}
	sections.push("## Testing", document.testing);
	return `${sections.join("\n\n")}\n`;
}
