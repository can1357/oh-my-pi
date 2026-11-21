/**
 * Turn the server's long-format bucket rows (`{ timestamp, key…, value }`)
 * into dense chart series aligned to a bucket axis (see `bucketAxis`).
 */

import type { ChartSeries } from "../charts/types";
import { OTHER_COLOR, SERIES_COLORS } from "./colors";

/**
 * Index of the last bucket starting at or before `timestamp`, or -1 before the
 * axis. Matching by floor instead of exact key keeps data visible when the
 * server's day buckets start at a different midnight than the browser's axis
 * (the two run in different timezones): the day shifts rather than vanishing.
 */
export function bucketAt(buckets: readonly number[], timestamp: number): number {
	let lo = 0;
	let hi = buckets.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (buckets[mid] <= timestamp) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/**
 * Sum `value(point)` into a dense array aligned to `buckets`. Points before
 * the first bucket are dropped; points after the last bucket start land in the
 * last bucket.
 */
export function densify<P extends { timestamp: number }>(
	points: readonly P[],
	buckets: readonly number[],
	value: (point: P) => number,
): number[] {
	const out = Array.from({ length: buckets.length }, () => 0);
	for (const point of points) {
		const i = bucketAt(buckets, point.timestamp);
		if (i >= 0) out[i] += value(point);
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
 * first). Series beyond `limit` merge into a trailing "Other" series. Points
 * are placed like `densify`: dropped before the axis, last bucket after it.
 */
export function pivotSeries<P extends { timestamp: number }>(
	points: readonly P[],
	opts: PivotOptions<P>,
): ChartSeries[] {
	const byKey = new Map<string, number[]>();
	for (const point of points) {
		const i = bucketAt(opts.buckets, point.timestamp);
		if (i < 0) continue;
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
