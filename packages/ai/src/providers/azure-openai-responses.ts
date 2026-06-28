import { $env } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Model,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	ToolChoice,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	applyOpenAIReasoningEffortFallback,
	createOpenAIReasoningEffortFallbackKey,
	type OpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "./openai-responses-wire";
import {
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	buildResponsesInput,
	createInitialResponsesAssistantMessage,
	getOpenAIResponsesPromptCacheKey,
	isOpenAIResponsesProgressEvent,
	parseAzureDeploymentNameMap,
	processResponsesStream,
} from "./openai-shared";

export { parseAzureDeploymentNameMap } from "./openai-shared";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"Azure OpenAI responses stream timed out while waiting for the first event";

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment ?? model.id;
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

type AzureOpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses"> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"azure-openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent
			? (event: RawSseEvent) => {
					if (!event.event && event.data && event.data !== "[DONE]") {
						try {
							const parsed = JSON.parse(event.data);
							const resolvedEvent =
								typeof parsed.type === "string"
									? parsed.type
									: typeof parsed.object === "string"
										? parsed.object
										: null;
							if (resolvedEvent) {
								event.event = resolvedEvent;
								event.raw = [`event: ${resolvedEvent}`, ...event.raw];
							}
						} catch {}
					}
					onSseEvent(event, model);
				}
			: undefined;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { url, headers } = buildAzureResponsesRequest(model, apiKey, options);
			let params = buildParams(model, context, options, deploymentName);
			const replacementPayload = await options?.onPayload?.(params, model);
			if (replacementPayload !== undefined) {
				params = replacementPayload as typeof params;
			}
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url,
				body: params,
			};
			const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
				"azure-responses",
				url,
				typeof params.model === "string" ? params.model : model.id,
			);
			const attemptedReasoningEffortFallbacks = new Set<string>();
			let openaiStream: AsyncIterable<ResponseStreamEvent>;
			while (true) {
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const handle = await postOpenAIStream<ResponseStreamEvent>({
						url,
						headers: headersWithTimeout,
						body: params,
						signal: requestSignal,
						fetch: options?.fetch,
						// Watchdog armed → no retries, so they cannot silently extend the deadline.
						maxAttempts: requestTimeoutMs !== undefined ? 1 : undefined,
						onSseEvent: rawSseObserver,
					});
					openaiStream = handle.events;
					break;
				} catch (error) {
					const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
					const reasoningEffortFallback: OpenAIReasoningEffortFallback | undefined = !requestSignal.aborted
						? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, params)
						: undefined;
					if (reasoningEffortFallback === undefined) throw error;
					const retryMarker = `${reasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
					if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
					attemptedReasoningEffortFallbacks.add(retryMarker);
					applyOpenAIReasoningEffortFallback(params, reasoningEffortFallback);
					rawRequestDump.body = params;
				} finally {
					if (requestTimeout !== undefined) clearTimeout(requestTimeout);
				}
			}
			stream.push({ type: "start", partial: output });

			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: AZURE_OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "Azure OpenAI responses stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAIResponsesProgressEvent,
			});
			let sawTerminalResponseEvent = false;
			await processResponsesStream(timedOpenaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				onCompleted: () => {
					sawTerminalResponseEvent = true;
				},
			});

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}

			if (abortTracker.wasCallerAbort()) {
				throw new AIError.AbortError();
			}

			if (!sawTerminalResponseEvent) {
				throw new AIError.ProviderResponseError(
					"Azure OpenAI responses stream closed before a terminal response event was received",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
					provider: model.provider,
					kind: "output",
				});
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, abortTracker, rawRequestDump });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || $env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || $env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = `https://${resourceName}.openai.azure.com/openai/v1`;
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new AIError.ConfigurationError(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
		apiVersion,
	};
}

/**
 * Replicates the `AzureOpenAI` SDK client's request shape for `/responses`:
 * a string api key becomes a single `api-key` header (azure.mjs `authHeaders`;
 * never `Authorization: Bearer`), `api-version` rides as a query parameter
 * (azure.mjs constructor `defaultQuery`), and `/responses` is not a
 * deployment-scoped path, so no `/deployments/{model}` URL rewriting applies.
 * Custom model/options headers may override the auth header, matching the SDK's
 * `buildHeaders` precedence.
 */
function buildAzureResponsesRequest(
	model: Model<"azure-openai-responses">,
	apiKey: string,
	options?: AzureOpenAIResponsesOptions,
): { url: string; headers: Record<string, string> } {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new AIError.MissingApiKeyError(
				undefined,
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = envKey;
	}

	const headers: Record<string, string> = { "api-key": apiKey, ...(model.headers ?? {}) };
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return {
		url: `${baseUrl}/responses?api-version=${encodeURIComponent(apiVersion)}`,
		headers,
	};
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const systemRole = model.reasoning && model.compat.supportsDeveloperRole ? "developer" : "system";
	const messages = buildResponsesInput({
		model,
		context,
		strictResponsesPairing: true,
		supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
		systemRole,
		includeThinkingSignatures: true,
		developerStringContent: true,
	});

	const params: AzureOpenAIResponsesSamplingParams = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: getOpenAIResponsesPromptCacheKey(options),
		// Encrypted reasoning replay (applyResponsesReasoningParams) requires
		// stateless responses, matching the openai provider.
		store: false,
	};

	applyCommonResponsesSamplingParams(params, options, model);

	if (context.tools) {
		params.tools = context.tools.map(tool => ({
			type: "function" as const,
			name: tool.name,
			description: tool.description || "",
			parameters: sanitizeSchemaForOpenAIResponses(toolWireSchema(tool)),
			strict: false,
		}));
		if (options?.toolChoice && context.tools.length > 0) {
			const toolChoice = mapToOpenAIResponsesToolChoice(options.toolChoice);
			if (
				toolChoice &&
				(typeof toolChoice === "string" ||
					toolChoice.type !== "function" ||
					context.tools.some(tool => tool.name === toolChoice.name))
			) {
				params.tool_choice = toolChoice;
			}
		}
	}

	applyResponsesReasoningParams(params, model, options, messages);

	return params;
}
