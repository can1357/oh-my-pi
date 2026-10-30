/**
 * One-row block sparklines (`▁▂▃▅▇█`) for ANSI renderers: the usage history
 * in `omp usage`, a job widget's series in the `wait` card and status line.
 */

/** Block glyphs from lowest to highest. */
export const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** How {@link renderSparkline} maps values to glyphs and styles them. */
export interface SparklineOptions {
	/** Domain low end; values at or below it draw the lowest block. Default 0. */
	readonly min?: number;
	/** Domain high end; values at or above it draw the full block. Default the largest value. */
	readonly max?: number;
	/** Styles one glyph; `fraction` is the value's 0–1 position in the domain. */
	readonly style?: (glyph: string, value: number, fraction: number) => string;
	/** What a missing value draws, already styled. Default a space. */
	readonly gap?: string;
}

/** The block glyph for a 0–1 fraction of the domain. */
export function sparkGlyph(fraction: number): string {
	const clamped = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
	return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length))]!;
}

/** One cell per value, oldest first; `undefined` (and non-finite) values draw the gap. */
export function renderSparkline(values: readonly (number | undefined)[], options: SparklineOptions = {}): string {
	const min = options.min ?? 0;
	let max = options.max;
	if (max === undefined) {
		max = min;
		for (const value of values) if (value !== undefined && Number.isFinite(value) && value > max) max = value;
	}
	const span = max - min;
	const gap = options.gap ?? " ";
	let out = "";
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) {
			out += gap;
			continue;
		}
		const fraction = span > 0 ? (value - min) / span : value > min ? 1 : 0;
		const glyph = sparkGlyph(fraction);
		out += options.style ? options.style(glyph, value, Math.min(Math.max(fraction, 0), 1)) : glyph;
	}
	return out;
}

/**
 * `values` squeezed into at most `cells` points by equal-count bucket means,
 * newest bucket last; shorter series come back unchanged.
 */
export function fitSparkValues(values: readonly number[], cells: number): readonly number[] {
	const count = Math.max(0, Math.floor(cells));
	if (values.length <= count) return values;
	const out: number[] = [];
	for (let bucket = 0; bucket < count; bucket++) {
		const from = Math.floor((bucket * values.length) / count);
		const to = Math.max(from + 1, Math.floor(((bucket + 1) * values.length) / count));
		let sum = 0;
		for (let i = from; i < to; i++) sum += values[i]!;
		out.push(sum / (to - from));
	}
	return out;
}

/**
 * The largest value per time bucket over `[sinceMs, nowMs]`, `cells` buckets
 * wide; buckets without a point are `undefined` (a gap in the sparkline).
 */
export function peakBuckets(
	points: Iterable<{ readonly at: number; readonly value: number }>,
	sinceMs: number,
	nowMs: number,
	cells: number,
): (number | undefined)[] {
	const span = Math.max(1, nowMs - sinceMs);
	const count = Math.max(0, Math.floor(cells));
	const buckets: (number | undefined)[] = Array.from({ length: count }, () => undefined);
	if (count === 0) return buckets;
	for (const point of points) {
		const offset = Math.floor(((point.at - sinceMs) / span) * count);
		const index = Math.min(count - 1, Math.max(0, offset));
		const prev = buckets[index];
		buckets[index] = prev === undefined ? point.value : Math.max(prev, point.value);
	}
	return buckets;
}
