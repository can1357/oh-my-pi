/**
 * Model-family id predicates: the shared vocabulary for "is this id a member
 * of family X" checks that gate wire-level behavior across hosts (a Kimi or
 * DeepSeek model keeps its quirks no matter which OpenAI-compatible proxy
 * serves it). Looser per-feature heuristics (e.g. stream-markup healing)
 * deliberately keep their own patterns — only provably-shared matchers live
 * here.
 */

import {
	bareModelId,
	type GlmModel,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseAnthropicModel,
	parseGlmModel,
	parseKnownModel,
	parseOpenAIModel,
	semverGte,
} from "./classify";

/** Bounded process-lifetime cache memo helper. */
function memo<T>(fn: (modelId: string) => T): (modelId: string) => T {
	const cache = new Map<string, T>();
	return (modelId: string) => {
		if (cache.has(modelId)) {
			return cache.get(modelId) as T;
		}
		const result = fn(modelId);
		cache.set(modelId, result);
		return result;
	};
}

/** Kimi family ids in any namespace form (`moonshotai/kimi-*`, `kimi-k2.6`, `vendor/kimi.x`). */
export const isKimiModelId = memo((modelId: string): boolean => {
	return modelId.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(modelId);
});

/** Kimi K2.6 specifically, including router ids that spell the version `k2p6`. */
export const isKimiK26ModelId = memo((modelId: string): boolean => {
	return /(^|\/)kimi-k2(?:\.6|p6)(?:[-:]|$)/i.test(modelId);
});

/**
 * Kimi K3 in any namespace form (`kimi-k3`, `kimi-k3.1`, `kimi-k3-turbo`,
 * `moonshotai/kimi-k3`). K3 always reasons and drives thinking via OpenAI-style
 * `reasoning_effort: "max"`, not the K2.x binary `thinking: { type }` block —
 * see the moonshot discovery mapper and `buildOpenAICompat`.
 */
export const isKimiK3ModelId = memo((modelId: string): boolean => {
	return /(^|\/)kimi-k3(?:\.\d+)?(?:[-.:_]|$)/i.test(modelId);
});

/**
 * Claude ids in any namespace form: bare (`claude-*`), path-namespaced
 * (`anthropic/claude.x`), or dot-prefixed (`us.anthropic.claude-…`,
 * `global.anthropic.claude-…`, `au.anthropic.claude-…` — Bedrock cross-region
 * inference profiles). Necessary because {@link parseAnthropicModel} only
 * classifies kinds enumerated in its regex, so any dotted profile whose kind
 * (e.g. `haiku`) is not enumerated would otherwise slip past this fallback.
 */
export const isClaudeModelId = memo((modelId: string): boolean => {
	return /(^|[/.])claude[-.]/i.test(modelId);
});

/** `anthropic/`-namespaced ids (aggregator catalogs like OpenRouter). */
export const isAnthropicNamespacedModelId = memo((modelId: string): boolean => {
	return /(^|\/)anthropic\//i.test(modelId);
});

/** Qwen family ids (substring match — Qwen SKUs have no stable prefix shape). */
export const isQwenModelId = memo((modelId: string): boolean => {
	return modelId.toLowerCase().includes("qwen");
});

/**
 * Open-weight Qwen 3.8+ releases (`qwen3.8-27b`, `qwen3.8-2.4t-a95b`, GGUF
 * names like `Qwen3.8-27B-UD-Q6_K_XL`) whose chat template steers thinking
 * depth through a `reasoning_effort` template kwarg (`low`/`medium`/`xhigh`,
 * template default `xhigh`; thinking itself cannot be disabled). Compared
 * component-wise so `qwen3.10` sorts after `qwen3.8`. API-only `-max` SKUs are
 * excluded — Dashscope drives them through OpenAI-style `reasoning_effort`
 * with curated compat. The trailing guard rejects parameter-count lookalikes
 * (`qwen-3.8b`) without breaking `qwen3.8-27b`.
 */
export const isQwen38PlusTemplateEffortModelId = memo((modelId: string): boolean => {
	const match = /qwen[-_ ]?(\d+)\.(\d+)(?![\dbB])/i.exec(modelId);
	if (!match) return false;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major < 3 || (major === 3 && minor < 8)) return false;
	return !/^-max(?:$|[-.:])/i.test(modelId.slice(match.index + match[0].length));
});

