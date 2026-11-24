import type { TruncationResult } from "../tools/streaming-output";

/** Whether a lower or higher metric is better. */
export type MetricDirection = "lower" | "higher";

/** Disposition of a completed experiment. */
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

/** JSON-compatible additional structured experiment information. */
export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

/** Named structured experiment observations. */
export interface ASIData {
	[key: string]: ASIValue;
}

/** Numeric metrics indexed by name. */
export interface NumericMetricMap {
	[key: string]: number;
}

/** Name and unit of an experiment metric. */
export interface MetricDef {
	name: string;
	unit: string;
}

/** Recorded metric and disposition of an experiment run. */
export interface ExperimentResult {
	runNumber: number | null;
	commit: string;
	metric: number;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
}

/** Current experiment baseline, history, and scope. */
export interface ExperimentState {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
	sessionId: number | null;
}

/** Live elapsed time and output metadata of a benchmark. */
export interface RunExperimentProgressDetails {
	phase: "running";
	elapsed: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	runDirectory?: string;
}

/** Completed benchmark measurements, status, and output. */
export interface RunDetails {
	runNumber: number;
	runDirectory: string;
	benchmarkLogPath: string;
	command: string;
	exitCode: number | null;
	durationSeconds: number;
	passed: boolean;
	crashed: boolean;
	timedOut: boolean;
	tailOutput: string;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	parsedAsi: ASIData | null;
	metricName: string;
	metricUnit: string;
	preRunDirtyPaths: string[];
	abandonedPriorRun: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Logged experiment result and updated baseline state. */
export interface LogDetails {
	experiment: ExperimentResult;
	state: ExperimentState;
	wallClockSeconds: number | null;
	scopeDeviations: string[];
	justification: string | null;
	flaggedRuns: Array<{ runId: number; reason: string }>;
}

/** Format an integer with comma-separated digit groups. */
export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

/** Format a number with grouped digits and optional decimals. */
export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

/** Format an optional metric value with its unit. */
export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

/** Filename of the benchmark harness. */
export const HARNESS_FILENAME = "autoresearch.sh";

/** Default command that executes the benchmark harness. */
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;

/** Initialization outcome and experiment state. */
export interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

/** Persisted experiment notes after an update. */
export interface UpdateNotesDetails {
	notes: string;
}
