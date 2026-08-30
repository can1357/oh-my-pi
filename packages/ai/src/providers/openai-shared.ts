import { toClinePassWireModelId } from "@oh-my-pi/pi-catalog/cline-pass-model-id";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { toFirepassWireModelId, toFireworksWireModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type {
	OpenAICompat,
	OpenAIReasoningDisableMode,
	OpenAIStreamMarkupHealingPattern,
	OpenRouterRouting,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	VercelGatewayRouting,
} from "@oh-my-pi/pi-catalog/types";
import { parseAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
} from "@oh-my-pi/pi-catalog/wire/coreweave";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import {
	$env,
	classifyJsonPrefix,
	extractHttpStatusFromError,
	isRecord,
	logger,
	parseImageMetadata,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	stringifyJson,
	structuredCloneJSON,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type ComputerAction,
	type ComputerToolCallMetadata,
	type Context,
	type ImageContent,
	type Message,
	type MessageAttribution,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
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
	type Usage,
} from "../types";

export type { OpenAIPromptCacheOptions } from "../types";

import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
	stripUnpairedOpenAIResponsesComputerReasoningIdsForReplay,
} from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingArgumentsDone,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { hasVisibleAssistantContent } from "../utils/empty-completion-retry";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	escapeHarmonyControlTokens,
	escapeHarmonyControlTokensInJson,
	isHarmonyDialectModel,
} from "../utils/harmony-leak";
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
	Response as OpenAIResponse,
	ResponseComputerToolCall,
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

/**
 * Keyless-provider sentinel. Custom providers configured with `auth: none`
 * (models.yml) have no credential, so the coding-agent resolves their API key
 * to this literal instead of a real secret. Providers must treat it as "no
 * credential" and suppress any credential-bearing header (e.g. `Authorization:
 * Bearer …`) rather than forwarding the sentinel on the wire. See #6188; the
 * google-vertex and amazon-bedrock transports apply the same guard inline.
 */
export const NO_AUTH_SENTINEL = "N/A";

export interface OpenAIModelIdentity {
	provider: string;
	id: string;
	identity?: Model["identity"];
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

/** Cache identity controls shared by OpenAI-family transports. */
export interface OpenAICacheOptions {
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
	removeBlankCoreWeaveProjectHeaders(headers);
	if (hasCoreWeaveProjectHeader(headers)) {
		return;
	}
	const projectHeaders = coreWeaveProjectHeaders($env);
	if (projectHeaders) {
		headers[COREWEAVE_PROJECT_HEADER] = projectHeaders[COREWEAVE_PROJECT_HEADER];
	}
}

function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
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

	if (model.provider === "alibaba-token-plan") {
		// Require an explicitly resolved Token Plan credential. The generic
		// `$env.OPENAI_API_KEY` fallback above matches the broad `sk-*` token
		// grammar and would otherwise be sent to QwenCloud as bearer material.
		if (!options.apiKey) {
			throw new AIError.MissingApiKeyError("alibaba-token-plan");
		}
		const credential = parseAlibabaTokenPlanCredential(rawApiKey);
		if (!credential) throw new AIError.ConfigurationError("Invalid QwenCloud Token Plan credential");
		apiKey = credential.token;
		if (credential.baseUrl) baseUrl = credential.baseUrl;
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
		setHeaderIfAbsent(headers, "session_id", options.openAISessionId);
		setHeaderIfAbsent(headers, "x-client-request-id", options.openAISessionId);
	}
	if (options.promptCacheSessionId && model.compat?.promptCacheSessionHeader) {
		setHeaderIfAbsent(headers, model.compat.promptCacheSessionHeader, options.promptCacheSessionId);
	}

	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}
	// Attribute xAI traffic as omp unless a User-Agent is already set.
	if (model.provider === "xai" || model.provider === "xai-oauth") {
		setHeaderIfAbsent(headers, "User-Agent", USER_AGENT);
	}
	const requestHeaders = { ...headers };
	// A keyless provider (`auth: none` in models.yml) resolves to the `N/A`
	// sentinel rather than a real key. Injecting `Authorization: Bearer N/A`
	// breaks custom endpoints that authenticate via their own headers (e.g.
	// `headers.x-api-key`) and reject the bogus bearer — mirror the sentinel
	// guards in google-vertex / amazon-bedrock and send no Authorization here
	// (#6188). A caller-supplied Authorization in `model.headers` still wins.
	if (apiKey !== NO_AUTH_SENTINEL) {
		headers.Authorization ??= `Bearer ${apiKey}`;
	}
	return { copilotPremiumRequests, baseUrl, headers, query, requestHeaders };
}

export function applyOpenAIServiceTier(
	params: { service_tier?: ServiceTier | null | undefined },
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "identity">,
): void {
	if (!shouldSendServiceTier(serviceTier, model)) return;
	params.service_tier = serviceTier;
}

/**
 * Standard OpenAI Responses service-tier cost multipliers. The non-Codex
 * Responses path bills the tier it was served (or requested): Flex processing is
 * half price; Priority is a 2x premium. Codex bills the same tiers with its own
 * table (Priority is 2.5x on gpt-5.5) and applies that separately.
 */
function getOpenAIResponsesServiceTierCostMultiplier(
	model: Pick<Model, "serviceTierCost">,
	tier: string | null | undefined,
): number {
	const resolvedMultiplier = tier === "flex" || tier === "priority" ? model.serviceTierCost?.[tier] : undefined;
	if (resolvedMultiplier !== undefined) return resolvedMultiplier;
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
	model: Pick<Model, "provider" | "serviceTierCost">,
	usage: AssistantMessage["usage"],
	responseServiceTier: unknown,
	requestServiceTier: ServiceTier | null | undefined,
): void {
	if (model.provider !== "openai") return;
	// The response echo is authoritative when present (OpenAI may downgrade a
	// requested priority/flex turn to default under load); only fall back to the
	// requested tier when the response omits the echo entirely.
	const served = typeof responseServiceTier === "string" ? responseServiceTier : (requestServiceTier ?? undefined);
	const multiplier = getOpenAIResponsesServiceTierCostMultiplier(model, served);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/** Reconcile token-price estimates with a gateway's authoritative account charge. */
export function applyProviderReportedCost(model: Pick<Model, "provider">, usage: Usage, rawUsage: unknown): void {
	if (
		(model.provider !== "openrouter" && model.provider !== "cline-pass") ||
		typeof rawUsage !== "object" ||
		rawUsage === null
	)
		return;
	const reportedCost = Reflect.get(rawUsage, "cost");
	if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) return;

	const estimatedCost = usage.cost.total;
	if (Number.isFinite(estimatedCost) && estimatedCost > 0) {
		const scale = reportedCost / estimatedCost;
		usage.cost.input *= scale;
		usage.cost.output *= scale;
		usage.cost.cacheRead *= scale;
		usage.cost.cacheWrite *= scale;
	} else {
		// Keep legacy component-only aggregators additive when catalog pricing is unavailable.
		usage.cost.input = reportedCost;
		usage.cost.output = 0;
		usage.cost.cacheRead = 0;
		usage.cost.cacheWrite = 0;
	}
	usage.cost.total = reportedCost;
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
	orchestration?: Usage["orchestration"];
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

/** Normalize a cache identity to the wire limit accepted by OpenAI-family providers. */
export function normalizeOpenAIPromptCacheKey(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 64, "pc_");
}

export function normalizeOpenRouterResponsesSessionId(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 256, "session_");
}

/** Resolve a prompt-cache identity, falling back to the provider session unless caching is disabled. */
export function getOpenAIPromptCacheKey(options: OpenAICacheOptions | undefined): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.sessionId);
}

export function getOpenRouterResponsesSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
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
	return model.provider === "openrouter" && model.identity?.class === "anthropic";
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
		case "cline-pass":
			return toClinePassWireModelId(baseId);
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
	providerOptions?: { gateway?: Pick<VercelGatewayRouting, "only" | "order" | "caching"> };
}

