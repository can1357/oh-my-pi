/**
 * V8 heap-snapshot helpers for retention tests.
 *
 * Uses `Bun.generateHeapSnapshot("v8")` after explicit GC rounds so tests can
 * count what a thread still holds, and through which retainers, without
 * reading private fields by name.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

export interface V8HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
			edge_fields: string[];
			edge_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	edges: number[];
	strings: string[];
}

/**
 * Run several full GC cycles, each from a fresh macrotask turn so bindings
 * from the previous turn and pending microtasks can be collected.
 */
export async function collectGarbage(rounds = 4): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(item => typeof item === "number");
}

/** A `node_types` / `edge_types` list: each field's type name, or the names of an enum field's values. */
function isTypeList(value: unknown): value is Array<string | string[]> {
	return Array.isArray(value) && value.every(item => typeof item === "string" || isStringArray(item));
}

/** The node fields {@link HeapGraph} reads. */
const NODE_FIELDS: readonly string[] = ["type", "name", "self_size", "edge_count"];
/** The edge fields {@link HeapGraph} reads. */
const EDGE_FIELDS: readonly string[] = ["type", "name_or_index", "to_node"];

/**
 * `raw` (a parsed V8-format heap snapshot, of this thread or written by another) as a {@link V8HeapSnapshot},
 * once each field the readers here use has its shape: every node and edge field {@link HeapGraph} reads, a list of
 * type names for the node and edge `type` fields, and `nodes` and `edges` that hold whole records.
 * @throws when a field is missing or has another shape.
 */
export function parseV8HeapSnapshot(raw: unknown): V8HeapSnapshot {
	const snapshot = isRecord(raw) ? raw.snapshot : undefined;
	const meta = isRecord(snapshot) ? snapshot.meta : undefined;
	if (!isRecord(raw) || !isRecord(meta)) throw new Error("Not a V8 heap snapshot: it has no snapshot.meta");
	const nodeFields = meta.node_fields;
	const nodeTypes = meta.node_types;
	const edgeFields = meta.edge_fields;
	const edgeTypes = meta.edge_types;
	const { nodes, edges, strings } = raw;
	if (!isStringArray(nodeFields) || !isTypeList(nodeTypes) || !isStringArray(edgeFields) || !isTypeList(edgeTypes)) {
		throw new Error("Not a V8 heap snapshot: snapshot.meta lacks its node and edge field lists");
	}
	if (!isNumberArray(nodes) || !isNumberArray(edges) || !isStringArray(strings)) {
		throw new Error("Not a V8 heap snapshot: it lacks its nodes, edges or strings");
	}
	const missingNodeFields = NODE_FIELDS.filter(field => !nodeFields.includes(field));
	if (missingNodeFields.length > 0) {
		throw new Error(`V8 heap snapshot schema: snapshot.meta.node_fields lacks ${missingNodeFields.join(", ")}`);
	}
	const missingEdgeFields = EDGE_FIELDS.filter(field => !edgeFields.includes(field));
	if (missingEdgeFields.length > 0) {
		throw new Error(`V8 heap snapshot schema: snapshot.meta.edge_fields lacks ${missingEdgeFields.join(", ")}`);
	}
	if (!isStringArray(nodeTypes[nodeFields.indexOf("type")])) {
		throw new Error("V8 heap snapshot schema: snapshot.meta.node_types has no list of names for the node type field");
	}
	if (!isStringArray(edgeTypes[edgeFields.indexOf("type")])) {
		throw new Error("V8 heap snapshot schema: snapshot.meta.edge_types has no list of names for the edge type field");
	}
	if (nodes.length % nodeFields.length !== 0) {
		throw new Error(
			`V8 heap snapshot schema: nodes has ${nodes.length} numbers, not whole records of ${nodeFields.length} node fields`,
		);
	}
	if (edges.length % edgeFields.length !== 0) {
		throw new Error(
			`V8 heap snapshot schema: edges has ${edges.length} numbers, not whole records of ${edgeFields.length} edge fields`,
		);
	}
	return {
		snapshot: {
			meta: { node_fields: nodeFields, node_types: nodeTypes, edge_fields: edgeFields, edge_types: edgeTypes },
		},
		nodes,
		edges,
		strings,
	};
}

