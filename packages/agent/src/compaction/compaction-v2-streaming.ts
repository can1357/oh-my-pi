/**
 * Remote Compaction V2: streaming Responses compaction.
 *
 * Mirrors Codex `core/src/compact_remote_v2.rs`: append a `compaction_trigger`
 * input item to the normal Responses stream, require exactly one streamed
 * compaction output item, then install retained real user messages plus that
 * compaction item as replacement history.
 */

import type { Api, CodexCompactionContext, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { applyCodexResponsesLiteShape } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	createOpenAICodexCompactionRequestContext,
	createOpenAICodexCompatibilityMetadata,
	type OpenAICodexCompactionBody,
	type OpenAICodexCompatibilityMetadata,
	openCodexCompactionEventStream,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	getOpenAIPromptCacheKey,
	getOpenAIResponsesRoutingSessionId,
	parseAzureDeploymentNameMap,
	resolveOpenAIRequestSetup,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { captureOpenAIHttpError } from "@oh-my-pi/pi-ai/utils/openai-http";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	codexRoutingHint,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, logger, stringifyJson } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types & Configuration
// ============================================================================

/** Retained-message budget Codex uses after streamed V2 compaction. */
export const V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

/** Max retries for V2 streaming compaction on transient stream errors. */
export const V2_COMPACTION_MAX_RETRIES = 2;

/** Timeout for V2 streaming compaction (3 minutes, same as V1). */
export const V2_COMPACTION_TIMEOUT_MS = 180_000;

const DEFAULT_AZURE_API_VERSION = "v1";
const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";
const COMPACTION_TRIGGER_ITEM = { type: "compaction_trigger" } as const;
// OpenAI image metering depends on detail and dimensions; charge the common
// high-detail 1024px-path budget so retained image history cannot be unbounded.
const IMAGE_TOKEN_ESTIMATE = 765;
const CONTEXTUAL_USER_PREFIXES = [
	"<environment_context>",
	"<user_instructions>",
	"<additional_context>",
	"<skills",
	"<token_budget>",
	"<model_switch>",
];

/** Token usage reported by the streamed V2 Responses completion. */
export interface CompactionV2Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
	reasoningOutputTokens?: number;
}

/** Request body fields needed for Responses-stream V2 compaction. */
export interface CompactionV2Request {
	model: string;
	input: unknown[];
	instructions: string;
	retainedMessageBudget: number;
	tools?: unknown[];
	/** Responses reasoning param (effort + summary), matching a normal turn; omitted for non-reasoning models. */
	reasoning?: { effort: string; summary: string };
	sessionId?: string;
	promptCacheKey?: string;
}

/** Response collected from the V2 stream and converted into replacement history. */
export interface CompactionV2Response {
	compactionItem: Record<string, unknown>;
	replacementHistory: Array<Record<string, unknown>>;
	usedTokens: number;
	usage?: CompactionV2Usage;
	retainedImageCount: number;
}

// ============================================================================
// Endpoint Resolution
// ============================================================================

/** Resolve the streaming Responses endpoint for a V2-capable model. */
export function getCompactionV2Endpoint(model: Model): string | undefined {
	if (model.remoteCompaction?.enabled === false) return undefined;
	if (!isOpenAiV2CompatibleModel(model)) return undefined;

	const configuredEndpoint = model.remoteCompaction?.v2Endpoint ?? model.remoteCompaction?.streamingEndpoint;
	if (configuredEndpoint && configuredEndpoint.length > 0) return configuredEndpoint;

	const api = compactionV2Api(model);
	if (api === "azure-openai-responses") {
		return appendAzureApiVersion(`${resolveAzureOpenAiBaseUrl(model)}/responses`);
	}
	if (api === "openai-codex-responses" || model.provider === "openai-codex") {
		return resolveOpenAiCodexResponsesEndpoint(model.baseUrl);
	}
	return resolveOpenAiResponsesEndpoint(model.baseUrl);
}

