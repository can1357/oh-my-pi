import type { LearnedPolicyConfig, RouterFeatureVector } from "./types.js";

export interface LearnedScoreResult {
	modelId: string;
	score: number;
	contributions: Record<string, number>;
}

export function featureMap(features: RouterFeatureVector): Record<string, number> {
	const map: Record<string, number> = {
		bias: 1,
		"tokens.input.log": Math.log10(Math.max(1, features.approxInputTokens)) / 6,
		"tokens.total.log": Math.log10(Math.max(1, features.totalTokenEstimate)) / 6,
		"has.code": features.hasCode ? 1 : 0,
		"has.url": features.hasUrl ? 1 : 0,
		"has.json": features.hasJsonRequirement ? 1 : 0,
		"has.structured": features.hasStructuredData ? 1 : 0,
		"has.tools": features.hasToolNeed ? 1 : 0,
		"has.retrieval": features.hasRetrievalNeed ? 1 : 0,
		"has.multimodal": features.hasMultimodalInput ? 1 : 0,
		"has.long_context": features.hasLongContextNeed ? 1 : 0,
		complexity: features.reasoningComplexity,
		ambiguity: features.ambiguity,
		safety: features.safetySensitivity,
		"runtime.pressure": features.runtimePressure,
	};
	map[`task.${features.taskType}`] = 1;
	map[`preference.${features.userPreference}`] = 1;
	map[`tier.${features.userTier}`] = 1;
	for (const signal of features.signals) map[`signal.${signal}`] = 1;
	return map;
}

export function scoreLearnedPolicy(
	config: LearnedPolicyConfig | undefined,
	features: RouterFeatureVector,
	modelIds: string[],
): LearnedScoreResult[] {
	if (!config?.enabled) return modelIds.map(modelId => ({ modelId, score: 0, contributions: {} }));
	const fmap = featureMap(features);
	return modelIds.map(modelId => {
		const weights = { ...(config.globalWeights ?? {}), ...(config.modelWeights?.[modelId] ?? {}) };
		const contributions: Record<string, number> = {};
		let score = config.intercept ?? 0;
		for (const [feature, value] of Object.entries(fmap)) {
			const weight = weights[feature] ?? 0;
			if (weight !== 0 && value !== 0) {
				const contribution = weight * value;
				contributions[feature] = contribution;
				score += contribution;
			}
		}
		return { modelId, score, contributions };
	});
}

export function learnedConfidenceGap(results: LearnedScoreResult[]): number {
	const sorted = [...results].sort((a, b) => b.score - a.score);
	if (sorted.length < 2) return 0;
	return Math.abs((sorted[0]?.score ?? 0) - (sorted[1]?.score ?? 0));
}
