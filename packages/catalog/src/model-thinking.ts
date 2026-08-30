/**
 * Thinking metadata: build-time derivation and runtime field-read helpers.
 *
 * Derivation (`resolveModelThinking`) runs exactly once per model — from
 * `buildModel` for dynamic specs and from the catalog generator for bundled
 * entries. Everything below the "runtime helpers" divider reads baked fields
 * only: no id parsing, no host matching, no compat detection per request.
 */
import { Effort, THINKING_EFFORTS } from "./effort";
import { modelMatchesHost } from "./hosts";
import {
	type AnthropicModel,
	bareModelId,
	type GeminiModel,
	isAnthropicAdaptiveGenAtLeast,
	type OpenAIModel,
	type ParsedModel,
	parseAnthropicModel,
	parseKnownModel,
	parseOpenAIModel,
	semverEqual,
	semverGte,
} from "./identity/classify";
import {
	findThinkingVariantToken,
	isDeepseekModelIdOrName,
	isDeepseekV4FlashModelId,
	isGlm52ReasoningEffortModelId,
	isGlm53ReasoningEffortModelId,
	isGrokXHighEffortCapable,
	isKimiK3ModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isOpenAIGptOssModelId,
	isQwenModelId,
	supportsAdaptiveThinkingDisplay,
} from "./identity/family";
import type {
	Api,
	CompatOf,
	Model,
	ModelSpec,
	ResolvedDevinCompat,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ThinkingConfig,
} from "./types";

/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];
const GEMINI_3_PRO_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];
const GEMINI_3_FLASH_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GPT_5_2_PLUS_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
const GPT_5_1_CODEX_MINI_EFFORTS: readonly Effort[] = [Effort.Medium, Effort.High];
const LOW_MEDIUM_HIGH_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High];
/** Wire-exact `low`/`high`/`max` scale used by Kimi K3 and DeepSeek V4 (Flash and Pro, direct API and aggregators). */
const LOW_HIGH_MAX_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High, Effort.Max];
/** Wire-exact two-tier scale (`high`/`max`): GLM-5.2 on Z.ai/Umans/Ollama Cloud/Baseten, Sakana Fugu, older DeepSeek reasoners (V3.x/R1). */
const HIGH_MAX_REASONING_EFFORTS: readonly Effort[] = [Effort.High, Effort.Max];
/** OpenRouter's DeepSeek route accepts only `high`. */
const HIGH_ONLY_REASONING_EFFORTS: readonly Effort[] = [Effort.High];
/**
 * Qwen 3.8+ open-weight chat template: prompt-steered `reasoning_effort`
 * kwarg with exactly three wire tiers (template default is `xhigh`).
 */
const QWEN38_TEMPLATE_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.XHigh];
/**
 * Five wire tiers with a `low` floor: GPT-5.6+, Anthropic adaptive models
 * with the real xhigh tier (Opus 4.7+, Sonnet 5+, Fable/Mythos 5), and the
 * Fire Pass Kimi router (distinct xhigh and max budgets).
 */
const FIVE_TIER_EFFORTS_LOW_TO_MAX: readonly Effort[] = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];
/** Legacy adaptive scale (Opus/Sonnet 4.6, every Bedrock adaptive model): four wire tiers, no xhigh. */
const FOUR_TIER_EFFORTS_LOW_TO_MAX: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
/** GLM-5.2 resellers that pass the default lower tiers verbatim and expose the genuine `max` top tier. */
const DEFAULT_REASONING_EFFORTS_WITH_MAX: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.Max,
];
/** Local Ollama wire vocabulary (`low`/`medium`/`high`/`max`; `none` is thinking-off). */
const OLLAMA_REASONING_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
type EffortMap = Partial<Record<Effort, string>>;

const GROQ_QWEN3_32B_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "default",
	[Effort.Low]: "default",
	[Effort.Medium]: "default",
	[Effort.High]: "default",
	[Effort.XHigh]: "default",
};
const FIREWORKS_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "none",
};
const MIMO_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "low",
	[Effort.XHigh]: "high",
};

const MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Low]: "adaptive",
	[Effort.Medium]: "adaptive",
	[Effort.High]: "adaptive",
};

