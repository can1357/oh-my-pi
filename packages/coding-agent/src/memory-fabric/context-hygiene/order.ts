/**
 * Adaptive Context Hygiene — position / anti-burial ordering (ACF CH10).
 *
 * Long-context models degrade on information buried in the MIDDLE of a large
 * packet ("lost in the middle"; plan §2). The correct response is not deletion
 * but ORDER: render the most decision-critical items where recall is highest —
 * the edges — and let proven-low-value items settle into the middle. This is
 * the "order by decision importance (anti-burial)" step of the plan §5 gate and
 * the CH10 phase (plan §7).
 *
 * Safety posture (plan §3, §4):
 *   - Ordering NEVER changes content, provenance, command semantics, or class.
 *     It only chooses positions (rule #1). Items are cloned; input is untouched.
 *   - F0 is "never reordered out of prominence" (§3). The importance score ranks
 *     F0 strictly above every lower class, and the anti-burial layout places the
 *     top-ranked items at the edges — so F0 is kept prominent, never buried,
 *     whenever any lower-fidelity item exists to occupy the middle.
 *   - Deterministic: ties break on the caller's original index (stable), so the
 *     same input always yields the same order.
 *   - Fail-open (rule #4): on ANY error the original items are returned in their
 *     original order, flagged `failedOpen`. Ordering is size-neutral, so it can
 *     never make a packet larger.
 *
 * Additive, injectable, disabled by default. NOT wired as the pipeline's default
 * `orderItems` (that stays identity); a caller opts in with
 * `runContextHygieneGate(items, needs, { orderItems: makeOrderer() })`.
 */

import { type ClassifiedContextItem, FIDELITY_ORDER, type FidelityClass } from "./types";

export const ORDERER_NAME = "acf-anti-burial-orderer";
export const ORDERER_VERSION = "ch10-1";

/**
 * - "anti-burial" (default): top-ranked items at the two EDGES, lowest in the
 *   middle (mitigates lost-in-the-middle).
 * - "importance-desc": a plain most-important-first sort (front-loaded).
 * - "stable": identity order (a measurement control; annotates only).
 */
export type OrderStrategy = "anti-burial" | "importance-desc" | "stable";

/** Where an item landed. Edges are the high-recall zones. */
export type Placement = "edge-start" | "edge-end" | "middle";

/** Caller-supplied importance in [0, +inf). Higher = more decision-critical. */
export type ImportanceSignal = (item: ClassifiedContextItem, index: number) => number;

export interface OrderOptions {
	/** Layout strategy. Default "anti-burial". */
	strategy?: OrderStrategy;
	/**
	 * Optional caller importance (e.g. need-relevance, recency). Default: 0 for
	 * every item, so ordering is driven purely by fidelity class. A throwing
	 * signal is treated as 0 for that item (never crashes the gate).
	 */
	importance?: ImportanceSignal;
	/** Weight on the fidelity-class component of the score. Default 1. */
	fidelityWeight?: number;
	/** Weight on the caller-importance component of the score. Default 1. */
	importanceWeight?: number;
	/** Injectable clock for deterministic telemetry timestamps. */
	now?: () => Date;
}

/** A classified item annotated with its ordering decision. */
export interface OrderedContextItem extends ClassifiedContextItem {
	/** Importance rank: 0 = most decision-critical. */
	orderRank: number;
	/** Composite importance score (higher = more important). */
	orderScore: number;
	/** Index in the caller's original input (audit + stable tie-break). */
	originalIndex: number;
	/** Final placement bucket relative to the packet. */
	placement: Placement;
}

export interface OrderReport {
	orderer: string;
	ordererVersion: string;
	strategy: OrderStrategy;
	/** Items in their new order, annotated. */
	items: OrderedContextItem[];
	/** How many items changed position vs. the original order. */
	moved: number;
	/** True when at least one F0/F1 item sits in the middle bucket (a smell). */
	preservedInMiddle: boolean;
	generatedAt: string;
	/** True when the orderer caught an error and returned the input unchanged. */
	failedOpen: boolean;
}

const PRESERVED: ReadonlySet<FidelityClass> = new Set<FidelityClass>(["F0", "F1"]);

/** Class score: F0 highest → F4 lowest; unknown class scores 0 (below F4). */
function fidelityScore(fidelity: FidelityClass): number {
	const rank = FIDELITY_ORDER.indexOf(fidelity);
	const r = rank === -1 ? FIDELITY_ORDER.length : rank;
	return FIDELITY_ORDER.length - r; // F0=5, F1=4, F2=3, F3=2, F4=1
}

/** Safely evaluate the caller importance signal; a throw counts as 0. */
function safeImportance(signal: ImportanceSignal | undefined, item: ClassifiedContextItem, index: number): number {
	if (!signal) return 0;
	try {
		const v = signal(item, index);
		return Number.isFinite(v) && v > 0 ? v : 0;
	} catch {
		return 0;
	}
}

