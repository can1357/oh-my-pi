/**
 * Generation-time catalog policies: upstream metadata corrections, derived
 * field baking, and promotion-target linking. Runs only from
 * `generate-models.ts` — none of this ships in the runtime bundle.
 */
import { buildCompat } from "../src/build";
import {
	type AnthropicModel,
	bareModelId,
	isFableOrMythos,
	type OpenAIModel,
	type OpenAIVariant,
	type ParsedModel,
	parseKnownModel,
	semverEqual,
} from "../src/identity/classify";
import { buildCanonicalModelIndex, buildCanonicalReferenceData } from "../src/identity/equivalence";
import { isMimoModelIdOrName } from "../src/identity/family";
import { getLongestModelLikeIdSegment } from "../src/identity/id";
import { buildModelReferenceIndex, resolveModelReference } from "../src/identity/reference";
import { resolveModelThinking } from "../src/model-thinking";
import type { Api, Model, ModelSpec } from "../src/types";
import { isVariantCollapsedSpec } from "../src/variant-collapse";

const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic";

/**
 * Static fallback model injected when Cloudflare AI Gateway discovery
 * returns no results. Ensures the provider always has at least one usable
 * model entry in the catalog.
 */
export const CLOUDFLARE_FALLBACK_MODEL: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	contextWindow: 200000,
	maxTokens: 64000,
};

const CODEX_GPT_5_4_PRIORITY_BY_VARIANT: Partial<Record<OpenAIVariant, number>> = {
	base: 0,
	mini: 1,
	nano: 2,
};

const COPILOT_GENERATED_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"claude-opus-4.6": { contextWindow: 168000, maxTokens: 32000 },
	"gpt-5.2": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4-mini": { contextWindow: 272000, maxTokens: 128000 },
	"grok-code-fast-1": { contextWindow: 192000, maxTokens: 64000 },
};

/**
 * Apply upstream metadata corrections to a mutable array of models, then
 * re-bake canonical thinking metadata so generated catalogs always carry the
 * deriver's output for the post-policy spec.
 */
export function applyGeneratedModelPolicies(models: ModelSpec<Api>[]): void {
	for (const model of models) {
		applyGeneratedModelPolicy(model);
		rebakeModelThinking(model);
	}
}

/**
 * Recompute `thinking` from the canonical deriver, replacing any baked value.
 * Mirrors `buildModel`'s trust-or-derive resolution with trust disabled: the
 * generator is the authority that produces the trusted values. Collapsed
 * effort-tier variants are exempt — their collapse table authored the
 * routing/off-suppression metadata and the deriver cannot reproduce it.
 */
export function rebakeModelThinking(model: ModelSpec<Api>): void {
	if (isVariantCollapsedSpec(model)) return;
	const requiresProviderAuthoredEffort =
		model.provider === "umans" && (model.thinking?.requiresEffort === true || model.id === "umans-kimi-k2.7");
	const thinking = resolveModelThinking({ ...model, thinking: undefined }, buildCompat(model));
	if (thinking) {
		model.thinking = requiresProviderAuthoredEffort ? { ...thinking, requiresEffort: true } : thinking;
	} else {
		delete model.thinking;
	}
}

/**
 * Link OpenAI model variants to their context promotion targets.
 *
 * When a model's context is exhausted, the agent can promote to a sibling model
 * on the same provider:
 * - `codex-spark` variants promote to the full `gpt-5.5`.
 * - every `gpt-5.5` flavor (base, `-pro`, `-instant`, dated snapshots, and
 *   namespaced ids like `openai/gpt-5.5`) promotes to its `gpt-5.4` sibling.
 *
 * The sibling is resolved by parsed version + matching provider/api, not a
 * hardcoded bare id, so namespaced (`openrouter/openai/gpt-5.4`), dotted
 * (`amazon-bedrock` `openai.gpt-5.4`), and dated (`gpt-5.4-2026-03-05`) ids all
 * link. The runtime still gates on the target actually being larger
 * (`#resolveContextPromotionTarget`), so an equal/smaller sibling is a harmless
 * no-op rather than a counterproductive switch.
 */