// ---------------------------------------------------------------------------
// Build-time derivation (buildModel + catalog generator only)
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical thinking metadata for a spec. Called exactly once per
 * model by `buildModel`, after compat resolution.
 *
 * - Non-reasoning models never carry thinking.
 * - Models that reason natively but reject the wire effort param
 *   (`compat.supportsReasoningEffort: false` on openai-responses*) carry no
 *   thinking either: `reasoning: true, thinking: undefined` IS the encoding
 *   for "thinks, but exposes no control surface".
 * - Explicit spec thinking (generator-baked or user-authored) owns the
 *   capability surface (`mode`, `efforts`, `defaultLevel`); the wire facts
 *   (`effortMap`, `supportsDisplay`) are backfilled from identity when not
 *   explicitly set, so configs never need to know provider wire tier tables.
 * - Sparse specs go through full inference.
 */
export function resolveModelThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	if (!spec.reasoning) return undefined;
	if (spec.provider === "cline-pass" && (compat as ResolvedOpenAICompat).supportsReasoningEffort === false) {
		return undefined;
	}
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	if (spec.thinking && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0) {
		return fillThinkingWireDefaults(spec, compat, spec.thinking);
	}
	// Cascade selects effort only by routing to a sibling model id, so a Devin
	// model with no explicit routed thinking has no controllable surface —
	// never fabricate an effort ladder from identity.
	if ((compat as ResolvedDevinCompat | undefined)?.trustExplicitThinkingOnly === true) return undefined;
	// Empty/malformed explicit metadata is treated as absent — infer instead.
	return deriveThinking(spec, compat);
}

/**
 * Backfill identity-derived wire facts onto explicit thinking metadata.
 * Explicit `effortMap` / `supportsDisplay` (including `false`) win, except
 * when the model-defined effort ladder disagrees with the cached surface:
 * then both the ladder AND the wire map are re-derived from identity, so
 * stale cached metadata from before a wire-truth change (e.g. the retired
 * shifted five-tier maps) cannot survive normalization.
 */
function fillThinkingWireDefaults<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const normalizedEfforts =
		spec.provider === "cline-pass" ? thinking.efforts : (getModelDefinedEfforts(spec, compat) ?? thinking.efforts);
	const effortsChanged = !sameEffortList(normalizedEfforts, thinking.efforts);
	const effortMap =
		thinking.effortMap === undefined || effortsChanged
			? inferEffortMap(spec, compat, thinking.mode, normalizedEfforts)
			: undefined;
	const shouldReplaceEffortMap = thinking.effortMap === undefined ? effortMap !== undefined : effortsChanged;
	const needsDisplay =
		thinking.supportsDisplay === undefined &&
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id);
	const needsRequiresEffort =
		thinking.requiresEffort === undefined &&
		(impliesMandatoryReasoning(parsed, spec.id) ||
			isQwenTemplateReasoningEffortCompat(compat) ||
			isOpenCodeGatewayOxAlphaModel(spec));
	const needsDefaultLevel =
		thinking.defaultLevel === undefined && (isKimiK3ModelId(spec.id) || isGlm53ReasoningEffortModelId(spec.id));
	if (!effortsChanged && !shouldReplaceEffortMap && !needsDisplay && !needsRequiresEffort && !needsDefaultLevel) {
		return thinking;
	}
	const filled: ThinkingConfig = { ...thinking };
	if (effortsChanged) {
		filled.efforts = normalizedEfforts;
	}
	if (shouldReplaceEffortMap) {
		if (effortMap === undefined) {
			delete filled.effortMap;
		} else {
			filled.effortMap = effortMap;
		}
	}
	if (needsDisplay) {
		filled.supportsDisplay = true;
	}
	if (needsDefaultLevel) {
		filled.defaultLevel = Effort.Max;
	}
	if (needsRequiresEffort) {
		filled.requiresEffort = true;
	}
	return filled;
}

/** Derive thinking from identity + resolved compat, ignoring any baked value. Generator-side entry. */
export function deriveThinking<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const efforts = inferSupportedEfforts(parsed, spec, compat);
	if (efforts.length === 0) {
		throw new Error(`Model ${spec.provider}/${spec.id} resolved to an empty thinking range`);
	}
	const config: ThinkingConfig = {
		mode: inferThinkingControlMode(spec, parsed),
		efforts,
	};
	if (isKimiK3ModelId(spec.id) || isGlm53ReasoningEffortModelId(spec.id)) {
		config.defaultLevel = Effort.Max;
	}
	const effortMap = inferEffortMap(spec, compat, config.mode, config.efforts);
	if (effortMap !== undefined) {
		config.effortMap = effortMap;
	}
	if (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id)
	) {
		config.supportsDisplay = true;
	}
	if (
		impliesMandatoryReasoning(parsed, spec.id) ||
		isQwenTemplateReasoningEffortCompat(compat) ||
		isOpenCodeGatewayOxAlphaModel(spec)
	) {
		config.requiresEffort = true;
	}
	return config;
}

