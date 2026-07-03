export interface SignalWeightCoefficients {
	estimatedTokens: number;
	fileContextCost: number;
	dependencyDegree: number;
	uncertainty: number;
	toolCost: number;
}

export interface SignalCostFeatures {
	estimatedTokens?: number;
	fileContextCost?: number;
	dependencyDegree?: number;
	uncertainty?: number;
	toolCost?: number;
}

export interface EffectiveParallelismInput {
	taskMaxConcurrency: number;
	expectedShardDurationMs?: number;
	providerRequestsPerMinute?: number;
	expectedRequestsPerShard?: number;
	providerTokensPerMinute?: number;
	expectedTokensPerShard?: number;
	localIoLimit?: number;
	localCpuLimit?: number;
	totalCostBudget?: number;
	concurrentCostBudget?: number;
	expectedCostPerShard?: number;
}

export interface EffectiveParallelismResult {
	concurrency: number;
	rawConcurrency: number;
	factors: Array<{ name: string; value: number }>;
	limitingFactors: string[];
	maxAffordableShards?: number;
	capacityLimited: boolean;
	minInterStartDelayMs?: number;
}

export interface RecursionCapacityInput {
	maxRecursionDepth: number;
	branchingFactor: number;
	rootDepth?: number;
}

export const DEFAULT_SIGNAL_WEIGHT_COEFFICIENTS: SignalWeightCoefficients = {
	estimatedTokens: 1,
	fileContextCost: 1,
	dependencyDegree: 1,
	uncertainty: 1,
	toolCost: 1,
};

export function normalizeConcurrencyCap(cap: number): number {
	if (cap <= 0 || cap === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
	if (!Number.isFinite(cap)) return 1;
	return Math.max(1, Math.floor(cap));
}

function rateConcurrency(
	ratePerMinute: number | undefined,
	usagePerShard: number | undefined,
	expectedShardDurationMs: number | undefined,
): number | undefined {
	if (ratePerMinute === undefined || usagePerShard === undefined || expectedShardDurationMs === undefined) {
		return undefined;
	}
	if (ratePerMinute <= 0 || usagePerShard <= 0 || expectedShardDurationMs <= 0) return undefined;
	const expectedShardDurationMinutes = expectedShardDurationMs / 60_000;
	return (ratePerMinute * expectedShardDurationMinutes) / usagePerShard;
}

function positiveRatio(numerator: number | undefined, denominator: number | undefined): number | undefined {
	if (numerator === undefined || denominator === undefined) return undefined;
	if (numerator <= 0 || denominator <= 0) return undefined;
	return numerator / denominator;
}

export function computeEffectiveParallelism(input: EffectiveParallelismInput): EffectiveParallelismResult {
	const factors: Array<{ name: string; value: number }> = [
		{ name: "task.maxConcurrency", value: normalizeConcurrencyCap(input.taskMaxConcurrency) },
	];
	const requestLimit = rateConcurrency(
		input.providerRequestsPerMinute,
		input.expectedRequestsPerShard,
		input.expectedShardDurationMs,
	);
	if (requestLimit !== undefined) factors.push({ name: "provider_rpm", value: requestLimit });
	const tokenLimit = rateConcurrency(
		input.providerTokensPerMinute,
		input.expectedTokensPerShard,
		input.expectedShardDurationMs,
	);
	if (tokenLimit !== undefined) factors.push({ name: "provider_tpm", value: tokenLimit });
	if (input.localIoLimit !== undefined && input.localIoLimit > 0)
		factors.push({ name: "local_io", value: input.localIoLimit });
	if (input.localCpuLimit !== undefined && input.localCpuLimit > 0)
		factors.push({ name: "local_cpu", value: input.localCpuLimit });
	const concurrentCostLimit = positiveRatio(input.concurrentCostBudget, input.expectedCostPerShard);
	if (concurrentCostLimit !== undefined) factors.push({ name: "concurrent_cost_budget", value: concurrentCostLimit });
	const maxAffordableShards = positiveRatio(input.totalCostBudget, input.expectedCostPerShard);

	const minimum = factors.reduce((current, factor) => Math.min(current, factor.value), Number.POSITIVE_INFINITY);
	const capacityLimited = minimum > 0 && minimum < 1;
	const concurrency =
		minimum === Number.POSITIVE_INFINITY
			? Number.POSITIVE_INFINITY
			: capacityLimited
				? 1
				: Math.max(1, Math.floor(minimum));
	const limitingFactors = factors.filter(factor => factor.value === minimum).map(factor => factor.name);
	const minInterStartDelayMs =
		capacityLimited && input.expectedShardDurationMs !== undefined
			? Math.ceil(input.expectedShardDurationMs / minimum)
			: undefined;
	return {
		concurrency,
		rawConcurrency: minimum,
		factors,
		limitingFactors,
		maxAffordableShards,
		capacityLimited,
		minInterStartDelayMs,
	};
}

export function estimateSignalWeight(
	features: SignalCostFeatures,
	coefficients: SignalWeightCoefficients = DEFAULT_SIGNAL_WEIGHT_COEFFICIENTS,
): number {
	const weight =
		(features.estimatedTokens ?? 0) * coefficients.estimatedTokens +
		(features.fileContextCost ?? 0) * coefficients.fileContextCost +
		(features.dependencyDegree ?? 0) * coefficients.dependencyDegree +
		(features.uncertainty ?? 0) * coefficients.uncertainty +
		(features.toolCost ?? 0) * coefficients.toolCost;
	return Math.max(1, weight);
}

export function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function computeRecursionLeafCapacity(input: RecursionCapacityInput): number {
	const branching = Math.max(0, Math.floor(input.branchingFactor));
	if (branching === 0) return 0;
	if (input.maxRecursionDepth < 0) return Number.POSITIVE_INFINITY;
	const rootDepth = Math.max(0, Math.floor(input.rootDepth ?? 0));
	const remainingDepth = Math.max(0, input.maxRecursionDepth - rootDepth);
	if (remainingDepth === 0) return 0;
	return branching ** remainingDepth;
}
