/** Paired cluster bootstrap over per-question scores and the helps/hurts/neutral decision rule. */

export interface BootstrapResult {
	meanDiff: number;
	ciLow: number;
	ciHigh: number;
	wins: number;
	ties: number;
	losses: number;
}

export function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Differences are b − a. `clusters[i]` names the case question i was asked against: its questions share one memory
 * store, so each resample draws whole clusters with replacement and pools their questions (sum of differences over
 * question count). With one question per cluster this is the plain per-question bootstrap.
 */
export function pairedBootstrap(
	a: readonly number[],
	b: readonly number[],
	clusters: readonly string[],
	options: { resamples?: number; seed?: number } = {},
): BootstrapResult {
	if (a.length !== b.length || clusters.length !== a.length) {
		throw new Error(`pairedBootstrap: length mismatch ${a.length} vs ${b.length} vs ${clusters.length} clusters`);
	}
	const { resamples = 10000, seed = 1 } = options;
	const diffs = a.map((x, i) => b[i] - x);
	const n = diffs.length;
	if (n === 0) return { meanDiff: 0, ciLow: 0, ciHigh: 0, wins: 0, ties: 0, losses: 0 };
	const totals = new Map<string, { sum: number; count: number }>();
	for (const [i, d] of diffs.entries()) {
		const total = totals.get(clusters[i]);
		if (total) {
			total.sum += d;
			total.count++;
		} else totals.set(clusters[i], { sum: d, count: 1 });
	}
	const groups = [...totals.values()];
	const m = groups.length;
	const rand = mulberry32(seed);
	const means = new Float64Array(resamples);
	for (let r = 0; r < resamples; r++) {
		let sum = 0;
		let count = 0;
		for (let i = 0; i < m; i++) {
			const group = groups[Math.floor(rand() * m)];
			sum += group.sum;
			count += group.count;
		}
		means[r] = sum / count;
	}
	means.sort();
	// Percentile rule: index floor(p * resamples), clamped to the last element; p = 0.025 and 0.975.
	const at = (p: number): number => means[Math.min(resamples - 1, Math.floor(p * resamples))];
	return {
		meanDiff: diffs.reduce((s, d) => s + d, 0) / n,
		ciLow: at(0.025),
		ciHigh: at(0.975),
		wins: diffs.filter(d => d > 0).length,
		ties: diffs.filter(d => d === 0).length,
		losses: diffs.filter(d => d < 0).length,
	};
}

/** helps: overall CI above 0 and no category CI wholly below 0; hurts is the mirror; otherwise neutral. */
export function verdict(
	overall: BootstrapResult,
	perCategory: Record<string, BootstrapResult>,
): "helps" | "hurts" | "neutral" {
	const cats = Object.values(perCategory);
	if (overall.ciLow > 0 && !cats.some(c => c.ciHigh < 0)) return "helps";
	if (overall.ciHigh < 0 && !cats.some(c => c.ciLow > 0)) return "hurts";
	return "neutral";
}
