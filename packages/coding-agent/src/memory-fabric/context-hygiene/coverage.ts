/**
 * Adaptive Context Hygiene — required-need coverage + never-worse guard (ACF CH6).
 *
 * The pre-model hygiene gate (plan §5) ends with a coverage check: before the
 * Context Composer finalizes the packet, every *required need* must be covered
 * by at least one retained item. Rule #6 is explicit:
 *
 *   "Required-need coverage is validated before the packet is finalized; if a
 *    required need is not covered, expand fidelity rather than ship a gap."
 *
 * This module implements that rule on top of the CH3 fidelity classifier:
 *   - A need is *covered* only by a SAFE, RETAINED item (disposition "keep").
 *     Items marked to be omitted/dropped by an upstream budget stage don't
 *     count until we escalate them.
 *   - When a required need is covered only by an omittable candidate, the gate
 *     ESCALATES that candidate's fidelity to a preserved class (F1) and forces
 *     it to be kept — expanding fidelity rather than shipping a gap.
 *   - Rejected (F4) items never satisfy a need by default: resurrecting unsafe
 *     content to cover a requirement would violate the F4 contract, so an F4
 *     item is treated as no candidate → a hard coverage gap the caller must
 *     resolve by widening retrieval.
 *   - F0 is never downgraded; escalation only ever raises fidelity.
 *
 * Never-worse guarantee (the CH6 analogue of the CH1 output guard, rule #5):
 * gating/compression must NEVER cover fewer required needs than are coverable
 * from the safe candidate set. If the checker itself errors it fails *toward
 * preservation*: keep every candidate and flag that expansion is required, so a
 * gap is never silently shipped.
 *
 * Additive, injectable, disabled by default; not wired into the hot path.
 */

import {
	ALLOWED_TRANSFORMS,
	type ClassifiedContextItem,
	FIDELITY_ORDER,
	type FidelityClass,
	PRESERVED_CLASSES,
} from "./types";

/** What the downstream budget stage intends to do with an item. */
export type Disposition = "keep" | "omit" | "drop";

/** A requirement the finalized packet must satisfy. */
export interface RequiredNeed {
	id: string;
	description?: string;
	/** Predicate: does this item satisfy the need? */
	match: (item: ClassifiedContextItem) => boolean;
	/** Required needs must be covered; optional ones are reported only. Default true. */
	required?: boolean;
}

/** An item carried through the coverage gate with its final disposition. */
export interface CoveredContextItem extends ClassifiedContextItem {
	disposition: Disposition;
	/** Present when the gate raised fidelity / forced keep to cover a need. */
	escalated?: {
		fromFidelity: FidelityClass;
		toFidelity: FidelityClass;
		fromDisposition: Disposition;
		reason: string;
		forNeed: string;
	};
}

export type CoverageAction = "already-covered" | "expanded" | "gap" | "optional-uncovered";

/** Per-need coverage outcome. */
export interface NeedCoverage {
	needId: string;
	required: boolean;
	covered: boolean;
	/** Safe candidate items (F0–F3) that match this need. */
	matchedCandidateIds: string[];
	/** Retained items (disposition "keep") that actually cover the need. */
	coveringItemIds: string[];
	action: CoverageAction;
}

export interface Expansion {
	needId: string;
	itemId: string;
	fromFidelity: FidelityClass;
	toFidelity: FidelityClass;
	fromDisposition: Disposition;
}

export interface NeverWorseCoverage {
	/** Required needs that COULD be covered from the safe candidate set. */
	requiredCoverableCount: number;
	/** Required needs actually covered after gating + expansion. */
	requiredCoveredCount: number;
	/** True if we covered fewer required needs than were coverable (must be false). */
	violation: boolean;
}

export interface CoverageReport {
	/** Items in original order, with final disposition + any escalations applied. */
	items: CoveredContextItem[];
	results: NeedCoverage[];
	expansions: Expansion[];
	/** Required needs with no safe candidate at all — caller must widen retrieval. */
	gaps: string[];
	allRequiredCovered: boolean;
	neverWorse: NeverWorseCoverage;
	generatedAt: string;
	/** True when the checker caught an error and kept everything (fail toward preservation). */
	failedOpen: boolean;
}

