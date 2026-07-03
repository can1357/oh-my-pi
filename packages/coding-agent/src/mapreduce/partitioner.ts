import { computeCutEdges, type SignalGraph, type WeightedSignal } from "./graph";
import { buildReducerTreePlan, type ReducerTreePlan } from "./reducers";

export interface ShardLimits {
	maxShardTokens: number;
	maxShardSignals: number;
	maxShardFiles: number;
	targetWeight: number;
}

export interface ObjectiveWeights {
	cutEdges: number;
	duplicateContext: number;
	reducerInput: number;
	failureRisk: number;
}

export interface PlanShardsInput {
	graph: SignalGraph;
	limits: ShardLimits;
	objectiveWeights?: Partial<ObjectiveWeights>;
	effectiveConcurrency?: number;
	reducerFanIn?: number;
}

export interface PlannedShard {
	id: string;
	signalIds: string[];
	weight: number;
	tokens: number;
	files: string[];
	failureRisk: number;
}
export interface InfeasibleSignal {
	id: string;
	reasons: string[];
}

export interface ShardPlanMetrics {
	estimatedMakespan: number;
	cutEdges: number;
	cutEdgeWeight: number;
	weightVariance: number;
	duplicateContext: number;
	reducerInput: number;
	failureRisk: number;
	objective: number;
}

export interface ShardPlan {
	shards: PlannedShard[];
	estimatedMakespan: number;
	cutEdges: number;
	weightVariance: number;
	reducerPlan: ReducerTreePlan;
	infeasibleSignals: InfeasibleSignal[];
	feasible: boolean;
	metrics: ShardPlanMetrics;
}

const DEFAULT_OBJECTIVE_WEIGHTS: ObjectiveWeights = {
	cutEdges: 1,
	duplicateContext: 1,
	reducerInput: 1,
	failureRisk: 1,
};

interface MutableShard {
	id: string;
	signalIds: string[];
	weight: number;
	tokens: number;
	files: Set<string>;
	failureRisk: number;
}

function infeasibleReasons(node: WeightedSignal, limits: ShardLimits): string[] {
	const reasons: string[] = [];
	if (limits.maxShardSignals < 1) reasons.push("maxShardSignals < 1");
	if (limits.maxShardFiles < 1) reasons.push("maxShardFiles < 1");
	if (node.tokens > limits.maxShardTokens) reasons.push("tokens exceed maxShardTokens");
	if (node.weight > limits.targetWeight) reasons.push("weight exceeds targetWeight");
	return reasons;
}

function canFit(shard: MutableShard, node: WeightedSignal, limits: ShardLimits): boolean {
	const fileCount = shard.files.has(node.signal.file) ? shard.files.size : shard.files.size + 1;
	return (
		shard.signalIds.length + 1 <= limits.maxShardSignals &&
		shard.tokens + node.tokens <= limits.maxShardTokens &&
		shard.weight + node.weight <= limits.targetWeight &&
		fileCount <= limits.maxShardFiles
	);
}

function projectedCutEdgeDelta(
	node: WeightedSignal,
	graph: SignalGraph,
	assignedShardBySignal: Map<string, string>,
	targetShardId: string | undefined,
): number {
	const projectedShardId = targetShardId ?? "\0new-shard";
	let delta = 0;
	for (const edge of graph.edges) {
		if (!edge.signalIds.includes(node.id)) continue;
		const beforeShards = new Set<string>();
		for (const signalId of edge.signalIds) {
			if (signalId === node.id) continue;
			const shardId = assignedShardBySignal.get(signalId);
			if (shardId) beforeShards.add(shardId);
		}
		const wasCut = beforeShards.size > 1;
		beforeShards.add(projectedShardId);
		const becomesCut = beforeShards.size > 1;
		if (becomesCut && !wasCut) delta += edge.weight;
	}
	return delta;
}

function duplicateContextDelta(
	node: WeightedSignal,
	shard: MutableShard | undefined,
	fileShardCount: Map<string, number>,
): number {
	if (shard?.files.has(node.signal.file)) return 0;
	return fileShardCount.has(node.signal.file) ? 1 : 0;
}

function failureRiskDelta(shard: MutableShard | undefined, node: WeightedSignal): number {
	const currentRisk = shard?.failureRisk ?? 0;
	const projectedRisk = currentRisk + (node.failureRisk ?? 0);
	return projectedRisk ** 2 - currentRisk ** 2;
}

function shardScore(
	node: WeightedSignal,
	shard: MutableShard | undefined,
	graph: SignalGraph,
	assignedShardBySignal: Map<string, string>,
	fileShardCount: Map<string, number>,
	limits: ShardLimits,
	weights: ObjectiveWeights,
): number {
	const currentWeight = shard?.weight ?? 0;
	const projectedWeight = currentWeight + node.weight;
	const targetWeight = Math.max(1, limits.targetWeight);
	const balanceDelta = (projectedWeight ** 2 - currentWeight ** 2) / targetWeight ** 2;
	const cutPenalty = projectedCutEdgeDelta(node, graph, assignedShardBySignal, shard?.id);
	const reducerInputDelta = shard ? 0 : 1;
	return (
		balanceDelta +
		weights.cutEdges * cutPenalty +
		weights.duplicateContext * duplicateContextDelta(node, shard, fileShardCount) +
		weights.reducerInput * reducerInputDelta +
		weights.failureRisk * failureRiskDelta(shard, node)
	);
}

function addNode(shard: MutableShard, node: WeightedSignal): void {
	shard.signalIds.push(node.id);
	shard.weight += node.weight;
	shard.tokens += node.tokens;
	shard.files.add(node.signal.file);
	shard.failureRisk += node.failureRisk ?? 0;
}

