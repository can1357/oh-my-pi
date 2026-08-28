/**
 * Capability Ranking — memory-informed ordering.
 *
 * Additive, disabled-by-default, SUGGEST-ONLY continuation of
 * `capability-fidelity.ts`. Given an execution-complete bundle and an
 * (optional) tier plan, it orders the bundle's capabilities using injected
 * outcome history — reliability from past success/failure counts plus an
 * optional recency decay — so a later planner can prefer capabilities that
 * have actually worked before.
 *
 * The ordering is a **suggestion**: nothing is added, dropped, or executed.
 * Tier priority is always respected first (a safety-critical L0 item never
 * ranks below a supporting L3 item); memory scores only break ties *within* a
 * tier. This keeps the fidelity safety guarantees intact while letting
 * history inform the order.
 *
 * Scope (this file):
 *   - Deterministic reliability score (Laplace-smoothed success rate).
 *   - Optional recency score (half-life decay, clock injected for determinism).
 *   - Optional co-occurrence affinity bonus (injected matrix).
 *   - Stable ordering: tier priority → score desc → original bundle order.
 * Explicitly NOT here:
 *   - Any execution, planner wiring, or approval routing.
 *   - Any mutation of the bundle, plan, graph, registry, or descriptors.
 *   - Inventing history — stats are injected by the caller, never gathered here.
 *
 * Discipline: pure, suggest-only, disabled-by-default, fail-open, additive.
 * Determinism note: recency is only computed when `recencyWeight > 0`, and it
 * requires the caller to inject `now` — there is no hidden Date.now() fallback.
 */

import type { ExecutionCompleteBundle } from "./capability-bundle";
import type { FidelityPlan, FidelityTier } from "./capability-fidelity";

/** Outcome history for one capability (injected — read, never written). */
export interface CapabilityOutcomeStats {
	successes?: number;
	failures?: number;
	/** Epoch ms of last use; enables the optional recency score. */
	lastUsedTs?: number;
}

export interface RankOptions {
	/** Disabled by default. When false, an inert (empty) ranking is returned. */
	enabled?: boolean;
	/** Outcome history keyed by capability id. */
	history?: Record<string, CapabilityOutcomeStats>;
	/** Optional tier plan; when present, tier priority dominates the order. */
	plan?: FidelityPlan;
	/** Weight of the reliability score. Default: 1. */
	reliabilityWeight?: number;
	/** Weight of the recency score. Default: 0 (opt-in; requires `now`). */
	recencyWeight?: number;
	/** Half-life (ms) for recency decay. Default: 7 days. */
	recencyHalfLifeMs?: number;
	/** Injected clock (epoch ms). REQUIRED for recency to take effect. */
	now?: number;
	/** Co-occurrence affinity matrix: capability -> { [coId]: frequency }. */
	coOccurrenceMap?: Record<string, Record<string, number>>;
	/** Weight of the co-occurrence affinity bonus. Default: 0.2. */
	coOccurrenceWeight?: number;
}

export interface RankedCapability {
	id: string;
	tier: FidelityTier | null;
	score: number;
	reliability: number;
	recency: number;
	reason: string;
}

export interface RankedBundle {
	mode: "suggest";
	enabled: boolean;
	/** Suggested order (best first). Advisory only — nothing is applied. */
	ranking: RankedCapability[];
}

const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_PRIORITY: Record<FidelityTier, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
/** Co-occurrence totals at or above this saturate the affinity bonus at 1. */
const CO_OCCURRENCE_SATURATION = 5;

function inertRanking(): RankedBundle {
	return { mode: "suggest", enabled: false, ranking: [] };
}

/** Laplace-smoothed success rate; neutral 0.5 when there is no history. */
function reliabilityOf(stats: CapabilityOutcomeStats): number {
	const s = Math.max(0, stats.successes ?? 0);
	const f = Math.max(0, stats.failures ?? 0);
	return (s + 1) / (s + f + 2);
}

function recencyOf(stats: CapabilityOutcomeStats, now: number, halfLife: number): number {
	if (typeof stats.lastUsedTs !== "number" || !Number.isFinite(stats.lastUsedTs)) return 0;
	const age = Math.max(0, now - stats.lastUsedTs);
	return 0.5 ** (age / halfLife);
}

/**
 * Rank an execution-complete bundle using injected outcome history.
 * Pure, suggest-only, fail-open. Inert when disabled.
 */
export function rankBundle(bundle: ExecutionCompleteBundle, options: RankOptions = {}): RankedBundle {
	if (options.enabled !== true) return inertRanking();

	try {
		const history = options.history ?? {};
		const wRel = Number.isFinite(options.reliabilityWeight) ? (options.reliabilityWeight as number) : 1;
		const wRec = Number.isFinite(options.recencyWeight) ? (options.recencyWeight as number) : 0;
		const wCo = Number.isFinite(options.coOccurrenceWeight) ? (options.coOccurrenceWeight as number) : 0.2;
		const halfLife =
			Number.isFinite(options.recencyHalfLifeMs) && (options.recencyHalfLifeMs as number) > 0
				? (options.recencyHalfLifeMs as number)
				: DEFAULT_HALF_LIFE_MS;
		// Recency stays 0 without an injected clock: purity over convenience.
		const now = Number.isFinite(options.now) ? (options.now as number) : null;
		const coMap = options.coOccurrenceMap;

		const tierOf = new Map<string, FidelityTier>();
		if (options.plan) {
			for (const a of options.plan.assignments) tierOf.set(a.id, a.tier);
		}

		const includedSet = new Set(bundle.included);

		const ranked: Array<RankedCapability & { order: number }> = bundle.included.map((id, order) => {
			const stats = history[id] ?? {};
			const reliability = reliabilityOf(stats);
			const recency = wRec > 0 && now !== null ? recencyOf(stats, now, halfLife) : 0;

			let coScore = 0;
			const coTarget = coMap?.[id];
			if (coTarget) {
				for (const otherId of includedSet) {
					if (otherId !== id && typeof coTarget[otherId] === "number") {
						coScore += coTarget[otherId];
					}
				}
			}

			const score = wRel * reliability + wRec * recency + wCo * Math.min(1, coScore / CO_OCCURRENCE_SATURATION);
			const tier = tierOf.get(id) ?? null;
			const hasHistory = (stats.successes ?? 0) + (stats.failures ?? 0) > 0;
			const reason = hasHistory
				? `reliability=${reliability.toFixed(3)}${coScore > 0 ? `, coScore=${coScore.toFixed(1)}` : ""}`
				: "no history (neutral prior)";
			return { id, tier, score, reliability, recency, reason, order };
		});

		ranked.sort((a, b) => {
			const ta = a.tier ? TIER_PRIORITY[a.tier] : Number.POSITIVE_INFINITY;
			const tb = b.tier ? TIER_PRIORITY[b.tier] : Number.POSITIVE_INFINITY;
			if (ta !== tb) return ta - tb; // lower tier index = higher priority
			if (b.score !== a.score) return b.score - a.score; // higher score first
			return a.order - b.order; // stable: original bundle order
		});

		return {
			mode: "suggest",
			enabled: true,
			ranking: ranked.map(({ order: _order, ...rest }) => rest),
		};
	} catch {
		return inertRanking();
	}
}