export function linkOpenAIPromotionTargets(models: ModelSpec<Api>[]): void {
	for (const candidate of models) {
		const parsedCandidate = parseKnownModel(candidate.id);
		if (parsedCandidate.family !== "openai") continue;
		let targetVersion: string | undefined;
		if (parsedCandidate.variant === "codex-spark") {
			targetVersion = "5.5";
		} else if (semverEqual(parsedCandidate.version, "5.5")) {
			targetVersion = "5.4";
		} else {
			continue;
		}
		// Prefer the plainest sibling id (shortest bare segment) so the base model
		// wins over `-pro`/`-mini`/`-nano` siblings that parse to the same version.
		let fallback: ModelSpec<Api> | undefined;
		let fallbackBareLength = Number.POSITIVE_INFINITY;
		for (const model of models) {
			if (model === candidate) continue;
			if (model.provider !== candidate.provider || model.api !== candidate.api) continue;
			const parsed = parseKnownModel(model.id);
			if (parsed.family !== "openai" || !semverEqual(parsed.version, targetVersion)) continue;
			const bareLength = bareModelId(model.id).length;
			if (bareLength < fallbackBareLength) {
				fallback = model;
				fallbackBareLength = bareLength;
			}
		}
		if (!fallback) continue;
		candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}

/**
 * Fill `null` `contextWindow` / `maxTokens` from a model's family reference.
 * Proxies and resellers serve first-party models under mangled ids and report
 * no limits, so discovery emits `null` rather than a magic number. Two lookups
 * cover the two ways an id drifts from its family head:
 *
 * 1. Compact / re-spelled versions (`venice/openai-gpt-54-mini`,
 *    `aimlapi/moonshot/kimi-k2-5`) — the canonical-equivalence index maps these
 *    to their head (`gpt-5.4-mini`, `kimi-k2.5`).
 * 2. Org-namespace variance (`aimlapi/alibaba/qwen3-32b` vs `groq/qwen/qwen3-32b`)
 *    — these never share an exact id, so the bare model-segment (`qwen3-32b`)
 *    is resolved through the proxy-reference suffix-alias map instead.
 *
 * Both lookups draw metadata from the proxy-reference index, which prefers the
 * largest limits with complete cache pricing and first-party providers, and
 * excludes zero-cost xai-oauth subscription entries (inflated `maxTokens`) as
 * sources. The canonical head is tried first (more precise); the segment alias
 * backfills any field it leaves null.
 *
 * Only `null` fields are filled; provider-specific limits that discovery
 * returned explicitly are never overwritten.
 */
export function applyCanonicalLimitFallback(models: ModelSpec<Api>[]): void {
	if (!models.some(model => model.contextWindow === null || model.maxTokens === null)) {
		return;
	}
	// The identity indices read only id/provider/name/limit/cost fields, all of
	// which ModelSpec carries — no built-only field (compat/thinking) is read —
	// so reusing the runtime Model<Api> builders over raw specs is sound.
	const catalog = models as unknown as readonly Model<Api>[];
	const referenceData = buildCanonicalReferenceData(catalog);
	const canonicalIndex = buildCanonicalModelIndex(catalog, referenceData);
	const referenceIndex = buildModelReferenceIndex(catalog);

	for (const model of models) {
		if (model.contextWindow !== null && model.maxTokens !== null) {
			continue;
		}
		const canonicalId = canonicalIndex.bySelector.get(`${model.provider}/${model.id}`.toLowerCase());
		const segment = getLongestModelLikeIdSegment(model.id);
		const references = [
			canonicalId ? resolveModelReference(canonicalId, referenceIndex) : undefined,
			segment ? referenceIndex.suffixAlias.get(segment) : undefined,
		];
		for (const reference of references) {
			if (!reference || (reference.provider === model.provider && reference.id === model.id)) {
				continue;
			}
			if (model.contextWindow === null && reference.contextWindow !== null) {
				model.contextWindow = reference.contextWindow;
			}
			if (model.maxTokens === null && reference.maxTokens !== null) {
				model.maxTokens = reference.maxTokens;
			}
			if (model.contextWindow !== null && model.maxTokens !== null) {
				break;
			}
		}
	}
}

function applyGeneratedModelPolicy(model: ModelSpec<Api>): void {
	const copilotLimits = model.provider === "github-copilot" ? COPILOT_GENERATED_LIMITS[model.id] : undefined;
	if (copilotLimits) {
		model.contextWindow = copilotLimits.contextWindow;
		model.maxTokens = copilotLimits.maxTokens;
	}

	if (model.provider === "ollama-cloud") {
		model.omitMaxOutputTokens = true;
	}

	// GLM Coding Plan: GLM-5.2 is the selectable 1M served id; pin it so
	// endpoint discovery or older bundled fallbacks cannot regress to 200k.
	if ((model.provider === "zai" || model.provider === "zhipu-coding-plan") && model.id === "glm-5.2") {
		model.contextWindow = 1_000_000;
		model.maxTokens = 131_072;
	}
	// MiniMax-M3: 512K is the standard pricing tier boundary, not the
	// model ceiling. Pin every long-context provider that serves the model
	// (anthropic-messages `minimax`/`minimax-cn` and the openai-completions
	// MiniMax Coding/Token Plan endpoints `minimax-code`/`minimax-code-cn`)
	// to the documented 1M tier.
	if (
		model.id === "MiniMax-M3" &&
		(model.provider === "minimax" ||
			model.provider === "minimax-cn" ||
			model.provider === "minimax-code" ||
			model.provider === "minimax-code-cn")
	) {
		model.contextWindow = 1_000_000;
	}

	if (
		model.api === "openai-completions" &&
		(model.provider === "minimax-code" || model.provider === "minimax-code-cn")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		};
		delete model.compat.thinkingFormat;
	}
	if (model.api === "openai-completions" && model.provider === "opencode-go" && isMimoModelIdOrName(model.id)) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
		};
	}
	if (model.api === "openai-completions" && model.provider === "opencode-go" && model.id === "kimi-k2.7-code") {
		model.compat = {
			...(model.compat ?? {}),
			supportsForcedToolChoice: false,
		};
	}
	if (
		model.api === "openai-completions" &&
		model.provider === "opencode-go" &&
		(model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
		};
	}
	const parsedModel = parseKnownModel(model.id);
	const applyPatchToolType = inferGeneratedApplyPatchToolType(model, parsedModel);
	if (applyPatchToolType) {
		model.applyPatchToolType = applyPatchToolType;
	} else {
		delete model.applyPatchToolType;
	}
	if (parsedModel.family === "anthropic") {
		applyAnthropicCatalogPolicy(model, parsedModel);
	}
	if (parsedModel.family === "openai") {
		applyOpenAICatalogPolicy(model, parsedModel);
	}
}

