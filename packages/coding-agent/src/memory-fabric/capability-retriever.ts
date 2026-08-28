/**
 * Capability retriever facade — composes the retrieval pipeline end to end.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY orchestrator that composes the
 * capability-retrieval pipeline:
 *
 *     seed fusion  ->  bundle expansion  ->  cycle analysis
 *                                        ->  conflict resolution
 *
 * into a single reviewable `CapabilityRetrieval` result behind ONE
 * disabled-by-default flag.
 *
 * Why ports instead of imports:
 *   Every stage is injected as a port function. This module imports NOTHING
 *   (not even its sibling stage modules). That keeps it truly self-contained
 *   and means the build cannot acquire an unresolvable import if the stage
 *   modules land in a different order. The caller wires the real
 *   `fuseCapabilitySeeds` + `toSeedIds`, `expandExecutionComplete`,
 *   `analyzeCapabilityCycles` and `analyzeCapabilityConflicts` into the ports.
 *
 * Hard invariants:
 *   - Never executes anything and never mutates its inputs.
 *   - OBSERVE-ONLY: produces a projection + human-gated flags; it does NOT
 *     drop, reorder-in-place or select anything for real.
 *   - Fail-open: any stage/port that throws degrades to that stage's inert
 *     output; the facade never throws.
 *   - Disabled-by-default: returns an inert empty retrieval unless
 *     `options.enabled === true`.
 *   - A mandatory (unbreakable) ordering cycle can NEVER yield a usable order
 *     (`order` stays null and `blocked` is set), independent of the gate.
 *
 * Discipline: additive (not wired into `index.ts`), deterministic (id-ordered
 * aggregation; no clocks/randomness).
 */

/** A directed capability edge (kind free-form). Mirrors the sibling edge shape. */
export interface RetrieverEdge {
	from: string;
	to: string;
	kind: string;
}

/** Minimal descriptor the conflict stage consumes (structural subset). */
export interface RetrieverDescriptor {
	id: string;
	[key: string]: unknown;
}

/** Structural subset of the seed-fusion output that the facade reads. */
export interface FusedSeedLike {
	capabilityId: string;
	rrfScore?: number;
}

/** Structural subset of the bundle-expansion output. */
export interface BundleLike {
	seeds?: string[];
	included?: string[];
	prerequisites?: string[];
	missing?: string[];
	truncated?: boolean;
	cycles?: string[][];
}

/** Structural subset of the cycle-analysis output. */
export interface CycleLike {
	acyclic?: boolean;
	hasMandatoryCycle?: boolean;
	topologicalOrder?: string[] | null;
	mandatoryCycles?: Array<{ nodeIds: string[] }>;
	truncated?: boolean;
}

/** Structural subset of a conflict decision. */
export interface DecisionLike {
	a: string;
	b: string;
	action: string;
	keep?: string;
	drop?: string;
	reason?: string;
}

/** Structural subset of the conflict-resolution output. */
export interface ConflictLike {
	decisions?: DecisionLike[];
	needsUser?: DecisionLike[];
}

/**
 * Stage ports. Each returns its stage's *inert* value on any problem; the
 * facade also guards each call, so a port may simply throw and stay simple.
 */
export interface RetrieverPorts {
	/** Produce ranked seed capability ids from the request. */
	fuseSeeds?: (request: RetrievalRequest) => FusedSeedLike[];
	/** Expand a bundle (prerequisites/validations/...) from seed ids. */
	expandBundle?: (seedIds: string[], request: RetrievalRequest) => BundleLike;
	/** Analyse ordering cycles over the working edge set. */
	analyzeCycles?: (edges: RetrieverEdge[], nodeIds: string[]) => CycleLike;
	/** Detect + resolve conflicts among the working descriptors. */
	resolveConflicts?: (descriptors: RetrieverDescriptor[], edges: RetrieverEdge[]) => ConflictLike;
}

