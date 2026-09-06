import * as AIError from "../error";
import type { GatewayErrorDisposition } from "../error/gateway";
import type { Api, Model } from "../types";

export type TargetNode = { type: "target"; model: string };

export type FallbackNode = {
	type: "fallback";
	on: readonly GatewayErrorDisposition[];
	children: readonly RouteNode[];
};

export type RouteNode = TargetNode | FallbackNode;

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
	/** Next unused target ids for this disposition; empty if none. */
	fallbacks: Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>;
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

	constructor(resolveModel: ResolveModel) {
		this.#resolveModel = resolveModel;
	}

	get generation(): number {
		return this.#generation;
	}

	/** Register/replace a virtual route. Bumps generation. Rejects cycles and empty fallback children. */
	register(definition: RouteDefinition): void {
		const compiled = compileNode(definition.root, new Set());
		this.#generation += 1;
		this.#routes.set(definition.id, {
			generation: this.#generation,
			id: definition.id,
			root: copyNode(definition.root),
			targets: Object.freeze([...compiled.targets]),
			fallbacks: freezeFallbacks(compiled.fallbacks),
		});
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
		};
	}
}

function compileNode(node: RouteNode, seenOnPath: ReadonlySet<string>): NodeCompile {
	if (node.type === "target") {
		if (seenOnPath.has(node.model)) {
			throw new AIError.ValidationError(`Route cycle: model "${node.model}" repeats on one path`);
		}
		return { targets: [node.model], fallbacks: {} };
	}
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
		mergeFallbacks(fallbacks, part.fallbacks);
		if (child.type === "target") sequential.add(child.model);
		primary = false;
	}
	for (const disposition of node.on) {
		if (afterPrimary.length === 0) continue;
		const existing = fallbacks[disposition];
		fallbacks[disposition] = existing ? [...existing, ...afterPrimary] : [...afterPrimary];
	}
	return { targets, fallbacks };
}

function copyNode(node: RouteNode): RouteNode {
	if (node.type === "target") {
		return { type: "target", model: node.model };
	}
	return {
		type: "fallback",
		on: Object.freeze([...node.on]),
		children: Object.freeze(node.children.map(copyNode)),
	};
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
