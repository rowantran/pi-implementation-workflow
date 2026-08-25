import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlannedChange } from "./planned-changes.ts";
import {
	planAuditReviewPrompt,
	plannedChangeReviewPrompt,
	reviewAgentSystemPrompt,
	reviewAgentUserMessage,
	reviewSynthesisPrompt,
	testingCriteriaReviewPrompt,
} from "./prompts.ts";
import {
	PLAN_AUDIT_OUTPUT_TOOL,
	PLANNED_CHANGE_OUTPUT_TOOL,
	REVIEW_SYNTHESIS_OUTPUT_TOOL,
	TESTING_CRITERIA_OUTPUT_TOOL,
} from "./review-agent-output.ts";
import {
	isPlanAudit,
	isPlannedChangeAnalysis,
	isReviewSynthesis,
	isTestingCriteriaAnalysis,
	REVIEW_REPORT_VERSION,
	type PlanAudit,
	type PlannedChangeAnalysis,
	type ReviewSynthesis,
	type TestingCriteriaAnalysis,
	type WorkflowReviewReport,
} from "./review-report.ts";

const REVIEW_AGENT_EXTENSION = fileURLToPath(new URL("./review-agent-output.ts", import.meta.url));
const MAX_REVIEW_CONCURRENCY = 4;

export type ReviewAgentRole = "planned-change" | "plan-auditor" | "testing-criteria" | "synthesizer";

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
	worktreePath: string;
	metadataPath: string;
	planPath: string;
	clarificationsPath: string;
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

export async function generateWorkflowReview(
	input: ReviewGenerationInput,
	runAgent: ReviewAgentRunner,
): Promise<WorkflowReviewReport> {
	if (input.plannedChanges.length === 0) throw new Error("The plan has no planned changes to review.");

	const generationAbort = new AbortController();
	const jobs: Array<
		() => Promise<
			| { type: "change"; value: PlannedChangeAnalysis }
			| { type: "audit"; value: PlanAudit }
			| { type: "testing"; value: TestingCriteriaAnalysis }
		>
	> = [
		...input.plannedChanges.map((change) => async () => {
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
			return { type: "change" as const, value };
		}),
		async () => {
			const value = await runAgent({
				role: "plan-auditor",
				outputTool: PLAN_AUDIT_OUTPUT_TOOL,
				cwd: input.worktreePath,
				prompt: planAuditReviewPrompt({
					metadataPath: input.metadataPath,
					clarificationsPath: input.clarificationsPath,
					planPath: input.planPath,
					baseCommit: input.baseCommit,
					headCommit: input.headCommit,
					pullRequestUrl: input.pullRequestUrl,
				}),
				signal: generationAbort.signal,
			});
			if (!isPlanAudit(value)) throw new Error("The holistic plan auditor returned an invalid result.");
			return { type: "audit" as const, value };
		},
		async () => {
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
			return { type: "testing" as const, value };
		},
	];

	const results = await runWithConcurrency(jobs, MAX_REVIEW_CONCURRENCY, () => generationAbort.abort());
	const analyses = results.filter((result) => result.type === "change").map((result) => result.value);
	const audit = results.find((result) => result.type === "audit")?.value;
	const testingCriteriaReview = results.find((result) => result.type === "testing")?.value;
	if (!audit) throw new Error("The holistic plan audit did not complete.");
	if (!testingCriteriaReview) throw new Error("The testing criteria review did not complete.");
	if (analyses.length !== input.plannedChanges.length) throw new Error("One or more planned-change reviews are missing.");
	input.onStage?.("analysis-complete");

	const orderedAnalyses = input.plannedChanges.map((change) => {
		const analysis = analyses.find((candidate) => candidate.id === change.id);
		if (!analysis) throw new Error(`The review for ${change.id} is missing.`);
		return analysis;
	});
	const synthesisDirectory = await mkdtemp(join(tmpdir(), "pi-workflow-review-synthesis-"));
	const plannedChangeReviewsPath = join(synthesisDirectory, "planned-change-reviews.json");
	const planAuditPath = join(synthesisDirectory, "plan-audit.json");
	const testingCriteriaReviewPath = join(synthesisDirectory, "testing-criteria-review.json");
	let synthesis: ReviewSynthesis;
	try {
		await Promise.all([
			writeReviewResult(plannedChangeReviewsPath, orderedAnalyses),
			writeReviewResult(planAuditPath, audit),
			writeReviewResult(testingCriteriaReviewPath, testingCriteriaReview),
		]);
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
				plannedChangeReviewsPath,
				planAuditPath,
				testingCriteriaReviewPath,
				outputTool: REVIEW_SYNTHESIS_OUTPUT_TOOL,
			}),
			signal: generationAbort.signal,
		});
		if (!isReviewSynthesis(synthesisValue)) throw new Error("The review synthesizer returned an invalid result.");
		synthesis = synthesisValue;
	} finally {
		await rm(synthesisDirectory, { recursive: true, force: true });
	}
	input.onStage?.("synthesis-complete");

	return {
		version: REVIEW_REPORT_VERSION,
		pullRequestUrl: input.pullRequestUrl,
		baseCommit: input.baseCommit,
		headCommit: input.headCommit,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		overallResult: synthesis.overallResult,
		overallConcerns: synthesis.overallConcerns,
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

async function writeReviewResult(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