export interface RetrievalRequest {
	/** Pre-fused seed ids (used when no `fuseSeeds` port is supplied). */
	seedIds?: string[];
	/** Ordering + conflict edges for the working set. */
	edges?: RetrieverEdge[];
	/** Descriptors for the conflict stage. */
	descriptors?: RetrieverDescriptor[];
	/** Arbitrary signal payload forwarded to the seed fuser (opaque here). */
	signals?: unknown;
}

export interface RetrievalOptions {
	/** Disabled by default. When not true an inert retrieval is returned. */
	enabled?: boolean;
	/** Cap on seed ids carried forward from fusion. Default 64. */
	maxSeeds?: number;
}

/** A single item requiring a human decision before any real use. */
export interface RetrievalFlag {
	kind: "mandatory-cycle" | "conflict";
	reason: string;
	/** Ids involved (sorted). */
	ids: string[];
}

export interface CapabilityRetrieval {
	mode: "observe";
	enabled: boolean;
	/** Which stages actually contributed (in pipeline order). */
	stages: string[];
	/** Seed ids after fusion (id-ordered, capped). */
	seeds: string[];
	/** Included capability ids after bundle expansion (sorted). */
	included: string[];
	/** Safe execution order, or null when a mandatory cycle blocks it. */
	order: string[] | null;
	/** True when nothing can be safely auto-ordered (mandatory cycle present). */
	blocked: boolean;
	/** Ids the bundle could not resolve (sorted). */
	missing: string[];
	/** Conflict decisions (as returned; already deterministic). */
	decisions: DecisionLike[];
	/** Aggregated items that must go to a human before any real selection. */
	needsUser: RetrievalFlag[];
	/** True if any stage hit a budget/limit guard. */
	truncated: boolean;
}

const DEFAULT_MAX_SEEDS = 64;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function uniqueSorted(ids: Iterable<unknown>): string[] {
	const set = new Set<string>();
	for (const id of ids) {
		if (isNonEmptyString(id)) set.add(id);
	}
	return [...set].sort();
}

function inert(): CapabilityRetrieval {
	return {
		mode: "observe",
		enabled: false,
		stages: [],
		seeds: [],
		included: [],
		order: null,
		blocked: false,
		missing: [],
		decisions: [],
		needsUser: [],
		truncated: false,
	};
}

/** Run a stage function, returning `fallback` if it throws. */
function safeRun<T>(fn: () => T, fallback: T): { value: T; ran: boolean } {
	try {
		return { value: fn(), ran: true };
	} catch {
		return { value: fallback, ran: false };
	}
}

/**
 * Compose the capability-retrieval pipeline into one observe-only result.
 * Disabled-by-default, fail-open, deterministic. Executes nothing.
 */
