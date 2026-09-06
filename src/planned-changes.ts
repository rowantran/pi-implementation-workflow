export interface PlannedChange {
	id: string;
	title: string;
	/** Absent only for legacy plans that did not declare dependencies. */
	dependsOn?: string[];
	what: string;
	why: string;
	pseudocode?: string;
	content: string;
}

export interface PlanDependencyNode {
	id: string;
	title: string;
	dependsOn: string[];
}

export type PlanDependencyGraph =
	| { status: "valid"; nodes: PlanDependencyNode[] }
	| { status: "unavailable"; reason: string };

const PLANNED_CHANGES_HEADING = /^##\s+Planned Changes\s*$/i;
const TESTING_HEADING = /^##\s+Testing\s*$/i;
const SECOND_LEVEL_HEADING = /^##\s+/;
const ENTRY_HEADING = /^###\s+(PC-(\d+)):\s+(.+?)\s*$/;
const FIELD_HEADING = /^\s*\*\*(Depends on|What|Why|Pseudocode)\*\*:?\s*$/i;
const CANONICAL_PC_ID = /^PC-(?:0[1-9]|[1-9]\d+)$/;

export function parsePlannedChanges(
	plan: string,
	{ requireDependencies = false }: { requireDependencies?: boolean } = {},
): PlannedChange[] {
	const lines = plan.replaceAll("\r\n", "\n").split("\n");
	const outsideFence = linesOutsideFences(lines);
	const sectionStart = lines.findIndex((line, index) => outsideFence[index] && PLANNED_CHANGES_HEADING.test(line));
	if (sectionStart < 0) throw new Error('add a second-level "Planned Changes" section');

	let sectionEnd = lines.length;
	for (let index = sectionStart + 1; index < lines.length; index++) {
		if (outsideFence[index] && SECOND_LEVEL_HEADING.test(lines[index] ?? "")) {
			sectionEnd = index;
			break;
		}
	}

	const headings: Array<{ index: number; id: string; number: number; title: string }> = [];
	for (let index = sectionStart + 1; index < sectionEnd; index++) {
		const line = lines[index] ?? "";
		if (!outsideFence[index]) continue;
		const match = ENTRY_HEADING.exec(line);
		if (match) {
			headings.push({ index, id: match[1]!, number: Number(match[2]), title: match[3]!.trim() });
			continue;
		}
		if (/^###\s+/.test(line)) {
			throw new Error(`use the heading format "### PC-01: Title" instead of "${line.trim()}"`);
		}
	}
	if (headings.length === 0) throw new Error("add at least one planned change with a stable PC-01 identifier");

	const preamble = lines.slice(sectionStart + 1, headings[0]!.index).join("\n").trim();
	if (preamble) throw new Error("place all Planned Changes content inside PC-numbered entries");

	const changes = headings.map((heading, position) => {
		const expectedNumber = position + 1;
		const expectedId = `PC-${String(expectedNumber).padStart(2, "0")}`;
		if (heading.number !== expectedNumber || heading.id !== expectedId) {
			throw new Error(`number planned changes consecutively; expected ${expectedId}, found ${heading.id}`);
		}
		if (!heading.title) throw new Error(`${heading.id} needs a title`);

		const end = headings[position + 1]?.index ?? sectionEnd;
		const bodyLines = lines.slice(heading.index + 1, end);
		const bodyOutsideFence = linesOutsideFences(bodyLines);
		for (const [index, line] of bodyLines.entries()) {
			if (bodyOutsideFence[index] && /^\s*\*\*Depends on\b/i.test(line) && !FIELD_HEADING.test(line)) {
				throw new Error(`${heading.id} must put **Depends on** on its own line before **What**, with None or comma-separated canonical PC IDs on the next line`);
			}
		}
		const fields = bodyLines
			.map((line, index) => ({ index, match: bodyOutsideFence[index] ? FIELD_HEADING.exec(line) : null }))
			.filter((item): item is { index: number; match: RegExpExecArray } => item.match !== null);
		const names = fields.map((item) => item.match[1]!.toLowerCase());
		const hasDependencies = names.includes("depends on");
		if (requireDependencies && !hasDependencies) {
			throw new Error(`${heading.id} is missing **Depends on**; add this standalone field before **What**, with None or comma-separated canonical PC IDs on the next line`);
		}
		if (hasDependencies && (names[0] !== "depends on" || names.lastIndexOf("depends on") !== 0)) {
			throw new Error(`${heading.id} must contain **Depends on** exactly once, before **What**`);
		}
		const contentNames = hasDependencies ? names.slice(1) : names;
		if (contentNames.join(",") !== "what,why" && contentNames.join(",") !== "what,why,pseudocode") {
			throw new Error(
				`${heading.id} must contain **What** and **Why** once, in that order, followed by at most one optional **Pseudocode** field`,
			);
		}
		const value = (fieldIndex: number): string => {
			const start = fields[fieldIndex]!.index + 1;
			const fieldEnd = fields[fieldIndex + 1]?.index ?? bodyLines.length;
			return bodyLines.slice(start, fieldEnd).join("\n").trim();
		};
		const dependsOn = hasDependencies ? parseDependencies(heading.id, value(0)) : undefined;
		const contentStart = hasDependencies ? 1 : 0;
		const what = value(contentStart);
		const why = value(contentStart + 1);
		const pseudocode = contentNames.length === 3 ? value(contentStart + 2) : undefined;
		if (!what || !why) throw new Error(`${heading.id} has an empty What or Why field`);
		if (pseudocode === "") throw new Error(`${heading.id} has an empty Pseudocode field; remove it when it is not useful`);

		return {
			id: heading.id,
			title: heading.title,
			...(dependsOn === undefined ? {} : { dependsOn }),
			what,
			why,
			...(pseudocode === undefined ? {} : { pseudocode }),
			content: lines.slice(heading.index, end).join("\n").trim(),
		};
	});
	validateDependencies(changes);
	return changes;
}

