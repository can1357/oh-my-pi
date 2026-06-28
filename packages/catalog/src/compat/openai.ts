/**
 * OpenAI-API compat builders — chat-completions and Responses flavors.
 *
 * `buildOpenAICompat`/`buildOpenAIResponsesCompat` run exactly once per model
 * (from `buildModel`): detection writes a fresh record, sparse spec overrides
 * are assigned onto it in place, and conditional policies are materialized as
 * complete alternate views. Request handlers read `model.compat` fields and
 * never detect, resolve, or allocate.
 */
import { isFireworksFastModelId } from "../fireworks-model-id";
import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import {
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGlm52ReasoningEffortModelId,
	isGrokReasoningEffortCapable,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isQwenModelId,
	modelFamilyToken,
} from "../identity/family";
import type {
	ModelSpec,
	OpenAICompat,
	OpenAIStreamMarkupHealingPattern,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	ResolvedOpenRouterCompat,
} from "../types";
import { applyCompatOverrides } from "./apply";

/** GLM coding-plan SKUs idle for minutes mid-reasoning; see `streamIdleTimeoutMs`. */
const GLM_CODING_PLAN_MODEL_PATTERN = /^glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** Direct DeepSeek reasoning models stall between thinking and answer phases. */
const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Kimi K2.6 can spend several minutes reasoning before the first visible token. */
const KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Xiaomi MiMo Pro on api.xiaomimimo.com can stall ~2min before the first event (issue #1770). */
const XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Alibaba Coding Plan (coding-intl.dashscope) qwen models idle before the first event (issue #1770). */
const ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const MINIMAX_PROVIDER_OR_ID_PATTERN = /minimax/i;
const DSML_HEALING_PROVIDERS = new Set([
	"ollama",
	"ollama-cloud",
	"nvidia",
	"deepseek",
	"fireworks",
	"nanogpt",
	"opencode-go",
	"openrouter",
]);

/**
 * Ollama's OpenAI-compatible `reasoning.effort` only accepts
 * `high|medium|low|max|none`; OMP's `minimal`/`xhigh` levels make the server
 * reject the turn with HTTP 400 `invalid reasoning value`. Map the two
 * unsupported levels onto the closest accepted ones. Stamped in the compat
 * builder (not only at discovery) so stale-cached and custom `ollama`-provider
 * specs are backfilled on every `buildModel`, not just on a fresh
 * `omp models refresh`. Custom OpenAI-compatible providers pointed at a local
 * Ollama port under a different provider id are not covered — they must set
 * `compat.reasoningEffortMap` themselves.
 */
const OLLAMA_REASONING_EFFORT_MAP: ResolvedOpenAISharedCompat["reasoningEffortMap"] = { minimal: "low", xhigh: "max" };

/**
 * Merge the Ollama default effort map under any explicit overrides (overrides
 * win). No-op off the local `ollama` provider or for non-reasoning models.
 */
function mergeOllamaReasoningEffortMap(
	compat: ResolvedOpenAISharedCompat,
	provider: string,
	reasoning: boolean | undefined,
): void {
	if (provider !== "ollama" || !reasoning) return;
	compat.reasoningEffortMap = { ...OLLAMA_REASONING_EFFORT_MAP, ...compat.reasoningEffortMap };
}

function resolveReasoningDisableMode(
	thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"],
): ResolvedOpenAISharedCompat["reasoningDisableMode"] {
	switch (thinkingFormat) {
		case "openrouter":
			return "openrouter-enabled-false";
		case "zai":
			return "zai-thinking-disabled";
		case "qwen":
			return "qwen-enable-thinking-false";
		case "qwen-chat-template":
			return "qwen-template-false";
		default:
			return "lowest-effort";
	}
}

function detectStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
): OpenAIStreamMarkupHealingPattern | undefined {
	if (MINIMAX_PROVIDER_OR_ID_PATTERN.test(provider) || MINIMAX_PROVIDER_OR_ID_PATTERN.test(modelId)) {
		return "thinking";
	}
	if (provider === "kimi-code" || provider === "moonshot" || /kimi[-/_.]?k2/i.test(modelId)) {
		return "kimi";
	}
	if (isDeepseekModelIdOrName(modelId) && DSML_HEALING_PROVIDERS.has(provider)) {
		return "dsml";
	}
	return undefined;
}

/**
 * OpenCode's gateways (https://opencode.ai/zen|go) gate `reasoning_content`
 * on the request's thinking state for every model they front (Kimi K2.x,
 * DeepSeek V4, GLM-5.x, Qwen3.x, MiMo, MiniMax, …): they 400 with `Extra
 * inputs are not permitted` when thinking is off but the field is supplied
 * (#1071), and 400 with `thinking is enabled but reasoning_content is missing
 * in assistant tool call message at index N` (#1484) when thinking is on and
 * the field is absent. The base compat therefore leaves the replay off, and
 * this `whenThinking` policy reactivates it for thinking-engaged requests.
 * `allowsSyntheticReasoningContentForToolCalls` is forced to `false` on the
 * same path: the gateway specifically requires `reasoning_content`, and the
 * synthetic-friendly default would echo whichever field the upstream streamed
 * (e.g. `reasoning` for many opencode turns), landing the replay in the wrong
 * key and re-triggering the 400.
 */
const OPENCODE_WHEN_THINKING: NonNullable<OpenAICompat["whenThinking"]> = {
	requiresReasoningContentForToolCalls: true,
	allowsSyntheticReasoningContentForToolCalls: false,
	reasoningContentField: "reasoning_content",
};

const MIMO_REASONING_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	xhigh: "high",
};

