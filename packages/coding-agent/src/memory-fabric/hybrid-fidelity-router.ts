/**
 * Hybrid fidelity router.
 *
 * Routes each retained context item to the CHEAPEST representation lane that
 * still preserves what the agent needs from it, instead of carrying every
 * item at one uniform fidelity. Structural complement to the adaptive-fidelity
 * budget (which decides how much fidelity each item gets) and the expansion
 * triggers (which decide whether a subsystem fires at all).
 *
 * Four lanes, ordered cheapest-preserving:
 *   - exact-local        verbatim, kept in-context   (protected/F0 + full local)
 *   - compact-global     summarized, kept in-context (summarized + full non-local)
 *   - projected-evidence projected summary of evidence
 *   - deferred-handle    reference only, fetched on demand (evicted items)
 *
 * Deterministic priority ladder (first match wins):
 *   evicted          -> deferred-handle
 *   protected (F0)   -> exact-local        (never downgraded)
 *   evidence         -> projected-evidence
 *   summarized       -> compact-global
 *   full + local     -> exact-local
 *   full + non-local -> compact-global
 *
 * The ladder guarantees protected/F0 material is always carried verbatim
 * (exact-local) unless it was already evicted upstream.
 *
 * Discipline: imports nothing; observe-only (assigns lanes, moves nothing);
 * disabled-by-default (inert unless `options.enabled === true`); fail-open
 * (never throws); deterministic (id-sorted output, no clocks, no randomness).
 */

export type RouterFidelityTier = "full" | "summarized" | "evicted";

export type RepresentationLane = "exact-local" | "compact-global" | "projected-evidence" | "deferred-handle";

/** All lanes in their canonical (cheapest-preserving) order. */
export const REPRESENTATION_LANES: readonly RepresentationLane[] = [
	"exact-local",
	"compact-global",
	"projected-evidence",
	"deferred-handle",
] as const;

/** An item to route. Only `id` is required; the rest are routing hints. */
export interface RoutableItem {
	id: string;
	/** Fidelity tier assigned upstream. Missing/unknown is treated as "full". */
	tier?: RouterFidelityTier;
	/** True when the item is protected (F0) — pinned verbatim, never downgraded. */
	protected?: boolean;
	/** True when the item is already available locally / in-context. */
	local?: boolean;
	/** True when the item is external evidence best carried as a projection. */
	evidence?: boolean;
}

export interface RouterOptions {
	/** Disabled by default. When not true an inert result is returned. */
	enabled?: boolean;
}

export interface LaneAssignment {
	id: string;
	lane: RepresentationLane;
	tier: RouterFidelityTier;
	reason: string;
}

export type LaneBuckets = Record<RepresentationLane, string[]>;

export interface RouterResult {
	mode: "observe";
	enabled: boolean;
	/** Every assignment, id-sorted. */
	assignments: LaneAssignment[];
	/** Ids grouped by lane; each lane id-sorted. */
	lanes: LaneBuckets;
}

function emptyLanes(): LaneBuckets {
	return {
		"exact-local": [],
		"compact-global": [],
		"projected-evidence": [],
		"deferred-handle": [],
	};
}

function inert(): RouterResult {
	return { mode: "observe", enabled: false, assignments: [], lanes: emptyLanes() };
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function normalizeTier(tier: unknown): RouterFidelityTier {
	return tier === "summarized" || tier === "evicted" ? tier : "full";
}

/**
 * Route each item to the cheapest representation lane that preserves intent.
 * Observe-only, disabled-by-default, fail-open, deterministic. Inert when
 * disabled. First match in the priority ladder wins.
 */
export function routeFidelity(items: RoutableItem[], options: RouterOptions = {}): RouterResult {
	if (options.enabled !== true) return inert();

	try {
		const seen = new Set<string>();
		const assignments: LaneAssignment[] = [];

		for (const raw of items ?? []) {
			if (!raw || !isNonEmptyString(raw.id) || seen.has(raw.id)) continue;
			seen.add(raw.id);

			const tier = normalizeTier(raw.tier);
			let lane: RepresentationLane;
			let reason: string;

			if (tier === "evicted") {
				lane = "deferred-handle";
				reason = "evicted -> reference only";
			} else if (raw.protected === true) {
				lane = "exact-local";
				reason = "protected (F0) -> verbatim local";
			} else if (raw.evidence === true) {
				lane = "projected-evidence";
				reason = "evidence -> projected summary";
			} else if (tier === "summarized") {
				lane = "compact-global";
				reason = "summarized -> compact global";
			} else if (raw.local === true) {
				lane = "exact-local";
				reason = "full + local -> verbatim local";
			} else {
				lane = "compact-global";
				reason = "full + non-local -> compact global";
			}

			assignments.push({ id: raw.id, lane, tier, reason });
		}

		assignments.sort((a, b) => a.id.localeCompare(b.id));
		const lanes = emptyLanes();
		for (const a of assignments) lanes[a.lane].push(a.id);
		for (const lane of REPRESENTATION_LANES) lanes[lane].sort();

		return { mode: "observe", enabled: true, assignments, lanes };
	} catch {
		return inert();
	}
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizeRouter(result: RouterResult): string {
	if (result?.enabled !== true) return "router: disabled";
	const parts = REPRESENTATION_LANES.map(lane => `${lane}=${result.lanes[lane].length}`);
	return `router: ${parts.join(" ")}`;
}
