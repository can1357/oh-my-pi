import { hostMatchesUrl } from "@pk-nerdsaver-ai/pi-catalog/hosts";
import { $flag, logger, structuredCloneJSON } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAICompat,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	NO_STRICT,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";
import {
	isForcedToolChoice,
	mapToOpenAIResponsesToolChoice,
	type OpenAIResponsesToolChoice,
} from "../utils/tool-choice";
import { compactGrammarDefinition } from "./grammar";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import {
	applyCommonResponsesSamplingParams,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyResponsesCompatPolicy,
	applyWireModelIdTransform,
	buildResponsesDeltaInput,
	buildResponsesInput,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIResponsesPromptCacheKey,
	getOpenAIResponsesRoutingSessionId,
	getOpenAIStrictToolsScope,
	getOpenRouterResponsesSessionId,
	isCompiledGrammarTooLargeStrictError,
	isOpenAIResponsesProgressEvent,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	processResponsesStream,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: ToolChoice;
	openrouterVariant?: string;
	maxTokensExplicit?: boolean;
	disableReasoning?: boolean;
	/**
	 * Stateful turns: chain via `previous_response_id` + delta input instead of
	 * replaying the full transcript. Forces `store: true` (the platform only
	 * resolves stored responses). Defaults ON against the official OpenAI API
	 * and OFF for other Responses endpoints; `PI_OPENAI_STATEFUL` overrides the
	 * default, and `false` here vetoes everything. Requires `sessionId` +
	 * `providerSessionState`. Falls back to a full replay whenever history
	 * mutates or the server reports a stale id.
	 */
	statefulResponses?: boolean;
	/**
	 * Override catalog compat for strict tool call/result pairing when building
	 * Responses API inputs. Default behavior is catalog compat; this is only for
	 * debugging/adapter wrappers.
	 */
	strictResponsesPairing?: boolean;
	/**
	 * Override catalog compat for `include: ["reasoning.encrypted_content"]`.
	 * Default behavior is catalog compat; this is only for debugging/adapter wrappers.
	 */
	includeEncryptedReasoning?: boolean;
	/**
	 * Override catalog compat for stripping `type: "reasoning"` items from
	 * replayed conversation history before request encoding. Default behavior is
	 * catalog compat; this is only for debugging/adapter wrappers.
	 */
	filterReasoningHistory?: boolean;
	/**
	 * Override catalog compat for suppressing the `reasoning.effort` wire param.
	 * Default behavior is catalog compat; this is only for debugging/adapter wrappers.
	 */
	omitReasoningEffort?: boolean;
	/**
	 * Extra request headers merged onto the model/copilot defaults. Used by
	 * adapter wrappers to inject provider-specific
	 * routing or cache hints.
	 */
	headers?: Record<string, string>;
	/**
	 * Extra body fields merged into the Responses request payload. Used by
	 * adapter wrappers to inject provider-specific body keys (e.g.,
	 * prompt_cache_key for prompt-cache routing).
	 */
	extraBody?: Record<string, unknown>;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";
/** Consecutive stale-previous-response failures before chaining is disabled for the session. */
const OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT = 3;

interface OpenAIResponsesProviderSessionState
	extends ProviderSessionState,
		OpenAIStrictToolsState,
		OpenAIReasoningEffortFallbackState {
	nativeHistoryReplayWarmed: boolean;
	/** Stateful `previous_response_id` chain baselines, keyed by baseUrl/model/session. */
	chains: Map<string, OpenAIResponsesChainState>;
}

interface OpenAIResponsesChainState {
	/**
	 * Wire params of the last successful turn, with per-turn trailing
	 * scaffolding stripped from `input` (never carries previous_response_id).
	 */
	lastParams?: OpenAIResponsesSamplingParams;
	lastResponseId?: string;
	/** Output items of the last response, in replay-sanitized form (matches next-turn input). */
	lastResponseItems?: ResponseInput;
	canAppend: boolean;
	/** Consecutive stale-previous-response failures; reset on a successful chained completion. */
	staleFailures: number;
	/** Set once chaining is judged unsupported for this session (circuit breaker). */
	disabled: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAIResponsesProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		nativeHistoryReplayWarmed: false,
		chains: new Map(),
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.chains.clear();
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAIResponsesProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function isOpenAIResponsesStatefulEnabled(
	options: OpenAIResponsesOptions | undefined,
	baseUrl: string | undefined,
): boolean {
	if (options?.statefulResponses === false) return false;
	if (options?.statefulResponses === true) return true;
	// Default ON only against the official OpenAI API: chaining forces
	// `store: true`, and third-party /v1/responses proxies routinely ignore or
	// reject `previous_response_id`. An unset baseUrl means the default
	// endpoint (api.openai.com).
	return $flag("PI_OPENAI_STATEFUL", !baseUrl || hostMatchesUrl(baseUrl, "openai"));
}

function getOpenAIResponsesChainState(
	providerSessionState: OpenAIResponsesProviderSessionState,
	model: Model<"openai-responses">,
	resolvedBaseUrl: string | undefined,
	sessionId: string,
): OpenAIResponsesChainState {
	const key = `${resolvedBaseUrl ?? model.baseUrl ?? ""}\u0000${model.id}\u0000${sessionId}`;
	const existing = providerSessionState.chains.get(key);
	if (existing) return existing;
	const created: OpenAIResponsesChainState = { canAppend: false, staleFailures: 0, disabled: false };
	providerSessionState.chains.set(key, created);
	return created;
}

function resetOpenAIResponsesChainState(state: OpenAIResponsesChainState): void {
	state.canAppend = false;
	state.lastParams = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

interface OpenAIResponsesChainedParams {
	params: OpenAIResponsesSamplingParams;
	/** Set iff the params carry previous_response_id (delta request). */
	previousResponseId?: string;
}

/**
 * Shape the next turn's request: when the session's append baseline is intact
 * (same options, strict history prefix), chain via `previous_response_id` +
 * delta-only `input`; otherwise break the chain and replay the full transcript.
 *
 * The prefix check runs on the wire form of the conversation arguments alone:
 * per-turn trailing scaffolding is excluded from both sides and re-appended to
 * the delta, so a decoration that trails every request can never masquerade as
 * a history mutation.
 */
function buildOpenAIResponsesChainedParams(
	params: OpenAIResponsesSamplingParams,
	trailingScaffoldingItems: number,
	chain: OpenAIResponsesChainState,
): OpenAIResponsesChainedParams {
	const historyParams =
		trailingScaffoldingItems > 0 && Array.isArray(params.input)
			? { ...params, input: params.input.slice(0, params.input.length - trailingScaffoldingItems) }
			: params;
	const deltaInput = chain.canAppend
		? buildResponsesDeltaInput(chain.lastParams, chain.lastResponseItems, historyParams)
		: null;
	if (deltaInput && deltaInput.length > 0 && chain.lastResponseId) {
		const scaffolding =
			historyParams !== params && Array.isArray(params.input)
				? params.input.slice(params.input.length - trailingScaffoldingItems)
				: [];
		return {
			params: { ...params, previous_response_id: chain.lastResponseId, input: [...deltaInput, ...scaffolding] },
			previousResponseId: chain.lastResponseId,
		};
	}
	if (chain.canAppend) {
		// History mutated or options changed — break the chain and replay in full.
		resetOpenAIResponsesChainState(chain);
	}
	return { params };
}

function isOpenAIResponsesStalePreviousResponseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as { code?: string }).code === "previous_response_not_found") return true;
	// "unsupported" covers endpoints that reject the parameter outright
	// (e.g. "Unsupported parameter: previous_response_id").
	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

function registerOpenAIResponsesChainStaleFailure(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.staleFailures += 1;
	if (chain.staleFailures >= OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT) {
		chain.disabled = true;
	}
	logger.debug("OpenAI responses previous_response_id rejected; falling back to full context", {
		error: error instanceof Error ? error.message : String(error),
		consecutiveFailures: chain.staleFailures,
		disabled: chain.disabled,
	});
}

/**
 * One-shot ZDR signal: the org will never resolve a stored response, so skip
 * the staleFailures counter and disable chaining immediately for this session.
 */
function markOpenAIResponsesChainZeroDataRetention(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.disabled = true;
	chain.staleFailures = OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT;
	logger.debug("OpenAI responses chaining disabled (Zero Data Retention)", {
		error: error instanceof Error ? error.message : String(error),
	});
}

type OpenRouterAnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	session_id?: string;
	stream_options?: { include_obfuscation?: boolean };
	provider?: OpenAICompat["openRouterRouting"];
	reasoning?: { effort?: string } | { enabled: false };
	cache_control?: OpenRouterAnthropicCacheControl;
};