function mergeMimoReasoningEffortMap(compat: ResolvedOpenAISharedCompat, enabled: boolean): void {
	if (!enabled) return;
	compat.reasoningEffortMap = { ...MIMO_REASONING_EFFORT_MAP, ...compat.reasoningEffortMap };
}

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (
		provider === "openai" ||
		provider === "openrouter" ||
		provider === "cerebras" ||
		provider === "together" ||
		provider === "github-copilot" ||
		provider === "zenmux"
	) {
		return true;
	}
	return (
		hostMatchesUrl(baseUrl, "openai") ||
		hostMatchesUrl(baseUrl, "azureOpenAI") ||
		hostMatchesUrl(baseUrl, "cerebras") ||
		hostMatchesUrl(baseUrl, "together") ||
		hostMatchesUrl(baseUrl, "openrouter") ||
		hostMatchesUrl(baseUrl, "deepseekFamily")
	);
}

/**
 * Local OpenAI-compatible inference servers whose chat templates re-tokenize
 * the entire prompt every request — llama.cpp prefix-KV-cache reuse only
 * survives when the rendered tokens stay byte-identical across turns. The
 * runtime auto-enables {@link OpenAICompat.replayReasoningContent} for these
 * providers (and for any provider pointed at a loopback / RFC1918 baseUrl) so
 * Qwen3 / DeepSeek-R1 / GLM templates can reconstruct the prior assistant
 * turn's `<think>` block from `reasoning_content` (#3528).
 */
const LOCAL_OPENAI_COMPAT_PROVIDERS = new Set(["llama.cpp", "lm-studio", "vllm", "ollama"]);

/**
 * Local proxy providers that share the loopback-default baseUrl but forward
 * to an unrelated upstream (OpenAI, Anthropic, …) rather than running a
 * chat-template renderer themselves — `replayReasoningContent` would push
 * `reasoning_content` to the upstream, which gains no KV-cache benefit and
 * may 400 on the extra field. Excluded from BOTH the provider check above
 * and the loopback heuristic below; users who want the replay on a custom
 * proxy setup can opt in via the sparse `compat.replayReasoningContent`
 * override.
 */
