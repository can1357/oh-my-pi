/**
 * Qwen Cloud (Alibaba Model Studio) provider - wraps OpenAI or Anthropic API
 * based on format setting.
 *
 * Qwen Cloud exposes both an OpenAI-compatible and an Anthropic-compatible
 * surface against the same account:
 * - OpenAI: https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
 * - Anthropic: https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages
 *
 * Discovery runs through the OpenAI surface (the Anthropic route serves no
 * `/models`); the chat transport defaults to OpenAI, with the Anthropic path
 * available for callers that prefer it.
 */

import {
	QWEN_CLOUD_ANTHROPIC_BASE_URL,
	QWEN_CLOUD_OPENAI_BASE_URL,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type QwenCloudApiFormat = OpenAIAnthropicApiFormat;

export interface QwenCloudOptions extends OpenAIAnthropicShimOptions {
	/** API format: "openai" (default) or "anthropic". */
	format?: QwenCloudApiFormat;
}

/**
 * Stream from Qwen Cloud, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async processing happens internally.
 */
export function streamQwenCloud(
	model: Model<"openai-completions">,
	context: Context,
	options?: QwenCloudOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: QWEN_CLOUD_ANTHROPIC_BASE_URL,
		openaiBaseUrl: QWEN_CLOUD_OPENAI_BASE_URL,
		defaultFormat: "openai",
	});
}

/**
 * Check if a model is a Qwen Cloud model.
 */
export function isQwenCloudModel(model: Model<Api>): boolean {
	return model.provider === "qwen-cloud";
}
