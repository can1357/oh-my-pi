/**
 * Capability cycle analysis — ordering safety for the capability graph.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY hardening of the cycle detection
 * that `capability-bundle.ts` only stubs. The bundle expander detects cycles
 * over `requires` alone and reports a flat *set* of participating ids. This
 * module upgrades that to a full ordering-cycle taxonomy over the extended
 * edge model the capability retriever needs:
 *
 *   - Multiple ordering edge kinds — `requires`, `consumes-output-of`
 *     (mandatory) and `recommended-before` / `recommended-after` (advisory).
 *   - Mandatory vs advisory classification — a cycle made only of mandatory
 *     edges is unbreakable and blocks ordering; a cycle that includes an
 *     advisory edge can be broken by dropping the advisory edge.
 *   - Reconstructed cycle *paths* (not just a node set), normalized to a stable
 *     rotation (lexicographically smallest node first) for dedup / diagnostics.
 *   - A Kahn's-algorithm second check over the mandatory sub-graph that both
 *     confirms acyclicity independently of the DFS and yields a topological
 *     order when one exists.
 *   - Two entry points for the two moments the retriever must validate:
 *     registration time (whole declared graph) and retrieval time (only the
 *     sub-graph reachable from the seeds being expanded).
 *
 * Scope (this file): pure graph analysis over an injected edge list. Never
 * parses descriptors, never mutates a graph/registry, never executes. Conflict
 * detection/resolution and seed production live in sibling modules.
 *
 * Discipline: disabled-by-default, observe-only, fail-open, additive (not
 * wired into `index.ts`), deterministic (sorted adjacency + id tie-breaks; no
 * clocks).
 */

/** A directed capability edge as declared in the graph (kind is free-form). */
export interface CapabilityEdgeInput {
	from: string;
	to: string;
	kind: string;
}

export type OrderingDirection = "dependency" | "precedes";

/**
 * How each ordering edge maps onto a *precedence* edge `u => v` ("u must run
 * before v"). `dependency` (A requires B) means B precedes A; `precedes`
 * (A recommended-before B) means A precedes B.
 */
export const DEFAULT_ORDERING_KINDS: Record<string, { mandatory: boolean; direction: OrderingDirection }> = {
	requires: { mandatory: true, direction: "dependency" },
	"consumes-output-of": { mandatory: true, direction: "dependency" },
	"recommended-after": { mandatory: false, direction: "dependency" },
	"recommended-before": { mandatory: false, direction: "precedes" },
};

export interface CapabilityCycle {
	/** Cycle node ids, normalized so the smallest id is first (cyclic order kept). */
	nodeIds: string[];
	/** The ordering edge kinds traversed around the cycle. */
	edgeKinds: string[];
	/** True when every edge in the cycle is mandatory (unbreakable ordering). */
	mandatory: boolean;
}

export interface CycleAnalysis {
	mode: "observe";
	enabled: boolean;
	/** True when the MANDATORY sub-graph has no cycle (Kahn processed all nodes). */
	acyclic: boolean;
	/** Representative simple cycles found over all ordering edges (diagnostic). */
	cycles: CapabilityCycle[];
	mandatoryCycles: CapabilityCycle[];
	advisoryCycles: CapabilityCycle[];
	hasMandatoryCycle: boolean;
	/** Topological order over mandatory edges (id-tie-broken); null if cyclic. */
	topologicalOrder: string[] | null;
	nodeCount: number;
	/** True if a budget guard (`maxNodes`/`maxCycles`) stopped the walk early. */
	truncated: boolean;
}

export interface CycleAnalysisOptions {
	/** Disabled by default. When false an inert (acyclic/empty) result is returned. */
	enabled?: boolean;
	/** Override the ordering-kind table (kind -> {mandatory, direction}). */
	orderingKinds?: Record<string, { mandatory: boolean; direction: OrderingDirection }>;
	/** Max distinct nodes to consider. Default 512. */
	maxNodes?: number;
	/** Max cycles to reconstruct. Default 64. */
	maxCycles?: number;
}

const DEFAULT_MAX_NODES = 512;
const DEFAULT_MAX_CYCLES = 64;

/** DFS colors: unvisited, on the current path, and fully explored. */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