/**
 * True when the model reasons natively but rejects the wire `reasoning.effort`
 * param. Scoped to openai-responses* because that's the only API surface where
 * `compat.supportsReasoningEffort: false` means "omit the field entirely"
 * (xAI Grok off the `isGrokReasoningEffortCapable` allowlist: grok-build,
 * grok-4.20-0309-reasoning). openai-completions keeps its thinking config even
 * without effort support — binary thinking formats (zai/qwen) drive reasoning
 * through other request fields.
 */
function omitsWireReasoningEffort(api: Api, compat: CompatOf<Api>): boolean {
	if (api !== "openai-responses" && api !== "openai-codex-responses" && api !== "azure-openai-responses") {
		return false;
	}
	return (compat as ResolvedOpenAIResponsesCompat | undefined)?.supportsReasoningEffort === false;
}

function inferEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
	efforts: readonly Effort[],
): EffortMap | undefined {
	const detected = inferDetectedEffortMap(spec, compat, mode);
	const configured = readCompatEffortMap(compat);
	const merged =
		detected === undefined ? configured : configured === undefined ? detected : { ...detected, ...configured };
	return merged === undefined ? undefined : filterEffortMapToSupportedEfforts(merged, efforts);
}

function filterEffortMapToSupportedEfforts(map: EffortMap, efforts: readonly Effort[]): EffortMap | undefined {
	let filtered: EffortMap | undefined;
	for (const effort of efforts) {
		const mapped = map[effort];
		if (mapped === undefined) continue;
		if (filtered === undefined) filtered = {};
		filtered[effort] = mapped;
	}
	return filtered;
}