export interface OpenAIGatewayRoutingCompat {
	isOpenRouterHost: boolean;
	openRouterRouting?: OpenRouterRouting;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

/**
 * Apply gateway routing preferences to the request body. OpenRouter routes via
 * the top-level `provider` field; the Vercel AI Gateway routes Chat
 * Completions through `providerOptions.gateway`.
 */
export function applyOpenAIGatewayRouting(
	params: OpenAIGatewayRoutingParams,
	compat: OpenAIGatewayRoutingCompat,
	cacheEnabled = true,
): void {
	if (compat.isOpenRouterHost && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting) {
		const routing = compat.vercelGatewayRouting;
		if (routing.only || routing.order || (cacheEnabled && routing.caching)) {
			const gatewayOptions: Pick<VercelGatewayRouting, "only" | "order" | "caching"> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			if (cacheEnabled && routing.caching) gatewayOptions.caching = routing.caching;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
}

export interface VercelResponsesCacheParams {
	caching?: "auto";
	cache_anchor_items?: number;
	cache_ttl?: "5m" | "1h";
	providerOptions?: { gateway?: Pick<VercelGatewayRouting, "only" | "order"> };
}

export interface VercelResponsesCacheCompat {
	isVercelGatewayHost: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

/**
 * Apply Vercel AI Gateway's Responses-only automatic cache controls and
 * provider routing. Cache settings are top-level Responses fields, while
 * `only` and `order` remain under `providerOptions.gateway`.
 */
export function applyVercelResponsesCacheControls(
	params: VercelResponsesCacheParams,
	compat: VercelResponsesCacheCompat,
	cacheRetention: CacheRetention = "short",
): void {
	const routing = compat.vercelGatewayRouting;
	if (!compat.isVercelGatewayHost) return;

	if (routing?.only || routing?.order) {
		const gateway: Pick<VercelGatewayRouting, "only" | "order"> = {};
		if (routing.only) gateway.only = routing.only;
		if (routing.order) gateway.order = routing.order;
		params.providerOptions = { gateway };
	}

	if (cacheRetention === "none" || routing?.caching !== "auto") return;

	params.caching = "auto";
	if (routing.cacheAnchorItems !== undefined) params.cache_anchor_items = routing.cacheAnchorItems;
	// A configured 1h TTL is capped by resolved retention; default and short intentionally omit it.
	if (routing.cacheTtl !== undefined && (routing.cacheTtl !== "1h" || cacheRetention === "long")) {
		params.cache_ttl = routing.cacheTtl;
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
 * Merge a compat/options `extraBody` blob into the request params. An encoded
 * Venice disable signal takes precedence over static `venice_parameters`, so
 * an explicit per-turn Thinking Off selection cannot be re-enabled by config.
 * When `dropThinkingWhenReasoningEffort` is set and `reasoning_effort` is
 * present, delete the conflicting `thinking` toggle (Fireworks rejects both).
 */
export function applyOpenAIExtraBody<P extends object>(
	params: P & { venice_parameters?: Record<string, unknown> },
	extraBody: Record<string, unknown> | undefined,
	options?: OpenAIExtraBodyOptions,
): void {
	if (!extraBody) return;
	const encodedVeniceParameters = params.venice_parameters;
	Object.assign(params, extraBody);
	if (encodedVeniceParameters?.disable_thinking === true) {
		const configuredVeniceParameters = extraBody.venice_parameters;
		params.venice_parameters = {
			...(isRecord(configuredVeniceParameters) ? configuredVeniceParameters : {}),
			...encodedVeniceParameters,
		};
	}
	if (options?.dropThinkingWhenReasoningEffort) {
		const shaped = params as { reasoning_effort?: unknown; thinking?: unknown };
		if (shaped.reasoning_effort !== undefined) {
			delete shaped.thinking;
		}
	}
}

/**
 * Chat Completions streaming request body shaped by the OpenAI-family providers.
 * (binary `thinking`, Qwen `enable_thinking`/`chat_template_kwargs`, Venice
 * `venice_parameters`, nested `reasoning`, gateway `provider`/`providerOptions`,
 * sampling extras). Lives in the shared module beside the request-shaping
 * helpers that mutate it.
 */
export type OpenAICompletionsParams = Omit<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "service_tier"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled"; effort?: string; keep?: "all" };
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	chat_template_kwargs?: {
		enable_thinking?: boolean;
		thinking?: boolean;
		preserve_thinking?: boolean;
		reasoning_effort?: string;
	};
	reasoning?: { effort?: string; enabled?: boolean; max_tokens?: number };
	venice_parameters?: { disable_thinking?: boolean; [key: string]: unknown };
	reasoning_effort?: string | null;
	service_tier?: ServiceTier;
	tool_stream?: boolean;
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

/** Reasoning-relevant slice of caller options the Chat Completions dialect dispatch reads. */
export interface ChatCompletionsReasoningOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
	thinkingBudgets?: Partial<Record<Effort, number>>;
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

/**
 * Map a user-facing effort to the provider wire value: explicit compat
 * override first, then the model's baked `thinking.effortMap`, else identity.
 * Shared by the chat-completions/Responses policy resolver and the Codex
 * request transformer.
 */
export function mapOpenAIReasoningEffort(
	model: Pick<Model, "thinking">,
	compat: { reasoningEffortMap?: Partial<Record<Effort, string>> } | undefined,
	effort: string,
): string {
	const level = effort as Effort;
	return compat?.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? effort;
}

function isImplicitDisableWhenNotRequested(disableMode: OpenAIReasoningDisableMode): boolean {
	return (
		disableMode === "zai-thinking-disabled" ||
		disableMode === "qwen-enable-thinking-false" ||
		disableMode === "qwen-template-false" ||
		disableMode === "chat-template-thinking-false"
	);
}

/**
 * Whether a redundant `tool_choice: "auto"` should be dropped to keep
 * reasoning alive. Hosts with `disableReasoningOnToolChoice` (DeepSeek family
 * on e.g. Fireworks) silently turn reasoning off whenever any `tool_choice`
 * is present. "auto" is already the provider default, so omitting it is
 * wire-neutral for tool selection; forced and "none" choices are semantic and
 * still win over reasoning (#1207).
 */
export function shouldDropAutoToolChoiceForReasoning(
	model: Pick<Model, "reasoning">,
	compat: { disableReasoningOnToolChoice: boolean },
	toolChoice: unknown,
	options: { reasoning?: string; disableReasoning?: boolean } | undefined,
): boolean {
	return (
		toolChoice === "auto" &&
		compat.disableReasoningOnToolChoice &&
		Boolean(model.reasoning) &&
		options?.reasoning !== undefined &&
		!options.disableReasoning
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
	if (disabled && compat.supportsReasoningEffort && !omitReasoningEffort) {
		if (disableMode === "none-effort") {
			wireEffort = "none";
		} else if (disableReason === "caller" && requestedEffort === undefined && disableMode === "lowest-effort") {
			const minEffort = getSupportedEfforts(model)[0];
			if (minEffort === undefined) {
				throw new AIError.ConfigurationError(
					`Model ${model.provider}/${model.id} has no supported reasoning efforts`,
				);
			}
			wireEffort = mapOpenAIReasoningEffort(model, compat, minEffort);
		}
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
		case "none-effort":
			params.reasoning_effort = "none";
			break;
		case "zai-thinking-disabled":
			params.thinking = { type: "disabled" };
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = false;
			break;
		case "qwen-template-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: false };
			break;
		case "chat-template-thinking-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, thinking: false };
			break;
		case "openrouter-enabled-false":
		case "cline-enabled-false":
			params.reasoning = { enabled: false };
			break;
		case "venice-disable-thinking":
			params.venice_parameters = { ...params.venice_parameters, disable_thinking: true };
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
				if (reasoning.dialect === "kimi" && reasoning.wireEffort !== undefined) {
					params.thinking = { type: "enabled", effort: reasoning.wireEffort };
					if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
					break;
				}
				params.thinking = { type: "enabled" };
				if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
				if (policy.compat.supportsReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
			case "qwen-enable-thinking-false":
				params.enable_thinking = true;
				// Qwen 3.8+ templates steer thinking depth via the
				// `reasoning_effort` kwarg (low/medium/xhigh, template default
				// xhigh) — without it every effort selection lands on xhigh.
				// Twin emission mirrors `preserve_thinking` above: newer
				// llama.cpp builds map the top-level OpenAI field into the
				// template, older builds and Alibaba-style local servers read
				// only the kwargs copy. The `qwen-chat-template` dialect (NIM,
				// vLLM/SGLang) rides kwargs alone — NIM's request schema
				// rejects unknown top-level fields (#2299).
				if (policy.compat.qwenTemplateReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort;
					params.chat_template_kwargs = {
						...params.chat_template_kwargs,
						reasoning_effort: reasoning.wireEffort,
					};
				}
				break;
			case "qwen-template-false":
				// Spread so the `preserve_thinking` kwarg hoisted above
				// survives the merge — a bare `{ enable_thinking: true }`
				// would clobber it.
				params.chat_template_kwargs = {
					...params.chat_template_kwargs,
					enable_thinking: true,
					...(policy.compat.qwenTemplateReasoningEffort && reasoning.wireEffort !== undefined
						? { reasoning_effort: reasoning.wireEffort }
						: {}),
				};
				break;
			case "chat-template-thinking-false":
				params.chat_template_kwargs = {
					...params.chat_template_kwargs,
					thinking: true,
					...(reasoning.wireEffort !== undefined ? { reasoning_effort: reasoning.wireEffort } : {}),
				};
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
		(reasoning.disableMode === "lowest-effort" || reasoning.disableMode === "none-effort") &&
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
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		compat,
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: options?.toolChoice,
	});
	applyChatCompletionsCompatPolicy(params, policy);
	if (
		model.provider !== "cline-pass" ||
		!policy.reasoning.enabled ||
		model.thinking?.mode !== "budget" ||
		options?.reasoning === undefined
	) {
		return;
	}
	const budget = options.thinkingBudgets?.[options.reasoning] ?? model.thinking.effortBudgets?.[options.reasoning];
	if (budget === undefined) return;
	delete params.reasoning_effort;
	params.reasoning = { ...params.reasoning, max_tokens: budget };
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
function isZaiReasoningEffortDialect(_model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && compat.zaiReasoningEffortDialect;
}

/**
 * Provider-specific Chat Completions output clamp.
 *
 * Most OpenAI-compatible endpoints retain the conservative 64k ceiling from
 * {@link resolveOpenAIOutputTokenParam}. ClinePass, Z.AI/GLM-5.2 reasoning,
 * and native Moonshot K3 explicitly accept their full advertised model caps,
 * so those routes clamp to `model.maxTokens` instead.
 */
export function resolveOpenAICompletionsOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	if (model.provider === "cline-pass") {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	if (isZaiReasoningEffortDialect(model, compat)) {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	if (compat.clampOutputToModelMax) {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	return undefined;
}

/**
 * Provider-specific Responses API output clamp.
 *
 * Meta documents a 131,072-token output limit for Muse Spark 1.1, so native
 * Meta requests may use the model's full advertised cap instead of the
 * conservative 64k OpenAI-compatible default.
 */
export function resolveOpenAIResponsesOutputClamp(model: Pick<Model, "provider" | "maxTokens">): number | undefined {
	if (model.provider === "meta") {
		return model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS;
	}
	return undefined;
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

interface StrictToolsRetryContext {
	model: OpenAIModelIdentity;
	strictToolsApplied: boolean;
	tools: Tool[] | undefined;
}

/** Decide whether an OpenAI-family request should retry once with non-strict tools. */
export function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	context: StrictToolsRetryContext,
): boolean {
	const { model, strictToolsApplied, tools } = context;
	if (!tools || tools.length === 0 || !strictToolsApplied) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) return false;
	const errorMessage = error instanceof Error ? error.message.trim() : "";
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	if (
		/wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool|tool parameters? schema|invalid schema for function|structured[_ -]?outputs?\b[^\n]*(?:not (?:supported|available|enabled)|unsupported)|(?:not support|unsupported)[^\n]*structured[_ -]?outputs?\b/i.test(
			messageParts,
		)
	) {
		return true;
	}
	if (model.provider !== "openrouter" || !/^(?:400\s+)?Provider returned error$/i.test(errorMessage)) return false;
	const body = capturedErrorResponse?.bodyJson;
	if (body && typeof body === "object" && "error" in body) {
		const errorBody = body.error;
		if (errorBody && typeof errorBody === "object" && "metadata" in errorBody) {
			const metadata = errorBody.metadata;
			if (metadata && typeof metadata === "object" && "raw" in metadata) {
				const raw = metadata.raw;
				if (typeof raw === "string" ? raw.trim().length > 0 : raw != null) return false;
			}
		}
	}
	return true;
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
	"response.reasoning_summary_text.done",
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

type ResponsesToolCallKind = "function" | "custom" | "computer";

function responsesToolCallKind(type: unknown): ResponsesToolCallKind | undefined {
	if (type === "function_call") return "function";
	if (type === "custom_tool_call") return "custom";
	if (type === "computer_call") return "computer";
	return undefined;
}

function responsesToolOutputKind(type: unknown): ResponsesToolCallKind | undefined {
	if (type === "function_call_output") return "function";
	if (type === "custom_tool_call_output") return "custom";
	if (type === "computer_call_output") return "computer";
	return undefined;
}
function responseInputCallId(item: ResponseInput[number]): string | undefined {
	if (!("call_id" in item)) return undefined;
	return typeof item.call_id === "string" ? item.call_id : undefined;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (responsesToolCallKind(item.type) === undefined) continue;
		const callId = responseInputCallId(item);
		if (callId) knownCallIds.add(callId);
	}
	return knownCallIds;
}

/** Scan replay items for call_ids that were originally custom tool calls. */
export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type !== "custom_tool_call") continue;
		const callId = responseInputCallId(item);
		if (callId) customCallIds.add(callId);
	}
	return customCallIds;
}

/** Scan replay items for call_ids that were originally native computer calls. */
export function collectComputerCallIds(messages: ResponseInput): Set<string> {
	const computerCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type !== "computer_call") continue;
		const callId = responseInputCallId(item);
		if (callId) computerCallIds.add(callId);
	}
	return computerCallIds;
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
	const precedingCalls = new Set<string>();
	let repaired: ResponseInput | undefined;
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		const callKind = responsesToolCallKind(item.type);
		const callId = responseInputCallId(item);
		if (callKind && callId) precedingCalls.add(`${callKind}\0${callId}`);

		const outputKind = responsesToolOutputKind(item.type);
		if (!outputKind || !callId || precedingCalls.has(`${outputKind}\0${callId}`)) {
			repaired?.push(item);
			continue;
		}

		if (!repaired) repaired = input.slice(0, index);
		const toolName = outputKind === "computer" ? "computer" : "tool";
		const rawOutput = "output" in item ? item.output : undefined;
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
		repaired.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number]);
	}
	return repaired ?? input;
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
	const laterOutputs = new Set<string>();
	const orphanIndexes = new Set<number>();
	for (let index = input.length - 1; index >= 0; index--) {
		const item = input[index];
		const callId = responseInputCallId(item);
		const outputKind = responsesToolOutputKind(item.type);
		if (outputKind && callId) laterOutputs.add(`${outputKind}\0${callId}`);

		const callKind = responsesToolCallKind(item.type);
		if (callKind && callId && !laterOutputs.has(`${callKind}\0${callId}`)) orphanIndexes.add(index);
	}
	if (orphanIndexes.size === 0) return input;

	const repaired: ResponseInput = [];
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		if (!orphanIndexes.has(index)) {
			repaired.push(item);
			continue;
		}
		const kind = responsesToolCallKind(item.type);
		const callId = responseInputCallId(item);
		if (!kind || !callId) {
			repaired.push(item);
			continue;
		}
		if (kind === "computer") {
			repaired.push({
				type: "message",
				role: "assistant",
				content: `[Computer call interrupted before a screenshot was recorded; call_id=${callId}]`,
			} as ResponseInput[number]);
			continue;
		}
		repaired.push(item);
		repaired.push({
			type: kind === "custom" ? "custom_tool_call_output" : "function_call_output",
			call_id: callId,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		} as ResponseInput[number]);
	}
	return repaired;
}

