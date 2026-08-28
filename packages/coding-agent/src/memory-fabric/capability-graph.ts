/**
 * Capability Graph — read-only dependency edge model.
 *
 * Additive, disabled-by-default extension of `capability-orchestration.ts`.
 * Models dependency edges between capabilities so bundle expansion can
 * retrieve an "execution-complete" set (a seed capability plus everything it
 * needs to run) instead of a flat lexical hit list.
 *
 * Scope (this file):
 *   - Static edge parsing from `CapabilityDescriptor.metadata` (no inference).
 *   - Read-only edge queries (neighbors, incoming, by-kind, conflict check).
 * Explicitly NOT here:
 *   - Traversal / execution-complete expansion (capability-bundle.ts).
 *   - Any execution, planning, or mutation of the CapabilityCache.
 *
 * Discipline:
 *   - Disabled by default (`enabled` defaults to `false`) — when disabled every
 *     query returns empty and nothing is parsed.
 *   - Fail-open — malformed metadata is skipped; queries never throw.
 *   - Additive — imports only the `CapabilityDescriptor` type; no hot-path edits.
 */

import type { CapabilityDescriptor } from "./capability-orchestration";

export type CapabilityEdgeKind = "requires" | "validates" | "rolls-back" | "conflicts-with" | "commonly-used-with";

/**
 * Symmetric edges describe a mutual relationship (order does not matter);
 * directional edges describe a one-way dependency (A requires B, not vice versa).
 */
const SYMMETRIC_EDGE_KINDS: ReadonlySet<CapabilityEdgeKind> = new Set(["conflicts-with", "commonly-used-with"]);

const KNOWN_EDGE_KINDS: ReadonlySet<CapabilityEdgeKind> = new Set([
	"requires",
	"validates",
	"rolls-back",
	"conflicts-with",
	"commonly-used-with",
]);

/**
 * Shorthand metadata field name -> edge kind. Descriptors may declare edges
 * either via `metadata.edges` (canonical) or via these convenience arrays.
 */
const SHORTHAND_FIELD_TO_KIND: Record<string, CapabilityEdgeKind> = {
	requires: "requires",
	validates: "validates",
	rollsBack: "rolls-back",
	conflictsWith: "conflicts-with",
	commonlyUsedWith: "commonly-used-with",
};

export interface CapabilityEdge {
	from: string;
	to: string;
	kind: CapabilityEdgeKind;
	/** Only statically declared edges are derived here. */
	source: "static";
	/** Optional co-occurrence strength (used mainly by `commonly-used-with`). */
	weight?: number;
}

export interface CapabilityGraphOptions {
	/** Disabled by default. When false, nothing is ingested and queries are empty. */
	enabled?: boolean;
	/** Reject edges that complete mandatory cycles during registration/ingest. Default: false. */
	rejectRegistrationCycles?: boolean;
}

interface RawEdgeDeclaration {
	to?: unknown;
	kind?: unknown;
	weight?: unknown;
}

