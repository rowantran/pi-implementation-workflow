export const PLAN_SCHEMA_VERSION = 2;
/** Stable, path-safe names, independent of display order. Numeric prefixes are not IDs. */
export const PLANNED_CHANGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface FollowupOrigin {
	reviewNumber: number;
	sessionId: string;
	entryId: string;
}
export type RequirementSource =
	| { type: "original-ask" }
	| { type: "plan-section"; name: "goal" | "intro" | "testing" }
	| { type: "change"; id: string };
export interface AmendmentRequirement { source: RequirementSource; quotedRequirement: string }
export type ScopeEffect = { type: "addition" } | { type: "amendment"; requirements: AmendmentRequirement[] };
export interface FollowupDefinition { origin: FollowupOrigin; effect: ScopeEffect }

export interface PlannedChange {
	id: string;
	title: string;
	dependsOn: string[];
	/** The implementer's assessment, not a review verdict or proof of completion. */
	implemented: boolean;
	/** Freeform Markdown. No prescribed What/Why/Pseudocode fields. */
	content: string;
	followup?: FollowupDefinition;
	/** Required for followups, absent for originals. Stored in the change's testing.md. */
	testing?: string;
}

export interface PlanDocument {
	schemaVersion: 1 | 2;
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
export function planValidationErrors(value: unknown, context: { originalAsk?: string } = {}): string[] {
	if (!isPlanObject(value)) return ["plan: expected an object"];
	const errors = unknownFieldErrors(value, ["schemaVersion", "readingOrder", "goal", "intro", "testing", "changes"], "plan");
	if (value.schemaVersion !== 1 && value.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push("plan.json: schemaVersion must be 1 or 2");
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
	const definitions = new Map<string, Record<string, unknown>>();
	const amendmentEdges = new Map<string, string[]>();
	for (const [index, change] of changes.entries()) {
		if (!isPlanObject(change)) { errors.push(`changes[${index}]: expected an object`); continue; }
		const path = `planned-changes/${typeof change.id === "string" ? change.id : `<entry-${index}>`}`;
		errors.push(...unknownFieldErrors(change, ["id", "title", "dependsOn", "content", "implemented", "followup", "testing"], path));
		if (value.schemaVersion === 2 && typeof change.implemented !== "boolean") errors.push(`${path}/change_metadata.json: implemented must be boolean`);
		if (value.schemaVersion === 1 && Object.hasOwn(change, "implemented") && change.implemented !== false) errors.push(`${path}: legacy implemented must be absent or false`);
		if (value.schemaVersion === 1 && Object.hasOwn(change, "followup")) errors.push(`${path}: followups require schemaVersion 2`);
		if (Object.hasOwn(change, "followup")) {
			validateFollowup(change.followup, `${path}/change_metadata.json/followup`, errors);
			if (typeof change.testing !== "string" || !change.testing.trim()) errors.push(`${path}/testing.md: followups require nonempty testing criteria`);
		} else if (Object.hasOwn(change, "testing")) errors.push(`${path}/testing.md: only followups have change-level testing`);
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
			else {
				byId.set(change.id, { id: change.id, title: typeof change.title === "string" ? change.title : "", dependsOn: dependencies });
				definitions.set(change.id, change);
			}
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
	for (const [id, change] of definitions) {
		const followup = change.followup;
		if (!isPlanObject(followup) || !isPlanObject(followup.effect) || followup.effect.type !== "amendment" || !Array.isArray(followup.effect.requirements)) continue;
		const edges: string[] = [];
		for (const requirement of followup.effect.requirements) {
			if (!isPlanObject(requirement) || !isPlanObject(requirement.source) || typeof requirement.quotedRequirement !== "string") continue;
			const source = requirement.source;
			let target: unknown;
			if (source.type === "original-ask") target = context.originalAsk;
			else if (source.type === "plan-section" && typeof source.name === "string") {
				target = value[source.name];
				if (target === undefined) errors.push(`${id}: amendment references missing plan section ${source.name}`);
			} else if (source.type === "change" && typeof source.id === "string") {
				if (source.id === id) errors.push(`${id}: amendment cannot target itself`);
				if (!definitions.has(source.id)) errors.push(`${id}: amendment references unknown change ${source.id}`);
				else { target = definitions.get(source.id)!.content; edges.push(source.id); }
			}
			if (typeof target === "string" && !target.includes(requirement.quotedRequirement)) errors.push(`${id}: quotedRequirement does not occur verbatim in its amendment target`);
		}
		amendmentEdges.set(id, edges);
	}
	errors.push(...cycleErrors(byId, "dependency", (id) => byId.get(id)!.dependsOn));
	errors.push(...cycleErrors(byId, "amendment", (id) => amendmentEdges.get(id) ?? []));
	errors.push(...cycleErrors(byId, "dependency/amendment", (id) => [...byId.get(id)!.dependsOn, ...(amendmentEdges.get(id) ?? [])]));
	return [...new Set(errors)];
}

function validateFollowup(value: unknown, path: string, errors: string[]): void {
	if (!isPlanObject(value)) { errors.push(`${path}: expected an object`); return; }
	errors.push(...unknownFieldErrors(value, ["origin", "effect"], path));
	if (!isPlanObject(value.origin)) errors.push(`${path}/origin: expected an object`);
	else {
		errors.push(...unknownFieldErrors(value.origin, ["reviewNumber", "sessionId", "entryId"], `${path}/origin`));
		if (!Number.isSafeInteger(value.origin.reviewNumber) || (value.origin.reviewNumber as number) < 1) errors.push(`${path}/origin: reviewNumber must be a positive integer`);
		for (const field of ["sessionId", "entryId"]) if (typeof value.origin[field] !== "string" || !value.origin[field].trim() || /[\r\n\0]/.test(value.origin[field] as string)) errors.push(`${path}/origin: ${field} must be a nonempty single-line string`);
	}
	const effect = value.effect;
	if (!isPlanObject(effect)) { errors.push(`${path}/effect: expected an object`); return; }
	if (effect.type === "addition") { errors.push(...unknownFieldErrors(effect, ["type"], `${path}/effect`)); return; }
	if (effect.type !== "amendment") { errors.push(`${path}/effect: type must be addition or amendment`); return; }
	errors.push(...unknownFieldErrors(effect, ["type", "requirements"], `${path}/effect`));
	if (!Array.isArray(effect.requirements) || !effect.requirements.length) { errors.push(`${path}/effect: amendment requires at least one requirement`); return; }
	const seen = new Set<string>();
	for (const requirement of effect.requirements) {
		if (!isPlanObject(requirement)) { errors.push(`${path}/effect: requirement must be an object`); continue; }
		errors.push(...unknownFieldErrors(requirement, ["source", "quotedRequirement"], `${path}/effect/requirement`));
		if (typeof requirement.quotedRequirement !== "string" || !requirement.quotedRequirement.trim()) errors.push(`${path}/effect: quotedRequirement must be nonempty prose`);
		const source = requirement.source;
		if (!isPlanObject(source)) { errors.push(`${path}/effect: source must be an object`); continue; }
		if (source.type === "original-ask") errors.push(...unknownFieldErrors(source, ["type"], `${path}/effect/source`));
		else if (source.type === "plan-section") {
			errors.push(...unknownFieldErrors(source, ["type", "name"], `${path}/effect/source`));
			if (!["goal", "intro", "testing"].includes(source.name as string)) errors.push(`${path}/effect: plan section must be goal, intro, or testing`);
		} else if (source.type === "change") {
			errors.push(...unknownFieldErrors(source, ["type", "id"], `${path}/effect/source`));
			if (!isPlannedChangeId(source.id)) errors.push(`${path}/effect: invalid amendment change ID`);
		} else errors.push(`${path}/effect: invalid requirement source type`);
		const key = JSON.stringify([source.type, source.name, source.id, requirement.quotedRequirement]);
		if (seen.has(key)) errors.push(`${path}/effect: duplicate amendment requirement`);
		seen.add(key);
	}
}

/** Iterative DFS avoids a call-stack limit. Invalid edges are reported separately. */
function cycleErrors(byId: Map<string, PlanDependencyNode>, kind: string, edges: (id: string) => string[]): string[] {
	const errors: string[] = [];
	const adjacency = new Map([...byId.keys()].map((id) => [id, edges(id)]));
	const visited = new Set<string>();
	const active = new Map<string, number>();
	for (const id of byId.keys()) {
		if (visited.has(id)) continue;
		const path = [{ id, next: 0 }];
		active.set(id, 0);
		while (path.length) {
			const current = path[path.length - 1]!;
			const dependency = adjacency.get(current.id)![current.next++];
			if (dependency === undefined) { visited.add(current.id); active.delete(current.id); path.pop(); continue; }
			if (dependency === current.id || !byId.has(dependency)) continue;
			const cycleStart = active.get(dependency);
			if (cycleStart !== undefined) {
				errors.push(`${kind} cycle: ${[...path.slice(cycleStart).map((node) => node.id), dependency].join(" -> ")}`);
				continue;
			}
			if (visited.has(dependency)) continue;
			active.set(dependency, path.length);
			path.push({ id: dependency, next: 0 });
		}
	}
	return errors;
}

export function validatePlanDocument(value: unknown, context: { originalAsk?: string } = {}): PlanDocument {
	const errors = planValidationErrors(value, context);
	if (errors.length) throw new PlanValidationError(errors);
	const document = value as PlanDocument;
	const byId = new Map(document.changes.map((change) => [change.id, change]));
	return { ...document, readingOrder: [...document.readingOrder], changes: document.readingOrder.map((id) => {
		const change = byId.get(id)!;
		return { ...structuredClone(change), dependsOn: [...change.dependsOn], implemented: change.implemented ?? false };
	}) };
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
		sections.push(`### ${change.id}: ${change.title}`, `**Depends on:** ${change.dependsOn.length ? change.dependsOn.join(", ") : "None"}`, `**Implemented (assessment):** ${change.implemented}`, change.content);
		if (change.followup) {
			sections.push(`**Followup from review ${change.followup.origin.reviewNumber}** (${change.followup.effect.type})`);
			if (change.followup.effect.type === "amendment") for (const requirement of change.followup.effect.requirements) {
				sections.push(`**Amends:** ${JSON.stringify(requirement.source)}`, `> ${requirement.quotedRequirement.replace(/\n/g, "\n> ")}`);
			}
			sections.push(`#### Followup testing: ${change.id}`, change.testing!);
		}
	}
	sections.push("## Testing", document.testing);
	return `${sections.join("\n\n")}\n`;
}