/** Capture and parse a V8-format heap snapshot of the current JS thread. */
export function takeV8HeapSnapshot(): V8HeapSnapshot {
	return parseV8HeapSnapshot(JSON.parse(Bun.generateHeapSnapshot("v8")));
}

/** An edge of a {@link HeapGraph}: its kind, its name (a property, a variable, or an index) and its target. */
export interface HeapEdge {
	readonly type: string;
	readonly name: string;
	readonly to: number;
}

/** Edge kinds that keep their target alive, best first for a retainer path. */
const STRONG_EDGE_RANK: Readonly<Record<string, number>> = {
	property: 0,
	context: 1,
	element: 2,
	internal: 3,
	hidden: 4,
};

/** Node kinds whose text is a string's characters. */
const STRING_NODE_TYPES: Readonly<Record<string, true>> = {
	string: true,
	"concatenated string": true,
	"sliced string": true,
};

/**
 * Node and edge readers over a parsed V8-format snapshot, for walks and retainer paths; nodes are
 * numbered from 0. Bun's snapshot keeps only the first 1024 characters of a string as its name, and
 * a string's `selfSize` is the size of its characters, so a string's size is read from `selfSize`.
 */
export class HeapGraph {
	readonly #snapshot: V8HeapSnapshot;
	readonly #nodeCount: number;
	readonly #nodeStride: number;
	readonly #edgeStride: number;
	readonly #type: number;
	readonly #name: number;
	readonly #selfSize: number;
	readonly #edgeType: number;
	readonly #edgeName: number;
	readonly #edgeTo: number;
	readonly #nodeTypes: readonly string[];
	readonly #edgeTypes: readonly string[];
	/** Index (in edges, not fields) of each node's first edge; one more entry for the end. */
	readonly #firstEdge: Uint32Array;

