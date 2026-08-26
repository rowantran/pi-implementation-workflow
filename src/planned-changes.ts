export interface PlannedChange {
	id: string;
	title: string;
	what: string;
	why: string;
	pseudocode?: string;
	content: string;
}

const PLANNED_CHANGES_HEADING = /^##\s+Planned Changes\s*$/i;
const TESTING_HEADING = /^##\s+Testing\s*$/i;
const SECOND_LEVEL_HEADING = /^##\s+/;
const ENTRY_HEADING = /^###\s+(PC-(\d+)):\s+(.+?)\s*$/;
const FIELD_HEADING = /^\s*\*\*(What|Why|Pseudocode)\*\*:?\s*$/i;

export function parsePlannedChanges(plan: string): PlannedChange[] {
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

	return headings.map((heading, position) => {
		const expectedNumber = position + 1;
		const expectedId = `PC-${String(expectedNumber).padStart(2, "0")}`;
		if (heading.number !== expectedNumber || heading.id !== expectedId) {
			throw new Error(`number planned changes consecutively; expected ${expectedId}, found ${heading.id}`);
		}
		if (!heading.title) throw new Error(`${heading.id} needs a title`);

		const end = headings[position + 1]?.index ?? sectionEnd;
		const bodyLines = lines.slice(heading.index + 1, end);
		const bodyOutsideFence = linesOutsideFences(bodyLines);
		const fields = bodyLines
			.map((line, index) => ({ index, match: bodyOutsideFence[index] ? FIELD_HEADING.exec(line) : null }))
			.filter((item): item is { index: number; match: RegExpExecArray } => item.match !== null);
		const names = fields.map((item) => item.match[1]!.toLowerCase());
		if (names.join(",") !== "what,why" && names.join(",") !== "what,why,pseudocode") {
			throw new Error(
				`${heading.id} must contain **What** and **Why** once, in that order, followed by at most one optional **Pseudocode** field`,
			);
		}
		const value = (fieldIndex: number): string => {
			const start = fields[fieldIndex]!.index + 1;
			const fieldEnd = fields[fieldIndex + 1]?.index ?? bodyLines.length;
			return bodyLines.slice(start, fieldEnd).join("\n").trim();
		};
		const what = value(0);
		const why = value(1);
		const pseudocode = fields.length === 3 ? value(2) : undefined;
		if (!what || !why) throw new Error(`${heading.id} has an empty What or Why field`);
		if (pseudocode === "") throw new Error(`${heading.id} has an empty Pseudocode field; remove it when it is not useful`);

		return {
			id: heading.id,
			title: heading.title,
			what,
			why,
			...(pseudocode === undefined ? {} : { pseudocode }),
			content: lines.slice(heading.index, end).join("\n").trim(),
		};
	});
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
