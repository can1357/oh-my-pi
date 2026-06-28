import { scope } from "arktype";

// Config schemas validate at most a handful of times per process (on config
// load), so the eager JIT codegen ArkType runs at definition time is pure
// startup tax. A local jitless scope skips that codegen and falls back to
// interpreted traversal — ~65% cheaper to construct, validation correctness
// unchanged. (No `name`: duplicate module instances would collide.)
const { type } = scope({}, { jitless: true });

const OpenRouterRoutingSchema = type({
	"only?": "string[]",
	"order?": "string[]",
});

const VercelGatewayRoutingSchema = type({
	"only?": "string[]",
	"order?": "string[]",
});

const ReasoningEffortMapSchema = type({
	"minimal?": "string",
	"low?": "string",
	"medium?": "string",
	"high?": "string",
	"xhigh?": "string",
});

const OpenAICompatFields = {
	"supportsStore?": "boolean",
	"supportsDeveloperRole?": "boolean",
	"supportsMultipleSystemMessages?": "boolean",
	"supportsReasoningEffort?": "boolean",
	"reasoningEffortMap?": ReasoningEffortMapSchema,
	"maxTokensField?": '"max_completion_tokens" | "max_tokens"',
	"supportsUsageInStreaming?": "boolean",
	"requiresToolResultName?": "boolean",
	"requiresMistralToolIds?": "boolean",
	"requiresAssistantAfterToolResult?": "boolean",
	"requiresThinkingAsText?": "boolean",
	"reasoningContentField?": '"reasoning_content" | "reasoning" | "reasoning_text"',
	"requiresReasoningContentForToolCalls?": "boolean",
	"allowsSyntheticReasoningContentForToolCalls?": "boolean",
	"requiresAssistantContentForToolCalls?": "boolean",
	"supportsToolChoice?": "boolean",
	"supportsForcedToolChoice?": "boolean",
	"disableReasoningOnForcedToolChoice?": "boolean",
	"disableReasoningOnToolChoice?": "boolean",
	"thinkingFormat?": '"openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template"',
	"openRouterRouting?": OpenRouterRoutingSchema,
	"vercelGatewayRouting?": VercelGatewayRoutingSchema,
	"extraBody?": { "[string]": "unknown" },
	"cacheControlFormat?": '"anthropic"',
	"supportsStrictMode?": "boolean",
	"toolStrictMode?": '"all_strict" | "none"',
	"streamIdleTimeoutMs?": "number >= 0",
	"supportsLongPromptCacheRetention?": "boolean",
	"supportsReasoningParams?": "boolean",
	"alwaysSendMaxTokens?": "boolean",
	"strictResponsesPairing?": "boolean",
	"supportsImageDetailOriginal?": "boolean",
	// anthropic-messages compat flags (same `compat` slot, per-api interpretation)
	"requiresToolResultId?": "boolean",
	"replayUnsignedThinking?": "boolean",
} as const;

const OpenAICompatFieldsSchema = type(OpenAICompatFields);

export const OpenAICompatSchema = type({
	...OpenAICompatFields,
	"whenThinking?": OpenAICompatFieldsSchema,
});

const ApiSchema = type(
	'"openai-completions" | "openai-responses" | "openai-codex-responses" | "azure-openai-responses" | "anthropic-messages" | "google-generative-ai" | "google-gemini-cli" | "google-vertex"',
);

const EffortSchema = type('"minimal" | "low" | "medium" | "high" | "xhigh"');

const ThinkingControlModeSchema = type(
	'"effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort"',
);

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * Accepts the canonical `efforts` vocabulary plus the legacy
 * `minLevel`/`maxLevel`/`levels` range shape, normalizing both to
 * `ThinkingConfig` (ordered `efforts`, never empty). Precedence mirrors the
 * old runtime: explicit `levels` beat the min..max range; `efforts` beats both.
 */
