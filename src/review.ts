import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPlannedChangeId } from "./planned-changes.ts";
import type { WorkflowScope } from "./workflow-scope.ts";
import { formatPullRequestStack, type WorkflowPullRequest } from "./pull-requests.ts";
import {
	holisticReviewPrompt,
	incrementalReviewScopePrompt,
	plannedChangeReviewPrompt,
	reviewAgentSystemPrompt,
	reviewAgentUserMessage,
	reviewSynthesisPrompt,
	testingCriteriaReviewPrompt,
} from "./prompts.ts";
import { reviewCanSeedIncremental, reviewInputsFromScope, type ReviewInputsSnapshot } from "./review-selection.ts";
import {
	HOLISTIC_REVIEW_OUTPUT_TOOL,
	INCREMENTAL_REVIEW_SCOPE_OUTPUT_TOOL,
	PLANNED_CHANGE_OUTPUT_TOOL,
	REVIEW_SYNTHESIS_OUTPUT_TOOL,
	TESTING_CRITERIA_OUTPUT_TOOL,
} from "./review-agent-output.ts";
import {
	isHolisticReview,
	isIncrementalReviewScope,
	isPlannedChangeAnalysis,
	isReviewSynthesis,
	isTestingCriteriaAnalysisForGroups,
	isWorkflowReviewReport,
	REVIEW_REPORT_VERSION,
	type HolisticReview,
	type IncrementalReviewScope,
	type PlannedChangeAnalysis,
	type ReviewSynthesis,
	type TestingCriteriaAnalysis,
	type WorkflowReviewReport,
	type WorkflowReviewReportV4,
	type PlannedChangeDefinition,
} from "./review-report.ts";

const REVIEW_AGENT_EXTENSION = fileURLToPath(new URL("./review-agent-output.ts", import.meta.url));
const MAX_REVIEW_CONCURRENCY = 4;
const REVIEW_ROUND_VERSION = 4;

export type ReviewAgentRole =
	| "incremental-scope"
	| "planned-change"
	| "holistic-review"
	| "testing-criteria"
	| "synthesizer";

export interface ReviewAgentRequest {
	role: ReviewAgentRole;
	outputTool: string;
	prompt: string;
	cwd: string;
	signal?: AbortSignal;
}

export type ReviewAgentRunner = (request: ReviewAgentRequest) => Promise<unknown>;

export type ReviewAgentProgressStatus = "queued" | "running" | "complete" | "failed" | "reused";

export interface ReviewAgentProgress {
	id: string;
	label: string;
	role: ReviewAgentRole;
	status: ReviewAgentProgressStatus;
}

export interface ReviewGenerationInput {
	pullRequests: WorkflowPullRequest[];
	baseCommit: string;
	headCommit: string;
	worktreePath: string;
	metadataPath: string;
	clarificationsPath: string;
	reviewRunsPath: string;
	/** Captured immutable baseline/current requirements; implementation flags are never review inputs. */
	scope: WorkflowScope;
	previousReview?: WorkflowReviewReport;
	previousReviewPath?: string;
	generatedAt?: string;
	onStage?: (stage: "scope-complete" | "analysis-complete" | "synthesis-complete") => void;
	onAgentProgress?: (progress: ReviewAgentProgress) => void;
}

export interface SpawnReviewAgentOptions {
	model?: string;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	signal?: AbortSignal;
}

interface ReviewRoundManifest {
	version: typeof REVIEW_ROUND_VERSION;
	status: "in-progress" | "analysis-complete" | "complete";
	pullRequestUrls: string[];
	baseCommit: string;
	headCommit: string;
	sourceFingerprint: string;
	generatedAt: string;
	plannedChanges: Array<{ id: string; title: string }>;
	incrementalFromHeadCommit?: string;
	relevantPlannedChangeIds?: string[];
}

interface ReviewRoundPaths {
	root: string;
	manifest: string;
	plannedChanges: string;
	incrementalScope: string;
	holisticReview: string;
	testingCriteriaReview: string;
	synthesis: string;
}

