/**
 * Capability conflict resolution — typed conflicts + precedence ladder.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY conflict engine. The bundle
 * expander (`capability-bundle.ts`) only *reports* symmetric `conflicts-with`
 * pairs as a flat list; it neither classifies them nor proposes a resolution.
 * This module upgrades that to the conflict taxonomy + precedence ladder the
 * capability retriever needs:
 *
 *   1. Detection — derive a typed conflict set from:
 *        - declared `conflicts-with` edges (mutually-exclusive, hard),
 *        - resource/effect overlaps (write/write, delete/read-or-write),
 *        - injected per-capability metadata (schema / environment / scope /
 *          policy incompatibilities).
 *      False conflicts are filtered out: two capabilities that live on
 *      mutually-exclusive conditional branches (e.g. on-success vs on-failure)
 *      can never co-run, so they do not really conflict.
 *   2. Resolution — for each conflict pick a decision via a fixed *precedence
 *      ladder* (user-instruction > safety > canonical-decision > workflow >
 *      dependency > preference > health > reliability > side-effect > cost >
 *      ask-user). Hard conflicts keep a winner / drop a loser, or escalate to
 *      ask-user; soft conflicts keep both with a recommended primary. An
 *      `alternative-to` swap is preferred over a straight drop when available.
 *
 * Hard safety invariants (mirrors the planner-adapter stance):
 *   - The engine NEVER executes and NEVER mutates its inputs.
 *   - It emits *suggested* decisions only; `drop` / `swap` / `ask-user` are
 *     advisory and stay human-gated. Nothing here auto-applies.
 *   - A scorer/preference signal can NEVER override a hard constraint.
 *   - Two safety-critical capabilities in a hard conflict are NEVER
 *     auto-resolved — they always escalate to `ask-user`.
 *   - All context is injected; the module never invents signals.
 *
 * Discipline: disabled-by-default, observe-only, fail-open, additive (not wired
 * into `index.ts`), deterministic (sorted iteration + id tie-breaks; no clocks).
 */

/** Kinds of conflict this engine can represent. */
export type ConflictType =
	| "mutually-exclusive" // declared conflicts-with; cannot co-run
	| "resource-contention" // both write the same resource
	| "effect-overlap" // one deletes what the other reads/writes
	| "schema-incompatible" // incompatible input/output schema versions
	| "environment-incompatible" // require conflicting runtime/env
	| "policy-incompatible" // one is disallowed alongside the other by policy
	| "scope-incompatible"; // operate on disjoint required scopes

export type ConflictSeverity = "hard" | "soft";

/** A precedence lane, highest authority first. */
export type PrecedenceLane =
	| "user-instruction"
	| "safety"
	| "canonical-decision"
	| "workflow"
	| "dependency"
	| "preference"
	| "health"
	| "reliability"
	| "side-effect"
	| "cost";

/** Precedence ladder, index 0 = highest authority. */
export const PRECEDENCE_LADDER: readonly PrecedenceLane[] = [
	"user-instruction",
	"safety",
	"canonical-decision",
	"workflow",
	"dependency",
	"preference",
	"health",
	"reliability",
	"side-effect",
	"cost",
];

/** Read/write/side-effect footprint of a capability (all injected). */
export interface ResourceEffects {
	reads?: string[];
	writes?: string[];
	creates?: string[];
	deletes?: string[];
	externalSystems?: string[];
}

/**
 * Injected descriptor for one capability. Everything is provided by the caller;
 * the engine never derives these from execution.
 */
export interface ConflictCapabilityDescriptor {
	id: string;
	/** True when this capability is safety-critical (never silently dropped). */
	safetyCritical?: boolean;
	/** Ids this capability can be replaced by (enables a swap over a drop). */
	alternativeTo?: string[];
	/** Highest precedence lane that *supports keeping* this capability. */
	supportedBy?: PrecedenceLane[];
	/** Schema identity for input/output compatibility checks. */
	schemaId?: string;
	/** Required runtime / environment tag. */
	environment?: string;
	/** Required scopes/permissions. */
	scopes?: string[];
	/** Conditional branch this capability lives on (for false-conflict filter). */
	branch?: string;
	effects?: ResourceEffects;
}

