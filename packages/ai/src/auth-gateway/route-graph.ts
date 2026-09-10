import * as AIError from "../error";
import type { GatewayErrorDisposition } from "../error/gateway";
import type { Api, Model } from "../types";
import type { AffinityLevel, StatePortability } from "./affinity";

export type TargetNode = { type: "target"; model: string; weight?: number };

export type FallbackNode = {
	type: "fallback";
	on: readonly GatewayErrorDisposition[];
	children: readonly RouteNode[];
};

export type BalanceNode = {
	type: "balance";
	strategy: "rr" | "weighted";
	children: readonly RouteNode[];
};

export type ConditionalNode = {
	type: "conditional";
	when: { vision?: boolean };
	children: readonly RouteNode[];
};

export type DomainNode = {
	type: "domain";
	name: string;
	children: readonly RouteNode[];
};

export type RouteRefNode = {
	type: "route-ref";
	route: string;
};

export type RouteNode = TargetNode | FallbackNode | BalanceNode | ConditionalNode | DomainNode | RouteRefNode;

export interface RouteDefinition {
	id: string;
	root: RouteNode;
	affinity?: AffinityLevel;
	portability?: StatePortability;
}

export interface CompiledRoute {
	generation: number;
	id: string;
	root: RouteNode;
	/** DFS target model ids in visit order (primary first). */
	targets: readonly string[];
	/** Next unused target ids for this disposition; empty if none. */
	fallbacks: Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>;
	fallbackByTarget?: Readonly<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>>;
	affinity?: AffinityLevel;
	portability?: StatePortability;
}

type ResolveModel = (modelId: string) => Model<Api> | undefined;

type NodeCompile = {
	targets: string[];
	fallbacks: Partial<Record<GatewayErrorDisposition, string[]>>;
};

/**
 * Compiled-route registry: virtual fallback trees plus a single-target wrap for
 * concrete models. Unknown ids stay undefined (gateway 404). No YAML loader.
 */
export class RouteRegistry {
	#generation = 1;
	#resolveModel: ResolveModel;
	#routes = new Map<string, CompiledRoute>();
	#roundRobinPositions = new Map<string, number>();

	constructor(resolveModel: ResolveModel) {
		this.#resolveModel = resolveModel;
	}

	get generation(): number {
		return this.#generation;
	}