/** Gemma open-weights family (`gemma-3-27b-it`, `google/gemma-4-E2B-it`, `gemma2-9b`). */
export const isGemmaModelId = memo((modelId: string): boolean => {
	return /(^|\/)gemma[-.]?\d/i.test(modelId);
});

/** DeepSeek family by id or display name (proxies often rename the id but keep the name). */
export const isDeepseekModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("deepseek");
});

/**
 * DeepSeek V4 Flash SKU in any host/namespace form (`deepseek-v4-flash`, dated
 * `deepseek-v4-flash-0731`, `deepseek-ai/DeepSeek-V4-Flash`). Both V4 SKUs
 * (Flash and Pro) accept the `low` reasoning_effort tier; this predicate keeps
 * Flash distinguishable from Pro where a host quirk splits them (e.g.
 * OpenRouter exposes `low` on Flash but only `high` on non-Flash V4).
 * See https://api-docs.deepseek.com/api/create-chat-completion.
 */
export const isDeepseekV4FlashModelId = memo((modelId: string): boolean => {
	return bareModelId(modelId).toLowerCase().includes("deepseek-v4-flash");
});

/** Xiaomi MiMo family by id or display name. */
export const isMimoModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("mimo");
});

/** StepFun Step 3.7 Flash SKU in any namespace form (`kilo/stepfun/step-3.7-flash:free`). */
export const isStep37FlashModelId = memo((modelId: string): boolean => {
	return modelId.toLowerCase().includes("step-3.7-flash");
});

/** Gemini family ids in any namespace form (`gemini-*`, `google/gemini-*`, `openrouter/google/gemini-…`). */
export const isGeminiModelId = memo((modelId: string): boolean => {
	return /(^|\/)gemini[-.]?/i.test(modelId);
});

/** Grok family ids across namespace and delimiter forms (`grok-*`, `cursor-grok-*`, `xai/grok-*`). */
export const isGrokModelId = memo((modelId: string): boolean => {
	return /(?:^|[./_-])grok(?:[-.]|$)/i.test(modelId);
});

const GROK_EFFORT_CAPABLE_PREFIXES = [
	"grok-3-mini",
	"grok-4.20-multi-agent",
	"grok-4.3",
	"grok-4.5",
	"grok-4.6",
] as const;

/**
 * Grok SKUs that expose the wire `reasoning.effort` dial. Other Grok reasoners
 * (e.g. `grok-build`, `grok-4.20-0309-reasoning`) think natively but reject the
 * param, so callers must omit reasoning effort for them. `grok-4.6` accepts
 * `low`/`medium`/`high`/`xhigh` and 400s on `max`.
 */
export const isGrokReasoningEffortCapable = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId).trim().toLowerCase();
	if (!bare) return false;
	return GROK_EFFORT_CAPABLE_PREFIXES.some(prefix => bare.startsWith(prefix));
});

/**
 * `grok-4.20-multi-agent*` uses `reasoning.effort` to pick agent count
 * (`xhigh` is the 16-agent mode). Other first-party Grok effort SKUs stay on
 * `low|medium|high` unless {@link isGrokXHighEffortCapable} (currently
 * `grok-4.6*` plus multi-agent).
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 */
export const isGrokMultiAgentModelId = memo((modelId: string): boolean => {
	return bareModelId(modelId).trim().toLowerCase().startsWith("grok-4.20-multi-agent");
});

/**
 * First-party Grok SKUs whose Responses wire accepts `reasoning.effort: "xhigh"`.
 * `grok-4.6*` documents xhigh as a reasoning depth; multi-agent uses it as
 * 16-agent mode. `grok-4.5` / `grok-4.3` / `grok-3-mini` do not.
 */
export const isGrokXHighEffortCapable = memo((modelId: string): boolean => {
	if (isGrokMultiAgentModelId(modelId)) return true;
	return bareModelId(modelId).trim().toLowerCase().startsWith("grok-4.6");
});

/**
 * MiniMax M2-generation family (M2, M2.1, M2.5, M2.7, including `-highspeed`/
 * `-lightning`/`-her`/`-turbo` variants, dotless aliases like `minimax-m21`,
 * and short `minimax/m2-…` ids on aggregator hosts). Underlying model accepts
 * only `low|medium|high` for `reasoning_effort` and 400s on `minimal`,
 * `xhigh`, or `none` — so hosts whose default effort map otherwise lowers
 * `minimal` to `none` (Fireworks) or expects the full 5-tier scale must
 * clamp instead. Excludes M1, M3, MiniMax-Text-01, music, hailuo, voice ids.
 */