function sameEffortList(left: readonly Effort[], right: readonly Effort[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isOpenAICompatReasoningApi(api: Api): boolean {
	return api === "openai-completions" || api === "openrouter";
}

/**
 * GPT-5.6+ addressed through a wire `reasoning.effort`/`reasoning_effort`
 * field, where the five-tier `low..max` wire scale applies. Devin
 * (`devin-agent`) selects effort by routing to per-tier sibling model ids
 * instead and must stay unmapped.
 */
function isGpt56PlusWireEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	switch (spec.api) {
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
		case "openai-completions":
		case "openrouter":
			break;
		default:
			return false;
	}
	const parsed = parseOpenAIModel(bareModelId(spec.id));
	return parsed !== null && semverGte(parsed.version, "5.6");
}

function getModelDefinedEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] | undefined {
	if (
		isOpenAICompatReasoningApi(spec.api) &&
		isChatTemplateThinkingFormat(compat) &&
		spec.thinking?.mode === "effort" &&
		spec.thinking.efforts.length > 0
	) {
		return spec.thinking.efforts;
	}
	if (isGlm53ReasoningEffortModelId(spec.id)) {
		// GLM-5.3+ exposes a uniform wire-exact low/high/max ladder on every
		// host — unlike GLM-5.2, whose reasoning_effort dialect is
		// host-specific. Thinking can no longer be disabled (handled by
		// impliesMandatoryReasoning), and the default effort is `max`.
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isGlm52ReasoningEffortModelId(spec.id)) {
		// GLM-5.2's reasoning_effort dialect is host-specific (verified against
		// live endpoints):
		//   - Z.ai/Zhipu ("zai" dialect) expose only high/max ("none" is the
		//     thinking-off state, not a user tier).
		//   - Umans, Ollama Cloud, and Baseten serve the same two-tier
		//     high/max scale on their GLM-5.2 routes.
		//   - OpenRouter rejects `max` — `xhigh` IS its top tier.
		//   - Other openai-compat hosts (Fireworks, resellers) pass the
		//     default lower tiers through verbatim and expose the genuine
		//     `max` above `high` (host quirks like Fireworks' minimal→none
		//     stay in the host maps).
		if (isOpenRouterThinkingFormat(compat)) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		if (
			isZaiThinkingFormat(compat) ||
			isAnthropicMessagesGlm52ReasoningEffortModel(spec) ||
			isOllamaCloudGlm52ReasoningEffortModel(spec) ||
			spec.provider === "baseten"
		) {
			return HIGH_MAX_REASONING_EFFORTS;
		}
		if (isOpenAICompatReasoningApi(spec.api)) {
			return DEFAULT_REASONING_EFFORTS_WITH_MAX;
		}
	}
	if (isKimiK3ModelId(spec.id)) {
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isOpenCodeGatewayOxAlphaModel(spec)) {
		return LOW_HIGH_MAX_REASONING_EFFORTS;
	}
	if (isSakanaFuguReasoningModel(spec)) {
		return HIGH_MAX_REASONING_EFFORTS;
	}
	if (isGpt56PlusWireEffortModel(spec)) {
		// Normalize stale baked/discovered `low..xhigh` surfaces to the
		// wire-exact five-tier `low..max` ladder.
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}
	const anthropicAdaptive = getAnthropicAdaptiveEfforts(spec);
	if (anthropicAdaptive !== undefined) {
		return anthropicAdaptive;
	}
	// Fire Pass's Kimi router accepts low..max with distinct xhigh and max
	// budgets; user minimal has no wire tier there.
	if (spec.provider === "firepass") {
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}
	// Local Ollama's effort vocabulary is low/medium/high/max regardless of
	// model. Custom OpenAI-compatible providers pointed at an Ollama port
	// under a different provider id must set `compat.reasoningEffortMap`
	// themselves.
	if (spec.provider === "ollama") {
		return OLLAMA_REASONING_EFFORTS;
	}
	// Qwen 3.8+ served through a local llama.cpp-style backend: the chat
	// template's prompt-steered `reasoning_effort` kwarg accepts exactly
	// low/medium/xhigh (and thinking cannot be turned off — the official 3.8
	// template raises on `enable_thinking: false`, hence requiresEffort).
	if (isOpenAICompatReasoningApi(spec.api) && isQwenTemplateReasoningEffortCompat(compat)) {
		return QWEN38_TEMPLATE_REASONING_EFFORTS;
	}
	if (
		(isOpenAICompatReasoningApi(spec.api) ||
			spec.api === "openai-responses" ||
			(spec.api === "ollama-chat" && spec.provider === "ollama-cloud")) &&
		isDeepseekReasoningModel(spec)
	) {
		// The DeepSeek V4 effort ladder is a model property, not a transport one:
		// `opencode-go/deepseek-v4-flash` is pinned to `openai-responses` (the Go
		// gateway serves it only at /responses), yet carries the same wire-exact
		// low/high/max scale — so the Responses transport is admitted here too.
		// DeepSeek V4 (Flash and Pro) accepts the wire-exact low/high/max ladder
		// on every first-party/aggregator host — the direct API, aggregators, and
		// Ollama Cloud alike (medium/xhigh fold into high, max is a real wire
		// tier). See https://api-docs.deepseek.com/api/create-chat-completion.
		// OpenRouter's non-Flash V4 route exposes only high, except the dated
		// `deepseek-v4-pro-0813` SKU: its /models metadata advertises (and the
		// route accepts) the full low/high/max ladder like every other host.
		// The older reasoners (V3.x, R1, deepseek-reasoner) top out at high/max.
		if (isDeepseekV4FlashModelId(spec.id)) {
			return LOW_HIGH_MAX_REASONING_EFFORTS;
		}
		const bareId = bareModelId(spec.id).toLowerCase();
		if (bareId.includes("deepseek-v4")) {
			if (!isOpenRouterThinkingFormat(compat)) {
				return LOW_HIGH_MAX_REASONING_EFFORTS;
			}
			// Route suffixes are OpenRouter-specific and not part of the model identity.
			const openRouterBaseId = bareId.replace(/:[^:]+$/, "");
			return openRouterBaseId === "deepseek-v4-pro-0813"
				? LOW_HIGH_MAX_REASONING_EFFORTS
				: HIGH_ONLY_REASONING_EFFORTS;
		}
		return isOpenRouterThinkingFormat(compat) ? HIGH_ONLY_REASONING_EFFORTS : HIGH_MAX_REASONING_EFFORTS;
	}
	if (spec.provider === "baseten" && isOpenAIGptOssModelId(spec.id)) {
		// Baseten's gpt-oss router mirrors its GLM route: high/max only.
		return HIGH_MAX_REASONING_EFFORTS;
	}
	// First-party Grok: `grok-4.6*` and `grok-4.20-multi-agent*` advertise
	// `xhigh`. Other effort-capable SKUs stay on `minimal/low/medium/high`.
	if (modelMatchesHost({ provider: spec.provider, baseUrl: spec.baseUrl ?? "" }, "xai")) {
		return isGrokXHighEffortCapable(spec.id) ? DEFAULT_REASONING_EFFORTS_WITH_XHIGH : DEFAULT_REASONING_EFFORTS;
	}
	return isOpenAICompatReasoningApi(spec.api) &&
		(isMinimaxM2FamilyModelId(spec.id) ||
			isOpenAIGptOssModelId(spec.id) ||
			isOpenAICompatMimoReasoningEffortModel(spec, compat))
		? LOW_MEDIUM_HIGH_REASONING_EFFORTS
		: undefined;
}