const ModelThinkingSchema = type({
	mode: ThinkingControlModeSchema,
	"efforts?": EffortSchema.array(),
	"defaultLevel?": EffortSchema,
	"effortMap?": ReasoningEffortMapSchema,
	"supportsDisplay?": "boolean",
	// Legacy range vocabulary (pre-efforts configs).
	"minLevel?": EffortSchema,
	"maxLevel?": EffortSchema,
	"levels?": EffortSchema.array(),
})
	.narrow(
		(value, ctx) =>
			value.efforts !== undefined ||
			value.levels !== undefined ||
			(value.minLevel !== undefined && value.maxLevel !== undefined) ||
			ctx.mustBe("thinking with `efforts` (or legacy `levels`/`minLevel`+`maxLevel`)"),
	)
	.pipe((value: any) => {
		let resolved = value.efforts ?? value.levels;
		if (!resolved) {
			const minIndex = EFFORT_ORDER.indexOf(value.minLevel!);
			const maxIndex = EFFORT_ORDER.indexOf(value.maxLevel!);
			resolved = EFFORT_ORDER.slice(minIndex, Math.max(minIndex, maxIndex) + 1);
		}
		return {
			mode: value.mode,
			efforts: resolved,
			...(value.defaultLevel !== undefined && { defaultLevel: value.defaultLevel }),
			...(value.effortMap !== undefined && { effortMap: value.effortMap }),
			...(value.supportsDisplay !== undefined && { supportsDisplay: value.supportsDisplay }),
		};
	});

const RemoteCompactionSchema = type({
	"enabled?": "boolean",
	"api?": ApiSchema,
	"endpoint?": "string",
	"model?": "string",
}).narrow((value, ctx) => {
	if (value.endpoint !== undefined && typeof value.endpoint === "string" && value.endpoint.length === 0) {
		return ctx.mustBe("remoteCompaction.endpoint a non-empty string");
	}
	if (value.model !== undefined && typeof value.model === "string" && value.model.length === 0) {
		return ctx.mustBe("remoteCompaction.model a non-empty string");
	}
	return true;
});

const ModelDefinitionSchema = type({
	id: "string",
	"name?": "string",
	"api?": ApiSchema,
	"baseUrl?": "string",
	"reasoning?": "boolean",
	"thinking?": ModelThinkingSchema,
	"input?": '("text" | "image")[]',
	"supportsTools?": "boolean",
	"cost?": {
		input: "number",
		output: "number",
		cacheRead: "number",
		cacheWrite: "number",
	},
	"premiumMultiplier?": "number",
	"contextWindow?": "number",
	"maxTokens?": "number",
	"omitMaxOutputTokens?": "boolean",
	"headers?": { "[string]": "string" },
	"compat?": OpenAICompatSchema,
	"contextPromotionTarget?": "string",
	"compactionModel?": "string",
	"remoteCompaction?": RemoteCompactionSchema,
}).narrow((value, ctx) => {
	// Enforce id non-empty
	if (typeof value.id === "string" && value.id.length === 0) {
		return ctx.mustBe("id a non-empty string");
	}
	if (value.name !== undefined && typeof value.name === "string" && value.name.length === 0) {
		return ctx.mustBe("name a non-empty string");
	}
	if (value.baseUrl !== undefined && typeof value.baseUrl === "string" && value.baseUrl.length === 0) {
		return ctx.mustBe("baseUrl a non-empty string");
	}
	if (
		value.contextPromotionTarget !== undefined &&
		typeof value.contextPromotionTarget === "string" &&
		value.contextPromotionTarget.length === 0
	) {
		return ctx.mustBe("contextPromotionTarget a non-empty string");
	}
	if (
		value.compactionModel !== undefined &&
		typeof value.compactionModel === "string" &&
		value.compactionModel.length === 0
	) {
		return ctx.mustBe("compactionModel a non-empty string");
	}
	return true;
});

