import { featureMap } from "./learned.js";
import type { LearnedPolicyConfig, RouterFeatureVector, TelemetryRecord } from "./types.js";

export interface RoutePredictorTrainingOptions {
	learningRate?: number;
	epochs?: number;
	l2?: number;
	successBonus?: number;
	failurePenalty?: number;
	maxAbsWeight?: number;
}

export interface RoutePredictorTrainingResult {
	role: "route-predictor";
	tier: "local-fast";
	executionRouter: "unchanged";
	examples: number;
	models: string[];
	policy: LearnedPolicyConfig;
}

interface TrainingExample {
	modelId: string;
	features: RouterFeatureVector;
	weight: number;
}

export function trainRoutePredictorFromTelemetry(
	records: TelemetryRecord[],
	options: RoutePredictorTrainingOptions = {},
): RoutePredictorTrainingResult {
	const examples = records.flatMap(recordToTrainingExamples);
	const models = [...new Set(examples.map(example => example.modelId))].sort();
	const weights = new Map<string, Record<string, number>>();
	const learningRate = options.learningRate ?? 0.08;
	const epochs = Math.max(1, Math.floor(options.epochs ?? 8));
	const l2 = options.l2 ?? 0.0005;
	const maxAbsWeight = options.maxAbsWeight ?? 2;

	for (const model of models) weights.set(model, {});
	for (let epoch = 0; epoch < epochs; epoch += 1) {
		for (const example of examples) {
			const fmap = featureMap(example.features);
			const prediction = sigmoid(dot(weights.get(example.modelId) ?? {}, fmap));
			const error = example.weight - prediction;
			const modelWeights = weights.get(example.modelId) ?? {};
			for (const [feature, value] of Object.entries(fmap)) {
				const current = modelWeights[feature] ?? 0;
				const next = current + learningRate * (error * value - l2 * current);
				modelWeights[feature] = clamp(round(next, 6), -maxAbsWeight, maxAbsWeight);
			}
			weights.set(example.modelId, modelWeights);
		}
	}

	return {
		role: "route-predictor",
		tier: "local-fast",
		executionRouter: "unchanged",
		examples: examples.length,
		models,
		policy: {
			enabled: examples.length > 0,
			intercept: 0,
			modelWeights: Object.fromEntries(weights),
			globalWeights: {},
			minConfidenceToOverride: 0.18,
		},
	};
}

export function parseTelemetryJsonl(text: string): TelemetryRecord[] {
	const records: TelemetryRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		records.push(JSON.parse(line) as TelemetryRecord);
	}
	return records;
}

function recordToTrainingExamples(record: TelemetryRecord): TrainingExample[] {
	if (!record.route?.selectedModel || !record.features) return [];
	const features = completeFeatures(record.features);
	const selected = record.route.selectedModel;
	const selectedWeight = outcomeWeight(record);
	const examples: TrainingExample[] = [{ modelId: selected, features, weight: selectedWeight }];
	for (const fallback of record.route.fallbackChain ?? []) {
		if (fallback !== selected)
			examples.push({ modelId: fallback, features, weight: Math.max(0, selectedWeight - 0.35) });
	}
	return examples;
}

function outcomeWeight(record: TelemetryRecord): number {
	if (record.metrics?.success === false) return 0.15;
	if (typeof record.metrics?.userRating === "number") return clamp(record.metrics.userRating / 5, 0, 1);
	if (record.validation && !record.validation.passed) return 0.25;
	return record.metrics?.success === true ? 1 : 0.8;
}

function completeFeatures(features: Partial<RouterFeatureVector>): RouterFeatureVector {
	return {
		taskScores: features.taskScores ?? defaultTaskScores(),
		taskType: features.taskType ?? "unknown",
		approxInputTokens: features.approxInputTokens ?? 0,
		approxOutputTokens: features.approxOutputTokens ?? 0,
		totalTokenEstimate: features.totalTokenEstimate ?? 0,
		language: features.language ?? "unknown",
		hasCode: features.hasCode ?? false,
		hasUrl: features.hasUrl ?? false,
		hasJsonRequirement: features.hasJsonRequirement ?? false,
		hasStructuredData: features.hasStructuredData ?? false,
		hasToolNeed: features.hasToolNeed ?? false,
		hasRetrievalNeed: features.hasRetrievalNeed ?? false,
		hasMultimodalInput: features.hasMultimodalInput ?? false,
		hasLongContextNeed: features.hasLongContextNeed ?? false,
		reasoningComplexity: features.reasoningComplexity ?? 0,
		ambiguity: features.ambiguity ?? 0,
		safetySensitivity: features.safetySensitivity ?? 0,
		runtimePressure: features.runtimePressure ?? 0,
		userTier: features.userTier ?? "default",
		userPreference: features.userPreference ?? "balanced",
		tags: features.tags ?? [],
		signals: features.signals ?? [],
	};
}
function defaultTaskScores(): Record<RouterFeatureVector["taskType"], number> {
	return {
		chat: 0,
		classification: 0,
		coding: 0,
		translation: 0,
		summarization: 0,
		extraction: 0,
		reasoning: 0,
		retrieval: 0,
		planning: 0,
		multimodal: 0,
		safety: 0,
		unknown: 1,
	};
}

function dot(weights: Record<string, number>, fmap: Record<string, number>): number {
	let total = 0;
	for (const [feature, value] of Object.entries(fmap)) total += (weights[feature] ?? 0) * value;
	return total;
}

function sigmoid(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
function round(value: number, places: number): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}
