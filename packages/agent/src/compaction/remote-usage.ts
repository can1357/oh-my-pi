/**
 * Token accounting for remote compaction requests.
 *
 * A compaction endpoint bills its own request, so the session ledger must see
 * what it billed. The wire shape differs per protocol — the Responses API
 * reports `input_tokens`/`output_tokens`, an OpenAI-compatible chat-completions
 * server reports `prompt_tokens`/`completion_tokens` — so both normalize into
 * one record.
 *
 * The buckets come from the shared OpenAI accounting path, so a compaction
 * request is billed exactly like the equivalent Responses request: the
 * cache-write and provider-side orchestration buckets a reduced wire shape
 * used to drop are kept.
 */

import {
	calculateOpenAIUsageAccounting,
	calculateResponsesUsageAccounting,
	type OpenAIUsageAccounting,
	type ResponsesUsagePayload,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * What one remote compaction request billed, normalized across wire shapes.
 *
 * `inputTokens`/`outputTokens` are the provider's own counts — the Responses
 * API counts cached input inside `input_tokens`. `accounting` is the split the
 * ledger bills, produced by the shared OpenAI accounting path.
 */
export interface RemoteCompactionUsage {
	/** Input tokens as the provider counted them, cached tokens included. */
	inputTokens: number;
	/** Output tokens the provider billed, reasoning included. */
	outputTokens: number;
	/** The billed bucket split. */
	accounting: OpenAIUsageAccounting;
	/**
	 * Cost the provider reported for the request, when it reported one.
	 *
	 * A gateway (OpenRouter and BYOK providers) can bill the request itself
	 * and return the amount in `usage.cost` or in
	 * `usage.cost_details.upstream_inference_cost`. Returning only token
	 * accounting would discard what the provider charged.
	 */
	providerCost?: {
		/** Total cost the provider reported for the request. */
		total?: number;
		/** Upstream inference cost, for a BYOK request billed by the gateway. */
		upstreamInferenceCost?: number;
	};
}

function numberField(source: Record<string, unknown>, field: string): number | undefined {
	const value = source[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Like {@link numberField}, but keeps an explicit `null` so the shared
 * accounting reads the same payload the Responses path would read.
 */
function nullableNumberField(source: Record<string, unknown>, field: string): number | null | undefined {
	const value = source[field];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return value === null ? null : undefined;
}

function detailsField(source: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
	const value = source[field];
	return isRecord(value) ? value : undefined;
}

/**
 * Parse a Responses-shaped `usage` object.
 *
 * `input_tokens` includes the cached tokens the provider bills separately, so
 * the shared accounting splits it into the buckets the ledger charges.
 */
export function parseResponsesUsage(raw: unknown): RemoteCompactionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = numberField(raw, "input_tokens");
	const outputTokens = numberField(raw, "output_tokens");
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const inputDetails = detailsField(raw, "input_tokens_details");
	const outputDetails = detailsField(raw, "output_tokens_details");
	const payload: ResponsesUsagePayload = {
		input_tokens: nullableNumberField(raw, "input_tokens"),
		output_tokens: nullableNumberField(raw, "output_tokens"),
		total_tokens: nullableNumberField(raw, "total_tokens"),
		prompt_cache_hit_tokens: nullableNumberField(raw, "prompt_cache_hit_tokens"),
		prompt_cache_miss_tokens: nullableNumberField(raw, "prompt_cache_miss_tokens"),
	};
	if (inputDetails) {
		payload.input_tokens_details = {
			cached_tokens: nullableNumberField(inputDetails, "cached_tokens"),
			cache_write_tokens: nullableNumberField(inputDetails, "cache_write_tokens"),
			orchestration_input_tokens: nullableNumberField(inputDetails, "orchestration_input_tokens"),
			orchestration_input_cached_tokens: nullableNumberField(inputDetails, "orchestration_input_cached_tokens"),
		};
	}
	if (outputDetails) {
		payload.output_tokens_details = {
			reasoning_tokens: nullableNumberField(outputDetails, "reasoning_tokens"),
			orchestration_output_tokens: nullableNumberField(outputDetails, "orchestration_output_tokens"),
		};
	}
	const accounting = calculateResponsesUsageAccounting(payload);
	if (!accounting) return undefined;
	return { inputTokens, outputTokens, accounting };
}

/**
 * Parse a chat-completions-shaped `usage` object.
 *
 * `prompt_tokens` includes the cached tokens in `prompt_tokens_details`, just
 * like the Responses API counts cached input inside `input_tokens`.
 */
export function parseChatCompletionsUsage(raw: unknown): RemoteCompactionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = numberField(raw, "prompt_tokens");
	const outputTokens = numberField(raw, "completion_tokens");
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const inputDetails = detailsField(raw, "prompt_tokens_details");
	const outputDetails = detailsField(raw, "completion_tokens_details");
	// A gateway can report the warm cache through any of three fields: the
	// OpenAI `prompt_tokens_details.cached_tokens`, a top-level `cached_tokens`,
	// or Vertex's `cachedContentTokenCount`. Reading only the first would
	// charge the whole prompt as fresh input.
	const cachedTokens =
		(inputDetails ? numberField(inputDetails, "cached_tokens") : undefined) ??
		numberField(raw, "cached_tokens") ??
		numberField(raw, "cachedContentTokenCount");
	const cacheWriteTokens = inputDetails ? numberField(inputDetails, "cache_write_tokens") : undefined;
	const cacheHitTokens = numberField(raw, "prompt_cache_hit_tokens");
	const cacheMissTokens = numberField(raw, "prompt_cache_miss_tokens");
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: inputTokens,
		outputTokens: outputTokens,
		cachedTokens: cachedTokens ?? 0,
		reasoningTokens: (outputDetails ? numberField(outputDetails, "reasoning_tokens") : undefined) ?? 0,
		cacheWriteOpenRouter: cacheWriteTokens,
		cacheWriteDeepSeek: cacheMissTokens,
		hasDeepSeekCacheHitAndMiss: cacheHitTokens !== undefined && cacheMissTokens !== undefined,
	});
	return { inputTokens, outputTokens, accounting, ...parseProviderCost(raw) };
}

/**
 * The cost the provider reported for the request, if it reported one.
 *
 * A gateway bills the request itself and returns the amount either as
 * `usage.cost` (total) or as `usage.cost_details.upstream_inference_cost`
 * (the upstream inference part of a BYOK request).
 */
function parseProviderCost(raw: Record<string, unknown>): { providerCost?: RemoteCompactionUsage["providerCost"] } {
	const total = numberField(raw, "cost");
	const costDetails = detailsField(raw, "cost_details");
	const upstreamInferenceCost = costDetails ? numberField(costDetails, "upstream_inference_cost") : undefined;
	if (total === undefined && upstreamInferenceCost === undefined) return {};
	return { providerCost: { total, upstreamInferenceCost } };
}
