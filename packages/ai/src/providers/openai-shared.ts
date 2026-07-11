import type { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { toFirepassWireModelId, toFireworksWireModelId } from "@pk-nerdsaver-ai/pi-catalog/fireworks-model-id";
import { isGlm52ReasoningEffortModelId } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { calculateCost } from "@pk-nerdsaver-ai/pi-catalog/models";
import type {
	OpenAICompat,
	OpenAIReasoningDisableMode,
	OpenAIStreamMarkupHealingPattern,
	OpenRouterRouting,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	VercelGatewayRouting,
} from "@pk-nerdsaver-ai/pi-catalog/types";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
} from "@pk-nerdsaver-ai/pi-catalog/wire/coreweave";
import { parseGitHubCopilotApiKey } from "@pk-nerdsaver-ai/pi-catalog/wire/github-copilot";
import {
	$env,
	extractHttpStatusFromError,
	logger,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	structuredCloneJSON,
} from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Context,
	type ImageContent,
	type Message,
	type MessageAttribution,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	type Provider,
	type ResolvedServiceTier,
	resolveServiceTier,
	type ServiceTier,
	type StopReason,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type TextSignatureV1,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "../types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingArgumentsDone,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { getOpenRouterHeaders } from "../utils/openrouter-headers";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import type { ChatCompletionCreateParamsStreaming } from "./openai-chat-wire";
