import type { ExperimentResult, MetricDef, MetricDirection, NumericMetricMap } from "../tools/autoresearch";

/** Format an experiment duration for display. */
export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

/** Compare metrics using the configured optimization direction. */
export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

/** Select results belonging to the active experiment segment. */
export function currentResults(results: ExperimentResult[], segment: number): ExperimentResult[] {
	return results.filter(result => result.segment === segment);
}

/** Find the first unflagged kept experiment in a segment. */
export function findBaselineResult(results: ExperimentResult[], segment: number): ExperimentResult | null {
	return currentResults(results, segment).find(result => result.status === "keep" && !result.flagged) ?? null;
}

/** Read the baseline primary metric for a segment. */
export function findBaselineMetric(results: ExperimentResult[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline ? baseline.metric : null;
}

/** Resolve a baseline run number, including legacy unnumbered results. */
export function findBaselineRunNumber(results: ExperimentResult[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	if (!baseline) return null;
	if (baseline.runNumber !== null) return baseline.runNumber;
	const index = results.indexOf(baseline);
	return index >= 0 ? index + 1 : null;
}

/** Collect secondary baselines from the earliest unflagged metric samples. */
export function findBaselineSecondary(
	results: ExperimentResult[],
	segment: number,
	knownMetrics: MetricDef[],
): NumericMetricMap {
	const baseline = findBaselineResult(results, segment);
	const values: NumericMetricMap = baseline ? { ...baseline.metrics } : {};
	for (const metric of knownMetrics) {
		if (values[metric.name] !== undefined) continue;
		for (const result of currentResults(results, segment)) {
			if (result.flagged) continue;
			const value = result.metrics[metric.name];
			if (value !== undefined) {
				values[metric.name] = value;
				break;
			}
		}
	}
	return values;
}