type ResponsesBatchItemKind = "call" | "output" | "assistant-message" | "other";

/** Classify a Responses input item for tool-call/output batch normalization. */
function classifyResponsesBatchItem(item: object): ResponsesBatchItemKind {
	const type = "type" in item ? item.type : undefined;
	if (responsesToolCallKind(type) !== undefined) return "call";
	if (responsesToolOutputKind(type) !== undefined) return "output";
	const role = "role" in item ? item.role : undefined;
	if (type === "message" && role === "assistant") return "assistant-message";
	return "other";
}

/**
 * Relocate assistant `message` items wedged inside a tool-call → tool-output
 * batch to before the batch, yielding canonical `message(s) → calls → outputs`
 * order. Idempotent; returns the same array reference when nothing moves.
 *
 * OpenAI's Responses API pairs tool outputs by `call_id` and tolerates any item
 * order, but stricter gateways (notably opencode-go's "Console Go") reject a
 * shape where an assistant message interrupts a `function_call` →
 * `function_call_output` run, 400ing with `No tool output found for tool call …`
 * (naming a random call of the batch on each retry). This arises whenever a
 * model streams a trailing text / demoted-thinking block *after* its tool calls:
 * the block-encode path preserves stream order, emitting the message between the
 * calls and the outputs appended afterward. Moving the already-model-owned
 * message ahead of its call batch keeps content identical while satisfying the
 * strict validator. See #8789.
 */
