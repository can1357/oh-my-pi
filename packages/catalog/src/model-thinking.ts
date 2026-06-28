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
	isFableOrMythos,
	type OpenAIModel,
	type ParsedModel,
	parseAnthropicModel,
	parseKnownModel,
	semverEqual,
	semverGte,
} from "./identity/classify";
import {
	findThinkingVariantToken,
	isDeepseekModelIdOrName,
	isGlm52ReasoningEffortModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isOpenAIGptOssModelId,
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
const GLM_52_HIGH_MAX_REASONING_EFFORTS: readonly Effort[] = [Effort.High, Effort.XHigh];

const FUGU_REASONING_EFFORTS: readonly Effort[] = [Effort.High, Effort.XHigh];
const FUGU_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.XHigh]: "max",
};
type EffortMap = Partial<Record<Effort, string>>;

const GROQ_QWEN3_32B_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "default",
	[Effort.Low]: "default",
	[Effort.Medium]: "default",
	[Effort.High]: "default",
	[Effort.XHigh]: "default",
};
const DEEPSEEK_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "high",
	[Effort.Low]: "high",
	[Effort.Medium]: "high",
	[Effort.High]: "high",
	[Effort.XHigh]: "max",
};
const FIREWORKS_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "none",
};
const ZAI_GLM_52_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "none",
	[Effort.Low]: "high",
	[Effort.Medium]: "high",
	[Effort.High]: "high",
	[Effort.XHigh]: "max",
};
const GLM_52_XHIGH_MAX_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.XHigh]: "max",
};
const MIMO_REASONING_EFFORT_MAP: Readonly<EffortMap> = {
	[Effort.Minimal]: "low",
	[Effort.XHigh]: "high",
};

/**
 * Effort → wire-value map for the 5-tier adaptive scale (Opus 4.7+ and
 * Fable/Mythos 5 on the Messages API). User-facing efforts shift up one notch
 * so the top tier reaches the genuine "max" and "high" lands on Anthropic's
 * recommended "xhigh" coding/agentic default.
 */
export const ANTHROPIC_ADAPTIVE_EFFORT_MAP_5_TIER: Readonly<Partial<Record<Effort, string>>> = {
	[Effort.Minimal]: "low",
	[Effort.Low]: "medium",
	[Effort.Medium]: "high",
	[Effort.High]: "xhigh",
	[Effort.XHigh]: "max",
};

/**
 * Effort → wire-value map for the legacy 4-tier adaptive scale (Opus 4.6,
 * Sonnet 4.6+, and every adaptive model on Bedrock Converse). `low..high` pass
 * through verbatim; there is no real "xhigh", so it aliases the top "max" tier.
 */
