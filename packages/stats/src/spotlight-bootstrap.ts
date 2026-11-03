/**
 * Seeded session-clustered bootstrap for the Spotlight dashboard's estimates: 1000 resamples (seeded per key, so
 * every request returns the same interval), 5th and 95th percentiles, no interval under 3 sessions.
 */

import type { SpotlightEstimate } from "./shared-types";

const BOOTSTRAP_RESAMPLES = 1000;
/** Fewest sessions an interval is drawn from. */
export const BOOTSTRAP_MIN_SESSIONS = 3;

/** mulberry32: a small seeded PRNG, so intervals are identical across requests. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Linear-interpolated quantile `p` of ascending `sorted` (non-empty). */
export function quantile(sorted: ArrayLike<number>, p: number): number {
	const at = (sorted.length - 1) * p;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * The 90% interval of a statistic over seeded resamples: `resample` draws its own resample of the sessions with
 * `random` (uniform in [0, 1)) and returns the statistic, or null when the resample cannot define it.
 */
export function bootstrapInterval(
	key: string,
	resample: (random: () => number) => number | null,
): Pick<SpotlightEstimate, "lo" | "hi"> {
	const random = seededRandom(Bun.hash.crc32(key));
	const samples: number[] = [];
	for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
		const sample = resample(random);
		if (sample !== null && Number.isFinite(sample)) samples.push(sample);
	}
	return percentileInterval(samples);
}

/** 5th and 95th percentiles of bootstrap samples (sorted in place); null without any. */
export function percentileInterval(samples: number[] | Float64Array): Pick<SpotlightEstimate, "lo" | "hi"> {
	if (samples.length === 0) return { lo: null, hi: null };
	samples.sort((a, b) => a - b);
	return { lo: quantile(samples, 0.05), hi: quantile(samples, 0.95) };
}

/**
 * A joint bootstrap: one array of {@link BOOTSTRAP_RESAMPLES} seeded resample rounds that several statistics share.
 * `round` draws one resample with `random` and stores each statistic of it at index `r` of that statistic's array
 * (made by {@link jointSamples}); {@link percentileInterval} then turns every array into its interval. One pass
 * replaces a {@link bootstrapInterval} per statistic.
 */
export function bootstrapRounds(key: string, round: (random: () => number, r: number) => void): void {
	const random = seededRandom(Bun.hash.crc32(key));
	for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) round(random, r);
}

/** One statistic's samples for {@link bootstrapRounds}. */
export function jointSamples(): Float64Array {
	return new Float64Array(BOOTSTRAP_RESAMPLES);
}

/**
 * The means of seeded resamples of `values` (one per bootstrap round, in round order), so statistics of several
 * groups can be combined round by round.
 */
export function resampledMeans(values: readonly number[], key: string): Float64Array {
	const random = seededRandom(Bun.hash.crc32(key));
	const means = new Float64Array(BOOTSTRAP_RESAMPLES);
	for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
		let sum = 0;
		for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
		means[r] = sum / values.length;
	}
	return means;
}

/** Ratio of sums over sessions (`[numerator, denominator]` per session) with its bootstrap interval. */
export function bootstrapRatio(pairs: readonly (readonly [number, number])[], key: string): SpotlightEstimate {
	let num = 0;
	let den = 0;
	for (const [a, b] of pairs) {
		num += a;
		den += b;
	}
	const value = pairs.length > 0 && den > 0 ? num / den : null;
	if (value === null || pairs.length < BOOTSTRAP_MIN_SESSIONS) return { value, lo: null, hi: null };
	return {
		value,
		...bootstrapInterval(key, random => {
			let sampleNum = 0;
			let sampleDen = 0;
			for (let i = 0; i < pairs.length; i++) {
				const [a, b] = pairs[Math.floor(random() * pairs.length)];
				sampleNum += a;
				sampleDen += b;
			}
			return sampleDen > 0 ? sampleNum / sampleDen : null;
		}),
	};
}