interface PrecedenceEdge {
	to: string;
	mandatory: boolean;
	kind: string;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function inert(): CycleAnalysis {
	return {
		mode: "observe",
		enabled: false,
		acyclic: true,
		cycles: [],
		mandatoryCycles: [],
		advisoryCycles: [],
		hasMandatoryCycle: false,
		topologicalOrder: [],
		nodeCount: 0,
		truncated: false,
	};
}

/** Rotate a cycle's nodes so the smallest id leads; rotate edge kinds in step. */
function normalizeCycle(nodeIds: string[], edgeKinds: string[]): { nodeIds: string[]; edgeKinds: string[] } {
	if (nodeIds.length === 0) return { nodeIds, edgeKinds };
	let minIdx = 0;
	for (let i = 1; i < nodeIds.length; i++) {
		if (nodeIds[i] < nodeIds[minIdx]) minIdx = i;
	}
	const n = nodeIds.length;
	const rotatedNodes = nodeIds.map((_, i) => nodeIds[(minIdx + i) % n]);
	// edgeKinds[i] connects nodeIds[i] -> nodeIds[(i+1)%n]; rotate identically.
	const rotatedKinds = edgeKinds.map((_, i) => edgeKinds[(minIdx + i) % n]);
	return { nodeIds: rotatedNodes, edgeKinds: rotatedKinds };
}

/**
 * Analyse ordering cycles over an injected edge list. Pure, observe-only,
 * fail-open, deterministic. Returns an inert (acyclic) result when disabled.
 */
export function analyzeCapabilityCycles(
	edges: readonly CapabilityEdgeInput[],
	options: CycleAnalysisOptions = {},
): CycleAnalysis {
	if (options.enabled !== true) return inert();

	try {
		const kinds = options.orderingKinds ?? DEFAULT_ORDERING_KINDS;
		const maxNodes = positiveIntOr(options.maxNodes, DEFAULT_MAX_NODES);
		const maxCycles = positiveIntOr(options.maxCycles, DEFAULT_MAX_CYCLES);

		// Build precedence adjacency (u => v = "u before v") from ordering edges.
		const adj = new Map<string, PrecedenceEdge[]>();
		const nodes = new Set<string>();
		let truncated = false;

		const addNode = (id: string): boolean => {
			if (nodes.has(id)) return true;
			if (nodes.size >= maxNodes) {
				truncated = true;
				return false;
			}
			nodes.add(id);
			if (!adj.has(id)) adj.set(id, []);
			return true;
		};

		for (const edge of edges ?? []) {
			if (!edge || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) continue;
			if (edge.from === edge.to) continue;
			const spec = kinds[edge.kind];
			if (!spec) continue; // non-ordering edge kind: ignored for cycles
			if (!addNode(edge.from) || !addNode(edge.to)) continue;
			// dependency: to precedes from (to => from). precedes: from => to.
			const [u, v] = spec.direction === "dependency" ? [edge.to, edge.from] : [edge.from, edge.to];
			const list = adj.get(u) ?? [];
			list.push({ to: v, mandatory: spec.mandatory, kind: edge.kind });
			adj.set(u, list);
		}

		// Deterministic adjacency ordering.
		for (const list of adj.values()) {
			list.sort((a, b) => a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
		}
		const sortedNodes = [...nodes].sort();

		// --- DFS cycle reconstruction over ALL ordering edges (diagnostic) ---
		const color = new Map<string, number>();
		for (const n of sortedNodes) color.set(n, WHITE);
		const path: string[] = [];
		const pathEdgeKind: string[] = []; // pathEdgeKind[i] connects path[i-1] -> path[i]
		const pathEdgeMand: boolean[] = [];
		const seenCycles = new Set<string>();
		const cycles: CapabilityCycle[] = [];

		const recordCycle = (startIdx: number, closingKind: string, closingMand: boolean): void => {
			const nodeIds = path.slice(startIdx);
			// edges within: pathEdgeKind[startIdx+1..end], plus closing edge back to start.
			const edgeKinds = pathEdgeKind.slice(startIdx + 1);
			const edgeMand = pathEdgeMand.slice(startIdx + 1);
			edgeKinds.push(closingKind);
			edgeMand.push(closingMand);
			const norm = normalizeCycle(nodeIds, edgeKinds);
			const sig = norm.nodeIds.join("\u0000");
			if (seenCycles.has(sig)) return;
			seenCycles.add(sig);
			cycles.push({
				nodeIds: norm.nodeIds,
				edgeKinds: norm.edgeKinds,
				mandatory: edgeMand.every(Boolean),
			});
		};

		const dfs = (node: string): void => {
			if (cycles.length >= maxCycles) {
				truncated = true;
				return;
			}
			color.set(node, GRAY);
			for (const e of adj.get(node) ?? []) {
				if (cycles.length >= maxCycles) {
					truncated = true;
					break;
				}
				const c = color.get(e.to);
				if (c === GRAY) {
					const idx = path.lastIndexOf(e.to);
					if (idx !== -1) recordCycle(idx, e.kind, e.mandatory);
				} else if (c === WHITE) {
					path.push(e.to);
					pathEdgeKind.push(e.kind);
					pathEdgeMand.push(e.mandatory);
					dfs(e.to);
					path.pop();
					pathEdgeKind.pop();
					pathEdgeMand.pop();
				}
			}
			color.set(node, BLACK);
		};

		for (const start of sortedNodes) {
			if (color.get(start) === WHITE) {
				path.push(start);
				pathEdgeKind.push("");
				pathEdgeMand.push(true);
				dfs(start);
				path.pop();
				pathEdgeKind.pop();
				pathEdgeMand.pop();
			}
		}

		const mandatoryCycles = cycles.filter(c => c.mandatory);
		const advisoryCycles = cycles.filter(c => !c.mandatory);

		// --- Kahn's algorithm over the MANDATORY sub-graph (authoritative) ---
		const mandAdj = new Map<string, string[]>();
		const indeg = new Map<string, number>();
		for (const n of sortedNodes) {
			mandAdj.set(n, []);
			indeg.set(n, 0);
		}
		for (const [u, list] of adj) {
			for (const e of list) {
				if (!e.mandatory) continue;
				const targets = mandAdj.get(u) ?? [];
				targets.push(e.to);
				mandAdj.set(u, targets);
				indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
			}
		}
		const queue = sortedNodes.filter(n => (indeg.get(n) ?? 0) === 0).sort();
		const topo: string[] = [];
		while (queue.length > 0) {
			const n = queue.shift();
			if (n === undefined) break;
			topo.push(n);
			const next: string[] = [];
			for (const m of mandAdj.get(n) ?? []) {
				indeg.set(m, (indeg.get(m) ?? 0) - 1);
				if ((indeg.get(m) ?? 0) === 0) next.push(m);
			}
			// keep the queue sorted for a deterministic topological order
			for (const m of next.sort()) queue.push(m);
			queue.sort();
		}
		const acyclic = topo.length === sortedNodes.length;

		return {
			mode: "observe",
			enabled: true,
			acyclic,
			cycles,
			mandatoryCycles,
			advisoryCycles,
			hasMandatoryCycle: mandatoryCycles.length > 0 || !acyclic,
			topologicalOrder: acyclic ? topo : null,
			nodeCount: sortedNodes.length,
			truncated,
		};
	} catch {
		return inert();
	}
}

/**
 * Registration-time check: validate the whole declared edge set. Use when a
 * capability (or SKILL.md) is registered so a bad edge is caught at the source.
 */
export function validateGraphAtRegistration(
	edges: readonly CapabilityEdgeInput[],
	options: CycleAnalysisOptions = {},
): CycleAnalysis {
	return analyzeCapabilityCycles(edges, options);
}

/**
 * Retrieval-time check: validate only the sub-graph reachable from the given
 * seeds via ordering edges (both directions), so expanding those seeds cannot
 * walk into a cycle. Reachability is bounded by `maxNodes`.
 */
export function validateSeedsAtRetrieval(
	edges: readonly CapabilityEdgeInput[],
	seedIds: readonly string[],
	options: CycleAnalysisOptions = {},
): CycleAnalysis {
	if (options.enabled !== true) return inert();
	try {
		const kinds = options.orderingKinds ?? DEFAULT_ORDERING_KINDS;
		const maxNodes = positiveIntOr(options.maxNodes, DEFAULT_MAX_NODES);

		// Undirected adjacency over ordering edges for reachability.
		const undirected = new Map<string, Set<string>>();
		const link = (a: string, b: string) => {
			const set = undirected.get(a) ?? new Set<string>();
			set.add(b);
			undirected.set(a, set);
		};
		for (const edge of edges ?? []) {
			if (!edge || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) continue;
			if (!kinds[edge.kind]) continue;
			link(edge.from, edge.to);
			link(edge.to, edge.from);
		}

		const reachable = new Set<string>();
		const stack: string[] = [];
		for (const s of seedIds ?? []) {
			if (isNonEmptyString(s) && !reachable.has(s)) {
				reachable.add(s);
				stack.push(s);
			}
		}
		while (stack.length > 0 && reachable.size < maxNodes) {
			const n = stack.pop();
			if (n === undefined) break;
			for (const m of undirected.get(n) ?? []) {
				if (!reachable.has(m)) {
					reachable.add(m);
					stack.push(m);
				}
			}
		}

		const induced = (edges ?? []).filter(e => {
			if (!e || !isNonEmptyString(e.from) || !isNonEmptyString(e.to)) return false;
			return reachable.has(e.from) && reachable.has(e.to);
		});
		return analyzeCapabilityCycles(induced, options);
	} catch {
		return inert();
	}
}