import type { InputItem } from "./openai-codex/request-transformer";
import type {
	ResponseContentPartAddedEvent,
	ResponseCreateParamsStreaming,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

export interface OpenAIModelIdentity {
	provider: string;
	id: string;
	baseUrl?: string;
}

export interface OpenAIStrictToolsScope {
	provider: string;
	baseUrl: string | undefined;
	modelId: string;
}

export interface OpenAIStrictToolsState {
	strictTools: {
		disabledModelScopes: Set<string>;
	};
}

export interface OpenAIRequestSetupModel extends OpenAIModelIdentity {
	headers?: Record<string, string>;
	premiumMultiplier?: number;
	compat?: Pick<ResolvedOpenAISharedCompat, "promptCacheSessionHeader">;
}

export interface OpenAIResponsesCacheOptions {
	cacheRetention?: CacheRetention;
	sessionId?: string;
	promptCacheKey?: string;
}

export interface OpenAIRequestSetupOptions {
	apiKey?: string;
	extraHeaders?: Record<string, string>;
	initiatorOverride?: MessageAttribution;
	messages: Message[];
	defaultBaseUrl?: string;
	prependHeaders?: () => Record<string, string>;
	alibabaCodingPlanAuth?: boolean;
	azureChatCompletions?: {
		apiVersion: string;
		deploymentName: string;
	};
	openAISessionId?: string;
	promptCacheSessionId?: string;
}

export interface OpenAIRequestSetup {
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	headers: Record<string, string>;
	query: Record<string, string> | undefined;
	requestHeaders: Record<string, string>;
}

function normalizeSakanaRequestBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim();
	if (!value) return undefined;
	const normalized = value.replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function resolveSakanaRequestBaseUrl(): string | undefined {
	return normalizeSakanaRequestBaseUrl($env.SAKANA_BASE_URL) ?? normalizeSakanaRequestBaseUrl($env.FUGU_BASE_URL);
}

function applyCoreWeaveProjectHeader(headers: Record<string, string>): void {
	if (hasCoreWeaveProjectHeader(headers)) {
		return;
	}
	const projectHeaders = coreWeaveProjectHeaders($env);
	if (projectHeaders) {
		headers[COREWEAVE_PROJECT_HEADER] = projectHeaders[COREWEAVE_PROJECT_HEADER];
	}
}

export function resolveOpenAIRequestSetup(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): OpenAIRequestSetup {
	let apiKey = options.apiKey;
	if (!apiKey) {
		if (!$env.OPENAI_API_KEY) {
			throw new AIError.MissingApiKeyError(
				undefined,
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}
	const rawApiKey = apiKey;
	let headers = { ...(model.headers ?? {}) };
	if (model.provider === "openrouter") {
		Object.assign(headers, getOpenRouterHeaders());
	}
	Object.assign(headers, options.extraHeaders);
	if (model.provider === "coreweave") {
		applyCoreWeaveProjectHeader(headers);
	}
	if (options.prependHeaders) {
		headers = { ...options.prependHeaders(), ...headers };
	}

	let copilotPremiumRequests: number | undefined;
	let baseUrl = model.baseUrl;
	if (model.provider === "moonshot") {
		// Bundled `moonshot` catalog models hardcode the international endpoint
		// (`api.moonshot.ai`). MOONSHOT_BASE_URL lets users redirect the provider
		// at the China platform (`api.moonshot.cn`), which only accepts China keys
		// and rejects the international host. (#2883)
		const moonshotBaseUrl = $env.MOONSHOT_BASE_URL?.trim();
		if (moonshotBaseUrl) {
			baseUrl = moonshotBaseUrl;
		}
	}
	if (model.provider === "sakana") {
		const sakanaBaseUrl = resolveSakanaRequestBaseUrl();
		if (sakanaBaseUrl) {
			baseUrl = sakanaBaseUrl;
		}
	}
	if (model.provider === "github-copilot") {
		apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
		const copilot = buildCopilotDynamicHeaders({
			messages: options.messages,
			hasImages: hasCopilotVisionInput(options.messages),
			premiumMultiplier: model.premiumMultiplier,
			headers,
			initiatorOverride: options.initiatorOverride,
		});
		Object.assign(headers, copilot.headers);
		copilotPremiumRequests = copilot.premiumRequests;
		baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl;
	}

	if (options.alibabaCodingPlanAuth && model.provider === "alibaba-coding-plan") {
		try {
			const parsed = JSON.parse(rawApiKey);
			if (typeof parsed?.token === "string") {
				apiKey = parsed.token;
			}
			if (typeof parsed?.enterpriseUrl === "string") {
				baseUrl = parsed.enterpriseUrl;
			}
		} catch {
			// Not JSON — use raw apiKey and catalog baseUrl.
		}
	}

	let query: Record<string, string> | undefined;
	if (options.azureChatCompletions && baseUrl?.includes(".openai.azure.com")) {
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${options.azureChatCompletions.deploymentName}`;
		}
		query = { "api-version": options.azureChatCompletions.apiVersion };
	}

	if (options.openAISessionId && model.provider === "openai") {
		headers.session_id ??= options.openAISessionId;
		headers["x-client-request-id"] ??= options.openAISessionId;
	}
	if (options.promptCacheSessionId && model.compat?.promptCacheSessionHeader) {
		headers[model.compat.promptCacheSessionHeader] ??= options.promptCacheSessionId;
	}

	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}
	const requestHeaders = { ...headers };
	headers.Authorization ??= `Bearer ${apiKey}`;
	return { copilotPremiumRequests, baseUrl, headers, query, requestHeaders };
}

export function applyOpenAIServiceTier(
	params: { service_tier?: ResolvedServiceTier | "auto" | "default" | null | undefined },
	serviceTier: ServiceTier | null | undefined,
	provider: Provider | undefined,
): void {
	if (!shouldSendServiceTier(serviceTier, provider)) return;
	const resolved = resolveServiceTier(serviceTier, provider);
	if (resolved === "flex" || resolved === "scale" || resolved === "priority") {
		params.service_tier = resolved;
	}
}

/**
 * Standard OpenAI Responses service-tier cost multipliers. The non-Codex
 * Responses path bills the tier it was served (or requested): Flex processing is
 * half price; Priority is a 2x premium. Codex bills the same tiers with its own
 * table (Priority is 2.5x on gpt-5.5) and applies that separately.
 */
function getOpenAIResponsesServiceTierCostMultiplier(tier: string | null | undefined): number {
	switch (tier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

/**
 * Adjust resolved cost by the service tier OpenAI actually billed — parity with
 * Codex (`applyCodexServiceTierPricing`), but with the standard (non-Codex)
 * multipliers. The served tier comes from the response echo, falling back to the
 * resolved request tier. Scoped to `provider: "openai"` (the only standard
 * Responses biller) so an echoed `service_tier` from an Azure/OpenRouter/Copilot
 * proxy can never skew those costs.
 */
export function applyOpenAIResponsesServiceTierCost(
	model: Pick<Model, "provider">,
	usage: AssistantMessage["usage"],
	responseServiceTier: unknown,
	requestServiceTier: ServiceTier | null | undefined,
): void {
	if (model.provider !== "openai") return;
	// The response echo is authoritative when present (OpenAI may downgrade a
	// requested priority/flex turn to default under load); only fall back to the
	// requested tier when the response omits the echo entirely.
	const served =
		typeof responseServiceTier === "string"
			? responseServiceTier
			: resolveServiceTier(requestServiceTier, model.provider);
	const multiplier = getOpenAIResponsesServiceTierCostMultiplier(served);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export interface OpenAIUsageAccountingInput {
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cacheWriteOpenRouter: number | undefined;
	cacheWriteDeepSeek: number | undefined;
	hasDeepSeekCacheHitAndMiss: boolean;
}

export interface OpenAIUsageAccounting {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
}

export function calculateOpenAIUsageAccounting(accounting: OpenAIUsageAccountingInput): OpenAIUsageAccounting {
	const cacheWriteTokens = accounting.cacheWriteOpenRouter ?? accounting.cacheWriteDeepSeek ?? 0;
	const isDeepSeekUsage =
		accounting.hasDeepSeekCacheHitAndMiss &&
		accounting.cacheWriteOpenRouter === undefined &&
		(accounting.cacheWriteDeepSeek ?? 0) > 0;
	const input = isDeepSeekUsage
		? Math.max(0, accounting.promptTokens - accounting.cachedTokens)
		: Math.max(0, accounting.promptTokens - accounting.cachedTokens - cacheWriteTokens);
	const cacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
	return {
		input,
		output: accounting.outputTokens,
		cacheRead: accounting.cachedTokens,
		cacheWrite,
		totalTokens: input + accounting.outputTokens + accounting.cachedTokens + cacheWrite,
		...(accounting.reasoningTokens > 0 ? { reasoningTokens: accounting.reasoningTokens } : {}),
	};
}

export function normalizeOpenAIResponsesPromptCacheKey(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 64, "pc_");
}

export function normalizeOpenRouterResponsesSessionId(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 256, "session_");
}

export function getOpenAIResponsesPromptCacheKey(options: OpenAIResponsesCacheOptions | undefined): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIResponsesPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAIResponsesCacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
}

export function getOpenRouterResponsesSessionId(
	options: Pick<OpenAIResponsesCacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenRouterResponsesSessionId(options?.sessionId);
}

export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function createOpenAIStrictToolsState(): OpenAIStrictToolsState {
	return {
		strictTools: {
			disabledModelScopes: new Set<string>(),
		},
	};
}

export function clearOpenAIStrictToolsState(state: OpenAIStrictToolsState): void {
	state.strictTools.disabledModelScopes.clear();
}

export function getOpenAIStrictToolsScope(
	model: OpenAIModelIdentity,
	resolvedBaseUrl: string | undefined,
): OpenAIStrictToolsScope {
	return {
		provider: model.provider,
		baseUrl: resolvedBaseUrl ?? model.baseUrl,
		modelId: model.id,
	};
}

export function isStrictToolsDisabledForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): boolean {
	if (!scope) return false;
	return (
		state?.strictTools.disabledModelScopes.has(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`) ?? false
	);
}

export function disableStrictToolsForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): void {
	if (!scope) return;
	state?.strictTools.disabledModelScopes.add(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`);
}

export function isOpenRouterAnthropicModel(model: OpenAIModelIdentity): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

/**
 * Append an OpenRouter routing-variant suffix (e.g. `:nitro`, `:floor`, `:online`, `:exacto`)
 * to a model id when no explicit variant is already present. A variant is considered
 * "already present" when `modelId` contains a colon after the last `/` separator —
 * which covers both user-typed selectors (`anthropic/claude-haiku:nitro`) and catalog
 * entries that bake the variant in (`deepseek/deepseek-v3.1-terminus:exacto`).
 */
export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
}

export function applyWireModelIdTransform(
	baseId: string,
	mode: ResolvedOpenAISharedCompat["wireModelIdMode"],
	openrouterVariant?: string,
): string {
	switch (mode) {
		case "firepass":
			return toFirepassWireModelId(baseId);
		case "fireworks":
			return toFireworksWireModelId(baseId);
		case "openrouter":
			return applyOpenRouterRoutingVariant(baseId, openrouterVariant);
		default:
			return baseId;
	}
}

export interface OpenAIOutputTokenParam {
	field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
	value: number;
}

export interface ResolveOpenAIOutputTokenInput {
	/** Wire field the endpoint expects for the output cap. */
	field: OpenAIOutputTokenParam["field"];
	/** Caller-supplied output cap (model-defaulted by `stream.ts`, or null/undefined on direct provider calls). */
	maxTokens: number | null | undefined;
	/** Whether the caller explicitly set `maxTokens` (routing omission only applies when false). */
	maxTokensExplicit: boolean;
	/** Model output cap (`model.maxTokens`). */
	modelMaxTokens: number | null | undefined;
	/** Drop the field entirely — proxies with unknown upstream caps (Ollama via `model.omitMaxOutputTokens`). */
	omitMaxOutputTokens: boolean;
	/** The model sits behind OpenRouter (catalog default caps are omitted so each upstream self-caps). */
	isOpenRouterHost: boolean;
	/** Endpoint always needs a cap (Kimi-family TPM math); supplies the model default when the caller did not. */
	alwaysSendMaxTokens: boolean;
	/** Hard provider clamp; defaults to {@link OPENAI_MAX_OUTPUT_TOKENS}. */
	providerOutputClamp?: number;
}

/**
 * Resolve the single output-token wire parameter shared by Chat Completions
 * (`max_tokens`/`max_completion_tokens`) and the Responses family
 * (`max_output_tokens`). Centralizes the provider exceptions that previously
 * lived inline in both `buildParams`:
 *  - `alwaysSendMaxTokens`: Kimi-family endpoints derive TPM limits from the
 *    cap and require one on every call, so default from the model cap (or
 *    {@link OPENAI_MAX_OUTPUT_TOKENS}) when the caller omitted it.
 *  - OpenRouter routing omission: OpenRouter fans out to upstreams whose output
 *    caps differ from the catalog value, so a catalog default above the routed
 *    upstream's cap makes OpenRouter skip that upstream. Omit catalog defaults
 *    (explicit caller caps still win) so `provider.order`/`only` is honored.
 *  - model/provider clamp: never exceed `model.maxTokens` or the provider clamp
 *    (`OPENAI_MAX_OUTPUT_TOKENS`, raised for GLM-5.2 reasoning by the caller).
 *  - `omitMaxOutputTokens`: proxies (Ollama) with unknown upstream caps drop it.
 */
export function resolveOpenAIOutputTokenParam(
	input: ResolveOpenAIOutputTokenInput,
): OpenAIOutputTokenParam | undefined {
	if (input.omitMaxOutputTokens) return undefined;
	const requested =
		input.maxTokens ?? (input.alwaysSendMaxTokens ? (input.modelMaxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined);
	if (requested === undefined) return undefined;
	if (input.isOpenRouterHost && !input.alwaysSendMaxTokens && !input.maxTokensExplicit) return undefined;
	const value = Math.min(
		requested,
		input.modelMaxTokens ?? Number.POSITIVE_INFINITY,
		input.providerOutputClamp ?? OPENAI_MAX_OUTPUT_TOKENS,
	);
	if (!(value > 0)) return undefined;
	return { field: input.field, value };
}

export interface OpenAIGatewayRoutingParams {
	provider?: OpenRouterRouting;
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
}

export interface OpenAIGatewayRoutingCompat {
	isOpenRouterHost: boolean;
	openRouterRouting?: OpenRouterRouting;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

/**
 * Apply gateway routing preferences to the request body. OpenRouter routes via
 * the top-level `provider` field; the Vercel AI Gateway routes via
 * `providerOptions.gateway`. Both Chat Completions and Responses call this; the
 * Vercel branch is inert for Responses, whose resolved compat never sets
 * `isVercelGatewayHost`.
 */
export function applyOpenAIGatewayRouting(
	params: OpenAIGatewayRoutingParams,
	compat: OpenAIGatewayRoutingCompat,
): void {
	if (compat.isOpenRouterHost && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting) {
		const routing = compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: { only?: string[]; order?: string[] } = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
}

export interface OpenAIExtraBodyOptions {
	/**
	 * Fireworks rejects DeepSeek-style `thinking` toggles alongside OpenAI-style
	 * `reasoning_effort`; drop `thinking` when the effort field carries the level.
	 */
	dropThinkingWhenReasoningEffort?: boolean;
}

/**
 * Merge a compat/options `extraBody` blob into the request params. When
 * `dropThinkingWhenReasoningEffort` is set and `reasoning_effort` is present,
 * delete the conflicting `thinking` toggle (Fireworks rejects both together).
 */
export function applyOpenAIExtraBody<P extends object>(
	params: P,
	extraBody: Record<string, unknown> | undefined,
	options?: OpenAIExtraBodyOptions,
): void {
	if (!extraBody) return;
	Object.assign(params, extraBody);
	if (options?.dropThinkingWhenReasoningEffort) {
		const shaped = params as { reasoning_effort?: unknown; thinking?: unknown };
		if (shaped.reasoning_effort !== undefined) {
			delete shaped.thinking;
		}
	}
}

/**
 * Chat Completions streaming request body shaped by the OpenAI-family providers.
 * Extends the vendored SDK params with the compat dialect fields pi-ai emits
 * (binary `thinking`, Qwen `enable_thinking`/`chat_template_kwargs`, nested
 * `reasoning`, gateway `provider`/`providerOptions`, sampling extras). Lives in
 * the shared module beside the request-shaping helpers that mutate it.
 */
export type OpenAICompletionsParams = Omit<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "service_tier"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled"; keep?: "all" };
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean };
	reasoning?: { effort?: string } | { enabled: false };
	reasoning_effort?: string | null;
	service_tier?: ResolvedServiceTier;
	tool_stream?: boolean;
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

/** Reasoning-relevant slice of caller options the Chat Completions dialect dispatch reads. */
export interface ChatCompletionsReasoningOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	disableReasoning?: boolean;
}

export type OpenAICompatEndpoint = "chat-completions" | "responses";

export type OpenAIReasoningDisableReason = "caller" | "forced-tool-choice" | "tool-choice" | "not-requested";

export type OpenAICompatPolicyCompat = ResolvedOpenAISharedCompat &
	Partial<ResolvedOpenAICompat> &
	Partial<ResolvedOpenAIResponsesCompat>;

export interface ResolveOpenAICompatPolicyOptions {
	endpoint: OpenAICompatEndpoint;
	compat?: OpenAICompatPolicyCompat;
	reasoning?: string;
	disableReasoning?: boolean;
	toolChoice?: unknown;
	strictResponsesPairing?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	omitReasoningEffort?: boolean;
}

export interface OpenAICompatPolicy {
	endpoint: OpenAICompatEndpoint;
	compat: OpenAICompatPolicyCompat;
	reasoning: {
		modelSupported: boolean;
		supportsParams: boolean;
		requestedEffort?: string;
		wireEffort?: string;
		enabled: boolean;
		disabled: boolean;
		disableReason?: OpenAIReasoningDisableReason;
		dialect: ResolvedOpenAISharedCompat["thinkingFormat"];
		disableMode: OpenAIReasoningDisableMode;
		omitReasoningEffort: boolean;
		includeEncryptedReasoning: boolean;
		filterReasoningHistory: boolean;
		requiresReasoningContentForToolCalls: boolean;
		requiresReasoningContentForAllAssistantTurns: boolean;
		allowsSyntheticReasoningContentForToolCalls: boolean;
		reasoningContentField?: OpenAICompat["reasoningContentField"];
		requiresThinkingAsText: boolean;
	};
	tools: {
		strictResponsesPairing: boolean;
		toolCallIdKind: "default" | "openai-40" | "mistral-9-alnum";
	};
	messages: {
		systemRole: "system" | "developer";
		supportsDeveloperRole: boolean;
		supportsMultipleSystemMessages: boolean;
	};
	stream: {
		stripSpecialTokens: "deepseek" | false;
		markupHealingPattern?: OpenAIStreamMarkupHealingPattern;
		reasoningDeltasMayBeCumulative: boolean;
		emptyLengthFinishIsContextError: boolean;
	};
}

function mapOpenAIReasoningEffort(
	model: Pick<Model, "thinking">,
	compat: OpenAICompatPolicyCompat,
	effort: string,
): string {
	const level = effort as Effort;
	return compat.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? effort;
}

function isImplicitDisableWhenNotRequested(disableMode: OpenAIReasoningDisableMode): boolean {
	return (
		disableMode === "zai-thinking-disabled" ||
		disableMode === "qwen-enable-thinking-false" ||
		disableMode === "qwen-template-false"
	);
}

export function resolveOpenAICompatPolicy<TApi extends Api>(
	model: Model<TApi>,
	options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
	const baseCompat = (options.compat ?? model.compat) as OpenAICompatPolicyCompat;
	const requestedEffort = options.reasoning;
	const modelSupported = Boolean(model.reasoning);
	const forcedToolChoiceSuppressesReasoning =
		baseCompat.disableReasoningOnForcedToolChoice &&
		baseCompat.supportsForcedToolChoice &&
		isForcedToolChoice(options.toolChoice);
	const anyToolChoiceSuppressesReasoning =
		!forcedToolChoiceSuppressesReasoning &&
		baseCompat.disableReasoningOnToolChoice &&
		options.toolChoice !== undefined;
	const requestedAndAllowed = requestedEffort !== undefined && !options.disableReasoning && modelSupported;
	const conflictDisableReason: OpenAIReasoningDisableReason | undefined = forcedToolChoiceSuppressesReasoning
		? "forced-tool-choice"
		: anyToolChoiceSuppressesReasoning
			? "tool-choice"
			: undefined;
	const disableReason: OpenAIReasoningDisableReason | undefined = options.disableReasoning
		? "caller"
		: conflictDisableReason;
	const enabledBeforeThinkingVariant = requestedAndAllowed && disableReason === undefined;
	const baseWireEffort =
		enabledBeforeThinkingVariant && requestedEffort !== undefined
			? mapOpenAIReasoningEffort(model, baseCompat, requestedEffort)
			: undefined;
	const disabledByNoneEffort =
		enabledBeforeThinkingVariant &&
		baseCompat.reasoningDisableMode === "zai-thinking-disabled" &&
		baseWireEffort === "none";
	const enabled = enabledBeforeThinkingVariant && !disabledByNoneEffort;
	const compat =
		enabled && baseCompat.whenThinking ? (baseCompat.whenThinking as OpenAICompatPolicyCompat) : baseCompat;
	const omitReasoningEffort =
		options.omitReasoningEffort ?? (compat.omitReasoningEffort || !compat.supportsReasoningEffort);
	const disableMode = compat.reasoningDisableMode;
	let wireEffort =
		enabled && requestedEffort !== undefined ? mapOpenAIReasoningEffort(model, compat, requestedEffort) : undefined;
	const disabledWithoutRequest =
		modelSupported &&
		requestedEffort === undefined &&
		!options.disableReasoning &&
		isImplicitDisableWhenNotRequested(disableMode);
	const disabled =
		(modelSupported && disableReason === "caller") ||
		conflictDisableReason !== undefined ||
		(modelSupported && disabledWithoutRequest) ||
		disabledByNoneEffort;
	if (
		disabled &&
		disableReason === "caller" &&
		requestedEffort === undefined &&
		disableMode === "lowest-effort" &&
		compat.supportsReasoningEffort &&
		!omitReasoningEffort
	) {
		const minEffort = getSupportedEfforts(model)[0];
		if (minEffort === undefined) {
			throw new AIError.ConfigurationError(`Model ${model.provider}/${model.id} has no supported reasoning efforts`);
		}
		wireEffort = mapOpenAIReasoningEffort(model, compat, minEffort);
	}

	return {
		endpoint: options.endpoint,
		compat,
		reasoning: {
			modelSupported,
			supportsParams: compat.supportsReasoningParams,
			requestedEffort,
			wireEffort,
			enabled,
			disabled,
			disableReason: disableReason ?? (disabledWithoutRequest || disabledByNoneEffort ? "not-requested" : undefined),
			dialect: compat.thinkingFormat,
			requiresReasoningContentForToolCalls: compat.requiresReasoningContentForToolCalls,
			requiresReasoningContentForAllAssistantTurns: compat.requiresReasoningContentForAllAssistantTurns,
			allowsSyntheticReasoningContentForToolCalls: compat.allowsSyntheticReasoningContentForToolCalls,
			reasoningContentField: compat.reasoningContentField,
			requiresThinkingAsText: compat.requiresThinkingAsText,
			disableMode,
			omitReasoningEffort,
			includeEncryptedReasoning: options.includeEncryptedReasoning ?? compat.includeEncryptedReasoning,
			filterReasoningHistory: options.filterReasoningHistory ?? compat.filterReasoningHistory,
		},
		tools: {
			strictResponsesPairing: options.strictResponsesPairing ?? compat.strictResponsesPairing ?? false,
			toolCallIdKind: compat.requiresMistralToolIds
				? "mistral-9-alnum"
				: compat.usesOpenAIToolCallIdLimit
					? "openai-40"
					: "default",
		},
		messages: {
			systemRole: modelSupported && compat.supportsDeveloperRole ? "developer" : "system",
			supportsDeveloperRole: compat.supportsDeveloperRole,
			supportsMultipleSystemMessages: compat.supportsMultipleSystemMessages ?? true,
		},
		stream: {
			stripSpecialTokens: compat.stripDeepseekSpecialTokens ? "deepseek" : false,
			markupHealingPattern: compat.streamMarkupHealingPattern,
			reasoningDeltasMayBeCumulative: compat.reasoningDeltasMayBeCumulative,
			emptyLengthFinishIsContextError: compat.emptyLengthFinishIsContextError,
		},
	};
}

function encodeChatCompletionsDisabledReasoning(
	params: OpenAICompletionsParams,
	disableMode: OpenAIReasoningDisableMode,
): void {
	delete params.reasoning_effort;
	switch (disableMode) {
		case "zai-thinking-disabled":
			params.thinking = { type: "disabled" };
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = false;
			break;
		case "qwen-template-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: false };
			break;
		case "openrouter-enabled-false":
			(params as typeof params & { reasoning?: { effort?: string } | { enabled: false } }).reasoning = {
				enabled: false,
			};
			break;
		default:
			delete params.reasoning;
			break;
	}
}

export function applyChatCompletionsCompatPolicy(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	// `preserve_thinking` is a chat-template HISTORY knob, not a per-turn
	// thinking switch — it controls whether OLDER assistant turns render
	// with `<think>...</think>` on Qwen3.6+. Emit it BEFORE the reasoning
	// state branches and EVERY early-return below, because the wire shape
	// must carry the kwarg in three cases the auto-detected
	// `qwenPreserveThinking` flag covers but `reasoning.enabled` does not:
	//
	// 1. Discovered local Qwen models. `discoverOpenAICompatibleModels`
	//    stamps `reasoning: false` on every spec built from a generic
	//    `/v1/models` endpoint (the upstream doesn't advertise the
	//    capability), so `model.reasoning === false` → `reasoning.enabled
	//    === false`, the body wouldn't otherwise see the kwarg, and the
	//    encoder's `replayReasoningContent` branch would keep shipping
	//    `reasoning_content` only for the template to strip `<think>` from
	//    older turns anyway. Exactly the #3528 / #3541 symptom on every
	//    discovered Qwen build.
	// 2. Caller-disabled reasoning. The slot's KV cache still holds prior
	//    `<think>...</think>` tokens from earlier thinking turns; the
	//    template must keep rendering them or cache invalidates at the
	//    first historic `<think>`.
	// 3. Forced-tool-choice / DeepSeek-style auto-disable. Same reasoning
	//    as (2) — historic thinking blocks have to survive history replay
	//    even when the current turn cannot think.
	//
	// Non-Qwen templates ignore the parameter (jinja `is defined` check
	// silently no-ops), so emitting it unconditionally for the Qwen-family
	// + local-cache compat flag is safe.
	if (policy.compat.qwenPreserveThinking) {
		// Mirror the dialect split that gates `enable_thinking`. The
		// `qwen` dialect rides the top-level field (the only place
		// llama.cpp's `--jinja` hook AND Alibaba Cloud Model Studio's
		// compatible-mode look) while the `qwen-chat-template` dialect
		// (NVIDIA NIM, vLLM/SGLang's chat-template-kwargs path) MUST
		// ride only the kwargs copy — NIM's request schema is
		// `additionalProperties: false` and rejects every unknown
		// top-level field, the very reason `enable_thinking` is
		// route-split this way (#2299, see `catalog/src/compat/openai.ts`
		// thinkingFormat comment).
		if (policy.compat.thinkingFormat === "qwen") {
			params.preserve_thinking = true;
		}
		params.chat_template_kwargs = { ...params.chat_template_kwargs, preserve_thinking: true };
	}

	const reasoning = policy.reasoning;
	if ((!reasoning.modelSupported && !reasoning.disabled) || !reasoning.supportsParams) return;
	if (reasoning.enabled) {
		switch (reasoning.disableMode) {
			case "zai-thinking-disabled":
				if (reasoning.wireEffort === "none") {
					encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
					return;
				}
				params.thinking = { type: "enabled" };
				if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
				if (policy.compat.supportsReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
			case "qwen-enable-thinking-false":
				params.enable_thinking = true;
				break;
			case "qwen-template-false":
				// Spread so the `preserve_thinking` kwarg hoisted above
				// survives the merge — a bare `{ enable_thinking: true }`
				// would clobber it.
				params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: true };
				break;
			case "openrouter-enabled-false":
				if (reasoning.wireEffort !== undefined) {
					(params as typeof params & { reasoning?: { effort?: string } }).reasoning = {
						effort: reasoning.wireEffort,
					};
				}
				break;
			default:
				if (!reasoning.omitReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
		}
		return;
	}
	if (!reasoning.disabled) return;
	if (
		reasoning.disableReason === "caller" &&
		reasoning.requestedEffort === undefined &&
		reasoning.disableMode === "lowest-effort" &&
		reasoning.wireEffort !== undefined
	) {
		params.reasoning_effort = reasoning.wireEffort as Effort;
		return;
	}
	encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
}

export function applyChatCompletionsReasoningParams(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	options: (ChatCompletionsReasoningOptions & { toolChoice?: unknown }) | undefined,
): void {
	applyChatCompletionsCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			compat,
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
		}),
	);
}

