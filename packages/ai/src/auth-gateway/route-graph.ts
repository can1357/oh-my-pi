import * as AIError from "../error";
import type { GatewayErrorDisposition } from "../error/gateway";
import type { Api, Model } from "../types";

export type TargetNode = { type: "target"; model: string };

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
}

export interface CompiledRoute {
	generation: number;
	id: string;
	root: RouteNode;
	/** DFS target model ids in visit order (primary first). */
	targets: readonly string[];
	/**
	 * Union of next unused target ids per disposition (listing / diagnostics).
	 * Runtime failover uses {@link fallbackByTarget} so nested rules stay scoped.
	 */
	fallbacks: Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>;
	/**
	 * From-target → disposition → next targets. Nested fallback edges only apply
	 * when the failing target is inside that fallback branch.
	 */
	fallbackByTarget: Readonly<
		Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>>
	>;
}

type ResolveModel = (modelId: string) => Model<Api> | undefined;

type NodeCompile = {
	targets: string[];
	/** disposition → fromTarget → tos */
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>;
};

/**
 * Compiled-route registry: virtual fallback trees plus a single-target wrap for
 * concrete models. Unknown ids stay undefined (gateway 404). No YAML loader.
 */
export class RouteRegistry {
	#generation = 1;
	#resolveModel: ResolveModel;
	#routes = new Map<string, CompiledRoute>();

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
		this.#generation += 1;
		return true;
	}

	resolve(modelId: string): CompiledRoute | undefined {
		const virtual = this.#routes.get(modelId);
		if (virtual) return virtual;
		const model = this.#resolveModel(modelId);
		if (!model) return undefined;
		const id = modelId.includes("/") ? modelId : model.id;
		return {
			generation: this.#generation,
			id,
			root: { type: "target", model: id },
			targets: [id],
			fallbacks: {},
			fallbackByTarget: {},
		};
	}
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
		fallbacks: freezeFallbacksUnion(compiled.fallbacksByFrom),
		fallbackByTarget: freezeFallbacksByTarget(compiled.fallbacksByFrom),
	};
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
			return { type: "target", model: node.model };
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
			return { targets: [node.model], fallbacksByFrom: {} };
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
	const fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>> = {};
	const afterPrimary: string[] = [];
	const primaryTargets: string[] = [];
	const sequential = new Set(seenOnPath);
	let primary = true;
	for (const child of node.children) {
		// Independent ancestor copy per sibling. Fallback subtrees must not
		// inherit sequential sibling targets — those are other leaves.
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen);
		targets.push(...part.targets);
		if (primary) primaryTargets.push(...part.targets);
		else afterPrimary.push(...part.targets);
		mergeFallbacksByFrom(fallbacksByFrom, part.fallbacksByFrom);
		if (child.type === "target") sequential.add(child.model);
		primary = false;
	}
	for (const disposition of node.on) {
		if (afterPrimary.length === 0) continue;
		let byFrom = fallbacksByFrom[disposition];
		if (!byFrom) {
			byFrom = {};
			fallbacksByFrom[disposition] = byFrom;
		}
		for (const from of primaryTargets) {
			const existing = byFrom[from];
			byFrom[from] = existing ? [...existing, ...afterPrimary] : [...afterPrimary];
		}
	}
	return { targets, fallbacksByFrom };
}

function compileFlatten(children: readonly RouteNode[], seenOnPath: ReadonlySet<string>): NodeCompile {
	const targets: string[] = [];
	const fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>> = {};
	const sequential = new Set(seenOnPath);
	for (const child of children) {
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen);
		targets.push(...part.targets);
		// Keep nested fallback edges scoped to their subtree — do not invent
		// cross-sibling edges for unreached branches.
		mergeFallbacksByFrom(fallbacksByFrom, part.fallbacksByFrom);
		if (child.type === "target") sequential.add(child.model);
	}
	return { targets, fallbacksByFrom };
}

function copyNode(node: RouteNode): RouteNode {
	switch (node.type) {
		case "target":
			return { type: "target", model: node.model };
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

function mergeFallbacksByFrom(
	dest: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
	src: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
): void {
	for (const key of Object.keys(src) as GatewayErrorDisposition[]) {
		const fromMap = src[key];
		if (!fromMap) continue;
		let destFrom = dest[key];
		if (!destFrom) {
			destFrom = {};
			dest[key] = destFrom;
		}
		for (const [from, tos] of Object.entries(fromMap)) {
			if (!tos || tos.length === 0) continue;
			const existing = destFrom[from];
			destFrom[from] = existing ? [...existing, ...tos] : [...tos];
		}
	}
}

function freezeFallbacksUnion(
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
): Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>> {
	const out: Partial<Record<GatewayErrorDisposition, readonly string[]>> = {};
	for (const key of Object.keys(fallbacksByFrom) as GatewayErrorDisposition[]) {
		const fromMap = fallbacksByFrom[key];
		if (!fromMap) continue;
		const seen = new Set<string>();
		const list: string[] = [];
		for (const tos of Object.values(fromMap)) {
			if (!tos) continue;
			for (const id of tos) {
				if (seen.has(id)) continue;
				seen.add(id);
				list.push(id);
			}
		}
		if (list.length > 0) out[key] = Object.freeze(list);
	}
	return Object.freeze(out);
}

function freezeFallbacksByTarget(
	fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>>,
): Readonly<Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>>> {
	const byTarget: Partial<Record<string, Partial<Record<GatewayErrorDisposition, string[]>>>> = {};
	for (const disposition of Object.keys(fallbacksByFrom) as GatewayErrorDisposition[]) {
		const fromMap = fallbacksByFrom[disposition];
		if (!fromMap) continue;
		for (const [from, tos] of Object.entries(fromMap)) {
			if (!tos || tos.length === 0) continue;
			let dest = byTarget[from];
			if (!dest) {
				dest = {};
				byTarget[from] = dest;
			}
			const existing = dest[disposition];
			dest[disposition] = existing ? [...existing, ...tos] : [...tos];
		}
	}
	const out: Partial<Record<string, Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>>> = {};
	for (const [from, dispMap] of Object.entries(byTarget)) {
		const frozen: Partial<Record<GatewayErrorDisposition, readonly string[]>> = {};
		for (const disposition of Object.keys(dispMap) as GatewayErrorDisposition[]) {
			const list = dispMap[disposition];
			if (!list || list.length === 0) continue;
			frozen[disposition] = Object.freeze([...list]);
		}
		out[from] = Object.freeze(frozen);
	}
	return Object.freeze(out);
}
