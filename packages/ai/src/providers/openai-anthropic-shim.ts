/**
 * Shared implementation for providers that expose BOTH an OpenAI-compatible
 * and an Anthropic-compatible API surface against the same model catalog
 * (currently Kimi Code and Synthetic).
 *
 * Each call site supplies the provider-specific bits (base URLs, default
 * format, optional extra headers); the streaming/forwarding plumbing lives
 * here once.
 */

import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import * as AIError from "../error";
import { ANTHROPIC_THINKING, mapAnthropicToolChoice } from "../stream";
import type { Context, Model, ModelSpec, SimpleStreamOptions, ThinkingControlMode } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";

export type OpenAIAnthropicApiFormat = "openai" | "anthropic";

export interface OpenAIAnthropicShimOptions extends SimpleStreamOptions {
	/** API format: "openai" or "anthropic". */
	format?: OpenAIAnthropicApiFormat;
}

export interface OpenAIAnthropicShimConfig {
	/** Base URL for the Anthropic-compatible endpoint (without trailing /v1/messages). */
	anthropicBaseUrl: string;
	/** Optional override for the OpenAI-compatible base URL. If omitted, `model.baseUrl` is used as-is. */
	openaiBaseUrl?: string;
	/** Default API format when caller does not specify one. */
	defaultFormat: OpenAIAnthropicApiFormat;
	/** Thinking transport used when this provider's Anthropic endpoint differs from generic budget semantics. */
	anthropicThinkingMode?: ThinkingControlMode;
	/** Forward cache-retention and request-metadata options to the selected transport. Default: false. */
	forwardCacheOptions?: boolean;
	/** Provider-specific headers (e.g. auth/session) merged ahead of user-supplied headers. */
	extraHeaders?: () => Record<string, string>;
}

/**
 * Stream from an OpenAI-or-Anthropic compatible provider. Returns synchronously;
 * async header fetching and stream piping happen internally.
 */
export function streamOpenAIAnthropicShim(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAIAnthropicShimOptions | undefined,
	config: OpenAIAnthropicShimConfig,
): AssistantMessageEventStream {
	const governed = options?.preserveModelSelection === true || options?.preserveThinkingEffort === true;
	if (governed) options = { ...options };
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? config.defaultFormat;
	// The resolver form of `apiKey` is resolved upstream in `streamSimple`;
	// this shim only ever receives a static bearer string.
	const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;

	(async () => {
		try {
			const mergedHeaders = {
				...config.extraHeaders?.(),
				...options?.headers,
			};

			if (format === "anthropic") {
				if (governed && model.reasoningMode !== undefined) {
					throw new AIError.ModelSelectionError(
						"The alternate Anthropic wire cannot encode the admitted model-mode selector.",
					);
				}
				const anthropicModel = buildModel({
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: config.anthropicBaseUrl,
					headers: mergedHeaders,
					...(governed
						? {
								requestModelId: resolveWireModelId(
									model,
									options?.disableReasoning || options?.forceReasoningOff ? undefined : options?.reasoning,
								),
							}
						: {}),
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					...(config.anthropicThinkingMode && model.thinking
						? { thinking: { ...model.thinking, mode: config.anthropicThinkingMode } }
						: {}),
					input: model.input,
					cost: model.cost,
				} as ModelSpec<"anthropic-messages">);

				const reasoningEffort = options?.reasoning;
				const thinkingEnabled =
					!!reasoningEffort &&
					model.reasoning &&
					!options?.disableReasoning &&
					(!governed || !options?.forceReasoningOff);
				const thinkingBudget = reasoningEffort
					? (options?.thinkingBudgets?.[reasoningEffort] ?? ANTHROPIC_THINKING[reasoningEffort])
					: undefined;
				if (
					options?.preserveThinkingEffort &&
					reasoningEffort !== undefined &&
					(!thinkingEnabled || thinkingBudget === undefined || thinkingBudget <= 0)
				) {
					throw new AIError.ModelSelectionError(
						"The alternate Anthropic wire cannot honor the fixed requested effort.",
					);
				}

				const innerStream = streamAnthropic(anthropicModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					preserveModelSelection: options?.preserveModelSelection,
					preserveThinkingEffort: options?.preserveThinkingEffort,
					onBeforeRequest: options?.onBeforeRequest,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
					reasoning: governed
						? thinkingEnabled
							? reasoningEffort
							: undefined
						: config.anthropicThinkingMode
							? reasoningEffort
							: undefined,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			} else {
				const openaiModel: Model<"openai-completions"> = config.openaiBaseUrl
					? buildModel({
							...model,
							baseUrl: config.openaiBaseUrl,
							headers: mergedHeaders,
							compat: model.compatConfig,
						} as ModelSpec<"openai-completions">)
					: model;

				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(openaiModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					cacheRetention: config.forwardCacheOptions ? options?.cacheRetention : undefined,
					metadata: config.forwardCacheOptions ? options?.metadata : undefined,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					onPayload: options?.onPayload,
					preserveModelSelection: options?.preserveModelSelection,
					preserveThinkingEffort: options?.preserveThinkingEffort,
					onBeforeRequest: options?.onBeforeRequest,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					reasoning: reasoningEffort,
					toolChoice: options?.toolChoice,
					serviceTier: options?.serviceTier,
					disableReasoning: options?.disableReasoning || (governed && options?.forceReasoningOff),
					waitForTerminalDrain: options?.waitForTerminalDrain,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