export function hoistInterleavedResponsesToolBatchMessages<T extends object>(items: readonly T[]): T[] {
	const moved = new Set<number>();
	const insertBefore = new Map<number, number[]>();
	for (let index = 0; index < items.length; index++) {
		if (classifyResponsesBatchItem(items[index]) !== "output") continue;
		// Only anchor on the first output of a run.
		if (index > 0 && classifyResponsesBatchItem(items[index - 1]) === "output") continue;
		// Walk back over the batch body (calls interleaved with assistant messages).
		let start = index;
		let sawCall = false;
		const messageIndexes: number[] = [];
		while (start > 0) {
			const kind = classifyResponsesBatchItem(items[start - 1]);
			if (kind === "call") {
				sawCall = true;
			} else if (kind === "assistant-message") {
				messageIndexes.push(start - 1);
			} else {
				break;
			}
			start -= 1;
		}
		// Nothing to hoist unless a message actually sits among the calls.
		if (!sawCall || messageIndexes.length === 0) continue;
		messageIndexes.reverse();
		const target = insertBefore.get(start) ?? [];
		for (const messageIndex of messageIndexes) {
			moved.add(messageIndex);
			target.push(messageIndex);
		}
		insertBefore.set(start, target);
	}
	if (moved.size === 0) return items.slice();
	const result: T[] = [];
	for (let index = 0; index < items.length; index++) {
		const pending = insertBefore.get(index);
		if (pending) for (const messageIndex of pending) result.push(items[messageIndex]);
		if (moved.has(index)) continue;
		result.push(items[index]);
	}
	return result;
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

function convertResponsesInputImage(image: ImageContent, supportsImageDetailOriginal: boolean): ResponseInputImage {
	const detail = clampResponsesImageDetail(image.detail, supportsImageDetailOriginal);
	if (image.providerFile?.provider === "openai" && image.providerFile.id) {
		return { type: "input_image", detail, file_id: image.providerFile.id };
	}
	return {
		type: "input_image",
		detail,
		image_url: image.url ?? `data:${image.mimeType};base64,${image.data}`,
	};
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
	supportsImageDetailOriginal: boolean,
	escapeControlTokens = false,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		const text = content.toWellFormed();
		return [
			{
				type: "input_text",
				text: escapeControlTokens ? escapeHarmonyControlTokens(text) : text,
			} satisfies ResponseInputText,
		];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const raw = item.text.toWellFormed();
		const text = escapeControlTokens ? escapeHarmonyControlTokens(raw) : raw;
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push(convertResponsesInputImage(item, supportsImageDetailOriginal));
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

/**
 * Map freeform custom-tool wire names back to the internal tool name for
 * providers that only accept function_call / function_call_output.
 * Built once per request; `apply_patch` → `edit` is the OMP default.
 */
function buildCustomToolWireNameMap(tools: readonly Tool[] | undefined): ReadonlyMap<string, string> | undefined {
	if (!tools?.length) return undefined;
	const map = new Map<string, string>();
	for (const tool of tools) {
		if (tool.customWireName) map.set(tool.customWireName, tool.name);
	}
	return map.size > 0 ? map : undefined;
}

function resolveReplayCustomToolName(wireName: string, wireNameMap: ReadonlyMap<string, string> | undefined): string {
	return wireNameMap?.get(wireName) ?? (wireName === "apply_patch" ? "edit" : wireName);
}

/**
 * Downgrade OpenAI-only custom tool items when the target model does not
 * advertise freeform custom tools (`applyPatchToolType === "freeform"`).
 * No-op (returns the same array reference) when freeform is supported.
 */
function adaptResponsesReplayItemsForModel(
	input: ResponseInput,
	supportsCustomToolCalls: boolean,
	wireNameMap: ReadonlyMap<string, string> | undefined,
	supportsComputerUse: boolean,
): ResponseInput {
	if (supportsCustomToolCalls && supportsComputerUse) return input;

	let changed = false;
	const adapted: ResponseInput = [];
	for (const item of input) {
		if (!supportsCustomToolCalls && item.type === "custom_tool_call") {
			changed = true;
			adapted.push({
				type: "function_call",
				...(item.id ? { id: item.id } : {}),
				call_id: item.call_id,
				name: resolveReplayCustomToolName(item.name, wireNameMap),
				arguments: JSON.stringify({ input: item.input }),
				...(item.namespace ? { namespace: item.namespace } : {}),
			});
			continue;
		}
		if (!supportsCustomToolCalls && item.type === "custom_tool_call_output") {
			changed = true;
			adapted.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: item.output,
			});
			continue;
		}
		if (!supportsComputerUse && (item.type === "computer_call" || item.type === "computer_call_output")) {
			changed = true;
			const callId = responseInputCallId(item) ?? "unknown";
			adapted.push({
				type: "message",
				role: "assistant",
				content: `[Previous computer ${item.type === "computer_call" ? "call" : "result"}; call_id=${callId}]: ${stringifyJson(item) ?? ""}`,
			} as ResponseInput[number]);
			continue;
		}
		adapted.push(item);
	}
	return changed ? adapted : input;
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
	/** Preserve assistant message item IDs from text signatures during fallback replay. */
	preserveAssistantMessageIds?: boolean;
	/**
	 * Synthesize a reasoning item for every replayed assistant turn that carries
	 * content but no reasoning item. Set for DeepSeek-family Responses targets
	 * that reject a thinking-mode continuation lacking `reasoning_text`.
	 */
	requiresReasoningReplayForAllTurns?: boolean;
	/** As {@link requiresReasoningReplayForAllTurns}, but only for turns that contain a tool call. */
	requiresReasoningReplayForToolCalls?: boolean;
}

/**
 * Escape reserved Harmony control tokens in the free-text fields of replayed
 * Responses input items: user/developer/system text, tool-result output,
 * assistant message text, and tool-call payloads.
 *
 * Tool-call items are covered deliberately. The original #6913 fix skipped
 * model-owned items on the theory that they carry no client data — but a model
 * legitimately writing *about* Harmony samples `<|channel|>` etc. into its own
 * `function_call.arguments`, and a full-transcript replay (stale or blocked
 * previous_response_id, provider fallback) feeds those bytes back as input,
 * which gpt-5.x reject with invalid_prompt / "Request blocked", permanently
 * poisoning the session. `arguments` is a JSON document, so it uses
 * {@link escapeHarmonyControlTokensInJson} to stay parseable. Reasoning items
 * are left untouched: `encrypted_content` is opaque and plaintext summaries
 * are never rendered back into the prompt.
 *
 * Native history replay pushes stored `providerPayload` items straight onto the
 * wire, bypassing {@link convertResponsesInputContent}; without this a stored
 * `input_text` carrying `<|channel|>analysis` still reaches gpt-5.x raw (#6913).
 * Callers gate on {@link isHarmonyDialectModel}. Items are copied, not mutated.
 */
export function escapeReplayedControlTokens(items: ResponseInput): ResponseInput {
	return items.map(item => {
		if (item.type === "function_call_output") {
			return typeof item.output === "string"
				? { ...item, output: escapeHarmonyControlTokens(item.output) }
				: {
						...item,
						output: item.output.map(part =>
							part.type === "input_text" ? { ...part, text: escapeHarmonyControlTokens(part.text) } : part,
						),
					};
		}
		if (item.type === "custom_tool_call_output") {
			return typeof item.output === "string"
				? { ...item, output: escapeHarmonyControlTokens(item.output) }
				: {
						...item,
						output: item.output.map(part =>
							part.type === "input_text" ? { ...part, text: escapeHarmonyControlTokens(part.text) } : part,
						),
					};
		}
		if (item.type === "function_call") {
			return typeof item.arguments === "string"
				? { ...item, arguments: escapeHarmonyControlTokensInJson(item.arguments) }
				: item;
		}
		if (item.type === "custom_tool_call") {
			return typeof item.input === "string" ? { ...item, input: escapeHarmonyControlTokens(item.input) } : item;
		}
		// EasyInputMessage may omit `type` (`{ role, content }`); the responses
		// server persists it verbatim, so treat missing type as a message too.
		const isTypedMessage = item.type === "message" || item.type === undefined;
		if (!isTypedMessage || !("role" in item) || !("content" in item)) return item;
		if (item.role === "assistant") {
			// Assistant output text is model-owned but equally capable of carrying
			// control tokens as data. `status` discriminates ResponseOutputMessage.
			if ("status" in item && Array.isArray(item.content)) {
				return {
					...item,
					content: item.content.map(part =>
						part.type === "output_text"
							? { ...part, text: escapeHarmonyControlTokens(part.text) }
							: part.type === "refusal"
								? { ...part, refusal: escapeHarmonyControlTokens(part.refusal) }
								: part,
					),
				};
			}
			return item;
		}
		const content = item.content;
		if (typeof content === "string") {
			return { ...item, content: escapeHarmonyControlTokens(content) };
		}
		if (Array.isArray(content)) {
			return {
				...item,
				content: content.map(part =>
					part.type === "input_text" ? { ...part, text: escapeHarmonyControlTokens(part.text) } : part,
				),
			};
		}
		return item;
	});
}