interface ReviewAgentIdentity {
	id: string;
	label: string;
	role: ReviewAgentRole;
}

export async function generateWorkflowReview(
	input: ReviewGenerationInput,
	runAgent: ReviewAgentRunner,
): Promise<WorkflowReviewReportV4> {
	// Do not let an in-process caller mutate the captured sources while agents run.
	input = { ...input, scope: structuredClone(input.scope) };
	const inputs = reviewInputsFromScope(input.scope, {
		pullRequestUrls: input.pullRequests.map(({ url }) => url), baseCommit: input.baseCommit, headCommit: input.headCommit,
	});
	const plannedChanges = inputs.plannedChanges;
	const approvedPlanContext = reviewPlanContext(input.scope, inputs);
	const runAgentWithPlan: ReviewAgentRunner = (request) => runAgent({
		...request,
		prompt: `${request.prompt}\n\n${approvedPlanContext}`,
	});
	if ((input.previousReview === undefined) !== (input.previousReviewPath === undefined)) {
		throw new Error("An incremental review requires both the previous review and its path.");
	}
	if (input.previousReview && !reviewCanSeedIncremental(input.previousReview, inputs)) {
		throw new Error(
			"The previous review cannot seed an incremental re-review of the current inputs; generate a full review instead.",
		);
	}

	if (input.pullRequests.length === 0) throw new Error("The workflow has no pull requests to review.");
	const pullRequestStack = formatPullRequestStack(input.pullRequests);
	const pullRequestUrls = input.pullRequests.map(({ url }) => url);

	const reportAgentProgress = (agent: ReviewAgentIdentity, status: ReviewAgentProgressStatus): void => {
		input.onAgentProgress?.({ ...agent, status });
	};
	const runTrackedAgent = async <T>(agent: ReviewAgentIdentity, operation: () => Promise<T>): Promise<T> => {
		reportAgentProgress(agent, "running");
		try {
			const result = await operation();
			reportAgentProgress(agent, "complete");
			return result;
		} catch (error) {
			reportAgentProgress(agent, "failed");
			throw error;
		}
	};

	const paths = reviewRoundPaths(input, inputs);
	const existingManifest = await readJson(paths.manifest, isReviewRoundManifest);
	const canReuse = existingManifest !== undefined && manifestMatches(existingManifest, input, inputs);
	if (!canReuse) await rm(paths.root, { recursive: true, force: true });
	await mkdir(paths.plannedChanges, { recursive: true });
	let manifest: ReviewRoundManifest = canReuse
		? existingManifest
		: {
				version: REVIEW_ROUND_VERSION,
				status: "in-progress",
				pullRequestUrls,
				baseCommit: input.baseCommit,
				headCommit: input.headCommit,
				sourceFingerprint: inputs.sourceFingerprint,
				generatedAt: input.generatedAt ?? new Date().toISOString(),
				plannedChanges: plannedChanges.map(({ id, title }) => ({ id, title })),
				...(input.previousReview ? { incrementalFromHeadCommit: input.previousReview.headCommit } : {}),
			};
	if (!canReuse) await writeJson(paths.manifest, manifest);

	const generationAbort = new AbortController();
	let relevantPlannedChangeIds = plannedChanges.map(({ id }) => id);
	if (input.previousReview) {
		const previousReview = input.previousReview;
		const scopeAgent: ReviewAgentIdentity = {
			id: "incremental-scope",
			label: "Incremental scope reviewer",
			role: "incremental-scope",
		};
		reportAgentProgress(scopeAgent, "queued");
		let scope = canReuse ? await readJson(paths.incrementalScope, isIncrementalReviewScope) : undefined;
		const reusableScope =
			scope !== undefined &&
			incrementalReviewScopeIsValid(scope, plannedChanges) &&
			arraysEqual(
				manifest.relevantPlannedChangeIds,
				scope.relevantPlannedChanges.map(({ id }) => id),
			);
		if (!reusableScope) {
			if (canReuse) {
				await Promise.all([
					rm(paths.plannedChanges, { recursive: true, force: true }),
					rm(paths.holisticReview, { force: true }),
					rm(paths.testingCriteriaReview, { force: true }),
					rm(paths.synthesis, { force: true }),
				]);
				await mkdir(paths.plannedChanges, { recursive: true });
			}
			scope = await runTrackedAgent(scopeAgent, async () => {
				const value = await runAgentWithPlan({
					role: "incremental-scope",
					outputTool: INCREMENTAL_REVIEW_SCOPE_OUTPUT_TOOL,
					cwd: input.worktreePath,
					prompt: incrementalReviewScopePrompt({
						metadataPath: input.metadataPath,
						clarificationsPath: input.clarificationsPath,
						planPath: input.scope.approvedPlan.path,
						previousReviewPath: input.previousReviewPath!,
						previousHeadCommit: previousReview.headCommit,
						headCommit: input.headCommit,
						pullRequestStack,
					}),
					signal: generationAbort.signal,
				});
				if (!isIncrementalReviewScope(value) || !incrementalReviewScopeIsValid(value, plannedChanges)) {
					throw new Error("The incremental review scope agent returned an invalid result.");
				}
				await writeJson(paths.incrementalScope, value);
				return value;
			});
			manifest = {
				...manifest,
				status: "in-progress",
				relevantPlannedChangeIds: scope.relevantPlannedChanges.map(({ id }) => id),
			};
			await writeJson(paths.manifest, manifest);
		} else {
			reportAgentProgress(scopeAgent, "reused");
		}
		relevantPlannedChangeIds = scope!.relevantPlannedChanges.map(({ id }) => id);
		input.onStage?.("scope-complete");
	}
	const relevantPlannedChanges = new Set(relevantPlannedChangeIds);
	const plannedChangeAgents = new Map(
		plannedChanges
			.map((change, index) => ({ change, number: index + 1 }))
			.filter(({ change }) => relevantPlannedChanges.has(change.id))
			.map(({ change, number }) => [
				change.id,
				{
					id: `planned-change:${change.id}`,
					label: `${number}. ${change.title}`,
					role: "planned-change" as const,
				},
			]),
	);
	const holisticAgent: ReviewAgentIdentity = {
		id: "holistic-review",
		label: "Holistic reviewer",
		role: "holistic-review",
	};
	const testingCriteriaAgent: ReviewAgentIdentity = {
		id: "testing-criteria",
		label: "Testing criteria reviewer",
		role: "testing-criteria",
	};
	for (const agent of [...plannedChangeAgents.values(), holisticAgent, testingCriteriaAgent]) {
		reportAgentProgress(agent, "queued");
	}

	let analysisChanged = false;
	const jobs: Array<
		() => Promise<
			| { type: "change"; value: PlannedChangeAnalysis }
			| { type: "holistic"; value: HolisticReview }
			| { type: "testing"; value: TestingCriteriaAnalysis }
		>
	> = [
		...plannedChanges.map((change) => async () => {
			const resultPath = join(paths.plannedChanges, `${safePathSegment(change.id, "planned-change id")}.json`);
			const agent = plannedChangeAgents.get(change.id);
			if (canReuse) {
				const existing = await readJson(resultPath, isPlannedChangeAnalysis);
				if (existing?.id === change.id && existing.title === change.title) {
					if (agent) reportAgentProgress(agent, "reused");
					return { type: "change" as const, value: existing };
				}
			}
			if (!relevantPlannedChanges.has(change.id)) {
				const previous = input.previousReview?.plannedChanges.find((candidate) => candidate.id === change.id)?.review;
				if (!previous || previous.title !== change.title) {
					throw new Error(`The previous review for unaffected planned change ${change.id} is missing.`);
				}
				await writeJson(resultPath, previous);
				return { type: "change" as const, value: previous };
			}
			if (!agent) throw new Error(`The review progress identity for ${change.id} is missing.`);
			analysisChanged = true;
			// Persist invalidation before replacing evidence, even if another analysis later fails.
			await rm(paths.synthesis, { force: true });
			return runTrackedAgent(agent, async () => {
				const value = await runAgentWithPlan({
					role: "planned-change",
					outputTool: PLANNED_CHANGE_OUTPUT_TOOL,
					cwd: input.worktreePath,
					prompt: plannedChangeReviewPrompt({
						id: change.id,
						title: change.title,
						content: change.content,
						metadataPath: input.metadataPath,
						clarificationsPath: input.clarificationsPath,
						planPath: input.scope.approvedPlan.path,
						baseCommit: input.baseCommit,
						headCommit: input.headCommit,
						pullRequestStack,
					}),
					signal: generationAbort.signal,
				});
				if (!isPlannedChangeAnalysis(value)) throw new Error(`${change.id} reviewer returned an invalid result.`);
				if (value.id !== change.id || value.title !== change.title) {
					throw new Error(`${change.id} reviewer returned the wrong planned-change identity.`);
				}
				await writeJson(resultPath, value);
				return { type: "change" as const, value };
			});
		}),
		async () => {
			if (canReuse) {
				const existing = await readJson(paths.holisticReview, isHolisticReview);
				if (existing) {
					reportAgentProgress(holisticAgent, "reused");
					return { type: "holistic" as const, value: existing };
				}
			}
			analysisChanged = true;
			await rm(paths.synthesis, { force: true });
			return runTrackedAgent(holisticAgent, async () => {
				const value = await runAgentWithPlan({
					role: "holistic-review",
					outputTool: HOLISTIC_REVIEW_OUTPUT_TOOL,
					cwd: input.worktreePath,
					prompt: holisticReviewPrompt({
						metadataPath: input.metadataPath,
						clarificationsPath: input.clarificationsPath,
						planPath: input.scope.approvedPlan.path,
						baseCommit: input.baseCommit,
						headCommit: input.headCommit,
						pullRequestStack,
					}),
					signal: generationAbort.signal,
				});
				if (!isHolisticReview(value)) throw new Error("The holistic reviewer returned an invalid result.");
				await writeJson(paths.holisticReview, value);
				return { type: "holistic" as const, value };
			});
		},
		async () => {
			if (canReuse) {
				const existing = await readJson(paths.testingCriteriaReview, (value): value is TestingCriteriaAnalysis =>
					isTestingCriteriaAnalysisForGroups(value, inputs.testingGroups));
				if (existing) {
					reportAgentProgress(testingCriteriaAgent, "reused");
					return { type: "testing" as const, value: existing };
				}
			}
			analysisChanged = true;
			await rm(paths.synthesis, { force: true });
			return runTrackedAgent(testingCriteriaAgent, async () => {
				const value = await runAgentWithPlan({
					role: "testing-criteria",
					outputTool: TESTING_CRITERIA_OUTPUT_TOOL,
					cwd: input.worktreePath,
					prompt: testingCriteriaReviewPrompt({
						testingCriteria: inputs.testingCriteria,
						metadataPath: input.metadataPath,
						clarificationsPath: input.clarificationsPath,
						planPath: input.scope.approvedPlan.path,
						baseCommit: input.baseCommit,
						headCommit: input.headCommit,
						pullRequestStack,
					}),
					signal: generationAbort.signal,
				});
				if (!isTestingCriteriaAnalysisForGroups(value, inputs.testingGroups)) {
					throw new Error("The testing criteria reviewer returned an invalid result.");
				}
				await writeJson(paths.testingCriteriaReview, value);
				return { type: "testing" as const, value };
			});
		},
	];

	const results = await runWithConcurrency(jobs, MAX_REVIEW_CONCURRENCY, () => generationAbort.abort());
	const analyses = results.filter((result) => result.type === "change").map((result) => result.value);
	const holisticReview = results.find((result) => result.type === "holistic")?.value;
	const testingCriteriaReview = results.find((result) => result.type === "testing")?.value;
	if (!holisticReview) throw new Error("The holistic review did not complete.");
	if (!testingCriteriaReview) throw new Error("The testing criteria review did not complete.");
	if (analyses.length !== plannedChanges.length) throw new Error("One or more planned-change reviews are missing.");
	await writeJson(paths.manifest, { ...manifest, status: "analysis-complete" });
	input.onStage?.("analysis-complete");

	const orderedAnalyses = plannedChanges.map((change) => {
		const analysis = analyses.find((candidate) => candidate.id === change.id);
		if (!analysis) throw new Error(`The review for ${change.id} is missing.`);
		return analysis;
	});
	const synthesisAgent: ReviewAgentIdentity = {
		id: "synthesizer",
		label: "Synthesis agent",
		role: "synthesizer",
	};
	reportAgentProgress(synthesisAgent, "queued");
	let synthesis = !analysisChanged && canReuse ? await readJson(paths.synthesis, isReviewSynthesis) : undefined;
	if (!synthesis) {
		synthesis = await runTrackedAgent(synthesisAgent, async () => {
			const synthesisValue = await runAgentWithPlan({
				role: "synthesizer",
				outputTool: REVIEW_SYNTHESIS_OUTPUT_TOOL,
				cwd: input.worktreePath,
				prompt: reviewSynthesisPrompt({
					metadataPath: input.metadataPath,
					clarificationsPath: input.clarificationsPath,
					planPath: input.scope.approvedPlan.path,
					pullRequestStack,
					baseCommit: input.baseCommit,
					headCommit: input.headCommit,
					plannedChangeReviewsDirectory: paths.plannedChanges,
					holisticReviewPath: paths.holisticReview,
					testingCriteriaReviewPath: paths.testingCriteriaReview,
					outputTool: REVIEW_SYNTHESIS_OUTPUT_TOOL,
				}),
				signal: generationAbort.signal,
			});
			if (!isReviewSynthesis(synthesisValue)) throw new Error("The review synthesizer returned an invalid result.");
			await writeJson(paths.synthesis, synthesisValue);
			return synthesisValue;
		});
	} else {
		reportAgentProgress(synthesisAgent, "reused");
	}
	const report: WorkflowReviewReportV4 = {
		version: REVIEW_REPORT_VERSION,
		baselinePlanVersion: input.scope.approvedPlan.number,
		currentPlanVersion: input.scope.currentPlan.number,
		pullRequestUrls,
		baseCommit: input.baseCommit,
		headCommit: input.headCommit,
		sourceFingerprint: inputs.sourceFingerprint,
		generatedAt: manifest.generatedAt,
		overallResult: synthesis.overallResult,
		overallConcerns: synthesis.overallConcerns,
		holisticReview,
		plannedChanges: plannedChanges.map((change, index) => ({ ...change, review: orderedAnalyses[index]! })),
		testingCriteria: {
			originalCriteria: inputs.testingCriteria,
			groups: inputs.testingGroups,
			review: testingCriteriaReview,
		},
	};
	if (!isWorkflowReviewReport(report)) throw new Error("The generated workflow review report is invalid.");
	await writeJson(paths.manifest, { ...manifest, status: "complete" });
	input.onStage?.("synthesis-complete");
	return report;
}