export const ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER: Readonly<Partial<Record<Effort, string>>> = {
	[Effort.Minimal]: "low",
	[Effort.XHigh]: "max",
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
 * model-defined effort restrictions still normalize stale cached capability
 * surfaces before request-time code can observe them.
 */
function fillThinkingWireDefaults<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
): ThinkingConfig {
	const parsed = parseKnownModel(spec.id);
	const normalizedEfforts = getModelDefinedEfforts(spec, compat) ?? thinking.efforts;
	const effortsChanged = !sameEffortList(normalizedEfforts, thinking.efforts);
	const effortMap =
		thinking.effortMap === undefined
			? inferEffortMap(spec, compat, parsed, thinking.mode, normalizedEfforts)
			: effortsChanged
				? filterEffortMapToSupportedEfforts(thinking.effortMap, normalizedEfforts)
				: undefined;
	const shouldReplaceEffortMap = thinking.effortMap === undefined ? effortMap !== undefined : effortsChanged;
	const needsDisplay =
		thinking.supportsDisplay === undefined &&
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id);
	const needsRequiresEffort = thinking.requiresEffort === undefined && impliesMandatoryReasoning(parsed, spec.id);
	if (!effortsChanged && !shouldReplaceEffortMap && !needsDisplay && !needsRequiresEffort) {
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
	const effortMap = inferEffortMap(spec, compat, parsed, config.mode, config.efforts);
	if (effortMap !== undefined) {
		config.effortMap = effortMap;
	}
	if (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		supportsAdaptiveThinkingDisplay(spec.id)
	) {
		config.supportsDisplay = true;
	}
	if (impliesMandatoryReasoning(parsed, spec.id)) {
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
	parsedModel: ParsedModel,
	mode: ThinkingConfig["mode"],
	efforts: readonly Effort[],
): EffortMap | undefined {
	const detected = inferDetectedEffortMap(spec, compat, parsedModel, mode);
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

function getModelDefinedEfforts<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] | undefined {
	if (isGlm52ReasoningEffortModelId(spec.id)) {
		// Z.ai/Zhipu and OpenRouter both surface GLM-5.2's full effort ladder,
		// including the top `xhigh` (= "max") tier; Umans and Ollama Cloud
		// expose only high/max.
		if (isZaiThinkingFormat(compat) || isOpenRouterThinkingFormat(compat)) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		if (isUmansGlm52ReasoningEffortModel(spec) || isOllamaCloudGlm52ReasoningEffortModel(spec)) {
			return GLM_52_HIGH_MAX_REASONING_EFFORTS;
		}
	}
	if (isSakanaFuguReasoningModel(spec)) {
		return FUGU_REASONING_EFFORTS;
	}
	return isOpenAICompatReasoningApi(spec.api) &&
		(isMinimaxM2FamilyModelId(spec.id) ||
			isOpenAIGptOssModelId(spec.id) ||
			isOpenAICompatMimoReasoningEffortModel(spec, compat))
		? LOW_MEDIUM_HIGH_REASONING_EFFORTS
		: undefined;
}

function isOllamaCloudGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "ollama-chat" && spec.provider === "ollama-cloud" && isGlm52ReasoningEffortModelId(spec.id);
}

function isUmansGlm52ReasoningEffortModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.api === "anthropic-messages" && spec.provider === "umans" && isGlm52ReasoningEffortModelId(spec.id);
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

function inferDetectedEffortMap<TApi extends Api>(
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
	parsedModel: ParsedModel,
	mode: ThinkingConfig["mode"],
): EffortMap | undefined {
	if (mode === "anthropic-adaptive") {
		if (isMinimaxReasoningModelOnAnthropicEndpoint(spec)) {
			return MINIMAX_ANTHROPIC_ADAPTIVE_EFFORT_MAP;
		}
		return anthropicModelHasRealXHighEffort(spec, parsedModel)
			? ANTHROPIC_ADAPTIVE_EFFORT_MAP_5_TIER
			: ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER;
	}
	// GLM-5.2 coding SKUs accept `reasoning_effort`, but the effort dialect is
	// host-specific (verified against live endpoints):
	//   - Z.ai/Zhipu ("zai" dialect): the model exposes only none/high/max, so
	//     `xhigh` 400s — collapse minimal->none, low/medium/high->high, xhigh->max.
	//   - OpenRouter: `max` 400s and `xhigh` IS its max tier, so it passes `xhigh`
	//     through literally (no map; the tier is exposed via getModelDefinedEfforts).
	//   - Umans and Ollama Cloud expose only high/max on their GLM-5.2 routes.
	//   - Other openai-compat hosts (Fireworks, resellers) keep their distinct
	//     lower tiers and host quirks (e.g. Fireworks rejects `minimal`, so
	//     `minimal->none` stays) and only remap the top `xhigh` UI tier onto the
	//     genuine `max` budget. Filtered to supported efforts later.
	const isGlm52 = isGlm52ReasoningEffortModelId(spec.id);
	if (isGlm52 && isZaiThinkingFormat(compat)) {
		return ZAI_GLM_52_REASONING_EFFORT_MAP;
	}
	if (isUmansGlm52ReasoningEffortModel(spec) || isOllamaCloudGlm52ReasoningEffortModel(spec)) {
		return GLM_52_XHIGH_MAX_EFFORT_MAP;
	}
	if (isSakanaFuguReasoningModel(spec)) {
		return FUGU_REASONING_EFFORT_MAP;
	}
	if (!isOpenAICompatReasoningApi(spec.api)) {
		return undefined;
	}
	let map: EffortMap | undefined;
	if (spec.provider === "groq" && spec.id === "qwen/qwen3-32b") {
		map = GROQ_QWEN3_32B_REASONING_EFFORT_MAP;
	} else if (isDeepseekReasoningModel(spec)) {
		map = DEEPSEEK_REASONING_EFFORT_MAP;
	} else if (isOpenAICompatMimoReasoningEffortModel(spec, compat)) {
		map = MIMO_REASONING_EFFORT_MAP;
	} else if (modelMatchesHost(spec, "openrouter")) {
		map = getOpenRouterAnthropicReasoningEffortMap(spec.id);
	} else if (modelMatchesHost(spec, "fireworks")) {
		map = FIREWORKS_REASONING_EFFORT_MAP;
	}
	// Overlay GLM-5.2's top-tier `xhigh -> max` on the host base map, except on
	// OpenRouter (xhigh IS its max tier; `max` 400s there).
	if (isGlm52 && !isOpenRouterThinkingFormat(compat)) {
		map = { ...map, ...GLM_52_XHIGH_MAX_EFFORT_MAP };
	}
	return map;
}