export function buildResponsesInput<TApi extends Api>(options: BuildResponsesInputOptions<TApi>): ResponseInput {
	const messages: ResponseInput = [];
	const systemPrompts = options.systemRole ? normalizeSystemPrompts(options.context.systemPrompt) : [];
	for (const systemPrompt of systemPrompts) {
		messages.push({ role: options.systemRole as "system" | "developer", content: systemPrompt });
	}

	// Compat is resolved by the catalog (e.g. Copilot / xai-oauth reject
	// `detail: "original"`). Do not re-branch on provider id here.
	const supportsImageDetailOriginal = options.supportsImageDetailOriginal;
	// Freeform custom tools (`custom_tool_call`) only when the catalog says so;
	// same gate as tool conversion (`applyPatchToolType === "freeform"`).
	const supportsCustomToolCalls = options.model.applyPatchToolType === "freeform";
	const customToolWireNameMap = supportsCustomToolCalls
		? undefined
		: buildCustomToolWireNameMap(options.context.tools);
	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const computerCallIds = new Set<string>();
	const transformedMessages = transformMessages(
		options.context.messages,
		options.model,
		normalizeResponsesToolCallIdForTransform,
	);
	const filterReasoning = <T extends { type?: string }>(items: T[]): T[] =>
		options.nativeHistory?.filterReasoning ? items.filter(item => item?.type !== "reasoning") : items;
	const includeThinkingSignatures = options.includeThinkingSignatures ?? options.nativeHistory?.replay ?? true;
	// Harmony-server models (gpt-5.x) reject requests whose input data reproduces
	// reserved control-token spellings; escape the transport copy of untrusted
	// user/tool text so ordinary docs, code, or grep results cannot poison the
	// session (#6913). The persisted transcript is never touched.
	const escapeControlTokens = isHarmonyDialectModel(options.model);

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
				const sanitizedItems = sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems), {
					supportsImageDetailOriginal,
					supportsComputerUse: options.model.supportsComputerUse === true,
				});
				const replayItems = adaptResponsesReplayItemsForModel(
					sanitizedItems,
					supportsCustomToolCalls,
					customToolWireNameMap,
					options.model.supportsComputerUse === true,
				);
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(replayItems) : replayItems));
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				for (const id of collectComputerCallIds(messages)) computerCallIds.add(id);
				msgIndex++;
				continue;
			}
			const content = convertResponsesInputContent(
				msg.content,
				options.model.input.includes("image"),
				supportsImageDetailOriginal,
				escapeControlTokens,
			);
			if (!content) continue;
			const developerText =
				options.developerStringContent && msg.role === "developer" && typeof msg.content === "string"
					? msg.content.toWellFormed()
					: undefined;
			messages.push({
				role: "user",
				content:
					developerText !== undefined
						? escapeControlTokens
							? escapeHarmonyControlTokens(developerText)
							: developerText
						: content,
			});
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// Providers replay stale native items even when the current request has
			// disabled native replay (cold session state, filter policy). Consult
			// the payload sanitizer directly so hidden-empty turns are recognized
			// on both the warm and cold paths.
			const providerPayload =
				assistantMsg.api === options.model.api && assistantMsg.model === options.model.id
					? getOpenAIResponsesHistoryPayload(
							assistantMsg.providerPayload,
							options.model.provider,
							assistantMsg.provider,
						)
					: undefined;
			const nativeReplayEnabled = options.nativeHistory?.replay === true;
			const historyItems = providerPayload?.items;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const rawSanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
					filterReasoning(historyItems),
					{
						supportsImageDetailOriginal,
						supportsComputerUse: options.model.supportsComputerUse === true,
					},
				);
				const sanitizedHistoryItems = rawSanitizedHistoryItems
					? adaptResponsesReplayItemsForModel(
							rawSanitizedHistoryItems,
							supportsCustomToolCalls,
							customToolWireNameMap,
							options.model.supportsComputerUse === true,
						)
					: undefined;
				if (nativeReplayEnabled && sanitizedHistoryItems) {
					// Model-owned replay items can carry reserved control-token
					// spellings as data (the model writing *about* Harmony); escape the
					// transport copy just like client turns.
					const wireItems = escapeControlTokens
						? escapeReplayedControlTokens(sanitizedHistoryItems)
						: sanitizedHistoryItems;
					if (providerPayload?.dt) {
						messages.push(...wireItems);
					} else {
						messages.splice(0, messages.length, ...wireItems);
						customCallIds.clear();
						computerCallIds.clear();
					}
					knownCallIds = collectKnownCallIds(messages);
					for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
					for (const id of collectComputerCallIds(messages)) computerCallIds.add(id);
					msgIndex++;
					continue;
				}
				if (!sanitizedHistoryItems) suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				assistantMsg,
				options.model,
				msgIndex,
				knownCallIds,
				suppressHiddenEmptyFallback ? false : includeThinkingSignatures,
				customCallIds,
				options.preserveAssistantMessageIds,
				supportsCustomToolCalls,
				customToolWireNameMap,
				computerCallIds,
				options.requiresReasoningReplayForAllTurns ?? false,
				options.requiresReasoningReplayForToolCalls ?? false,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length === 0) continue;
			messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(outputItems) : outputItems));
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				options.model,
				options.strictResponsesPairing,
				supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
				supportsCustomToolCalls,
				computerCallIds,
			);
		}
		msgIndex++;
	}

	const hoisted = hoistInterleavedResponsesToolBatchMessages(messages);
	const withRepairedOutputs = options.repairOrphanOutputs ? repairOrphanResponsesToolOutputs(hoisted) : hoisted;
	const withRepairedCalls = repairOrphanResponsesToolCalls(withRepairedOutputs);
	return stripUnpairedOpenAIResponsesComputerReasoningIdsForReplay(withRepairedCalls);
}

type ResponsesReplayAssistantMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };

function parseResponseReasoningReplayItem(signature: string | undefined): ResponseReasoningItem | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (!("type" in parsed) || parsed.type !== "reasoning") return undefined;
		if (!("id" in parsed) || typeof parsed.id !== "string") return undefined;
		return parsed as ResponseReasoningItem;
	} catch {
		return undefined;
	}
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
	preserveMessageIds = false,
	supportsCustomToolCalls = true,
	customToolWireNameMap?: ReadonlyMap<string, string>,
	computerCallIds?: Set<string>,
	requiresReasoningReplayForAllTurns = false,
	requiresReasoningReplayForToolCalls = false,
): ResponseInput {
	const outputItems: ResponseInput = [];
	let unsignedTextBlocks = 0;
	const hasReplayableReasoningItem =
		includeThinkingSignatures &&
		assistantMsg.stopReason !== "error" &&
		assistantMsg.content.some(
			block => block.type === "thinking" && parseResponseReasoningReplayItem(block.thinkingSignature) !== undefined,
		);
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;
	// DeepSeek-family Responses targets (e.g. opencode-go) reject a thinking-mode
	// continuation whose replayed assistant turns carry no reasoning item: "The
	// reasoning_text in the thinking mode must be passed back to the API." After a
	// cross-model prewalk hand-off or a compaction that drops the native replay
	// payload, the block re-encode below demotes reasoning to text and emits no
	// reasoning item. Track reasoning emission so a placeholder can be synthesized,
	// mirroring the chat-completions `requiresReasoningContentForAllAssistantTurns`
	// empty-`reasoning_content` safety net.
	const requiresReasoningItem =
		assistantMsg.stopReason !== "error" &&
		(requiresReasoningReplayForAllTurns ||
			(requiresReasoningReplayForToolCalls && assistantMsg.content.some(block => block.type === "toolCall")));
	let reasoningItemEmitted = false;
	const carriedReasoningTexts: string[] = [];
	let synthesizedReasoningItemId: string | undefined;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (requiresReasoningItem) {
				if (block.itemId) synthesizedReasoningItemId ??= block.itemId;
				if (block.thinking.trim().length > 0) carriedReasoningTexts.push(block.thinking);
			}
			if (!includeThinkingSignatures) {
				continue;
			}
			const reasoningItem = parseResponseReasoningReplayItem(block.thinkingSignature);
			if (reasoningItem) {
				outputItems.push(reasoningItem);
				reasoningItemEmitted = true;
			}
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				if (hasReplayableReasoningItem) {
					// Distinct ids per unsigned block: several text blocks in one message
					// (cross-provider replay downgrades thinking → text) must not share an id.
					msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
					unsignedTextBlocks += 1;
				}
			} else if (!preserveMessageIds && !hasReplayableReasoningItem) {
				// Without the matching reasoning item the server rejects replayed
				// item ids (#4173) — drop them regardless of shape, including
				// legacy plain-string signatures that would otherwise fall into
				// the >64-char hash branch and fabricate a bogus msg_ id.
				msgId = undefined;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			const messageItem: ResponsesReplayAssistantMessage = {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				...(msgId ? { id: msgId } : {}),
				...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
			};
			outputItems.push(messageItem as ResponseInput[number]);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		if (block.providerMetadata?.type === "computer") {
			if (model.supportsComputerUse !== true) {
				const callId = normalizeResponsesToolCallId(block.id, "ctc").callId;
				outputItems.push({
					type: "message",
					role: "assistant",
					content: `[Previous computer call; call_id=${callId}]: ${stringifyJson(block.providerMetadata.actions) ?? ""}`,
				} as ResponseInput[number]);
				continue;
			}
			const normalized = normalizeResponsesToolCallId(block.id, "ctc");
			knownCallIds.add(normalized.callId);
			computerCallIds?.add(normalized.callId);
			outputItems.push({
				type: "computer_call",
				id: block.providerMetadata.providerItemId,
				call_id: normalized.callId,
				actions: structuredCloneJSON(block.providerMetadata.actions),
				pending_safety_checks: structuredCloneJSON(block.providerMetadata.pendingSafetyChecks),
				status: "completed",
			} as ResponseInput[number]);
			continue;
		}
		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (
			!hasReplayableReasoningItem &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		} else if (
			isDifferentModel &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName && supportsCustomToolCalls) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				...(itemId ? { id: itemId } : {}),
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		const functionName =
			block.customWireName && !supportsCustomToolCalls
				? resolveReplayCustomToolName(block.customWireName, customToolWireNameMap)
				: block.name;
		outputItems.push({
			type: "function_call",
			...(itemId ? { id: itemId } : {}),
			call_id: normalized.callId,
			name: functionName,
			arguments: stringifyJson(block.arguments) ?? "null",
		});
	}

	if (requiresReasoningItem && !reasoningItemEmitted && outputItems.length > 0) {
		// Replay the demoted reasoning (already present in `content` as visible
		// text) as a structured reasoning item so the thinking-mode continuation
		// carries the `reasoning_text` the provider requires. The text may be empty
		// when the source turn was minted by another model and its reasoning is
		// already folded into the message text; the item's presence is what
		// satisfies the provider contract, mirroring the empty `reasoning_content`
		// placeholder used on the chat-completions path.
		const reasoningText = carriedReasoningTexts.join("\n");
		const reasoningId =
			synthesizedReasoningItemId ?? `rs_${Bun.hash(`${model.id}:${msgIndex}:${reasoningText}`).toString(36)}`;
		const reasoningItem: ResponseReasoningItem = {
			type: "reasoning",
			id: reasoningId,
			summary: [],
			content: [{ type: "reasoning_text", text: reasoningText }],
		};
		outputItems.unshift(reasoningItem);
	}

	return outputItems;
}