/** Requirement-only context shared by every role, including incremental scope and synthesis. */
function reviewPlanContext(scope: WorkflowScope, inputs: ReviewInputsSnapshot): string {
	const plan = scope.approvedPlan.document;
	return [
		"<workflow-scope-evidence>",
		`Exact baseline plan version: ${scope.approvedPlan.path}`,
		`Exact current plan version: ${scope.currentPlan.path}`,
		"All finalized followups below are in scope. Explicit amendments govern only their cited requirements; unrelated original requirements remain in force.",
		"Implementation flags are not evidence of correctness. Assess every scoped change independently; do not read progress metadata as review evidence or change any flags.",
		"Original ask:", scope.originalAsk,
		"Clarifications:", ...scope.clarifications.entries.flatMap(({ question, answer }) => [`Question: ${question}`, `Answer: ${answer}`]),
		"Goal:", plan.goal,
		...(plan.intro === undefined ? [] : ["", "Introduction:", plan.intro]),
		"",
		`Reading order: ${inputs.plannedChanges.map(({ id }) => id).join(", ")}`,
		...inputs.plannedChanges.flatMap((change, index) => [
			"", `Planned change ${index + 1}: ${change.title}`, `Stable ID: ${change.id}`,
			`Kind: ${change.kind === "followup" ? "Followup" : "Original"}`,
			`Depends on: ${change.dependsOn.length ? change.dependsOn.join(", ") : "None"}`,
			...(change.kind === "followup" ? [`Scope effect: ${JSON.stringify(change.effect)}`] : []),
			"", change.content,
		]),
		"", "Testing groups (cover every source ID):",
		...inputs.testingGroups.flatMap(({ sourceId, criteria }) => ["", `Testing source ID: ${sourceId}`, criteria]),
		"</workflow-scope-evidence>",
	].join("\n");
}