export const ModelOverrideSchema = type({
	"name?": "string",
	"reasoning?": "boolean",
	"thinking?": ModelThinkingSchema,
	"input?": '("text" | "image")[]',
	"supportsTools?": "boolean",
	"cost?": {
		"input?": "number",
		"output?": "number",
		"cacheRead?": "number",
		"cacheWrite?": "number",
	},
	"premiumMultiplier?": "number",
	"contextWindow?": "number",
	"maxTokens?": "number",
	"omitMaxOutputTokens?": "boolean",
	"headers?": { "[string]": "string" },
	"compat?": OpenAICompatSchema,
	"contextPromotionTarget?": "string",
	"compactionModel?": "string",
	"remoteCompaction?": RemoteCompactionSchema,
}).narrow((value, ctx) => {
	if (value.name !== undefined && typeof value.name === "string" && value.name.length === 0) {
		return ctx.mustBe("name a non-empty string");
	}
	if (
		value.contextPromotionTarget !== undefined &&
		typeof value.contextPromotionTarget === "string" &&
		value.contextPromotionTarget.length === 0
	) {
		return ctx.mustBe("contextPromotionTarget a non-empty string");
	}
	if (
		value.compactionModel !== undefined &&
		typeof value.compactionModel === "string" &&
		value.compactionModel.length === 0
	) {
		return ctx.mustBe("compactionModel a non-empty string");
	}
	return true;
});

export type ModelOverride = typeof ModelOverrideSchema.infer;

export const ProviderDiscoverySchema = type({
	type: '"ollama" | "llama.cpp" | "lm-studio" | "openai-models-list" | "proxy" | "litellm"',
});

export const ProviderAuthSchema = type('"apiKey" | "none" | "oauth"');

export type ProviderAuthMode = typeof ProviderAuthSchema.infer;
export type ProviderDiscovery = typeof ProviderDiscoverySchema.infer;

const ProviderConfigSchema = type({
	"baseUrl?": "string",
	"apiKey?": "string",
	"api?": ApiSchema,
	"headers?": { "[string]": "string" },
	"compat?": OpenAICompatSchema,
	"remoteCompaction?": RemoteCompactionSchema,
	"authHeader?": "boolean",
	"auth?": ProviderAuthSchema,
	"discovery?": ProviderDiscoverySchema,
	"models?": ModelDefinitionSchema.array(),
	"modelOverrides?": { "[string]": ModelOverrideSchema },
	"disableStrictTools?": "boolean",
	/**
	 * Streaming transport override. When set to `"pi-native"`, omp dispatches
	 * every model under this provider via the auth-gateway's
	 * `POST /v1/pi/stream` endpoint instead of the per-provider SDK. The
	 * provider's `baseUrl` must point at a compatible `omp auth-gateway`
	 * and `apiKey` must carry the gateway bearer.
	 */
	"transport?": '"pi-native"',
}).narrow((value, ctx) => {
	if (value.baseUrl !== undefined && typeof value.baseUrl === "string" && value.baseUrl.length === 0) {
		return ctx.mustBe("baseUrl a non-empty string");
	}
	if (value.apiKey !== undefined && typeof value.apiKey === "string" && value.apiKey.length === 0) {
		return ctx.mustBe("apiKey a non-empty string");
	}
	return true;
});

const EquivalenceConfigSchema = type({
	"overrides?": { "[string]": "string" },
	"exclude?": "string[]",
}).narrow((value, ctx) => {
	if (value.overrides !== undefined) {
		for (const [, v] of Object.entries(value.overrides)) {
			if (typeof v === "string" && v.length === 0) {
				return ctx.mustBe("overrides values non-empty strings");
			}
		}
	}
	if (value.exclude !== undefined && Array.isArray(value.exclude)) {
		for (const item of value.exclude) {
			if (typeof item === "string" && item.length === 0) {
				return ctx.mustBe("exclude items non-empty strings");
			}
		}
	}
	return true;
});

export const ModelsConfigSchema = type({
	"providers?": { "[string]": ProviderConfigSchema },
	"equivalence?": EquivalenceConfigSchema,
});

export type ModelsConfig = typeof ModelsConfigSchema.infer;