function maybeAddOpenRouterAnthropicCacheControl(
	params: OpenAIResponsesSamplingParams,
	model: Model<"openai-responses">,
	cacheRetention: CacheRetention,
): void {
	if (cacheRetention === "none" || !isOpenRouterAnthropicModel(model)) return;
	if (params.cache_control != null) return;
	params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * Generate function for OpenAI Responses API
 */
const streamOpenAIResponsesOnce = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let chainState: OpenAIResponsesChainState | undefined;
		let sentPreviousResponseId: string | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
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
			// Keep request routing on `sessionId` while allowing callers to pin a
			// stable prompt-cache key independently. Side-channel calls use this to
			// avoid perturbing provider conversation state without cold-starting the cache.
			const routingSessionId = getOpenAIResponsesRoutingSessionId(options);
			const promptCacheSessionId = getOpenAIResponsesPromptCacheKey(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { headers, copilotPremiumRequests, baseUrl } = resolveOpenAIRequestSetup(model, {
				apiKey,
				extraHeaders: options?.headers,
				initiatorOverride: options?.initiatorOverride,
				messages: context.messages,
				openAISessionId: routingSessionId,
				promptCacheSessionId,
			});
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			const builtParams = buildParams(model, context, options, providerSessionState, strictToolsScope);
			const params = builtParams.params;
			const { trailingScaffoldingItems } = builtParams;
			let activeParams = params;
			let activeTrailingScaffoldingItems = trailingScaffoldingItems;
			const resolvedBaseUrl = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
			const requestReasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
			const attemptedReasoningEffortFallbacks = new Set<string>();
			let pendingReasoningEffortFallback: { key: string; fallback: OpenAIReasoningEffortFallback } | undefined;
			let activeReasoningEffortFallbackKey: string | undefined;
			let activeRequestParams: OpenAIResponsesSamplingParams | undefined;
			const applyReasoningEffortFallbackForRequest = (requestParams: OpenAIResponsesSamplingParams): string => {
				const fallbackKey = createOpenAIReasoningEffortFallbackKey(
					"responses",
					resolvedBaseUrl,
					typeof requestParams.model === "string" ? requestParams.model : model.id,
				);
				const requestReasoningEffortFallback = requestReasoningEffortFallbacks.has(fallbackKey)
					? requestReasoningEffortFallbacks.get(fallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, fallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(requestParams, requestReasoningEffortFallback);
				}
				return fallbackKey;
			};
			if (isOpenAIResponsesStatefulEnabled(options, baseUrl) && routingSessionId && providerSessionState) {
				chainState = getOpenAIResponsesChainState(providerSessionState, model, baseUrl, routingSessionId);
				if (!chainState.disabled) {
					// Platform `previous_response_id` chaining only resolves stored responses.
					params.store = true;
				}
			}
			applyReasoningEffortFallbackForRequest(params);
			let chained: OpenAIResponsesChainedParams =
				chainState && !chainState.disabled
					? buildOpenAIResponsesChainedParams(params, trailingScaffoldingItems, chainState)
					: { params };
			sentPreviousResponseId = chained.previousResponseId;
			const idleTimeoutMs =
				options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const requestUrl = `${resolvedBaseUrl}/responses`;
			const applyPayloadReplacement = async (requestParams: OpenAIResponsesSamplingParams) => {
				const replacementPayload = await options?.onPayload?.(requestParams, model);
				const payload =
					replacementPayload !== undefined ? (replacementPayload as OpenAIResponsesSamplingParams) : requestParams;
				applyReasoningEffortFallbackForRequest(payload);
				return payload;
			};
			chained = { ...chained, params: await applyPayloadReplacement(chained.params) };
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: requestUrl,
				body: chained.params,
			};
			const openResponsesStream = (requestParams: OpenAIResponsesSamplingParams) => {
				activeReasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"responses",
					resolvedBaseUrl,
					typeof requestParams.model === "string" ? requestParams.model : model.id,
				);
				activeRequestParams = requestParams;
				return callWithCopilotModelRetry(
					async () => {
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
							const { events, response, requestId } = await postOpenAIStream<ResponseStreamEvent>({
								url: requestUrl,
								headers: headersWithTimeout,
								body: requestParams,
								signal: requestSignal,
								fetch: options?.fetch,
								// With a first-event watchdog armed, transport retries must
								// not silently extend the caller's deadline.
								maxAttempts: requestTimeoutMs !== undefined ? 1 : undefined,
								onSseEvent: rawSseObserver,
							});
							// Disarm the first-event watchdog as soon as headers arrive — a slow
							// onResponse callback must not abort an already-connected stream.
							if (requestTimeout !== undefined) {
								clearTimeout(requestTimeout);
								requestTimeout = undefined;
							}
							await notifyProviderResponse(options, response, model, requestId);
							return events;
						} finally {
							if (requestTimeout !== undefined) clearTimeout(requestTimeout);
						}
					},
					{ provider: model.provider, signal: requestSignal },
				);
			};
			let openaiStream: AsyncIterable<ResponseStreamEvent>;
			let strictRetryAvailable = true;
			let activeStrictToolsApplied = builtParams.strictToolsApplied;
			let forceDisableStrictTools = false;
			while (true) {
				try {
					openaiStream = await openResponsesStream(chained.params);
					if (pendingReasoningEffortFallback) {
						rememberOpenAIReasoningEffortFallback(
							providerSessionState,
							pendingReasoningEffortFallback.key,
							pendingReasoningEffortFallback.fallback,
						);
						pendingReasoningEffortFallback = undefined;
					}
					break;
				} catch (error) {
					const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
					const reasoningEffortFallback =
						activeReasoningEffortFallbackKey && activeRequestParams && !requestSignal.aborted
							? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
									explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
								})
							: undefined;
					if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
						const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
						if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
						attemptedReasoningEffortFallbacks.add(retryMarker);
						requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
						applyOpenAIReasoningEffortFallback(chained.params, reasoningEffortFallback);
						applyOpenAIReasoningEffortFallback(activeParams, reasoningEffortFallback);
						rawRequestDump.body = chained.params;
						pendingReasoningEffortFallback = {
							key: activeReasoningEffortFallbackKey,
							fallback: reasoningEffortFallback,
						};
						continue;
					}
					const compiledGrammarTooLarge =
						isOpenRouterAnthropicModel(model) &&
						isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse);
					const canRetryWithoutStrictTools =
						strictRetryAvailable &&
						!requestSignal.aborted &&
						(compiledGrammarTooLarge ||
							shouldRetryWithoutStrictTools(
								error,
								capturedErrorResponse,
								activeStrictToolsApplied,
								context.tools,
							));
					if (canRetryWithoutStrictTools) {
						strictRetryAvailable = false;
						forceDisableStrictTools = true;
						disableStrictToolsForScope(providerSessionState, strictToolsScope);
						const fallbackBuilt = buildParams(
							model,
							context,
							options,
							providerSessionState,
							strictToolsScope,
							true,
						);
						const fallbackParams = fallbackBuilt.params;
						if (chainState && !chainState.disabled) fallbackParams.store = true;
						let fallbackChained: OpenAIResponsesChainedParams =
							chainState && !chainState.disabled
								? buildOpenAIResponsesChainedParams(
										fallbackParams,
										fallbackBuilt.trailingScaffoldingItems,
										chainState,
									)
								: { params: fallbackParams };
						sentPreviousResponseId = fallbackChained.previousResponseId;
						fallbackChained = {
							...fallbackChained,
							params: await applyPayloadReplacement(fallbackChained.params),
						};
						chained = fallbackChained;
						rawRequestDump.body = chained.params;
						activeParams = fallbackParams;
						activeTrailingScaffoldingItems = fallbackBuilt.trailingScaffoldingItems;
						activeStrictToolsApplied = fallbackBuilt.strictToolsApplied;
						continue;
					}
					if (!chainState || !sentPreviousResponseId || requestSignal.aborted) {
						throw error;
					}
					const zdrRejection =
						error instanceof Error &&
						/previous[ _]?response/i.test(error.message) &&
						/zero[ _-]?data[ _-]?retention/i.test(error.message);
					if (!zdrRejection && !isOpenAIResponsesStalePreviousResponseError(error)) {
						throw error;
					}
					// Server rejected the chain baseline: reset, count the failure (or
					// disable categorically on ZDR), and retry once with the full
					// transcript. Structurally cannot loop — the retry carries no
					// previous_response_id.
					if (zdrRejection) {
						markOpenAIResponsesChainZeroDataRetention(chainState, error);
						// ZDR orgs cannot store responses; the retry uses `store: false`.
					} else {
						registerOpenAIResponsesChainStaleFailure(chainState, error);
					}
					sentPreviousResponseId = undefined;
					const currentBuilt = buildParams(
						model,
						context,
						options,
						providerSessionState,
						strictToolsScope,
						forceDisableStrictTools,
					);
					const currentParams = currentBuilt.params;
					// Only ZDR forces `store: false` (the org never persists responses). A
					// non-ZDR stale baseline is transient, so keep storing: the full-context
					// retry must be chainable next turn, and the consecutive stale-failure
					// breaker only trips when each retry stores and the next turn re-chains.
					currentParams.store = !zdrRejection;
					const retryParams = await applyPayloadReplacement(currentParams);
					chained = { params: retryParams };
					rawRequestDump.body = retryParams;
					activeParams = currentParams;
					activeTrailingScaffoldingItems = currentBuilt.trailingScaffoldingItems;
					activeStrictToolsApplied = currentBuilt.strictToolsApplied;
				}
			}
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			let sawTerminalResponseEvent = false;
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI responses stream stalled while waiting for the next event",
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				onIdle: () => requestAbortController.abort(),
				abortSignal: options?.signal,
				isProgressItem: isOpenAIResponsesProgressEvent,
			});
			await processResponsesStream(timedOpenaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				onOutputItemDone: item => {
					// `processResponsesStream` hands over a private clone already; no
					// second deep copy needed (reasoning items carry multi-KB blobs).
					nativeOutputItems.push(item as unknown as Record<string, unknown>);
				},
				onCompleted: () => {
					sawTerminalResponseEvent = true;
				},
				requestServiceTier: options?.serviceTier,
			});

			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) {
				throw localAbortReason;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new AIError.AbortError();
			}

			// Detect premature stream closure: the HTTP stream ended without the
			// provider sending `response.completed` or `response.incomplete`.
			// Custom/proxy providers may drop the connection mid-stream; without
			// this guard the incomplete output is silently surfaced as a successful
			// "stop".
			if (!sawTerminalResponseEvent) {
				throw new AIError.ProviderResponseError(
					"OpenAI responses stream closed before a terminal response event was received",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
					provider: model.provider,
					kind: "runtime",
				});
			}

			output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			if (providerSessionState) providerSessionState.nativeHistoryReplayWarmed = true;
			if (chainState) {
				chainState.lastParams = structuredCloneJSON(
					activeTrailingScaffoldingItems > 0 && Array.isArray(activeParams.input)
						? {
								...activeParams,
								input: activeParams.input.slice(0, activeParams.input.length - activeTrailingScaffoldingItems),
							}
						: activeParams,
				);
				if (output.responseId) {
					chainState.lastResponseId = output.responseId;
					chainState.lastResponseItems = sanitizeOpenAIResponsesHistoryItemsForReplay(
						structuredCloneJSON(nativeOutputItems),
					);
					chainState.canAppend = true;
					// Only a successful CHAINED completion clears the stale counter — a
					// full-context success must not mask categorical rejection.
					if (sentPreviousResponseId) chainState.staleFailures = 0;
				} else {
					// Without a response id the append baseline cannot be trusted.
					chainState.canAppend = false;
				}
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			if (chainState) resetOpenAIResponsesChainState(chainState);
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				rawRequestDump,
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			// Some providers via OpenRouter include extra details here.
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Public entry: wrap the single-attempt Responses streamer with bounded
 * empty-completion retries — a `response.completed` carrying no content/usage
 * would otherwise stall the agent loop. Shared with the OpenAI-completions and
 * Anthropic providers via `withEmptyCompletionRetry`.
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAIResponsesOnce);