function reviewRoundPaths(input: ReviewGenerationInput, inputs: ReviewInputsSnapshot): ReviewRoundPaths {
	const range = `${safePathSegment(input.baseCommit, "base commit")}..${safePathSegment(input.headCommit, "head commit")}`;
	const root = join(input.reviewRunsPath, range, safePathSegment(inputs.sourceFingerprint, "source fingerprint"));
	return {
		root,
		manifest: join(root, "manifest.json"),
		plannedChanges: join(root, "planned-changes"),
		incrementalScope: join(root, "incremental-review-scope.json"),
		holisticReview: join(root, "holistic-review.json"),
		testingCriteriaReview: join(root, "testing-criteria-review.json"),
		synthesis: join(root, "synthesis.json"),
	};
}

function safePathSegment(value: string, label: string): string {
	if (value === "." || value === ".." || !/^[a-zA-Z0-9._-]+$/.test(value)) {
		throw new Error(`Invalid ${label} for review artifact path.`);
	}
	return value;
}

function manifestMatches(manifest: ReviewRoundManifest, input: ReviewGenerationInput, inputs: ReviewInputsSnapshot): boolean {
	const plannedChanges = inputs.plannedChanges;
	return (
		arraysEqual(manifest.pullRequestUrls, input.pullRequests.map(({ url }) => url)) &&
		manifest.baseCommit === input.baseCommit &&
		manifest.headCommit === input.headCommit &&
		manifest.sourceFingerprint === inputs.sourceFingerprint &&
		manifest.incrementalFromHeadCommit === input.previousReview?.headCommit &&
		manifest.plannedChanges.length === plannedChanges.length &&
		manifest.plannedChanges.every((change, index) => {
			const expected = plannedChanges[index];
			return change.id === expected?.id && change.title === expected.title;
		})
	);
}

