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
		const compiled = compileNode(definition.root, new Set());
		this.#generation += 1;
		this.#routes.set(definition.id, {
			generation: this.#generation,
			id: definition.id,
			root: copyNode(definition.root),
			targets: Object.freeze([...compiled.targets]),
			fallbacks: freezeFallbacksUnion(compiled.fallbacksByFrom),
			fallbackByTarget: freezeFallbacksByTarget(compiled.fallbacksByFrom),
		});
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

function compileNode(node: RouteNode, seenOnPath: ReadonlySet<string>): NodeCompile {
	if (node.type === "target") {
		if (seenOnPath.has(node.model)) {
			throw new AIError.ValidationError(`Route cycle: model "${node.model}" repeats on one path`);
		}
		return { targets: [node.model], fallbacksByFrom: {} };
	}
	if (node.children.length === 0) {
		throw new AIError.ValidationError("Fallback node has empty children");
	}

	const targets: string[] = [];
	const fallbacksByFrom: Partial<Record<GatewayErrorDisposition, Partial<Record<string, string[]>>>> = {};
	const sequential = new Set(seenOnPath);
	const childParts: Array<{ entryTargets: string[]; after: string[] }> = [];
	const entryTargetsPerChild: string[][] = [];
	const allTargetsPerChild: string[][] = [];
	for (const child of node.children) {
		// Independent ancestor copy per sibling. Fallback subtrees must not
		// inherit sequential sibling targets — those are other leaves.
		const childSeen = new Set(child.type === "target" ? sequential : seenOnPath);
		const part = compileNode(child, childSeen);
		targets.push(...part.targets);
		allTargetsPerChild.push([...part.targets]);
		const entry =
			child.type === "fallback"
				? part.targets[0] !== undefined
					? [part.targets[0]]
					: []
				: [...part.targets];
		entryTargetsPerChild.push(entry);
		mergeFallbacksByFrom(fallbacksByFrom, part.fallbacksByFrom);
		if (child.type === "target") sequential.add(child.model);
	}
	// fallbackByTarget is keyed by model id; the same id in multiple sibling
	// subtrees would merge nested edges across unreached branches.
	const owner = new Map<string, number>();
	for (let i = 0; i < allTargetsPerChild.length; i += 1) {
		for (const id of allTargetsPerChild[i]!) {
			const prev = owner.get(id);
			if (prev !== undefined && prev !== i) {
				throw new AIError.ValidationError(
					`Ambiguous cross-branch reuse of model "${id}" under one fallback`,
				);
			}
			owner.set(id, i);
		}
	}
	// From each sibling entry, edges go to the remaining suffix of entry targets.
	for (let i = 0; i < entryTargetsPerChild.length; i += 1) {
		const suffix: string[] = [];
		for (let j = i + 1; j < entryTargetsPerChild.length; j += 1) {
			suffix.push(...entryTargetsPerChild[j]!);
		}
		childParts.push({ entryTargets: entryTargetsPerChild[i]!, after: suffix });
	}
	for (const disposition of node.on) {
		let byFrom = fallbacksByFrom[disposition];
		if (!byFrom) {
			byFrom = {};
			fallbacksByFrom[disposition] = byFrom;
		}
		for (const part of childParts) {
			if (part.after.length === 0) continue;
			for (const from of part.entryTargets) {
				const existing = byFrom[from];
				byFrom[from] = existing ? [...existing, ...part.after] : [...part.after];
			}
		}
	}
	return { targets, fallbacksByFrom };
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
