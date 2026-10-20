/**
 * Token accounting for remote compaction requests.
 *
 * A compaction endpoint bills its own request, so the session ledger must see
 * what it billed. The wire shape differs per protocol — the Responses API
 * reports `input_tokens`/`output_tokens`, an OpenAI-compatible chat-completions
 * server reports `prompt_tokens`/`completion_tokens` — so both normalize into
 * one record.
 */

import { isRecord } from "@oh-my-pi/pi-utils";

/** What one remote compaction request billed, normalized across wire shapes. */
export interface RemoteCompactionUsage {
	/** Input tokens as the provider counted them, cached tokens included. */
	inputTokens: number;
	/** Output tokens the provider billed, reasoning included. */
	outputTokens: number;
	/** The provider's own total for the request. */
	totalTokens: number;
	/** Cached input tokens the provider billed at the cache-read rate. */
	cachedInputTokens?: number;
	/** Reasoning tokens the provider billed as output. */
	reasoningOutputTokens?: number;
}

function numberField(source: Record<string, unknown>, field: string): number | undefined {
	const value = source[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detailsField(source: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
	const value = source[field];
	return isRecord(value) ? value : undefined;
}

/**
 * Parse a Responses-shaped `usage` object.
 *
 * `input_tokens` includes the cached tokens the provider bills separately, so
 * the caller subtracts them before charging the input rate.
 */
export function parseResponsesUsage(raw: unknown): RemoteCompactionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const inputTokens = numberField(raw, "input_tokens");
	const outputTokens = numberField(raw, "output_tokens");
	const totalTokens = numberField(raw, "total_tokens");
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const inputDetails = detailsField(raw, "input_tokens_details");
	const outputDetails = detailsField(raw, "output_tokens_details");
	const cachedInputTokens = inputDetails ? numberField(inputDetails, "cached_tokens") : undefined;
	const reasoningOutputTokens = outputDetails ? numberField(outputDetails, "reasoning_tokens") : undefined;
	return {
		inputTokens,
		outputTokens,
		totalTokens: totalTokens ?? inputTokens + outputTokens,
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
		...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
	};
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
	const totalTokens = numberField(raw, "total_tokens");
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const inputDetails = detailsField(raw, "prompt_tokens_details");
	const outputDetails = detailsField(raw, "completion_tokens_details");
	const cachedInputTokens = inputDetails ? numberField(inputDetails, "cached_tokens") : undefined;
	const reasoningOutputTokens = outputDetails ? numberField(outputDetails, "reasoning_tokens") : undefined;
	return {
		inputTokens,
		outputTokens,
		totalTokens: totalTokens ?? inputTokens + outputTokens,
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
		...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
	};
}
