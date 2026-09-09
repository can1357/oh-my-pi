/**
 * Synthetic provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Synthetic offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.synthetic.new/openai/v1/chat/completions
 * - Anthropic: https://api.synthetic.new/anthropic/v1/messages
 *
 * @see https://dev.synthetic.new/docs/api/overview
 */

import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type SyntheticApiFormat = OpenAIAnthropicApiFormat;

const SYNTHETIC_NEW_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_NEW_ANTHROPIC_BASE_URL = "https://api.synthetic.new/anthropic";

export interface SyntheticOptions extends OpenAIAnthropicShimOptions {
	/** API format: "openai" or "anthropic". Default: "openai" */
	format?: SyntheticApiFormat;
}

/**
 * Stream from Synthetic, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async processing happens internally.
 */
export function streamSynthetic(
	model: Model<"openai-completions">,
	context: Context,
	options?: SyntheticOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: SYNTHETIC_NEW_ANTHROPIC_BASE_URL,
		openaiBaseUrl: SYNTHETIC_NEW_BASE_URL,
		defaultFormat: "openai",
	});
}

/**
 * Check if a model is a Synthetic model.
 */
export function isSyntheticModel(model: Model<Api>): boolean {
	return model.provider === "synthetic";
}
