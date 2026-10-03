import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, mapEffortToAnthropicAdaptiveEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Model } from "../../types";
import type { KiroModelRequestFields } from "./types";

/**
 * Resolve the request's effort against the model's live schema.
 *
 * Clamping is delegated to the shared `clampThinkingLevelForModel` contract,
 * which selects the greatest supported level at or below the request. A local
 * implementation previously rounded *up*, so a `medium` request against a
 * `[low, high]` catalog silently escalated to `high`.
 */
function resolveEffort(model: Model, requested: Effort | undefined): Effort | undefined {
	const thinking = model.thinking;
	if (!thinking || thinking.efforts.length === 0) return undefined;
	return clampThinkingLevelForModel(model, requested ?? thinking.defaultLevel ?? Effort.Medium);
}

/**
 * Effective output-token limit for the request: the caller's cap when supplied,
 * always bounded by the model's own ceiling so the serialized limit stays valid
 * for the selected model.
 */
function resolveMaxTokens(model: Model, requested: number | undefined): number | undefined {
	const ceiling = model.maxTokens;
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return ceiling ?? undefined;
	const bounded = Math.floor(requested);
	return ceiling ? Math.min(bounded, ceiling) : bounded;
}

/** Map only schema-derived model metadata; unknown thinking families are omitted. */
export function buildKiroModelRequestFields(
	model: Model,
	requested: Effort | undefined,
	hideThinkingSummary = false,
	maxTokens?: number,
): KiroModelRequestFields | undefined {
	const effort = resolveEffort(model, requested);
	if (effort === undefined || !model.thinking) return undefined;
	if (model.thinking.mode === "anthropic-adaptive") {
		// The adaptive family has no separate numeric budget: `effort` selects the
		// reasoning tier and `max_tokens` bounds the whole output, so the budget
		// must be derived from the effective request limit rather than the catalog
		// ceiling.
		const limit = resolveMaxTokens(model, maxTokens);
		return {
			thinking: { type: "adaptive", display: hideThinkingSummary ? "omitted" : "summarized" },
			output_config: { effort: mapEffortToAnthropicAdaptiveEffort(model, effort) },
			...(limit ? { max_tokens: limit } : {}),
		};
	}
	if (model.thinking.mode === "effort") {
		return { reasoning: { mode: "standard", effort: model.thinking.effortMap?.[effort] ?? effort } };
	}
	return undefined;
}
