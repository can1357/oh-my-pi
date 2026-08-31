import { type } from "@oh-my-pi/omptype";
import { once } from "@oh-my-pi/pi-utils";

export const getModelsConfigSchemaBundle = once(() => {
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
		"max?": "string",
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
		"qwenTemplateReasoningEffort?": "boolean",
		"openRouterRouting?": OpenRouterRoutingSchema,
		"vercelGatewayRouting?": VercelGatewayRoutingSchema,
		"extraBody?": { "[string]": "unknown" },
		"cacheControlFormat?": '"anthropic"',
		"supportsStrictMode?": "boolean",
		"toolStrictMode?": '"all_strict" | "none"',
		"streamIdleTimeoutMs?": "number >= 0",
		"streamMarkupHealingPattern?": '"kimi" | "dsml" | "qwen" | "thinking"',
		"supportsLongPromptCacheRetention?": "boolean",
		"supportsReasoningParams?": "boolean",
		"alwaysSendMaxTokens?": "boolean",
		"strictResponsesPairing?": "boolean",
		"supportsImageDetailOriginal?": "boolean",
		// anthropic-messages compat flags (same `compat` slot, per-api interpretation)
		"supportsEagerToolInputStreaming?": "boolean",
		"allowAnthropicHeaderOverrides?": "boolean",
		"requiresToolResultId?": "boolean",
		"replayUnsignedThinking?": "boolean",
	} as const;

	const OpenAICompatFieldsSchema = type(OpenAICompatFields);

	const OpenAICompatSchema = type({
		...OpenAICompatFields,
		"whenThinking?": OpenAICompatFieldsSchema,
	});

	const BedrockCompatSchema = type({
		"promptCacheMode?": '"none" | "automatic" | "explicit"',
		"supportsLongPromptCacheRetention?": "boolean",
		"promptCacheMinimumTokens?": "number >= 0",
		"promptCacheMaximumCheckpoints?": "number >= 0",
	});

	// Provider-level overrides can target bundled models whose API is not repeated
	// in models.yml, so preserve the sparse compat shape for each supported API.
	const ApiCompatSchema = OpenAICompatSchema.and(BedrockCompatSchema);

	const ApiSchema = type(
		'"openai-completions" | "openai-responses" | "openai-codex-responses" | "azure-openai-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai" | "google-gemini-cli" | "google-vertex"',
	);

	const EffortSchema = type('"minimal" | "low" | "medium" | "high" | "xhigh" | "max"');

	const ThinkingControlModeSchema = type(
		'"effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort"',
	);

	const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
		"requiresEffort?": "boolean",
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
				...(value.requiresEffort !== undefined && { requiresEffort: value.requiresEffort }),
			};
		});

	const ModelTokenizerSchema = type(
		'"claude-v3" | "claude-v47" | "claude-v5" | "claude-v5-sonnet" | "qwen3" | "deepseek-v3" | "kimi-k2" | "glm5"',
	);

	const RemoteCompactionSchema = type({
		"enabled?": "boolean",
		"api?": ApiSchema,
		"endpoint?": "string",
		"model?": "string",
		"v2StreamingEnabled?": "boolean",
		"v2Endpoint?": "string",
		"streamingEndpoint?": "string",
	}).narrow((value, ctx) => {
		if (value.endpoint !== undefined && typeof value.endpoint === "string" && value.endpoint.length === 0) {
			return ctx.mustBe("remoteCompaction.endpoint a non-empty string");
		}
		if (value.model !== undefined && typeof value.model === "string" && value.model.length === 0) {
			return ctx.mustBe("remoteCompaction.model a non-empty string");
		}
		if (value.v2Endpoint !== undefined && typeof value.v2Endpoint === "string" && value.v2Endpoint.length === 0) {
			return ctx.mustBe("remoteCompaction.v2Endpoint a non-empty string");
		}
		if (
			value.streamingEndpoint !== undefined &&
			typeof value.streamingEndpoint === "string" &&
			value.streamingEndpoint.length === 0
		) {
			return ctx.mustBe("remoteCompaction.streamingEndpoint a non-empty string");
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
		"imageInputDecoder?": '"stb"',
		"tokenizer?": ModelTokenizerSchema,
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
		"preferWebsockets?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": ApiCompatSchema,
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

	const ModelOverrideSchema = type({
		"name?": "string",
		"reasoning?": "boolean",
		"thinking?": ModelThinkingSchema,
		"input?": '("text" | "image")[]',
		"imageInputDecoder?": '"stb"',
		"tokenizer?": ModelTokenizerSchema,
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
		"preferWebsockets?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": ApiCompatSchema,
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

	const ProviderDiscoverySchema = type({
		type: '"ollama" | "llama.cpp" | "lm-studio" | "openai-models-list" | "proxy" | "litellm"',
		"timeoutMs?": "number",
		/**
		 * Defaults to `true`. Set `false` to fetch the model list from
		 * `{baseUrl}/models` without injecting `/v1` — for gateways that root
		 * their OpenAI-compatible surface at a versioned path (e.g.
		 * `https://api.opper.ai/v3/compat`) where the forced `/v1/models`
		 * returns a different, smaller model list.
		 */
		"injectV1?": "boolean",
	}).narrow((value, ctx) => {
		if (value.injectV1 !== undefined && value.type !== "openai-models-list") {
			return ctx.mustBe("injectV1 only on openai-models-list discovery");
		}
		if (
			value.timeoutMs !== undefined &&
			(typeof value.timeoutMs !== "number" || value.timeoutMs <= 0 || !Number.isFinite(value.timeoutMs))
		) {
			return ctx.mustBe("timeoutMs a positive finite number");
		}
		return true;
	});

	const ProviderAuthSchema = type('"apiKey" | "none" | "oauth"');

	const ProviderConfigSchema = type({
		"baseUrl?": "string",
		"apiKey?": "string",
		"api?": ApiSchema,
		"headers?": { "[string]": "string" },
		"compat?": ApiCompatSchema,
		"remoteCompaction?": RemoteCompactionSchema,
		"authHeader?": "boolean",
		"auth?": ProviderAuthSchema,
		"discovery?": ProviderDiscoverySchema,
		"models?": ModelDefinitionSchema.array(),
		"modelOverrides?": { "[string]": ModelOverrideSchema },
		"disableStrictTools?": "boolean",
		/**
		 * Amazon Bedrock Guardrail id or ARN attached to every Converse request under
		 * this provider. Required by accounts that gate `bedrock:InvokeModel*` on the
		 * `bedrock:GuardrailIdentifier` condition key.
		 */
		"guardrailIdentifier?": "string",
		/** Bedrock guardrail version (defaults to `"DRAFT"` when a guardrail is set). */
		"guardrailVersion?": "string",
		/** Bedrock guardrail trace verbosity. */
		"guardrailTrace?": '"enabled" | "disabled" | "enabled_full"',
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

	const ModelsConfigSchema = type({
		"providers?": { "[string]": ProviderConfigSchema },
	});

	return {
		OpenAICompatSchema,
		ModelOverrideSchema,
		ProviderDiscoverySchema,
		ProviderAuthSchema,
		ModelsConfigSchema,
	};
});

export const getModelsConfigSchema = () => getModelsConfigSchemaBundle().ModelsConfigSchema;