/** Returns nodes in plan reading order, not execution order. Missing legacy declarations are not inferred. */
export function getPlanDependencyGraph(plan: string): PlanDependencyGraph {
	try {
		const changes = parsePlannedChanges(plan, { requireDependencies: true });
		return {
			status: "valid",
			nodes: changes.map(({ id, title, dependsOn }) => ({ id, title, dependsOn: dependsOn! })),
		};
	} catch (error) {
		return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}

function parseDependencies(id: string, value: string): string[] {
	if (value === "None") return [];
	const dependencies = value.split(",").map((dependency) => dependency.trim());
	if (/[\r\n]/.test(value) || dependencies.some((dependency) => !CANONICAL_PC_ID.test(dependency))) {
		throw new Error(`${id} has invalid **Depends on** value ${JSON.stringify(value)}; use None or comma-separated canonical PC IDs (for example PC-02, PC-03) on one line`);
	}
	const seen = new Set<string>();
	for (const dependency of dependencies) {
		if (seen.has(dependency)) throw new Error(`${id} repeats dependency ${dependency}; list each dependency only once`);
		seen.add(dependency);
	}
	return dependencies;
}

function validateDependencies(changes: PlannedChange[]): void {
	const byId = new Map(changes.map((change) => [change.id, change]));
	for (const change of changes) {
		for (const dependency of change.dependsOn ?? []) {
			if (dependency === change.id) throw new Error(`${change.id} cannot depend on itself; remove its self-dependency`);
			if (!byId.has(dependency)) throw new Error(`${change.id} depends on unknown ID ${dependency}; reference an existing planned change`);
		}
	}

	// Iterative depth-first traversal avoids a call-stack limit on large plans.
	const visited = new Set<string>();
	const active = new Map<string, number>();
	for (const change of changes) {
		if (visited.has(change.id)) continue;
		const path = [{ id: change.id, nextDependency: 0 }];
		active.set(change.id, 0);
		while (path.length > 0) {
			const current = path[path.length - 1]!;
			const dependency = byId.get(current.id)!.dependsOn?.[current.nextDependency++];
			if (dependency === undefined) {
				visited.add(current.id);
				active.delete(current.id);
				path.pop();
				continue;
			}
			const cycleStart = active.get(dependency);
			if (cycleStart !== undefined) {
				const cycle = [...path.slice(cycleStart).map(({ id }) => id), dependency];
				throw new Error(`dependency cycle: ${cycle.join(" -> ")}; remove or correct a dependency to make the graph acyclic`);
			}
			if (visited.has(dependency)) continue;
			active.set(dependency, path.length);
			path.push({ id: dependency, nextDependency: 0 });
		}
	}
}

export function parseTestingCriteria(plan: string): string {
	const lines = plan.replaceAll("\r\n", "\n").split("\n");
	const outsideFence = linesOutsideFences(lines);
	const sectionStart = lines.findIndex((line, index) => outsideFence[index] && TESTING_HEADING.test(line));
	if (sectionStart < 0) throw new Error('add a second-level "Testing" section');

	let sectionEnd = lines.length;
	for (let index = sectionStart + 1; index < lines.length; index++) {
		if (outsideFence[index] && SECOND_LEVEL_HEADING.test(lines[index] ?? "")) {
			sectionEnd = index;
			break;
		}
	}
	const criteria = lines.slice(sectionStart + 1, sectionEnd).join("\n").trim();
	if (!criteria) throw new Error("add explicit verification criteria to the Testing section");
	return criteria;
}

function linesOutsideFences(lines: string[]): boolean[] {
	const result: boolean[] = [];
	let fenceCharacter: "`" | "~" | undefined;
	let fenceLength = 0;
	for (const [index, line] of lines.entries()) {
		result[index] = fenceCharacter === undefined;
		const match = /^\s*(`{3,}|~{3,})/.exec(line);
		if (!match) continue;
		const marker = match[1]!;
		const character = marker[0] as "`" | "~";
		if (!fenceCharacter) {
			fenceCharacter = character;
			fenceLength = marker.length;
			continue;
		}
		if (character === fenceCharacter && marker.length >= fenceLength) {
			fenceCharacter = undefined;
			fenceLength = 0;
		}
	}
	return result;
}
