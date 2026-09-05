/**
 * Nebius Token Factory provider - thin wrapper over the OpenAI-compatible API.
 *
 * Nebius exposes a single OpenAI-compatible surface (no Anthropic protocol):
 * - Default base URL: https://api.tokenfactory.nebius.com/v1
 * - Auth: plain Bearer token (Authorization: Bearer <NEBIUS_API_KEY>)
 *
 * Inference honors `model.baseUrl`, so a `NEBIUS_BASE_URL` region override
 * flows through discovery onto the model and reaches the same region here.
 * The override is also applied here so bundled and cached rows (which keep
 * the global endpoint) follow it even when discovery never restamped them.
 *
 * @see https://docs.tokenfactory.nebius.com/
 */

import { normalizeNebiusBaseUrl } from "@oh-my-pi/pi-catalog/provider-models";
import { $env } from "@oh-my-pi/pi-utils";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { type OpenAIAnthropicShimOptions, streamOpenAIAnthropicShim } from "./openai-anthropic-shim";

export type NebiusOptions = OpenAIAnthropicShimOptions;

/**
 * Stream from Nebius Token Factory. Single-protocol OpenAI: the format option
 * is pinned to "openai" and the Anthropic endpoint is never used.
 * Returns synchronously like other providers - async processing happens internally.
 */
export function streamNebius(
	model: Model<"openai-completions">,
	context: Context,
	options?: NebiusOptions,
): AssistantMessageEventStream {
	const envBaseUrl = $env.NEBIUS_BASE_URL?.trim() ? normalizeNebiusBaseUrl($env.NEBIUS_BASE_URL) : undefined;
	return streamOpenAIAnthropicShim(
		model,
		context,
		{ ...options, format: "openai" },
		{ ...(envBaseUrl ? { openaiBaseUrl: envBaseUrl } : {}), defaultFormat: "openai" },
	);
}

/**
 * Check if a model is a Nebius model. Routing predicate called synchronously
 * by stream.ts dispatch, mirroring isSyntheticModel/isKimiModel.
 */
export function isNebiusModel(model: Model<Api>): boolean {
	return model.provider === "nebius";
}
