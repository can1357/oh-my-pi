/**
 * Adaptive-Fidelity Context State (ACF lane).
 *
 * A bounded, compressed "working memory" projection. Given a set of candidate
 * context items (each with a token cost and a few salience signals), it admits
 * them under a HARD token budget and labels each one:
 *   - "full"       — carried at full fidelity (exact),
 *   - "summarized" — carried compacted (cheaper token cost),
 *   - "evicted"    — not carried in the bounded state this turn.
 * It then exposes a compact `currentFidelityState()` view (the carried ids
 * plus "expansion handles" — the summarized/evicted ids that can be
 * re-hydrated from canonical storage on demand).
 *
 * Discipline (matches the rest of the memory-fabric lanes):
 *   - OBSERVE-ONLY: produces a projection. It never deletes, mutates or
 *     reorders canonical data. "evicted"/"summarized" describe how a *copy*
 *     would be carried; the caller's canonical stores keep exact evidence and
 *     can always expand a handle back to full fidelity.
 *   - DISABLED-BY-DEFAULT: returns an inert empty state unless
 *     `options.enabled === true`.
 *   - FAIL-OPEN: never throws; any error degrades to the inert state.
 *   - SAFETY OVER EFFICIENCY: `protected` items are NEVER evicted and NEVER
 *     summarized. If protected items alone exceed the budget the state is
 *     flagged `overBudget` — we keep safety-critical context rather than
 *     drop it to satisfy a number.
 *   - DETERMINISTIC: ordering is salience-desc then id-asc; recency uses an
 *     injected monotonic `recencySeq` — no clocks, no randomness. Same input
 *     always yields the same state.
 *   - Imports NOTHING; additive (not wired into any index).
 */

/** How a carried item is represented in the bounded state. */
export type AdaptiveFidelityTier = "full" | "summarized" | "evicted";

/** A candidate context item offered to the bounded working set. */
export interface FidelityInputItem {
	/** Stable identifier (used for tie-breaks and as an expansion handle). */
	id: string;
	/** Token cost to carry this item at full fidelity (> 0). */
	tokens: number;
	/**
	 * Token cost when summarized. Defaults to `ceil(tokens * summaryRatio)`.
	 * Ignored for `protected` items (they are always carried at full cost).
	 */
	summaryTokens?: number;
	/** Safety-critical. Never evicted, never summarized. */
	protected?: boolean;
	/** 0..1 — authority / verification level. */
	authority?: number;
	/** 0..1 — safety value of this item. */
	safety?: number;
	/** 0..1 — relevance to the current task. */
	relevance?: number;
	/** 0..1 — historical utility of this item. */
	utility?: number;
	/** Injected monotonic recency sequence (higher = more recent). No clock. */
	recencySeq?: number;
	/** How many times this item is referenced (bounded, normalized to 5). */
	references?: number;
	/** True when the item is involved in a contradiction (raises salience). */
	contradiction?: boolean;
	/** True when provenance is complete (small salience bonus). */
	provenanceComplete?: boolean;
}

/** A scored, placed entry in the bounded state. */
export interface FidelityEntry {
	id: string;
	tier: AdaptiveFidelityTier;
	/** Deterministic salience in [0, 1]. */
	salience: number;
	/** Tokens this entry actually costs in the bounded state (0 when evicted). */
	cost: number;
	/** True for protected items. */
	protected: boolean;
}

export interface AdaptiveFidelityStateOptions {
	/** Disabled by default. When not true an inert empty state is returned. */
	enabled?: boolean;
	/** Hard token budget for the bounded state. Default 4000. */
	budget?: number;
	/** Summary cost ratio when `summaryTokens` is not given. Default 0.35. */
	summaryRatio?: number;
	/** Cap on eligible *ordinary* items considered (highest-salience kept). Default 256. */
	maxItems?: number;
}

export interface AdaptiveFidelityState {
	mode: "observe";
	enabled: boolean;
	/** The hard budget the state was planned against. */
	budget: number;
	/** Tokens actually used by carried (full + summarized) items. */
	used: number;
	/** Every placed entry, ordered salience-desc then id-asc. */
	entries: FidelityEntry[];
	/** Ids carried at full fidelity (sorted). */
	full: string[];
	/** Ids carried summarized (sorted). */
	summarized: string[];
	/** Ids not carried this turn (sorted). These remain in canonical storage. */
	evicted: string[];
	/**
	 * Fraction of eligible items carried at full fidelity:
	 * full / (full + summarized + evicted). 0 when there are no items.
	 */
	firingRate: number;
	/** True when anything was summarized or evicted, or the budget overflowed. */
	truncated: boolean;
	/** True when protected items alone pushed `used` past `budget`. */
	overBudget: boolean;
}