	constructor(snapshot: V8HeapSnapshot) {
		const {
			node_fields: nodeFields,
			node_types: nodeTypes,
			edge_fields: edgeFields,
			edge_types: edgeTypes,
		} = snapshot.snapshot.meta;
		const nodeTypeNames = nodeTypes[nodeFields.indexOf("type")];
		const edgeTypeNames = edgeTypes[edgeFields.indexOf("type")];
		if (!Array.isArray(nodeTypeNames) || !Array.isArray(edgeTypeNames)) {
			throw new Error("Unexpected V8 heap snapshot schema");
		}
		this.#snapshot = snapshot;
		this.#nodeStride = nodeFields.length;
		this.#edgeStride = edgeFields.length;
		this.#nodeCount = snapshot.nodes.length / this.#nodeStride;
		this.#type = nodeFields.indexOf("type");
		this.#name = nodeFields.indexOf("name");
		this.#selfSize = nodeFields.indexOf("self_size");
		this.#edgeType = edgeFields.indexOf("type");
		this.#edgeName = edgeFields.indexOf("name_or_index");
		this.#edgeTo = edgeFields.indexOf("to_node");
		this.#nodeTypes = nodeTypeNames;
		this.#edgeTypes = edgeTypeNames;
		const edgeCount = nodeFields.indexOf("edge_count");
		this.#firstEdge = new Uint32Array(this.#nodeCount + 1);
		for (let node = 0, edge = 0; node < this.#nodeCount; node++) {
			this.#firstEdge[node] = edge;
			edge += snapshot.nodes[node * this.#nodeStride + edgeCount]!;
			this.#firstEdge[node + 1] = edge;
		}
	}

	type(node: number): string {
		return this.#nodeTypes[this.#snapshot.nodes[node * this.#nodeStride + this.#type]!] ?? "";
	}

	name(node: number): string {
		return this.#snapshot.strings[this.#snapshot.nodes[node * this.#nodeStride + this.#name]!] ?? "";
	}

	selfSize(node: number): number {
		return this.#snapshot.nodes[node * this.#nodeStride + this.#selfSize]!;
	}

	edges(node: number): HeapEdge[] {
		const edges: HeapEdge[] = [];
		for (let edge = this.#firstEdge[node]!; edge < this.#firstEdge[node + 1]!; edge++) edges.push(this.#edge(edge));
		return edges;
	}

	/** String nodes (flat, rope or slice) whose text satisfies `predicate`. */
	stringNodes(predicate: (text: string) => boolean): number[] {
		const found: number[] = [];
		for (let node = 0; node < this.#nodeCount; node++) {
			if (STRING_NODE_TYPES[this.type(node)] && predicate(this.name(node))) found.push(node);
		}
		return found;
	}

	/** Object nodes with an own property `property` whose value is the string `value`. */
	objectsWithStringProperty(property: string, value: string): number[] {
		const found: number[] = [];
		for (let node = 0; node < this.#nodeCount; node++) {
			if (this.type(node) !== "object") continue;
			const matches = this.edges(node).some(
				edge =>
					edge.type === "property" &&
					edge.name === property &&
					STRING_NODE_TYPES[this.type(edge.to)] === true &&
					this.name(edge.to) === value,
			);
			if (matches) found.push(node);
		}
		return found;
	}

	/**
	 * The nodes reachable from `from` over strong edges, `from` included. A node `enter` refuses is
	 * listed but its edges are not followed.
	 */
	reachable(from: number, enter: (node: number) => boolean): number[] {
		const seen = new Set<number>([from]);
		const queue = [from];
		for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
			if (next !== from && !enter(next)) continue;
			for (const edge of this.edges(next)) {
				if (STRONG_EDGE_RANK[edge.type] === undefined || seen.has(edge.to)) continue;
				seen.add(edge.to);
				queue.push(edge.to);
			}
		}
		return [...seen];
	}

	/**
	 * A retainer path for each of `nodes`: from the nearest retainer `isHolder` accepts (or the last one
	 * found within `maxDepth` steps) down to the node, as `Holder.field[].field`. Each step takes the
	 * node's best strong retainer: a property before a closure variable, an element, or an internal edge.
	 */
	retainerPaths(nodes: readonly number[], isHolder: (node: number) => boolean, maxDepth = 10): Map<number, string> {
		const chains = nodes.map(node => ({ node, at: node, steps: [] as string[], done: false, seen: new Set([node]) }));
		for (let depth = 0; depth < maxDepth; depth++) {
			const open = chains.filter(chain => !chain.done);
			if (open.length === 0) break;
			const best = this.#bestRetainers(new Set(open.map(chain => chain.at)));
			for (const chain of open) {
				const retainer = best.get(chain.at);
				if (!retainer || chain.seen.has(retainer.from)) {
					chain.steps.unshift(`(${this.type(chain.at)} ${this.name(chain.at)})`);
					chain.done = true;
					continue;
				}
				chain.steps.unshift(retainer.step);
				chain.at = retainer.from;
				chain.seen.add(retainer.from);
				if (isHolder(retainer.from)) {
					chain.steps.unshift(this.name(retainer.from));
					chain.done = true;
				}
			}
		}
		return new Map(chains.map(chain => [chain.node, (chain.done ? "" : "…") + chain.steps.join("")]));
	}

	/** The best strong retainer of each of `targets`, by edge rank, with the path step it adds. */
	#bestRetainers(targets: ReadonlySet<number>): Map<number, { from: number; step: string; rank: number }> {
		const best = new Map<number, { from: number; step: string; rank: number }>();
		const { edges } = this.#snapshot;
		for (let node = 0; node < this.#nodeCount; node++) {
			for (let edge = this.#firstEdge[node]!; edge < this.#firstEdge[node + 1]!; edge++) {
				const to = edges[edge * this.#edgeStride + this.#edgeTo]! / this.#nodeStride;
				if (to === node || !targets.has(to)) continue;
				const { type, name } = this.#edge(edge);
				const rank = STRONG_EDGE_RANK[type];
				if (rank === undefined || (best.get(to)?.rank ?? Infinity) <= rank) continue;
				const step =
					type === "property" ? `.${name}` : type === "context" ? `{${name}}` : type === "element" ? "[]" : "<>";
				best.set(to, { from: node, step, rank });
			}
		}
		return best;
	}

	#edge(edge: number): HeapEdge {
		const { edges, strings } = this.#snapshot;
		const offset = edge * this.#edgeStride;
		const type = this.#edgeTypes[edges[offset + this.#edgeType]!] ?? "";
		const nameOrIndex = edges[offset + this.#edgeName]!;
		return {
			type,
			name: type === "element" || type === "hidden" ? String(nameOrIndex) : (strings[nameOrIndex] ?? ""),
			to: edges[offset + this.#edgeTo]! / this.#nodeStride,
		};
	}
}