const PROXY_OPENAI_COMPAT_PROVIDERS = new Set(["litellm"]);

function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	return false;
}

/**
 * Build the resolved chat-completions compat record for a model spec.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 */
export function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };

	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const supportsZaiReasoningEffort = (isZai || isZhipu) && isGlm52ReasoningEffortModelId(spec.id);
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isKimiModel = isKimiModelId(spec.id);
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isMoonshotKimi = isKimiModel && isMoonshotNative;
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && isKimiK26ModelId(spec.id);
	const isAnthropicModel =
		modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(spec.id) || isAnthropicNamespacedModelId(spec.id);
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isNvidiaNim = modelMatchesHost(hostModel, "nvidia");
	const isQwen = isQwenModelId(spec.id);
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `spec.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isXiaomiMimo = isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	const isMimoReasoningEffortModel =
		!isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	// OpenCode Zen's `big-pickle` is a DeepSeek reasoning alias; the upstream
	// 400s come from DeepSeek and require exact reasoning_content replay.
	const isOpenCodeDeepseekAlias =
		provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias;
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekFamily && Boolean(spec.reasoning);
	const isGrok = modelMatchesHost(hostModel, "xai");
	const isMistral = modelMatchesHost(hostModel, "mistral");
	const isOpenCodeHost = modelMatchesHost(hostModel, "opencode");
	const isNonStandard =
		isCerebras ||
		isGrok ||
		isMistral ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "deepseekFamily") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isAlibaba ||
		isZai ||
		isZhipu ||
		isKilo ||
		isQwen ||
		isXiaomiHost ||
		isMoonshotNative ||
		isOpenCodeHost;
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";

	const useMaxTokens =
		isMistral ||
		isMoonshotNative ||
		isZai ||
		isZhipu ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isDirectDeepseekApi;

	// Hosts whose chat-completions endpoints are known to accept multiple
	// leading `system`/`developer` messages (preferred for KV-cache reuse).
	// Anything outside this allowlist defaults to coalescing because
	// strict chat templates (Qwen 3.5+ via vLLM, MiniMax, etc.) reject
	// follow-up system messages with a 400.
	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
	const isTogether = modelMatchesHost(hostModel, "together");
	const isFireworks = hostMatchesUrl(baseUrl, "fireworks");
	const isGroqHost = modelMatchesHost(hostModel, "groq");
	const isCopilotHost = provider === "github-copilot";
	const isZenmuxHost = provider === "zenmux";
	// Endpoints/models that MUST receive a single system block. MiniMax's OpenAI
	// endpoint returns error 2013 on multiple system messages; the Qwen 3.5+ chat
	// template raises "System message must be at the beginning" / 500s with an
	// internal_server_error when any system block appears past index 0. That
	// template ships with the weights, so every Qwen-serving vLLM/SGLang host
	// hits it — confirmed on Alibaba Dashscope, Qwen Portal, and Fireworks
	// (`fireworks/qwen3.7-plus` 500'd on two leading system blocks). Gate on the
	// Qwen family itself, not per-host: coalescing only trades away KV-cache reuse.
	const isMiniMaxHost = modelMatchesHost(hostModel, "minimax");
	const isQwenPortal = modelMatchesHost(hostModel, "qwenPortal");
	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		!isQwen &&
		(isOpenAIHost ||
			isAzureHost ||
			isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			isZai ||
			isZhipu ||
			isCopilotHost ||
			isZenmuxHost);

	// Stream-watchdog floor: GLM coding-plan SKUs, Kimi K2.6, and direct
	// DeepSeek reasoning models can idle for minutes while reasoning; widen the
	// idle timeout so warm-ups stop aborting and retrying.
	const streamIdleTimeoutMs =
		GLM_CODING_PLAN_MODEL_PATTERN.test(spec.id) && (isZai || isZhipu)
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: provider === "alibaba-coding-plan"
				? ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
				: isXiaomiMimo
					? XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS
					: spec.reasoning && isKimiK26ModelId(spec.id)
						? KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS
						: spec.reasoning && isDirectDeepseekApi
							? DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS
							: undefined;

	// Fireworks "Fast" variants (`<id>-fast`) are served from the router
	// namespace (`accounts/fireworks/routers/<id>-fast`), like Fire Pass, rather
	// than the `models/` namespace the rest of the `fireworks` provider uses.
	const isFireworksFastRouter = provider === "fireworks" && isFireworksFastModelId(spec.id);
	const wireModelIdMode: ResolvedOpenAISharedCompat["wireModelIdMode"] =
		provider === "firepass" || isFireworksFastRouter
			? "firepass"
			: provider === "fireworks"
				? "fireworks"
				: isOpenRouter
					? "openrouter"
					: "raw";
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] =
		isZai || isZhipu || isMoonshotKimi || isXiaomiMimo
			? "zai"
			: isOpenRouter
				? "openrouter"
				: isQwen && isNvidiaNim
					? "qwen-chat-template"
					: isQwen && isFireworks
						? "openai"
						: isAlibaba || isQwen
							? "qwen"
							: "openai";

	const compat: ResolvedOpenAICompat = {
		supportsStore: !isNonStandard,
		// `developer` is an OpenAI-Responses-era extension to the chat-completions schema. Almost
		// every OpenAI-compatible host other than OpenAI itself (and Azure OpenAI, which mirrors
		// the schema exactly) treats it as an unknown role: Moonshot returns a 400 "tokenization
		// failed", Groq/Cerebras/etc. error or silently misroute. Default to `system` and require
		// callers to opt in via `compat.supportsDeveloperRole: true` for hosts known to mirror
		// OpenAI's reasoning-API surface.
		supportsDeveloperRole: isOpenAIHost || isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort: !isGrok && !isXiaomiMimo && (!(isZai || isZhipu) || supportsZaiReasoningEffort),
		// GitHub Copilot's chat-completions endpoint rejects reasoning params wholesale.
		supportsReasoningParams: provider !== "github-copilot",
		reasoningEffortMap: isMimoReasoningEffortModel ? MIMO_REASONING_EFFORT_MAP : {},
		supportsUsageInStreaming: !isCerebras,
		// pi-ai's thinking-loop guard is gemini-only; default the flag from the
		// family classifier so OpenAI-compat proxies serving Gemini are covered.
		// An opaque alias can opt in via `compat.enableGeminiThinkingLoopGuard`.
		enableGeminiThinkingLoopGuard: modelFamilyToken(spec.id) === "gemini",
		// Kimi (including via OpenRouter and Fireworks router-form IDs such as
		// `accounts/fireworks/routers/kimi-*`) calculates TPM rate limits based on
		// max_tokens, not actual output. The official Kimi K2 model guidance
		// (https://docs.fireworks.ai/models/kimi-k2) also requires `max_tokens` for
		// every call since the family can otherwise emit very long reasoning traces
		// before the final answer.
		alwaysSendMaxTokens: isKimiModel,
		disableReasoningOnForcedToolChoice: isKimiModel || isAnthropicModel,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(spec.reasoning) && !isOpenRouter,
		supportsToolChoice: !isDirectDeepseekReasoning,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: provider !== "llama.cpp",
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: isMistral,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		// Only Kimi's native hosts (Moonshot / Kimi-code, matched by `isMoonshotKimi`)
		// speak the z.ai binary `thinking: { type }` field. Kimi reached through
		// OpenAI-compatible proxies — Fireworks' Fire Pass router, OpenCode's gateway,
		// etc. — drives reasoning via OpenAI-style `reasoning_effort`
		// (low|medium|high|xhigh|max|none), so those stay on the "openai" path.
		// NVIDIA NIM hosts Qwen with the vLLM convention
		// (`chat_template_kwargs.enable_thinking`); top-level `enable_thinking`
		// is rejected by NIM's `additionalProperties: false` request schema
		// (issue #2299).
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: isOpenRouter && isAnthropicModel,
		thinkingKeep: usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: "reasoning_content",
		// Backends that 400 follow-up requests when prior assistant tool-call turns lack `reasoning_content`:
		//   - Kimi: documented invariant on its native API.
		//   - DeepSeek-family reasoning models, including aliased OpenCode Zen models
		//     like `big-pickle`, validate exact thinking-mode replay.
		//   - Xiaomi MiMo models require exact `reasoning_content` replay on
		//     thinking-mode tool-call continuations across standard and Token Plan hosts.
		//   - Any reasoning-capable model reached through OpenRouter can enforce this
		//     server-side whenever the request is in thinking mode. We can't translate
		//     Anthropic's redacted/encrypted reasoning into provider-native plaintext,
		//     so cross-provider continuations rely on a placeholder.
		// OpenCode Kimi aliases handle reasoning content internally and reject
		// client-sent `reasoning_content`, so exclude only that Kimi-on-OpenCode path
		// (the `whenThinking` policy below re-enables the replay for thinking turns).
		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(spec.reasoning)) ||
			isXiaomiMimo ||
			(isOpenRouter && Boolean(spec.reasoning)),
		requiresReasoningContentForAllAssistantTurns:
			((isDeepseekFamily && Boolean(spec.reasoning)) || isXiaomiMimo) && !isOpenRouter,
		// DeepSeek V4 and Xiaomi MiMo reject synthetic reasoning_content placeholders (".") on tool-call turns.
		// Kimi and OpenRouter accept them when actual reasoning is unavailable.
		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !spec.reasoning) && !isXiaomiMimo,
		// Local llama.cpp-style servers re-tokenize the entire chat-template
		// prompt each request; Qwen3 / DeepSeek-R1 / GLM templates reconstruct
		// the prior assistant turn's `<think>` block from `reasoning_content`,
		// so dropping the field re-renders the assistant turn without thinking
		// content and forces full prompt re-processing (#3528). The
		// `requires*ReasoningContent*` flags above stay off for these hosts —
		// they accept but don't validate the field — so the encoder needs a
		// distinct opt-in to replay on every reasoning turn. NOT gated on
		// `spec.reasoning`: the runtime discovery paths for `llama.cpp` /
		// `lm-studio` / `openai-models-list` hardcode `reasoning: false`
		// because the upstream `/models` endpoints don't advertise the
		// capability, but the OpenAI stream parser still records incoming
		// `reasoning_content` deltas as thinking blocks. Gating on the spec
		// flag would leave every discovered local Qwen / DeepSeek model
		// re-triggering #3528. The encoder only writes `reasoning_content`
		// when a thinking block actually exists on the turn
		// (`nonEmptyThinkingBlocks.length > 0`), so the flag is a no-op on
		// pure-text histories.
		replayReasoningContent:
			!PROXY_OPENAI_COMPAT_PROVIDERS.has(provider) &&
			(LOCAL_OPENAI_COMPAT_PROVIDERS.has(provider) || hasLocalLoopbackBaseUrl(baseUrl)),
		// `preserve_thinking: true` makes the Qwen3.6+ chat template render
		// `<think>...</think>` for older assistant turns too, instead of
		// stripping it the moment a new user message moves them past
		// `last_query_index`. Without it, the slot's KV cache (which holds the
		// raw `<think>X</think>` tokens emitted during generation) diverges
		// from the next-turn render and llama.cpp falls back to full prompt
		// re-processing — the exact symptom reported in #3541. Auto-enabled
		// for Qwen thinking dialects on local llama.cpp-style backends (paired
		// with `replayReasoningContent` above). Non-Qwen templates ignore the
		// parameter, so the flag stays a no-op outside the Qwen path.
		qwenPreserveThinking:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") &&
			!PROXY_OPENAI_COMPAT_PROVIDERS.has(provider) &&
			(LOCAL_OPENAI_COMPAT_PROVIDERS.has(provider) || hasLocalLoopbackBaseUrl(baseUrl)),
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		cacheControlFormat: isOpenRouter && spec.id.startsWith("anthropic/") ? "anthropic" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		wireModelIdMode,
		isVercelGatewayHost: isVercelGateway,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
		toolSchemaFlavor: isMoonshotNative ? "moonshot-mfjs" : undefined,
		streamIdleTimeoutMs,
		stripDeepseekSpecialTokens:
			isDeepseekModelIdOrName(spec.id) && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, spec.id),
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(provider) || MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.id),
		emptyLengthFinishIsContextError: provider === "ollama",
		usesOpenAIToolCallIdLimit: provider === "openai",
		promptCacheSessionHeader: undefined,
		dropThinkingWhenReasoningEffort: provider === "fireworks",
	};

	applyCompatOverrides(compat, spec.compat);
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
	mergeOllamaReasoningEffortMap(compat, provider, spec.reasoning);
	mergeMimoReasoningEffortMap(compat, isMimoReasoningEffortModel);

	const whenThinkingPolicy =
		spec.compat?.whenThinking ?? (isOpenCodeProvider && spec.reasoning ? OPENCODE_WHEN_THINKING : undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat };
		applyCompatOverrides(variant, whenThinkingPolicy);
		if (whenThinkingPolicy.reasoningDisableMode === undefined) {
			variant.reasoningDisableMode = resolveReasoningDisableMode(variant.thinkingFormat);
		}
		if (whenThinkingPolicy.omitReasoningEffort === undefined && !variant.supportsReasoningEffort) {
			variant.omitReasoningEffort = true;
		}
		mergeOllamaReasoningEffortMap(variant, provider, spec.reasoning);
		mergeMimoReasoningEffortMap(variant, isMimoReasoningEffortModel);
		compat.whenThinking = variant;
	}

	return compat;
}

interface OpenAIResponsesSpecLike {
	id?: string;
	provider: string;
	name: string;
	baseUrl: string;
	reasoning?: boolean;
	compat?: OpenAICompat;
}

/**
 * Build the resolved Responses-API compat record. The Responses flavor
 * deliberately differs from chat-completions: GitHub Copilot's responses
 * endpoint accepts the `developer` role, while strict tool mode is scoped to
 * first-party OpenAI/Azure/Copilot providers. Azure is detected by provider id
 * as well as URL — bundled `azure` models carry no baseUrl (the deployment host
 * is per-resource, resolved at runtime) — while OpenAI/Copilot developer-role
 * and prompt-cache detection stay URL-keyed, as the historical call sites were.
 * The GPT-5 juice-zero hack keys on the model name, matching the historical
 * request-time check.
 */
export function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const isAzure = modelMatchesHost({ provider: spec.provider, baseUrl }, "azureOpenAI");
	const isOpenRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "openrouter");
	const isOpenAIUrl = hostMatchesUrl(baseUrl, "openai");
	const id = spec.id ?? "";
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] = isOpenRouter ? "openrouter" : "openai";
	const isKimiModel = id ? isKimiModelId(id) : false;
	const isAnthropicModel = id ? isClaudeModelId(id) || isAnthropicNamespacedModelId(id) : false;
	const isDeepseekFamily = id ? isDeepseekModelIdOrName(id) || isDeepseekModelIdOrName(spec.name) : false;
	const reasoningCapable = Boolean(spec.reasoning);

	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole: isAzure || isOpenAIUrl || hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode:
			spec.provider === "openai" || isAzure || spec.provider === "github-copilot" || isOpenRouter || isOpenAIUrl,
		supportsReasoningEffort: spec.provider !== "xai-oauth" || isGrokReasoningEffortCapable(id),
		supportsLongPromptCacheRetention: isOpenAIUrl,
		// Azure OpenAI and GitHub Copilot Responses paths require tool results
		// to strictly match prior tool calls when building Responses inputs.
		strictResponsesPairing: isAzure || spec.provider === "github-copilot",
		// GitHub Copilot's Responses endpoint rejects the `detail: "original"`
		// image hint with a 400; every other host preserves native-resolution
		// frames (snapcompact relies on `original`). Detect Copilot by provider id
		// or base-URL host (mirroring the Anthropic compat builder) so a model
		// pointed at the Copilot host under a different provider id still clamps.
		supportsImageDetailOriginal: !modelMatchesHost({ provider: spec.provider, baseUrl }, "githubCopilot"),
		requiresJuiceZeroHack: spec.name.toLowerCase().startsWith("gpt-5"),
		reasoningEffortMap: {},
		supportsReasoningParams: true,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: spec.provider !== "xai-oauth",
		filterReasoningHistory: spec.provider === "xai-oauth" || (isOpenRouter && isAnthropicModel),
		disableReasoningOnForcedToolChoice: isKimiModel,
		disableReasoningOnToolChoice: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		supportsToolChoice: true,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(isKimiModel || (isDeepseekFamily && reasoningCapable) || (isOpenRouter && reasoningCapable)) &&
			reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !reasoningCapable,
		// The Responses API replays reasoning through encrypted `summary` items,
		// not via a top-level `reasoning_content` field — this flag is
		// chat-completions-only.
		replayReasoningContent: false,
		// Responses-only; the Qwen `preserve_thinking` template knob lives on
		// the chat-completions wire shape, never on Responses.
		qwenPreserveThinking: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: isKimiModel,
		openRouterRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		wireModelIdMode: isOpenRouter ? "openrouter" : "raw",
		alwaysSendMaxTokens: spec.id ? isKimiModelId(spec.id) : false,
		enableGeminiThinkingLoopGuard: modelFamilyToken(spec.id ?? "") === "gemini",
		supportsObfuscationOptOut: isOpenAIUrl || spec.provider === "openai",
		stripDeepseekSpecialTokens:
			Boolean(id) && isDeepseekModelIdOrName(id) && (spec.provider === "nvidia" || spec.provider === "deepseek"),
		streamMarkupHealingPattern: id ? detectStreamMarkupHealingPattern(spec.provider, id) : undefined,
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.provider) || (id ? MINIMAX_PROVIDER_OR_ID_PATTERN.test(id) : false),
		emptyLengthFinishIsContextError: spec.provider === "ollama",
		usesOpenAIToolCallIdLimit: spec.provider === "openai",
		promptCacheSessionHeader: spec.provider === "xai-oauth" ? "x-grok-conv-id" : undefined,
		streamIdleTimeoutMs: spec.compat?.streamIdleTimeoutMs,
	};
	applyCompatOverrides(compat, spec.compat);
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
	mergeOllamaReasoningEffortMap(compat, spec.provider, spec.reasoning);
	return compat;
}

type ResponsesOnlyCompat = Omit<ResolvedOpenAIResponsesCompat, keyof ResolvedOpenAISharedCompat>;

function pickResponsesOnly(compat: ResolvedOpenAIResponsesCompat): ResponsesOnlyCompat {
	return {
		supportsLongPromptCacheRetention: compat.supportsLongPromptCacheRetention,
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		requiresJuiceZeroHack: compat.requiresJuiceZeroHack,
		supportsObfuscationOptOut: compat.supportsObfuscationOptOut,
	} satisfies ResponsesOnlyCompat;
}

export function buildOpenRouterCompat(spec: ModelSpec<"openrouter">): ResolvedOpenRouterCompat {
	const chat = buildOpenAICompat({
		...spec,
		api: "openai-completions",
	} as ModelSpec<"openai-completions">);
	const responses = buildOpenAIResponsesCompat(spec);
	return { ...chat, ...pickResponsesOnly(responses) } as ResolvedOpenRouterCompat;
}