/** A declared directed/symmetric conflict edge (kind free-form; filtered). */
export interface CapabilityConflictEdge {
	from: string;
	to: string;
	kind: string;
}

/** A typed, classified conflict between two capabilities (a < b by id). */
export interface CapabilityConflict {
	a: string;
	b: string;
	type: ConflictType;
	severity: ConflictSeverity;
	reason: string;
	/** Where this conflict came from (declared edge / effects / metadata). */
	provenance: "declared" | "effects" | "metadata";
}

export type ConflictAction = "keep-both" | "keep-winner" | "swap" | "ask-user";

export interface ConflictDecision {
	a: string;
	b: string;
	type: ConflictType;
	severity: ConflictSeverity;
	action: ConflictAction;
	/** For keep-winner/swap: the id to keep. */
	keep?: string;
	/** For keep-winner: the id suggested to drop. For swap: the id replaced. */
	drop?: string;
	/** For swap: the alternative id suggested in place of `drop`. */
	replaceWith?: string;
	/** The precedence lane that decided it, or "tie"/"safety-standoff". */
	decidedBy: PrecedenceLane | "tie" | "safety-standoff" | "none";
	reason: string;
}

/** Branch pairs that are mutually exclusive (cannot co-run) -> false conflict. */
const EXCLUSIVE_BRANCH_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["on-success", "on-failure"],
	["then", "else"],
];

export interface ConflictOptions {
	/** Disabled by default. When false an inert (empty) result is returned. */
	enabled?: boolean;
	/** Edge kinds treated as declared mutual-exclusion. Default: conflicts-with. */
	exclusionKinds?: string[];
	/** Extra mutually-exclusive branch-name pairs. */
	exclusiveBranchPairs?: ReadonlyArray<readonly [string, string]>;
	/** Max descriptors to consider. Default 256. */
	maxNodes?: number;
}

export interface ConflictResolutionResult {
	mode: "observe";
	enabled: boolean;
	conflicts: CapabilityConflict[];
	decisions: ConflictDecision[];
	/** Decisions that need a human (ask-user) — surfaced for the gate. */
	needsUser: ConflictDecision[];
	truncated: boolean;
}

const DEFAULT_EXCLUSION_KINDS = ["conflicts-with"];
const DEFAULT_MAX_NODES = 256;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function inert(): ConflictResolutionResult {
	return { mode: "observe", enabled: false, conflicts: [], decisions: [], needsUser: [], truncated: false };
}

/** Order a pair by id so (a,b) is canonical (a <= b). */
function orderPair(x: string, y: string): [string, string] {
	return x <= y ? [x, y] : [y, x];
}

function pairKey(x: string, y: string): string {
	const [a, b] = orderPair(x, y);
	return `${a}\u0000${b}`;
}

/** Canonical (a, b, type) ordering shared by conflicts and decisions. */
function comparePairThenType(
	p: { a: string; b: string; type: string },
	q: { a: string; b: string; type: string },
): number {
	return p.a.localeCompare(q.a) || p.b.localeCompare(q.b) || p.type.localeCompare(q.type);
}

/** True when the two descriptors sit on mutually-exclusive branches. */
function onExclusiveBranches(
	a: ConflictCapabilityDescriptor,
	b: ConflictCapabilityDescriptor,
	pairs: ReadonlyArray<readonly [string, string]>,
): boolean {
	if (!isNonEmptyString(a.branch) || !isNonEmptyString(b.branch)) return false;
	if (a.branch === b.branch) return false;
	for (const [x, y] of pairs) {
		if ((a.branch === x && b.branch === y) || (a.branch === y && b.branch === x)) return true;
	}
	return false;
}

