/**
 * Nearest-rank quantile of an ascending-sorted sample: the smallest value with at least `q` of the sample at or below
 * it. `q` is a fraction in [0, 1] and is clamped to the sample; an empty sample gives 0.
 */
export function nearestRank(sorted: ArrayLike<number>, q: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Arithmetic mean; an empty sample gives 0. */
export function mean(values: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += values[i];
	return values.length === 0 ? 0 : sum / values.length;
}