function edgeKey(edge: CapabilityEdge): string {
	return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function coerceWeight(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read-only projection of dependency edges over a set of capability descriptors.
 * Never mutates the descriptors or any registry; safe to construct at any time.
 */
export class CapabilityGraph {
	readonly #enabled: boolean;
	readonly #rejectRegistrationCycles: boolean;
	readonly #edges = new Map<string, CapabilityEdge>();
	readonly #knownIds = new Set<string>();
	readonly rejectedRegistrationEdges: Array<{ from: string; to: string; kind: CapabilityEdgeKind }> = [];

	constructor(options: CapabilityGraphOptions = {}) {
		this.#enabled = options.enabled === true;
		this.#rejectRegistrationCycles = options.rejectRegistrationCycles === true;
	}

	get isEnabled(): boolean {
		return this.#enabled;
	}

	/**
	 * Parse and store edges declared in the given descriptors' metadata.
	 * No-op when disabled. Fail-open: malformed entries are skipped silently.
	 */
	ingest(descriptors: readonly CapabilityDescriptor[]): this {
		if (!this.#enabled) return this;
		try {
			for (const descriptor of descriptors) {
				if (!descriptor || !isNonEmptyString(descriptor.id)) continue;
				this.#knownIds.add(descriptor.id);
				this.#parseDescriptorEdges(descriptor);
			}
		} catch {
			// Fail-open: partial graphs are acceptable; never throw to callers.
		}
		return this;
	}

	#parseDescriptorEdges(descriptor: CapabilityDescriptor): void {
		const metadata = descriptor.metadata;
		if (!metadata || typeof metadata !== "object") return;

		const canonical = (metadata as Record<string, unknown>).edges;
		if (Array.isArray(canonical)) {
			for (const raw of canonical) {
				this.#addRawEdge(descriptor.id, raw as RawEdgeDeclaration);
			}
		}

		for (const [field, kind] of Object.entries(SHORTHAND_FIELD_TO_KIND)) {
			const list = (metadata as Record<string, unknown>)[field];
			if (!Array.isArray(list)) continue;
			for (const entry of list) {
				if (isNonEmptyString(entry)) {
					this.#addEdge(descriptor.id, entry, kind);
				} else if (entry && typeof entry === "object") {
					const obj = entry as RawEdgeDeclaration;
					if (isNonEmptyString(obj.to)) {
						this.#addEdge(descriptor.id, obj.to, kind, coerceWeight(obj.weight));
					}
				}
			}
		}
	}

	#addRawEdge(from: string, raw: RawEdgeDeclaration): void {
		if (!raw || typeof raw !== "object") return;
		if (!isNonEmptyString(raw.to)) return;
		if (!isNonEmptyString(raw.kind)) return;
		const kind = raw.kind as CapabilityEdgeKind;
		if (!KNOWN_EDGE_KINDS.has(kind)) return;
		this.#addEdge(from, raw.to, kind, coerceWeight(raw.weight));
	}

	#addEdge(from: string, to: string, kind: CapabilityEdgeKind, weight?: number): void {
		if (from === to) return; // no self-edges
		if (this.#rejectRegistrationCycles && this.#wouldCreateMandatoryCycle(from, to, kind)) {
			this.rejectedRegistrationEdges.push({ from, to, kind });
			return;
		}
		const edge: CapabilityEdge = { from, to, kind, source: "static" };
		if (weight !== undefined) edge.weight = weight;
		this.#edges.set(edgeKey(edge), edge);
	}

	#wouldCreateMandatoryCycle(from: string, to: string, kind: CapabilityEdgeKind): boolean {
		if (kind !== "requires") return false;
		const visited = new Set<string>();
		const queue = [to];
		while (queue.length > 0) {
			const curr = queue.pop();
			if (curr === undefined) break;
			if (curr === from) return true;
			if (visited.has(curr)) continue;
			visited.add(curr);
			for (const edge of this.getEdges(curr, "requires")) {
				if (!visited.has(edge.to)) queue.push(edge.to);
			}
		}
		return false;
	}

	/** All stored edges (defensive copy). Empty when disabled. */
	listEdges(): CapabilityEdge[] {
		if (!this.#enabled) return [];
		return [...this.#edges.values()];
	}

	/**
	 * Outgoing edges declared from `id`. For symmetric kinds, also includes
	 * edges declared toward `id` (so a mutual relation is visible from both ends).
	 */
	getEdges(id: string, kind?: CapabilityEdgeKind): CapabilityEdge[] {
		if (!this.#enabled || !isNonEmptyString(id)) return [];
		const result: CapabilityEdge[] = [];
		for (const edge of this.#edges.values()) {
			if (kind && edge.kind !== kind) continue;
			if (edge.from === id) {
				result.push(edge);
			} else if (edge.to === id && SYMMETRIC_EDGE_KINDS.has(edge.kind)) {
				// Present the mirror of a symmetric edge from `id`'s perspective.
				result.push({ ...edge, from: id, to: edge.from });
			}
		}
		return result;
	}

	/** Edges that point at `id` (directional incoming). */
	getIncomingEdges(id: string, kind?: CapabilityEdgeKind): CapabilityEdge[] {
		if (!this.#enabled || !isNonEmptyString(id)) return [];
		const result: CapabilityEdge[] = [];
		for (const edge of this.#edges.values()) {
			if (kind && edge.kind !== kind) continue;
			if (edge.to === id) result.push(edge);
		}
		return result;
	}

	/** Neighbor ids reachable from `id` via edges of the given kind. */
	neighbors(id: string, kind: CapabilityEdgeKind): string[] {
		return [...new Set(this.getEdges(id, kind).map(e => e.to))];
	}

	/** All edges of a given kind across the graph. */
	getEdgesByKind(kind: CapabilityEdgeKind): CapabilityEdge[] {
		if (!this.#enabled) return [];
		return [...this.#edges.values()].filter(e => e.kind === kind);
	}

	/** Read-only conflict check (symmetric). */
	hasConflict(idA: string, idB: string): boolean {
		if (!this.#enabled || !isNonEmptyString(idA) || !isNonEmptyString(idB)) return false;
		for (const edge of this.#edges.values()) {
			if (edge.kind !== "conflicts-with") continue;
			if ((edge.from === idA && edge.to === idB) || (edge.from === idB && edge.to === idA)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Edge targets that were never registered as capabilities during `ingest`.
	 * Useful for validation (a `requires` pointing at a missing capability).
	 */
	danglingTargets(): string[] {
		if (!this.#enabled) return [];
		const missing = new Set<string>();
		for (const edge of this.#edges.values()) {
			if (!this.#knownIds.has(edge.to)) missing.add(edge.to);
		}
		return [...missing];
	}

	/** Read-only snapshot for observability/telemetry. */
	toJSON(): { enabled: boolean; edgeCount: number; edges: CapabilityEdge[]; danglingTargets: string[] } {
		return {
			enabled: this.#enabled,
			edgeCount: this.#enabled ? this.#edges.size : 0,
			edges: this.listEdges(),
			danglingTargets: this.danglingTargets(),
		};
	}

	/** Number of capabilities seen during ingest. */
	getNodeCount(): number {
		return this.#enabled ? this.#knownIds.size : 0;
	}

	/** Number of stored edges (excludes rejected registrations). */
	getEdgeCount(): number {
		return this.#enabled ? this.#edges.size : 0;
	}

	/**
	 * Number of back-edges found in one directed DFS over the edge graph — an
	 * indicator of cyclic structure, not an exact count of distinct cycles.
	 * Iterative traversal (stack-safe); O(V+E). Returns 0 when disabled.
	 */
	getCycleCount(): number {
		if (!this.#enabled) return 0;
		const adjacency = new Map<string, string[]>();
		for (const node of this.#knownIds) adjacency.set(node, []);
		for (const edge of this.#edges.values()) {
			const bucket = adjacency.get(edge.from);
			if (bucket) {
				bucket.push(edge.to);
			} else {
				adjacency.set(edge.from, [edge.to]);
			}
		}
		const visited = new Set<string>();
		const onStack = new Set<string>();
		let backEdges = 0;

		for (const root of adjacency.keys()) {
			if (visited.has(root)) continue;
			const stack: Array<{ id: string; next: string[]; idx: number }> = [
				{ id: root, next: adjacency.get(root) ?? [], idx: 0 },
			];
			visited.add(root);
			onStack.add(root);
			while (stack.length > 0) {
				const frame = stack[stack.length - 1];
				if (frame.idx < frame.next.length) {
					const target = frame.next[frame.idx++];
					if (onStack.has(target)) {
						backEdges++;
						continue;
					}
					if (visited.has(target)) continue;
					visited.add(target);
					onStack.add(target);
					stack.push({ id: target, next: adjacency.get(target) ?? [], idx: 0 });
				} else {
					stack.pop();
					onStack.delete(frame.id);
				}
			}
		}
		return backEdges;
	}

	/** Number of stored `conflicts-with` edges. */
	getConflictCount(): number {
		return this.getEdgesByKind("conflicts-with").length;
	}
}

/**
 * Convenience factory: build a graph and ingest descriptors in one call.
 * Disabled by default — callers must pass `{ enabled: true }` to opt in.
 */
export function createCapabilityGraph(
	descriptors: readonly CapabilityDescriptor[] = [],
	options: CapabilityGraphOptions = {},
): CapabilityGraph {
	return new CapabilityGraph(options).ingest(descriptors);
}