export function disableChatCompletionsReasoningForDialect(
	params: OpenAICompletionsParams,
	compat: ResolvedOpenAICompat,
): void {
	encodeChatCompletionsDisabledReasoning(params, compat.reasoningDisableMode);
}

/**
 * Z.AI/GLM-5.2 reasoning-effort dialect predicate. GLM-5.2 models served on a
 * Z.AI-format host (thinkingFormat "zai") accept `reasoning_effort`, stream tool
 * calls via `tool_stream`, and clamp output to the model cap. Moonshot Kimi and
 * Xiaomi MiMo also resolve to thinkingFormat "zai" with supportsReasoningEffort
 * true but are NOT GLM-5.2, so the model-id check is load-bearing — never swap it
 * for `compat.supportsReasoningEffort`.
 */
function isZaiReasoningEffortDialect(model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && isGlm52ReasoningEffortModelId(model.id);
}

/**
 * Output-token clamp for the Z.AI/GLM-5.2 reasoning dialect: these hosts accept
 * the full model window on reasoning turns, so clamp to the model cap. Returns
 * `undefined` for every other model, leaving {@link resolveOpenAIOutputTokenParam}
 * on its default `OPENAI_MAX_OUTPUT_TOKENS` clamp.
 */
export function resolveZaiReasoningOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	return isZaiReasoningEffortDialect(model, compat) ? (model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined;
}