function estimateMakespan(shards: readonly MutableShard[], concurrency: number | undefined): number {
	if (shards.length === 0) return 0;
	const workers =
		concurrency === undefined || concurrency === Number.POSITIVE_INFINITY
			? shards.length
			: Math.max(1, Math.floor(concurrency));
	const lanes = Array.from({ length: Math.min(workers, shards.length) }, () => 0);
	for (const shard of [...shards].sort((left, right) => right.weight - left.weight)) {
		let bestIndex = 0;
		for (let index = 1; index < lanes.length; index += 1) {
			if ((lanes[index] ?? 0) < (lanes[bestIndex] ?? 0)) bestIndex = index;
		}
		lanes[bestIndex] = (lanes[bestIndex] ?? 0) + shard.weight;
	}
	return Math.max(...lanes);
}

function weightVariance(shards: readonly MutableShard[]): number {
	if (shards.length === 0) return 0;
	const mean = shards.reduce((sum, shard) => sum + shard.weight, 0) / shards.length;
	return shards.reduce((sum, shard) => sum + (shard.weight - mean) ** 2, 0) / shards.length;
}

function duplicateContext(shards: readonly MutableShard[]): number {
	const fileOccurrences = new Map<string, number>();
	for (const shard of shards) {
		for (const file of shard.files) fileOccurrences.set(file, (fileOccurrences.get(file) ?? 0) + 1);
	}
	let duplicates = 0;
	for (const count of fileOccurrences.values()) duplicates += Math.max(0, count - 1);
	return duplicates;
}

function failureRiskConcentration(shards: readonly MutableShard[]): number {
	return shards.reduce((sum, shard) => sum + shard.failureRisk ** 2, 0);
}

function shouldReplaceCandidate(
	candidateScore: number,
	bestScore: number,
	candidateShard: MutableShard | undefined,
	bestShard: MutableShard | undefined,
): boolean {
	const epsilon = 1e-9;
	if (candidateScore < bestScore - epsilon) return true;
	if (candidateScore > bestScore + epsilon) return false;
	if (candidateShard && !bestShard) return true;
	if (!candidateShard || !bestShard) return false;
	return candidateShard.id < bestShard.id;
}

export function planShards(input: PlanShardsInput): ShardPlan {
	const weights = { ...DEFAULT_OBJECTIVE_WEIGHTS, ...input.objectiveWeights };
	const nodes = [...input.graph.nodes].sort(
		(left, right) => right.weight - left.weight || left.id.localeCompare(right.id),
	);
	const shards: MutableShard[] = [];
	const assignedShardBySignal = new Map<string, string>();
	const fileShardCount = new Map<string, number>();
	const infeasibleSignals: InfeasibleSignal[] = [];

	for (const node of nodes) {
		const reasons = infeasibleReasons(node, input.limits);
		if (reasons.length > 0) {
			infeasibleSignals.push({ id: node.id, reasons });
			continue;
		}
		let bestShard: MutableShard | undefined;
		let bestScore = shardScore(
			node,
			undefined,
			input.graph,
			assignedShardBySignal,
			fileShardCount,
			input.limits,
			weights,
		);
		for (const shard of shards) {
			if (!canFit(shard, node, input.limits)) continue;
			const score = shardScore(
				node,
				shard,
				input.graph,
				assignedShardBySignal,
				fileShardCount,
				input.limits,
				weights,
			);
			if (shouldReplaceCandidate(score, bestScore, shard, bestShard)) {
				bestScore = score;
				bestShard = shard;
			}
		}
		if (!bestShard) {
			bestShard = {
				id: `shard_${String(shards.length + 1).padStart(3, "0")}`,
				signalIds: [],
				weight: 0,
				tokens: 0,
				files: new Set<string>(),
				failureRisk: 0,
			};
			shards.push(bestShard);
		}
		const hadFile = bestShard.files.has(node.signal.file);
		addNode(bestShard, node);
		if (!hadFile) fileShardCount.set(node.signal.file, (fileShardCount.get(node.signal.file) ?? 0) + 1);
		assignedShardBySignal.set(node.id, bestShard.id);
	}

	const cuts = computeCutEdges(input.graph.edges, assignedShardBySignal);
	const variance = weightVariance(shards);
	const duplicates = duplicateContext(shards);
	const estimatedMakespan = estimateMakespan(shards, input.effectiveConcurrency);
	const reducerPlan = buildReducerTreePlan(shards.length, input.reducerFanIn ?? 32);
	const reducerInputCost = shards.length;
	const failureRisk = failureRiskConcentration(shards);
	const objective =
		estimatedMakespan +
		weights.cutEdges * cuts.weight +
		weights.duplicateContext * duplicates +
		weights.reducerInput * reducerInputCost +
		weights.failureRisk * failureRisk;

	return {
		shards: shards.map(shard => ({
			id: shard.id,
			signalIds: [...shard.signalIds],
			weight: shard.weight,
			tokens: shard.tokens,
			files: [...shard.files].sort(),
			failureRisk: shard.failureRisk,
		})),
		estimatedMakespan,
		cutEdges: cuts.count,
		weightVariance: variance,
		reducerPlan,
		infeasibleSignals,
		feasible: infeasibleSignals.length === 0,
		metrics: {
			estimatedMakespan,
			cutEdges: cuts.count,
			cutEdgeWeight: cuts.weight,
			weightVariance: variance,
			duplicateContext: duplicates,
			reducerInput: reducerInputCost,
			failureRisk,
			objective,
		},
	};
}
