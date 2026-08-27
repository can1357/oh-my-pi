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
import { isMimoModelIdOrName } from "../src/identity/family";
import { getLongestModelLikeIdSegment } from "../src/identity/id";
import { buildModelReferenceIndex, resolveModelReference } from "../src/identity/reference";
import { resolveModelThinking } from "../src/model-thinking";
import { isOllamaCloudOutputCapped, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS } from "../src/provider-models/ollama";
import {
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	applyXaiResponsesThinkingPolicy,
	OPENAI_GPT_56_LONG_CONTEXT_COSTS,
	resolveWaferServerlessThinkingFormat,
} from "../src/provider-models/openai-compat";
import type { Api, LongContextTokenCost, Model, ModelSpec } from "../src/types";
import { isVariantCollapsedSpec } from "../src/variant-collapse";
import { buildCanonicalModelIndex, buildCanonicalReferenceData } from "./equivalence";

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

/**
 * `stencil.so` currently lists `jp.anthropic.claude-opus-5`, but AWS's own
 * Bedrock model card documents only `anthropic.claude-opus-5` plus the `us.`,
 * `eu.`, `au.`, and `global.` Geo/Global inference-profile IDs under
 * Programmatic Access; Japan regions are marked unsupported for Geo inference
 * in the same card's regional-availability table. Bedrock rejects an
 * undocumented inference-profile ID outright, so drop this specific upstream
 * row rather than ship a selector that 4xxs on first use (PR #6591 review).
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
 */
export function dropUnsupportedBedrockGeoIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => !(model.provider === "amazon-bedrock" && model.id === "jp.anthropic.claude-opus-5"));
}

const BEDROCK_MANTLE_OPENAI_MODEL_IDS: Record<string, true> = {
	"openai.gpt-5.4": true,
	"openai.gpt-5.5": true,
	"openai.gpt-5.6-luna": true,
	"openai.gpt-5.6-sol": true,
	"openai.gpt-5.6-terra": true,
};

/**
 * models.dev exposes these Responses-only models under amazon-bedrock, whose
 * descriptor uses Converse. The working Mantle rows come from the static seed.
 */
export function dropBedrockMantleOpenAIModels(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => !(model.provider === "amazon-bedrock" && BEDROCK_MANTLE_OPENAI_MODEL_IDS[model.id]));
}