/**
 * Wire-exact effort ladders for Anthropic adaptive models (4.6+). Model-defined
 * so stale cached surfaces normalize on every build: Messages-API models with
 * the real xhigh tier (4.7+) expose the full five-tier `low..max` scale;
 * Opus/Sonnet 4.6 and every Bedrock adaptive model stay on the four-tier
 * `low/medium/high/max` scale.
 */
function getAnthropicAdaptiveEfforts<TApi extends Api>(spec: ModelSpec<TApi>): readonly Effort[] | undefined {
	const parsed = parseAnthropicModel(bareModelId(spec.id));
	if (!parsed || !isAnthropicAdaptiveGenAtLeast(parsed, "4.6")) return undefined;
	if (spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") {
		return anthropicModelHasRealXHighEffort(spec, parsed)
			? FIVE_TIER_EFFORTS_LOW_TO_MAX
			: FOUR_TIER_EFFORTS_LOW_TO_MAX;
	}
	if (isOpenRouterAnthropicAdaptiveReasoningModel(parsed, spec)) {
		return isAnthropicAdaptiveGenAtLeast(parsed, "4.7") ? FIVE_TIER_EFFORTS_LOW_TO_MAX : FOUR_TIER_EFFORTS_LOW_TO_MAX;
	}
	return undefined;
}

function isOllamaCloudGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "ollama-chat" && spec.provider === "ollama-cloud" && isGlm52ReasoningEffortModelId(spec.id);
}

function isAnthropicMessagesGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return (
		spec.api === "anthropic-messages" &&
		(spec.provider === "umans" || spec.provider === "zai") &&
		isGlm52ReasoningEffortModelId(spec.id)
	);
}

function isMinimaxReasoningModelOnAnthropicEndpoint<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "anthropic-messages" && (isMinimaxM2FamilyModelId(spec.id) || isMinimaxM3FamilyModelId(spec.id));
}

function isOpenAICompatMimoReasoningEffortModel<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): boolean {
	if (!isOpenAICompatReasoningApi(spec.api)) return false;
	if (!isMimoModelIdOrName(spec.id) && !isMimoModelIdOrName(spec.name ?? "")) return false;
	const resolved = compat as ResolvedOpenAICompat | undefined;
	return (
		(resolved?.thinkingFormat === "openai" || resolved?.thinkingFormat === "openrouter") &&
		resolved.supportsReasoningEffort
	);
}

function readCompatEffortMap(compat: CompatOf<Api>): EffortMap | undefined {
	if (compat === undefined || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	const map = compat.reasoningEffortMap;
	return map && Object.keys(map).length > 0 ? map : undefined;
}

function isOpenRouterThinkingFormat(compat: CompatOf<Api>): boolean {
	return compat !== undefined && "thinkingFormat" in compat && compat.thinkingFormat === "openrouter";
}

function isZaiThinkingFormat(compat: CompatOf<Api>): boolean {
	return compat !== undefined && "thinkingFormat" in compat && compat.thinkingFormat === "zai";
}
/** Resolved-compat gate for the Qwen 3.8+ local template `reasoning_effort` dialect. */
function isQwenTemplateReasoningEffortCompat(compat: CompatOf<Api>): boolean {
	return (
		compat !== undefined && "qwenTemplateReasoningEffort" in compat && compat.qwenTemplateReasoningEffort === true
	);
}
function isChatTemplateThinkingFormat(compat: CompatOf<Api>): boolean {
	return compat !== undefined && "thinkingFormat" in compat && compat.thinkingFormat === "chat-template";
}

function inferDetectedEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	mode: ThinkingConfig["mode"],
): EffortMap | undefined {
	if (mode === "anthropic-adaptive") {
		if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
			return MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP;
		}
		// Adaptive effort ladders are wire-exact (see
		// getAnthropicAdaptiveEfforts) — no mapping needed.
		return undefined;
	}
	if (!isOpenAICompatReasoningApi(spec.api)) {
		return undefined;
	}
	if (spec.provider === "groq" && spec.id === "qwen/qwen3-32b") {
		return GROQ_QWEN3_32B_REASONING_EFFORT_MAP;
	}
	if (isOpenAICompatMimoReasoningEffortModel(spec, compat)) {
		return MIMO_REASONING_EFFORT_MAP;
	}
	// Host quirk: Fireworks rejects `minimal` (maps to `none`) on ladders
	// that genuinely include it. Filtered to supported efforts later.
	if (modelMatchesHost(spec, "fireworks")) {
		return FIREWORKS_REASONING_EFFORT_MAP;
	}
	return undefined;
}

function isSakanaFuguReasoningModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.provider === "sakana" && /^fugu(?:$|-)/i.test(spec.id);
}

/**
 * "Ox Alpha" stealth models on the OpenCode gateways (`opencode-go` /
 * `opencode-zen`) reason through the wire-exact `low`/`high`/`max` ladder with
 * mandatory thinking: the gateway rejects `minimal`/`medium`/`xhigh`
 * (`[1210] ... please use low, high, or max`), the same dialect it already
 * serves for GLM-5.3 and Kimi K3. The SKU also ships under unrelated aliased
 * ids (`opencode-zen/x-preview-f-free`), so the stencil display name is
 * matched as well. Other hosts proxying an `ox-alpha` SKU (Kilo, NanoGPT,
 * Venice, OpenRouter) expose their own vocabularies and are left untouched.
 * See issue #9349.
 */
function isOpenCodeGatewayOxAlphaModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	if (spec.provider !== "opencode-go" && spec.provider !== "opencode-zen") return false;
	if (/(?:^|\/)ox-alpha(?:-|$)/i.test(bareModelId(spec.id))) return true;
	// Aliased gateway ids surface the same SKU under an unrelated id; the
	// display name ("Ox Alpha …") is the stable cross-id signal. Anchored on
	// both sides so "Box Alpha"/"Ox Alphabet" cannot false-positive.
	return /\box[ _-]?alpha\b/i.test(spec.name ?? "");
}

function isDeepseekReasoningModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	if (!spec.reasoning) return false;
	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isOpenCodeDeepseekAlias =
		spec.provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	return (
		modelMatchesHost(spec, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias
	);
}

function inferSupportedEfforts<TApi extends Api>(
	parsedModel: ParsedModel,
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] {
	const modelDefinedEfforts = getModelDefinedEfforts(spec, compat);
	if (modelDefinedEfforts !== undefined) {
		return modelDefinedEfforts;
	}
	switch (parsedModel.family) {
		case "openai":
			return inferOpenAISupportedEfforts(parsedModel);
		case "gemini":
			return inferGeminiSupportedEfforts(parsedModel);
		case "anthropic":
			return inferAnthropicSupportedEfforts(parsedModel, spec, compat);
		case "unknown":
			return inferFallbackEfforts(spec, compat);
	}
}

