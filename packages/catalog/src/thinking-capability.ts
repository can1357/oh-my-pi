import { buildModel } from "./build";
import { type Effort, THINKING_EFFORTS } from "./effort";
import {
	readCachedThinkingCapability,
	type ThinkingCapabilityCacheKey,
	writeCachedThinkingCapability,
} from "./model-cache";
import { GOOGLE_THINKING_BUDGETS } from "./model-thinking";
import { toModelSpec } from "./provider-models/bundled-references";
import type { AnthropicCompat, Api, Model, OpenAICompat, ThinkingConfig } from "./types";

/** Request parameter dialect exercised by an out-of-band reasoning probe. */
export type ThinkingProbeFormat =
	| "openai"
	| "openrouter"
	| "zai"
	| "qwen"
	| "qwen-chat-template"
	| "chat-template"
	| "responses"
	| "anthropic-adaptive"
	| "anthropic-budget"
	| "google-level"
	| "google-budget"
	| "none";

/** One completed probe; accepted parameters count even without visible reasoning. */
export interface ThinkingProbeAttempt {
	format: ThinkingProbeFormat;
	effort?: Effort;
	accepted: boolean;
	observed: boolean;
}

/** Learned controls and the complete probe evidence, timestamped in epoch milliseconds. */
export interface ThinkingCapability {
	checkedAt: number;
	format: ThinkingProbeFormat;
	efforts: readonly Effort[];
	observed: boolean;
	attempts: readonly ThinkingProbeAttempt[];
}

type ProbeModel = Pick<Model, "provider" | "api" | "baseUrl" | "id" | "requestModelId">;
const DAY_MS = 24 * 60 * 60 * 1000;

function isFormat(value: unknown): value is ThinkingProbeFormat {
	switch (value) {
		case "openai":
		case "openrouter":
		case "zai":
		case "qwen":
		case "qwen-chat-template":
		case "chat-template":
		case "responses":
		case "anthropic-adaptive":
		case "anthropic-budget":
		case "google-level":
		case "google-budget":
		case "none":
			return true;
		default:
			return false;
	}
}

function isEffort(value: unknown): value is Effort {
	return THINKING_EFFORTS.some(effort => effort === value);
}

function isAttempt(value: unknown): value is ThinkingProbeAttempt {
	if (typeof value !== "object" || value === null) return false;
	return (
		"format" in value &&
		isFormat(value.format) &&
		(!("effort" in value) || value.effort === undefined || isEffort(value.effort)) &&
		"accepted" in value &&
		typeof value.accepted === "boolean" &&
		"observed" in value &&
		typeof value.observed === "boolean" &&
		(!value.observed || value.accepted)
	);
}

function isCapability(value: unknown): value is ThinkingCapability {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("checkedAt" in value) ||
		typeof value.checkedAt !== "number" ||
		!Number.isSafeInteger(value.checkedAt) ||
		value.checkedAt < 0
	)
		return false;
	if (!("format" in value) || !isFormat(value.format)) return false;
	if (!("observed" in value) || typeof value.observed !== "boolean") return false;
	if (!("efforts" in value) || !Array.isArray(value.efforts) || !value.efforts.every(isEffort)) return false;
	let previous = -1;
	for (const effort of value.efforts) {
		const index = THINKING_EFFORTS.indexOf(effort);
		if (index <= previous) return false;
		previous = index;
	}
	if (value.format === "none" ? value.efforts.length !== 0 : value.efforts.length === 0) return false;
	return "attempts" in value && Array.isArray(value.attempts) && value.attempts.every(isAttempt);
}

function cacheKey(model: ProbeModel): ThinkingCapabilityCacheKey | undefined {
	try {
		const endpoint = new URL(model.baseUrl);
		// Authentication may travel in userinfo, queries or fragments; none belongs
		// in a capability key. Preserve the path because it selects deployments.
		endpoint.username = "";
		endpoint.password = "";
		endpoint.search = "";
		endpoint.hash = "";
		return {
			provider: model.provider,
			api: model.api,
			endpoint: endpoint.toString().replace(/\/+$/, ""),
			wireModelId: model.requestModelId ?? model.id,
		};
	} catch {
		// An unresolved runtime endpoint cannot safely share learned metadata.
		return undefined;
	}
}

