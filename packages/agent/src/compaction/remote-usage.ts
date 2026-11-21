/**
 * Token and cost accounting for remote compaction requests.
 *
 * A compaction endpoint bills its own request, so the session ledger must see
 * what it billed. The wire shape differs per protocol — the Responses API
 * reports `input_tokens`/`output_tokens`, an OpenAI-compatible chat-completions
 * server reports `prompt_tokens`/`completion_tokens` — so both normalize into
 * one billed record.
 *
 * Both normalize through the accounting path their own lane already uses, so a
 * compaction request is billed exactly like the equivalent turn: the cache-write
 * and provider-side orchestration buckets, the catalog price and a
 * gateway-reported charge all come from that shared code instead of a second
 * implementation here.
 */

import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { parseChunkUsage } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyProviderReportedCost,
	calculateResponsesUsageAccounting,
	type ResponsesUsagePayload,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * What one remote compaction request billed: the buckets the ledger charges,
 * priced at the model's catalog cost and adjusted to a charge the provider
 * reported itself.
 */
export type RemoteCompactionUsage = Usage;

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
export function parseResponsesUsage(raw: unknown, model: Model): RemoteCompactionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = numberField(raw, "input_tokens");
	const outputTokens = numberField(raw, "output_tokens");
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const inputDetails = detailsField(raw, "input_tokens_details");
	const outputDetails = detailsField(raw, "output_tokens_details");
	const payload: ResponsesUsagePayload = {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
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
	const usage: Usage = {
		...accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	applyProviderReportedCost(model, usage, raw);
	return usage;
}

/**
 * Parse a chat-completions-shaped `usage` object.
 *
 * `prompt_tokens` includes the cached tokens the provider bills separately,
 * and the OpenAI-completions lane already owns that split — the cache-token
 * fallbacks, DeepSeek's hit/miss pair, the gateway-reported charge — so a
 * compaction request is billed through it rather than re-deriving the buckets.
 */
export function parseChatCompletionsUsage(raw: unknown, model: Model): RemoteCompactionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	// A usage object without either count is not a bill for this request.
	if (numberField(raw, "prompt_tokens") === undefined || numberField(raw, "completion_tokens") === undefined) {
		return undefined;
	}
	return parseChunkUsage(raw, model, undefined);
}
