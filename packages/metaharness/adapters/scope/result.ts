/**
 * The scope benchmark's `result.json` shape and the markdown views over it: a per-arm report
 * and a two-arm comparison. The metaharness manager reads {@link ScopeResult.summary} for the
 * dashboard (`src/benchmarks.ts`).
 */
import type { CheckCall } from "./checks";

/** Launch settings shared by every run of one arm. */
export interface ScopeConfig {
	/** Arm name used in reports and comparisons. */
	label: string;
	model: string;
	thinking: string | null;
	/** File appended to the system prompt. */
	appendSystemPrompt: string | null;
	/** Handlebars file replacing the system prompt template. */
	systemPromptTemplate: string | null;
	tasks: string[];
	runs: number;
	concurrency: number;
	timeoutSec: number;
}

/** One attempt at one task. */
export interface ScopeRun {
	task: string;
	attempt: number;
	pass: boolean;
	/** Harness, provider, or timeout error: the session did not finish normally. */
	error: string | null;
	/** Why the outcome is wrong: verifier misses and out-of-scope edits. Empty on pass. */
	failures: string[];
	wallMs: number;
	/** Sum of provider request durations. */
	modelMs: number;
	/** Wall time with at least one tool running. */
	toolMs: number;
	turns: number;
	toolCalls: number;
	checks: CheckCall[];
	postEditReads: number;
	/** Workspace-relative files the run added, changed, or deleted. */
	changed: string[];
	/** Changed files outside the task's scope. */
	outOfScope: string[];
	tokens: { input: number; output: number; reasoning: number; cacheRead: number };
	costUsd: number;
	/** ndjson event trace, relative to the job dir. */
	trace: string;
}

/** Aggregates over every finished run; `null` until one finishes. */
export interface ScopeSummary {
	runs: number;
	passRate: number | null;
	medianWallS: number | null;
	medianTurns: number | null;
	unrequestedChecksPerRun: number | null;
	/** Share of all wall time spent inside unrequested checks. */
	unrequestedCheckShare: number | null;
	/** Share of runs that changed a file outside the task's scope. */
	scopeCreepRate: number | null;
	costUsd: number;
	tokIn: number;
	tokOut: number;
}

/** `result.json`: rewritten after every finished run. */
export interface ScopeResult {
	config: ScopeConfig;
	startedAt: string;
	finishedAt: string | null;
	/** Planned runs: tasks × runs per task. */
	total: number;
	runs: ScopeRun[];
	summary: ScopeSummary;
}

/** Per-task (or whole-arm) figures behind one report row. */
interface RunStats {
	runs: number;
	passes: number;
	wallS: number | null;
	modelS: number | null;
	toolS: number | null;
	turns: number | null;
	calls: number | null;
	unrequested: number | null;
	unrequestedS: number | null;
	postEditReads: number | null;
	creep: number;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const seconds = (ms: number | null): number | null => (ms === null ? null : ms / 1000);

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : sum(values) / values.length;
}

function unrequestedChecks(run: ScopeRun): CheckCall[] {
	return run.checks.filter(check => check.unrequested);
}

function stats(runs: readonly ScopeRun[]): RunStats {
	return {
		runs: runs.length,
		passes: runs.filter(run => run.pass).length,
		wallS: seconds(median(runs.map(run => run.wallMs))),
		modelS: seconds(median(runs.map(run => run.modelMs))),
		toolS: seconds(median(runs.map(run => run.toolMs))),
		turns: median(runs.map(run => run.turns)),
		calls: median(runs.map(run => run.toolCalls)),
		unrequested: mean(runs.map(run => unrequestedChecks(run).length)),
		unrequestedS: seconds(mean(runs.map(run => sum(unrequestedChecks(run).map(check => check.ms))))),
		postEditReads: mean(runs.map(run => run.postEditReads)),
		creep: runs.filter(run => run.outOfScope.length > 0).length,
	};
}

/** Recomputes {@link ScopeResult.summary}; the CLI calls it after every run. */
export function summarize(runs: readonly ScopeRun[]): ScopeSummary {
	const all = stats(runs);
	const unrequestedMs = sum(runs.flatMap(run => unrequestedChecks(run).map(check => check.ms)));
	return {
		runs: runs.length,
		passRate: ratio(all.passes, runs.length),
		medianWallS: all.wallS,
		medianTurns: all.turns,
		unrequestedChecksPerRun: all.unrequested,
		unrequestedCheckShare: ratio(unrequestedMs, sum(runs.map(run => run.wallMs))),
		scopeCreepRate: ratio(all.creep, runs.length),
		costUsd: sum(runs.map(run => run.costUsd)),
		tokIn: sum(runs.map(run => run.tokens.input)),
		tokOut: sum(runs.map(run => run.tokens.output)),
	};
}