function isReviewRoundManifest(value: unknown): value is ReviewRoundManifest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ReviewRoundManifest>;
	return (
		candidate.version === REVIEW_ROUND_VERSION &&
		(candidate.status === "in-progress" || candidate.status === "analysis-complete" || candidate.status === "complete") &&
		Array.isArray(candidate.pullRequestUrls) &&
		candidate.pullRequestUrls.length > 0 &&
		candidate.pullRequestUrls.every((url) => typeof url === "string") &&
		typeof candidate.baseCommit === "string" &&
		typeof candidate.headCommit === "string" &&
		typeof candidate.sourceFingerprint === "string" &&
		typeof candidate.generatedAt === "string" &&
		Array.isArray(candidate.plannedChanges) &&
		candidate.plannedChanges.every(
			(change) =>
				change !== null &&
				typeof change === "object" &&
				isPlannedChangeId((change as { id?: unknown }).id) &&
				typeof (change as { title?: unknown }).title === "string",
		) &&
		(candidate.incrementalFromHeadCommit === undefined ||
			typeof candidate.incrementalFromHeadCommit === "string") &&
		(candidate.relevantPlannedChangeIds === undefined ||
			(Array.isArray(candidate.relevantPlannedChangeIds) &&
				candidate.relevantPlannedChangeIds.every(isPlannedChangeId)))
	);
}