/** Check whether a model can use streaming V2 compaction. */
export function shouldUseCompactionV2Streaming(
	model: Model,
): model is Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses"> {
	if (model.remoteCompaction?.v2StreamingEnabled !== true) return false;
	return getCompactionV2Endpoint(model) !== undefined;
}

function compactionV2Api(model: Model): Api | undefined {
	return model.remoteCompaction?.api ?? model.api;
}

function isOpenAiV2CompatibleModel(model: Model): boolean {
	const api = compactionV2Api(model);
	return api === "openai-responses" || api === "azure-openai-responses" || api === "openai-codex-responses";
}

function shouldUseCodexProviderTransport(model: Model): model is Model<"openai-codex-responses"> {
	return (
		model.api === "openai-codex-responses" &&
		model.remoteCompaction?.v2Endpoint === undefined &&
		model.remoteCompaction?.streamingEndpoint === undefined
	);
}

function resolveOpenAiResponsesEndpoint(baseUrl: string | undefined): string {
	const rawBase = baseUrl && baseUrl.length > 0 ? baseUrl : "https://api.openai.com/v1";
	const normalizedBase = rawBase.replace(/\/+$/, "");
	if (normalizedBase.endsWith("/responses")) return normalizedBase;
	if (normalizedBase.endsWith("/v1")) return `${normalizedBase}/responses`;
	return `${normalizedBase}/v1/responses`;
}

function resolveOpenAiCodexResponsesEndpoint(baseUrl: string | undefined): string {
	const rawBase = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalizedBase = rawBase.replace(/\/+$/, "");
	if (normalizedBase.endsWith("/codex/responses")) return normalizedBase;
	if (normalizedBase.endsWith("/codex")) return `${normalizedBase}/responses`;
	return `${normalizedBase}/codex/responses`;
}

function resolveAzureOpenAiBaseUrl(model: Model): string {
	const baseUrl = $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = $env.AZURE_OPENAI_RESOURCE_NAME;
	const resolvedBaseUrl =
		baseUrl ?? (resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : undefined) ?? model.baseUrl;
	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or configure model.baseUrl.",
		);
	}
	return resolvedBaseUrl.replace(/\/+$/, "");
}

function appendAzureApiVersion(endpoint: string): string {
	if (/[?&]api-version=/.test(endpoint)) return endpoint;
	const separator = endpoint.includes("?") ? "&" : "?";
	return `${endpoint}${separator}api-version=${encodeURIComponent($env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION)}`;
}

function resolveCompactionV2Model(model: Model): string {
	const requestModel = model.remoteCompaction?.model ?? model.requestModelId ?? model.id;
	if (compactionV2Api(model) !== "azure-openai-responses") return requestModel;
	const mappedDeployment = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel);
	return mappedDeployment ?? requestModel;
}

// ============================================================================
// Request Building
// ============================================================================

/** Clamp the retained-message budget to Codex's known-safe 64K ceiling. */
export function resolveCompactionV2RetainedMessageBudget(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return V2_RETAINED_MESSAGE_TOKEN_BUDGET;
	return Math.min(V2_RETAINED_MESSAGE_TOKEN_BUDGET, Math.max(1, Math.floor(value)));
}

/** Build a V2 streaming compaction request from Responses-native history. */
export function buildCompactionV2Request(
	model: Model,
	input: unknown[],
	instructions: string,
	options?: {
		tools?: unknown[];
		reasoning?: { effort: string; summary: string };
		sessionId?: string;
		promptCacheKey?: string;
		retainedMessageBudget?: number;
	},
): CompactionV2Request {
	return {
		model: resolveCompactionV2Model(model),
		input,
		instructions,
		retainedMessageBudget: resolveCompactionV2RetainedMessageBudget(options?.retainedMessageBudget),
		reasoning: options?.reasoning,
		tools: options?.tools,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
	};
}

// ============================================================================
// Streaming Request Handler
// ============================================================================

/** Race the caller's signal against the V2 request timeout. */
function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
	if (timeoutMs <= 0) return signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Request V2 compaction over the normal OpenAI Responses streaming endpoint. */
