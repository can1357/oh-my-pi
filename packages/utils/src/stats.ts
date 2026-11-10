/**
 * Nearest-rank quantile of an ascending-sorted sample: the smallest value with at least `q` of the sample at or below
 * it. `q` is a fraction in [0, 1] and is clamped to the sample; an empty sample gives 0.
 */
export function nearestRank(sorted: ArrayLike<number>, q: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