/**
 * Enable `tool_stream` for Z.AI/GLM-5.2 reasoning models when tools are present
 * (GLM-5.2 streams tool-call arguments incrementally and needs the flag to do so).
 */
export function applyChatCompletionsToolStream(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): void {
	if (
		isZaiReasoningEffortDialect(model, compat) &&
		compat.supportsReasoningEffort &&
		Array.isArray(params.tools) &&
		params.tools.length > 0
	) {
		params.tool_stream = true;
	}
}

export function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return (
		/invalid_request_error/i.test(messageParts) &&
		/compiled grammar/i.test(messageParts) &&
		/too large/i.test(messageParts)
	);
}

export function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	strictToolsApplied: boolean,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || !strictToolsApplied) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) return false;
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return /wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool|tool parameters? schema|invalid schema for function/i.test(
		messageParts,
	);
}

function normalizeOpenAIStableId(value: string | undefined, maxLength: number, hashPrefix: string): string | undefined {
	if (!value || value.length === 0) return undefined;
	const wellFormed = value.toWellFormed();
	if (wellFormed.length <= maxLength) return wellFormed;
	return `${hashPrefix}${Bun.hash(wellFormed).toString(36)}`;
}

export const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

export function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		} else if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			knownCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return knownCallIds;
}

/** Scan replay items for call_ids that were originally custom tool calls. */
export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (
			(item as { type?: string }).type === "custom_tool_call" &&
			typeof (item as { call_id?: string }).call_id === "string"
		) {
			customCallIds.add((item as { call_id: string }).call_id);
		}
	}
	return customCallIds;
}

