import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlannedChange } from "./planned-changes.ts";
import {
	holisticReviewPrompt,
	plannedChangeReviewPrompt,
	reviewAgentSystemPrompt,
	reviewAgentUserMessage,
	reviewSynthesisPrompt,
	testingCriteriaReviewPrompt,
} from "./prompts.ts";
import {
	HOLISTIC_REVIEW_OUTPUT_TOOL,
	PLANNED_CHANGE_OUTPUT_TOOL,
	REVIEW_SYNTHESIS_OUTPUT_TOOL,
	TESTING_CRITERIA_OUTPUT_TOOL,
} from "./review-agent-output.ts";
import {
	isHolisticReview,
	isPlannedChangeAnalysis,
	isReviewSynthesis,
	isTestingCriteriaAnalysis,
	REVIEW_REPORT_VERSION,
	type HolisticReview,
	type PlannedChangeAnalysis,
	type ReviewSynthesis,
	type TestingCriteriaAnalysis,
	type WorkflowReviewReport,
} from "./review-report.ts";

const REVIEW_AGENT_EXTENSION = fileURLToPath(new URL("./review-agent-output.ts", import.meta.url));
const MAX_REVIEW_CONCURRENCY = 4;
const REVIEW_ROUND_VERSION = 1;

export type ReviewAgentRole = "planned-change" | "holistic-review" | "testing-criteria" | "synthesizer";

export interface ReviewAgentRequest {
	role: ReviewAgentRole;
	outputTool: string;
	prompt: string;
	cwd: string;
	signal?: AbortSignal;
}

export type ReviewAgentRunner = (request: ReviewAgentRequest) => Promise<unknown>;

export interface ReviewGenerationInput {
	pullRequestUrl: string;
	baseCommit: string;
	headCommit: string;
	sourceFingerprint: string;
	worktreePath: string;
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
	reviewRunsPath: string;
	plannedChanges: PlannedChange[];
	testingCriteria: string;
	generatedAt?: string;
	onStage?: (stage: "analysis-complete" | "synthesis-complete") => void;
}

export interface SpawnReviewAgentOptions {
	model?: string;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	signal?: AbortSignal;
}

interface ReviewRoundManifest {
	version: typeof REVIEW_ROUND_VERSION;
	status: "in-progress" | "analysis-complete" | "complete";
	pullRequestUrl: string;
	baseCommit: string;
	headCommit: string;
	sourceFingerprint: string;
	generatedAt: string;
	plannedChanges: Array<{ id: string; title: string }>;
}

interface ReviewRoundPaths {
	root: string;
	manifest: string;
	plannedChanges: string;
	holisticReview: string;
	testingCriteriaReview: string;
	synthesis: string;
}

