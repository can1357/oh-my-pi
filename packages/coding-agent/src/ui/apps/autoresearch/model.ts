/**
 * What the autoresearch dashboard reads: the experiment runtime, plus the
 * derived facts both faces (the native dashboard and the terminal text
 * dashboard) share: status tallies, the best run, the mode line.
 */
import { currentResults } from "../../../autoresearch/results-data";
import { formatNum } from "../../../autoresearch/tool-details";
import type { ExperimentResult, ExperimentState, ExperimentStatus } from "../../../autoresearch/tool-details";
import { isBetter } from "../../../autoresearch/results-data";

/** The experiment runtime the dashboard shows. */
export interface AutoresearchDashboardRuntime {
	autoresearchMode: boolean;
	dashboardExpanded: boolean;
	state: ExperimentState;
	lastRunSummary: { runNumber: number; passed: boolean; parsedPrimary: number | null } | null;
	runningExperiment: { startedAt: number; command: string } | null;
}

/** A run with its position in `state.results`. */
export interface IndexedResult {
	readonly result: ExperimentResult;
	readonly index: number;
}

/** Whether the dashboard has anything to show. */
export function shouldShowDashboard(runtime: AutoresearchDashboardRuntime): boolean {
	return (
		runtime.autoresearchMode ||
		runtime.state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

/** Runs per status. */
export function statusCounts(results: readonly ExperimentResult[]): Record<ExperimentStatus, number> {
	const counts: Record<ExperimentStatus, number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
	for (const result of results) counts[result.status] += 1;
	return counts;
}

/** The best kept run of the current segment (positive metrics only). */
export function findBestResult(state: ExperimentState): IndexedResult | null {
	let best: IndexedResult | null = null;
	state.results.forEach((result, index) => {
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.metric <= 0) return;
		if (!best || isBetter(result.metric, best.result.metric, state.bestDirection)) best = { index, result };
	});
	return best;
}

/** Runs of the current segment, with their positions. */
export function segmentRuns(state: ExperimentState): IndexedResult[] {
	return state.results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => result.segment === state.currentSegment);
}

/** The run number a result shows (legacy results count by position). */
export function runNumberOf(entry: IndexedResult): number {
	return entry.result.runNumber ?? entry.index + 1;
}

/** `mode on`, `baseline pending`, `segment complete` or `mode off`. */
export function modeStatus(runtime: AutoresearchDashboardRuntime): string {
	const state = runtime.state;
	if (runtime.autoresearchMode) return state.results.length === 0 ? "baseline pending" : "mode on";
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) return "segment complete";
	return "mode off";
}

/** Theme color of a confidence multiple. */
export function confidenceToken(confidence: number): string {
	return confidence >= 2 ? "success" : confidence >= 1 ? "warning" : "error";
}

/** ` +12.9%` style change from `baseline`, or "" when there is nothing to compare. */
function signedChange(value: number, baseline: number | undefined): string {
	if (baseline === undefined || baseline === 0 || baseline === value) return "";
	const delta = ((value - baseline) / baseline) * 100;
	return ` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

/** A secondary metric cell: the value with its change from the baseline (`-` when unmeasured). */
export function secondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	return `${formatNum(value, unit)}${signedChange(value, baseline)}`;
}

/** `name value change` of a secondary metric at the best run, or null when unmeasured. */
export function secondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	return `${name} ${formatNum(value, unit)}${signedChange(value, baseline)}`;
}

/** Signed change from `base` to `value` in percent with a true minus (`−12.4%`), or null. */
export function percentChange(value: number, base: number | null | undefined): string | null {
	if (base === null || base === undefined || base === 0 || value === base) return null;
	const delta = ((value - base) / base) * 100;
	return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%`;
}

/** Fraction digits (0–2) that show every value exactly, so numbers that sit together align. */
export function fractionDigits(values: readonly number[]): number {
	let digits = 0;
	for (const value of values) {
		while (digits < 2 && Math.abs(Math.round(value * 10 ** digits) - value * 10 ** digits) > 1e-6) digits += 1;
	}
	return digits;
}