export const isMinimaxM2FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	// Boundary-delimited `m2` token followed by zero or more digits (dotless
	// variants like `m21`/`m25`/`m27`) and an optional dotted minor version.
	return /(?:^|[/.-])m2\d*(?:[.-]\d+)?(?:[-.:_]|$)/i.test(lower);
});

/** MiniMax M3 family ids in bundled/default and aggregator namespace forms. */
export const isMinimaxM3FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	return /(?:^|[/._-])(?:minimax[/._-])?m3(?:[-.:_]|$)/i.test(lower);
});

/**
 * OpenAI gpt-oss family (`gpt-oss-20b`, `gpt-oss-120b`, `gpt-oss:120b`,
 * `vendor/gpt-oss-…`). The Harmony reasoning format only accepts
 * `low|medium|high` for `reasoning_effort` and rejects `minimal`, `xhigh`,
 * and `none`.
 */
export const isOpenAIGptOssModelId = memo((modelId: string): boolean => {
	return /(^|\/)gpt-oss[-:]/i.test(modelId);
});

/**
 * Meta Muse Spark ids (`muse-spark-1.1`, `muse-spark-1.2`,
 * `muse-spark-1.2-contributor`, `meta/muse-spark-1.2`). The Responses
 * `reasoning.effort` wire accepts `none` (thinking-off) plus
 * `minimal`/`low`/`medium`/`high`/`xhigh`.
 */
export const isMuseSparkModelId = memo((modelId: string): boolean => {
	return /(^|\/)muse-spark(?:[-.]|$)/i.test(modelId);
});

/** OpenAI model ids (gpt-*, chatgpt-*, o1/o3/o4 SKUs, codex-*, or openai/*). */
export const isOpenAIModelId = memo((modelId: string): boolean => {
	return (
		/(^|\/)(?:gpt|chatgpt|codex)[-.]/i.test(modelId) ||
		/(^|\/)o[134](?:[-.]|$)/i.test(modelId) ||
		modelId.toLowerCase().includes("openai/")
	);
});

/** OpenAI models at or above the gpt-5.4 wire generation, keyed off the parsed version. */
const isOpenAIWireGen54Plus = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5.4");
});

/**
 * OpenAI Codex models that honor `reasoning.context: "all_turns"` (full
 * cross-turn reasoning replay). The `reasoning.context` field itself exists for
 * the whole gpt-5/o-series family, but the `all_turns` value is only accepted
 * from gpt-5.4 onward; earlier ids (`gpt-5.1-codex`, `gpt-5.3-codex`, and
 * `gpt-5.3-codex-spark`) reject it with
 * `Unsupported value: 'all_turns' is not supported with this model`. Version
 * floor (not an allowlist) so 5.6/6.x inherit support automatically. Callers
 * fall back to omitting `context`, letting the server default to `current_turn`.
 */
export const supportsAllTurnsReasoningContext = isOpenAIWireGen54Plus;

/**
 * OpenAI Codex models that accept `reasoning.summary`. Shares the gpt-5.4 wire
 * floor with {@link supportsAllTurnsReasoningContext}: earlier Codex ids
 * (`gpt-5.1-codex`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) reject the field
 * with `Unsupported parameter: 'reasoning.summary' is not supported with this
 * model`. Callers omit `summary` for unsupported ids, letting the server skip
 * the human-readable summary stream.
 */
export const supportsCodexReasoningSummary = isOpenAIWireGen54Plus;

/** OpenAI proprietary reasoning families keyed off the parsed gpt version (gpt-5+). */
const isOpenAIWireGen5Plus = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5");
});

/** o-series reasoning ids (`o1`, `o1-pro`, `o3`, `o3-mini`, `o4-mini`, `openai/o3`, …). */
const O_SERIES_REASONING_RE = /(^|\/)o[134](?:[-.]|$)/i;

/**
 * OpenAI proprietary models whose serving path rejects explicit sampling
 * parameters (`temperature`, `top_p`, `top_k`, …) with
 * `400 Unsupported parameter: 'temperature' is not supported with this model`.
 * Covers the o-series and the entire gpt-5+ generation — base, `mini`, `nano`,
 * `codex*`, the `luna`/`sol`/`terra` SKUs, and the `-chat-latest` variants,
 * since even the non-reasoning gpt-5 chat models reject sampling params (see
 * litellm#13781). Holds regardless of which OpenAI-serving host proxies the
 * model (official, Azure, GitHub Copilot). Version floor (not an allowlist) so
 * 6.x inherits automatically. Issue #5606.
 */