	/** Register/replace a virtual route. Bumps generation. Rejects cycles and empty fallback children. */
	register(definition: RouteDefinition): void {
		const compiled = compileDefinition(definition, id => this.#routes.get(id)?.root, this.#generation + 1);
		this.#generation += 1;
		this.#routes.set(definition.id, compiled);
		this.#roundRobinPositions.delete(definition.id);
	}

	/**
	 * Atomically replace every virtual route. Compiles all definitions first;
	 * on any throw, `#routes` and generation stay unchanged. Bumps generation once.
	 */
	replaceAll(defs: readonly RouteDefinition[]): void {
		const nextGeneration = this.#generation + 1;
		const pending = new Map<string, CompiledRoute>();
		for (const definition of defs) {
			const compiled = compileDefinition(
				definition,
				id => pending.get(id)?.root ?? this.#routes.get(id)?.root,
				nextGeneration,
			);
			pending.set(definition.id, compiled);
		}
		this.#generation = nextGeneration;
		this.#routes = pending;
		this.#roundRobinPositions.clear();
	}

	/** Registered virtual routes in insertion order. Concrete catalog wraps are omitted. */
	list(): readonly CompiledRoute[] {
		return [...this.#routes.values()];
	}

	/** Lookup a registered virtual route by id. Never wraps concrete catalog models. */
	get(id: string): CompiledRoute | undefined {
		return this.#routes.get(id);
	}

	/** Unregister a virtual route. Bumps generation on success. Returns false if not registered. */
	unregister(id: string): boolean {
		if (!this.#routes.delete(id)) return false;
		this.#roundRobinPositions.delete(id);
		this.#generation += 1;
		return true;
	}

	/** Advance a per-route cursor, shared by all endpoint formats in this gateway. */
	pickInitialTarget(compiled: CompiledRoute): string | undefined {
		const position = this.#roundRobinPositions.get(compiled.id) ?? 0;
		const target = pickInitialRouteTarget(compiled, position);
		if (compiled.targets.length > 0) this.#roundRobinPositions.set(compiled.id, position + 1);
		return target;
	}

	resolve(modelId: string, facts?: RouteRequestFacts): CompiledRoute | undefined {
		const virtual = this.#routes.get(modelId);
		if (virtual) return facts ? selectRouteForRequest(virtual, facts) : virtual;
		const model = this.#resolveModel(modelId);
		if (!model) return undefined;
		// Preserve provider-qualified ids (`openai/gpt-5`) so affinity / fallback
		// targets match the caller's route key, not the catalog's bare `model.id`.
		const id = modelId.includes("/") ? modelId : model.id;
		return {
			generation: this.#generation,
			id,
			root: { type: "target", model: id },
			targets: [id],
			fallbacks: {},
		};
	}
}

export interface RouteRequestFacts {
	vision: boolean;
}

/** Conditional children are the matching branch and an optional alternative. */
export function selectRouteForRequest(route: CompiledRoute, facts: RouteRequestFacts): CompiledRoute {
	const choose = (node: RouteNode): RouteNode => {
		if (node.type === "conditional") {
			if (node.children.length > 2)
				throw new AIError.ValidationError("Conditional routes accept a matching branch and optional alternative");
			const matches = node.when.vision === undefined || node.when.vision === facts.vision;
			const selected = node.children[matches ? 0 : 1];
			return selected ? choose(selected) : { type: "balance", strategy: "rr", children: [] };
		}
		if (node.type === "target" || node.type === "route-ref") return node;
		return { ...node, children: node.children.map(choose) };
	};
	return compileDefinition({ ...route, root: choose(route.root) }, () => undefined, route.generation);
}

function compileDefinition(
	definition: RouteDefinition,
	lookup: (id: string) => RouteNode | undefined,
	generation: number,
): CompiledRoute {
	const root = resolveRouteRefs(definition.root, lookup);
	const compiled = compileNode(root, new Set());
	return {
		generation,
		id: definition.id,
		root: copyNode(root),
		targets: Object.freeze([...compiled.targets]),
		fallbacks: freezeFallbacks(compiled.fallbacks),
		fallbackByTarget: compileScopedFallbacks(root),
		...(definition.affinity !== undefined ? { affinity: definition.affinity } : {}),
		...(definition.portability !== undefined ? { portability: { ...definition.portability } } : {}),
	};
}

function compileScopedFallbacks(root: RouteNode): NonNullable<CompiledRoute["fallbackByTarget"]> {
	type Edges = Partial<Record<GatewayErrorDisposition, string[]>>;
	const byTarget = new Map<string, Edges>();
	const entries = (node: RouteNode): string[] => {
		if (node.type === "target") return [node.model];
		if (node.type === "route-ref") return [];
		if (node.type === "balance") return node.children.flatMap(entries);
		return node.children[0] ? entries(node.children[0]) : [];
	};
	const walk = (node: RouteNode, inherited: Edges): void => {
		if (node.type === "target") {
			const edges: Edges = {};
			for (const key of Object.keys(inherited) as GatewayErrorDisposition[]) {
				const candidates = [...new Set(inherited[key])].filter(id => id !== node.model);
				if (candidates.length) edges[key] = candidates;
			}
			const previous = byTarget.get(node.model);
			if (previous && !Bun.deepEquals(previous, edges))
				throw new AIError.ValidationError(`Ambiguous fallback contexts for model "${node.model}"`);
			byTarget.set(node.model, edges);
			return;
		}
		if (node.type === "route-ref") return;
		for (let i = 0; i < node.children.length; i++) {
			const next: Edges = { ...inherited };
			if (node.type === "fallback") {
				const later = node.children.slice(i + 1).flatMap(entries);
				for (const key of node.on) next[key] = [...later, ...(inherited[key] ?? [])];
			} else if (node.type === "balance") {
				const siblings = node.children.filter((_, index) => index !== i).flatMap(entries);
				for (const key of Object.keys(inherited) as GatewayErrorDisposition[])
					next[key] = [...siblings, ...(inherited[key] ?? [])];
			}
			walk(node.children[i]!, next);
		}
	};
	walk(root, {});
	return Object.freeze(Object.fromEntries([...byTarget].map(([id, edges]) => [id, freezeFallbacks(edges)])));
}

function resolveRouteRefs(node: RouteNode, lookup: (id: string) => RouteNode | undefined): RouteNode {
	switch (node.type) {
		case "route-ref": {
			const resolved = lookup(node.route);
			if (resolved === undefined) {
				throw new AIError.ValidationError("Unresolved route-ref");
			}
			return copyNode(resolved);
		}
		case "target":
			return node.weight === undefined
				? { type: "target", model: node.model }
				: { type: "target", model: node.model, weight: node.weight };
		case "fallback":
			return {
				type: "fallback",
				on: node.on,
				children: node.children.map(child => resolveRouteRefs(child, lookup)),
			};
		case "balance":
			return {
				type: "balance",
				strategy: node.strategy,
				children: node.children.map(child => resolveRouteRefs(child, lookup)),
			};
		case "conditional":
			return {
				type: "conditional",
				when: { ...node.when },
				children: node.children.map(child => resolveRouteRefs(child, lookup)),
			};
		case "domain":
			return {
				type: "domain",
				name: node.name,
				children: node.children.map(child => resolveRouteRefs(child, lookup)),
			};
	}
}

function compileNode(node: RouteNode, seenOnPath: ReadonlySet<string>): NodeCompile {
	switch (node.type) {
		case "target": {
			if (seenOnPath.has(node.model)) {
				throw new AIError.ValidationError(`Route cycle: model "${node.model}" repeats on one path`);
			}
			return { targets: [node.model], fallbacks: {} };
		}
		case "route-ref":
			throw new AIError.ValidationError("Unresolved route-ref");
		case "fallback":
			return compileFallback(node, seenOnPath);
		case "balance":
		case "conditional":
		case "domain":
			return compileFlatten(node.children, seenOnPath);
	}
}

function compileFallback(node: FallbackNode, seenOnPath: ReadonlySet<string>): NodeCompile {
	if (node.children.length === 0) {
		throw new AIError.ValidationError("Fallback node has empty children");
	}

	const targets: string[] = [];
	const fallbacks: Partial<Record<GatewayErrorDisposition, string[]>> = {};
	const afterPrimary: string[] = [];
	const sequential = new Set(seenOnPath);
	let primary = true;
	for (const child of node.children) {
		// Independent ancestor copy per sibling. Fallback subtrees must not
		// inherit sequential sibling targets — those are other leaves.
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen);
		targets.push(...part.targets);
		if (!primary) afterPrimary.push(...part.targets);
		else afterPrimary.push(...initialBalancedTargets(child));
		mergeFallbacks(fallbacks, part.fallbacks);
		if (child.type === "target") sequential.add(child.model);
		primary = false;
	}
	for (const disposition of node.on) {
		if (afterPrimary.length === 0) continue;
		const existing = fallbacks[disposition];
		fallbacks[disposition] = [...new Set([...afterPrimary, ...(existing ?? [])])];
	}
	return { targets, fallbacks };
}

function compileFlatten(children: readonly RouteNode[], seenOnPath: ReadonlySet<string>): NodeCompile {
	const targets: string[] = [];
	const fallbacks: Partial<Record<GatewayErrorDisposition, string[]>> = {};
	const sequential = new Set(seenOnPath);
	for (const child of children) {
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen);
		targets.push(...part.targets);
		mergeFallbacks(fallbacks, part.fallbacks);
		if (child.type === "target") sequential.add(child.model);
	}
	return { targets, fallbacks };
}

function copyNode(node: RouteNode): RouteNode {
	switch (node.type) {
		case "target":
			return node.weight === undefined
				? { type: "target", model: node.model }
				: { type: "target", model: node.model, weight: node.weight };
		case "fallback":
			return {
				type: "fallback",
				on: Object.freeze([...node.on]),
				children: Object.freeze(node.children.map(copyNode)),
			};
		case "balance":
			return {
				type: "balance",
				strategy: node.strategy,
				children: Object.freeze(node.children.map(copyNode)),
			};
		case "conditional":
			return {
				type: "conditional",
				when: Object.freeze({ ...node.when }),
				children: Object.freeze(node.children.map(copyNode)),
			};
		case "domain":
			return {
				type: "domain",
				name: node.name,
				children: Object.freeze(node.children.map(copyNode)),
			};
		case "route-ref":
			return { type: "route-ref", route: node.route };
	}
}

function mergeFallbacks(
	dest: Partial<Record<GatewayErrorDisposition, string[]>>,
	src: Partial<Record<GatewayErrorDisposition, string[]>>,
): void {
	for (const key of Object.keys(src) as GatewayErrorDisposition[]) {
		const extra = src[key];
		if (!extra || extra.length === 0) continue;
		const existing = dest[key];
		dest[key] = existing ? [...existing, ...extra] : [...extra];
	}
}

function freezeFallbacks(
	fallbacks: Partial<Record<GatewayErrorDisposition, string[]>>,
): Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>> {
	const out: Partial<Record<GatewayErrorDisposition, readonly string[]>> = {};
	for (const key of Object.keys(fallbacks) as GatewayErrorDisposition[]) {
		const list = fallbacks[key];
		if (!list || list.length === 0) continue;
		out[key] = Object.freeze([...list]);
	}
	return Object.freeze(out);
}

/** Choose the first dispatch target, honouring a root balance strategy when present. */
function initialBalancedTargets(node: RouteNode): string[] {
	if (node.type === "target" || node.type === "route-ref") return [];
	if (node.type === "balance") return compileNode(node, new Set()).targets;
	return node.children[0] ? initialBalancedTargets(node.children[0]) : [];
}

export function pickInitialRouteTarget(compiled: CompiledRoute, salt = 0): string | undefined {
	const choose = (node: RouteNode): string | undefined => {
		if (node.type === "target") return node.model;
		if (node.type === "route-ref" || node.children.length === 0) return undefined;
		let selected = node.children[0]!;
		if (node.type === "balance") {
			if (node.strategy === "rr") selected = node.children[Math.abs(salt) % node.children.length]!;
			else
				for (const child of node.children) {
					const weight = child.type === "target" ? (child.weight ?? 1) : 1;
					const selectedWeight = selected.type === "target" ? (selected.weight ?? 1) : 1;
					if (weight > selectedWeight) selected = child;
				}
		}
		return choose(selected);
	};
	return choose(compiled.root);
}