function overlap(one: string[] | undefined, two: string[] | undefined): string[] {
	if (!one || !two || one.length === 0 || two.length === 0) return [];
	const set = new Set(two);
	const hits = new Set<string>();
	for (const v of one) {
		if (isNonEmptyString(v) && set.has(v)) hits.add(v);
	}
	return [...hits].sort();
}

/**
 * Detect typed conflicts from declared edges + injected descriptors.
 * Pure; deterministic; fail-open (returns [] on error).
 */
export function detectConflicts(
	descriptors: readonly ConflictCapabilityDescriptor[],
	edges: readonly CapabilityConflictEdge[],
	options: ConflictOptions = {},
): CapabilityConflict[] {
	if (options.enabled !== true) return [];
	try {
		const exclusionKinds = new Set(options.exclusionKinds ?? DEFAULT_EXCLUSION_KINDS);
		const branchPairs = options.exclusiveBranchPairs ?? EXCLUSIVE_BRANCH_PAIRS;
		const maxNodes = positiveIntOr(options.maxNodes, DEFAULT_MAX_NODES);

		const byId = new Map<string, ConflictCapabilityDescriptor>();
		for (const d of descriptors ?? []) {
			if (!d || !isNonEmptyString(d.id)) continue;
			if (!byId.has(d.id) && byId.size >= maxNodes) continue;
			if (!byId.has(d.id)) byId.set(d.id, d);
		}

		const found = new Map<string, CapabilityConflict>();
		const record = (c: CapabilityConflict) => {
			const key = `${pairKey(c.a, c.b)}\u0000${c.type}`;
			if (!found.has(key)) found.set(key, c);
		};

		const notFalse = (x: string, y: string): boolean => {
			const da = byId.get(x);
			const db = byId.get(y);
			if (da && db && onExclusiveBranches(da, db, branchPairs)) return false;
			return true;
		};

		// 1) Declared conflicts-with edges -> mutually-exclusive / hard.
		for (const edge of edges ?? []) {
			if (!edge || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) continue;
			if (edge.from === edge.to) continue;
			if (!exclusionKinds.has(edge.kind)) continue;
			if (!notFalse(edge.from, edge.to)) continue;
			const [a, b] = orderPair(edge.from, edge.to);
			record({
				a,
				b,
				type: "mutually-exclusive",
				severity: "hard",
				reason: `declared ${edge.kind} between ${a} and ${b}`,
				provenance: "declared",
			});
		}

		// 2) Resource/effect + metadata conflicts across descriptor pairs.
		const ids = [...byId.keys()].sort();
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const da = byId.get(ids[i]);
				const db = byId.get(ids[j]);
				if (!da || !db) continue;
				const [a, b] = orderPair(da.id, db.id);
				if (!notFalse(a, b)) continue;

				const ea = da.effects ?? {};
				const eb = db.effects ?? {};

				// write/write on the same resource -> resource-contention (soft).
				const ww = overlap(ea.writes, eb.writes);
				if (ww.length > 0) {
					record({
						a,
						b,
						type: "resource-contention",
						severity: "soft",
						reason: `both write: ${ww.join(", ")}`,
						provenance: "effects",
					});
				}
				// creates/creates on the same resource -> resource-contention (soft).
				const cc = overlap(ea.creates, eb.creates);
				if (cc.length > 0) {
					record({
						a,
						b,
						type: "resource-contention",
						severity: "soft",
						reason: `both create same target: ${cc.join(", ")}`,
						provenance: "effects",
					});
				}

				// delete vs read/write of the same resource -> effect-overlap (hard).
				const delHitsA = [...overlap(ea.deletes, eb.reads), ...overlap(ea.deletes, eb.writes)];
				const delHitsB = [...overlap(eb.deletes, ea.reads), ...overlap(eb.deletes, ea.writes)];
				const delHits = [...new Set([...delHitsA, ...delHitsB])].sort();
				if (delHits.length > 0) {
					record({
						a,
						b,
						type: "effect-overlap",
						severity: "hard",
						reason: `delete overlaps read/write: ${delHits.join(", ")}`,
						provenance: "effects",
					});
				}

				// Schema mismatch is only a conflict when the pair also contends on a
				// shared resource; a bare schema difference between unrelated
				// capabilities is NOT a conflict.
				if (isNonEmptyString(da.schemaId) && isNonEmptyString(db.schemaId) && da.schemaId !== db.schemaId) {
					if (ww.length > 0 || delHits.length > 0) {
						record({
							a,
							b,
							type: "schema-incompatible",
							severity: "soft",
							reason: `schema ${da.schemaId} vs ${db.schemaId} on shared resource`,
							provenance: "metadata",
						});
					}
				}

				// Environment incompatibility -> hard, but only when they must co-run
				// (share a resource/effect); otherwise different envs are independent.
				const envA = da.environment;
				const envB = db.environment;
				if (isNonEmptyString(envA) && isNonEmptyString(envB) && envA !== envB) {
					if (ww.length > 0 || delHits.length > 0) {
						record({
							a,
							b,
							type: "environment-incompatible",
							severity: "hard",
							reason: `env ${envA} vs ${envB} while sharing a resource`,
							provenance: "metadata",
						});
					}
				}

				// scope incompatibility -> soft (disjoint required scopes).
				if (da.scopes && db.scopes && da.scopes.length > 0 && db.scopes.length > 0) {
					if (overlap(da.scopes, db.scopes).length === 0 && (ww.length > 0 || delHits.length > 0)) {
						record({
							a,
							b,
							type: "scope-incompatible",
							severity: "soft",
							reason: "disjoint scopes while sharing a resource",
							provenance: "metadata",
						});
					}
				}
			}
		}

		return [...found.values()].sort(comparePairThenType);
	} catch {
		return [];
	}
}