export async function generateWorkflowReview(
	input: ReviewGenerationInput,
	runAgent: ReviewAgentRunner,
): Promise<WorkflowReviewReport> {
	if (input.plannedChanges.length === 0) throw new Error("The plan has no planned changes to review.");

	const paths = reviewRoundPaths(input);
	const existingManifest = await readJson(paths.manifest, isReviewRoundManifest);
	const canReuse = existingManifest !== undefined && manifestMatches(existingManifest, input);
	if (!canReuse) await rm(paths.root, { recursive: true, force: true });
	await mkdir(paths.plannedChanges, { recursive: true });
	const manifest: ReviewRoundManifest = canReuse
		? existingManifest
		: {
				version: REVIEW_ROUND_VERSION,
				status: "in-progress",
				pullRequestUrl: input.pullRequestUrl,
				baseCommit: input.baseCommit,
				headCommit: input.headCommit,
				sourceFingerprint: input.sourceFingerprint,
				generatedAt: input.generatedAt ?? new Date().toISOString(),
				plannedChanges: input.plannedChanges.map(({ id, title }) => ({ id, title })),
			};
	if (!canReuse) await writeJson(paths.manifest, manifest);

	const generationAbort = new AbortController();
	let analysisChanged = false;
	const jobs: Array<
		() => Promise<
			| { type: "change"; value: PlannedChangeAnalysis }
			| { type: "holistic"; value: HolisticReview }
			| { type: "testing"; value: TestingCriteriaAnalysis }
		>
	> = [
		...input.plannedChanges.map((change) => async () => {
			const resultPath = join(paths.plannedChanges, `${safePathSegment(change.id, "planned-change id")}.json`);
			if (canReuse) {
				const existing = await readJson(resultPath, isPlannedChangeAnalysis);
				if (existing?.id === change.id && existing.title === change.title) {
					return { type: "change" as const, value: existing };
				}
			}
			analysisChanged = true;
			const value = await runAgent({
				role: "planned-change",
				outputTool: PLANNED_CHANGE_OUTPUT_TOOL,
				cwd: input.worktreePath,
				prompt: plannedChangeReviewPrompt({
					id: change.id,
					title: change.title,
					content: change.content,
					metadataPath: input.metadataPath,
					clarificationsPath: input.clarificationsPath,
					planPath: input.planPath,
					baseCommit: input.baseCommit,
					headCommit: input.headCommit,
					pullRequestUrl: input.pullRequestUrl,
				}),
				signal: generationAbort.signal,
			});
			if (!isPlannedChangeAnalysis(value)) throw new Error(`${change.id} reviewer returned an invalid result.`);
			if (value.id !== change.id || value.title !== change.title) {
				throw new Error(`${change.id} reviewer returned the wrong planned-change identity.`);
			}
			await writeJson(resultPath, value);
			return { type: "change" as const, value };
		}),
		async () => {
			if (canReuse) {
				const existing = await readJson(paths.holisticReview, isHolisticReview);
				if (existing) return { type: "holistic" as const, value: existing };
			}
			analysisChanged = true;
			const value = await runAgent({
				role: "holistic-review",
				outputTool: HOLISTIC_REVIEW_OUTPUT_TOOL,
				cwd: input.worktreePath,
				prompt: holisticReviewPrompt({
					metadataPath: input.metadataPath,
					clarificationsPath: input.clarificationsPath,
					planPath: input.planPath,
					baseCommit: input.baseCommit,
					headCommit: input.headCommit,
					pullRequestUrl: input.pullRequestUrl,
				}),
				signal: generationAbort.signal,
			});
			if (!isHolisticReview(value)) throw new Error("The holistic reviewer returned an invalid result.");
			await writeJson(paths.holisticReview, value);
			return { type: "holistic" as const, value };
		},
		async () => {
			if (canReuse) {
				const existing = await readJson(paths.testingCriteriaReview, isTestingCriteriaAnalysis);
				if (existing) return { type: "testing" as const, value: existing };
			}
			analysisChanged = true;
			const value = await runAgent({
				role: "testing-criteria",
				outputTool: TESTING_CRITERIA_OUTPUT_TOOL,
				cwd: input.worktreePath,
				prompt: testingCriteriaReviewPrompt({
					testingCriteria: input.testingCriteria,
					metadataPath: input.metadataPath,
					clarificationsPath: input.clarificationsPath,
					planPath: input.planPath,
					baseCommit: input.baseCommit,
					headCommit: input.headCommit,
					pullRequestUrl: input.pullRequestUrl,
				}),
				signal: generationAbort.signal,
			});
			if (!isTestingCriteriaAnalysis(value)) {
				throw new Error("The testing criteria reviewer returned an invalid result.");
			}
			await writeJson(paths.testingCriteriaReview, value);
			return { type: "testing" as const, value };
		},
	];

	const results = await runWithConcurrency(jobs, MAX_REVIEW_CONCURRENCY, () => generationAbort.abort());
	const analyses = results.filter((result) => result.type === "change").map((result) => result.value);
	const holisticReview = results.find((result) => result.type === "holistic")?.value;
	const testingCriteriaReview = results.find((result) => result.type === "testing")?.value;
	if (!holisticReview) throw new Error("The holistic review did not complete.");
	if (!testingCriteriaReview) throw new Error("The testing criteria review did not complete.");
	if (analyses.length !== input.plannedChanges.length) throw new Error("One or more planned-change reviews are missing.");
	await writeJson(paths.manifest, { ...manifest, status: "analysis-complete" });
	input.onStage?.("analysis-complete");

	const orderedAnalyses = input.plannedChanges.map((change) => {
		const analysis = analyses.find((candidate) => candidate.id === change.id);
		if (!analysis) throw new Error(`The review for ${change.id} is missing.`);
		return analysis;
	});
	let synthesis = !analysisChanged && canReuse ? await readJson(paths.synthesis, isReviewSynthesis) : undefined;
	if (!synthesis) {
		const synthesisValue = await runAgent({
			role: "synthesizer",
			outputTool: REVIEW_SYNTHESIS_OUTPUT_TOOL,
			cwd: input.worktreePath,
			prompt: reviewSynthesisPrompt({
				metadataPath: input.metadataPath,
				clarificationsPath: input.clarificationsPath,
				planPath: input.planPath,
				pullRequestUrl: input.pullRequestUrl,
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
		synthesis = synthesisValue;
		await writeJson(paths.synthesis, synthesis);
	}
	await writeJson(paths.manifest, { ...manifest, status: "complete" });
	input.onStage?.("synthesis-complete");

	return {
		version: REVIEW_REPORT_VERSION,
		pullRequestUrl: input.pullRequestUrl,
		baseCommit: input.baseCommit,
		headCommit: input.headCommit,
		sourceFingerprint: input.sourceFingerprint,
		generatedAt: manifest.generatedAt,
		overallResult: synthesis.overallResult,
		overallConcerns: synthesis.overallConcerns,
		holisticReview,
		plannedChanges: input.plannedChanges.map((change, index) => ({
			id: change.id,
			title: change.title,
			what: change.what,
			why: change.why,
			pseudocode: change.pseudocode,
			review: orderedAnalyses[index]!,
		})),
		testingCriteria: {
			originalCriteria: input.testingCriteria,
			review: testingCriteriaReview,
		},
	};
}

function reviewRoundPaths(input: ReviewGenerationInput): ReviewRoundPaths {
	const range = `${safePathSegment(input.baseCommit, "base commit")}..${safePathSegment(input.headCommit, "head commit")}`;
	const root = join(input.reviewRunsPath, range, safePathSegment(input.sourceFingerprint, "source fingerprint"));
	return {
		root,
		manifest: join(root, "manifest.json"),
		plannedChanges: join(root, "planned-changes"),
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

function manifestMatches(manifest: ReviewRoundManifest, input: ReviewGenerationInput): boolean {
	return (
		manifest.pullRequestUrl === input.pullRequestUrl &&
		manifest.baseCommit === input.baseCommit &&
		manifest.headCommit === input.headCommit &&
		manifest.sourceFingerprint === input.sourceFingerprint &&
		manifest.plannedChanges.length === input.plannedChanges.length &&
		manifest.plannedChanges.every((change, index) => {
			const expected = input.plannedChanges[index];
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
		typeof candidate.pullRequestUrl === "string" &&
		typeof candidate.baseCommit === "string" &&
		typeof candidate.headCommit === "string" &&
		typeof candidate.sourceFingerprint === "string" &&
		typeof candidate.generatedAt === "string" &&
		Array.isArray(candidate.plannedChanges) &&
		candidate.plannedChanges.every(
			(change) =>
				change !== null &&
				typeof change === "object" &&
				typeof (change as { id?: unknown }).id === "string" &&
				typeof (change as { title?: unknown }).title === "string",
		)
	);
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