/** Read fresh, validated metadata for this exact provider/API/endpoint/wire id. */
export function readThinkingCapability(model: ProbeModel, dbPath?: string): ThinkingCapability | undefined {
	const key = cacheKey(model);
	if (!key) return undefined;
	const serialized = readCachedThinkingCapability(key, dbPath);
	if (serialized === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(serialized);
		if (!isCapability(value)) return undefined;
		const age = Date.now() - value.checkedAt;
		if (age < 0 || age >= (value.format === "none" ? DAY_MS : 30 * DAY_MS)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

/** Save completed probe evidence; transient failures must not be written as capabilities. */
export function writeThinkingCapability(model: ProbeModel, capability: ThinkingCapability, dbPath?: string): void {
	const key = cacheKey(model);
	if (!key || !isCapability(capability)) return;
	writeCachedThinkingCapability(key, JSON.stringify(capability), dbPath);
}

function openAIOverrides(capability: ThinkingCapability): OpenAICompat | undefined {
	const format = capability.format;
	if (format === "none") {
		return {
			supportsReasoningParams: false,
			supportsReasoningEffort: false,
			omitReasoningEffort: true,
			reasoningDisableMode: "omit",
			trustExplicitThinkingOnly: true,
		};
	}
	const reasoningEffortMap: Partial<Record<Effort, string>> = {};
	for (const effort of capability.efforts) reasoningEffortMap[effort] = effort;
	if (format === "responses") {
		return {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
			omitReasoningEffort: false,
			reasoningEffortMap,
		};
	}
	if (
		format !== "openai" &&
		format !== "openrouter" &&
		format !== "zai" &&
		format !== "qwen" &&
		format !== "qwen-chat-template" &&
		format !== "chat-template"
	)
		return undefined;
	const effortAccepted = capability.attempts.some(
		attempt => attempt.format === format && attempt.accepted && attempt.effort !== undefined,
	);
	const toggleOnly = (format === "zai" || format === "qwen" || format === "qwen-chat-template") && !effortAccepted;
	const reasoningDisableMode =
		format === "openrouter"
			? "openrouter-enabled-false"
			: format === "zai"
				? "zai-thinking-disabled"
				: format === "qwen"
					? "qwen-enable-thinking-false"
					: format === "qwen-chat-template"
						? "qwen-template-false"
						: format === "chat-template"
							? "chat-template-thinking-false"
							: "omit";
	return {
		thinkingFormat: format,
		reasoningDisableMode,
		supportsReasoningParams: true,
		supportsReasoningEffort: !toggleOnly,
		omitReasoningEffort: toggleOnly,
		reasoningEffortMap,
		...(format === "qwen" || format === "qwen-chat-template" ? { qwenTemplateReasoningEffort: effortAccepted } : {}),
		...(format === "zai" ? { zaiReasoningEffortDialect: effortAccepted } : {}),
	};
}

function learnedThinking(capability: ThinkingCapability): ThinkingConfig | undefined {
	if (capability.format === "none") return undefined;
	const mode =
		capability.format === "anthropic-adaptive"
			? "anthropic-adaptive"
			: capability.format === "google-level"
				? "google-level"
				: capability.format === "anthropic-budget" || capability.format === "google-budget"
					? "budget"
					: "effort";
	const effortMap: Partial<Record<Effort, string>> = {};
	for (const effort of capability.efforts) effortMap[effort] = effort;
	return {
		mode,
		efforts: capability.efforts,
		effortMap,
		...(capability.format === "google-budget" ? { effortBudgets: GOOGLE_THINKING_BUDGETS } : {}),
	};
}

/** Purely overlay learned controls on an unverified model, preserving authored/advertised capability. */
export function applyThinkingCapability<TApi extends Api>(
	model: Model<TApi>,
	capability: ThinkingCapability,
): Model<TApi> {
	if (!model.thinking?.unverified || !isCapability(capability)) return model;
	const spec = toModelSpec(model);
	const openAI =
		model.api === "openai-completions" ||
		model.api === "openrouter" ||
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	const anthropicOverrides: AnthropicCompat | undefined =
		model.api !== "anthropic-messages"
			? undefined
			: capability.format === "anthropic-adaptive"
				? { disableAdaptiveThinking: false, supportsOutputEffort: true }
				: capability.format === "none"
					? { disabledThinking: "omit", supportsOutputEffort: false }
					: undefined;
	const overrides = openAI ? openAIOverrides(capability) : anthropicOverrides;
	const thinking = learnedThinking(capability);
	const built = buildModel<TApi>({
		...spec,
		reasoning: capability.format !== "none" || capability.observed,
		thinking,
		...(overrides ? { compat: Object.assign({}, spec.compat, overrides) } : {}),
	});
	// Native reasoning without a dial must not inherit a fallback ladder; learned
	// controls are exact, not inputs for further rule-owned ladder expansion.
	return { ...built, thinking };
}

/** Load and apply cached controls only while capability remains unverified. */
export function withThinkingCapability<TApi extends Api>(model: Model<TApi>, dbPath?: string): Model<TApi> {
	if (!model.thinking?.unverified) return model;
	const capability = readThinkingCapability(model, dbPath);
	return capability === undefined ? model : applyThinkingCapability(model, capability);
}