function inferOpenAISupportedEfforts(model: OpenAIModel): readonly Effort[] {
	if (model.variant === "codex-mini" && semverEqual(model.version, "5.1")) {
		return GPT_5_1_CODEX_MINI_EFFORTS;
	}
	// 5.6+ exposes the wire-exact five-tier ladder low..max.
	if (semverGte(model.version, "5.6")) {
		return FIVE_TIER_EFFORTS_LOW_TO_MAX;
	}
	if (semverGte(model.version, "5.2")) {
		return GPT_5_2_PLUS_EFFORTS;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferGeminiSupportedEfforts(model: GeminiModel): readonly Effort[] {
	if (!semverGte(model.version, "3.0")) {
		return DEFAULT_REASONING_EFFORTS;
	}
	return model.kind === "pro" ? GEMINI_3_PRO_EFFORTS : GEMINI_3_FLASH_EFFORTS;
}

const OPENAI_O_SERIES_RE = /^o[134](?:$|[-:.])/i;

/**
 * Reasoning-only upstreams reject disabled or omitted thinking ("Reasoning is
 * mandatory for this endpoint and cannot be disabled") — the floor is the
 * lowest effort, never off:
 * - Gemini 3.x exposes levels only; Gemini 2.5 Pro floors thinkingBudget at
 *   128 and rejects 0 (2.5 Flash/Flash-Lite keep the off switch).
 * - OpenAI o-series and MiniMax M2 are reasoning-first architectures.
 * - Thinking-variant SKUs (`*-thinking`, `*-reasoner`, `*-reasoning`) ARE the
 *   thinking checkpoint; live bare twins pair-collapse away
 *   (variant-collapse) and the collapsed entry owns off — this floor protects
 *   the orphans.
 */
function impliesMandatoryReasoning(parsed: ParsedModel, modelId: string): boolean {
	if (parsed.family === "gemini") {
		if (semverGte(parsed.version, "3.0")) return true;
		if (parsed.kind === "pro" && semverGte(parsed.version, "2.5")) return true;
	}
	if (isKimiK3ModelId(modelId)) return true;
	// GLM-5.3+ no longer supports disabling thinking — thinking.type must
	// always be "enabled". Floor thinking-off requests to the lowest effort.
	if (isGlm53ReasoningEffortModelId(modelId)) return true;
	if (isMinimaxM2FamilyModelId(modelId)) return true;
	if (OPENAI_O_SERIES_RE.test(bareModelId(modelId))) return true;
	return findThinkingVariantToken(modelId) !== undefined;
}

function inferAnthropicSupportedEfforts<TApi extends Api>(
	parsedModel: AnthropicModel,
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] {
	// Ladders for adaptive-generation models (Opus 4.6+, Sonnet 5+,
	// Fable/Mythos) are model-defined and already resolved by
	// getAnthropicAdaptiveEfforts. Every other 4.6+ model on the Messages
	// API (Sonnet/Haiku 4.6) still runs adaptive mode with the three-tier
	// low/medium/high wire scale — no minimal, no max.
	if (spec.api === "anthropic-messages" && semverGte(parsedModel.version, "4.6")) {
		return LOW_MEDIUM_HIGH_REASONING_EFFORTS;
	}
	// Non-adaptive 4.6 models on Bedrock stay budget-mode, where minimal is
	// a legitimate synthetic budget tier.
	if (spec.api === "bedrock-converse-stream" && semverGte(parsedModel.version, "4.6")) {
		return DEFAULT_REASONING_EFFORTS;
	}
	return inferFallbackEfforts(spec, compat);
}

function inferFallbackEfforts<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): readonly Effort[] {
	const modelDefinedEfforts = getModelDefinedEfforts(spec, compat);
	if (modelDefinedEfforts !== undefined) return modelDefinedEfforts;
	if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
		return LOW_MEDIUM_HIGH_REASONING_EFFORTS;
	}
	if (spec.api === "anthropic-messages") {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (spec.name.includes("deepseek-v4")) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (spec.api === "bedrock-converse-stream") {
		return DEFAULT_REASONING_EFFORTS;
	}
	if (isOpenAICompatReasoningApi(spec.api)) {
		const resolved = compat as ResolvedOpenAICompat;
		if (
			resolved.thinkingFormat === "openai" &&
			modelMatchesHost({ provider: spec.provider, baseUrl: spec.baseUrl ?? "" }, "venice") &&
			isQwenModelId(spec.id)
		) {
			return DEFAULT_REASONING_EFFORTS;
		}
		if (resolved.thinkingFormat === "openai" && resolved.supportsReasoningEffort) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		return DEFAULT_REASONING_EFFORTS;
	}
	// OpenAI Responses APIs encode discrete effort levels, including xhigh.
	if (
		spec.api === "openai-responses" ||
		spec.api === "openai-codex-responses" ||
		spec.api === "azure-openai-responses"
	) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferThinkingControlMode<TApi extends Api>(
	spec: ModelSpec<TApi>,
	parsedModel: ParsedModel,
): ThinkingConfig["mode"] {
	switch (spec.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return parsedModel.family === "gemini" &&
				semverGte(parsedModel.version, "3.0") &&
				parsedModel.version.major === 3
				? "google-level"
				: "budget";

		case "anthropic-messages":
			if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
				return "anthropic-adaptive";
			}
			if (isAnthropicMessagesGlm52ReasoningEffortModel(spec)) {
				return "anthropic-budget-effort";
			}
			if (parsedModel.family === "anthropic") {
				if (semverGte(parsedModel.version, "4.6")) {
					return "anthropic-adaptive";
				}
				// Opus 4.5 supports `output_config.effort` (sent alongside
				// `thinking.budget_tokens`); Sonnet 4.5 and Haiku 4.5 reject the
				// field with HTTP 400 "This model does not support the effort
				// parameter." (#3497).
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		case "bedrock-converse-stream":
			if (parsedModel.family === "anthropic") {
				if (isAnthropicAdaptiveGenAtLeast(parsedModel, "4.6")) {
					return "anthropic-adaptive";
				}
				// Opus 4.5 on Bedrock metadata mirrors the direct-Anthropic
				// shape; the Bedrock provider still emits plain budget thinking
				// on the wire for the budget-effort mode.
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			// Bedrock serves the GPT-5.x models through OpenAI's own request
			// schema, which rejects Anthropic's budget block outright:
			// `unknown_parameter: 'thinking'`. It takes `reasoning.effort`
			// instead. gpt-oss parses as `unknown` (no `gpt-<digits>`), so it
			// keeps the budget path it ships with today.
			if (parsedModel.family === "openai") {
				return "effort";
			}
			return "budget";

		default:
			return "effort";
	}
}

function isOpenRouterAnthropicAdaptiveReasoningModel<TApi extends Api>(
	parsedModel: AnthropicModel,
	spec: ModelSpec<TApi>,
): boolean {
	if (!isOpenAICompatReasoningApi(spec.api)) return false;
	if (!modelMatchesHost(spec, "openrouter")) return false;
	return isAnthropicAdaptiveGenAtLeast(parsedModel, "4.6");
}

/**
 * Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+ on the Messages API expose the full five-tier
 * adaptive scale (low/medium/high/xhigh/max). Bedrock Converse stays on the
 * four-tier scale regardless of model version.
 */
function anthropicModelHasRealXHighEffort<TApi extends Api>(spec: ModelSpec<TApi>, parsedModel: ParsedModel): boolean {
	if (spec.api !== "anthropic-messages") return false;
	if (parsedModel.family !== "anthropic") return false;
	return isAnthropicAdaptiveGenAtLeast(parsedModel, "4.7");
}

// ---------------------------------------------------------------------------
// Runtime helpers (field reads only — safe per request)
// ---------------------------------------------------------------------------

/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values.
 * When a collapsed family routes `minimal` onto the same wire id as `low`
 * (Antigravity Gemini 3.6/3.7 Flash), emit `LOW` — Cloud Code Assist rejects
 * `MINIMAL` on those `-low` SKUs.
 */
export function mapEffortToGoogleThinkingLevel<TApi extends Api>(
	effort: Effort,
	model?: ApiModel<TApi>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	if (effort === Effort.Minimal) {
		const routing = model?.thinking?.effortRouting;
		if (routing?.[Effort.Minimal] && routing[Effort.Minimal] === routing[Effort.Low]) {
			return "LOW";
		}
		return "MINIMAL";
	}
	switch (effort) {
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

/**
 * Maps a normalized thinking effort to Anthropic adaptive effort values via
 * the model's baked `thinking.effortMap` (identity for unmapped efforts).
 */
export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
	const supported = requireSupportedEffort(model, effort);
	return (model.thinking?.effortMap?.[supported] ?? supported) as
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "adaptive";
}

/**
 * Resolves the upstream wire model id for a request at the given effort
 * (`undefined` = thinking off). Collapsed effort-tier variants route through
 * `thinking.effortRouting`; everything else falls back to
 * `requestModelId ?? id`.
 */
export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}

/**
 * Clamp target for effort-less requests on `thinking.requiresEffort` models:
 * the effort whose wire route equals the model's default wire id
 * (`requestModelId`), so a collapsed row clamps to the tier it already
 * advertises as its default rather than the numerically lowest supported tier
 * (e.g. Cursor Grok 4.5/4.6 default to `medium`, the only tier the Start plan
 * serves). Falls back to {@link minimumSupportedEffort} when no route matches
 * the default id — families whose default already is the minimum, or that
 * expose no routing, are unaffected.
 */
export function defaultSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const routing = model.thinking?.effortRouting;
	const defaultWireId = model.requestModelId;
	if (routing !== undefined && defaultWireId !== undefined) {
		const efforts = model.thinking?.efforts;
		for (const effort of THINKING_EFFORTS) {
			if (efforts?.includes(effort) && routing[effort] === defaultWireId) return effort;
		}
	}
	return minimumSupportedEffort(model);
}