/**
 * Responses wire output for a tool result plus its text-only fallback.
 *
 * `output` preserves native image blocks for paired function/custom outputs.
 * `outputText` feeds orphan and unsupported-computer fallback messages, which
 * cannot carry the native output array.
 */
export interface ResponsesToolResultOutputEncoding {
	output: string | ResponseInputContent[];
	outputText: string;
}

/**
 * Encodes one canonical tool result for OpenAI Responses replay.
 *
 * Image-capable models receive an ordered native content array; text-only
 * models and callers without images receive the compatible string form.
 */
export function encodeResponsesToolResultOutput<TApi extends Api>(
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	supportsImageDetailOriginal: boolean,
): ResponsesToolResultOutputEncoding {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const rawOutput = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: hasImages
					? "(see attached image)"
					: ""
	).toWellFormed();
	const escapeControlTokens = isHarmonyDialectModel(model);
	// Harmony-server models reject reserved control-token spellings even as tool
	// data; escape the transport copy so a grep/read result cannot poison the
	// session (#6913). Covers every downstream branch that consumes `output`.
	const outputText = escapeControlTokens ? escapeHarmonyControlTokens(rawOutput) : rawOutput;
	const output: string | ResponseInputContent[] =
		hasImages && supportsImages
			? toolResult.content.map((block): ResponseInputContent => {
					if (block.type === "image") return convertResponsesInputImage(block, supportsImageDetailOriginal);
					const text = block.text.toWellFormed();
					return {
						type: "input_text",
						text: escapeControlTokens ? escapeHarmonyControlTokens(text) : text,
					};
				})
			: outputText;
	return { output, outputText };
}

/** Appends one Responses tool result. */
export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	supportsImageDetailOriginal: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
	supportsCustomToolCalls = true,
	computerCallIds?: ReadonlySet<string>,
): void {
	const { output, outputText } = encodeResponsesToolResultOutput(toolResult, model, supportsImageDetailOriginal);
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	if (toolResult.providerMetadata?.type === "computer" && model.supportsComputerUse !== true) {
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Previous computer result; call_id=${normalized.callId}]: ${stringifyJson(toolResult.providerMetadata.screenshot) ?? ""}`,
		} as ResponseInput[number]);
		return;
	}
	if (computerCallIds?.has(normalized.callId)) {
		if (toolResult.providerMetadata?.type !== "computer") {
			const limit = 16_000;
			const noteText = outputText.length > limit ? `${outputText.slice(0, limit)}\n...[truncated]` : outputText;
			messages.push({
				type: "message",
				role: "assistant",
				content: `[Computer tool failed before a screenshot was produced; call_id=${normalized.callId}]: ${noteText}`,
			} as ResponseInput[number]);
			return;
		}
		if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
			messages.push({
				type: "message",
				role: "assistant",
				content: `[Orphan computer result; call_id=${normalized.callId}]`,
			} as ResponseInput[number]);
			return;
		}
		messages.push({
			type: "computer_call_output",
			call_id: normalized.callId,
			output: structuredCloneJSON(toolResult.providerMetadata.screenshot),
			acknowledged_safety_checks: structuredCloneJSON(toolResult.providerMetadata.acknowledgedSafetyChecks),
		} as ResponseInput[number]);
		return;
	}
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		// Strict backends (Azure, Copilot) reject unpaired outputs outright, but
		// silently dropping the result loses information the model needs. Fold it
		// into an assistant note instead (same shape as repairOrphanResponsesToolOutputs).
		const limit = 16_000;
		const noteText = outputText.length > limit ? `${outputText.slice(0, limit)}\n...[truncated]` : outputText;
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolResult.toolName || "tool"} result; call_id=${normalized.callId}]: ${noteText}`,
		} as ResponseInput[number]);
		return;
	}
	if (supportsCustomToolCalls && customCallIds?.has(normalized.callId)) {
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

function ensureReasoningSummaryPart(
	item: ResponseReasoningItem,
	summaryIndex: number,
): ResponseReasoningItem["summary"][number] {
	item.summary = item.summary || [];
	while (item.summary.length <= summaryIndex) {
		item.summary.push({ type: "summary_text", text: "" });
	}
	return item.summary[summaryIndex]!;
}

export function appendReasoningSummaryPart(
	item: ResponseReasoningItem,
	part: ResponseReasoningItem["summary"][number],
): void {
	item.summary = item.summary || [];
	item.summary.push(part);
}

/**
 * Response-global accumulator for the sequential-cutoff summary contract.
 *
 * Summary indices are cumulative across ALL reasoning items in a response:
 * each new reasoning item replays the previous item's last completed section
 * (`.done` at index N-1) before streaming its own, and replay-only items may
 * add nothing new. Folding per item would re-emit every replayed section, so
 * the canonical summary and the emitted text span items and live here.
 */
export interface SequentialCutoffSummaryState {
	/** Latest full text per response-global summary index. */
	summary: ResponseReasoningItem["summary"];
	/** Canonical summary text already emitted as thinking deltas across all blocks. */
	emitted: string;
}

export function createSequentialCutoffSummaryState(): SequentialCutoffSummaryState {
	return { summary: [], emitted: "" };
}

// Sequential-cutoff streams may repeat the full canonical summary as later parts.
function foldReasoningSummary(parts: ResponseReasoningItem["summary"] | undefined): string {
	if (!parts) return "";
	let canonical = "";
	for (const part of parts) {
		const text = part.text;
		if (!text || text === canonical) continue;
		const extendsCanonical = text.startsWith(canonical) && text[canonical.length] === "\n";
		canonical = !canonical || extendsCanonical ? text : `${canonical}\n\n${text}`;
	}
	return canonical;
}

/** Chooses final reasoning text without making sequential-cutoff results disagree with emitted deltas. */
export function finalizeReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff?: SequentialCutoffSummaryState,
): string {
	if (cutoff) return finalizeCutoffReasoningThinking(item, streamedThinking, cutoff);
	const summaryThinking = item.summary?.map(part => part.text).join("\n\n") ?? "";
	if (summaryThinking) return summaryThinking;
	const contentThinking = item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
	return contentThinking || streamedThinking || "";
}

function finalizeCutoffReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff: SequentialCutoffSummaryState,
): string {
	// The block's streamed deltas are authoritative: final text must never
	// disagree with what delta consumers already rendered.
	if (streamedThinking) return streamedThinking;
	const summaryThinking = foldReasoningSummary(item.summary);
	if (summaryThinking) {
		// The done payload carries the response-cumulative summary. Emit only
		// what no earlier block already emitted; replay-only items finalize empty.
		if (cutoff.emitted.startsWith(summaryThinking)) return "";
		if (!cutoff.emitted || summaryThinking.startsWith(cutoff.emitted)) {
			const suffix = summaryThinking.slice(cutoff.emitted.length).replace(/^\n+/, "");
			// Adopt the payload as canonical so later items cannot replay this text.
			cutoff.summary = item.summary?.map(part => ({ ...part })) ?? [];
			cutoff.emitted = summaryThinking;
			return suffix;
		}
		// Diverged from streamed text — the deltas already shown win.
		return "";
	}
	return item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
}

export function appendReasoningSummaryTextDelta(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	summaryIndex = 0,
): void {
	const part = ensureReasoningSummaryPart(item, summaryIndex);
	block.thinking += delta;
	part.text += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

/**
 * Applies a completed reasoning-summary snapshot, including providers that omit
 * the preceding summary-part event.
 */
export function applyReasoningSummaryTextDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	const part = ensureReasoningSummaryPart(item, summaryIndex);
	const previous = part.text;
	part.text = text;
	if (!text || text === previous) return;
	if (!block.thinking) {
		block.thinking = text;
		stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
		return;
	}
	if (text.startsWith(block.thinking)) {
		const delta = text.slice(block.thinking.length);
		if (!delta) return;
		block.thinking += delta;
		stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
	}
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

/**
 * Applies an atomic `response.reasoning_summary_text.done` snapshot.
 *
 * Sequential-cutoff summary indices are response-global: later reasoning items
 * replay earlier sections, resend the accumulated summary as one part, or
 * complete without new sections. The canonical summary is rebuilt in `state`
 * (spanning items) and only its append-only suffix is emitted into the current
 * block. Divergent corrections stay buffered until finalization so delta
 * consumers never receive suffixes based on unseen replacement text.
 */
export function applyReasoningSummaryDone(
	state: SequentialCutoffSummaryState,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	while (state.summary.length <= summaryIndex) {
		state.summary.push({ type: "summary_text", text: "" });
	}
	state.summary[summaryIndex].text = text;
	const after = foldReasoningSummary(state.summary);
	if (!after.startsWith(state.emitted)) return;
	let delta = after.slice(state.emitted.length);
	if (!delta) return;
	state.emitted = after;
	// A fresh block starts a new section: drop the inter-section separator so
	// each thinking block stands alone.
	if (!block.thinking) delta = delta.replace(/^\n+/, "");
	if (!delta) return;
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
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
/** Chooses final message text while treating non-empty terminal content as authoritative. */
export function finalizeMessageText(item: ResponseOutputMessage, streamedText: string): string {
	if (!item.content?.length) return streamedText || "";
	return item.content.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? ""))).join("");
}
export const JUICE_EFFORT_MAP: Record<string, number> = {
	none: 0,
	minimal: 2,
	low: 4,
	medium: 8,
	high: 48,
	xhigh: 112,
	max: 960,
};