/**
 * Convert orphan `function_call_output` / `custom_tool_call_output` items —
 * those whose `call_id` has no matching preceding `function_call` /
 * `custom_tool_call` in the same input — into assistant text notes.
 *
 * The Responses API rejects unpaired outputs with
 * `400 No tool call found for function call output with call_id …`. Orphans
 * sneak in through two paths today:
 *
 * - A previous turn's `providerPayload` snapshot replaces the input array via
 *   the `dt: false` splice (see {@link convertConversationMessages}), wiping
 *   the matching `function_call` while leaving the matching
 *   `function_call_output` queued in a later `toolResult`.
 * - A locally-rejected tool call (argument-validation failure, hook reject,
 *   aborted turn before the call streamed) produces a tool result without a
 *   `function_call` ever landing in any persisted provider payload.
 *
 * Dropping the result loses information the model needs to recover; sending
 * it as-is 400s the request. Folding it into an assistant `message` preserves
 * the payload (call_id + truncated output) while staying within the Responses
 * input grammar. Matches the behavior of {@link transformRequestBody} in the
 * codex provider — issue #1351 / regression of #472.
 */
export function repairOrphanResponsesToolOutputs(input: ResponseInput): ResponseInput {
	const knownCallIds = new Set<string>();
	for (const item of input) {
		const t = (item as { type?: string }).type;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId !== "string") continue;
		if (t === "function_call" || t === "custom_tool_call") knownCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string" && !knownCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	return input.map(item => {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") return item;
		const record = item as { call_id?: unknown; output?: unknown; name?: unknown };
		const callId = record.call_id;
		if (typeof callId !== "string" || knownCallIds.has(callId)) return item;
		const toolName = typeof record.name === "string" && record.name.length > 0 ? record.name : "tool";
		const rawOutput = record.output;
		let text: string;
		if (typeof rawOutput === "string") text = rawOutput;
		else if (rawOutput == null) text = "";
		else {
			try {
				text = JSON.stringify(rawOutput);
			} catch {
				text = String(rawOutput);
			}
		}
		const ORPHAN_OUTPUT_LIMIT = 16_000;
		if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
		return {
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number];
	});
}

/** Placeholder output for a tool call whose result is absent from the input. */
const ORPHAN_TOOL_CALL_PLACEHOLDER =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

/**
 * Synthesize a placeholder `function_call_output` / `custom_tool_call_output`
 * for every `function_call` / `custom_tool_call` whose `call_id` has no matching
 * output later in the same input. The Responses API rejects an unpaired call
 * with `400 No tool output found for function call …`.
 *
 * Orphan calls surface when the user branches/navigates the session tree to a
 * node that ends on a tool call (the tool-result child is excluded from the
 * reconstructed history) or when a turn is aborted/crashes after the call
 * streamed but before its result persisted. Dropping the call would erase the
 * assistant's action; a placeholder output keeps the call visible so the model
 * can recover (e.g. re-issue the call). Symmetric to
 * {@link repairOrphanResponsesToolOutputs}.
 */
export function repairOrphanResponsesToolCalls(input: ResponseInput): ResponseInput {
	const outputCallIds = new Set<string>();
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string") outputCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const t = (item as { type?: string }).type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId === "string" && !outputCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	const repaired: ResponseInput = [];
	for (const item of input) {
		repaired.push(item);
		const t = (item as { type?: string }).type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = (item as { call_id?: unknown }).call_id;
		if (typeof callId !== "string" || outputCallIds.has(callId)) continue;
		repaired.push({
			type: t === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: callId,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		} as ResponseInput[number]);
	}
	return repaired;
}

/**
 * Some Responses backends (notably GitHub Copilot) reject the OpenAI image
 * `detail: "original"` value with a 400. When the model does not advertise
 * support for it, degrade `"original"` to `"auto"` so the request still goes
 * through with the closest valid fidelity instead of failing outright. See #2822.
 */