export interface CoverageOptions {
	/** Initial disposition per item. Default: F4 → "drop", everything else "keep". */
	dispositionOf?: (item: ClassifiedContextItem) => Disposition;
	/** Ids the budget stage intends to omit (overrides dispositionOf to "omit"). */
	omittedIds?: Iterable<string>;
	/**
	 * When true, rejected (F4) items may satisfy needs. Default false — unsafe
	 * content is never resurrected just to cover a requirement.
	 */
	allowRejectedToCover?: boolean;
	/** Fidelity a covered-but-omittable item is escalated to. Default "F1". */
	escalateTo?: FidelityClass;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

function defaultDisposition(item: ClassifiedContextItem): Disposition {
	return item.fidelity === "F4" ? "drop" : "keep";
}

/** Rank by fidelity: lower index in FIDELITY_ORDER = higher fidelity. */
function fidelityRank(f: FidelityClass): number {
	const i = FIDELITY_ORDER.indexOf(f);
	return i === -1 ? FIDELITY_ORDER.length : i;
}

/** The higher-fidelity (more protected) of two classes; never downgrades. */
function maxFidelity(a: FidelityClass, b: FidelityClass): FidelityClass {
	return fidelityRank(a) <= fidelityRank(b) ? a : b;
}

function cloneCovered(item: ClassifiedContextItem, disposition: Disposition): CoveredContextItem {
	return { ...item, disposition };
}

// --- convenience need builders --------------------------------------------

/** Need satisfied when an item's id (or provenance.originId) equals `id`. */
export function needFromId(needId: string, id: string, required = true): RequiredNeed {
	return {
		id: needId,
		description: `item id ${id}`,
		required,
		match: item => item.id === id || item.provenance?.originId === id,
	};
}

/** Need satisfied when item content (case-insensitive) contains any keyword. */
export function needFromKeywords(needId: string, keywords: string[], required = true): RequiredNeed {
	const lowered = keywords.map(k => k.toLowerCase());
	return {
		id: needId,
		description: `keywords: ${keywords.join(", ")}`,
		required,
		match: item => {
			const hay = item.content.toLowerCase();
			return lowered.some(k => hay.includes(k));
		},
	};
}

/** Need satisfied by an arbitrary predicate. */
export function needFromPredicate(
	needId: string,
	predicate: (item: ClassifiedContextItem) => boolean,
	required = true,
): RequiredNeed {
	return { id: needId, required, match: predicate };
}

/**
 * Validate required-need coverage over a classified candidate set and, per rule
 * #6, expand fidelity (escalate + force-keep) rather than ship a gap. Pure,
 * deterministic, and fail-open toward preservation.
 */
export function validateCoverage(
	items: ClassifiedContextItem[],
	needs: RequiredNeed[],
	options: CoverageOptions = {},
): CoverageReport {
	const now = options.now ?? (() => new Date());
	const generatedAt = now().toISOString();

	try {
		const dispositionOf = options.dispositionOf ?? defaultDisposition;
		const omitted = new Set<string>(options.omittedIds ?? []);
		const allowRejected = options.allowRejectedToCover ?? false;
		const escalateTo = options.escalateTo ?? "F1";

		// Build the working item list with initial dispositions.
		const working: CoveredContextItem[] = items.map(item => {
			let disp = dispositionOf(item);
			if (omitted.has(item.id)) disp = "omit";
			return cloneCovered(item, disp);
		});

		const results: NeedCoverage[] = [];
		const expansions: Expansion[] = [];
		const gaps: string[] = [];

		for (const need of needs) {
			const required = need.required !== false;

			// Safe candidates: matching items that are not rejected (unless allowed).
			const candidates = working.filter(w => (allowRejected || w.fidelity !== "F4") && safeMatch(need, w));
			const matchedCandidateIds = candidates.map(c => c.id);

			const retained = candidates.filter(c => c.disposition === "keep");
			let covering = retained.map(c => c.id);
			let covered = covering.length > 0;
			let action: CoverageAction;

			if (covered) {
				action = "already-covered";
			} else if (!required) {
				action = "optional-uncovered";
			} else if (candidates.length === 0) {
				// No safe candidate exists at all: a hard gap the gate can't fill.
				action = "gap";
				gaps.push(need.id);
			} else {
				// Expand fidelity rather than ship a gap: escalate the best candidate.
				const best = pickBest(candidates);
				const toFidelity = maxFidelity(best.fidelity, escalateTo);
				expansions.push({
					needId: need.id,
					itemId: best.id,
					fromFidelity: best.fidelity,
					toFidelity,
					fromDisposition: best.disposition,
				});
				applyEscalation(best, toFidelity, need.id);
				covering = [best.id];
				covered = true;
				action = "expanded";
			}

			results.push({ needId: need.id, required, covered, matchedCandidateIds, coveringItemIds: covering, action });
		}

		const requiredResults = results.filter(r => r.required);
		const requiredCoverableCount = requiredResults.filter(r => r.matchedCandidateIds.length > 0).length;
		const requiredCoveredCount = requiredResults.filter(r => r.covered).length;
		const violation = requiredCoveredCount < requiredCoverableCount;
		const allRequiredCovered = requiredResults.every(r => r.covered);

		return {
			items: working,
			results,
			expansions,
			gaps,
			allRequiredCovered,
			neverWorse: { requiredCoverableCount, requiredCoveredCount, violation },
			generatedAt,
			failedOpen: false,
		};
	} catch {
		// Fail toward preservation: keep everything, flag that expansion is needed.
		const kept = items.map(item => cloneCovered(item, "keep"));
		return {
			items: kept,
			results: [],
			expansions: [],
			gaps: [],
			allRequiredCovered: false,
			neverWorse: { requiredCoverableCount: 0, requiredCoveredCount: 0, violation: false },
			generatedAt,
			failedOpen: true,
		};
	}
}

function safeMatch(need: RequiredNeed, item: CoveredContextItem): boolean {
	try {
		return need.match(item) === true;
	} catch {
		// A throwing predicate must never crash the gate; treat as no-match.
		return false;
	}
}

/** Pick the highest-fidelity candidate; tie-break on original order (first). */
function pickBest(candidates: CoveredContextItem[]): CoveredContextItem {
	let best = candidates[0];
	for (let i = 1; i < candidates.length; i++) {
		if (fidelityRank(candidates[i].fidelity) < fidelityRank(best.fidelity)) best = candidates[i];
	}
	return best;
}

/** Raise an item's fidelity and force-keep it (mutates the working clone only). */
function applyEscalation(item: CoveredContextItem, toFidelity: FidelityClass, forNeed: string): void {
	const fromFidelity = item.fidelity;
	const fromDisposition = item.disposition;
	item.escalated = {
		fromFidelity,
		toFidelity,
		fromDisposition,
		reason: "required-need coverage: expanded fidelity rather than ship a gap (rule #6)",
		forNeed,
	};
	item.fidelity = toFidelity;
	item.disposition = "keep";
	item.preserved = PRESERVED_CLASSES.has(toFidelity);
	// Keep allowedTransforms consistent with the new class (no-compression still wins).
	item.allowedTransforms = item.noCompression ? ["none"] : [...ALLOWED_TRANSFORMS[toFidelity]];
}