export function getJuiceValue(effort?: string): number {
	if (!effort) return 8;
	return JUICE_EFFORT_MAP[effort] ?? 8;
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
	block.arguments = { input };
}

type OpenAIResponsesTerminalStreamEvent =
	| Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>
	| { type: "response.done"; response?: Partial<OpenAIResponse> };

function getOpenAIResponsesTerminalEvent(event: ResponseStreamEvent): OpenAIResponsesTerminalStreamEvent | undefined {
	const type = (event as { type?: unknown }).type;
	return type === "response.completed" || type === "response.incomplete" || type === "response.done"
		? (event as OpenAIResponsesTerminalStreamEvent)
		: undefined;
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
	/**
	 * Called when a terminal `response.completed`, `response.incomplete`, or
	 * `response.done` event is successfully processed. Only invoked on the
	 * successful-completion path; thrown failure (`response.failed`) and
	 * cancellation paths never call this.
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

export function computerCallMetadata(item: ResponseComputerToolCall): ComputerToolCallMetadata {
	const actions = item.actions?.length ? item.actions : item.action ? [item.action] : [];
	return {
		type: "computer",
		providerItemId: item.id,
		actions: structuredCloneJSON(actions) as ComputerAction[],
		pendingSafetyChecks: structuredCloneJSON(item.pending_safety_checks ?? []),
	};
}

/** Append a native Responses image result and emit its completion event. */
export function appendResponsesImageResult(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	result: string,
): void {
	const image: ImageContent = {
		type: "image",
		data: result,
		mimeType: parseImageMetadata(Buffer.from(result, "base64"))?.mimeType ?? "image/png",
	};
	output.content.push(image);
	stream.push({
		type: "image_end",
		contentIndex: output.content.length - 1,
		content: image,
		partial: output,
	});
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
		item:
			| ResponseReasoningItem
			| ResponseOutputMessage
			| ResponseFunctionToolCall
			| ResponseCustomToolCall
			| ResponseComputerToolCall;
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
	const startsJsonObjectDelta = (delta: unknown): boolean => {
		if (typeof delta !== "string") return false;
		for (let index = 0; index < delta.length; index++) {
			const code = delta.charCodeAt(index);
			if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
			return code === 0x7b;
		}
		return false;
	};
	const shouldAdvanceIdentifierlessFunctionDelta = (
		event: { output_index?: number; item_id?: string; delta?: unknown },
		candidate: StreamingItem,
	): boolean => {
		const delta = event.delta;
		if (
			hasOpenItemKey(event) ||
			typeof delta !== "string" ||
			!startsJsonObjectDelta(delta) ||
			candidate.item.type !== "function_call" ||
			candidate.block.type !== "toolCall"
		) {
			return false;
		}
		const partial = candidate.block[kStreamingPartialJson];
		if (partial.trim().length === 0) return false;
		// A `{`-starting identifierless delta is ambiguous: the opening of a new
		// sibling call, or continuation bytes inside the candidate's own argument
		// JSON (`{"command":"echo ` + `{1..3}"}`). Advance only when the candidate
		// cannot absorb the delta: its buffer is already one complete JSON value,
		// already unsalvageable (lossy hosts abandon buffers mid-string, leaving
		// raw control characters strict JSON forbids), or the concatenation would
		// break it. Otherwise the delta is a legal continuation and must stay.
		const state = classifyJsonPrefix(partial);
		if (state !== "prefix") return true;
		return classifyJsonPrefix(partial + delta) === "invalid";
	};
	const hasLaterUnfinishedFunctionCall = (start: number): boolean => {
		for (let index = start + 1; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index];
			if (
				candidate?.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				return true;
			}
		}
		return false;
	};

	let identifierlessFunctionDeltaTarget: StreamingItem | undefined;

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
		delta?: unknown;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenToolCallAlias(event, "function_call");
		const canContinuePreviousIdentifierlessDelta = typeof event.delta === "string";
		if (canContinuePreviousIdentifierlessDelta && identifierlessFunctionDeltaTarget) {
			const targetIndex = openItemsInOrder.indexOf(identifierlessFunctionDeltaTarget);
			const target = targetIndex >= 0 ? openItemsInOrder[targetIndex] : undefined;
			if (
				target?.item.type === "function_call" &&
				target.block.type === "toolCall" &&
				!target.block[kStreamingArgumentsDone]
			) {
				const shouldAdvanceFromTarget =
					shouldAdvanceIdentifierlessFunctionDelta(event, target) && hasLaterUnfinishedFunctionCall(targetIndex);
				if (!shouldAdvanceFromTarget) return target;
			} else {
				identifierlessFunctionDeltaTarget = undefined;
			}
		}
		let skippedStartedCandidate = false;
		for (let index = 0; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index]!;
			if (
				candidate.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				if (shouldAdvanceIdentifierlessFunctionDelta(event, candidate) && hasLaterUnfinishedFunctionCall(index)) {
					skippedStartedCandidate = true;
					continue;
				}
				if (canContinuePreviousIdentifierlessDelta) identifierlessFunctionDeltaTarget = candidate;
				return candidate;
			}
		}
		if (skippedStartedCandidate && startsJsonObjectDelta(event.delta)) return undefined;
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
		if (entry && identifierlessFunctionDeltaTarget === entry) identifierlessFunctionDeltaTarget = undefined;
		if (entry && lastOpenItem === entry) lastOpenItem = null;
	};
	const contentIndexOf = (block: ThinkingContent | TextContent | StreamingToolCallBlock): number =>
		output.content.indexOf(block);

	let sawFirstToken = false;
	// Whether the current stream produced a completed native `web_search_call`
	// output item. A provider-hosted search that finishes without yield is
	// progress evidence: the turn should pause for continuation rather than end.
	let sawCompletedWebSearchCall = false;

	for await (const event of openaiStream) {
		const terminalEvent = getOpenAIResponsesTerminalEvent(event);
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
			} else if (item.type === "computer_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: "computer",
					arguments: {},
					providerMetadata: computerCallMetadata(item),
					[kStreamingPartialJson]: "",
				};
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block }, item.call_id);
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
					event.summary_index,
				);
			}
		} else if (event.type === "response.reasoning_summary_text.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				applyReasoningSummaryTextDone(
					entry.item,
					entry.block,
					event.text,
					event.summary_index,
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
				entry.block[kStreamingArgumentsDone] = true;
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry =
				item.type === "function_call" || item.type === "custom_tool_call"
					? lookupOpenItem({ output_index: event.output_index, item_id: item.id ?? item.call_id })
					: lookupOpenItem({ output_index: event.output_index, item_id: item.id });
			if (item.type === "reasoning") {
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
					reasoningBlock.thinking = finalizeReasoningThinking(item, reasoningBlock.thinking);
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: contentIndexOf(reasoningBlock),
						content: reasoningBlock.thinking,
						partial: output,
					});
				}
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "message") {
				const block = entry?.block.type === "text" ? entry.block : undefined;
				const text = finalizeMessageText(item, block?.text ?? "");
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
					: item.arguments
						? parseStreamingJson(item.arguments)
						: block?.[kStreamingPartialJson]
							? parseStreamingJson(block[kStreamingPartialJson])
							: parseStreamingJson("{}");
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
			} else if (item.type === "computer_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: "computer",
					arguments: {},
					providerMetadata: computerCallMetadata(item),
				};
				let contentIndex: number;
				if (block) {
					block.id = toolCall.id;
					block.providerMetadata = toolCall.providerMetadata;
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id);
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
			} else if (item.type === "web_search_call" && (item.status === undefined || item.status === "completed")) {
				// A completed provider-hosted web search is progress evidence even when
				// the model never surfaced an answer; the agent loop continues from it.
				sawCompletedWebSearchCall = true;
			} else if (item.type === "image_generation_call" && item.status === "completed" && item.result) {
				appendResponsesImageResult(output, stream, item.result);
			}
		} else if (terminalEvent) {
			const response = terminalEvent.response;
			const shouldPromoteIncompleteToolUse =
				response?.status === "incomplete" &&
				response.incomplete_details?.reason === "max_output_tokens" &&
				hasExecutableIncompleteResponsesToolCalls(output);
			finalizePendingResponsesToolCalls(output);
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			applyProviderReportedCost(model, output.usage, response?.usage);
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
			promoteResponsesToolUseStopReason(
				output,
				(response as { end_turn?: boolean } | undefined)?.end_turn,
				shouldPromoteIncompleteToolUse,
			);
			// A completed provider-hosted web search that yielded no visible answer
			// (no text, image, or client tool call) is progress, not a dead end:
			// pause the turn so the agent loop re-samples with the search results
			// instead of silently ending. Reasoning/native output items are preserved
			// for replay. A search followed by visible output stays a normal stop.
			if (sawCompletedWebSearchCall && output.stopReason === "stop" && !hasVisibleAssistantContent(output)) {
				output.stopDetails = { type: "pause_turn" };
			}
			options?.onCompleted?.();
			// `response.completed`/`response.incomplete`/`response.done` is the last event of a
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

export function hasExecutableIncompleteResponsesToolCalls(output: AssistantMessage): boolean {
	let hasToolCall = false;
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		hasToolCall = true;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending.providerMetadata?.type === "computer") {
			if (pending.providerMetadata.actions.length === 0) return false;
			continue;
		}
		const rawArguments = pending[kStreamingPartialJson];
		// `output_item.done` is not positive completion proof: our Responses
		// compatibility encoder force-closes still-open calls before forwarding an
		// upstream `length` stop. Only an explicit arguments/input-done event sets
		// this marker; an open ordinary call can instead prove completion with its
		// retained strict-complete JSON.
		if (pending[kStreamingArgumentsDone]) continue;
		if (pending.customWireName !== undefined || rawArguments === undefined) return false;
		if (classifyJsonPrefix(rawArguments) !== "complete") return false;
	}
	return hasToolCall;
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
export function promoteResponsesToolUseStopReason(
	output: AssistantMessage,
	endTurn: boolean | undefined,
	promoteIncompleteToolUse = false,
): void {
	if (
		output.content.some(block => block.type === "toolCall") &&
		(output.stopReason === "stop" || (promoteIncompleteToolUse && output.stopReason === "length"))
	) {
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
	model: Pick<Model, "provider" | "api" | "id" | "omitMaxOutputTokens" | "maxTokens" | "identity"> & {
		compat: Pick<ResolvedOpenAISharedCompat, "supportsSamplingParams" | "supportsPenaltyAndStopParams">;
	},
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			resolveOpenAIResponsesOutputClamp(model) ?? OPENAI_MAX_OUTPUT_TOKENS,
		);
	}
	// OpenAI proprietary reasoning models (o-series, gpt-5+) reject explicit
	// sampling params with a 400 on every serving host (#5606).
	if (model.compat.supportsSamplingParams) {
		if (options?.temperature !== undefined) params.temperature = options.temperature;
		if (options?.topP !== undefined) params.top_p = options.topP;
		if (options?.topK !== undefined) params.top_k = options.topK;
		if (options?.minP !== undefined) params.min_p = options.minP;
		if (model.compat.supportsPenaltyAndStopParams) {
			if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
			if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
		}
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);
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
	/**
	 * Suppress native reasoning by sending `reasoning.effort: "none"` — the only
	 * disable level the Responses API defines (`"off"` is not a wire value and
	 * 400s everywhere). Gateways that reject `none` for a given model are
	 * handled by the reasoning-effort fallback retry, which clamps to the
	 * lowest level the error reports as allowed.
	 */
	forceReasoningOff?: boolean;
}

