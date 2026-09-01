import type { Effort, Model, ToolChoice } from "@oh-my-pi/pi-ai";
import type { TaskClassification, TaskComplexity } from "./task-router";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ModelCapabilities {
	contextWindow: number | null;
	maxOutputTokens: number | null;
	reasoning: CapabilityState;
	reasoningLevels: readonly Effort[];
	toolCalling: CapabilityState;
	parallelToolCalls: CapabilityState;
	structuredOutput: CapabilityState;
	vision: CapabilityState;
	computerUse: CapabilityState;
	streaming: CapabilityState;
	promptCaching: CapabilityState;
	supportsToolChoice: CapabilityState;
	supportsForcedToolChoice: CapabilityState;
	supportsNamedToolChoice: CapabilityState;
	supportsDeveloperMessages: CapabilityState;
	supportsSystemMessages: CapabilityState;
}

export interface StrategyProfile {
	contextBudget: number | undefined;
	reasoningMode: "off" | "default" | Effort;
	allowParallelTools: boolean;
	preferredToolChoice: ToolChoice | undefined;
	structuredOutputMode: "native" | "fallback";
	verificationDepth: "standard" | "deep";
	retryPolicy: "default" | "incremental" | "conservative";
	fallbackPolicy: "none" | "capability" | "capability-and-health";
	reasons: readonly string[];
}

export interface CapabilityRuntimeEvidence {
	toolCallFailures: number;
	malformedToolArgs: number;
	providerErrors: number;
	reasoningConfigFailures: number;
}

export interface ModelCapabilityTelemetry {
	provider: string;
	model: string;
	profile: ModelCapabilities;
	strategy: StrategyProfile;
	evidence: CapabilityRuntimeEvidence;
	cacheHit: boolean;
	unsupportedRequests: number;
}

const capabilityCache = new Map<string, ModelCapabilities>();

function cacheKey(model: Model): string { return `${model.provider}\0${model.id}\0${model.api}\0${model.baseUrl}`; }
function triState(value: unknown): CapabilityState { return value === true ? "supported" : value === false ? "unsupported" : "unknown"; }
function compatValue(model: Model, key: string): unknown { return model.compat && typeof model.compat === "object" ? (model.compat as unknown as Record<string, unknown>)[key] : undefined; }
function reasoningProfile(model: Model): Pick<ModelCapabilities, "reasoning" | "reasoningLevels"> {
	if (model.thinking?.efforts?.length) return { reasoning: "supported", reasoningLevels: model.thinking.efforts };
	if (model.reasoning === false) return { reasoning: "unsupported", reasoningLevels: [] };
	return { reasoning: model.reasoning === true ? "supported" : "unknown", reasoningLevels: [] };
}

export function deriveModelCapabilities(model: Model): ModelCapabilities {
	const key = cacheKey(model); const cached = capabilityCache.get(key); if (cached) return cached;
	const reasoning = reasoningProfile(model); const explicitCache = compatValue(model, "supportsPromptCacheBreakpoints"); const promptCacheMode = compatValue(model, "promptCacheMode");
	const profile: ModelCapabilities = {
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		reasoning: reasoning.reasoning,
		reasoningLevels: reasoning.reasoningLevels,
		toolCalling: triState(model.supportsTools),
		parallelToolCalls: triState(compatValue(model, "supportsParallelToolCalls")),
		structuredOutput: triState(compatValue(model, "supportsStructuredOutput")),
		vision: model.input.includes("image") ? "supported" : "unsupported",
		computerUse: triState(model.supportsComputerUse),
		streaming: "supported",
		promptCaching: explicitCache !== undefined ? triState(explicitCache) : promptCacheMode === "automatic" || promptCacheMode === "explicit" ? "supported" : promptCacheMode === "none" ? "unsupported" : "unknown",
		supportsToolChoice: triState(compatValue(model, "supportsToolChoice")),
		supportsForcedToolChoice: triState(compatValue(model, "supportsForcedToolChoice")),
		supportsNamedToolChoice: triState(compatValue(model, "supportsNamedToolChoice")),
		supportsDeveloperMessages: triState(compatValue(model, "supportsDeveloperRole")),
		supportsSystemMessages: "unknown",
	};
	capabilityCache.set(key, profile); return profile;
}

export function invalidateModelCapabilities(model?: Model): void { if (!model) capabilityCache.clear(); else capabilityCache.delete(cacheKey(model)); }

export function createStrategyProfile(task: TaskClassification, capabilities: ModelCapabilities): StrategyProfile {
	const reasons: string[] = [];
	const ratio: Record<TaskComplexity, number> = { SIMPLE: 0.10, NORMAL: 0.18, COMPLEX: 0.28, VERY_COMPLEX: 0.40 };
	const contextBudget = capabilities.contextWindow && capabilities.contextWindow > 0 ? Math.max(2048, Math.min(Math.floor(capabilities.contextWindow * ratio[task.complexity]), Math.max(4096, capabilities.contextWindow - (capabilities.maxOutputTokens ?? 0)))) : undefined;
	if (capabilities.contextWindow) reasons.push(`context window=${capabilities.contextWindow}`);
	const highest = capabilities.reasoningLevels[capabilities.reasoningLevels.length - 1];
	let reasoningMode: StrategyProfile["reasoningMode"] = "default";
	if (task.complexity === "SIMPLE" && capabilities.reasoning === "supported") reasoningMode = "off";
	else if (highest && (task.complexity === "COMPLEX" || task.complexity === "VERY_COMPLEX")) reasoningMode = highest;
	else if (task.complexity !== "SIMPLE" && capabilities.reasoning !== "supported") reasons.push("no controllable reasoning surface; compensate with context/verification");
	const allowParallelTools = task.complexity !== "SIMPLE" && capabilities.parallelToolCalls === "supported";
	if (!allowParallelTools) reasons.push("parallel tools unavailable or not useful at this complexity");
	const preferredToolChoice = capabilities.supportsToolChoice === "supported" && capabilities.supportsForcedToolChoice === "supported" ? "auto" : undefined;
	const structuredOutputMode = capabilities.structuredOutput === "supported" ? "native" : "fallback";
	const verificationDepth = task.complexity === "VERY_COMPLEX" || capabilities.reasoning !== "supported" ? "deep" : "standard";
	const retryPolicy = capabilities.reasoning === "supported" ? "incremental" : "conservative";
	const fallbackPolicy = capabilities.toolCalling === "unsupported" || capabilities.parallelToolCalls === "unsupported" ? "capability-and-health" : "capability";
	return { contextBudget, reasoningMode, allowParallelTools, preferredToolChoice, structuredOutputMode, verificationDepth, retryPolicy, fallbackPolicy, reasons };
}

export function createModelCapabilityTelemetry(model: Model, task: TaskClassification): ModelCapabilityTelemetry {
	const key = cacheKey(model); const cacheHit = capabilityCache.has(key); const profile = deriveModelCapabilities(model);
	return { provider: model.provider, model: model.id, profile, strategy: createStrategyProfile(task, profile), evidence: { toolCallFailures: 0, malformedToolArgs: 0, providerErrors: 0, reasoningConfigFailures: 0 }, cacheHit, unsupportedRequests: 0 };
}

export function recordCapabilityEvidence(telemetry: ModelCapabilityTelemetry, event: keyof CapabilityRuntimeEvidence, model?: Model): void {
	telemetry.evidence[event] += 1; if (telemetry.evidence[event] >= 3 && model) invalidateModelCapabilities(model);
}

export function getModelCapabilityCacheSize(): number { return capabilityCache.size; }
