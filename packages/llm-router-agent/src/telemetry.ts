import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { stepContextToContextTrace } from "./step-context.js";
import type {
	RequestInput,
	RouteDecision,
	RouterConfig,
	TelemetryRecord,
	TraceCaptureConfig,
	ValidationResult,
} from "./types.js";
import type { RouteLabel } from "./validation.js";

type PromptPreviewOptions = Pick<TraceCaptureConfig, "includePromptPreview" | "maxPromptPreviewChars">;

export function decisionTelemetry(
	decision: RouteDecision,
	metadata: Record<string, unknown> = {},
	input?: RequestInput,
	preview?: PromptPreviewOptions,
): TelemetryRecord {
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
		modelTrace: {
			provider: decision.provider,
			modelId: decision.modelId,
			selector: decision.selector,
			fallbackSelectors: decision.fallbackSelectors,
			candidateScores: decision.scores,
		},
		contextTrace: summarizeContext(decision, input, preview),
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

export interface TaskSpawnTelemetryInput {
	correlationId: string;
	agentName: string;
	workClass: string;
	autonomy: string;
	eligibleTier: readonly string[];
	eligibleCount: number;
	routeLabel?: RouteLabel;
	allow: boolean;
	reasonCode?: string;
	candidateSelectors?: readonly string[];
	maxRequests?: number;
	maxRuntimeMs?: number;
	classifierSource?: "classifier" | "fallback";
	classifierReason?: string;
	latencyMs?: number;
	appliedNarrowing: boolean;
	selectedTier?: readonly string[];
}

/**
 * Pre-allocation spawn-policy telemetry. Never includes assignment text or secrets.
 * Distinguished from input-hook decision telemetry by `kind` and `metadata.surface`.
 */
export function taskSpawnTelemetry(input: TaskSpawnTelemetryInput): TelemetryRecord {
	return {
		requestId: input.correlationId,
		timestamp: new Date().toISOString(),
		kind: "task_spawn",
		metrics: {
			latencyMs: input.latencyMs,
			success: input.allow,
		},
		metadata: {
			surface: "task_spawn",
			correlationId: input.correlationId,
			agentName: input.agentName,
			workClass: input.workClass,
			autonomy: input.autonomy,
			eligibleTier: [...input.eligibleTier],
			eligibleTierCount: input.eligibleTiers.length,
			eligibleCount: input.eligibleCount,
			routeLabel: input.routeLabel,
			allow: input.allow,
			reasonCode: input.reasonCode,
			candidateSelectors: input.candidateSelectors ? [...input.candidateSelectors] : undefined,
			maxRequests: input.maxRequests,
			maxRuntimeMs: input.maxRuntimeMs,
			classifierSource: input.classifierSource,
			classifierReason: input.classifierReason,
			appliedNarrowing: input.appliedNarrowing,
			selectedTier: input.selectedTier ? [...input.selectedTier] : undefined,
		},
	};
}

export async function writeTelemetry(config: RouterConfig, record: TelemetryRecord): Promise<void> {
	if (!config.telemetry?.enabled) return;
	const sampleRate = config.telemetry.sampleRate ?? 1;
	if (sampleRate < 1 && Math.random() > sampleRate) return;
	const path = config.telemetry.path ?? ".llm-router/telemetry.jsonl";
	await fs.mkdir(nodePath.dirname(path), { recursive: true });
	await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function writeTrace(config: RouterConfig, record: TelemetryRecord): Promise<void> {
	if (!config.traces?.enabled) return;
	const path = config.traces.path ?? ".llm-router/traces.jsonl";
	await fs.mkdir(nodePath.dirname(path), { recursive: true });
	await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function summarizeTelemetry(
	path: string,
): Promise<{ total: number; byModel: Record<string, number>; byTask: Record<string, number>; failures: number }> {
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
		hasUrl: decision.features.hasUrl,
		hasJsonRequirement: decision.features.hasJsonRequirement,
		hasStructuredData: decision.features.hasStructuredData,
		hasToolNeed: decision.features.hasToolNeed,
		hasRetrievalNeed: decision.features.hasRetrievalNeed,
		hasMultimodalInput: decision.features.hasMultimodalInput,
		hasLongContextNeed: decision.features.hasLongContextNeed,
		reasoningComplexity: decision.features.reasoningComplexity,
		ambiguity: decision.features.ambiguity,
		safetySensitivity: decision.features.safetySensitivity,
		runtimePressure: decision.features.runtimePressure,
		userTier: decision.features.userTier,
		userPreference: decision.features.userPreference,
		tags: decision.features.tags,
		stepKind: decision.features.stepKind,
		stepRisk: decision.features.stepRisk,
		stepIndex: decision.features.stepIndex,
		agentRole: decision.features.agentRole,
		irreversible: decision.features.irreversible,
		recentFailures: decision.features.recentFailures,
		lastVerifier: decision.features.lastVerifier,
		lastVerifierFailed: decision.features.lastVerifierFailed,
		escalationCount: decision.features.escalationCount,
		estimatedCacheHit: decision.features.estimatedCacheHit,
		providerAffinity: decision.features.providerAffinity,
		remainingTokens: decision.features.remainingTokens,
		signals: decision.features.signals,
	};
}

function summarizeContext(
	decision: RouteDecision,
	input: RequestInput | undefined,
	preview?: PromptPreviewOptions,
): TelemetryRecord["contextTrace"] {
	const stepTrace = stepContextToContextTrace(input?.metadata);
	return {
		promptPreview: previewPrompt(input, preview),
		approxInputTokens: decision.features.approxInputTokens,
		approxOutputTokens: decision.features.approxOutputTokens,
		totalTokenEstimate: decision.features.totalTokenEstimate,
		attachmentCount: input?.attachments?.length ?? 0,
		conversationTurns: stepTrace.conversationTurns ?? 0,
		...stepTrace,
	};
}


function previewPrompt(input: RequestInput | undefined, preview?: PromptPreviewOptions): string | undefined {
	if (!preview?.includePromptPreview || !input?.message) return undefined;
	return input.message.slice(0, preview.maxPromptPreviewChars ?? 1_000);
}