/** True when any component of a model's per-million-token cost is nonzero. */
export function hasBillableCost(cost: ModelSpec["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

/**
 * Providers whose first-party list prices back-fill Antigravity's unpriced
 * rows, in lookup order. Antigravity discovery reports no pricing (the
 * subscription bills upstream), so without this the whole provider surfaces
 * $0 cost for every request. Antigravity bills through Google, so Vertex
 * prices outrank Anthropic list prices for Claude ids.
 */
const ANTIGRAVITY_PRICING_PEERS = ["google", "google-vertex", "anthropic"] as const;

/**
 * Antigravity ids whose Google peer ships under a different id: Gemini
 * previews carry a `-preview` suffix on the Google API, Claude ids carry a
 * Vertex `@<version>` suffix. A dangling alias (retired Vertex id) falls back
 * to the plain-id lookup, i.e. Anthropic list prices for Claude.
 */
const ANTIGRAVITY_PRICING_ID_ALIASES: Readonly<Record<string, string>> = {
	"gemini-3-flash": "gemini-3-flash-preview",
	"gemini-3-pro": "gemini-3-pro-preview",
	"gemini-3.1-pro": "gemini-3.1-pro-preview",
	"claude-opus-4-5": "claude-opus-4-5@20251101",
	"claude-opus-4-6": "claude-opus-4-6@default",
	"claude-sonnet-4-5": "claude-sonnet-4-5@20250929",
	"claude-sonnet-4-6": "claude-sonnet-4-6@default",
};

/**
 * Price `google-antigravity` models at their first-party equivalents: Gemini
 * ids at Google API list prices, Claude ids at Google Vertex list prices
 * (falling back to Anthropic). Models without a priced peer (gpt-oss,
 * internal tab models) keep zero cost.
 */
export function applyAntigravityPricingFallback(models: readonly ModelSpec[]): ModelSpec[] {
	const peerCosts = new Map<string, ModelSpec["cost"]>();
	for (const peer of ANTIGRAVITY_PRICING_PEERS) {
		for (const model of models) {
			if (model.provider === peer && hasBillableCost(model.cost) && !peerCosts.has(model.id)) {
				peerCosts.set(model.id, model.cost);
			}
		}
	}
	return models.map(model => {
		if (model.provider !== "google-antigravity" || hasBillableCost(model.cost)) {
			return model;
		}
		const alias = ANTIGRAVITY_PRICING_ID_ALIASES[model.id];
		const cost = (alias ? peerCosts.get(alias) : undefined) ?? peerCosts.get(model.id);
		return cost ? { ...model, cost: { ...cost } } : model;
	});
}

const CODEX_GPT_5_4_PRIORITY_BY_VARIANT: Partial<Record<OpenAIVariant, number>> = {
	base: 0,
	mini: 1,
	nano: 2,
};

const CODEX_GPT_5_6_1M_MODEL_IDS: Record<string, true> = {
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

const OPENAI_GPT_5_6_LONG_CONTEXT_COST_BY_MODEL_ID: Readonly<Record<string, LongContextTokenCost>> = {
	"daybreak-blue-latest": OPENAI_GPT_56_LONG_CONTEXT_COSTS.sol,
	"gpt-5.6": OPENAI_GPT_56_LONG_CONTEXT_COSTS.sol,
	"gpt-5.6-luna": OPENAI_GPT_56_LONG_CONTEXT_COSTS.luna,
	"gpt-5.6-sol": OPENAI_GPT_56_LONG_CONTEXT_COSTS.sol,
	"gpt-5.6-terra": OPENAI_GPT_56_LONG_CONTEXT_COSTS.terra,
};

const OPENAI_NONE_EFFORT_MODEL_IDS: Record<string, true> = {
	"daybreak-blue-latest": true,
	"daybreak-red-latest": true,
	"gpt-5.6": true,
	"gpt-5.6-cyber": true,
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

function modelOrRequestIdValue<T>(
	model: Pick<ModelSpec<Api>, "id" | "requestModelId">,
	values: Readonly<Record<string, T>>,
): T | undefined {
	const direct = values[bareModelId(model.id)];
	if (direct !== undefined) return direct;
	return model.requestModelId === undefined ? undefined : values[bareModelId(model.requestModelId)];
}

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
 * effort-tier variants and provider-authored wire ladders are exempt because
 * the generic deriver cannot reproduce that routing metadata.
 */
export function rebakeModelThinking(model: ModelSpec<Api>): void {
	if (isVariantCollapsedSpec(model)) return;
	if (
		model.compat &&
		"thinkingFormat" in model.compat &&
		model.compat.thinkingFormat === "chat-template" &&
		model.thinking
	)
		return;
	if (
		model.provider === "alibaba-token-plan" &&
		(model.id === "qwen3.8-max-preview" || model.id === "qwen3.8-max") &&
		model.thinking
	) {
		return;
	}
	if (model.provider === "openrouter" && model.thinking?.requiresEffort === true) return;
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

/**
 * Pin the max-output figure for Ollama Cloud models whose deployment enforces a
 * lower ceiling than their advertised window.
 *
 * Ollama's `/api/show` never reports a per-model output cap, so discovery and
 * previous snapshots leave `maxTokens` at the full context window (or a stale
 * conservative fallback, as with `deepseek-v4-flash:0731`). DeepSeek V4
 * Pro/Flash deployments actually reject any output budget above
 * {@link OLLAMA_CLOUD_MAX_OUTPUT_TOKENS} (ollama/ollama#16890, #3392/#3394), so
 * pin those ids to `min(contextWindow, ceiling)` — the true amount the endpoint
 * accepts (#7266). Other cloud models keep their discovered limits.
 */
export function applyOllamaCloudOutputCap(models: ModelSpec<Api>[]): void {
	for (const model of models) {
		if (model.provider !== "ollama-cloud" || model.contextWindow === null) continue;
		if (!isOllamaCloudOutputCapped(model.id)) continue;
		model.maxTokens = Math.min(model.contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS);
	}
}

function applyGeneratedModelPolicy(model: ModelSpec<Api>): void {
	if ((model.provider === "xai" || model.provider === "xai-oauth") && model.api === "openai-responses") {
		const updated = applyXaiResponsesThinkingPolicy(model as ModelSpec<"openai-responses">);
		model.compat = updated.compat;
	}
	const copilotLimits = model.provider === "github-copilot" ? COPILOT_GENERATED_LIMITS[model.id] : undefined;
	if (copilotLimits) {
		model.contextWindow = copilotLimits.contextWindow;
		model.maxTokens = copilotLimits.maxTokens;
	}
	if (model.provider === "alibaba-token-plan") {
		const reference = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(candidate => candidate.id === model.id);
		if (reference) model.name = reference.name;
	}

	if (model.provider === "ollama-cloud") {
		model.omitMaxOutputTokens = true;
	}

	// GLM Coding Plan: the selectable 1M-context served ids; pin them so
	// endpoint discovery or older bundled fallbacks cannot regress to 200k.
	// GLM-5.3 succeeds GLM-5.2 with the same 1M context window.
	if (
		(model.provider === "zai" || model.provider === "zhipu-coding-plan") &&
		(model.id === "glm-5.2" || model.id === "glm-5.3")
	) {
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
	if (model.api === "openai-completions" && model.provider === "wafer-serverless" && model.reasoning) {
		const thinkingFormat = resolveWaferServerlessThinkingFormat(model.id, undefined);
		if (thinkingFormat === "zai") {
			model.compat = {
				...(model.compat ?? {}),
				thinkingFormat,
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			};
		}
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
		(model.api === "openai-completions" || model.api === "openai-responses") &&
		model.provider === "opencode-go" &&
		(model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
			maxTokensField: "max_tokens",
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
	// Claude Opus 4.5: stencil.so reports 3x the correct cache pricing.
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
	// pricing, and stencil.so lags new releases. Pin authoritative values from
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
	const isFirstPartyResponses = model.provider === "openai" && model.api === "openai-responses";
	// Subscription Codex rates usage at the same >272K long-context tier as the
	// API (openai/codex#32486), so first-party Codex SKUs carry the tier too —
	// it drives both cost attribution and the extended-context window clamp.
	const isFirstPartyCodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (isFirstPartyResponses && modelOrRequestIdValue(model, OPENAI_NONE_EFFORT_MODEL_IDS)) {
		model.compat = { ...(model.compat ?? {}), reasoningDisableMode: "none-effort" };
	}
	const longContextCost =
		isFirstPartyResponses || isFirstPartyCodex
			? modelOrRequestIdValue(model, OPENAI_GPT_5_6_LONG_CONTEXT_COST_BY_MODEL_ID)
			: undefined;
	if (longContextCost) {
		model.cost = { ...model.cost, longContext: longContextCost };
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
	// GPT-5.6 luna/sol/terra on the Codex transport: OpenAI enabled a 1M-token
	// window for subscription Codex (2026-08-16), but the Codex model registry
	// still reports the stale 272000 (openai/codex#38917), so floor the bundled
	// window at 1,000,000. Daybreak aliases are excluded — the registry actively
	// reports their true window.
	if (model.api === "openai-codex-responses" && CODEX_GPT_5_6_1M_MODEL_IDS[model.id]) {
		model.contextWindow = Math.max(model.contextWindow ?? 0, 1_000_000);
	}
}