export function retrieveCapabilities(
	request: RetrievalRequest,
	ports: RetrieverPorts = {},
	options: RetrievalOptions = {},
): CapabilityRetrieval {
	if (options.enabled !== true) return inert();

	try {
		const req = request ?? {};
		const maxSeeds = positiveIntOr(options.maxSeeds, DEFAULT_MAX_SEEDS);
		const stages: string[] = [];
		let truncated = false;

		// --- Stage 1: seed fusion -------------------------------------------
		const fuseSeeds = ports.fuseSeeds;
		let seeds: string[];
		if (typeof fuseSeeds === "function") {
			const fused = safeRun(() => fuseSeeds(req), [] as FusedSeedLike[]);
			if (fused.ran) stages.push("fuse-seeds");
			seeds = uniqueSorted((fused.value ?? []).map(s => s?.capabilityId));
		} else {
			seeds = uniqueSorted(req.seedIds ?? []);
		}
		if (seeds.length > maxSeeds) {
			seeds = seeds.slice(0, maxSeeds);
			truncated = true;
		}

		// --- Stage 2: bundle expansion ---------------------------------------
		const expandBundle = ports.expandBundle;
		let included: string[] = seeds;
		let missing: string[] = [];
		if (typeof expandBundle === "function") {
			const bundle = safeRun(() => expandBundle(seeds, req), {} as BundleLike);
			if (bundle.ran) stages.push("expand-bundle");
			const b = bundle.value ?? {};
			const incl = new Set<string>(seeds);
			for (const id of b.included ?? []) {
				if (isNonEmptyString(id)) incl.add(id);
			}
			for (const id of b.prerequisites ?? []) {
				if (isNonEmptyString(id)) incl.add(id);
			}
			included = [...incl].sort();
			missing = uniqueSorted(b.missing ?? []);
			if (b.truncated === true) truncated = true;
		}

		// Working edge set is restricted to edges among included ids.
		const includedSet = new Set(included);
		const edges = (req.edges ?? []).filter(e => {
			if (!e || !isNonEmptyString(e.from) || !isNonEmptyString(e.to)) return false;
			return includedSet.has(e.from) && includedSet.has(e.to);
		});

		// --- Stage 3: cycle analysis -----------------------------------------
		const analyzeCycles = ports.analyzeCycles;
		let order: string[] | null = null;
		let blocked = false;
		const cycleFlags: RetrievalFlag[] = [];
		if (typeof analyzeCycles === "function") {
			const cyc = safeRun(() => analyzeCycles(edges, included), {} as CycleLike);
			if (cyc.ran) stages.push("analyze-cycles");
			const c = cyc.value ?? {};
			if (c.truncated === true) truncated = true;
			if (c.hasMandatoryCycle === true || c.acyclic === false) {
				blocked = true;
				order = null;
				for (const mc of c.mandatoryCycles ?? []) {
					const ids = uniqueSorted(mc?.nodeIds ?? []);
					cycleFlags.push({
						kind: "mandatory-cycle",
						reason: "unbreakable ordering cycle; cannot auto-order",
						ids,
					});
				}
				if (cycleFlags.length === 0) {
					cycleFlags.push({ kind: "mandatory-cycle", reason: "mandatory ordering cycle detected", ids: [] });
				}
			} else if (Array.isArray(c.topologicalOrder)) {
				order = c.topologicalOrder.filter(isNonEmptyString);
			}
		}

		// --- Stage 4: conflict resolution ------------------------------------
		const resolveConflicts = ports.resolveConflicts;
		let decisions: DecisionLike[] = [];
		const conflictFlags: RetrievalFlag[] = [];
		if (typeof resolveConflicts === "function") {
			const descriptors = (req.descriptors ?? []).filter(d => d && isNonEmptyString(d.id) && includedSet.has(d.id));
			const conf = safeRun(() => resolveConflicts(descriptors, edges), {} as ConflictLike);
			if (conf.ran) stages.push("resolve-conflicts");
			const cr = conf.value ?? {};
			decisions = Array.isArray(cr.decisions) ? cr.decisions : [];
			for (const d of cr.needsUser ?? []) {
				if (!d || !isNonEmptyString(d.a) || !isNonEmptyString(d.b)) continue;
				conflictFlags.push({
					kind: "conflict",
					reason: isNonEmptyString(d.reason) ? d.reason : `unresolved ${d.action} conflict`,
					ids: uniqueSorted([d.a, d.b]),
				});
			}
		}

		// Aggregate human-gated flags deterministically (cycles first, then
		// conflicts; each group id-sorted).
		const needsUser = [
			...cycleFlags.sort((p, q) => p.ids.join().localeCompare(q.ids.join())),
			...conflictFlags.sort((p, q) => p.ids.join().localeCompare(q.ids.join())),
		];

		return {
			mode: "observe",
			enabled: true,
			stages,
			seeds,
			included,
			order,
			blocked,
			missing,
			decisions,
			needsUser,
			truncated,
		};
	} catch {
		return inert();
	}
}

/** A short deterministic one-line summary of a retrieval (for logs/telemetry). */
export function summarizeRetrieval(retrieval: CapabilityRetrieval): string {
	if (retrieval?.enabled !== true) return "retrieval: disabled";
	const parts = [
		`seeds=${retrieval.seeds.length}`,
		`included=${retrieval.included.length}`,
		`order=${retrieval.order ? retrieval.order.length : "blocked"}`,
		`needsUser=${retrieval.needsUser.length}`,
		`missing=${retrieval.missing.length}`,
	];
	if (retrieval.truncated) parts.push("truncated");
	return `retrieval: ${parts.join(" ")}`;
}