function applyAnthropicCatalogPolicy(model: ModelSpec<Api>, parsedModel: AnthropicModel): void {
	// Claude Opus 4.5: models.dev reports 3x the correct cache pricing.
	if (model.provider === "anthropic" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.5")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
	}

	// Bedrock Opus 4.6: upstream metadata is stale for cache pricing and context.
	if (model.provider === "amazon-bedrock" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.6")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
		model.contextWindow = 1000000;
		model.maxTokens = 128000;
	}

	// Claude Fable/Mythos 5: Anthropic's /v1/models omits token limits and
	// pricing, and models.dev lags new releases. Pin authoritative values from
	// the model card (1M context / 128k output) and pricing docs ($10 in / $50
	// out per MTok).
	if (model.provider === "anthropic" && isFableOrMythos(parsedModel.kind)) {
		model.contextWindow = 1_000_000;
		model.maxTokens = 128_000;
		model.cost.input = 10;
		model.cost.output = 50;
		model.cost.cacheRead = 1;
		model.cost.cacheWrite = 12.5;
	}
}

function inferGeneratedApplyPatchToolType(
	model: ModelSpec<Api>,
	parsedModel: ParsedModel,
): ModelSpec<Api>["applyPatchToolType"] {
	if (parsedModel.family !== "openai" || parsedModel.version.major !== 5) {
		return undefined;
	}
	if (model.provider === "openai" && model.api === "openai-responses") {
		return "freeform";
	}
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return "freeform";
	}
	return undefined;
}

function applyOpenAICatalogPolicy(model: ModelSpec<Api>, parsedModel: OpenAIModel): void {
	// GPT-5.6 Sol can opt into its native 1.05M context window on Codex,
	// including Max-plan accounts. Codex discovery still reports the 272K
	// default, so pin the expanded limit for OMPK's compaction accounting.
	if (
		model.api === "openai-codex-responses" &&
		semverEqual(parsedModel.version, "5.6") &&
		bareModelId(model.id) === "gpt-5.6-sol"
	) {
		model.contextWindow = 1_050_000;
		model.maxTokens = 128_000;
	}

	// Codex models: 400K figure includes output budget; input window is 272K.
	if (parsedModel.variant.startsWith("codex") && parsedModel.variant !== "codex-spark") {
		model.contextWindow = 272000;
		return;
	}
	// GPT-5.4 mini/nano use plain OpenAI IDs on the Codex transport, but Codex still
	// enforces the lower prompt budget for these variants. Codex discovery can also
	// report inconsistent priorities for the GPT-5.4 family, so normalize by parsed
	// variant instead of special-casing raw model ids.
	if (model.api === "openai-codex-responses" && semverEqual(parsedModel.version, "5.4")) {
		const normalizedPriority = CODEX_GPT_5_4_PRIORITY_BY_VARIANT[parsedModel.variant];
		if (normalizedPriority !== undefined) {
			model.priority = normalizedPriority;
		}
		if (parsedModel.variant === "mini" || parsedModel.variant === "nano") {
			model.contextWindow = 272000;
		}
	}
}
