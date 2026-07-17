import type { Effort } from "./effort";

export type { KnownProvider } from "./provider-models/descriptors";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openrouter"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "google-interactions"
	| "ollama-chat"
	| "cursor-agent"
	| "gitlab-duo-agent"
	| "devin-agent";
export type Api = KnownApi | (string & {});

/** Canonical thinking transport used by a model. */
export type ThinkingControlMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

/** Per-model thinking capabilities used to clamp and map user-facing effort levels. */
export interface ThinkingConfig {
	/** Provider-specific transport used to encode the selected effort. */
	mode: ThinkingControlMode;
	/**
	 * Supported user-facing efforts, ordered least → most intensive. Never
	 * empty: a reasoning model without a controllable effort surface carries
	 * `thinking: undefined` instead of an empty list.
	 */
	efforts: readonly Effort[];
	/** Optional default effort applied when this model is selected. Falls back to global default if absent. */
	defaultLevel?: Effort;
	/**
	 * Effort → provider wire-value remap, baked at build time. Identity for
	 * efforts the map omits. Used by Anthropic adaptive thinking, OpenAI-
	 * compatible `reasoning_effort`, and Responses-style reasoning params.
	 */
	effortMap?: Partial<Record<Effort, string>>;
	/**
	 * Adaptive thinking accepts the `display` field (Opus 4.7+, Fable/Mythos
	 * 5). Also implies native interleaved thinking — no beta header needed.
	 */
	supportsDisplay?: boolean;
	/**
	 * Per-effort upstream wire-id routing for collapsed effort-tier variants
	 * (`variant-collapse.ts`). Keyed by pi effort; `"off"` applies when
	 * thinking is disabled. Missing keys fall back to `requestModelId ?? id`.
	 */
	effortRouting?: Readonly<Partial<Record<Effort | "off", string>>>;
	/**
	 * Per-effort thinking budget in tokens, baked at build time for collapsed
	 * variants whose upstream expects an explicit `thinkingBudget` instead of a
	 * value derived from the generic ladder (Antigravity Cloud Code Assist
	 * gemini-3.x). Request mapping prefers caller `thinkingBudgets`, then this
	 * map, then the provider default ladder. Only meaningful for `mode: "budget"`.
	 */
	effortBudgets?: Readonly<Partial<Record<Effort, number>>>;
	/**
	 * When true, a thinking-off request MUST explicitly suppress thinking on
	 * the wire (google-level: `thinkingLevel: "MINIMAL"` + `includeThoughts:
	 * false`; budget: `thinkingBudget: 0`) instead of omitting thinkingConfig —
	 * Cloud Code Assist re-applies the per-id baked server default when the
	 * config is absent.
	 */
	suppressWhenOff?: boolean;
	/**
	 * Reasoning is mandatory upstream: the endpoint rejects disabled or
	 * omitted thinking (e.g. OpenRouter Gemini 3.x — "Reasoning is mandatory
	 * for this endpoint and cannot be disabled"). Request mapping clamps
	 * thinking-off to the lowest supported effort unless `suppressWhenOff`
	 * provides an explicit wire off-path.
	 */
	requiresEffort?: boolean;
}

// `Provider` is any provider-id string; `KnownProvider` (re-exported above) enumerates
// the built-in model providers from the catalog descriptor table.
export type Provider = string;

/** Token budgets for each thinking level (token-based providers only) */
export type ThinkingBudgets = { [key in Effort]?: number };

/**
 * `fetch`-compatible function. Accepts any callable matching the standard
 * fetch signature; `preconnect` is optional because non-Bun runtimes (browsers,
 * test mocks) won't expose it.
 */
export type FetchImpl = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
	preconnect?: typeof globalThis.fetch.preconnect;
};