/** Highest-authority (smallest index) lane supporting a descriptor; Infinity if none. */
function bestLaneRank(d: ConflictCapabilityDescriptor | undefined): number {
	if (!d?.supportedBy) return Number.POSITIVE_INFINITY;
	let best = Number.POSITIVE_INFINITY;
	for (const lane of d.supportedBy) {
		const idx = PRECEDENCE_LADDER.indexOf(lane);
		if (idx >= 0 && idx < best) best = idx;
	}
	return best;
}

function laneAt(rank: number): PrecedenceLane | "none" {
	const lane = rank >= 0 && rank < PRECEDENCE_LADDER.length ? PRECEDENCE_LADDER[rank] : undefined;
	return lane ?? "none";
}

/**
 * Resolve typed conflicts into suggested, human-gated decisions.
 * Pure, observe-only, fail-open, deterministic.
 */
export function resolveConflicts(
	conflicts: readonly CapabilityConflict[],
	descriptors: readonly ConflictCapabilityDescriptor[],
	options: ConflictOptions = {},
): ConflictResolutionResult {
	if (options.enabled !== true) return inert();
	try {
		const byId = new Map<string, ConflictCapabilityDescriptor>();
		for (const d of descriptors ?? []) {
			if (d && isNonEmptyString(d.id) && !byId.has(d.id)) byId.set(d.id, d);
		}

		const decisions: ConflictDecision[] = [];
		for (const c of conflicts ?? []) {
			if (!c || !isNonEmptyString(c.a) || !isNonEmptyString(c.b)) continue;
			const da = byId.get(c.a);
			const db = byId.get(c.b);

			// Soft conflicts: keep both, recommend a primary (higher authority).
			if (c.severity === "soft") {
				const ra = bestLaneRank(da);
				const rb = bestLaneRank(db);
				const primary = rb < ra ? c.b : c.a; // id tie-break favours a
				decisions.push({
					a: c.a,
					b: c.b,
					type: c.type,
					severity: "soft",
					action: "keep-both",
					keep: primary,
					decidedBy: ra === rb ? "tie" : laneAt(Math.min(ra, rb)),
					reason: `soft ${c.type}; keep both, primary ${primary}`,
				});
				continue;
			}

			// Hard conflicts.
			const aSafety = da?.safetyCritical === true;
			const bSafety = db?.safetyCritical === true;

			// Two safety-critical caps in a hard conflict: NEVER auto-resolve.
			if (aSafety && bSafety) {
				decisions.push({
					a: c.a,
					b: c.b,
					type: c.type,
					severity: "hard",
					action: "ask-user",
					decidedBy: "safety-standoff",
					reason: `hard ${c.type} between two safety-critical capabilities; human decision required`,
				});
				continue;
			}

			const ra = bestLaneRank(da);
			const rb = bestLaneRank(db);

			// A safety-critical cap can never be the one dropped.
			let winner: string | null = null;
			let decidedBy: PrecedenceLane | "tie" | "none" = "none";
			if (aSafety && !bSafety) {
				winner = c.a;
				decidedBy = "safety";
			} else if (bSafety && !aSafety) {
				winner = c.b;
				decidedBy = "safety";
			} else if (ra < rb) {
				winner = c.a;
				decidedBy = laneAt(ra);
			} else if (rb < ra) {
				winner = c.b;
				decidedBy = laneAt(rb);
			} else {
				// Equal authority (incl. both unsupported): cannot pick safely.
				winner = null;
				decidedBy = "tie";
			}

			if (winner === null) {
				decisions.push({
					a: c.a,
					b: c.b,
					type: c.type,
					severity: "hard",
					action: "ask-user",
					decidedBy: "tie",
					reason: `hard ${c.type} with no precedence separation; human decision required`,
				});
				continue;
			}

			const loser = winner === c.a ? c.b : c.a;
			const winnerDesc = byId.get(winner);

			// Prefer an alternative-to swap over a straight drop when the loser
			// declares an alternative (keeps both intents).
			const loserAlts = byId.get(loser)?.alternativeTo ?? [];
			const swapTarget = loserAlts.find(alt => isNonEmptyString(alt) && alt !== winner);
			if (isNonEmptyString(swapTarget)) {
				decisions.push({
					a: c.a,
					b: c.b,
					type: c.type,
					severity: "hard",
					action: "swap",
					keep: winner,
					drop: loser,
					replaceWith: swapTarget,
					decidedBy,
					reason: `hard ${c.type}; keep ${winner}, replace ${loser} with alternative ${swapTarget}`,
				});
				continue;
			}

			decisions.push({
				a: c.a,
				b: c.b,
				type: c.type,
				severity: "hard",
				action: "keep-winner",
				keep: winner,
				drop: loser,
				decidedBy,
				reason: `hard ${c.type}; keep ${winner} (via ${decidedBy}), suggest dropping ${loser}${
					winnerDesc?.safetyCritical ? " [winner is safety-critical]" : ""
				}`,
			});
		}

		decisions.sort(comparePairThenType);
		const needsUser = decisions.filter(d => d.action === "ask-user");
		return {
			mode: "observe",
			enabled: true,
			conflicts: [...(conflicts ?? [])],
			decisions,
			needsUser,
			truncated: false,
		};
	} catch {
		return inert();
	}
}

/**
 * Convenience: detect + resolve in one call over descriptors and edges.
 * Observe-only, human-gated, fail-open.
 */
export function analyzeCapabilityConflicts(
	descriptors: readonly ConflictCapabilityDescriptor[],
	edges: readonly CapabilityConflictEdge[],
	options: ConflictOptions = {},
): ConflictResolutionResult {
	if (options.enabled !== true) return inert();
	try {
		const conflicts = detectConflicts(descriptors, edges, options);
		return resolveConflicts(conflicts, descriptors, options);
	} catch {
		return inert();
	}
}
