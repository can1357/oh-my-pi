/**
 * Kimi Code provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Kimi offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.kimi.com/coding/v1/chat/completions
 * - Anthropic: https://api.kimi.com/coding/v1/messages
 *
 * Each discovered model selects its server-declared protocol; legacy models
 * without protocol metadata retain the Anthropic-compatible default.
 */

import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	/** Explicit API format override. Defaults to the model's resolved protocol policy. */
	format?: KimiApiFormat;
}

/**
 * Stream from Kimi Code, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async header fetching happens internally.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	const defaultFormat = model.compat.kimiApiFormat ?? options?.format;
	if (defaultFormat === undefined) {
		throw new Error(`Kimi Code model ${model.id} has no resolved API format`);
	}
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultFormat,
		anthropicThinkingMode: model.compat.thinkingFormat === "kimi" ? "anthropic-adaptive" : undefined,
		forwardCacheOptions: true,
		extraHeaders: getKimiCommonHeaders,
	});
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