/** The compact downstream-facing view consumers should read. */
export interface CurrentFidelityState {
	/** Ids carried in the bounded state right now (full + summarized, sorted). */
	carried: string[];
	/** Ids that are summarized — expand from canonical storage for full detail. */
	expandHandles: string[];
	/** Ids evicted this turn — also re-hydratable from canonical storage. */
	evictedHandles: string[];
	/** Tokens used by the carried state. */
	used: number;
	/** The hard budget. */
	budget: number;
}

const DEFAULT_BUDGET = 4000;
const DEFAULT_SUMMARY_RATIO = 0.35;
const DEFAULT_MAX_ITEMS = 256;

// Deterministic salience weights. Base weights sum to 1.0; contradiction is an
// additive bonus applied before a final clamp to [0, 1].
const W_SAFETY = 0.3;
const W_AUTHORITY = 0.22;
const W_RELEVANCE = 0.2;
const W_UTILITY = 0.12;
const W_RECENCY = 0.08;
const W_REFERENCES = 0.05;
const W_PROVENANCE = 0.03;
const CONTRADICTION_BONUS = 0.1;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function unit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function inert(): AdaptiveFidelityState {
	return {
		mode: "observe",
		enabled: false,
		budget: 0,
		used: 0,
		entries: [],
		full: [],
		summarized: [],
		evicted: [],
		firingRate: 0,
		truncated: false,
		overBudget: false,
	};
}

/** Cost to carry an item when summarized (never cheaper-than-1, never > full). */
function summaryCost(item: FidelityInputItem, fullCost: number, ratio: number): number {
	const explicit =
		typeof item.summaryTokens === "number" && Number.isFinite(item.summaryTokens)
			? Math.floor(item.summaryTokens)
			: Math.ceil(fullCost * ratio);
	const bounded = Math.max(1, explicit);
	return Math.min(bounded, fullCost);
}

/**
 * Compute the deterministic salience of an item in [0, 1]. `maxRecency` is the
 * largest `recencySeq` seen this call, used to normalize recency without a
 * clock. Protected items are pinned to 1 so they always sort first.
 */
function salienceOf(item: FidelityInputItem, maxRecency: number): number {
	if (item.protected === true) return 1;
	const recency = maxRecency > 0 ? unit((item.recencySeq ?? 0) / maxRecency) : 0;
	const references = unit(Math.min(item.references ?? 0, 5) / 5);
	let score =
		W_SAFETY * unit(item.safety) +
		W_AUTHORITY * unit(item.authority) +
		W_RELEVANCE * unit(item.relevance) +
		W_UTILITY * unit(item.utility) +
		W_RECENCY * recency +
		W_REFERENCES * references +
		W_PROVENANCE * (item.provenanceComplete === true ? 1 : 0);
	if (item.contradiction === true) score += CONTRADICTION_BONUS;
	return unit(score);
}

/**
 * Plan a bounded adaptive-fidelity working set from candidate context items.
 * Observe-only, disabled-by-default, fail-open, deterministic. Selects nothing
 * for real and never mutates canonical data.
 */
