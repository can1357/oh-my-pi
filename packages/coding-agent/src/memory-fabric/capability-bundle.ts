/**
 * Capability Bundle — execution-complete expansion.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY continuation of the capability
 * graph. Given a set of seed capability ids (e.g. from RRF-seeded retrieval),
 * it walks the `requires` edges to produce an *execution-complete* bundle —
 * the seeds plus every prerequisite needed to actually run them, ordered
 * prerequisites-first — and annotates the companion `validates` / `rolls-back`
 * capabilities and any `conflicts-with` collisions.
 *
 * Scope (this file):
 *   - Transitive `requires` closure over seeds (cycle-safe, budget-guarded).
 *   - Companion `validates` / `rolls-back` collection (+ their prerequisites).
 *   - Conflict + missing-target reporting (measure, do not mutate).
 * Explicitly NOT here:
 *   - Any execution, planning, ranking, or fidelity mapping.
 *   - Any mutation of the graph, registry, or descriptors.
 *
 * Discipline:
 *   - Observe-only — always returns `mode: "observe"`; nothing is executed.
 *   - Inert when the graph is disabled — a disabled graph yields empty edges,
 *     so the bundle is just the seeds themselves.
 *   - Fail-open — any error yields a seeds-only bundle; never throws.
 */

import type { CapabilityGraph } from "./capability-graph";

export interface ExpandOptions {
	/** Upper bound on total bundle size; extra nodes are dropped and `truncated` set. */
	maxNodes?: number;
	/** Also pull prerequisites of validation/rollback companions. Default: true. */
	includeCompanionRequires?: boolean;
}

export interface BundleConflict {
	a: string;
	b: string;
}

export interface ExecutionCompleteBundle {
	mode: "observe";
	/** The input seed ids (order preserved, de-duplicated). */
	seeds: string[];
	/** Full bundle, ordered prerequisites-first (topological over `requires`). */
	included: string[];
	/** Prerequisite ids added beyond the seeds via `requires`. */
	prerequisites: string[];
	/** Companion validation capability ids referenced by included nodes. */
	validations: string[];
	/** Companion rollback capability ids referenced by included nodes. */
	rollbacks: string[];
	/** Pairs of included capabilities that declare a mutual `conflicts-with`. */
	conflicts: BundleConflict[];
	/** Included ids that were never registered as capabilities (dangling `requires`). */
	missing: string[];
	/** True if the bundle hit `maxNodes` and was truncated. */
	truncated: boolean;
	/** Seed/prerequisite ids that participate in a `requires` cycle, if any. */
	cycles: string[];
}

const DEFAULT_MAX_NODES = 128;

function uniquePreserveOrder(ids: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * Expand a set of seed capabilities into an execution-complete bundle.
 * Pure, observe-only, fail-open. A disabled graph naturally yields seeds only.
 */
export function expandExecutionComplete(
	graph: CapabilityGraph,
	seedIds: readonly string[],
	options: ExpandOptions = {},
): ExecutionCompleteBundle {
	const seeds = uniquePreserveOrder(seedIds ?? []);
	const maxNodes =
		Number.isFinite(options.maxNodes) && (options.maxNodes as number) > 0
			? Math.floor(options.maxNodes as number)
			: DEFAULT_MAX_NODES;
	const includeCompanionRequires = options.includeCompanionRequires !== false;

	const seedsOnly = (): ExecutionCompleteBundle => ({
		mode: "observe",
		seeds,
		included: [...seeds],
		prerequisites: [],
		validations: [],
		rollbacks: [],
		conflicts: [],
		missing: [],
		truncated: false,
		cycles: [],
	});

	try {
		const order: string[] = [];
		const placed = new Set<string>();
		const cycles = new Set<string>();
		let truncated = false;

		// Post-order DFS over `requires`: a node is appended only after its
		// prerequisites, so `order` ends up prerequisites-first. `onStack`
		// guards against cycles; `permanent` marks fully-processed nodes.
		const permanent = new Set<string>();
		const visit = (root: string): void => {
			const stack: Array<{ id: string; reqs: string[]; idx: number }> = [
				{ id: root, reqs: graph.neighbors(root, "requires"), idx: 0 },
			];
			const onStack = new Set<string>([root]);

			while (stack.length > 0) {
				const frame = stack[stack.length - 1];
				if (frame.idx < frame.reqs.length) {
					const next = frame.reqs[frame.idx++];
					if (permanent.has(next)) continue;
					if (onStack.has(next)) {
						cycles.add(next);
						cycles.add(frame.id);
						continue;
					}
					if (order.length + stack.length >= maxNodes) {
						truncated = true;
						continue;
					}
					onStack.add(next);
					stack.push({ id: next, reqs: graph.neighbors(next, "requires"), idx: 0 });
				} else {
					stack.pop();
					onStack.delete(frame.id);
					permanent.add(frame.id);
					if (!placed.has(frame.id)) {
						if (order.length >= maxNodes) {
							truncated = true;
						} else {
							order.push(frame.id);
							placed.add(frame.id);
						}
					}
				}
			}
		};

		for (const seed of seeds) {
			if (!permanent.has(seed)) visit(seed);
		}

		// Core bundle so far = seeds + their transitive prerequisites.
		const coreIncluded = [...order];

		// Companions: validation + rollback capabilities of every core node.
		const validations: string[] = [];
		const rollbacks: string[] = [];
		for (const id of coreIncluded) {
			for (const v of graph.neighbors(id, "validates")) validations.push(v);
			for (const r of graph.neighbors(id, "rolls-back")) rollbacks.push(r);
		}
		const validationSet = uniquePreserveOrder(validations);
		const rollbackSet = uniquePreserveOrder(rollbacks);

		// Optionally make companions runnable too (expand their prerequisites).
		if (includeCompanionRequires) {
			for (const companion of [...validationSet, ...rollbackSet]) {
				if (!permanent.has(companion)) visit(companion);
			}
		} else {
			for (const companion of [...validationSet, ...rollbackSet]) {
				if (placed.has(companion)) continue;
				if (order.length >= maxNodes) {
					truncated = true;
					continue;
				}
				order.push(companion);
				placed.add(companion);
			}
		}

		const included = order;

		// Conflicts among everything we included (measure only — nothing dropped).
		const conflicts: BundleConflict[] = [];
		for (let i = 0; i < included.length; i++) {
			for (let j = i + 1; j < included.length; j++) {
				if (graph.hasConflict(included[i], included[j])) {
					conflicts.push({ a: included[i], b: included[j] });
				}
			}
		}

		// Missing = included ids that were never registered (dangling requires).
		const danglingSet = new Set(graph.danglingTargets());
		const missing = included.filter(id => danglingSet.has(id));

		const seedSet = new Set(seeds);
		const prerequisites = included.filter(
			id => !seedSet.has(id) && !validationSet.includes(id) && !rollbackSet.includes(id),
		);

		return {
			mode: "observe",
			seeds,
			included,
			prerequisites,
			validations: validationSet,
			rollbacks: rollbackSet,
			conflicts,
			missing,
			truncated,
			cycles: [...cycles],
		};
	} catch {
		// Fail-open: never let bundle expansion break a caller.
		return seedsOnly();
	}
}
