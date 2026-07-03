#!/usr/bin/env bun
/**
 * Tiny local agent-regression evaluator.
 *
 * Default mode validates the fixture's own reference answers. To score a real
 * candidate, pass `--responses path/to/responses.jsonl`; each line should be:
 * {"caseId":"...","run":1,"response":"...","latencyMs":123,"estimatedTokens":45,"toolCalls":2,"toolFailures":0}
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface Checks {
	contains: string[];
	notContains: string[];
	regex: string[];
	equals?: string;
	caseSensitive: boolean;
}

interface Budgets {
	maxEstimatedTokens?: number;
	maxToolCalls?: number;
	maxToolFailures?: number;
	maxLatencyMs?: number;
}

interface EvalCase {
	id: string;
	suite: string;
	category: string;
	source: string;
	tags: string[];
	prompt: string;
	reference: string;
	repeat: number;
	checks: Checks;
	budgets: Budgets;
}

interface CandidateAttempt {
	caseId: string;
	run?: number;
	response: string;
	latencyMs?: number;
	estimatedTokens?: number;
	toolCalls?: number;
	toolFailures?: number;
}

interface ScoredAttempt {
	run: number;
	success: boolean;
	failures: string[];
	latencyMs: number;
	estimatedTokens: number;
	toolCalls: number;
	toolFailures: number;
	response: string;
}

interface ScoredCase {
	id: string;
	suite: string;
	category: string;
	success: boolean;
	attempts: ScoredAttempt[];
}

interface Args {
	dataset: string;
	responses?: string;
	outDir: string;
	runs?: number;
	suites: string[];
	json: boolean;
}

const DEFAULT_DATASET = path.join("evals", "agent-tweak-smoke.jsonl");
const DEFAULT_OUT_DIR = path.join("runs", "agent-tweak-eval", "latest");

function writeStdout(text: string): void {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function writeStderr(text: string): void {
	process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function usage(): never {
	writeStderr(`Usage: bun scripts/agent-tweak-eval.ts [options]

Options:
  --dataset <path>    JSONL eval cases (default: ${DEFAULT_DATASET})
  --responses <path>  Candidate response/trace JSONL to score
  --out <dir>         Output directory (default: ${DEFAULT_OUT_DIR})
  --runs <n>          Override repeats per case
  --suite <name>      Run only one suite; repeat for multiple suites
  --json              Print summary JSON after METRIC lines
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { dataset: DEFAULT_DATASET, outDir: DEFAULT_OUT_DIR, suites: [], json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dataset") {
			args.dataset = argv[++i] ?? usage();
		} else if (arg === "--responses") {
			args.responses = argv[++i] ?? usage();
		} else if (arg === "--out") {
			args.outDir = argv[++i] ?? usage();
		} else if (arg === "--runs") {
			const parsed = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(parsed) || parsed <= 0) usage();
			args.runs = parsed;
		} else if (arg === "--suite") {
			args.suites.push(argv[++i] ?? usage());
		} else if (arg === "--json") {
			args.json = true;
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else {
			writeStderr(`Unknown argument: ${arg}`);
			usage();
		}
	}
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing required string field ${key}`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : fallback;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function optionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	return isRecord(value) ? value : {};
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
	const parsed: unknown = Bun.JSONL.parse(await Bun.file(file).text());
	if (!Array.isArray(parsed)) throw new Error(`${file}: JSONL parse did not return an array`);
	return parsed.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${file}:${index + 1}: JSONL row is not an object`);
		return entry;
	});
}

function parseCase(record: Record<string, unknown>): EvalCase {
	const checksRecord = optionalRecord(record, "checks");
	const budgetsRecord = optionalRecord(record, "budgets");
	const repeat = optionalNumber(record, "repeat") ?? 1;
	return {
		id: requiredString(record, "id"),
		suite: requiredString(record, "suite"),
		category: requiredString(record, "category"),
		source: optionalString(record, "source") ?? "local",
		tags: stringArray(record, "tags"),
		prompt: requiredString(record, "prompt"),
		reference: requiredString(record, "reference"),
		repeat: Math.max(1, Math.floor(repeat)),
		checks: {
			contains: stringArray(checksRecord, "contains"),
			notContains: stringArray(checksRecord, "notContains"),
			regex: stringArray(checksRecord, "regex"),
			equals: optionalString(checksRecord, "equals"),
			caseSensitive: optionalBoolean(checksRecord, "caseSensitive", false),
		},
		budgets: {
			maxEstimatedTokens: optionalNumber(budgetsRecord, "maxEstimatedTokens"),
			maxToolCalls: optionalNumber(budgetsRecord, "maxToolCalls"),
			maxToolFailures: optionalNumber(budgetsRecord, "maxToolFailures"),
			maxLatencyMs: optionalNumber(budgetsRecord, "maxLatencyMs"),
		},
	};
}

function parseAttempt(record: Record<string, unknown>): CandidateAttempt {
	const caseId = optionalString(record, "caseId") ?? optionalString(record, "id");
	if (!caseId) throw new Error("Candidate response row is missing caseId");
	const response =
		optionalString(record, "response") ?? optionalString(record, "output") ?? optionalString(record, "text");
	if (response === undefined) throw new Error(`Candidate response row for ${caseId} is missing response/output/text`);
	return {
		caseId,
		run: optionalNumber(record, "run"),
		response,
		latencyMs: optionalNumber(record, "latencyMs"),
		estimatedTokens: optionalNumber(record, "estimatedTokens") ?? optionalNumber(record, "tokens"),
		toolCalls: optionalNumber(record, "toolCalls"),
		toolFailures: optionalNumber(record, "toolFailures"),
	};
}

function normalize(text: string, caseSensitive: boolean): string {
	return caseSensitive ? text : text.toLowerCase();
}

function estimateTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

function scoreAttempt(evalCase: EvalCase, attempt: CandidateAttempt, run: number): ScoredAttempt {
	const failures: string[] = [];
	const checks = evalCase.checks;
	const response = attempt.response;
	const haystack = normalize(response, checks.caseSensitive);

	if (checks.equals !== undefined) {
		const actual = normalize(response.trim(), checks.caseSensitive);
		const expected = normalize(checks.equals.trim(), checks.caseSensitive);
		if (actual !== expected) failures.push(`equals expected ${JSON.stringify(checks.equals)}`);
	}

	for (const needle of checks.contains) {
		if (!haystack.includes(normalize(needle, checks.caseSensitive)))
			failures.push(`missing contains ${JSON.stringify(needle)}`);
	}

	for (const needle of checks.notContains) {
		if (haystack.includes(normalize(needle, checks.caseSensitive))) {
			failures.push(`forbidden contains ${JSON.stringify(needle)}`);
		}
	}

	for (const pattern of checks.regex) {
		const flags = checks.caseSensitive ? "" : "i";
		if (!new RegExp(pattern, flags).test(response)) failures.push(`regex did not match ${JSON.stringify(pattern)}`);
	}

	const latencyMs = attempt.latencyMs ?? 0;
	const estimatedTokens = attempt.estimatedTokens ?? estimateTokens(response);
	const toolCalls = attempt.toolCalls ?? 0;
	const toolFailures = attempt.toolFailures ?? 0;
	const budgets = evalCase.budgets;
	if (budgets.maxLatencyMs !== undefined && latencyMs > budgets.maxLatencyMs) {
		failures.push(`latency ${latencyMs}ms exceeds ${budgets.maxLatencyMs}ms`);
	}
	if (budgets.maxEstimatedTokens !== undefined && estimatedTokens > budgets.maxEstimatedTokens) {
		failures.push(`estimatedTokens ${estimatedTokens} exceeds ${budgets.maxEstimatedTokens}`);
	}
	if (budgets.maxToolCalls !== undefined && toolCalls > budgets.maxToolCalls) {
		failures.push(`toolCalls ${toolCalls} exceeds ${budgets.maxToolCalls}`);
	}
	if (budgets.maxToolFailures !== undefined && toolFailures > budgets.maxToolFailures) {
		failures.push(`toolFailures ${toolFailures} exceeds ${budgets.maxToolFailures}`);
	}

	return {
		run,
		success: failures.length === 0,
		failures,
		latencyMs,
		estimatedTokens,
		toolCalls,
		toolFailures,
		response,
	};
}

function missingAttempt(evalCase: EvalCase, run: number): ScoredAttempt {
	return {
		run,
		success: false,
		failures: [`missing candidate response for ${evalCase.id} run ${run}`],
		latencyMs: 0,
		estimatedTokens: 0,
		toolCalls: 0,
		toolFailures: 0,
		response: "",
	};
}

function indexAttempts(attempts: CandidateAttempt[]): Map<string, Map<number, CandidateAttempt>> {
	const indexed = new Map<string, Map<number, CandidateAttempt>>();
	const nextImplicitRun = new Map<string, number>();
	for (const attempt of attempts) {
		const byRun = indexed.get(attempt.caseId) ?? new Map<number, CandidateAttempt>();
		const run = attempt.run === undefined ? (nextImplicitRun.get(attempt.caseId) ?? 1) : Math.floor(attempt.run);
		if (run <= 0) throw new Error(`Candidate response row for ${attempt.caseId} has invalid run ${attempt.run}`);
		if (byRun.has(run)) throw new Error(`Duplicate candidate response for ${attempt.caseId} run ${run}`);
		byRun.set(run, attempt);
		indexed.set(attempt.caseId, byRun);
		nextImplicitRun.set(attempt.caseId, run + 1);
	}
	return indexed;
}

function pct(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function sanitizeMetricName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function summarizeCases(input: readonly ScoredCase[]): {
	casesTotal: number;
	attemptsTotal: number;
	caseSuccessRate: number;
	attemptSuccessRate: number;
	avgLatencyMs: number;
	avgEstimatedTokens: number;
	avgToolCalls: number;
	toolFailureRate: number;
} {
	const attempts = input.flatMap(result => result.attempts);
	const toolCalls = attempts.reduce((sum, attempt) => sum + attempt.toolCalls, 0);
	return {
		casesTotal: input.length,
		attemptsTotal: attempts.length,
		caseSuccessRate: pct(input.filter(result => result.success).length, input.length),
		attemptSuccessRate: pct(attempts.filter(attempt => attempt.success).length, attempts.length),
		avgLatencyMs: pct(
			attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
			attempts.length,
		),
		avgEstimatedTokens: pct(
			attempts.reduce((sum, attempt) => sum + attempt.estimatedTokens, 0),
			attempts.length,
		),
		avgToolCalls: pct(toolCalls, attempts.length),
		toolFailureRate: pct(
			attempts.reduce((sum, attempt) => sum + attempt.toolFailures, 0),
			Math.max(toolCalls, attempts.length),
		),
	};
}

const args = parseArgs(process.argv.slice(2));
const datasetPath = path.resolve(args.dataset);
const outDir = path.resolve(args.outDir);
const allCases = (await readJsonl(datasetPath)).map(parseCase);
const suiteFilter = new Set(args.suites);
const cases = args.suites.length === 0 ? allCases : allCases.filter(evalCase => suiteFilter.has(evalCase.suite));
if (cases.length === 0) {
	throw new Error(`No eval cases matched suite filter: ${args.suites.join(", ")}`);
}
const candidateAttempts = args.responses ? (await readJsonl(path.resolve(args.responses))).map(parseAttempt) : [];
const indexedAttempts = indexAttempts(candidateAttempts);
const usingReference = !args.responses;

const scoredCases: ScoredCase[] = cases.map(evalCase => {
	const suppliedByRun = indexedAttempts.get(evalCase.id);
	const suppliedRunCount = suppliedByRun?.size ?? 0;
	const expectedRuns = args.runs ?? Math.max(evalCase.repeat, suppliedRunCount, 1);
	const attempts: ScoredAttempt[] = [];
	for (let run = 1; run <= expectedRuns; run += 1) {
		const supplied = usingReference
			? { caseId: evalCase.id, run, response: evalCase.reference }
			: suppliedByRun?.get(run);
		attempts.push(supplied ? scoreAttempt(evalCase, supplied, run) : missingAttempt(evalCase, run));
	}
	return {
		id: evalCase.id,
		suite: evalCase.suite,
		category: evalCase.category,
		success: attempts.every(attempt => attempt.success),
		attempts,
	};
});

const successfulCases = scoredCases.filter(result => result.success).length;
const repeatConsistentCases = scoredCases.filter(result => {
	const [first, ...rest] = result.attempts;
	return first !== undefined && rest.every(attempt => attempt.success === first.success);
}).length;
const baseSummary = summarizeCases(scoredCases);
const suiteSummaries = [...new Set(scoredCases.map(result => result.suite))].sort().map(suite => ({
	suite,
	summary: summarizeCases(scoredCases.filter(result => result.suite === suite)),
}));
const paceProxy = suiteSummaries.find(entry => entry.suite === "pace-proxy");

const summary = {
	dataset: datasetPath,
	responses: args.responses ? path.resolve(args.responses) : null,
	usingReference,
	suiteFilter: args.suites,
	casesTotal: baseSummary.casesTotal,
	attemptsTotal: baseSummary.attemptsTotal,
	caseSuccessRate: baseSummary.caseSuccessRate,
	attemptSuccessRate: baseSummary.attemptSuccessRate,
	repeatConsistencyRate: pct(repeatConsistentCases, scoredCases.length),
	avgLatencyMs: baseSummary.avgLatencyMs,
	avgEstimatedTokens: baseSummary.avgEstimatedTokens,
	avgToolCalls: baseSummary.avgToolCalls,
	toolFailureRate: baseSummary.toolFailureRate,
	suites: suiteSummaries,
	paceProxyScreen: paceProxy?.summary.caseSuccessRate ?? null,
};

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });
await Bun.write(path.join(outDir, "results.json"), `${JSON.stringify({ summary, cases: scoredCases }, null, "\t")}\n`);
await Bun.write(
	path.join(outDir, "failures.jsonl"),
	`${scoredCases
		.flatMap(result =>
			result.attempts
				.filter(attempt => !attempt.success)
				.map(attempt => JSON.stringify({ caseId: result.id, run: attempt.run, failures: attempt.failures })),
		)
		.join("\n")}\n`,
);

writeStdout(`METRIC cases_total=${summary.casesTotal}`);
writeStdout(`METRIC attempts_total=${summary.attemptsTotal}`);
writeStdout(`METRIC success_rate=${summary.caseSuccessRate.toFixed(6)}`);
writeStdout(`METRIC attempt_success_rate=${summary.attemptSuccessRate.toFixed(6)}`);
writeStdout(`METRIC repeat_consistency_rate=${summary.repeatConsistencyRate.toFixed(6)}`);
writeStdout(`METRIC avg_latency_ms=${summary.avgLatencyMs.toFixed(2)}`);
writeStdout(`METRIC avg_estimated_tokens=${summary.avgEstimatedTokens.toFixed(2)}`);
writeStdout(`METRIC avg_tool_calls=${summary.avgToolCalls.toFixed(2)}`);
writeStdout(`METRIC tool_failure_rate=${summary.toolFailureRate.toFixed(6)}`);
writeStdout(`ASI result_path=${path.join(outDir, "results.json")}`);
for (const { suite, summary: suiteSummary } of suiteSummaries) {
	const metricPrefix = sanitizeMetricName(suite);
	writeStdout(`METRIC ${metricPrefix}_success_rate=${suiteSummary.caseSuccessRate.toFixed(6)}`);
	writeStdout(`METRIC ${metricPrefix}_attempt_success_rate=${suiteSummary.attemptSuccessRate.toFixed(6)}`);
	writeStdout(`METRIC ${metricPrefix}_avg_latency_ms=${suiteSummary.avgLatencyMs.toFixed(2)}`);
	writeStdout(`METRIC ${metricPrefix}_avg_estimated_tokens=${suiteSummary.avgEstimatedTokens.toFixed(2)}`);
	writeStdout(`METRIC ${metricPrefix}_avg_tool_calls=${suiteSummary.avgToolCalls.toFixed(2)}`);
	writeStdout(`METRIC ${metricPrefix}_tool_failure_rate=${suiteSummary.toolFailureRate.toFixed(6)}`);
}
if (paceProxy) {
	writeStdout(`ASI pace_proxy_screen=${paceProxy.summary.caseSuccessRate === 1 ? "pass" : "hold-expensive-runs"}`);
} else {
	writeStdout("ASI pace_proxy_screen=not-run");
}
writeStdout("ASI pace_proxy_note=screening-signal-not-calibrated-agentic-score-prediction");
writeStdout(`ASI failures_path=${path.join(outDir, "failures.jsonl")}`);
writeStdout(`ASI mode=${usingReference ? "reference-self-check" : "candidate-responses"}`);

if (args.json) writeStdout(JSON.stringify(summary, null, "\t"));

if (successfulCases !== cases.length) {
	process.exitCode = 1;
}