export const isOpenAISamplingRestrictedModelId = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId);
	return isOpenAIWireGen5Plus(modelId) || O_SERIES_REASONING_RE.test(bare);
});

/**
 * GLM SKU shapes that carry the reasoning ladders. `base`/`air`/`turbo` have
 * always been reasoning lines; `flash` joins at GLM-5.3-Flash, the first flash
 * SKU whose thinking is mandatory (pre-5.3 `-flash` SKUs are non-reasoning).
 * `flashx` and `preview` stay out.
 */
function isGlmReasoningVariant(glm: GlmModel): boolean {
	switch (glm.variant) {
		case "base":
		case "air":
		case "turbo":
			return true;
		case "flash":
			return semverGte(glm.version, "5.3");
		default:
			return false;
	}
}

/**
 * Reasoning-capable GLM coding SKUs: glm-4.5 and up on the base / `-air` /
 * `-turbo` lines, plus `-flash` from GLM-5.3-Flash on. Excludes the vision
 * (`…v`) shape, the non-reasoning `-flashx`/`-preview` variants, and pre-4.5
 * ids. Matching the family keeps newly-bumped integers (`glm-5.4`, `glm-6`, …)
 * covered without a per-id allowlist.
 */
export const isReasoningGlmModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision || !isGlmReasoningVariant(glm)) {
		return false;
	}
	return semverGte(glm.version, "4.5");
});

/** GLM-5.2+ coding SKUs accept `reasoning_effort` in addition to binary thinking. */
export const isGlm52ReasoningEffortModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision || !isGlmReasoningVariant(glm)) {
		return false;
	}
	return semverGte(glm.version, "5.2");
});

/**
 * GLM-5.3+ reasoning-effort SKUs. Unlike GLM-5.2 (whose dialect is
 * host-specific), the base, `-air`, `-turbo`, and `-flash` variants expose a
 * uniform wire-exact `low`/`high`/`max` ladder on every host, and thinking can
 * no longer be disabled — `thinking.type` must always be `enabled`. Matching
 * the family keeps future bumps (`glm-5.4`, `glm-6`, …) covered while excluding
 * the vision (`…v`) shape and the non-reasoning `-flashx`/`-preview` variants.
 */
export const isGlm53ReasoningEffortModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision || !isGlmReasoningVariant(glm)) {
		return false;
	}
	return semverGte(glm.version, "5.3");
});

/**
 * GLM SKUs that accept image input: the `v` that attaches to the version
 * (`glm-4v`, `glm-4.5v`) and the natively multimodal `-flash` line from
 * GLM-5.3-Flash on, whose id carries no `v` marker.
 */
export const isGlmVisionModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm) {
		return false;
	}
	return glm.vision || (glm.variant === "flash" && semverGte(glm.version, "5.3"));
});

/**
 * Coarse vendor-lineage token for "are two models the same family?" checks
 * (e.g. picking a cross-family reviewer). All Claude point releases share a token,
 * Claude and GPT differ; namespace prefixes and aggregator mirrors fold onto the
 * lineage via {@link parseKnownModel}'s `bareModelId` normalization. Opaque and
 * comparison-only — not a stable key to persist, since the vocabulary tracks new
 * releases. Returns `""` for ids it cannot classify; callers fall back to the provider.
 *
 * Vendor-only by design: a model's kind/variant (opus vs sonnet, codex vs base) is
 * collapsed onto the single vendor token; use {@link parseKnownModel} for finer breakdowns.
 */
export const modelFamilyToken = memo((modelId: string): string => {
	const parsed = parseKnownModel(modelId);
	if (parsed.family !== "unknown") return parsed.family;
	if (isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)) return "anthropic";
	if (isGeminiModelId(modelId)) return "gemini";
	if (isGrokModelId(modelId)) return "grok";
	if (isDeepseekModelIdOrName(modelId)) return "deepseek";
	if (isOpenAIModelId(modelId)) return "openai";
	if (isKimiModelId(modelId)) return "kimi";
	if (isQwenModelId(modelId)) return "qwen";
	if (isMinimaxM2FamilyModelId(modelId) || isMinimaxM3FamilyModelId(modelId)) return "minimax";
	if (isOpenAIGptOssModelId(modelId)) return "gpt-oss";
	if (isMimoModelIdOrName(modelId)) return "mimo";
	if (isGemmaModelId(modelId)) return "gemma";
	if (parseGlmModel(bareModelId(modelId))) return "glm";
	return "";
});