function isOfficialOpenAIResponsesEndpoint(model: Model<"openai-responses">): boolean {
	if (model.provider !== "openai") return false;
	if (!model.baseUrl) return true;
	try {
		return new URL(model.baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

export function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	strictToolsScope?: OpenAIStrictToolsScope,
	disableStrictToolsOverride = false,
): { params: OpenAIResponsesSamplingParams; trailingScaffoldingItems: number; strictToolsApplied: boolean } {
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: options?.toolChoice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const strictResponsesPairing = policy.tools.strictResponsesPairing;
	const shouldReplayNativeHistory = providerSessionState?.nativeHistoryReplayWarmed ?? true;
	const messages = buildResponsesInput({
		model,
		context,
		strictResponsesPairing,
		supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
		nativeHistory: {
			replay: shouldReplayNativeHistory,
			filterReasoning: policy.reasoning.filterReasoningHistory,
		},
		includeThinkingSignatures: shouldReplayNativeHistory && !policy.reasoning.filterReasoningHistory,
		repairOrphanOutputs: true,
	});

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	let systemInstructions: string | undefined;
	if (systemPrompts.length > 0) {
		const needsDeveloperRole = policy.messages.systemRole === "developer";
		if (needsDeveloperRole) {
			// Reasoning models on known OpenAI-compatible endpoints require the
			// `developer` role. Send all system prompts inline in `input`.
			messages.unshift(
				...systemPrompts.map(systemPrompt => ({ role: "developer" as const, content: systemPrompt })),
			);
		} else {
			// All other endpoints (including third-party /v1/responses proxies) use
			// the canonical top-level `instructions` field so that proxies that
			// reject `input[{role:"system"}]` work out of the box.
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = getOpenAIResponsesPromptCacheKey(options);
	const modelId = applyWireModelIdTransform(
		model.requestModelId ?? model.id,
		model.compat.wireModelIdMode,
		options?.openrouterVariant,
	);
	const params: OpenAIResponsesSamplingParams = {
		model: modelId,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: promptCacheKey
			? cacheRetention === "long" && model.compat.supportsLongPromptCacheRetention
				? "24h"
				: undefined
			: undefined,
		// Gateway routing: OpenRouter-only Responses wire field for sticky upstream
		// routing + observability grouping; no equivalent on direct OpenAI.
		session_id: model.compat.isOpenRouterHost ? getOpenRouterResponsesSessionId(options) : undefined,
		store: false,
		stream_options: model.compat.supportsObfuscationOptOut ? { include_obfuscation: false } : undefined,
	};
	maybeAddOpenRouterAnthropicCacheControl(params, model, cacheRetention);
	const outputToken = resolveOpenAIOutputTokenParam({
		field: "max_output_tokens",
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		isOpenRouterHost: model.compat.isOpenRouterHost,
		alwaysSendMaxTokens: model.compat.alwaysSendMaxTokens,
	});

	applyCommonResponsesSamplingParams(params, { ...options, maxTokens: outputToken?.value }, model);
	if (options?.textVerbosity && isOfficialOpenAIResponsesEndpoint(model)) {
		params.text = { ...params.text, verbosity: options.textVerbosity };
	}
	// TODO: openai responses has no top-level `stop`/`stop_sequences`; surface via reasoning.stop?
	// `StreamOptions.stopSequences` is intentionally dropped for this provider.
	// TODO: openai responses has no top-level `frequency_penalty` field as of the current SDK;
	// `StreamOptions.frequencyPenalty` is intentionally dropped for this provider.

	let strictToolsApplied = false;
	if (context.tools) {
		const disableStrictTools =
			disableStrictToolsOverride || isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
		const strictMode = !disableStrictTools && model.compat.supportsStrictMode;
		params.tools = convertTools(context.tools, strictMode, model);
		strictToolsApplied = params.tools.some(t => (t as { strict?: boolean }).strict === true);
		if (options?.toolChoice) {
			// Map tool_choice against the tools that survived quarantine, not the
			// original list: a forced choice for a dropped tool — or "required" when
			// every tool was dropped — would otherwise send a tool_choice with no
			// matching tool, which the provider rejects just like the bad schema did (#2652).
			const emittedNames = new Set(
				params.tools.map(t => (t as { name?: string }).name).filter((n): n is string => n !== undefined),
			);
			const survivingTools =
				params.tools.length === context.tools.length
					? context.tools
					: context.tools.filter(t => emittedNames.has(t.customWireName ?? t.name));
			const toolChoice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, survivingTools, model);
			if (toolChoice !== undefined && params.tools.length > 0) {
				params.tool_choice = toolChoice;
			}
		}
	}

	const reasoningPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const trailingScaffoldingItems = applyResponsesCompatPolicy(params, messages, reasoningPolicy, {
		reasoningSummary: options?.reasoningSummary,
		mapEffort: effort =>
			model.compat.reasoningEffortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			model.thinking?.effortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			effort,
	});

	applyOpenAIGatewayRouting(params, model.compat);

	applyOpenAIExtraBody(params, options?.extraBody);

	return { params, trailingScaffoldingItems, strictToolsApplied };
}

/**
 * Whether this model should get the OpenAI custom-tool grammar variant
 * for `apply_patch`. The generated model catalog sets
 * `model.applyPatchToolType` for first-party GPT-5 Responses models; this
 * runtime path only consumes that metadata.
 * @internal Exported for tests.
 */
export function supportsFreeformApplyPatch(model: Model<"openai-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

/** @internal Exported for tests. */
export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	if (!model.compat.supportsToolChoice) return undefined;
	if (isForcedToolChoice(choice) && !model.compat.supportsForcedToolChoice) {
		return "auto";
	}
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (!mapped || typeof mapped === "string" || mapped.type !== "function") {
		return mapped;
	}

	const directTool = tools.find(tool => tool.name === mapped.name);
	const customTool = supportsFreeformApplyPatch(model)
		? tools.find(tool => tool.customFormat && (tool.name === mapped.name || tool.customWireName === mapped.name))
		: undefined;
	const offeredTool = customTool ?? directTool;
	if (!offeredTool) {
		return undefined;
	}
	return customTool ? { type: "custom", name: customTool.customWireName ?? customTool.name } : mapped;
}

/** @internal Exported for tests. */
export function convertTools(
	tools: Tool[],
	strictMode: boolean,
	model: Model<"openai-responses">,
	onQuarantine: (toolName: string, schemaPath: string) => void = (toolName, schemaPath) =>
		logger.warn(
			`Tool "${toolName}" omitted from the openai-responses request: its parameter schema is invalid for this provider at ${schemaPath} (an enum/const value cannot match its declared type). Other tools are unaffected.`,
		),
): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	const out: OpenAITool[] = [];
	for (const tool of tools) {
		if (allowFreeform && tool.customFormat) {
			out.push({
				type: "custom",
				// Tool advertises its wire-level name (e.g. `apply_patch`) — the
				// agent-loop dispatcher will match incoming calls by either the
				// internal `name` or `customWireName`.
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool);
			continue;
		}
		const strict = !NO_STRICT && strictMode && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		// Quarantine a tool whose emitted schema carries a provider-rejecting
		// enum/const-vs-type contradiction: dropping just that tool keeps the rest
		// of the request valid instead of letting one bad MCP schema 400 the whole
		// turn (#2652). Other tools and built-ins are unaffected.
		const violation = findStrictToolSchemaViolation(parameters);
		if (violation) {
			onQuarantine(tool.name, violation);
			continue;
		}
		out.push({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		} as OpenAITool);
	}
	return out;
}
