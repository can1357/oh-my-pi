/**
 * Turn the server's long-format bucket rows (`{ timestamp, key…, value }`)
 * into dense chart series aligned to a bucket axis (see `bucketAxis`).
 */

import type { ChartSeries } from "../charts/types";
import { OTHER_COLOR, SERIES_COLORS } from "./colors";

/** Sum `value(point)` into a dense array aligned to `buckets`. Out-of-axis points are dropped. */
export function densify<P extends { timestamp: number }>(
	points: readonly P[],
	buckets: readonly number[],
	value: (point: P) => number,
): number[] {
	const index = bucketIndex(buckets);
	const out = Array.from({ length: buckets.length }, () => 0);
	for (const point of points) {
		const i = index.get(point.timestamp);
		if (i !== undefined) out[i] += value(point);
	}
	return out;
}

export interface PivotOptions<P> {
	buckets: readonly number[];
	/** Series identity for a row. */
	key: (point: P) => string;
	/** Display label for a series key; defaults to the key. */
	label?: (key: string) => string;
	value: (point: P) => number;
	/** Keep the `limit` largest series (by total); fold the rest into "Other". */
	limit?: number;
	/** Fixed colors per key (e.g. from `buildModelColorLookup`); falls back to rank order. */
	colors?: ReadonlyMap<string, string>;
}

/**
 * Pivot long rows into one dense series per key, ranked by total (largest
 * first). Series beyond `limit` merge into a trailing "Other" series.
 */
export function pivotSeries<P extends { timestamp: number }>(
	points: readonly P[],
	opts: PivotOptions<P>,
): ChartSeries[] {
	const index = bucketIndex(opts.buckets);
	const byKey = new Map<string, number[]>();
	for (const point of points) {
		const i = index.get(point.timestamp);
		if (i === undefined) continue;
		const key = opts.key(point);
		let values = byKey.get(key);
		if (!values) {
			values = Array.from({ length: opts.buckets.length }, () => 0);
			byKey.set(key, values);
		}
		values[i] += opts.value(point);
	}

	const ranked = [...byKey.entries()]
		.map(([key, values]) => ({ key, values, total: values.reduce((sum, v) => sum + v, 0) }))
		.filter(entry => entry.total !== 0)
		.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

	const limit = opts.limit ?? Number.POSITIVE_INFINITY;
	const head = ranked.slice(0, limit);
	const tail = ranked.slice(limit);
	const series: ChartSeries[] = head.map((entry, rank) => ({
		key: entry.key,
		label: opts.label ? opts.label(entry.key) : entry.key,
		color: opts.colors?.get(entry.key) ?? SERIES_COLORS[rank % SERIES_COLORS.length],
		values: entry.values,
	}));
	if (tail.length > 0) {
		const other = Array.from({ length: opts.buckets.length }, () => 0);
		for (const entry of tail) for (let i = 0; i < other.length; i++) other[i] += entry.values[i];
		series.push({ key: "__other__", label: `Other (${tail.length})`, color: OTHER_COLOR, values: other });
	}
	return series;
}

function bucketIndex(buckets: readonly number[]): Map<number, number> {
	const index = new Map<number, number>();
	for (let i = 0; i < buckets.length; i++) index.set(buckets[i], i);
	return index;
}
