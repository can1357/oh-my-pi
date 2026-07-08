import type { RouteDecision, RouterConfig, TelemetryRecord, ValidationResult } from "./types.js";

export function decisionTelemetry(decision: RouteDecision, metadata: Record<string, unknown> = {}): TelemetryRecord {
	return {
		requestId: decision.requestId,
		timestamp: new Date().toISOString(),
		kind: "decision",
		route: {
			selectedModel: decision.selectedModel,
			selector: decision.selector,
			confidence: decision.confidence,
			taskType: decision.taskType,
			reasons: decision.reasons,
			fallbackChain: decision.fallbackChain,
		},
		features: summarizeFeatures(decision),
		metadata,
	};
}

export function validationTelemetry(
	requestId: string,
	validation: ValidationResult,
	metadata: Record<string, unknown> = {},
): TelemetryRecord {
	return {
		requestId,
		timestamp: new Date().toISOString(),
		kind: "validation",
		validation,
		metadata,
	};
}

export async function writeTelemetry(config: RouterConfig, record: TelemetryRecord): Promise<void> {
	if (!config.telemetry?.enabled) return;
	const sampleRate = config.telemetry.sampleRate ?? 1;
	if (sampleRate < 1 && Math.random() > sampleRate) return;
	const path = config.telemetry.path ?? ".llm-router/telemetry.jsonl";
	const fs = await import("node:fs/promises");
	const nodePath = await import("node:path");
	await fs.mkdir(nodePath.dirname(path), { recursive: true });
	await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function summarizeTelemetry(
	path: string,
): Promise<{ total: number; byModel: Record<string, number>; byTask: Record<string, number>; failures: number }> {
	const fs = await import("node:fs/promises");
	const text = await fs.readFile(path, "utf8");
	const summary = {
		total: 0,
		byModel: {} as Record<string, number>,
		byTask: {} as Record<string, number>,
		failures: 0,
	};
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as TelemetryRecord;
			summary.total += 1;
			if (record.route?.selectedModel)
				summary.byModel[record.route.selectedModel] = (summary.byModel[record.route.selectedModel] ?? 0) + 1;
			if (record.route?.taskType)
				summary.byTask[record.route.taskType] = (summary.byTask[record.route.taskType] ?? 0) + 1;
			if (record.validation && !record.validation.passed) summary.failures += 1;
			if (record.metrics?.success === false) summary.failures += 1;
		} catch {
			summary.failures += 1;
		}
	}
	return summary;
}

function summarizeFeatures(decision: RouteDecision): TelemetryRecord["features"] {
	return {
		taskType: decision.features.taskType,
		approxInputTokens: decision.features.approxInputTokens,
		approxOutputTokens: decision.features.approxOutputTokens,
		totalTokenEstimate: decision.features.totalTokenEstimate,
		hasCode: decision.features.hasCode,
		hasJsonRequirement: decision.features.hasJsonRequirement,
		hasRetrievalNeed: decision.features.hasRetrievalNeed,
		hasMultimodalInput: decision.features.hasMultimodalInput,
		reasoningComplexity: decision.features.reasoningComplexity,
		safetySensitivity: decision.features.safetySensitivity,
		userTier: decision.features.userTier,
		userPreference: decision.features.userPreference,
		signals: decision.features.signals,
	};
}