function isSakanaFuguReasoningModel<TApi extends Api>(spec: ModelSpec<TApi>): boolean {
	return spec.provider === "sakana" && /^fugu(?:$|-)/i.test(spec.id);
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

function getOpenRouterAnthropicReasoningEffortMap(modelId: string): EffortMap | undefined {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	if (!parsed) return undefined;
	// Adaptive efforts on OpenRouter's completions front: Fable/Mythos and
	// Opus 4.6+ only — Sonnet stays on the plain effort vocabulary there.
	const isOpusAdaptive = parsed.kind === "opus" && semverGte(parsed.version, "4.6");
	if (!isFableOrMythos(parsed.kind) && !isOpusAdaptive) return undefined;

	const hasRealXHigh = isFableOrMythos(parsed.kind) || semverGte(parsed.version, "4.7");
	return hasRealXHigh ? ANTHROPIC_ADAPTIVE_EFFORT_MAP_5_TIER : ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER;
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
	if (isMinimaxM2FamilyModelId(modelId)) return true;
	if (OPENAI_O_SERIES_RE.test(bareModelId(modelId))) return true;
	return findThinkingVariantToken(modelId) !== undefined;
}

function inferAnthropicSupportedEfforts<TApi extends Api>(
	parsedModel: AnthropicModel,
	spec: ModelSpec<TApi>,
	compat: CompatOf<TApi>,
): readonly Effort[] {
	if (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		semverGte(parsedModel.version, "4.6")
	) {
		return parsedModel.kind === "opus" || isFableOrMythos(parsedModel.kind)
			? DEFAULT_REASONING_EFFORTS_WITH_XHIGH
			: DEFAULT_REASONING_EFFORTS;
	}
	if (isOpenRouterAnthropicAdaptiveReasoningModel(parsedModel, spec)) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
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
			if (isUmansGlm52ReasoningEffortModel(spec)) {
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
				if (
					semverGte(parsedModel.version, "4.6") &&
					(parsedModel.kind === "opus" || isFableOrMythos(parsedModel.kind))
				) {
					return "anthropic-adaptive";
				}
				// Opus 4.5 on Bedrock metadata mirrors the direct-Anthropic
				// shape; the Bedrock provider still emits plain budget thinking
				// on the wire for the budget-effort mode.
				if (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
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
	return isFableOrMythos(parsedModel.kind) || (parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.6"));
}

/**
 * Opus 4.7+ and Fable/Mythos on the Messages API expose the full five-tier
 * adaptive scale (low/medium/high/xhigh/max). Bedrock Converse stays on the
 * four-tier scale regardless of model version.
 */
function anthropicModelHasRealXHighEffort<TApi extends Api>(spec: ModelSpec<TApi>, parsedModel: ParsedModel): boolean {
	if (spec.api !== "anthropic-messages") return false;
	if (parsedModel.family !== "anthropic") return false;
	if (isFableOrMythos(parsedModel.kind)) return true;
	return parsedModel.kind === "opus" && semverGte(parsedModel.version, "4.7");
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

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values. */
export function mapEffortToGoogleThinkingLevel(effort: Effort): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	switch (effort) {
		case Effort.Minimal:
			return "MINIMAL";
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
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