/**
 * True for Claude generations that support extended thinking: Sonnet/Opus 3.7+,
 * every 4.x/5+ Opus/Sonnet, and the Fable/Mythos generation. Pre-thinking
 * models (Claude 3.5 and older) are excluded so no thinking effort dial is
 * fabricated for a model that rejects thinking parameters. Classifier-based, so
 * dotted and dashed version forms both match; ids the classifier does not parse
 * (e.g. Haiku, bare dated ids) return false.
 */
export const anthropicModelSupportsThinking = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && semverGte(parsed.version, "3.7");
});

/**
 * Adaptive thinking `display` is supported starting with Claude Opus 4.7+,
 * Sonnet 5+, and the Claude Fable/Mythos 5 generation. Older adaptive-thinking
 * models (Opus 4.6, Sonnet 4.6) reject the field. Classifier-based, so dotted
 * and dashed version forms both match while bare dated ids
 * (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
 */
export const supportsAdaptiveThinkingDisplay = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

/**
 * Returns true for Anthropic models with Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+
 * API restrictions:
 * - Sampling parameters (temperature/top_p/top_k) return 400 error
 * - Thinking content is omitted by default (needs display: "summarized")
 */
export const hasOpus47ApiRestrictions = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

/**
 * Mid-conversation `role: "system"` messages (system instructions appended at
 * non-first positions in the `messages` array) are supported starting with
 * Claude Opus 4.8+, Sonnet 5+, and the Claude Fable/Mythos 5 generation.
 * Earlier Claude models reject the role.
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
export const supportsMidConversationSystemMessages = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.8");
});

/**
 * Models that reliably follow the hashline line-anchored edit dialect
 * (`[path#TAG]` headers plus 1-indexed anchors). Kimi, MiMo, DeepSeek V4
 * Flash, and Step 3.7 Flash miscount anchors or drop the tag header often
 * enough that hosts fall back to the sloppy edit format for
 * them.
 */
export const supportsHashlineEdits = memo((modelId: string): boolean => {
	return !(
		isKimiModelId(modelId) ||
		isMimoModelIdOrName(modelId) ||
		isDeepseekV4FlashModelId(modelId) ||
		isStep37FlashModelId(modelId)
	);
});

export const isAnthropicFableOrMythosModel = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isFableOrMythos(parsed.kind);
});

/** Thinking-variant token location inside a model id. */
export interface ThinkingVariantToken {
	index: number;
	length: number;
}

const THINKING_VARIANT_TOKEN_RE = /-(?:thinking|reasoner|reasoning)(?=$|[^a-z0-9])/gi;

/**
 * Locates the first thinking-variant token (`-thinking`, `-reasoner`,
 * `-reasoning`; trailing or infix) in a model id. The token ends at the id
 * end or any non-alphanumeric boundary, and negated forms (`non-thinking`,
 * `no-thinking`) never match — those name the NON-thinking SKU.
 */
export function findThinkingVariantToken(modelId: string): ThinkingVariantToken | undefined {
	THINKING_VARIANT_TOKEN_RE.lastIndex = 0;
	let match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	while (match !== null) {
		const preceding = /([a-z0-9]+)$/i.exec(modelId.slice(0, match.index))?.[1]?.toLowerCase();
		if (preceding !== "non" && preceding !== "no") {
			return { index: match.index, length: match[0].length };
		}
		match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	}
	return undefined;
}

/**
 * Removes the located thinking-variant token: `kimi-k2-thinking` → `kimi-k2`,
 * `mimo-v2-flash-thinking-original` → `mimo-v2-flash-original`,
 * `grok-4.1-fast-reasoning` → `grok-4.1-fast`. Returns `undefined` when no
 * token exists or nothing would remain. Callers MUST verify the result names
 * a live model.
 */
export const stripThinkingVariantToken = memo((modelId: string): string | undefined => {
	const token = findThinkingVariantToken(modelId);
	if (!token) return undefined;
	const stripped = modelId.slice(0, token.index) + modelId.slice(token.index + token.length);
	return stripped.length > 0 ? stripped : undefined;
});