function incrementalReviewScopeIsValid(scope: IncrementalReviewScope, plannedChanges: PlannedChangeDefinition[]): boolean {
	const knownIds = new Set(plannedChanges.map(({ id }) => id));
	const selectedIds = scope.relevantPlannedChanges.map(({ id }) => id);
	return new Set(selectedIds).size === selectedIds.length && selectedIds.every((id) => knownIds.has(id));
}

function arraysEqual(left: string[] | undefined, right: string[]): boolean {
	return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readJson<T>(path: string, validate: (value: unknown) => value is T): Promise<T | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const value: unknown = JSON.parse(text);
		return validate(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export function createSpawnReviewAgent(options: SpawnReviewAgentOptions): ReviewAgentRunner {
	return async (request) =>
		spawnReviewAgent(request, {
			...options,
			signal:
				request.signal && options.signal
					? AbortSignal.any([request.signal, options.signal])
					: request.signal ?? options.signal,
		});
}

async function spawnReviewAgent(
	request: ReviewAgentRequest,
	options: SpawnReviewAgentOptions,
): Promise<unknown> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-workflow-review-"));
	const promptPath = join(temporaryDirectory, `${request.role}.md`);
	await writeFile(promptPath, `${reviewAgentSystemPrompt(request.outputTool)}\n\n${request.prompt}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--extension",
			REVIEW_AGENT_EXTENSION,
			"--tools",
			`read,bash,grep,find,ls,${request.outputTool}`,
			"--append-system-prompt",
			promptPath,
		];
		if (options.model) args.push("--model", options.model);
		if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
		args.push(reviewAgentUserMessage({ role: request.role, outputTool: request.outputTool }));

		const invocation = piInvocation(args);
		let stderr = "";
		let output: unknown;
		const submittedToolCalls = new Set<string>();
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve, reject) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: request.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const message = event.message;
				if (
					(event.type === "tool_result_end" || event.type === "message_end") &&
					message?.role === "toolResult" &&
					message.toolName === request.outputTool
				) {
					const submissionId = String(message.toolCallId ?? "single-submission");
					if (!submittedToolCalls.has(submissionId)) {
						submittedToolCalls.add(submissionId);
						output = message.details;
					}
				}
			};
			child.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});
			if (options.signal) {
				const abort = () => {
					wasAborted = true;
					child.kill("SIGTERM");
					setTimeout(() => {
						if (!child.killed) child.kill("SIGKILL");
					}, 5_000).unref();
				};
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			}
		});
		if (wasAborted) throw new Error(`${request.role} review was cancelled.`);
		if (exitCode !== 0) throw new Error(`${request.role} review failed: ${stderr.trim() || `exit code ${exitCode}`}`);
		if (submittedToolCalls.size !== 1 || output === undefined) {
			throw new Error(`${request.role} reviewer did not submit exactly one ${request.outputTool} result.`);
		}
		return output;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function runWithConcurrency<T>(
	jobs: Array<() => Promise<T>>,
	concurrency: number,
	onFailure: () => void,
): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	let failed = false;
	let failure: unknown;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, async () => {
		while (!failed) {
			const index = next++;
			const job = jobs[index];
			if (!job) return;
			try {
				results[index] = await job();
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
				onFailure();
			}
		}
	});
	await Promise.all(workers);
	if (failed) throw failure;
	return results;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}