function fmt(value: number | null, digits = 1): string {
	return value === null ? "—" : value.toFixed(digits);
}

/** Runs grouped by task, in first-seen order, plus the whole arm as `**all**`. */
function rows(runs: readonly ScopeRun[]): Array<[string, RunStats]> {
	const grouped = Map.groupBy(runs, run => run.task);
	return [
		...[...grouped].map(([task, taskRuns]): [string, RunStats] => [task, stats(taskRuns)]),
		["**all**", stats(runs)],
	];
}

/** Markdown report for one arm: per-task medians, then every unrequested check and failure. */
export function renderReport(result: ScopeResult): string {
	const { config } = result;
	const lines = [
		`# Scope benchmark: ${config.label}`,
		"",
		`\`${config.model}\` · thinking \`${config.thinking ?? "default"}\` · append \`${config.appendSystemPrompt ?? "none"}\` · template \`${config.systemPromptTemplate ?? "default"}\` · ${result.runs.length}/${result.total} runs · $${result.summary.costUsd.toFixed(3)}`,
		"",
		"Times and counts are per-run medians; unrequested checks, their seconds, and post-edit reads are per-run means.",
		"",
		"| task | pass | wall s | model s | tool s | turns | tool calls | unrequested checks | unrequested s | post-edit reads | out of scope |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const [task, s] of rows(result.runs)) {
		lines.push(
			`| ${task} | ${s.passes}/${s.runs} | ${fmt(s.wallS)} | ${fmt(s.modelS)} | ${fmt(s.toolS)} | ${fmt(s.turns, 0)} | ${fmt(s.calls, 0)} | ${fmt(s.unrequested)} | ${fmt(s.unrequestedS)} | ${fmt(s.postEditReads)} | ${s.creep}/${s.runs} |`,
		);
	}
	const charged = result.runs.flatMap(run =>
		unrequestedChecks(run).map(
			check =>
				`- \`${run.task}#${run.attempt}\` ${(check.ms / 1000).toFixed(1)}s ${check.kinds.join("+")}: \`${check.command.replaceAll("\n", " ⏎ ")}\``,
		),
	);
	if (charged.length > 0) lines.push("", "## Unrequested checks", "", ...charged);
	const failed = result.runs.filter(run => !run.pass);
	if (failed.length > 0) {
		lines.push(
			"",
			"## Failures",
			"",
			...failed.map(
				run => `- \`${run.task}#${run.attempt}\`: ${[run.error, ...run.failures].filter(Boolean).join("; ")}`,
			),
		);
	}
	return `${lines.join("\n")}\n`;
}

function delta(before: number | null, after: number | null): string {
	if (before === null || after === null || before === 0) return "";
	const change = ((after - before) / before) * 100;
	return ` (${change >= 0 ? "+" : ""}${change.toFixed(0)}%)`;
}

/** Markdown table comparing two arms task by task: `a → b`, with relative change on wall time. */
export function renderComparison(a: ScopeResult, b: ScopeResult): string {
	const left = new Map(rows(a.runs));
	const right = new Map(rows(b.runs));
	const tasks = [...new Set([...left.keys(), ...right.keys()])].filter(task => task !== "**all**");
	const lines = [
		`# ${a.config.label} → ${b.config.label}`,
		"",
		"| task | pass | wall s | turns | tool calls | unrequested checks | unrequested s | post-edit reads | out of scope |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const task of [...tasks, "**all**"]) {
		const x = left.get(task);
		const y = right.get(task);
		const pair = (pick: (s: RunStats) => number | null, digits = 1) =>
			`${fmt(x ? pick(x) : null, digits)} → ${fmt(y ? pick(y) : null, digits)}`;
		lines.push(
			`| ${task} | ${x ? `${x.passes}/${x.runs}` : "—"} → ${y ? `${y.passes}/${y.runs}` : "—"} | ${pair(s => s.wallS)}${delta(x?.wallS ?? null, y?.wallS ?? null)} | ${pair(s => s.turns, 0)} | ${pair(s => s.calls, 0)} | ${pair(s => s.unrequested)} | ${pair(s => s.unrequestedS)} | ${pair(s => s.postEditReads)} | ${x?.creep ?? "—"} → ${y?.creep ?? "—"} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}
