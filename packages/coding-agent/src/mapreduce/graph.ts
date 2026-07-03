import type { SelectorSignal } from "./selectors";

export type SignalRelationKind =
	| "same-file"
	| "same-selector"
	| "same-tag"
	| "same-package"
	| "same-symbol"
	| "same-route"
	| "caller-callee"
	| "same-config-key"
	| "same-vulnerability-class"
	| "shared-test-impact"
	| (string & {});

export interface WeightedSignal {
	id: string;
	signal: SelectorSignal;
	weight: number;
	tokens: number;
	failureRisk?: number;
}

export interface SignalHyperedge {
	id: string;
	kind: SignalRelationKind;
	signalIds: string[];
	weight: number;
}

export interface SignalGraph {
	nodes: WeightedSignal[];
	edges: SignalHyperedge[];
}

export interface BuildSignalGraphInput {
	signals: readonly SelectorSignal[];
	weights?: Readonly<Record<string, number>>;
	tokens?: Readonly<Record<string, number>>;
	extraEdges?: readonly SignalHyperedge[];
}

function packageKey(file: string): string {
	const parts = file.split("/").filter(Boolean);
	if (parts[0] === "packages" && parts[1]) return `${parts[0]}/${parts[1]}`;
	return parts[0] ?? "";
}

function addGroupEdges(
	edges: SignalHyperedge[],
	kind: SignalRelationKind,
	groups: Map<string, string[]>,
	weight: number,
): void {
	for (const [key, signalIds] of groups) {
		if (!key || signalIds.length < 2) continue;
		edges.push({ id: `${kind}:${key}`, kind, signalIds, weight });
	}
}

function addToGroup(groups: Map<string, string[]>, key: string, signalId: string): void {
	const current = groups.get(key) ?? [];
	current.push(signalId);
	groups.set(key, current);
}

export function buildSignalGraph(input: BuildSignalGraphInput): SignalGraph {
	const nodes = input.signals.map(signal => ({
		id: signal.id,
		signal,
		weight: input.weights?.[signal.id] ?? 1,
		tokens: input.tokens?.[signal.id] ?? Math.max(1, Math.ceil(signal.evidence.length / 4)),
	}));
	const byFile = new Map<string, string[]>();
	const bySelector = new Map<string, string[]>();
	const byPackage = new Map<string, string[]>();
	const byTag = new Map<string, string[]>();

	for (const node of nodes) {
		addToGroup(byFile, node.signal.file, node.id);
		addToGroup(bySelector, node.signal.selectorId, node.id);
		addToGroup(byPackage, packageKey(node.signal.file), node.id);
		for (const tag of node.signal.tags) {
			addToGroup(byTag, tag, node.id);
		}
	}

	const edges: SignalHyperedge[] = [];
	addGroupEdges(edges, "same-file", byFile, 3);
	addGroupEdges(edges, "same-selector", bySelector, 1);
	addGroupEdges(edges, "same-package", byPackage, 2);
	addGroupEdges(edges, "same-tag", byTag, 2);
	if (input.extraEdges) edges.push(...input.extraEdges);
	return { nodes, edges };
}

export function computeCutEdges(
	edges: readonly SignalHyperedge[],
	shardBySignal: ReadonlyMap<string, string>,
): { count: number; weight: number; edges: SignalHyperedge[] } {
	let count = 0;
	let weight = 0;
	const cutEdges: SignalHyperedge[] = [];
	for (const edge of edges) {
		const shards = new Set<string>();
		for (const signalId of edge.signalIds) {
			const shardId = shardBySignal.get(signalId);
			if (shardId) shards.add(shardId);
		}
		if (shards.size <= 1) continue;
		count += 1;
		weight += edge.weight;
		cutEdges.push(edge);
	}
	return { count, weight, edges: cutEdges };
}

export function buildAdjacency(edges: readonly SignalHyperedge[]): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	for (const edge of edges) {
		for (const signalId of edge.signalIds) {
			const neighbors = adjacency.get(signalId) ?? new Set<string>();
			for (const neighborId of edge.signalIds) {
				if (neighborId !== signalId) neighbors.add(neighborId);
			}
			adjacency.set(signalId, neighbors);
		}
	}
	return adjacency;
}
