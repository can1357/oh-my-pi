/**
 * The scope benchmark's `result.json` shape and the markdown views over it: a per-arm report
 * and a two-arm comparison. The metaharness manager reads {@link ScopeResult.summary} for the
 * dashboard (`src/benchmarks.ts`). An arm meets the goal when every change is `verified`, no
 * check runs `during` the work, and check seconds stay low at an unchanged pass rate.
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
	/** JSON file of `{ find, replace }` pairs applied to the rendered prompt. Absent in results written before the flag existed. */
	rewrite?: string | null;
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
	/** A check ran after the last edit; `null` when the run changed no file. */
	verified: boolean | null;
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
	/** Of the runs that changed files, the share that ran a check after their last edit. */
	verifiedRate: number | null;
	/** Checks per run ahead of the first edit (or with nothing changed): reproducing a reported failure. */
	checksBeforePerRun: number | null;
	/** Checks per run after the first edit that were not the final verification: the check-edit-check loop. */
	checksDuringPerRun: number | null;
	/** Seconds per run inside checks of either phase. */
	checkSecondsPerRun: number | null;
	/** Share of all wall time spent inside checks. */
	checkShare: number | null;
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
	/** Runs that changed files, and how many of those ran a final check. */
	changed: number;
	verified: number;
	before: number | null;
	during: number | null;
	final: number | null;
	checkS: number | null;
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

/** Checks that were not the final verification. */
function earlyChecks(run: ScopeRun): CheckCall[] {
	return run.checks.filter(check => check.phase !== "final");
}

function phaseMean(runs: readonly ScopeRun[], phase: CheckCall["phase"]): number | null {
	return mean(runs.map(run => run.checks.filter(check => check.phase === phase).length));
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
		changed: runs.filter(run => run.verified !== null).length,
		verified: runs.filter(run => run.verified === true).length,
		before: phaseMean(runs, "before"),
		during: phaseMean(runs, "during"),
		final: phaseMean(runs, "final"),
		checkS: seconds(mean(runs.map(run => sum(run.checks.map(check => check.ms))))),
		postEditReads: mean(runs.map(run => run.postEditReads)),
		creep: runs.filter(run => run.outOfScope.length > 0).length,
	};
}

/** Recomputes {@link ScopeResult.summary}; the CLI calls it after every run. */
export function summarize(runs: readonly ScopeRun[]): ScopeSummary {
	const all = stats(runs);
	const checkMs = sum(runs.flatMap(run => run.checks.map(check => check.ms)));
	return {
		runs: runs.length,
		passRate: ratio(all.passes, runs.length),
		medianWallS: all.wallS,
		medianTurns: all.turns,
		verifiedRate: ratio(all.verified, all.changed),
		checksBeforePerRun: all.before,
		checksDuringPerRun: all.during,
		checkSecondsPerRun: all.checkS,
		checkShare: ratio(checkMs, sum(runs.map(run => run.wallMs))),
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

/** `verified/changed`, or `—` when no run changed files. */
function verifiedCell(s: RunStats | undefined): string {
	return s && s.changed > 0 ? `${s.verified}/${s.changed}` : "—";
}

/** Markdown report for one arm: per-task figures, then every check that was not a final verification, unverified change, and failure. */
export function renderReport(result: ScopeResult): string {
	const { config } = result;
	const lines = [
		`# Scope benchmark: ${config.label}`,
		"",
		`\`${config.model}\` · thinking \`${config.thinking ?? "default"}\` · append \`${config.appendSystemPrompt ?? "none"}\` · template \`${config.systemPromptTemplate ?? "default"}\` · rewrite \`${config.rewrite ?? "none"}\` · ${result.runs.length}/${result.total} runs · $${result.summary.costUsd.toFixed(3)}`,
		"",
		"Goal: work statically, then verify the change once before yielding. `verified` = runs with a check after their last edit ÷ runs that changed files. Checks `before` ran ahead of the first edit (or with nothing changed); checks `during` ran after it without being the final verification. Times, turns, and tool calls are per-run medians; check counts, check seconds, and post-edit reads are per-run means.",
		"",
		"| task | pass | verified | wall s | model s | tool s | turns | tool calls | checks before | checks during | final checks | check s | post-edit reads | out of scope |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const [task, s] of rows(result.runs)) {
		lines.push(
			`| ${task} | ${s.passes}/${s.runs} | ${verifiedCell(s)} | ${fmt(s.wallS)} | ${fmt(s.modelS)} | ${fmt(s.toolS)} | ${fmt(s.turns, 0)} | ${fmt(s.calls, 0)} | ${fmt(s.before)} | ${fmt(s.during)} | ${fmt(s.final)} | ${fmt(s.checkS)} | ${fmt(s.postEditReads)} | ${s.creep}/${s.runs} |`,
		);
	}
	const early = result.runs.flatMap(run =>
		earlyChecks(run).map(
			check =>
				`- \`${run.task}#${run.attempt}\` ${check.phase} ${(check.ms / 1000).toFixed(1)}s ${check.kinds.join("+")}: \`${check.command.replaceAll("\n", " ⏎ ")}\``,
		),
	);
	if (early.length > 0) lines.push("", "## Checks before the last edit", "", ...early);
	const unverified = result.runs.filter(run => run.verified === false);
	if (unverified.length > 0) {
		lines.push(
			"",
			"## Unverified changes",
			"",
			...unverified.map(run => `- \`${run.task}#${run.attempt}\`: ${run.changed.join(", ")}`),
		);
	}
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
		"| task | pass | verified | wall s | turns | checks before | checks during | final checks | check s | post-edit reads | out of scope |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const task of [...tasks, "**all**"]) {
		const x = left.get(task);
		const y = right.get(task);
		const pair = (pick: (s: RunStats) => number | null, digits = 1) =>
			`${fmt(x ? pick(x) : null, digits)} → ${fmt(y ? pick(y) : null, digits)}`;
		lines.push(
			`| ${task} | ${x ? `${x.passes}/${x.runs}` : "—"} → ${y ? `${y.passes}/${y.runs}` : "—"} | ${verifiedCell(x)} → ${verifiedCell(y)} | ${pair(s => s.wallS)}${delta(x?.wallS ?? null, y?.wallS ?? null)} | ${pair(s => s.turns, 0)} | ${pair(s => s.before)} | ${pair(s => s.during)} | ${pair(s => s.final)} | ${pair(s => s.checkS)} | ${pair(s => s.postEditReads)} | ${x?.creep ?? "—"} → ${y?.creep ?? "—"} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}