function clampResponsesImageDetail(
	detail: ImageContent["detail"],
	supportsImageDetailOriginal: boolean,
): ResponseInputImage["detail"] {
	const resolved = detail ?? "auto";
	return resolved === "original" && !supportsImageDetailOriginal ? "auto" : resolved;
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
	supportsImageDetailOriginal: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const text = item.text.toWellFormed();
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push({
			type: "input_image",
			detail: clampResponsesImageDetail(item.detail, supportsImageDetailOriginal),
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage);
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

export interface BuildResponsesInputOptions<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	systemRole?: "system" | "developer";
	nativeHistory?: {
		replay: boolean;
		filterReasoning: boolean;
	};
	includeThinkingSignatures?: boolean;
	developerStringContent?: boolean;
	repairOrphanOutputs?: boolean;
}

export function buildResponsesInput<TApi extends Api>(options: BuildResponsesInputOptions<TApi>): ResponseInput {
	const messages: ResponseInput = [];
	const systemPrompts = options.systemRole ? normalizeSystemPrompts(options.context.systemPrompt) : [];
	for (const systemPrompt of systemPrompts) {
		messages.push({ role: options.systemRole as "system" | "developer", content: systemPrompt });
	}

	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const transformedMessages = transformMessages(
		options.context.messages,
		options.model,
		normalizeResponsesToolCallIdForTransform,
	);
	const filterReasoning = <T extends { type?: string }>(items: T[]): T[] =>
		options.nativeHistory?.filterReasoning ? items.filter(item => item?.type !== "reasoning") : items;
	const includeThinkingSignatures = options.includeThinkingSignatures ?? options.nativeHistory?.replay ?? true;

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = options.nativeHistory
				? getOpenAIResponsesHistoryItems(providerPayload, options.model.provider)
				: undefined;
			const shouldReplayPayloadItems =
				options.nativeHistory?.replay ||
				(historyItems?.some(item => {
					if (!item || typeof item !== "object") return false;
					const candidate = item as { type?: unknown };
					return candidate.type === "compaction" || candidate.type === "compaction_summary";
				}) ??
					false);
			if (historyItems && shouldReplayPayloadItems) {
				messages.push(...sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems)));
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}
			const content = convertResponsesInputContent(
				msg.content,
				options.model.input.includes("image"),
				options.supportsImageDetailOriginal,
			);
			if (!content) continue;
			messages.push({
				role: "user",
				content:
					options.developerStringContent && msg.role === "developer" && typeof msg.content === "string"
						? msg.content.toWellFormed()
						: content,
			});
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload =
				options.nativeHistory?.replay &&
				assistantMsg.api === options.model.api &&
				assistantMsg.model === options.model.id
					? getOpenAIResponsesHistoryPayload(
							assistantMsg.providerPayload,
							options.model.provider,
							assistantMsg.provider,
						)
					: undefined;
			const historyItems = providerPayload?.items;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems));
				if (providerPayload?.dt) {
					messages.push(...sanitizedHistoryItems);
				} else {
					messages.splice(0, messages.length, ...sanitizedHistoryItems);
				}
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				assistantMsg,
				options.model,
				msgIndex,
				knownCallIds,
				includeThinkingSignatures,
				customCallIds,
			);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				options.model,
				options.strictResponsesPairing,
				options.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
			);
		}
		msgIndex++;
	}

	const withRepairedOutputs = options.repairOrphanOutputs ? repairOrphanResponsesToolOutputs(messages) : messages;
	return repairOrphanResponsesToolCalls(withRepairedOutputs);
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	let unsignedTextBlocks = 0;
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			if (block.thinkingSignature) {
				try {
					outputItems.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
				} catch {
					// Legacy/corrupt persisted signature — skip the reasoning item
					// rather than failing the whole request build.
				}
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				// Distinct ids per unsigned block: several text blocks in one message
				// (cross-provider replay downgrades thinking → text) must not share an id.
				msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
				unsignedTextBlocks += 1;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			outputItems.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				id: msgId,
				phase: parsedSignature?.phase,
			} satisfies ResponseOutputMessage);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				id: itemId,
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		outputItems.push({
			type: "function_call",
			id: itemId,
			call_id: normalized.callId,
			name: block.name,
			arguments: JSON.stringify(block.arguments),
		});
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	supportsImageDetailOriginal: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: "(see attached image)"
	).toWellFormed();
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		// Strict backends (Azure, Copilot) reject unpaired outputs outright, but
		// silently dropping the result loses information the model needs. Fold it
		// into an assistant note instead (same shape as repairOrphanResponsesToolOutputs).
		const limit = 16_000;
		const noteText = output.length > limit ? `${output.slice(0, limit)}\n...[truncated]` : output;
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolResult.toolName || "tool"} result; call_id=${normalized.callId}]: ${noteText}`,
		} as ResponseInput[number]);
		return;
	}
	if (customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: clampResponsesImageDetail(block.detail, supportsImageDetailOriginal),
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

/**
 * Per-block accumulation helpers shared by the two Responses decode loops —
 * {@link processResponsesStream} (generic Responses) and the Codex stream
 * handler in `openai-codex-responses.ts`. Each endpoint keeps its own
 * item-routing, terminal handling, and transport bookkeeping; these own only
 * the leaf mutations on an already-resolved open block, so the
 * append/parse/finalize logic lives in exactly one place. The caller passes the
 * `contentIndex` its router resolved (generic uses `output.content.indexOf`;
 * Codex uses the open item's recorded index) so the emitted stream events match
 * each decoder's existing behavior byte-for-byte.
 */
type ResponsesToolCallBlock = ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number };

export function appendReasoningSummaryPart(
	item: ResponseReasoningItem,
	part: ResponseReasoningItem["summary"][number],
): void {
	item.summary = item.summary || [];
	item.summary.push(part);
}

export function appendReasoningSummaryTextDelta(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += delta;
	lastPart.text += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendReasoningSummaryPartDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "thinking_delta", contentIndex, delta: "\n\n", partial: output });
}

export function appendMessageContentPart(
	item: ResponseOutputMessage,
	part: ResponseContentPartAddedEvent["part"] | undefined,
): void {
	item.content = item.content || [];
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		item.content.push(part);
	}
}

export function appendMessageTextDelta(
	item: ResponseOutputMessage,
	block: TextContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	partType: "output_text" | "refusal",
): void {
	item.content = item.content || [];
	let lastPart = item.content[item.content.length - 1];
	if (lastPart?.type !== partType) {
		// `content_part.added` never arrived (lossy proxy) — synthesize the part
		// so live text still streams instead of freezing until output_item.done.
		lastPart =
			partType === "output_text"
				? { type: "output_text", text: "", annotations: [] }
				: { type: "refusal", refusal: "" };
		item.content.push(lastPart);
	}
	block.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

export function accumulateToolCallArgumentsDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
	if (throttled) {
		block.arguments = throttled.value;
		block[kStreamingLastParseLen] = throttled.parsedLen;
	}
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

/**
 * Finalize streamed function-call arguments from the authoritative `.done`
 * payload. The caller owns the `argumentsDone` flag (generic Responses sets it;
 * Codex's block shape has no such field), so this only rewrites `arguments` and
 * drops the transient accumulation fields.
 */
export function finalizeToolCallArgumentsDone(block: ResponsesToolCallBlock, args: string): void {
	block[kStreamingPartialJson] = args;
	block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
	clearStreamingPartialJson(block);
}

export function accumulateCustomToolCallInputDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	block.arguments = { input: block[kStreamingPartialJson] };
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

export function finalizeCustomToolCallInputDone(block: ResponsesToolCallBlock, input: string): void {
	block[kStreamingPartialJson] = input;
	block.arguments = { input };
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
	/**
	 * Called when a terminal `response.completed` or `response.incomplete` event
	 * is successfully processed. Only invoked on the successful-completion path;
	 * thrown failure (`response.failed`) and cancellation paths never call this.
	 * Used by callers to detect premature stream closure (i.e. the stream ended
	 * without a recognized terminal event).
	 */
	onCompleted?: () => void;
	/**
	 * Caller-requested service tier, used to bill the served tier when the
	 * response omits the `service_tier` echo. Only applied for `provider: "openai"`.
	 */
	requestServiceTier?: ServiceTier;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	type StreamingToolCallBlock = ToolCall & {
		[kStreamingPartialJson]: string;
		[kStreamingLastParseLen]?: number;
		[kStreamingArgumentsDone]?: boolean;
	};
	interface StreamingItem {
		item: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
		block: ThinkingContent | TextContent | StreamingToolCallBlock;
	}

	// Multiple items (parallel function_calls in particular) can be open at the same
	// time. OpenAI's spec routes every per-item event by `output_index`/`item_id`;
	// see https://github.com/can1357/oh-my-pi/issues/1880 — llama.cpp emits parallel
	// function_call deltas interleaved, and a singleton `current` reference would
	// fold them into the wrong block and drop arguments on every call but the last.
	//
	// OpenAI-compatible hosts can compound this by omitting `item.id` and
	// `output_index` on `output_item.added` while routing later argument deltas to
	// either the bare `call_id` or a synthesized `fc_<call_id>` item id. Register
	// both keys so each delta reaches its own block instead of falling back to the
	// most recently added parallel call.
	const openItemsByOutputIndex = new Map<number, StreamingItem>();
	const openItemsByItemId = new Map<string, StreamingItem>();
	const openItemsByPrefixedCallId = new Map<string, StreamingItem>();
	let lastOpenItem: StreamingItem | null = null;
	const openItemsInOrder: StreamingItem[] = [];

	const prefixedFunctionCallItemKey = (callId: string | undefined): string | undefined =>
		callId ? `fc_${callId}` : undefined;

	const registerOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.set(outputIndex, entry);
		if (itemId) openItemsByItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.set(alternateItemKey, entry);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey
		) {
			openItemsByPrefixedCallId.set(prefixedAlternateItemKey, entry);
		}
		openItemsInOrder.push(entry);
		lastOpenItem = entry;
	};
	const lookupOpenItem = (event: { output_index?: number; item_id?: string }): StreamingItem | undefined => {
		const hasKey = typeof event.output_index === "number" || event.item_id !== undefined;
		if (typeof event.output_index === "number") {
			const found = openItemsByOutputIndex.get(event.output_index);
			if (found) return found;
		}
		if (event.item_id) {
			const found = openItemsByItemId.get(event.item_id);
			if (found) return found;
		}
		// Keyed events whose item already closed are stale; drop them instead of
		// routing to a sibling. Only fully identifierless mock/proxy events use the
		// legacy singleton fallback.
		return hasKey ? undefined : (lastOpenItem ?? undefined);
	};
	const hasOpenItemKey = (event: { output_index?: number; item_id?: string }): boolean =>
		typeof event.output_index === "number" || event.item_id !== undefined;
	const lookupOpenToolCallAlias = (
		event: { output_index?: number; item_id?: string },
		type: "function_call" | "custom_tool_call",
	): StreamingItem | undefined => {
		if (typeof event.output_index === "number") {
			const byOutputIndex = openItemsByOutputIndex.get(event.output_index);
			if (byOutputIndex) return byOutputIndex;
			// A lossy host (llama.cpp/Ollama, issue #2015) can omit `output_index` on
			// `output_item.added` while still stamping the spec-required field on the
			// delta. The index was never registered, so fall through to the prefixed
			// alias / exact item-id maps instead of dropping to `lastOpenItem`.
		}
		if (event.item_id) {
			// Prefixed call-id aliases share the same wire namespace as real call ids.
			// Argument/input events can use the prefixed form, while final
			// output_item.done events below use exact call ids; keep aliases in a
			// separate map so a real `call_id: "fc_x"` cannot overwrite the alias
			// for `call_id: "x"`.
			const alias = openItemsByPrefixedCallId.get(event.item_id);
			if (alias?.item.type === type) return alias;
			const exact = openItemsByItemId.get(event.item_id);
			if (exact) return exact;
		}
		return lookupOpenItem(event);
	};
	const lookupOpenFunctionCallItem = (event: {
		output_index?: number;
		item_id?: string;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenToolCallAlias(event, "function_call");
		for (const candidate of openItemsInOrder) {
			if (
				candidate.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				return candidate;
			}
		}
		return lastOpenItem?.item.type === "function_call" ? lastOpenItem : undefined;
	};
	const closeOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem | undefined,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.delete(outputIndex);
		if (itemId) openItemsByItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.delete(alternateItemKey);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey &&
			openItemsByPrefixedCallId.get(prefixedAlternateItemKey) === entry
		) {
			openItemsByPrefixedCallId.delete(prefixedAlternateItemKey);
		}
		if (entry) {
			const index = openItemsInOrder.indexOf(entry);
			if (index >= 0) openItemsInOrder.splice(index, 1);
		}
		if (entry && lastOpenItem === entry) lastOpenItem = null;
	};
	const contentIndexOf = (block: ThinkingContent | TextContent | StreamingToolCallBlock): number =>
		output.content.indexOf(block);

	let sawFirstToken = false;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "thinking_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "message") {
				const block: TextContent = {
					type: "text",
					text: "",
					textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined),
				};
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "text_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "function_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					[kStreamingPartialJson]: item.arguments || "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "custom_tool_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					// Preserve the raw wire name (e.g. `apply_patch`). The agent-loop
					// dispatcher matches it against both `Tool.name` and
					// `Tool.customWireName`, so this stays wire-accurate through
					// history replay while still routing to the right handler.
					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,
					// Custom tools stream a raw string, but we reuse `partialJson` as the
					// accumulation buffer so later code that inspects the field still works.
					[kStreamingPartialJson]: item.input ?? "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning") appendReasoningSummaryPart(entry.item, event.part);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
				);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.reasoning_text.delta") {
			// Raw reasoning text delta from local providers that stream thinking
			// directly rather than via the OpenAI summary tracking protocol.
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message") appendMessageContentPart(entry.item, event.part);
		} else if (event.type === "response.output_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"output_text",
				);
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"refusal",
				);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				accumulateToolCallArgumentsDelta(entry.block, event.delta, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				finalizeToolCallArgumentsDone(entry.block, event.arguments);
				entry.block[kStreamingArgumentsDone] = true;
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				accumulateCustomToolCallInputDelta(entry.block, event.delta, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				finalizeCustomToolCallInputDone(entry.block, event.input);
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry =
				item.type === "function_call" || item.type === "custom_tool_call"
					? lookupOpenItem({ output_index: event.output_index, item_id: item.id ?? item.call_id })
					: lookupOpenItem({ output_index: event.output_index, item_id: item.id });
			if (item.type === "reasoning") {
				const thinking =
					item.summary?.length > 0
						? item.summary.map(part => part.text).join("\n\n")
						: item.content?.[0]?.type === "reasoning_text"
							? (item.content[0].text ?? "")
							: "";
				// Prefer the routed entry; the bare itemId find misroutes when ids are
				// absent (`undefined === undefined` matches the FIRST thinking block) and
				// misses entirely when the done-event id drifts from the added-event id.
				const reasoningBlock =
					entry?.block.type === "thinking"
						? entry.block
						: (output.content.find(b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id) as
								| ThinkingContent
								| undefined);
				if (reasoningBlock) {
					reasoningBlock.thinking = thinking;
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: contentIndexOf(reasoningBlock),
						content: thinking,
						partial: output,
					});
				}
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "message") {
				const block = entry?.block.type === "text" ? entry.block : undefined;
				const text = item.content
					.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? "")))
					.join("");
				const textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				let contentIndex: number;
				if (block) {
					block.text = text;
					block.textSignature = textSignature;
					contentIndex = contentIndexOf(block);
				} else {
					// `output_item.added` never arrived (lossy proxy) — synthesize the
					// block so the final message still carries the authoritative text.
					const synthesized: TextContent = { type: "text", text, textSignature };
					output.content.push(synthesized);
					contentIndex = output.content.length - 1;
				}
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "function_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const args = block?.[kStreamingArgumentsDone]
					? block.arguments
					: block?.[kStreamingPartialJson]
						? parseStreamingJson(block[kStreamingPartialJson])
						: parseStreamingJson(item.arguments || "{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				let contentIndex: number;
				if (block) {
					// Persist the authoritative final args on the stored block. The
					// throttled delta parser may have skipped the last partial parse,
					// leaving block.arguments stale (often `{}`); the emitted toolCall
					// and the persisted block must agree.
					block.arguments = args;
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					// `output_item.added` never arrived (lossy proxy) — synthesize the
					// block so the final message carries the call the consumer was told
					// completed (the agent loop executes tools from message.content).
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const rawInput = block?.[kStreamingPartialJson] ? block[kStreamingPartialJson] : (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				let contentIndex: number;
				if (block) {
					// Persist the final input on the stored block and drop the transient
					// accumulation buffer, mirroring the function_call branch above.
					block.arguments = { input: rawInput };
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			const response = event.response;
			finalizePendingResponsesToolCalls(output);
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			applyOpenAIResponsesServiceTierCost(
				model,
				output.usage,
				(response as { service_tier?: unknown } | undefined)?.service_tier,
				options?.requestServiceTier,
			);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (response?.status === "failed" || response?.status === "cancelled") {
				const error = response?.error ?? (response as any)?.status_details?.error;
				const details = response?.incomplete_details;
				const statusDetailsReason = (response as any)?.status_details?.reason;
				const message = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: typeof statusDetailsReason === "string" && statusDetailsReason.length > 0
							? `status_details: ${statusDetailsReason}`
							: "Unknown error (no error details in response)";
				throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
			}
			if (response?.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
				// A content-filtered turn is a failure, not a token-cap truncation —
				// mapping it to "length" would route the agent loop into "shorten your
				// output" recovery against a filtered prompt.
				throw new AIError.ProviderResponseError("incomplete: content_filter", {
					provider: model.provider,
					kind: "content-blocked",
				});
			}
			promoteResponsesToolUseStopReason(output, (response as { end_turn?: boolean } | undefined)?.end_turn);
			options?.onCompleted?.();
			// `response.completed`/`response.incomplete` is the last event of a
			// Responses stream. Stop pulling instead of waiting for the server to
			// close the connection: misbehaving providers keep the socket open
			// after the terminal event, which would park this loop until the idle
			// watchdog converts an already-successful turn into a timeout error.
			// Breaking unwinds the iterator chain (the consumer's `.return()`
			// reaches the SDK stream), actively releasing the connection.
			break;
		} else if (event.type === "error") {
			const err = (event as any).error ?? event;
			const code = err.code ?? "unknown";
			const message = err.message ?? "no message";
			throw new AIError.ProviderResponseError(`Error Code ${code}: ${message}`, {
				provider: model.provider,
				kind: "output",
			});
		} else if (event.type === "response.failed") {
			populateResponsesUsageFromResponse(output, event.response?.usage);
			const error = event.response?.error ?? (event.response as any)?.status_details?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
		}
	}
}

export function mapOpenAIResponsesStopReason(status: ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			// Compile-time exhaustiveness; at runtime a brand-new status from the
			// server must degrade gracefully instead of failing a fully-streamed
			// response.
			const exhaustive: never = status;
			logger.warn("Unhandled OpenAI Responses stop reason", { status: exhaustive });
			return "stop";
		}
	}
}

/**
 * Finalize any streamed toolCall block whose `output_item.done` never arrived
 * (lossy proxy, or a terminal event that raced the per-item done): parse the
 * accumulated `partialJson` into authoritative arguments and strip the transient
 * streaming fields so they never persist. Shared by the chat-Responses decoder
 * and the Codex decoder. Closed blocks already cleared these fields, so walking
 * the full content list leaves them untouched.
 */
export function finalizePendingResponsesToolCalls(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingLastParseLen]?: number;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending[kStreamingPartialJson] && !pending[kStreamingArgumentsDone]) {
			pending.arguments =
				pending.customWireName !== undefined
					? { input: pending[kStreamingPartialJson] }
					: parseStreamingJson(pending[kStreamingPartialJson]);
		}
		clearStreamingPartialJson(pending);
	}
}

/**
 * Apply the Responses terminal stop-reason invariants shared by the chat-Responses
 * and Codex decoders: a turn that produced tool calls becomes `toolUse`, and a
 * Codex-lineage `end_turn: false` marker pauses the turn so the agent loop
 * re-samples instead of ending. Callers set `output.stopReason` from the wire
 * status first via {@link mapOpenAIResponsesStopReason}.
 */
export function promoteResponsesToolUseStopReason(output: AssistantMessage, endTurn: boolean | undefined): void {
	if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
	if (endTurn === false && output.stopReason === "stop") {
		output.stopDetails = { type: "pause_turn" };
	}
}

/** Initial empty `AssistantMessage` that streaming providers accumulate into. */
export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Extension fields we add on top of `ResponseCreateParamsStreaming` across the Responses-family providers. */
export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

/**
 * Apply the common `StreamOptions` → Responses sampling-parameter mapping (max output tokens,
 * temperature, top-p/k, min-p, presence/repetition penalties, service tier). Mutates `params`.
 *
 * `max_output_tokens` is suppressed when {@link Model.omitMaxOutputTokens} is `true`, so
 * proxies (notably Ollama) that forward to upstream APIs with an unknown output-token cap
 * can let the upstream apply its own default instead of 400-ing on `maxTokens` values that
 * reflect the model's context window rather than the upstream output limit.
 */
export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	model: Pick<Model, "provider" | "omitMaxOutputTokens" | "maxTokens">,
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			OPENAI_MAX_OUTPUT_TOKENS,
		);
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	applyOpenAIServiceTier(params, options?.serviceTier, model.provider);
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	disableReasoning?: boolean;
	toolChoice?: unknown;
};

export interface ApplyResponsesCompatPolicyOptions {
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	mapEffort?: (effort: string) => string;
}

export function applyResponsesCompatPolicy<P extends ResponseCreateParamsStreaming>(
	params: P,
	messages: ResponseInput,
	policy: OpenAICompatPolicy,
	options: ApplyResponsesCompatPolicyOptions | undefined,
): number {
	const reasoning = policy.reasoning;
	if (!reasoning.modelSupported) return 0;
	if (reasoning.includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (reasoning.disabled) {
		if (reasoning.disableMode === "openrouter-enabled-false") {
			params.reasoning = { enabled: false } as P["reasoning"];
			return 0;
		}
		if (
			reasoning.disableMode === "lowest-effort" &&
			reasoning.wireEffort !== undefined &&
			!reasoning.omitReasoningEffort
		) {
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			params.reasoning = { effort: reasoning.wireEffort as ReasoningParam["effort"] } as P["reasoning"] &
				ReasoningParam;
			return 0;
		}
		if (policy.compat.requiresJuiceZeroHack && reasoning.requestedEffort === undefined) {
			messages.push({
				role: "developer",
				content: [{ type: "input_text", text: "# Juice: 0 !important" }],
			});
			return 1;
		}
		return 0;
	}

	if (reasoning.requestedEffort !== undefined || options?.reasoningSummary !== undefined) {
		if (reasoning.omitReasoningEffort) {
			if (options?.reasoningSummary !== undefined && options.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
			return 0;
		}

		const requested = reasoning.requestedEffort ?? "medium";
		const wireEffort = reasoning.wireEffort ?? options?.mapEffort?.(requested) ?? requested;
		type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: wireEffort as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
		return 0;
	}

	if (policy.compat.requiresJuiceZeroHack) {
		messages.push({
			role: "developer",
			content: [{ type: "input_text", text: "# Juice: 0 !important" }],
		});
		return 1;
	}
	return 0;
}

/**
 * Apply reasoning-related Responses parameters. Default behavior comes from
 * catalog compat; include/omit arguments are explicit adapter-wrapper overrides.
 */
export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	messages: ResponseInput,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning?: boolean,
	omitReasoningEffort?: boolean,
): number {
	return applyResponsesCompatPolicy(
		params,
		messages,
		resolveOpenAICompatPolicy(model, {
			endpoint: "responses",
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
			includeEncryptedReasoning,
			omitReasoningEffort,
		}),
		{ reasoningSummary: options?.reasoningSummary, mapEffort },
	);
}

/** Populate `output.usage` from a Responses-API `response.usage` payload. Does not invoke `calculateCost`. */
export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				prompt_cache_hit_tokens?: number | null;
				prompt_cache_miss_tokens?: number | null;
				input_tokens_details?: {
					cached_tokens?: number | null;
					cache_write_tokens?: number | null;
					orchestration_input_tokens?: number | null;
					orchestration_input_cached_tokens?: number | null;
				} | null;
				output_tokens_details?: {
					reasoning_tokens?: number | null;
					orchestration_output_tokens?: number | null;
				} | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const details = usage.input_tokens_details;
	const outputDetails = usage.output_tokens_details;
	const orchestrationInputTokens = details?.orchestration_input_tokens ?? 0;
	const orchestrationInputCachedTokens = details?.orchestration_input_cached_tokens ?? 0;
	const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens ?? 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: (usage.input_tokens ?? 0) + orchestrationInputTokens,
		outputTokens: (usage.output_tokens ?? 0) + orchestrationOutputTokens,
		cachedTokens: (details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0) + orchestrationInputCachedTokens,
		reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
		cacheWriteOpenRouter: details?.cache_write_tokens ?? undefined,
		cacheWriteDeepSeek: usage.prompt_cache_miss_tokens ?? undefined,
		hasDeepSeekCacheHitAndMiss:
			usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined,
	});

	// Wholesale replacement must not drop provider-annotated extras (Copilot
	// premium-request accounting): the failed/cancelled paths throw right after
	// this call with no later chance to re-apply.
	const premiumRequests = output.usage.premiumRequests;
	output.usage = {
		...accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (premiumRequests !== undefined) {
		output.usage.premiumRequests = premiumRequests;
	}
}

/**
 * Structural equality for the chain prefix/option check, equivalent to the
 * default {@link Bun.deepEquals} (own enumerable keys, `absent ≡ own-undefined`)
 * except for two deliberate exclusions:
 *  - **symbol-keyed properties are ignored** — `for…in` walks enumerable
 *    *string* keys only (never symbols); these are plain wire items whose
 *    prototype contributes no enumerable keys, so iteration is effectively
 *    own-string-keyed. That is how the transient streaming symbols
 *    (`block-symbols.ts`) stamped onto live request items are excluded (the
 *    deep-cloned baseline never carries them). Do NOT add an
 *    `Object.getOwnPropertySymbols` pass, or those symbols resurface and break
 *    chaining.
 *  - keys listed in `omitKeys` are skipped (the option compare omits `input`
 *    and the per-turn `client_metadata`).
 * A defined value differing across sides IS a difference; a key undefined or
 * absent on both stays equal. Nested values use full {@link Bun.deepEquals}.
 */
function deepEqualsWithout(a: unknown, b: unknown, omitKeys?: Record<string, boolean>): boolean {
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return Bun.deepEquals(a, b);
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const key in ao) {
		if (omitKeys?.[key]) continue;
		const av = ao[key];
		const bv = bo[key];
		if (av !== bv && !Bun.deepEquals(av, bv)) return false;
	}
	for (const key in bo) {
		if (omitKeys?.[key]) continue;
		if (bo[key] !== undefined && !(key in ao)) return false;
	}
	return true;
}

const TOP_LEVEL_EXCLUDE_MAP = {
	input: true,
	client_metadata: true,
};

/**
 * Strict-prefix delta for stateful `previous_response_id` chaining (used by the
 * platform Responses provider and the Codex provider on both transports):
 * returns the input items the current request appends beyond the previous
 * request's input plus the previous response's output items, or null when the
 * request options differ or history mutated (the chain must break). Per-turn
 * `client_metadata` (e.g. rotating turn ids) is excluded from the option
 * comparison; codex-rs excludes it from the same check.
 */
export function buildResponsesDeltaInput<TItem extends ResponseInputItem | InputItem>(
	previous: { input?: TItem[] } | undefined,
	previousResponseItems: readonly TItem[] | undefined,
	current: { input?: TItem[] },
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	if (!deepEqualsWithout(previous, current, TOP_LEVEL_EXCLUDE_MAP)) {
		return null;
	}

	const baselineLen = (previous.input?.length ?? 0) + (previousResponseItems?.length ?? 0);
	if (current.input.length <= baselineLen) return null;

	let index = 0;
	for (const series of [previous.input, previousResponseItems]) {
		if (!series) continue;
		for (const item of series) {
			if (deepEqualsWithout(item, current.input[index])) {
				index++;
			} else {
				return null;
			}
		}
	}
	return current.input.slice(index) as TItem[];
}