export interface Usage {
	/** Non-cached input tokens (matches the bucket the provider bills as new input). */
	input: number;
	/** Total output tokens for the turn, including thinking, assistant text, and tool-call argument tokens. */
	output: number;
	/** Tokens read from the prompt cache. */
	cacheRead: number;
	/** Tokens written to the prompt cache (cache creation). */
	cacheWrite: number;
	/** Sum of input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** Copilot premium-request counter, when applicable. */
	premiumRequests?: number;
	/**
	 * Reasoning/thinking tokens included in `output`, when the provider reports them
	 * (OpenAI `output_tokens_details.reasoning_tokens`, Google `thoughtsTokenCount`).
	 * Always a subset of `output` — non-reasoning output is `output - reasoningTokens`.
	 *
	 * Providers that don't expose this leave it undefined rather than guessing;
	 * `undefined` means unknown, NOT zero.
	 */
	reasoningTokens?: number;
	/**
	 * Cache-write TTL breakdown (Anthropic only). When set, the components sum to
	 * `cacheWrite`. Absent providers do not populate this.
	 */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/**
	 * Server-side tool invocations made during this turn (Anthropic web_search /
	 * web_fetch, OpenAI built-in tools when reported). Counts requests, not tokens.
	 */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type OpenAIReasoningFormat = "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";

export type OpenAIReasoningDisableMode =
	| "omit"
	| "lowest-effort"
	| "openrouter-enabled-false"
	| "zai-thinking-disabled"
	| "qwen-enable-thinking-false"
	| "qwen-template-false"
	| "juice-zero-developer-message";

export type OpenAIStreamMarkupHealingPattern = "kimi" | "dsml" | "thinking";

/**
 * Compatibility settings for openai-completions API.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/**
	 * Whether the provider's chat-completions endpoint accepts multiple
	 * leading `system`/`developer` messages. When false, ordered system
	 * prompts are coalesced into a single message joined by `\n\n` so
	 * strict chat templates (e.g. Qwen-served via vLLM, MiniMax) accept
	 * the request. Default: detected per provider/baseUrl. Canonical
	 * OpenAI/Azure/OpenRouter/Cerebras/Together/Fireworks/Groq/DeepSeek/
	 * Mistral/xAI/Z.ai/GitHub Copilot/Zenmux are treated as `true`;
	 * unknown or strict-template hosts default to `false`. Setting this
	 * to `true` preserves separate blocks, which is preferred for
	 * KV-cache reuse when the trailing prompt changes between calls.
	 */
	supportsMultipleSystemMessages?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Optional mapping from pi-ai reasoning levels to provider/model-specific `reasoning_effort` values. */
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/**
	 * Enable the Gemini thinking-loop guard (pi-ai stream layer) for this model.
	 * Defaults to true when the model id classifies as the gemini family. Set
	 * explicitly to cover an opaque OpenAI-compat proxy alias (e.g. `my-model`)
	 * that routes to Gemini, or to false to opt a gemini-family id out.
	 */
	enableGeminiThinkingLoopGuard?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "zai" uses thinking: { type: "enabled" | "disabled" } (also used by Moonshot Kimi), "qwen" uses top-level enable_thinking, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
	thinkingFormat?: OpenAIReasoningFormat;
	/** Request-time disable encoding for the selected reasoning/thinking format. Default: derived from `thinkingFormat`. */
	reasoningDisableMode?: OpenAIReasoningDisableMode;
	/** Whether the provider rejects `reasoning.effort`/`reasoning_effort` even when the model reasons natively. Default: false unless reasoning effort is unsupported. */
	omitReasoningEffort?: boolean;
	/** Whether Responses requests should ask for encrypted reasoning replay items. Default: true. */
	includeEncryptedReasoning?: boolean;
	/** Whether replayed Responses history should strip native `type: "reasoning"` items before request encoding. Default: false. */
	filterReasoningHistory?: boolean;
	/** Optional `thinking.keep` value for Z.ai/Moonshot-style thinking params. Set false to suppress auto-detected keep. Default: auto-detected. */
	thinkingKeep?: "all" | false;
	/** Which reasoning content field to emit on assistant messages. Default: auto-detected. */
	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
	/** Whether assistant tool-call messages must include reasoning content. Default: false. */
	requiresReasoningContentForToolCalls?: boolean;
	/** Whether all assistant messages must include reasoning content. Default: false. */
	requiresReasoningContentForAllAssistantTurns?: boolean;
	/** Whether the provider accepts a synthetic placeholder (e.g. ".") for missing reasoning_content on tool-call turns. Default: true. Set to false for providers like DeepSeek that validate the exact reasoning_content value. */
	allowsSyntheticReasoningContentForToolCalls?: boolean;
	/**
	 * Replay prior assistant turns' thinking as `reasoning_content` even when no
	 * `requires*ReasoningContent*` flag demands it. Local llama.cpp-style servers
	 * re-tokenize the entire chat-template prompt each request; Qwen3 /
	 * DeepSeek-R1 / GLM templates reconstruct the prior turn's `<think>` block
	 * from `reasoning_content`, so dropping the field forces full prompt
	 * re-processing (#3528). Chat-completions only. Default: auto-detected
	 * (local inference providers and loopback/RFC1918 baseUrls).
	 */
	replayReasoningContent?: boolean;
	/**
	 * Send the Qwen3.6+ `preserve_thinking` chat-template knob so older assistant
	 * turns keep rendering `<think>...</think>` instead of being stripped past
	 * `last_query_index`, keeping llama.cpp prefix-KV caches byte-identical
	 * across turns (#3541). Routed like `enable_thinking` (top-level for the
	 * `qwen` dialect, `chat_template_kwargs` for `qwen-chat-template`). Non-Qwen
	 * templates ignore it. Default: auto-detected (Qwen thinking dialects on
	 * local backends).
	 */
	qwenPreserveThinking?: boolean;
	/** Whether assistant tool-call messages must include non-empty content. Default: false. */
	requiresAssistantContentForToolCalls?: boolean;
	/** Whether the provider supports the `tool_choice` parameter. Default: true. */
	supportsToolChoice?: boolean;
	/**
	 * Whether forced `tool_choice` values (`"required"` or named tools) are accepted.
	 * When false, request builders keep tools available but downgrade forced choices
	 * to provider-default auto selection. Default: true.
	 */
	supportsForcedToolChoice?: boolean;
	/**
	 * Whether a named forced `tool_choice` (`{ type: "function", function: { name } }`)
	 * is accepted. When false, request builders downgrade named choices to
	 * `"required"` so the turn still forces a tool call. Default: auto-detected
	 * (llama.cpp rejects named tool_choice).
	 */
	supportsNamedToolChoice?: boolean;
	/**
	 * Drop reasoning fields (`reasoning_effort`, OpenRouter `reasoning`) for
	 * the request when `tool_choice` forces a tool call. Mirrors the Anthropic
	 * `disableThinkingIfToolChoiceForced` rule for backends like Kimi that
	 * 400 with `tool_choice 'specified' is incompatible with thinking
	 * enabled` whenever both are present. Default: auto-detected (Kimi).
	 */
	disableReasoningOnForcedToolChoice?: boolean;
	/**
	 * Drop reasoning fields (`reasoning_effort`, OpenRouter `reasoning`) for
	 * any request that sends `tool_choice`. Use for providers/models that accept
	 * tools and `tool_choice`, but reject `tool_choice` while thinking is enabled.
	 * Default: auto-detected (DeepSeek reasoning models).
	 */
	disableReasoningOnToolChoice?: boolean;
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Extra fields to include in request body (e.g. gateway routing hints for OpenClaw-style proxies). */
	extraBody?: Record<string, unknown>;
	/** Request-session header that should mirror the normalized prompt-cache key. Default: unset. */
	promptCacheSessionHeader?: "x-grok-conv-id";
	/** Whether chat-completions payloads should include provider-specific prompt-cache markers. */
	cacheControlFormat?: "anthropic" | undefined;
	/** Whether the provider supports the `strict` field in tool definitions. Default: auto-detected per provider/baseUrl (conservative for unknown providers). */
	supportsStrictMode?: boolean;
	/**
	 * Tool-schema dialect the endpoint validates `tools.function.parameters`
	 * against. `"moonshot-mfjs"` triggers Moonshot Flavored JSON Schema
	 * normalization (collapse `const`→`enum`, infer `type` on bare enums, strip
	 * unsupported validators/`prefixItems`) because Moonshot/Kimi native hosts
	 * reject standard JSON Schema constructs with HTTP 400. Default:
	 * auto-detected (`"moonshot-mfjs"` on api.moonshot.ai / api.kimi.com). Set
	 * `"none"` to opt a custom Moonshot-compatible host out.
	 */
	toolSchemaFlavor?: "moonshot-mfjs" | "none";
	/**
	 * Stream-watchdog idle-timeout floor in ms for slow reasoning hosts.
	 * Default: auto-detected (GLM coding-plan hosts, direct DeepSeek reasoning).
	 */
	streamIdleTimeoutMs?: number;
	/** Whether the host honors `prompt_cache_retention: "24h"` on the Responses API. Default: auto-detected (api.openai.com). */
	supportsLongPromptCacheRetention?: boolean;
	/** Whether tool schemas must be sent either all strict or all non-strict. Undefined keeps the existing per-tool mixed behavior. */
	toolStrictMode?: "all_strict" | "none";
	/** Whether request shaping may send reasoning params at all. Default: auto-detected (disabled for GitHub Copilot chat-completions). */
	supportsReasoningParams?: boolean;
	/** Always send a max-token field when the caller did not provide one. Default: auto-detected (Kimi-family models derive TPM limits from max_tokens). */
	alwaysSendMaxTokens?: boolean;
	/** Whether Responses-API tool-call/result history must be strictly paired. Default: auto-detected (Azure OpenAI, GitHub Copilot). */
	strictResponsesPairing?: boolean;
	/** Whether the Responses API accepts the `detail: "original"` image hint. Default: auto-detected (false for GitHub Copilot, which rejects it with a 400). */
	supportsImageDetailOriginal?: boolean;
	/**
	 * Append a trailing `# Juice: 0 !important` developer item when the caller
	 * did not request reasoning, suppressing default reasoning on models that
	 * cannot disable it via request params (Responses APIs only; see
	 * https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7).
	 * Default: auto-detected (GPT-5-family model names).
	 */
	requiresJuiceZeroHack?: boolean;
	/** Whether streamed reasoning deltas for the same field may repeat the full cumulative text snapshot. Default: false. */
	reasoningDeltasMayBeCumulative?: boolean;
	/** Strip leaked DeepSeek chat-template special tokens from visible content deltas. Default: auto-detected. */
	stripDeepseekSpecialTokens?: boolean;
	/** Heal leaked chat-template/tool-call/thinking markup from visible content deltas. Default: auto-detected. */
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	/** Treat an empty length-finished stream as a context-window error. Default: auto-detected. */
	emptyLengthFinishIsContextError?: boolean;
	/** Normalize tool call ids to OpenAI's 40-character limit. Default: auto-detected. */
	usesOpenAIToolCallIdLimit?: boolean;
	/**
	 * Compat deltas applied when a request actually engages thinking mode
	 * (reasoning requested and not disabled, model reasoning-capable, and not
	 * suppressed by a forced tool choice). `buildModel` materializes the full
	 * alternate view as `compat.whenThinking`; handlers pointer-swap, never
	 * spread. Default: auto-detected (OpenCode gateways, #1071/#1484).
	 */
	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

/**
 * Compatibility settings for anthropic-messages API.
 * Use this to disable features that strict-by-default Anthropic accepts but
 * that proxy gateways (Vertex AI, AWS Bedrock-style fronts, etc.) reject.
 */
export interface AnthropicCompat {
	/**
	 * Drop the top-level `strict: true` field on tool definitions. Vertex AI's
	 * Anthropic-compatible endpoint rejects unknown tool fields with
	 * `tools.<n>.custom.strict: Extra inputs are not permitted`.
	 */
	disableStrictTools?: boolean;
	/**
	 * Map adaptive thinking (`thinking: { type: "adaptive" }`) to
	 * `{ type: "enabled", budget_tokens }`. Vertex AI rejects the `adaptive`
	 * tag with `Input tag 'adaptive' ... does not match any of the expected
	 * tags: 'disabled', 'enabled'`.
	 */
	disableAdaptiveThinking?: boolean;
	/** Whether tools may include Anthropic's per-tool eager_input_streaming flag. Default: true. */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether long prompt-cache retention (`ttl: "1h"`) is supported. Default: true for canonical Anthropic API. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether mid-conversation `role: "system"` messages are accepted in the
	 * `messages` array (Claude Opus 4.8+ and Claude Fable/Mythos 5 on the
	 * first-party Claude API and Claude Platform on AWS). When unset,
	 * auto-detected from the model id and base URL. Not available on Bedrock,
	 * Vertex AI, or Microsoft Foundry.
	 */
	supportsMidConversationSystem?: boolean;
	/**
	 * Whether the model accepts a forced `tool_choice` (`{ type: "any" }` or
	 * `{ type: "tool", name }`). Claude Fable/Mythos 5 reject forced tool use
	 * outright ("tool_choice forces tool use is not compatible with this model");
	 * the request builder downgrades forced choices to `auto` when this is false.
	 * When unset, auto-detected from the model id. Default: true.
	 */
	supportsForcedToolChoice?: boolean;
	/**
	 * Whether the model accepts sampling parameters (`temperature`, `top_p`,
	 * `top_k`). Opus 4.7+ and Fable/Mythos reject them with a 400. When unset,
	 * auto-detected from the model id. Default: true.
	 */
	supportsSamplingParams?: boolean;
	/**
	 * Include a non-standard `id` field (aliasing `tool_use_id`) on
	 * `tool_result` blocks. Z.AI's Anthropic-compatible proxy deserializes
	 * tool results into a class that reads `.id` (issue #814). Default:
	 * auto-detected (Z.AI hosts).
	 */
	requiresToolResultId?: boolean;
	/**
	 * Replay unsigned `thinking` blocks from prior assistant turns as native
	 * thinking instead of demoting them to text. Official Anthropic enforces
	 * signature-based thinking-chain integrity, so unsigned blocks must stay
	 * text there; compatible reasoning endpoints (Z.AI, DeepSeek, …) emit
	 * unsigned blocks and expect them back as `type: "thinking"` (#2005).
	 * Default: auto-detected from provider/baseUrl and `model.reasoning`.
	 */
	replayUnsignedThinking?: boolean;
	/**
	 * Prefix Anthropic built-in tool names (`web_search`, `code_execution`, ...)
	 * when they are ordinary client tools. Some Anthropic-compatible gateways
	 * intercept those exact names as server tools and return raw search/result
	 * blocks instead of normal `tool_use` calls.
	 */
	escapeBuiltinToolNames?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

/**
 * Fields whose meaning is identical across chat-completions and Responses surfaces.
 * Each builder still computes its own per-surface value when defaults diverge.
 */
export interface ResolvedOpenAISharedCompat {
	supportsDeveloperRole: boolean;
	supportsStrictMode: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortMap: Partial<Record<Effort, string>>;
	supportsReasoningParams: boolean;
	thinkingFormat: OpenAIReasoningFormat;
	reasoningDisableMode: OpenAIReasoningDisableMode;
	omitReasoningEffort: boolean;
	includeEncryptedReasoning: boolean;
	filterReasoningHistory: boolean;
	disableReasoningOnForcedToolChoice: boolean;
	disableReasoningOnToolChoice: boolean;
	supportsToolChoice: boolean;
	supportsForcedToolChoice: boolean;
	supportsNamedToolChoice: boolean;
	reasoningContentField?: OpenAICompat["reasoningContentField"];
	requiresReasoningContentForToolCalls: boolean;
	requiresReasoningContentForAllAssistantTurns: boolean;
	allowsSyntheticReasoningContentForToolCalls: boolean;
	replayReasoningContent: boolean;
	qwenPreserveThinking: boolean;
	requiresThinkingAsText: boolean;
	requiresMistralToolIds: boolean;
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresAssistantContentForToolCalls: boolean;
	stripDeepseekSpecialTokens: boolean;
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	reasoningDeltasMayBeCumulative: boolean;
	emptyLengthFinishIsContextError: boolean;
	usesOpenAIToolCallIdLimit: boolean;
	promptCacheSessionHeader?: OpenAICompat["promptCacheSessionHeader"];
	/** The model sits behind OpenRouter (routing prefs and max-token omission apply). */
	isOpenRouterHost: boolean;
	/** Whether this endpoint needs a max-token field even when caller did not set one. */
	alwaysSendMaxTokens: boolean;
	/** See {@link OpenAICompat.enableGeminiThinkingLoopGuard}. Set by the builder from the family classifier. */
	enableGeminiThinkingLoopGuard?: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	/** Provider-specific wire model-id transform applied to the base id. */
	wireModelIdMode: "raw" | "firepass" | "fireworks" | "openrouter";
}

/**
 * Fully-resolved chat-completions compat view: every detected default
 * materialized and user overrides applied. Built once per model by
 * `buildModel`; request handlers read fields and never detect, resolve, or
 * allocate.
 */
export type ResolvedOpenAICompat = ResolvedOpenAISharedCompat &
	Required<
		Omit<
			OpenAICompat,
			| "supportsDeveloperRole"
			| "supportsReasoningEffort"
			| "reasoningEffortMap"
			| "supportsReasoningParams"
			| "thinkingFormat"
			| "reasoningDisableMode"
			| "omitReasoningEffort"
			| "includeEncryptedReasoning"
			| "filterReasoningHistory"
			| "disableReasoningOnForcedToolChoice"
			| "disableReasoningOnToolChoice"
			| "supportsToolChoice"
			| "supportsForcedToolChoice"
			| "supportsNamedToolChoice"
			| "reasoningContentField"
			| "requiresReasoningContentForToolCalls"
			| "requiresReasoningContentForAllAssistantTurns"
			| "allowsSyntheticReasoningContentForToolCalls"
			| "replayReasoningContent"
			| "qwenPreserveThinking"
			| "requiresThinkingAsText"
			| "requiresMistralToolIds"
			| "requiresToolResultName"
			| "requiresAssistantAfterToolResult"
			| "requiresAssistantContentForToolCalls"
			| "stripDeepseekSpecialTokens"
			| "streamMarkupHealingPattern"
			| "reasoningDeltasMayBeCumulative"
			| "emptyLengthFinishIsContextError"
			| "usesOpenAIToolCallIdLimit"
			| "promptCacheSessionHeader"
			| "openRouterRouting"
			| "isOpenRouterHost"
			| "supportsStrictMode"
			| "supportsLongPromptCacheRetention"
			| "alwaysSendMaxTokens"
			| "wireModelIdMode"
			| "vercelGatewayRouting"
			| "extraBody"
			| "toolStrictMode"
			| "toolSchemaFlavor"
			| "streamIdleTimeoutMs"
			| "cacheControlFormat"
			| "thinkingKeep"
			| "strictResponsesPairing"
			| "supportsImageDetailOriginal"
			| "requiresJuiceZeroHack"
			| "enableGeminiThinkingLoopGuard"
			| "whenThinking"
		>
	> & {
		vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
		extraBody?: OpenAICompat["extraBody"];
		cacheControlFormat?: OpenAICompat["cacheControlFormat"];
		thinkingKeep?: OpenAICompat["thinkingKeep"];
		streamIdleTimeoutMs?: number;
		toolStrictMode: ResolvedToolStrictMode;
		toolSchemaFlavor?: OpenAICompat["toolSchemaFlavor"];
		/** The model sits behind Vercel AI Gateway. */
		isVercelGatewayHost: boolean;
		dropThinkingWhenReasoningEffort: boolean;
		/** Complete alternate view for thinking-engaged requests; swap pointers, never spread. */
		whenThinking?: ResolvedOpenAICompat;
	};

/** Fully-resolved Responses-API compat view (same contract as `ResolvedOpenAICompat`). */
export interface ResolvedOpenAIResponsesCompat extends ResolvedOpenAISharedCompat {
	supportsLongPromptCacheRetention: boolean;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	requiresJuiceZeroHack: boolean;
	supportsObfuscationOptOut: boolean;
	/** See {@link OpenAICompat.streamIdleTimeoutMs}. `0` disables the stream idle watchdog. */
	streamIdleTimeoutMs?: number;
}

/**
 * OpenRouter is a pseudo API: runtime dispatch can use either Responses
 * (default) or Chat Completions (`PI_OPENROUTER_RESPONSES=0`) with the same
 * model object, so its resolved compat must satisfy both handlers.
 */
export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

/** Compatibility settings for the devin-agent (Codeium Cascade) API. */
export interface DevinCompat {
	/**
	 * Cascade has no wire reasoning/effort field — effort is selected by routing
	 * to a sibling model id (the `thinking.effortRouting` baked by
	 * variant-collapse), so the thinking deriver must trust explicit routed
	 * metadata only and never fabricate an effort ladder from identity.
	 */
	trustExplicitThinkingOnly?: boolean;
}

/** Fully-resolved devin-agent compat view (same contract as `ResolvedOpenAICompat`). */
export type ResolvedDevinCompat = Required<DevinCompat>;

/** Fully-resolved anthropic-messages compat view (same contract as `ResolvedOpenAICompat`). */
export type ResolvedAnthropicCompat = Required<AnthropicCompat> & {
	/**
	 * The configured endpoint is the official first-party Anthropic API
	 * (https + exact `api.anthropic.com` host; a missing baseUrl counts as
	 * official because dispatch defaults there). Gates OAuth framing, custom
	 * env headers, and cache-TTL shaping without per-request URL parsing.
	 */
	officialEndpoint: boolean;
};

/** Sparse, user-authored compat overrides for a given API (models.json / config vocabulary). */
export type CompatConfigOf<TApi extends Api> = TApi extends
	| "openai-completions"
	| "openrouter"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	? OpenAICompat
	: TApi extends "anthropic-messages"
		? AnthropicCompat
		: TApi extends "devin-agent"
			? DevinCompat
			: undefined;

/** Resolved compat for a given API: complete record, materialized once by `buildModel`. */
export type CompatOf<TApi extends Api> = TApi extends "openrouter"
	? ResolvedOpenRouterCompat
	: TApi extends "openai-completions"
		? ResolvedOpenAICompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? ResolvedOpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? ResolvedAnthropicCompat
				: TApi extends "devin-agent"
					? ResolvedDevinCompat
					: undefined;

/**
 * Remote (server-side) context-compaction routing for a model. Authored by
 * bundled catalogs and models-config providers/model definitions; read by the
 * agent's remote-compaction path (e.g. OpenAI `POST /responses/compact`).
 * Provider-level config merges under model-level config (model wins).
 */
export interface RemoteCompactionConfig<TApi extends Api = Api> {
	/**
	 * Explicitly enable/disable remote compaction for this model. `undefined`
	 * falls back to provider defaults (first-party OpenAI/Codex opt in).
	 */
	enabled?: boolean;
	/** API surface handling the compaction request. Defaults to the model's own `api`. */
	api?: TApi;
	/** Explicit compaction endpoint URL. Defaults to a `/responses/compact` path derived from the model's baseUrl. */
	endpoint?: string;
	/** Model id to compact with. Defaults to the model's `requestModelId ?? id`. */
	model?: string;
}

// Model interface for the unified model system
export interface Model<TApi extends Api = Api> {
	id: string;
	/**
	 * Model id to send on the wire when it differs from `id`. Used by catalog
	 * variants that present one upstream model under several local entries —
	 * e.g. GitHub Copilot long-context variants (`claude-opus-4.7-1m` requests
	 * upstream `claude-opus-4.7`; the tier is a client-side context budget, not
	 * a served model id). Providers MUST serialize `requestModelId ?? id`;
	 * everything local (selection, caching, usage attribution) keys on `id`.
	 */
	requestModelId?: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/**
	 * Decoder family used for image inputs when it has narrower format support
	 * than OMP's general image pipeline. `stb` local backends reject WebP.
	 */
	imageInputDecoder?: "stb";
	/**
	 * Native provider tool-call support. `false` is the only unsupported signal:
	 * `true` and `undefined` both mean callers may use native tools. Catalog and
	 * discovery sources should set this sparsely when an upstream explicitly
	 * reports that native tool calling is unsupported.
	 */
	supportsTools?: boolean;
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	/** Premium Copilot requests charged per user-initiated request (defaults to 1). */
	premiumMultiplier?: number;
	contextWindow: number | null;
	maxTokens: number | null;
	/**
	 * When `true`, providers MUST omit `max_output_tokens` (Responses) /
	 * `max_tokens` / `max_completion_tokens` (Completions) from the outbound
	 * request and let the upstream API decide the per-response cap. `maxTokens`
	 * is still used locally for budgeting (compaction, context promotion); only
	 * the wire field is suppressed.
	 *
	 * Use this for proxies (notably Ollama) that forward to a backend whose true
	 * output limit OMP cannot discover — sending the wrong value triggers 400s
	 * from the upstream provider.
	 */
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	/**
	 * Streaming transport override. When `"pi-native"`, `streamSimple` routes
	 * the request to the model's `baseUrl` via the auth-gateway's
	 * `POST /v1/pi/stream` endpoint instead of dispatching the per-API
	 * provider client. The `baseUrl` must point at an `omp auth-gateway`
	 * (or compatible) host; `headers.Authorization` (or `apiKey` resolved by
	 * the registry) carries the gateway bearer.
	 *
	 * Used by containerized omp installs (e.g. robomp slots) to route every
	 * LLM call through a sidecar gateway that holds the real provider
	 * credentials. The model's other metadata (pricing, context window,
	 * thinking config, …) still resolves locally; only the streaming
	 * dispatch is redirected.
	 */
	transport?: "pi-native";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/** Preferred model to switch to when context promotion is triggered (model id or provider/id). */
	contextPromotionTarget?: string;
	/** Preferred model (model id or provider/id) to run compaction/summarization with, instead of this model itself. */
	compactionModel?: string;
	/** Remote (server-side) compaction routing; see {@link RemoteCompactionConfig}. */
	remoteCompaction?: RemoteCompactionConfig<Api>;
	/** Provider-assigned priority value (lower = higher priority). */
	priority?: number;
	/**
	 * GitLab Duo Agent Platform only: the root namespace GID/id the model list
	 * was resolved against. Stamped by credentialed runtime discovery so request
	 * paths can distinguish namespace-scoped rows; the bundled namespace-free
	 * fallback model never carries it.
	 */
	gitlabDuoWorkflowRootNamespaceId?: string;
	/** Canonical thinking capability metadata for this model. */
	thinking?: ThinkingConfig;
	/**
	 * Fully-resolved compatibility record, materialized once by `buildModel`.
	 * Protocol handlers read fields; they never detect, resolve, or allocate.
	 */
	compat: CompatOf<TApi>;
	/** Verbatim sparse compat from the spec (user/config intent), for introspection only. */
	compatConfig?: CompatConfigOf<TApi>;
	/**
	 * Which shape to use when exposing the Codex `apply_patch` tool to this model.
	 * Generated catalog policy sets `"freeform"` for first-party GPT-5 Responses
	 * models that support OpenAI custom tools with a Lark grammar. The freeform
	 * variant sends a raw patch string with no JSON envelope.
	 * - `"function"` or undefined: JSON function-tool with `{input: string}` (spec §1.2).
	 */
	applyPatchToolType?: "freeform" | "function";
	/**
	 * Force OAuth-style request shaping for providers whose API key prefix doesn't
	 * match an OAuth token (e.g. routing Anthropic traffic through a proxy that
	 * expects Claude Code framing). When true, the streaming layer sets
	 * `options.isOAuth = true` for the underlying provider call.
	 */
	isOAuth?: boolean;
}

/**
 * A model as authored by configs, bundled catalogs, and discovery — the input
 * vocabulary of `buildModel`. Identical to `Model` except `compat` carries the
 * sparse override shape and nothing is resolved yet.
 */
export interface ModelSpec<TApi extends Api = Api> extends Omit<Model<TApi>, "compat" | "compatConfig"> {
	/** Sparse compatibility overrides; resolved into `Model.compat` by `buildModel`. */
	compat?: CompatConfigOf<TApi>;
}