/** Placement bucket by final physical position (thirds; edges are high-recall). */
function placementFor(index: number, n: number): Placement {
	if (n <= 1) return "edge-start";
	if (n === 2) return index === 0 ? "edge-start" : "edge-end";
	const third = n / 3;
	if (index < third) return "edge-start";
	if (index >= n - third) return "edge-end";
	return "middle";
}

interface Scored {
	item: ClassifiedContextItem;
	originalIndex: number;
	score: number;
}

/**
 * Distribute importance-sorted items to the edges: rank 0 → very front, rank 1
 * → very back, rank 2 → second front, rank 3 → second back, … so the lowest
 * ranks converge in the middle. Deterministic and length-preserving.
 */
function antiBurialLayout<T>(rankedByImportance: T[]): T[] {
	const front: T[] = [];
	const back: T[] = [];
	for (let i = 0; i < rankedByImportance.length; i++) {
		if (i % 2 === 0) front.push(rankedByImportance[i]);
		else back.push(rankedByImportance[i]);
	}
	back.reverse();
	return [...front, ...back];
}

/**
 * Order classified items by decision importance (anti-burial by default).
 * Pure, deterministic, non-mutating, fail-open. Returns a full report; use
 * {@link makeOrderer} for a drop-in pipeline `orderItems` seam.
 */
export function planOrdering(items: ClassifiedContextItem[], options: OrderOptions = {}): OrderReport {
	const now = options.now ?? (() => new Date());
	const generatedAt = now().toISOString();
	const strategy: OrderStrategy = options.strategy ?? "anti-burial";

	try {
		const fidelityWeight = options.fidelityWeight ?? 1;
		const importanceWeight = options.importanceWeight ?? 1;

		// 1) Score every item (fidelity class + optional caller importance).
		const scored: Scored[] = items.map((item, originalIndex) => {
			const score =
				fidelityWeight * fidelityScore(item.fidelity) +
				importanceWeight * safeImportance(options.importance, item, originalIndex);
			return { item, originalIndex, score };
		});

		// 2) Rank by score desc; stable tie-break on original index (earlier wins).
		const ranked = [...scored].sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

		// 3) Lay out per strategy.
		let laidOut: Scored[];
		if (strategy === "stable") laidOut = scored;
		else if (strategy === "importance-desc") laidOut = ranked;
		else laidOut = antiBurialLayout(ranked);

		// rank-by-importance index for each original position.
		const rankOf = new Map<number, number>();
		ranked.forEach((s, rank) => {
			rankOf.set(s.originalIndex, rank);
		});

		const n = laidOut.length;
		let moved = 0;
		let preservedInMiddle = false;
		const ordered: OrderedContextItem[] = laidOut.map((s, finalIndex) => {
			if (s.originalIndex !== finalIndex) moved++;
			const placement = placementFor(finalIndex, n);
			if (placement === "middle" && PRESERVED.has(s.item.fidelity)) preservedInMiddle = true;
			return {
				...s.item,
				orderRank: rankOf.get(s.originalIndex) ?? finalIndex,
				orderScore: s.score,
				originalIndex: s.originalIndex,
				placement,
			};
		});

		return {
			orderer: ORDERER_NAME,
			ordererVersion: ORDERER_VERSION,
			strategy,
			items: ordered,
			moved,
			preservedInMiddle,
			generatedAt,
			failedOpen: false,
		};
	} catch {
		// Fail open: original order, unchanged, annotated as pass-through.
		const passthrough: OrderedContextItem[] = items.map((item, i) => ({
			...item,
			orderRank: i,
			orderScore: 0,
			originalIndex: i,
			placement: placementFor(i, items.length),
		}));
		return {
			orderer: ORDERER_NAME,
			ordererVersion: ORDERER_VERSION,
			strategy,
			items: passthrough,
			moved: 0,
			preservedInMiddle: false,
			generatedAt,
			failedOpen: true,
		};
	}
}

/**
 * Order items and return just the reordered array (annotations retained). This
 * is the shape the CH10 layout produces; kept separate from {@link makeOrderer}
 * so callers who want the report can have it.
 */
export function orderByDecisionImportance(
	items: ClassifiedContextItem[],
	options: OrderOptions = {},
): OrderedContextItem[] {
	return planOrdering(items, options).items;
}

/**
 * Build a drop-in `orderItems` hook for the Adaptive Context Hygiene Gate.
 * OrderedContextItem extends ClassifiedContextItem, so the result is assignable
 * to the pipeline's `orderItems` seam with no widening.
 */
export function makeOrderer(options: OrderOptions = {}): (items: ClassifiedContextItem[]) => ClassifiedContextItem[] {
	return items => orderByDecisionImportance(items, options);
}