export function planAdaptiveFidelityState(
	items: FidelityInputItem[],
	options: AdaptiveFidelityStateOptions = {},
): AdaptiveFidelityState {
	if (options.enabled !== true) return inert();

	try {
		const budget = positiveIntOr(options.budget, DEFAULT_BUDGET);
		const ratio =
			typeof options.summaryRatio === "number" && options.summaryRatio > 0 && options.summaryRatio < 1
				? options.summaryRatio
				: DEFAULT_SUMMARY_RATIO;
		const maxItems = positiveIntOr(options.maxItems, DEFAULT_MAX_ITEMS);

		// 1. Keep only structurally valid, positively-costed, unique items.
		const seen = new Set<string>();
		const valid: FidelityInputItem[] = [];
		for (const it of items ?? []) {
			if (!it || !isNonEmptyString(it.id)) continue;
			if (typeof it.tokens !== "number" || !Number.isFinite(it.tokens) || it.tokens <= 0) continue;
			if (seen.has(it.id)) continue;
			seen.add(it.id);
			valid.push(it);
		}

		const maxRecency = valid.reduce((m, it) => Math.max(m, it.recencySeq ?? 0), 0);

		// 2. Score, then order salience-desc, id-asc (protected pinned to top).
		const scored = valid.map(it => ({ item: it, salience: salienceOf(it, maxRecency) }));
		scored.sort((a, b) => {
			const ap = a.item.protected === true ? 1 : 0;
			const bp = b.item.protected === true ? 1 : 0;
			if (ap !== bp) return bp - ap;
			if (b.salience !== a.salience) return b.salience - a.salience;
			return a.item.id.localeCompare(b.item.id);
		});

		// 3. Apply the eligibility cap. Only ORDINARY items count toward
		//    `maxItems`; protected items are always eligible and never consume a
		//    slot, so `maxItems: N` keeps N ordinary items plus all protected
		//    ones. Ordinary overflow is evicted (and flags `truncated`).
		let truncated = false;
		let ordinaryEligible = 0;
		const eligible: typeof scored = [];
		const cappedOut: typeof scored = [];
		for (const s of scored) {
			if (s.item.protected === true) {
				eligible.push(s);
			} else if (ordinaryEligible < maxItems) {
				eligible.push(s);
				ordinaryEligible++;
			} else {
				cappedOut.push(s);
			}
		}
		if (cappedOut.length > 0) truncated = true;

		// 4. Greedy budget-bounded placement (already salience-ordered).
		const entries: FidelityEntry[] = [];
		let used = 0;
		let overBudget = false;

		for (const { item, salience } of eligible) {
			const fullCost = Math.floor(item.tokens);

			if (item.protected === true) {
				// Always carried at full fidelity, even past budget.
				used += fullCost;
				if (used > budget) overBudget = true;
				entries.push({ id: item.id, tier: "full", salience, cost: fullCost, protected: true });
				continue;
			}

			if (used + fullCost <= budget) {
				used += fullCost;
				entries.push({ id: item.id, tier: "full", salience, cost: fullCost, protected: false });
				continue;
			}

			const sCost = summaryCost(item, fullCost, ratio);
			if (used + sCost <= budget) {
				used += sCost;
				entries.push({ id: item.id, tier: "summarized", salience, cost: sCost, protected: false });
				truncated = true;
				continue;
			}

			entries.push({ id: item.id, tier: "evicted", salience, cost: 0, protected: false });
			truncated = true;
		}

		for (const { item, salience } of cappedOut) {
			entries.push({ id: item.id, tier: "evicted", salience, cost: 0, protected: false });
		}

		const full = entries
			.filter(e => e.tier === "full")
			.map(e => e.id)
			.sort();
		const summarized = entries
			.filter(e => e.tier === "summarized")
			.map(e => e.id)
			.sort();
		const evicted = entries
			.filter(e => e.tier === "evicted")
			.map(e => e.id)
			.sort();
		const total = full.length + summarized.length + evicted.length;
		const firingRate = total > 0 ? full.length / total : 0;

		return {
			mode: "observe",
			enabled: true,
			budget,
			used,
			entries,
			full,
			summarized,
			evicted,
			firingRate,
			truncated: truncated || overBudget,
			overBudget,
		};
	} catch {
		return inert();
	}
}

/**
 * The downstream-facing view: what the consumer should read *now*. Raw
 * history stays in canonical stores; summarized/evicted ids are handles that
 * can be expanded on demand.
 */
export function currentFidelityState(state: AdaptiveFidelityState): CurrentFidelityState {
	if (state?.enabled !== true) {
		return { carried: [], expandHandles: [], evictedHandles: [], used: 0, budget: 0 };
	}
	return {
		carried: [...state.full, ...state.summarized].sort(),
		expandHandles: [...state.summarized],
		evictedHandles: [...state.evicted],
		used: state.used,
		budget: state.budget,
	};
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizeFidelityState(state: AdaptiveFidelityState): string {
	if (state?.enabled !== true) return "fidelity: disabled";
	const parts = [
		`full=${state.full.length}`,
		`summarized=${state.summarized.length}`,
		`evicted=${state.evicted.length}`,
		`used=${state.used}/${state.budget}`,
		`firing=${state.firingRate.toFixed(2)}`,
	];
	if (state.overBudget) parts.push("over-budget");
	else if (state.truncated) parts.push("truncated");
	return `fidelity: ${parts.join(" ")}`;
}