export function applyResponsesCompatPolicy<P extends ResponseCreateParamsStreaming>(
	params: P,
	policy: OpenAICompatPolicy,
	options: ApplyResponsesCompatPolicyOptions | undefined,
): void {
	const reasoning = policy.reasoning;
	if (options?.forceReasoningOff) {
		params.reasoning = { effort: "none" } as P["reasoning"];
		return;
	}
	if (!reasoning.modelSupported) return;
	if (reasoning.includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (reasoning.disabled) {
		if (reasoning.disableMode === "openrouter-enabled-false") {
			params.reasoning = { enabled: false } as P["reasoning"];
			return;
		}
		if (
			(reasoning.disableMode === "lowest-effort" || reasoning.disableMode === "none-effort") &&
			reasoning.wireEffort !== undefined &&
			!reasoning.omitReasoningEffort
		) {
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			params.reasoning = { effort: reasoning.wireEffort as ReasoningParam["effort"] } as P["reasoning"] &
				ReasoningParam;
			return;
		}
		return;
	}

	if (reasoning.requestedEffort !== undefined || options?.reasoningSummary !== undefined) {
		if (reasoning.omitReasoningEffort) {
			if (options?.reasoningSummary !== undefined && options.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
			return;
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
		return;
	}
}

/**
 * Apply reasoning-related Responses parameters. Default behavior comes from
 * catalog compat; include/omit arguments are explicit adapter-wrapper overrides.
 */
export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning?: boolean,
	omitReasoningEffort?: boolean,
): void {
	return applyResponsesCompatPolicy(
		params,
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
	const reportedInputTokens = usage.input_tokens ?? 0;
	const reportedOutputTokens = usage.output_tokens ?? 0;
	const reportedCachedTokens = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const orchestrationInputTokens = details?.orchestration_input_tokens ?? 0;
	const orchestrationInputCachedTokens = details?.orchestration_input_cached_tokens ?? 0;
	const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens ?? 0;
	const reportedTotalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
	const reportedPrimaryTokens = reportedInputTokens + reportedOutputTokens;
	const reportedWithSeparateOrchestration =
		reportedPrimaryTokens + orchestrationInputTokens + orchestrationOutputTokens;
	const primaryIncludesOrchestration =
		reportedTotalTokens !== undefined &&
		orchestrationInputTokens + orchestrationOutputTokens > 0 &&
		Math.abs(reportedTotalTokens - reportedPrimaryTokens) <=
			Math.abs(reportedTotalTokens - reportedWithSeparateOrchestration);
	const orchestrationInputCached = Math.min(orchestrationInputTokens, orchestrationInputCachedTokens);
	const orchestrationInput = Math.max(0, orchestrationInputTokens - orchestrationInputCached);
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: Math.max(0, reportedInputTokens - (primaryIncludesOrchestration ? orchestrationInputTokens : 0)),
		outputTokens: Math.max(0, reportedOutputTokens - (primaryIncludesOrchestration ? orchestrationOutputTokens : 0)),
		cachedTokens: Math.max(0, reportedCachedTokens - (primaryIncludesOrchestration ? orchestrationInputCached : 0)),
		reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
		cacheWriteOpenRouter: details?.cache_write_tokens ?? undefined,
		cacheWriteDeepSeek: usage.prompt_cache_miss_tokens ?? undefined,
		hasDeepSeekCacheHitAndMiss:
			usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined,
	});
	const orchestrationTotal = orchestrationInput + orchestrationInputCached + orchestrationOutputTokens;
	if (orchestrationTotal > 0) {
		accounting.orchestration = {
			...(orchestrationInput > 0 ? { input: orchestrationInput } : {}),
			...(orchestrationInputCached > 0 ? { cacheRead: orchestrationInputCached } : {}),
			...(orchestrationOutputTokens > 0 ? { output: orchestrationOutputTokens } : {}),
		};
		accounting.totalTokens = reportedTotalTokens ?? accounting.totalTokens + orchestrationTotal;
	}

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
function deepEqualsWithout(
	a: unknown,
	b: unknown,
	omitKeys?: Readonly<Record<string, boolean>>,
	additionalOmitKeys?: Readonly<Record<string, boolean>>,
): boolean {
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return Bun.deepEquals(a, b);
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const key in ao) {
		if (omitKeys?.[key] || additionalOmitKeys?.[key]) continue;
		const av = ao[key];
		const bv = bo[key];
		if (av !== bv && !Bun.deepEquals(av, bv)) return false;
	}
	for (const key in bo) {
		if (omitKeys?.[key] || additionalOmitKeys?.[key]) continue;
		if (bo[key] !== undefined && !(key in ao)) return false;
	}
	return true;
}

const TOP_LEVEL_EXCLUDE_MAP = {
	input: true,
	client_metadata: true,
};

/**
 * Output-only lifecycle metadata excluded from per-item prefix identity:
 * replay sanitization strips `status` from message/function_call/custom
 * tool items (they reject output lifecycle fields), so raw response items
 * must not be distinguished from their sanitized replay form.
 */
const ITEM_LIFECYCLE_EXCLUDE_MAP = {
	status: true,
};

/**
 * Replay sanitization strips output item IDs from message/function/custom
 * assistant items. A live transcript rebuilt from the corresponding agent
 * message may still retain that ID; it is output-only identity, while call_id
 * remains the semantic tool/result pairing key.
 */
const REPLAY_SANITIZED_ITEM_EXCLUDE_MAP = {
	status: true,
	id: true,
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
	additionalTopLevelExcludeMap?: Readonly<Record<string, boolean>>,
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	if (!deepEqualsWithout(previous, current, TOP_LEVEL_EXCLUDE_MAP, additionalTopLevelExcludeMap)) {
		return null;
	}

	const baselineLen = (previous.input?.length ?? 0) + (previousResponseItems?.length ?? 0);
	if (current.input.length <= baselineLen) return null;

	let index = 0;
	for (const series of [previous.input, previousResponseItems]) {
		if (!series) continue;
		for (const item of series) {
			const type = item.type;
			const omitKeys =
				type === "message" || type === "function_call" || type === "custom_tool_call"
					? REPLAY_SANITIZED_ITEM_EXCLUDE_MAP
					: ITEM_LIFECYCLE_EXCLUDE_MAP;
			if (deepEqualsWithout(item, current.input[index], omitKeys)) {
				index++;
			} else {
				return null;
			}
		}
	}
	return current.input.slice(index) as TItem[];
}
