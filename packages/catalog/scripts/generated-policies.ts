/**
 * Generation-time catalog policies: upstream metadata corrections, derived
 * field baking, and promotion-target linking. Runs only from
 * `generate-models.ts` — none of this ships in the runtime bundle.
 */

import { modelLimitsFor, pricingPeerFor } from "../src/compat/behavior";
import { isCollapsedVariantSpec } from "../src/compat/collapse";
import { resolveModelPolicy } from "../src/compat/resolve";
import { compareRevision, parseRevision } from "../src/compat/revision";
import { classifyModel } from "../src/compat/taxonomy";
import { resolveCursorInput } from "../src/discovery/cursor";
import { bareModelId, getLongestModelLikeIdSegment } from "../src/identity/id";
import { buildModelReferenceIndex, resolveModelReference } from "../src/identity/reference";
import { isOllamaCloudOutputCapped, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS } from "../src/provider-models/ollama";
import { ALIBABA_TOKEN_PLAN_STATIC_MODELS } from "../src/provider-models/openai-compat";
import type { Api, Model, ModelSpec } from "../src/types";
import { buildCanonicalModelIndex, buildCanonicalReferenceData } from "./equivalence";

function revisionsEqual(left: string | undefined, right: string): boolean {
	if (left === undefined) return false;
	const parsedLeft = parseRevision(left);
	const parsedRight = parseRevision(right);
	return parsedLeft !== undefined && parsedRight !== undefined && compareRevision(parsedLeft, parsedRight) === 0;
}

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

/** True when any component of a model's per-million-token cost is nonzero. */
export function hasBillableCost(cost: ModelSpec["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

/**
 * Price `google-antigravity` models at their first-party equivalents via the
 * `pricing-peer` behavior rule: Gemini ids at Google API list prices, Claude
 * ids at Google Vertex list prices (falling back to Anthropic). Models
 * without a priced peer (gpt-oss, internal tab models) keep zero cost.
 */
export function applyAntigravityPricingFallback(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider !== "google-antigravity" || hasBillableCost(model.cost)) {
			return model;
		}
		const peer = pricingPeerFor("google-antigravity", model.id);
		if (!peer) {
			return model;
		}
		for (const candidateId of peer.peerId !== model.id ? [peer.peerId, model.id] : [model.id]) {
			for (const provider of peer.peers) {
				const match = models.find(
					candidate =>
						candidate.provider === provider && candidate.id === candidateId && hasBillableCost(candidate.cost),
				);
				if (match) return { ...model, cost: { ...match.cost } };
			}
		}
		return model;
	});
}

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
	if (isCollapsedVariantSpec(model)) return;
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
	if (model.provider === "cline-pass" && model.thinking) return;
	if (model.provider === "openrouter" && model.thinking?.requiresEffort === true) return;
	const requiresProviderAuthoredEffort =
		model.provider === "umans" && (model.thinking?.requiresEffort === true || model.id === "umans-kimi-k2.7");
	const thinking = resolveModelPolicy({ ...model, thinking: undefined }).thinking;
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
		const candidateIdentity = classifyModel(candidate.provider, candidate.id, { lenient: true });
		if (candidateIdentity.class !== "openai") continue;
		let targetVersion: string | undefined;
		if (candidateIdentity.family === "codex-spark") {
			targetVersion = "5.5";
		} else if (revisionsEqual(candidateIdentity.revision, "5.5")) {
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
			const identity = classifyModel(model.provider, model.id, { lenient: true });
			if (identity.class !== "openai" || !revisionsEqual(identity.revision, targetVersion)) continue;
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
	if (model.provider === "cursor") {
		model.input = resolveCursorInput(model.id, model.input);
	}
	const limits = modelLimitsFor(model.provider, model.id);
	if (limits) {
		if (limits.context !== undefined) model.contextWindow = limits.context;
		if (limits.maxTokens !== undefined) model.maxTokens = limits.maxTokens;
	}
	if (model.provider === "alibaba-token-plan") {
		const reference = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(candidate => candidate.id === model.id);
		if (reference) model.name = reference.name;
	}

	if (model.provider === "ollama-cloud") {
		model.omitMaxOutputTokens = true;
	}
}