export async function requestCompactionV2Streaming(
	model: Model,
	apiKey: string,
	request: CompactionV2Request,
	signal?: AbortSignal,
	options?: {
		fetch?: FetchImpl;
		timeoutMs?: number;
		retryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
		providerSessionState?: Map<string, ProviderSessionState>;
		codexCompaction?: CodexCompactionContext;
		preferWebsockets?: boolean;
	},
): Promise<CompactionV2Response> {
	const endpoint = getCompactionV2Endpoint(model);
	if (!endpoint) {
		throw new Error(`Model ${model.id} does not support V2 streaming compaction`);
	}

	const fetchImpl = options?.fetch ?? globalThis.fetch;
	const retryWait = options?.retryWait ?? ((delayMs: number) => Bun.sleep(delayMs));
	const isCodexResponses = compactionV2Api(model) === "openai-codex-responses" || model.provider === "openai-codex";
	const codexMetadata =
		isCodexResponses && !shouldUseCodexProviderTransport(model)
			? createOpenAICodexCompatibilityMetadata({
					sessionId: request.sessionId,
					providerSessionState: options?.providerSessionState,
					requestKind: "compaction",
					compaction: createOpenAICodexCompactionRequestContext({
						context: options?.codexCompaction,
						implementation: "responses_compaction_v2",
					}),
				})
			: undefined;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= V2_COMPACTION_MAX_RETRIES; attempt++) {
		const timeoutSignal = withRequestTimeout(signal, options?.timeoutMs ?? V2_COMPACTION_TIMEOUT_MS);
		try {
			return await attemptCompactionV2Streaming(endpoint, apiKey, model, request, fetchImpl, timeoutSignal, {
				codexMetadata,
				providerSessionState: options?.providerSessionState,
				codexCompaction: options?.codexCompaction,
				preferWebsockets: options?.preferWebsockets,
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			if (signal?.aborted) throw error;

			if (isRetryableCompactionError(error) && attempt < V2_COMPACTION_MAX_RETRIES) {
				lastError = error;
				const backoffMs = 2 ** attempt * 1000;
				logger.warn(`V2 compaction attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, {
					error: error.message,
					model: model.id,
				});
				await retryWait(backoffMs, signal);
				if (signal?.aborted) throw error;
				continue;
			}

			throw error;
		}
	}

	throw lastError ?? new Error("V2 compaction failed after max retries");
}

async function attemptCompactionV2Streaming(
	endpoint: string,
	apiKey: string,
	model: Model,
	request: CompactionV2Request,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	options: {
		codexMetadata?: OpenAICodexCompatibilityMetadata;
		providerSessionState?: Map<string, ProviderSessionState>;
		codexCompaction?: CodexCompactionContext;
		preferWebsockets?: boolean;
	},
): Promise<CompactionV2Response> {
	// Faithful to Codex: append the compaction trigger as the final input item
	// of an otherwise-normal Responses request, then stream the result. `store`
	// stays false — compaction must never persist a server-side response object.
	const cacheOptions = { sessionId: request.sessionId, promptCacheKey: request.promptCacheKey };
	const promptCacheKey = getOpenAIPromptCacheKey(cacheOptions);
	const body: OpenAICodexCompactionBody = {
		model: request.model,
		input: [...request.input, COMPACTION_TRIGGER_ITEM],
		instructions: request.instructions,
		stream: true,
		store: false,
		...(request.reasoning || model.useResponsesLite
			? {
					// Lite implies gpt-5.4+, where codex-rs sends `all_turns` replay.
					reasoning: model.useResponsesLite ? { ...request.reasoning, context: "all_turns" } : request.reasoning,
					include: ["reasoning.encrypted_content"],
				}
			: {}),
		...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
		...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: "auto" } : {}),
	};
	if (options.codexMetadata) {
		body.client_metadata = options.codexMetadata.clientMetadata;
	}
	// Responses Lite models take the same rewrite on the compaction stream:
	// instructions/tools ride as input items (codex-rs `compact_remote_v2`
	// builds through `build_responses_request`).
	if (model.useResponsesLite) {
		applyCodexResponsesLiteShape(body);
	}

	if (shouldUseCodexProviderTransport(model)) {
		const eventStream = await openCodexCompactionEventStream(model, body, {
			apiKey,
			signal,
			fetch: fetchImpl,
			sessionId: request.sessionId,
			providerSessionState: options.providerSessionState,
			preferWebsockets: options.preferWebsockets,
			responsesLite: model.useResponsesLite,
			codexCompaction: createOpenAICodexCompactionRequestContext({
				context: options.codexCompaction,
				implementation: "responses_compaction_v2",
			}),
		});
		return collectCompactionV2Events(eventStream, request);
	}

	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: buildCompactionV2Headers(model, apiKey, request, options.codexMetadata),
		body: stringifyJson(body),
		signal,
	});

	if (!response.ok) {
		const cause = await captureOpenAIHttpError(response);
		logger.warn("V2 remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText: cause.captured.bodyText ?? "",
		});
		throw new AIError.ProviderHttpError(
			`V2 remote compaction failed (${response.status} ${response.statusText})`,
			response.status,
			{
				headers: response.headers,
				cause,
			},
		);
	}

	return collectCompactionV2Output(response, request);
}

function buildCompactionV2Headers(
	model: Model,
	apiKey: string,
	request: CompactionV2Request,
	codexMetadata?: OpenAICodexCompatibilityMetadata,
): Record<string, string> {
	const api = compactionV2Api(model);
	const cacheOptions = { sessionId: request.sessionId, promptCacheKey: request.promptCacheKey };
	const routingSessionId = getOpenAIResponsesRoutingSessionId(cacheOptions);
	const promptCacheSessionId = getOpenAIPromptCacheKey(cacheOptions);
	const headers: Record<string, string> =
		api === "azure-openai-responses"
			? {
					"content-type": "application/json",
					"api-key": apiKey,
					...model.headers,
				}
			: {
					"content-type": "application/json",
					...resolveOpenAIRequestSetup(
						{ provider: model.provider, id: model.id, baseUrl: model.baseUrl, headers: model.headers },
						{ apiKey, messages: [], sessionId: request.sessionId ?? routingSessionId, promptCacheSessionId },
					).headers,
				};
	if (api === "openai-codex-responses" || model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		if (accountId) {
			headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
		}
		applyCodexResidencyHeader(headers, apiKey);
		if (routingSessionId) {
			headers[OPENAI_HEADERS.CONVERSATION_ID] = routingSessionId;
			headers[OPENAI_HEADERS.SESSION_ID] = routingSessionId;
			headers["x-client-request-id"] = routingSessionId;
		}
		headers[OPENAI_HEADERS.BETA] = OPENAI_HEADER_VALUES.BETA_RESPONSES;
		headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
		headers[OPENAI_HEADERS.CODEX_BETA_FEATURES] = OPENAI_HEADER_VALUES.REMOTE_COMPACTION_V2;
		headers[OPENAI_HEADERS.ROUTING_HINT] = codexRoutingHint(request.model, undefined);
		if (model.useResponsesLite) {
			headers[OPENAI_HEADERS.RESPONSES_LITE] = "true";
		}
	}
	if (codexMetadata) Object.assign(headers, codexMetadata.headers);

	return headers;
}

interface CompactionV2CollectionState {
	outputItemCount: number;
	compactionItems: Array<Record<string, unknown>>;
	sawCompleted: boolean;
	usage: CompactionV2Usage | undefined;
}

function createCompactionV2CollectionState(): CompactionV2CollectionState {
	return {
		outputItemCount: 0,
		compactionItems: [],
		sawCompleted: false,
		usage: undefined,
	};
}

async function collectCompactionV2Events(
	events: AsyncIterable<Record<string, unknown>>,
	request: CompactionV2Request,
): Promise<CompactionV2Response> {
	const state = createCompactionV2CollectionState();
	for await (const event of events) {
		handleCompactionV2Event(event, undefined, state);
	}
	return finishCompactionV2Collection(state, request);
}

async function collectCompactionV2Output(
	response: Response,
	request: CompactionV2Request,
): Promise<CompactionV2Response> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("No response body for V2 compaction streaming");
	}

	const state = createCompactionV2CollectionState();
	try {
		const decoder = new TextDecoder();
		let buffer = "";
		let eventName: string | undefined;
		let dataLines: string[] = [];

		const dispatch = (): void => {
			if (dataLines.length === 0) {
				eventName = undefined;
				return;
			}
			handleCompactionV2SseEvent(dataLines.join("\n"), eventName, state);
			eventName = undefined;
			dataLines = [];
		};

		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let lineEnd = buffer.indexOf("\n");
			while (lineEnd >= 0) {
				const rawLine = buffer.slice(0, lineEnd).replace(/\r$/, "");
				buffer = buffer.slice(lineEnd + 1);
				if (rawLine === "") {
					dispatch();
				} else if (rawLine.startsWith("event:")) {
					eventName = rawLine.slice("event:".length).trim();
				} else if (rawLine.startsWith("data:")) {
					dataLines.push(rawLine.slice("data:".length).trimStart());
				}
				lineEnd = buffer.indexOf("\n");
			}
			if (done) break;
		}
		if (buffer.length > 0) {
			if (buffer.startsWith("data:")) {
				dataLines.push(buffer.slice("data:".length).trimStart());
			} else if (buffer.startsWith("event:")) {
				eventName = buffer.slice("event:".length).trim();
			}
		}
		dispatch();
	} finally {
		reader.releaseLock();
	}

	return finishCompactionV2Collection(state, request);
}

function finishCompactionV2Collection(
	state: CompactionV2CollectionState,
	request: CompactionV2Request,
): CompactionV2Response {
	if (!state.sawCompleted) {
		throw new Error("V2 compaction stream closed before response.completed");
	}
	if (state.compactionItems.length !== 1) {
		throw new Error(
			`V2 compaction expected exactly one compaction output item, got ${state.compactionItems.length} from ${state.outputItemCount} output items`,
		);
	}

	const compactionItem = state.compactionItems[0];
	const { replacementHistory, retainedImageCount } = buildCompactionV2ReplacementHistory(
		request.input,
		compactionItem,
		request.retainedMessageBudget,
	);
	return {
		compactionItem,
		replacementHistory,
		usedTokens: state.usage?.inputTokens ?? 0,
		usage: state.usage,
		retainedImageCount,
	};
}

function handleCompactionV2SseEvent(
	data: string,
	eventName: string | undefined,
	state: CompactionV2CollectionState,
): void {
	if (data === "[DONE]") return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(data) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`V2 compaction stream parse failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	handleCompactionV2Event(event, eventName, state);
}

function handleCompactionV2Event(
	event: Record<string, unknown>,
	eventName: string | undefined,
	state: CompactionV2CollectionState,
): void {
	const type = typeof event.type === "string" ? event.type : eventName;
	if (type === "response.output_item.done") {
		state.outputItemCount++;
		const item = event.item;
		if (isRecord(item) && item.type === "compaction") {
			state.compactionItems.push(item);
		}
		return;
	}

	if (type === "response.completed" || type === "response.done") {
		state.sawCompleted = true;
		state.usage = parseCompactionV2Usage(event);
		return;
	}

	if (type === "response.failed" || type === "response.incomplete") {
		throw new Error(formatCompactionV2Failure(event, type));
	}
}

function parseCompactionV2Usage(event: Record<string, unknown>): CompactionV2Usage | undefined {
	const response = isRecord(event.response) ? event.response : undefined;
	const usage = response && isRecord(response.usage) ? response.usage : undefined;
	if (!usage) return undefined;

	const inputTokens = numberField(usage, "input_tokens");
	const outputTokens = numberField(usage, "output_tokens");
	const totalTokens = numberField(usage, "total_tokens");
	if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;

	const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
	const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
	const cachedInputTokens = inputDetails ? numberField(inputDetails, "cached_tokens") : undefined;
	const reasoningOutputTokens = outputDetails ? numberField(outputDetails, "reasoning_tokens") : undefined;
	return {
		inputTokens,
		outputTokens,
		totalTokens,
		...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
		...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
	};
}

function formatCompactionV2Failure(event: Record<string, unknown>, type: string): string {
	const response = isRecord(event.response) ? event.response : undefined;
	const error = isRecord(event.error)
		? event.error
		: response && isRecord(response.error)
			? response.error
			: undefined;
	const message = error ? stringField(error, "message") : undefined;
	const code = error ? (stringField(error, "code") ?? stringField(error, "type")) : undefined;
	return `V2 compaction stream ${type}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
}

function isRetryableCompactionError(error: Error): boolean {
	// The gateway's synthetic auth_unavailable is an HTTP 503, but the
	// captured response cause classifies it as auth. Let provider fallback run
	// immediately instead of spending the transient retry budget.
	if (AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) return false;
	if (
		error.name === "AbortError" ||
		error.name === "TimeoutError" ||
		error.message.toLowerCase().includes("timeout")
	) {
		return true;
	}
	if (error instanceof AIError.ProviderHttpError) {
		return AIError.isTransientStatus(error.status);
	}
	const message = error.message.toLowerCase();
	return (
		message.includes("stream closed before response.completed") ||
		message.includes("stream parse failed") ||
		message.includes("server_error") ||
		message.includes("internal_error") ||
		message.includes("overloaded") ||
		message.includes("service unavailable")
	);
}

// ============================================================================
// Replacement History
// ============================================================================

/** Build Codex-style V2 replacement history from prompt input plus compaction output. */
export function buildCompactionV2ReplacementHistory(
	input: unknown[],
	compactionItem: Record<string, unknown>,
	retainedMessageBudget = V2_RETAINED_MESSAGE_TOKEN_BUDGET,
): { replacementHistory: Array<Record<string, unknown>>; retainedImageCount: number } {
	const retained = input.filter(
		(item): item is Record<string, unknown> =>
			isRecord(item) && isRetainedForCompactionV2(item) && shouldKeepCompactionV2HistoryItem(item),
	);
	const replacementHistory = truncateRetainedMessagesForCompactionV2(
		retained,
		resolveCompactionV2RetainedMessageBudget(retainedMessageBudget),
	);
	const retainedImageCount = replacementHistory.reduce((count, item) => count + retainedInputImageCount(item), 0);
	replacementHistory.push(compactionItem);
	return { replacementHistory, retainedImageCount };
}

function isRetainedForCompactionV2(item: Record<string, unknown>): boolean {
	if (item.type !== "message") return false;
	const role = stringField(item, "role");
	return role === "user" || role === "developer" || role === "system";
}

function shouldKeepCompactionV2HistoryItem(item: Record<string, unknown>): boolean {
	if (item.type !== "message") return item.type === "compaction";
	const role = stringField(item, "role");
	if (role !== "user") return false;
	return !isContextualUserMessage(item);
}

function isContextualUserMessage(item: Record<string, unknown>): boolean {
	const content = Array.isArray(item.content) ? item.content : [];
	return content.some(part => {
		if (!isRecord(part) || part.type !== "input_text") return false;
		const text = stringField(part, "text")?.trimStart().toLowerCase();
		return !!text && CONTEXTUAL_USER_PREFIXES.some(prefix => text.startsWith(prefix));
	});
}

function retainedInputImageCount(item: Record<string, unknown>): number {
	const content = Array.isArray(item.content) ? item.content : [];
	let count = 0;
	for (const part of content) {
		if (isRecord(part) && part.type === "input_image") count++;
	}
	return count;
}

function truncateRetainedMessagesForCompactionV2(
	items: Array<Record<string, unknown>>,
	maxTokens: number,
): Array<Record<string, unknown>> {
	let remaining = maxTokens;
	const truncatedReversed: Array<Record<string, unknown>> = [];
	for (let i = items.length - 1; i >= 0; i--) {
		if (remaining === 0) continue;
		const item = items[i];
		const tokenCount = Math.max(messageContentTokenCount(item), 1);
		if (tokenCount <= remaining) {
			truncatedReversed.push(item);
			remaining = Math.max(0, remaining - tokenCount);
			continue;
		}

		const truncatedItem = truncateMessageTextToTokenBudget(item, remaining);
		if (truncatedItem) {
			truncatedReversed.push(truncatedItem);
			remaining = 0;
		}
	}
	truncatedReversed.reverse();
	return truncatedReversed;
}

function messageContentTokenCount(item: Record<string, unknown>): number {
	const content = Array.isArray(item.content) ? item.content : [];
	let tokens = 0;
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "input_image") {
			tokens += IMAGE_TOKEN_ESTIMATE;
			continue;
		}
		if (part.type === "input_text" || part.type === "output_text") {
			tokens += approxTokenCount(stringField(part, "text") ?? "");
		}
	}
	return tokens;
}

function truncateMessageTextToTokenBudget(
	item: Record<string, unknown>,
	maxTokens: number,
): Record<string, unknown> | undefined {
	const content = Array.isArray(item.content) ? item.content : [];
	let remaining = maxTokens;
	const truncatedContent: unknown[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "input_image") {
			if (remaining < IMAGE_TOKEN_ESTIMATE) continue;
			truncatedContent.push(part);
			remaining = Math.max(0, remaining - IMAGE_TOKEN_ESTIMATE);
			continue;
		}
		if (part.type !== "input_text" && part.type !== "output_text") continue;
		if (remaining === 0) continue;

		const text = stringField(part, "text") ?? "";
		const tokenCount = approxTokenCount(text);
		if (tokenCount <= remaining) {
			truncatedContent.push(part);
			remaining = Math.max(0, remaining - tokenCount);
			continue;
		}

		const truncatedText = truncateTextToTokenBudget(text, remaining);
		remaining = 0;
		if (truncatedText.length > 0) {
			truncatedContent.push({ ...part, text: truncatedText });
		}
	}

	if (truncatedContent.length === 0) return undefined;
	return { ...item, content: truncatedContent };
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return "";
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	const omittedTokens = Math.max(1, approxTokenCount(text) - maxTokens);
	const marker = `…${omittedTokens} tokens truncated…`;
	if (maxChars <= marker.length + 2) return text.slice(0, maxChars);
	const sideChars = Math.max(1, Math.floor((maxChars - marker.length) / 2));
	return `${text.slice(0, sideChars)}${marker}${text.slice(-sideChars)}`;
}

function approxTokenCount(text: string): number {
	return Math.ceil(text.length / 4);
}

// ============================================================================
// Preserve Data
// ============================================================================

/** Store V2 replacement history in the OpenAI remote-compaction preserve slot. */
export function storeCompactionV2PreserveData(response: CompactionV2Response, model: Model): Record<string, unknown> {
	return {
		[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
			version: "v2",
			provider: model.provider,
			replacementHistory: response.replacementHistory,
			usedTokens: response.usedTokens,
			usage: response.usage,
			retainedImageCount: response.retainedImageCount,
		},
	};
}

/** Retrieve preserved OpenAI replacement history that V2 can extend. */
export function getCompactionV2PreserveData(
	preserveData: Record<string, unknown> | undefined,
): { provider: string; replacementHistory: Array<Record<string, unknown>>; usedTokens: number } | undefined {
	const candidate = preserveData?.[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY];
	if (!isRecord(candidate)) return undefined;
	const provider = stringField(candidate, "provider");
	if (!provider) return undefined;
	if (!Array.isArray(candidate.replacementHistory)) return undefined;

	return {
		provider,
		replacementHistory: candidate.replacementHistory as Array<Record<string, unknown>>,
		usedTokens: numberField(candidate, "usedTokens") ?? 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
