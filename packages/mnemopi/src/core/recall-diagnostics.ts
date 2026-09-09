export const RECALL_TIERS = ["wm_fts", "wm_vec", "wm_fallback", "em_fts", "em_vec", "em_fallback"] as const;

export type RecallTier = (typeof RECALL_TIERS)[number];

export interface TierStatsSnapshot {
	readonly calls_with_hits: number;
	readonly total_hits: number;
}

export interface RecallDiagnosticsSnapshot {
	readonly created_at: string;
	readonly snapshot_at: string;
	readonly totals: {
		readonly calls: number;
		readonly calls_using_wm_fallback: number;
		readonly calls_using_em_fallback: number;
		readonly calls_truly_empty: number;
		readonly wm_fallback_rate: number;
		readonly em_fallback_rate: number;
	};
	readonly by_tier: Record<RecallTier, TierStatsSnapshot>;
}

interface TierStats {
	callsWithHits: number;
	totalHits: number;
}

function newTierStats(): Record<RecallTier, TierStats> {
	return {
		wm_fts: { callsWithHits: 0, totalHits: 0 },
		wm_vec: { callsWithHits: 0, totalHits: 0 },
		wm_fallback: { callsWithHits: 0, totalHits: 0 },
		em_fts: { callsWithHits: 0, totalHits: 0 },
		em_vec: { callsWithHits: 0, totalHits: 0 },
		em_fallback: { callsWithHits: 0, totalHits: 0 },
	};
}

function isRecallTier(tier: string): tier is RecallTier {
	return (RECALL_TIERS as readonly string[]).includes(tier);
}

export class RecallDiagnostics {
	private tierStats: Record<RecallTier, TierStats>;
	private totalCalls: number;
	private callsUsingWmFallback: number;
	private callsUsingEmFallback: number;
	private callsTrulyEmpty: number;
	private createdAt: string;

	constructor() {
		this.tierStats = newTierStats();
		this.totalCalls = 0;
		this.callsUsingWmFallback = 0;
		this.callsUsingEmFallback = 0;
		this.callsTrulyEmpty = 0;
		this.createdAt = new Date().toISOString();
	}

	private static validateTier(tier: string): asserts tier is RecallTier {
		if (!isRecallTier(tier)) {
			throw new Error(`unknown recall tier ${JSON.stringify(tier)}; valid tiers: ${JSON.stringify(RECALL_TIERS)}`);
		}
	}

	recordTierHits(tier: RecallTier | string, hitCount: number): void {
		RecallDiagnostics.validateTier(tier);
		if (hitCount < 0) throw new Error(`hit_count must be >= 0, got ${hitCount}`);
		const stats = this.tierStats[tier];
		if (hitCount > 0) stats.callsWithHits++;
		stats.totalHits += hitCount;
	}
	recordFallbackUsed(options: { readonly wm?: boolean; readonly em?: boolean } = {}): void {
		if (options.wm === true) this.callsUsingWmFallback++;
		if (options.em === true) this.callsUsingEmFallback++;
	}
	recordCall(options: { readonly trulyEmpty?: boolean; readonly truly_empty?: boolean } = {}): void {
		this.totalCalls++;
		if (options.trulyEmpty === true || options.truly_empty === true) this.callsTrulyEmpty++;
	}
	fallbackRate(): { readonly wm: number; readonly em: number } {
		if (this.totalCalls === 0) return { wm: 0.0, em: 0.0 };
		return {
			wm: Math.min(1.0, this.callsUsingWmFallback / this.totalCalls),
			em: Math.min(1.0, this.callsUsingEmFallback / this.totalCalls),
		};
	}
	snapshot(): RecallDiagnosticsSnapshot {
		const rates = this.fallbackRate();
		const byTier = {} as Record<RecallTier, TierStatsSnapshot>;
		for (const tier of RECALL_TIERS) {
			const stats = this.tierStats[tier];
			byTier[tier] = {
				calls_with_hits: stats.callsWithHits,
				total_hits: stats.totalHits,
			};
		}
		return {
			created_at: this.createdAt,
			snapshot_at: new Date().toISOString(),
			totals: {
				calls: this.totalCalls,
				calls_using_wm_fallback: this.callsUsingWmFallback,
				calls_using_em_fallback: this.callsUsingEmFallback,
				calls_truly_empty: this.callsTrulyEmpty,
				wm_fallback_rate: rates.wm,
				em_fallback_rate: rates.em,
			},
			by_tier: byTier,
		};
	}

	reset(): void {
		this.tierStats = newTierStats();
		this.totalCalls = 0;
		this.callsUsingWmFallback = 0;
		this.callsUsingEmFallback = 0;
		this.callsTrulyEmpty = 0;
		this.createdAt = new Date().toISOString();
	}
}

let singleton: RecallDiagnostics | undefined;

export function getDiagnostics(): RecallDiagnostics {
	if (singleton === undefined) singleton = new RecallDiagnostics();
	return singleton;
}
export function getRecallDiagnostics(): RecallDiagnosticsSnapshot {
	return getDiagnostics().snapshot();
}
export function resetRecallDiagnostics(): void {
	getDiagnostics().reset();
}
export function explainRecallDiagnostics(snapshot: RecallDiagnosticsSnapshot): string[] {
	const explanations: string[] = [];
	const totals = snapshot.totals;
	if (totals.calls === 0) {
		explanations.push("No recall calls have been recorded in this measurement window.");
		return explanations;
	}
	explanations.push(
		`WM fallback used on ${totals.calls_using_wm_fallback}/${totals.calls} calls (${(totals.wm_fallback_rate * 100).toFixed(1)}%).`,
	);
	explanations.push(
		`EM fallback used on ${totals.calls_using_em_fallback}/${totals.calls} calls (${(totals.em_fallback_rate * 100).toFixed(1)}%).`,
	);
	for (const tier of RECALL_TIERS) {
		const stats = snapshot.by_tier[tier];
		explanations.push(`${tier}: ${stats.total_hits} kept hits across ${stats.calls_with_hits} calls with hits.`);
	}
	if (totals.calls_truly_empty > 0) {
		explanations.push(`${totals.calls_truly_empty} calls returned no kept results from any attributed recall path.`);
	}
	return explanations;
}
