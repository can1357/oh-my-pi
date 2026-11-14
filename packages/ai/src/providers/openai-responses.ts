import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { resolveResponsesWebSocketPreference } from "@oh-my-pi/pi-catalog/compat/responses-websocket";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	$flag,
	cloneJsonTree,
	isUnexpectedSocketCloseMessage,
	logger,
	type ServerSentEvent,
	structuredCloneJSON,
} from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getEnvApiKey } from "../env-api-key";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAICompat,
	ProviderSessionState,
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
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { getProxyForUrl } from "../utils/proxy";
import { toolNamesByWire } from "../utils/tool-names";
import { isOpenAIResponsesProgressEvent } from "../utils/websocket";
import { wrapFetchForRequestCompression } from "../utils/request-compression";
import { waitForRetry } from "../utils/retry-wait";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	flattenExclusiveRequiredRootUnion,
	NO_STRICT,
	normalizeSchemaForMoonshot,
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
	type OpenAIEffortControlState,
	planStableOpenAIEffort,
	releaseOpenAIEffortControlSession,
	resolveOpenAIEffortControlState,
} from "./openai-configuration-update";
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
import { resolveCopilotRequestIdentity, wrapFetchForCopilotFallback } from "./github-copilot-headers";
import { OpenAIResponsesRequestRejection } from "./openai-request-error";
import type {
	Tool as OpenAITool,
	ReasoningEffort,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import { type StandardResponsesWebSocketLease, OpenAIResponsesTransportSessions } from "./openai-responses-session";
import {
	applyCommonResponsesSamplingParams,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyResponsesCompatPolicy,
	applyVercelResponsesCacheControls,
	applyWireModelIdTransform,
	buildResponsesDeltaInput,
	buildResponsesInput,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	encodeResponsesToolName,
	getJuiceValue,
	getOpenAIPromptCacheKey,
	getOpenAIResponsesRoutingSessionId,
	normalizeOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	getOpenRouterResponsesSessionId,
	isCompiledGrammarTooLargeStrictError,
	isOpenAIResponsesRefusedEncryptedReasoningError,
	isOpenAIResponsesStalePreviousResponseError,
	isStrictToolsDisabledForScope,
	readOpenRouterRawMetadata,
	type OpenAIPromptCacheOptions,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	processResponsesStream,
	replaysEncryptedReasoning,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	resolveOpenAIResponsesOutputClamp,
	resolveReasoningSummaryOption,
	type ResponsesToolNaming,
	shouldDropAutoToolChoiceForReasoning,
	shouldRetryWithoutStrictTools,
	throwOpenAIResponsesEventError,
} from "./openai-shared";
import { readOpenRouterGenerationError } from "./openrouter-generation";
import {
	OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX,
	resetOpenAIResponsesChainState,
	storesResponsesServerSide,
} from "./openai-responses-state";
import { isResponsesWebSocketProgressEvent, ResponsesWebSocketTransportError } from "./responses-websocket-connection";

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	/**
	 * Prefer WebSocket response.create on the standard /responses endpoint.
	 * Disabled unless this option or model.preferWebsockets is true; either
	 * explicit false vetoes true. WebSockets always require catalog compatibility.
	 * Reuses socket-local previous_response_id anchors when history is append-only.
	 * Pre-send transport failures may fall back to HTTP; sent generations never replay.
	 */
	preferWebsockets?: boolean;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: ToolChoice;
	openrouterVariant?: string;
	maxTokensExplicit?: boolean;
	disableReasoning?: boolean;
	/**
	 * Enables or disables `previous_response_id` chaining. Precedence: this
	 * option, then `PI_OPENAI_STATEFUL`, then `compat.statefulResponses`, then a
	 * transport default. WebSockets default ON with socket-local continuation and
	 * no forced storage; HTTP/SSE defaults ON only against the official OpenAI API
	 * and forces `store: true` (the platform only resolves stored responses).
	 * Three consecutive stale-anchor rejections disable chaining for the session.
	 * HTTP/SSE chaining requires `sessionId` + `providerSessionState`. Falls back
	 * to a full replay whenever history
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
	/** Opt-in GPT-5.6+ prompt-cache policy. Unsupported explicit mode fails locally. */
	promptCache?: OpenAIPromptCacheOptions;
	/**
	 * Send no `X-Stainless-Timeout` for the first-event budget. For adapter
	 * wrappers whose native client strips the SDK telemetry headers.
	 */
	omitStainlessTimeoutHeader?: boolean;
}

const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";
/** Consecutive stale-previous-response failures before chaining is disabled for the session. */
const OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT = 3;
const OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES = 1;
const OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS = 500;

function isOpenAIResponsesReplayUnsafeEvent(event: ResponseStreamEvent): boolean {
	switch (event.type) {
		case "response.output_text.delta":
		case "response.refusal.delta":
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
		case "response.function_call_arguments.delta":
		case "response.custom_tool_call_input.delta":
			return typeof event.delta === "string" && event.delta.length > 0;
		case "response.reasoning_summary_part.done":
			return true;
		case "response.output_item.done":
			return true;
		default:
			return false;
	}
}

function isRetryableOpenAIResponsesStreamFailure(error: unknown): boolean {
	// Terminal malformed output needs the agent's corrective reminder, not an
	// identical billable replay inside the transport adapter.
	if (
		error instanceof AIError.ProviderResponseError &&
		error.kind === "output" &&
		AIError.is(AIError.classify(error), AIError.Flag.MalformedFunctionCall)
	) {
		return false;
	}
	return (
		AIError.isTransientStreamParseError(error) ||
		(error instanceof AIError.ProviderResponseError && error.kind === "incomplete-stream") ||
		AIError.isProviderRetryableError(error)
	);
}

const OPENAI_RESPONSES_RESUME_POLL_INTERVAL_MS = 5_000;
/** Wall-clock budget for the whole recovery: a long high-effort turn finishing server-side. */
const OPENAI_RESPONSES_RESUME_DEADLINE_MS = 120_000;
/** Backstop on request count, independent of the clock. */
const OPENAI_RESPONSES_RESUME_MAX_POLLS = 24;
const OPENAI_RESPONSES_RESUME_POLL_ATTEMPT_TIMEOUT_MS = 30_000;

/** Decoded `GET /responses/{id}` body; only the fields resume needs. */
interface OpenAIResponsesPolledResult {
	id?: unknown;
	status?: unknown;
	output?: unknown;
}

/**
 * Poll a stored Responses result until it reaches an adoptable terminal state.
 * 404s, 5xx, and transport failures mean "not yet" (an in-flight run only
 * becomes retrievable once the server finishes it); any other status, a
 * mismatched id, or a failed/cancelled run ends the poll immediately. The
 * whole recovery is bounded by one wall-clock deadline: each request's timeout
 * is clamped to the time left, and no sleep may cross the deadline, so a
 * stalled host cannot hold an already-failed turn past it. Returns the
 * terminal object, or undefined on give-up/abort.
 *
 * @internal Exported for tests.
 */
export async function pollOpenAIResponsesResultForCompletion(args: {
	fetchImpl: NonNullable<StreamOptions["fetch"]>;
	url: string;
	headers: Record<string, string>;
	responseId: string;
	signal?: AbortSignal;
	/** Sleep between polls; defaults to a real wait honoring `signal`. */
	wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<Record<string, unknown> | undefined> {
	const deadline = Date.now() + OPENAI_RESPONSES_RESUME_DEADLINE_MS;
	for (let attempt = 0; attempt < OPENAI_RESPONSES_RESUME_MAX_POLLS; attempt++) {
		if (args.signal?.aborted) return undefined;
		if (attempt > 0) {
			if (Date.now() + OPENAI_RESPONSES_RESUME_POLL_INTERVAL_MS >= deadline) return undefined;
			try {
				await waitForRetry(args.wait, OPENAI_RESPONSES_RESUME_POLL_INTERVAL_MS, args.signal);
			} catch {
				return undefined;
			}
			if (args.signal?.aborted) return undefined;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return undefined;
		const attemptTimeout = AbortSignal.timeout(
			Math.min(OPENAI_RESPONSES_RESUME_POLL_ATTEMPT_TIMEOUT_MS, remainingMs),
		);
		let status: number | undefined;
		let body: OpenAIResponsesPolledResult | undefined;
		try {
			const response = await args.fetchImpl(args.url, {
				headers: args.headers,
				signal: args.signal ? AbortSignal.any([args.signal, attemptTimeout]) : attemptTimeout,
			});
			status = response.status;
			if (status === 200) {
				const decoded: unknown = await response.json().catch(() => undefined);
				if (decoded !== null && typeof decoded === "object") {
					body = decoded as OpenAIResponsesPolledResult;
				}
			}
		} catch {
			body = undefined;
		}
		if (status === 200) {
			if (body?.id !== args.responseId) return undefined;
			if (
				body.status === "completed" ||
				(body.status === "incomplete" && Array.isArray(body.output) && body.output.length > 0)
			) {
				// Validated above (id match, adoptable terminal status): hand the
				// decoded body to the event synthesizer as untyped wire JSON.
				const record: Record<string, unknown> = body as unknown as Record<string, unknown>;
				return record;
			}
			if (body.status === "failed" || body.status === "cancelled") return undefined;
		} else if (status !== undefined && status !== 404 && status < 500) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Whether a failed attempt may resume the server-side run instead of replaying
 * the turn: the failure is a mid-stream socket close (or premature close), the
 * request stored its result, a response id was captured, and the dead partial
 * streamed only reasoning. Visible text is excluded: delta-only consumers (ACP)
 * already rendered it and cannot retract it, so an adopted answer that differs
 * would leave the client showing stale text. Tool/image/server-tool blocks are
 * excluded because they may already have side effects.
 */
function canResumeOpenAIResponsesResultAfterDrop(args: {
	responseId: string | undefined;
	storeEnabled: boolean;
	partialContent: AssistantMessage["content"];
	failure: unknown;
}): boolean {
	if (!args.responseId || !args.storeEnabled) return false;
	let hasThinking = false;
	for (const block of args.partialContent) {
		if (block.type === "thinking") {
			if (block.thinking.trim().length > 0) hasThinking = true;
			continue;
		}
		if (block.type === "text" && block.text.trim().length === 0) continue;
		return false;
	}
	if (!hasThinking) return false;
	const message = args.failure instanceof Error ? args.failure.message : String(args.failure ?? "");
	const prematureClose =
		args.failure instanceof AIError.ProviderResponseError && args.failure.kind === "incomplete-stream";
	return isUnexpectedSocketCloseMessage(message) || prematureClose;
}

/**
 * Replays a polled terminal response through the normal item pipeline the way
 * a live stream would deliver it, so delta-only consumers render the adopted
 * answer: each item is announced (messages with empty content), message text
 * arrives as `output_text`/`refusal` deltas, then the item completes and the
 * terminal event closes the run. Reasoning is not re-streamed as deltas (the
 * dead partial's reasoning already reached the client); it lands in the final
 * message through `output_item.done`. The double assertion is load-bearing:
 * the polled body is untyped wire JSON whose items only become typed when the
 * pipeline validates them per item.
 */
async function* resumeOpenAIResponsesEventStream(
	response: Record<string, unknown>,
): AsyncGenerator<ResponseStreamEvent> {
	const items: unknown[] = Array.isArray(response.output) ? response.output : [];
	let sequenceNumber = 0;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const isRecord = item !== null && typeof item === "object";
		const isMessage = isRecord && "type" in item && item.type === "message";
		const parts: unknown[] = isMessage && "content" in item && Array.isArray(item.content) ? item.content : [];
		const itemId = isRecord && "id" in item ? item.id : undefined;
		yield {
			type: "response.output_item.added",
			output_index: index,
			item: isMessage ? { ...item, content: [] } : item,
			sequence_number: sequenceNumber++,
		} as unknown as ResponseStreamEvent;
		for (let partIndex = 0; partIndex < parts.length; partIndex++) {
			const part = parts[partIndex];
			if (part === null || typeof part !== "object" || !("type" in part)) continue;
			if (part.type === "output_text" && "text" in part && typeof part.text === "string") {
				yield {
					type: "response.output_text.delta",
					output_index: index,
					item_id: itemId,
					content_index: partIndex,
					delta: part.text,
					sequence_number: sequenceNumber++,
				} as unknown as ResponseStreamEvent;
			} else if (part.type === "refusal" && "refusal" in part && typeof part.refusal === "string") {
				yield {
					type: "response.refusal.delta",
					output_index: index,
					item_id: itemId,
					content_index: partIndex,
					delta: part.refusal,
					sequence_number: sequenceNumber++,
				} as unknown as ResponseStreamEvent;
			}
		}
		yield {
			type: "response.output_item.done",
			output_index: index,
			item,
			sequence_number: sequenceNumber++,
		} as unknown as ResponseStreamEvent;
	}
	yield {
		type: "response.completed",
		response,
		sequence_number: sequenceNumber,
	} as unknown as ResponseStreamEvent;
}

export interface OpenAIResponsesProviderSessionState
	extends ProviderSessionState, OpenAIStrictToolsState, OpenAIReasoningEffortFallbackState {
	/**
	 * Replay native history items. Starts false only on connection-bound hosts;
	 * `close()` clears it so the next request rebuilds history from message
	 * content; the first successful response sets it.
	 */
	nativeHistoryReplayWarmed: boolean;
	/** Bumped by `close()`; a response warms the state only if no close happened since its request started. */
	closeCount: number;
	/** Stateful `previous_response_id` chain baselines, keyed by baseUrl/model/session. */
	chains: Map<string, OpenAIResponsesChainState>;
	/** `configuration_update` effort baselines, keyed by baseUrl/model/session. */
	effortControls: Map<string, OpenAIEffortControlState<ResponsesStableEffort>>;
	transports?: OpenAIResponsesTransportSessions;
}

/** Wire efforts a `configuration_update` can carry: every real tier, never `none`/null. */
type ResponsesStableEffort = Exclude<ReasoningEffort, "none" | null>;

const RESPONSES_STABLE_EFFORTS: Record<ResponsesStableEffort, true> = {
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

function isResponsesStableEffort(effort: string): effort is ResponsesStableEffort {
	return Object.hasOwn(RESPONSES_STABLE_EFFORTS, effort);
}

/** Wire `reasoning.effort` for `level` on this model: catalog effort maps first, else the level itself. */
function mapResponsesEffort(
	model: Model<"openai-responses">,
	level: Effort | NonNullable<OpenAIResponsesOptions["reasoning"]>,
): string {
	return model.compat.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? level;
}

export interface OpenAIResponsesChainState {
	sessionId: string;
	/**
	 * Wire params of the last successful turn; never carries
	 * `previous_response_id`.
	 */
	lastParams?: OpenAIResponsesSamplingParams;
	lastPromptCacheBreakpointPolicy?: "latest-stable-message" | "none";
	lastResponseId?: string;
	/** Output items of the last response, in replay-sanitized form (matches next-turn input). */
	lastResponseItems?: ResponseInput;
	canAppend: boolean;
	/** Consecutive stale-previous-response failures; reset on a successful chained completion. */
	staleFailures: number;
	/** Set once chaining is judged unsupported for this session (circuit breaker). */
	disabled: boolean;
}

function createOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
): OpenAIResponsesProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAIResponsesProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		nativeHistoryReplayWarmed: !model.compat.connectionBoundNativeHistory,
		closeCount: 0,
		chains: new Map(),
		effortControls: new Map(),
		releaseSession: sessionId => {
			const normalizedSessionId = normalizeOpenAIPromptCacheKey(sessionId);
			if (!normalizedSessionId) return;
			for (const [key, chain] of state.chains) {
				if (chain.sessionId === normalizedSessionId) state.chains.delete(key);
			}
			releaseOpenAIEffortControlSession(state.effortControls, normalizedSessionId);
			state.transports?.releaseSession(normalizedSessionId);
		},
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.closeCount++;
			state.chains.clear();
			state.effortControls.clear();
			state.transports?.close();
			state.transports = undefined;
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
	const created = createOpenAIResponsesProviderSessionState(model);
	providerSessionState.set(key, created);
	return created;
}

function isOpenAIResponsesStatefulEnabled(
	options: OpenAIResponsesOptions | undefined,
	model: Model<"openai-responses">,
): boolean {
	// Chaining forces `store: true`, so a storing host whose storage is off
	// must never chain — not even when the caller asks for it.
	if (model.compat.storeResponses === true && !storesResponsesServerSide(model, options)) return false;
	if (options?.statefulResponses === false) return false;
	if (options?.statefulResponses === true) return true;
	// Default ON only against the official OpenAI API: chaining forces
	// `store: true`, and third-party /v1/responses proxies routinely ignore or
	// reject `previous_response_id`.
	return $flag("PI_OPENAI_STATEFUL", model.compat.statefulResponses ?? model.compat.officialEndpoint);
}

/**
 * Socket-local continuation needs no stored responses, so the official-endpoint
 * default does not apply. Explicit opt-outs (option, env, compat) still do: a
 * gateway that ignores `previous_response_id` would silently drop prior turns.
 */
function isOpenAIResponsesWebSocketChainEnabled(
	options: OpenAIResponsesOptions | undefined,
	model: Model<"openai-responses">,
): boolean {
	if (options?.statefulResponses !== undefined) return options.statefulResponses;
	return $flag("PI_OPENAI_STATEFUL", model.compat.statefulResponses ?? true);
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
	const created: OpenAIResponsesChainState = { sessionId, canAppend: false, staleFailures: 0, disabled: false };
	providerSessionState.chains.set(key, created);
	return created;
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
 * The prefix check runs on the wire form of the conversation arguments, so
 * history mutations or option changes force a full replay.
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
	caching?: "auto";
	cache_anchor_items?: number;
	cache_ttl?: "5m" | "1h";
};

function maybeAddOpenRouterAnthropicCacheControl(
	params: OpenAIResponsesSamplingParams,
	model: Model<"openai-responses">,
	cacheRetention: CacheRetention,
): void {
	if (cacheRetention === "none" || model.compat.cacheControlFormat !== "anthropic") return;
	if (params.cache_control != null) return;
	params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

type ResponsesTransport = "websocket" | "sse";

interface ResponsesAttemptContext {
	mode: ResponsesTransport | undefined;
	/** Set once the server refused replayed encrypted reasoning; later attempts build without it. */
	dropEncryptedReasoning: boolean;
}

function isPreSendTransportFallback(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted || !(error instanceof ResponsesWebSocketTransportError)) return false;
	if (error.status !== undefined) return [404, 405, 426, 501].includes(error.status);
	return (
		error.reason === "closed" ||
		error.reason === "socket-error" ||
		error.reason === "timeout" ||
		error.reason === "unavailable"
	);
}

function isPostSendTransportFailure(error: unknown): boolean {
	return (
		error instanceof AIError.StreamTimeoutError ||
		(error instanceof ResponsesWebSocketTransportError &&
			(error.reason === "closed" ||
				error.reason === "socket-error" ||
				error.reason === "send" ||
				error.reason === "unavailable"))
	);
}

/** Prime inside parameter fallback handling, without another parser or stream deadline. */
async function primeResponsesWebSocketStream(
	events: AsyncIterable<ResponseStreamEvent>,
): Promise<AsyncIterable<ResponseStreamEvent>> {
	const iterator = events[Symbol.asyncIterator]();
	let first: IteratorResult<ResponseStreamEvent>;
	try {
		first = await iterator.next();
	} catch (error) {
		await iterator.return?.();
		throw error;
	}
	return (async function* (): AsyncGenerator<ResponseStreamEvent> {
		try {
			if (!first.done) {
				yield first.value;
				yield* { [Symbol.asyncIterator]: () => iterator };
			}
		} finally {
			await iterator.return?.();
		}
	})();
}

/**
 * Generate function for OpenAI Responses API
 */
const streamOpenAIResponsesOnce = (
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	attemptContext: ResponsesAttemptContext,
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
		let lastSubmittedRequestWasFullReplay: boolean | undefined;
		let webSocketLease: StandardResponsesWebSocketLease | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent
			? (event: ServerSentEvent) => {
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
					onSseEvent({ event: event.event, data: event.data, raw: [...event.raw] }, model);
				}
			: undefined;

		try {
			// Keep request routing on `sessionId` while allowing callers to pin a
			// stable prompt-cache key independently. Side-channel calls use this to
			// avoid perturbing provider conversation state without cold-starting the cache.
			const routingSessionId = getOpenAIResponsesRoutingSessionId(options);
			const promptCacheSessionId = getOpenAIPromptCacheKey(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { headers, copilotPremiumRequests, baseUrl, copilotCacheKey, copilotCacheSnapshot } =
				resolveOpenAIRequestSetup(model, {
					apiKey,
					extraHeaders: options?.headers,
					initiatorOverride: options?.initiatorOverride,
					messages: context.messages,
					sessionId: options?.sessionId ?? routingSessionId,
					promptCacheSessionId,
					// The family affinity key rides only an explicit prompt-cache
					// identity; the sessionId-derived cache-id fallback never does.
					promptCacheAffinityKey: options?.promptCacheKey ? promptCacheSessionId : undefined,
				});
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const resolvedBaseUrl = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
			const requestUrl = `${resolvedBaseUrl}/responses`;
			let transportSessions = providerSessionState?.transports;
			attemptContext.mode ??= resolveResponsesWebSocketPreference(model, options?.preferWebsockets)
				? "websocket"
				: "sse";
			const idleTimeoutMs =
				options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ??
				getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, model.compat.streamFirstEventTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			if (attemptContext.mode === "websocket") {
				const endpoint = new URL(requestUrl);
				const scope = {
					url: endpoint.href,
					modelId: model.id,
					sessionId: providerSessionState ? normalizeOpenAIPromptCacheKey(options?.sessionId) : undefined,
				};
				if (transportSessions?.isSseOnly(scope)) {
					attemptContext.mode = "sse";
				} else {
					transportSessions ??= new OpenAIResponsesTransportSessions();
					if (providerSessionState) providerSessionState.transports = transportSessions;
					webSocketLease = transportSessions.acquire({
						scope,
						headers,
						proxy: getProxyForUrl(model.provider, endpoint),
						connectTimeoutMs: Math.min(30_000, requestTimeoutMs ?? 30_000),
						retainConnection: routingSessionId !== undefined,
					});
				}
			}
			let useWebSocket = attemptContext.mode === "websocket";
			const closeCountAtStart = providerSessionState?.closeCount;
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			const promptCacheBreakpointPolicy =
				resolveCacheRetention(options?.cacheRetention) !== "none" && options?.promptCache?.mode === "explicit"
					? (options.promptCache.breakpoint ?? "latest-stable-message")
					: undefined;
			if (
				!useWebSocket &&
				isOpenAIResponsesStatefulEnabled(options, model) &&
				routingSessionId &&
				providerSessionState
			) {
				chainState = getOpenAIResponsesChainState(providerSessionState, model, baseUrl, routingSessionId);
				if (chainState.canAppend && chainState.lastPromptCacheBreakpointPolicy !== promptCacheBreakpointPolicy) {
					resetOpenAIResponsesChainState(chainState);
				}
			}
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
			const applyPayloadReplacement = async (requestParams: OpenAIResponsesSamplingParams) => {
				const replacementPayload = await options?.onPayload?.(requestParams, model);
				const payload =
					replacementPayload !== undefined ? (replacementPayload as OpenAIResponsesSamplingParams) : requestParams;
				applyReasoningEffortFallbackForRequest(payload);
				return payload;
			};
			// Rebuilt with each request so the table reflects the tools that
			// survived construction (schema quarantine, strict-mode retry).
			let wireToolNames: ReadonlyMap<string, string> | undefined;
			const prepareRequest = async (disableStrictTools = false) => {
				const builtParams = buildParams(
					model,
					context,
					options,
					providerSessionState,
					strictToolsScope,
					disableStrictTools,
					chainState?.canAppend ? chainState.lastParams?.input : undefined,
					attemptContext.dropEncryptedReasoning,
				);
				const { params, trailingScaffoldingItems } = builtParams;
				wireToolNames = builtParams.toolNamesByWire;
				if (chainState && !chainState.disabled) params.store = true;
				applyReasoningEffortFallbackForRequest(params);
				const chained: OpenAIResponsesChainedParams =
					chainState && !chainState.disabled
						? buildOpenAIResponsesChainedParams(params, trailingScaffoldingItems, chainState)
						: { params };
				sentPreviousResponseId = chained.previousResponseId;
				return { builtParams, chained: { ...chained, params: await applyPayloadReplacement(chained.params) } };
			};
			let { builtParams, chained } = await prepareRequest();
			let activeParams = builtParams.params;
			let activeTrailingScaffoldingItems = builtParams.trailingScaffoldingItems;
			if (webSocketLease) {
				const connection = webSocketLease.session.connection;
				const freshHandshake = !connection.isOpen();
				try {
					await connection.connect(requestSignal);
					if (freshHandshake && connection.handshakeHeaders) {
						await options?.onResponse?.(
							{
								status: 101,
								headers: Object.fromEntries(connection.handshakeHeaders),
								metadata: { transport: "websocket", phase: "handshake" },
							},
							model,
						);
					}
				} catch (error) {
					const upgrade = error instanceof ResponsesWebSocketTransportError ? error : undefined;
					try {
						if (!isPreSendTransportFallback(error, requestSignal)) {
							if (upgrade?.status !== undefined && !requestSignal.aborted) {
								throw new AIError.ProviderHttpError(upgrade.message, upgrade.status, {
									headers: upgrade.headers,
									cause: upgrade,
								});
							}
							throw error;
						}
						// A definite upgrade rejection proves the endpoint lacks WS; a network
						// failure or timeout may be a blip, so only repeated ones stick.
						if (upgrade?.status !== undefined) webSocketLease.markSseOnly();
						else webSocketLease.recordConnectFailure();
						attemptContext.mode = "sse";
						useWebSocket = false;
						if (providerSessionState && routingSessionId) {
							const state = getOpenAIResponsesChainState(providerSessionState, model, baseUrl, routingSessionId);
							resetOpenAIResponsesChainState(state);
							if (isOpenAIResponsesStatefulEnabled(options, model)) chainState = state;
						}
					} finally {
						webSocketLease.release();
						webSocketLease = undefined;
					}
					// A different transport is a different candidate: rebuild HTTP
					// storage/chaining controls, then let the hook replace that body.
					({ builtParams, chained } = await prepareRequest());
					activeParams = builtParams.params;
					activeTrailingScaffoldingItems = builtParams.trailingScaffoldingItems;
				}
			}
			const activeRawRequestDump: RawHttpRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: requestUrl,
				body: chained.params,
			};
			rawRequestDump = activeRawRequestDump;
			const openResponsesStream = async (
				requestParams: OpenAIResponsesSamplingParams,
			): Promise<AsyncIterable<ResponseStreamEvent>> => {
				activeReasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"responses",
					resolvedBaseUrl,
					typeof requestParams.model === "string" ? requestParams.model : model.id,
				);
				activeRequestParams = requestParams;
				lastSubmittedRequestWasFullReplay = requestParams.previous_response_id === undefined;
				let requestTimeout: NodeJS.Timeout | undefined;
				if (!useWebSocket && requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					if (useWebSocket) {
						if (requestParams.previous_response_id != null) {
							throw new Error(
								"OpenAI responses WebSocket previous_response_id is connection-owned and cannot be injected",
							);
						}
						if ("background" in requestParams && requestParams.background === true) {
							throw new Error("OpenAI responses WebSocket requests do not support background: true");
						}
						const lease = webSocketLease!;
						return lease.session.events(requestParams, {
							signal: requestSignal,
							chain: isOpenAIResponsesWebSocketChainEnabled(options, model) && !lease.chainDisabled,
							supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
							onSseEvent: rawSseObserver,
							onChainResult: accepted => lease.recordChainResult(accepted),
						});
					}
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined && !options?.omitStainlessTimeoutHeader) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const { events, response, requestId } = await postOpenAIStream<ResponseStreamEvent>({
						url: requestUrl,
						headers: headersWithTimeout,
						body: requestParams,
						signal: requestSignal,
						fetch: wrapFetchForCopilotFallback(
							wrapFetchForRequestCompression(options?.fetch ?? fetch, model),
							model.provider === "github-copilot",
							resolveCopilotRequestIdentity(options?.headers),
							copilotCacheKey,
							copilotCacheSnapshot,
						),
						shouldRetryResponse: (response, bodyText) =>
							!AIError.isRequestBodyReadTimeout(response.status, bodyText) ||
							lastSubmittedRequestWasFullReplay !== true,
						// Transient 408/429/5xx get Retry-After-aware transport
						// retries; the first-event watchdog aborts `requestSignal`,
						// so retries cannot extend the caller's deadline.
						onSseEvent: rawSseObserver,
					});
					// Disarm the first-event watchdog as soon as headers arrive — a slow
					// onResponse callback must not abort an already-connected stream.
					clearTimeout(requestTimeout);
					await notifyProviderResponse(options, response, model, requestId);
					return events;
				} finally {
					clearTimeout(requestTimeout);
				}
			};
			let webSocketFirstEventDeadline: number | undefined;
			const timeResponsesStream = (
				events: AsyncIterable<ResponseStreamEvent>,
			): AsyncGenerator<ResponseStreamEvent> => {
				let firstItemTimeoutMs = firstEventTimeoutMs;
				if (useWebSocket && requestTimeoutMs !== undefined) {
					webSocketFirstEventDeadline ??= Date.now() + requestTimeoutMs;
					firstItemTimeoutMs = webSocketFirstEventDeadline - Date.now();
					if (firstItemTimeoutMs <= 0) throw abortTracker.abortLocally(firstEventTimeoutAbortError);
				}
				return iterateWithIdleTimeout(events, {
					idleTimeoutMs,
					firstItemTimeoutMs,
					firstItemErrorMessage: OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
					errorMessage: "OpenAI responses stream stalled while waiting for the next event",
					onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
					onIdle: () =>
						useWebSocket
							? abortTracker.abortLocally(
									new AIError.StreamTimeoutError(
										"OpenAI responses stream stalled while waiting for the next event",
									),
								)
							: requestAbortController.abort(),
					abortSignal: options?.signal,
					isProgressItem: useWebSocket ? isResponsesWebSocketProgressEvent : isOpenAIResponsesProgressEvent,
				});
			};
			let strictRetryAvailable = true;
			let activeStrictToolsApplied = builtParams.strictToolsApplied;
			let forceDisableStrictTools = false;
			let encryptedReasoningRetryAvailable = true;
			// The server refused a replayed encrypted reasoning blob (key rotation,
			// another credential): resending fails the same way, so rebuild the full
			// transcript once without any earlier blob. Text, tool calls and results stay.
			const prepareEncryptedReasoningRetry = async (error: unknown): Promise<boolean> => {
				if (
					!encryptedReasoningRetryAvailable ||
					requestSignal.aborted ||
					!isOpenAIResponsesRefusedEncryptedReasoningError(error) ||
					!replaysEncryptedReasoning(activeParams.input)
				) {
					return false;
				}
				encryptedReasoningRetryAvailable = false;
				attemptContext.dropEncryptedReasoning = true;
				if (chainState) resetOpenAIResponsesChainState(chainState);
				const retry = await prepareRequest(forceDisableStrictTools);
				chained = retry.chained;
				activeRawRequestDump.body = chained.params;
				activeParams = retry.builtParams.params;
				activeTrailingScaffoldingItems = retry.builtParams.trailingScaffoldingItems;
				activeStrictToolsApplied = retry.builtParams.strictToolsApplied;
				logger.debug("OpenAI responses replayed encrypted reasoning refused; retrying without it", {
					provider: model.provider,
					model: model.id,
					error: error instanceof Error ? error.message : String(error),
				});
				return true;
			};
			const openResponsesStreamWithFallbacks = async (): Promise<AsyncIterable<ResponseStreamEvent>> => {
				let openaiStream: AsyncIterable<ResponseStreamEvent>;
				try {
					while (true) {
						try {
							openaiStream = await openResponsesStream(chained.params);
							if (useWebSocket) {
								openaiStream = await primeResponsesWebSocketStream(timeResponsesStream(openaiStream));
							}
							if (pendingReasoningEffortFallback) {
								// Explicit-disable fallbacks (none -> lowest allowed) are
								// per-request: persisting them under the model key would
								// silently downgrade later normal turns sharing the
								// session state. A retained effort preference does not
								// make the disable less explicit. Keep them in the
								// per-request map only.
								const isExplicitDisable =
									options?.forceReasoningOff === true || options?.disableReasoning === true;
								if (!isExplicitDisable) {
									rememberOpenAIReasoningEffortFallback(
										providerSessionState,
										pendingReasoningEffortFallback.key,
										pendingReasoningEffortFallback.fallback,
									);
								}
								pendingReasoningEffortFallback = undefined;
							}
							break;
						} catch (error) {
							const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
							const reasoningEffortFallback =
								activeReasoningEffortFallbackKey && activeRequestParams && !requestSignal.aborted
									? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
											explicitDisable:
												options?.forceReasoningOff === true || options?.disableReasoning === true,
										})
									: undefined;
							if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
								const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
								if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
								attemptedReasoningEffortFallbacks.add(retryMarker);
								requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
								applyOpenAIReasoningEffortFallback(chained.params, reasoningEffortFallback);
								applyOpenAIReasoningEffortFallback(activeParams, reasoningEffortFallback);
								activeRawRequestDump.body = chained.params;
								pendingReasoningEffortFallback = {
									key: activeReasoningEffortFallbackKey,
									fallback: reasoningEffortFallback,
								};
								continue;
							}
							if (await prepareEncryptedReasoningRetry(error)) continue;
							const compiledGrammarTooLarge =
								model.compat.retryWithoutStrictOnGrammarError &&
								isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse);
							const canRetryWithoutStrictTools =
								strictRetryAvailable &&
								!requestSignal.aborted &&
								(compiledGrammarTooLarge ||
									shouldRetryWithoutStrictTools(error, capturedErrorResponse, {
										model,
										strictToolsApplied: activeStrictToolsApplied,
										tools: context.tools,
									}));
							if (canRetryWithoutStrictTools) {
								strictRetryAvailable = false;
								forceDisableStrictTools = true;
								disableStrictToolsForScope(providerSessionState, strictToolsScope);
								const fallback = await prepareRequest(true);
								chained = fallback.chained;
								activeRawRequestDump.body = chained.params;
								activeParams = fallback.builtParams.params;
								activeTrailingScaffoldingItems = fallback.builtParams.trailingScaffoldingItems;
								continue;
							}
							if (!chainState || !sentPreviousResponseId || requestSignal.aborted) {
								throw error;
							}
							const zdrRejection =
								error instanceof Error &&
								/previous[ _]?response/i.test(error.message) &&
								/zero[ _-]?data[ _-]?retention/i.test(error.message);
							const isPromptBlocked =
								error instanceof Error &&
								((error as { code?: string }).code === "invalid_prompt" ||
									/invalid_prompt|Request blocked/i.test(error.message));
							if (!zdrRejection && !isPromptBlocked && !isOpenAIResponsesStalePreviousResponseError(error)) {
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
								undefined,
								attemptContext.dropEncryptedReasoning,
							);
							const currentParams = currentBuilt.params;
							// Only ZDR forces `store: false` (the org never persists responses). A
							// non-ZDR stale baseline is transient, so keep storing: the full-context
							// retry must be chainable next turn, and the consecutive stale-failure
							// breaker only trips when each retry stores and the next turn re-chains.
							currentParams.store = !zdrRejection;
							const retryParams = await applyPayloadReplacement(currentParams);
							chained = { params: retryParams };
							activeRawRequestDump.body = retryParams;
							activeParams = currentParams;
							activeTrailingScaffoldingItems = currentBuilt.trailingScaffoldingItems;
							activeStrictToolsApplied = currentBuilt.strictToolsApplied;
						}
					}
				} catch (error) {
					if (error instanceof OpenAIResponsesRequestRejection) {
						throwOpenAIResponsesEventError(error.event, output, model.provider);
					}
					throw error;
				}
				return openaiStream;
			};
			let openaiStream = await openResponsesStreamWithFallbacks();
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			let transientStreamRetryAttempt = 0;
			while (true) {
				let sawReplayUnsafeOutput = false;
				let sawTerminalResponseEvent = false;
				const attemptStream = new AssistantMessageEventStream();
				let forwardAttemptLive = false;
				const forwardAttemptEvents = () => {
					for (const event of attemptStream.queue) stream.push(event);
					attemptStream.queue.length = 0;
				};
				nativeOutputItems.length = 0;
				const timedOpenaiStream = useWebSocket ? openaiStream : timeResponsesStream(openaiStream);
				const observedOpenaiStream = (async function* (): AsyncGenerator<ResponseStreamEvent> {
					for await (const event of timedOpenaiStream) {
						if (isOpenAIResponsesReplayUnsafeEvent(event)) {
							sawReplayUnsafeOutput = true;
							if (!forwardAttemptLive) {
								forwardAttemptEvents();
								forwardAttemptLive = true;
							}
						}
						yield event;
						if (forwardAttemptLive) forwardAttemptEvents();
					}
				})();

				try {
					await processResponsesStream(observedOpenaiStream, output, attemptStream, model, {
						onFirstToken: () => {
							if (!firstTokenTime) firstTokenTime = performance.now();
						},
						onOutputItemDone: item => {
							// The processor hands over a private clone; no second deep copy needed.
							nativeOutputItems.push(item as unknown as Record<string, unknown>);
						},
						onCompleted: () => {
							sawTerminalResponseEvent = true;
						},
						requestServiceTier: options?.serviceTier,
						toolNamesByWire: wireToolNames,
					});

					const localAbortReason = abortTracker.getLocalAbortReason();
					if (localAbortReason) throw localAbortReason;
					if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();

					// Detect premature stream closure: the HTTP stream ended without the
					// provider sending a recognized terminal response event.
					if (!sawTerminalResponseEvent) {
						throw new AIError.ProviderResponseError(
							"OpenAI responses stream closed before a terminal response event was received",
							{ provider: model.provider, kind: "incomplete-stream" },
						);
					}

					// OpenRouter's Responses translation can hide a native failure behind
					// "completed". Consult metadata only for truly empty stops, never
					// for replayable reasoning or provider-hosted tool progress.
					if (
						model.compat.isOpenRouterHost &&
						output.stopReason === "stop" &&
						output.content.length === 0 &&
						nativeOutputItems.length === 0 &&
						!output.stopDetails &&
						output.responseId
					) {
						const nativeError = await readOpenRouterGenerationError({
							baseUrl: resolvedBaseUrl,
							headers,
							responseId: output.responseId,
							outputTokens: output.usage.output,
							reasoningTokens: output.usage.reasoningTokens,
							fetch: options?.fetch,
							signal: requestSignal,
						});
						if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();
						if (nativeError) {
							throw new AIError.ProviderResponseError(nativeError, { provider: model.provider, kind: "output" });
						}
					}

					if (output.stopReason === "aborted" || output.stopReason === "error") {
						throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
							provider: model.provider,
							kind: "runtime",
						});
					}
					forwardAttemptEvents();
					break;
				} catch (error) {
					const streamFailure = abortTracker.getLocalAbortReason() ?? error;
					// A socket that died after the server accepted the run may still
					// finish server-side: adopt the stored result instead of replaying
					// the turn when the dead partial executed nothing. Falls through
					// to the normal retry handling when resume is ineligible or the
					// poll gives up, leaving all existing behavior unchanged.
					const resumeId = output.responseId;
					if (
						!useWebSocket &&
						resumeId !== undefined &&
						canResumeOpenAIResponsesResultAfterDrop({
							responseId: resumeId,
							// Gate on the host contract, not the wire flag: stateful chaining
							// forces `store: true` on official OpenAI too, where a dropped run
							// is not known to finish server-side and polling would only park
							// a turn that used to fail fast.
							storeEnabled: storesResponsesServerSide(model, options),
							partialContent: output.content,
							failure: streamFailure,
						})
					) {
						const resumedResponse = await pollOpenAIResponsesResultForCompletion({
							fetchImpl: wrapFetchForCopilotFallback(
								options?.fetch,
								model.provider === "github-copilot",
								resolveCopilotRequestIdentity(options?.headers),
								copilotCacheKey,
								copilotCacheSnapshot,
							),
							url: `${resolvedBaseUrl}/responses/${resumeId}`,
							headers,
							responseId: resumeId,
							signal: options?.signal,
							wait: options?.providerRetryWait,
						});
						if (resumedResponse !== undefined) {
							const deadContent = [...output.content];
							const deadResponseId = output.responseId;
							const deadUsage = structuredCloneJSON(output.usage);
							const deadUpstreamModel = output.upstreamModel;
							const deadUpstreamProvider = output.upstreamProvider;
							const deadStopDetails = output.stopDetails;
							// The replay re-emits every output item, including any reasoning
							// item that already hit `output_item.done` before the drop; keep a
							// copy and start empty so no id is recorded twice for chaining.
							const deadNativeItems = [...nativeOutputItems];
							const deadQueueLength = attemptStream.queue.length;
							let resumedSawTerminal = false;
							try {
								output.content.length = 0;
								nativeOutputItems.length = 0;
								output.stopReason = "stop";
								output.stopDetails = undefined;
								await processResponsesStream(
									resumeOpenAIResponsesEventStream(resumedResponse),
									output,
									attemptStream,
									model,
									{
										onFirstToken: () => {
											if (!firstTokenTime) firstTokenTime = performance.now();
										},
										onOutputItemDone: item => {
											nativeOutputItems.push(item as unknown as Record<string, unknown>);
										},
										onCompleted: () => {
											resumedSawTerminal = true;
										},
										requestServiceTier: options?.serviceTier,
										toolNamesByWire: wireToolNames,
									},
								);
								const resumedLocalAbort = abortTracker.getLocalAbortReason();
								if (resumedLocalAbort) throw resumedLocalAbort;
								if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();
								if (!resumedSawTerminal) {
									throw new AIError.ProviderResponseError(
										"OpenAI responses resume poll returned a result without a terminal event",
										{ provider: model.provider, kind: "incomplete-stream" },
									);
								}
								if (
									output.stopReason !== "stop" &&
									output.stopReason !== "length" &&
									output.stopReason !== "toolUse"
								) {
									throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
										provider: model.provider,
										kind: "runtime",
									});
								}
								forwardAttemptEvents();
								break;
							} catch (adoptError) {
								logger.debug("OpenAI responses resume adoption failed; keeping the dead partial", {
									provider: model.provider,
									model: model.id,
									responseId: resumeId,
									error: adoptError instanceof Error ? adoptError.message : String(adoptError),
								});
								output.content.length = 0;
								output.content.push(...deadContent);
								output.responseId = deadResponseId;
								output.usage = deadUsage;
								output.upstreamModel = deadUpstreamModel;
								output.upstreamProvider = deadUpstreamProvider;
								output.stopDetails = deadStopDetails;
								nativeOutputItems.length = 0;
								nativeOutputItems.push(...deadNativeItems);
								attemptStream.queue.length = deadQueueLength;
								if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();
								const adoptLocalAbort = abortTracker.getLocalAbortReason();
								if (adoptLocalAbort) throw adoptLocalAbort;
							}
						}
					}
					const replaySafe =
						!useWebSocket && !sawReplayUnsafeOutput && !requestSignal.aborted && !abortTracker.wasCallerAbort();
					// An in-stream refusal of replayed encrypted reasoning, before any output.
					const encryptedReasoningRetry = replaySafe && (await prepareEncryptedReasoningRetry(streamFailure));
					const canRetry =
						encryptedReasoningRetry ||
						(replaySafe &&
							transientStreamRetryAttempt < OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES &&
							isRetryableOpenAIResponsesStreamFailure(streamFailure));
					if (!canRetry) {
						forwardAttemptEvents();
						throw streamFailure;
					}

					if (!encryptedReasoningRetry) {
						transientStreamRetryAttempt++;
						logger.debug("OpenAI responses stream ended before replay-unsafe output; retrying", {
							provider: model.provider,
							model: model.id,
							attempt: transientStreamRetryAttempt,
							error: streamFailure instanceof Error ? streamFailure.message : String(streamFailure),
						});
					}
					const retryOutput = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
					output.content.length = 0;
					output.responseId = undefined;
					output.upstreamProvider = undefined;
					output.errorMessage = undefined;
					output.errorStatus = undefined;
					output.errorId = undefined;
					output.stopDetails = undefined;
					output.providerPayload = undefined;
					output.usage = retryOutput.usage;
					if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
					output.stopReason = "stop";
					output.duration = undefined;
					output.ttft = undefined;
					firstTokenTime = undefined;
					nativeOutputItems.length = 0;

					if (!encryptedReasoningRetry) {
						await waitForRetry(
							options?.providerRetryWait,
							OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS,
							options?.signal,
						);
					}
					if (abortTracker.wasCallerAbort()) throw new AIError.AbortError();
					openaiStream = await openResponsesStreamWithFallbacks();
				}
			}

			const historyPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			// Persisted with the turn so later requests, even after a restart, omit the refused blobs.
			if (attemptContext.dropEncryptedReasoning) historyPayload.encryptedReasoningFloor = true;
			output.providerPayload = historyPayload;
			const replayableResponseItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
				cloneJsonTree(nativeOutputItems),
				{
					supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
				},
			);
			if (replayableResponseItems) {
				if (providerSessionState && providerSessionState.closeCount === closeCountAtStart) {
					providerSessionState.nativeHistoryReplayWarmed = true;
				}
				if (chainState) {
					chainState.lastParams = cloneJsonTree(
						activeTrailingScaffoldingItems > 0 && Array.isArray(activeParams.input)
							? {
									...activeParams,
									input: activeParams.input.slice(
										0,
										activeParams.input.length - activeTrailingScaffoldingItems,
									),
								}
							: activeParams,
					);
					chainState.lastPromptCacheBreakpointPolicy = promptCacheBreakpointPolicy;
					if (output.responseId && replayableResponseItems.length === nativeOutputItems.length) {
						chainState.lastResponseId = output.responseId;
						chainState.lastResponseItems = replayableResponseItems;
						chainState.canAppend = true;
						// Only a successful CHAINED completion clears the stale counter — a
						// full-context success must not mask categorical rejection.
						if (sentPreviousResponseId) chainState.staleFailures = 0;
					} else {
						// No response id, or replay sanitization dropped an item the server
						// still holds. Sanitization is 1:1-or-fewer, so either case makes the
						// append baseline untrustworthy; next turn must replay in full.
						chainState.canAppend = false;
						chainState.lastResponseId = undefined;
						chainState.lastResponseItems = undefined;
					}
				}
			} else if (chainState) {
				// Hidden-empty / fully sanitized successes cannot be used as an append
				// baseline, but `lastParams` still records the successful wire controls
				// without re-enabling `previous_response_id` chaining.
				chainState.canAppend = false;
				chainState.lastParams = cloneJsonTree(
					activeTrailingScaffoldingItems > 0 && Array.isArray(activeParams.input)
						? {
								...activeParams,
								input: activeParams.input.slice(0, activeParams.input.length - activeTrailingScaffoldingItems),
							}
						: activeParams,
				);
				chainState.lastPromptCacheBreakpointPolicy = promptCacheBreakpointPolicy;
				chainState.lastResponseId = undefined;
				chainState.lastResponseItems = undefined;
			}
		} catch (error) {
			if (chainState) resetOpenAIResponsesChainState(chainState);
			const failure = abortTracker.getLocalAbortReason() ?? error;
			if (
				attemptContext.mode === "websocket" &&
				!abortTracker.wasCallerAbort() &&
				isPostSendTransportFailure(failure)
			) {
				webSocketLease?.markSseOnly();
			}
			webSocketLease?.session.close();
			const classifiedError =
				attemptContext.mode === "websocket" &&
				failure instanceof ResponsesWebSocketTransportError &&
				(failure.reason === "closed" ||
					failure.reason === "socket-error" ||
					failure.reason === "send" ||
					failure.reason === "unavailable")
					? new AIError.ProviderResponseError(
							"OpenAI responses stream closed before a terminal response event was received",
							{ provider: model.provider, kind: "incomplete-stream", cause: failure },
						)
					: failure;
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(classifiedError, {
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
			if (AIError.isRequestBodyReadTimeout(result.status, result.message) && lastSubmittedRequestWasFullReplay) {
				output.requestBodyReadTimeoutFullReplay = true;
			}
			// Some providers via OpenRouter include extra details here.
			const rawMetadata = readOpenRouterRawMetadata(capturedErrorResponse);
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
		} finally {
			webSocketLease?.release();
		}
		output.duration = performance.now() - startTime;
		if (firstTokenTime) output.ttft = firstTokenTime - startTime;
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} else {
			stream.push({ type: "done", reason: output.stopReason, message: output });
		}
		stream.end();
	})();

	return stream;
};

/**
 * Public entry: retry benign empty completions before they reach the agent
 * loop. Transient stream failures are retried inside the attempt so stateful
 * Responses request metadata remains stable.
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (model, context, options) => {
	const attemptContext: ResponsesAttemptContext = { mode: undefined, dropEncryptedReasoning: false };
	return withReplaySafeStreamRetry(
		model,
		context,
		options,
		(attemptModel, attemptContextMessages, attemptOptions) =>
			streamOpenAIResponsesOnce(attemptModel, attemptContextMessages, attemptOptions, attemptContext),
		{ retryEmptyCompletion: () => attemptContext.mode === "sse" },
	);
};

function isResponsesPromptCacheableContentBlock(block: unknown): block is ResponseInputContent {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	return block.type === "input_text" || block.type === "input_image" || block.type === "input_file";
}

type ResponsesPromptCacheableMessage = {
	role: "assistant" | "developer" | "system" | "user";
	content: ResponseInputContent[];
};

function isResponsesPromptCacheableMessage(item: unknown): item is ResponsesPromptCacheableMessage {
	if (typeof item !== "object" || item === null || !("role" in item) || !("content" in item)) return false;
	if (item.role !== "assistant" && item.role !== "developer" && item.role !== "system" && item.role !== "user")
		return false;
	return Array.isArray(item.content) && item.content.every(isResponsesPromptCacheableContentBlock);
}

type ResponsesStringInstruction = {
	role: "developer" | "system";
	content: string;
};

function isStableStringResponsesInstruction(item: unknown): item is ResponsesStringInstruction {
	if (typeof item !== "object" || item === null || !("role" in item) || !("content" in item)) return false;
	return (
		(item.role === "developer" || item.role === "system") &&
		typeof item.content === "string" &&
		item.content.length > 0
	);
}

function matchesResponsesCacheBaseline(
	baseline: ResponsesPromptCacheableMessage,
	current: ResponsesPromptCacheableMessage,
): boolean {
	if (baseline.role !== current.role || baseline.content.length !== current.content.length) return false;
	for (let index = 0; index < baseline.content.length; index++) {
		const baselineBlock = baseline.content[index];
		const currentBlock = current.content[index];
		if (!baselineBlock || !currentBlock) return false;
		const breakpoint = baselineBlock.prompt_cache_breakpoint;
		if (breakpoint) {
			if (!Bun.deepEquals(baselineBlock, { ...currentBlock, prompt_cache_breakpoint: breakpoint })) return false;
		} else if (!Bun.deepEquals(baselineBlock, currentBlock)) {
			return false;
		}
	}
	return true;
}

function restoreResponsesCacheBreakpointsFromBaseline(
	input: ResponseInput | undefined,
	baseline: ResponseInput | undefined,
): boolean {
	if (!input || !baseline) return false;
	let restored = false;
	for (let i = 0; i < baseline.length && i < input.length; i++) {
		const baselineMessage = baseline[i];
		const message = input[i];
		if (!isResponsesPromptCacheableMessage(baselineMessage)) continue;

		if (isStableStringResponsesInstruction(message)) {
			const [baselineBlock] = baselineMessage.content;
			if (
				baselineMessage.role === message.role &&
				baselineBlock?.type === "input_text" &&
				baselineBlock.text === message.content &&
				baselineBlock.prompt_cache_breakpoint
			) {
				Object.assign(message, {
					content: [
						{
							type: "input_text",
							text: message.content,
							prompt_cache_breakpoint: baselineBlock.prompt_cache_breakpoint,
						},
					],
				});
				restored = true;
			}
			continue;
		}

		if (!isResponsesPromptCacheableMessage(message) || !matchesResponsesCacheBaseline(baselineMessage, message))
			continue;
		for (let j = 0; j < baselineMessage.content.length; j++) {
			const baselineBlock = baselineMessage.content[j];
			const block = message.content[j];
			if (!baselineBlock?.prompt_cache_breakpoint || !block) continue;
			Object.assign(block, { prompt_cache_breakpoint: baselineBlock.prompt_cache_breakpoint });
			restored = true;
		}
	}
	return restored;
}

function hasResponsesCacheBreakpoint(input: ResponseInput | undefined): boolean {
	return (
		input?.some(
			message =>
				isResponsesPromptCacheableMessage(message) &&
				message.content.some(block => block.prompt_cache_breakpoint !== undefined),
		) ?? false
	);
}

function markLatestStableResponsesCacheBreakpoint(
	input: ResponseInput | undefined,
	statefulBaseline?: ResponseInput,
): boolean {
	if (!input) return false;
	// Stateful appends use a strict wire-prefix comparison. Retain the exact
	// marker from that prefix rather than recomputing a newer boundary.
	if (statefulBaseline) {
		if (restoreResponsesCacheBreakpointsFromBaseline(input, statefulBaseline)) return true;
		// A prior marker whose content no longer matches means chaining will
		// reset to a full replay. Recompute a fresh boundary for that replay.
		// Markerless baselines stay markerless so appends do not mutate them.
		if (!hasResponsesCacheBreakpoint(statefulBaseline)) return false;
	}

	let latestInputMessage = -1;
	for (let i = input.length - 1; i >= 0; i--) {
		const message = input[i];
		if (!("role" in message)) continue;
		if (message.role === "user" || message.role === "developer") {
			latestInputMessage = i;
			break;
		}
	}
	if (latestInputMessage <= 0) return false;

	for (let i = latestInputMessage - 1; i >= 0; i--) {
		const message = input[i];
		if (isStableStringResponsesInstruction(message)) {
			const text = message.content;
			Object.assign(message, {
				content: [
					{
						type: "input_text",
						text,
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			});
			return true;
		}
		if (!isResponsesPromptCacheableMessage(message)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!isResponsesPromptCacheableContentBlock(block)) continue;
			Object.assign(block, { prompt_cache_breakpoint: { mode: "explicit" } });
			return true;
		}
	}
	return false;
}

function applyOpenAIResponsesPromptCachePolicy(
	params: OpenAIResponsesSamplingParams,
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
	statefulCacheBaseline?: ResponseInput,
): void {
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	if (cacheRetention === "none") return;
	const promptCache = options?.promptCache;
	if (!model.compat.supportsPromptCacheBreakpoints) {
		if (promptCache?.mode === "explicit") {
			throw new AIError.ConfigurationError(
				`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
			);
		}
		return;
	}

	// GPT-5.6+ replaces `prompt_cache_retention` with `prompt_cache_options.ttl`;
	// long retention selects the 12h minimum lifetime even without an explicit policy.
	const ttl = promptCache?.ttl ?? (cacheRetention === "long" ? "12h" : undefined);
	if (!promptCache && ttl === undefined) return;
	params.prompt_cache_options = {
		mode: promptCache?.mode ?? "implicit",
		ttl: ttl ?? model.compat.promptCacheBreakpointTtl,
	};
	if (promptCache?.mode === "explicit" && promptCache.breakpoint !== "none")
		markLatestStableResponsesCacheBreakpoint(params.input, statefulCacheBaseline);
}

export function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	strictToolsScope?: OpenAIStrictToolsScope,
	disableStrictToolsOverride = false,
	statefulCacheBaseline?: ResponseInput,
	dropEncryptedReasoning = false,
): {
	params: OpenAIResponsesSamplingParams;
	trailingScaffoldingItems: number;
	strictToolsApplied: boolean;
	toolNamesByWire: ReadonlyMap<string, string> | undefined;
} {
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
	// Filtering native reasoning must not be undone by reconstruction when the
	// target also rejects synthetic items (Muse on OpenRouter). Unfiltered targets
	// retain required text/placeholder replay, including DeepSeek's #10690 fallback.
	const canReconstructReasoningReplay =
		!policy.reasoning.filterReasoningHistory || policy.reasoning.allowsSyntheticReasoningContentForToolCalls;
	const toolNaming = responsesToolNaming(model);
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
		requiresReasoningReplayForAllTurns:
			policy.reasoning.enabled &&
			policy.reasoning.requiresReasoningContentForAllAssistantTurns &&
			canReconstructReasoningReplay,
		requiresReasoningReplayForToolCalls:
			policy.reasoning.enabled &&
			policy.reasoning.requiresReasoningContentForToolCalls &&
			canReconstructReasoningReplay,
		repairOrphanOutputs: true,
		toolNaming,
		dropEncryptedReasoning,
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
	const promptCacheKey = getOpenAIPromptCacheKey(options);
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
		// GPT-5.6+ ignores the legacy retention field; its lifetime rides `prompt_cache_options.ttl`.
		prompt_cache_retention:
			promptCacheKey &&
			cacheRetention === "long" &&
			model.compat.supportsLongPromptCacheRetention &&
			!model.compat.supportsPromptCacheBreakpoints
				? "24h"
				: undefined,
		// Gateway routing: OpenRouter-only Responses wire field for sticky upstream
		// routing + observability grouping; no equivalent on direct OpenAI.
		session_id: model.compat.isOpenRouterHost ? getOpenRouterResponsesSessionId(options) : undefined,
		store: storesResponsesServerSide(model, options),
		stream_options: model.compat.supportsObfuscationOptOut ? { include_obfuscation: false } : undefined,
	};
	if (options?.include?.length) params.include = Array.from(new Set(options.include));
	maybeAddOpenRouterAnthropicCacheControl(params, model, cacheRetention);
	const outputToken = resolveOpenAIOutputTokenParam({
		field: "max_output_tokens",
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		isOpenRouterHost: model.compat.isOpenRouterHost,
		alwaysSendMaxTokens: model.compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveOpenAIResponsesOutputClamp(model),
	});

	applyCommonResponsesSamplingParams(params, { ...options, maxTokens: outputToken?.value }, model);
	if (options?.textVerbosity && model.compat.officialEndpoint) {
		params.text = { ...params.text, verbosity: options.textVerbosity };
	}
	// TODO: openai responses has no top-level `stop`/`stop_sequences`; surface via reasoning.stop?
	// `StreamOptions.stopSequences` is intentionally dropped for this provider.
	// TODO: openai responses has no top-level `frequency_penalty` field as of the current SDK;
	// `StreamOptions.frequencyPenalty` is intentionally dropped for this provider.

	let strictToolsApplied = false;
	let wireToolNames: ReadonlyMap<string, string> | undefined;
	if (context.tools) {
		const disableStrictTools =
			disableStrictToolsOverride || isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
		const strictMode = !disableStrictTools && model.compat.supportsStrictMode !== false;
		const emittedTools: Tool[] = [];
		const tools = convertTools(context.tools, strictMode, model, undefined, emittedTools);
		params.tools = tools;
		strictToolsApplied = tools.some(t => (t as { strict?: boolean }).strict === true);
		if (toolNaming) {
			// Built from what was declared, so returned calls map back to their tool
			// and a quarantined tool cannot cause a false wire-name collision.
			wireToolNames = toolNamesByWire(
				emittedTools.filter((_, index) => tools[index]?.type === "function"),
				name => encodeResponsesToolName(name, toolNaming),
			);
		}
		if (options?.toolChoice) {
			// Map tool_choice against the tools that survived quarantine, not the
			// original list: a forced choice for a dropped tool — or "required" when
			// every tool was dropped — would otherwise send a tool_choice with no
			// matching tool, which the provider rejects just like the bad schema did (#2652).
			const toolChoice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, emittedTools, model);
			if (toolChoice !== undefined && params.tools.length > 0) {
				if (
					typeof toolChoice === "object" &&
					toolChoice.type === "function" &&
					!model.compat.supportsNamedToolChoice
				) {
					// String-only hosts cannot receive the named object. Restrict the
					// catalogue first so "required" still forces the requested tool.
					params.tools = params.tools.filter(tool => tool.type === "function" && tool.name === toolChoice.name);
					params.tool_choice = "required";
				} else {
					params.tool_choice = toolChoice;
				}
			}
		}
	}

	if (shouldDropAutoToolChoiceForReasoning(model, model.compat, params.tool_choice, options)) {
		delete params.tool_choice;
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
	applyResponsesCompatPolicy(params, reasoningPolicy, {
		reasoningSummary: resolveReasoningSummaryOption(model, options),
		forceReasoningOff: options?.forceReasoningOff,
		mapEffort: effort => mapResponsesEffort(model, effort as NonNullable<OpenAIResponsesOptions["reasoning"]>),
	});
	// Catalog pro aliases (`gpt-5.6-*-pro`): merge AFTER the compat policy so the
	// mode survives every policy branch (disabled/omitted effort included) while
	// keeping whatever effort/summary the policy produced — mode and effort are
	// independent wire fields.
	if (model.reasoningMode && !options?.forceReasoningOff) {
		params.reasoning = { ...params.reasoning, mode: model.reasoningMode };
	}
	applyResponsesStableEffort(model, params, messages, options, providerSessionState);

	if (model.compat.isVercelGatewayHost) {
		applyVercelResponsesCacheControls(params, model.compat, cacheRetention);
	} else {
		applyOpenAIGatewayRouting(params, model.compat);
	}

	applyOpenAIExtraBody(params, options?.extraBody);
	applyOpenAIResponsesPromptCachePolicy(params, model, options, statefulCacheBaseline);

	let trailingScaffoldingItems = 0;
	if (options?.forceReasoningOff && model.compat.requiresReasoningOffJuiceInstruction) {
		const effort = options.reasoning ?? "medium";
		const juice = getJuiceValue(effort);
		messages.push({
			role: "developer",
			content: [{ type: "input_text", text: `# Juice: ${juice} !important` }],
		});
		trailingScaffoldingItems = 1;
	}

	return { params, trailingScaffoldingItems, strictToolsApplied, toolNamesByWire: wireToolNames };
}

/**
 * Keep the request-level effort byte-stable across a conversation and carry
 * later changes as `configuration_update` items (GPT-6 family, standard
 * reasoning mode). Requires a routing session id and provider session state to
 * remember the baseline; without them every request stands alone and sends its
 * own effort.
 */
function applyResponsesStableEffort(
	model: Model<"openai-responses">,
	params: OpenAIResponsesSamplingParams,
	input: ResponseInput,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): void {
	if (!model.compat.supportsConfigurationUpdate || model.reasoningMode === "pro" || !providerSessionState) return;
	const reasoning = params.reasoning;
	if (!reasoning || !("effort" in reasoning)) return;
	const effort = reasoning.effort;
	if (effort === undefined || effort === null || effort === "none") return;
	const sessionId = getOpenAIResponsesRoutingSessionId(options);
	if (!sessionId) return;
	const state = resolveOpenAIEffortControlState(
		providerSessionState.effortControls,
		id => `${model.baseUrl ?? ""}\u0000${model.id}\u0000${id}`,
		sessionId,
		normalizeOpenAIPromptCacheKey(options?.parentSessionId),
	);
	params.reasoning = {
		...reasoning,
		effort: planStableOpenAIEffort(state, input, effort, minimizedResponsesEffort(model, options)),
	};
}

/** The model's lowest effort on the wire when the caller asked to minimize it (`minimizeEffort`). */
function minimizedResponsesEffort(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
): ResponsesStableEffort | undefined {
	const lowest = options?.minimizeEffort ? model.thinking?.efforts[0] : undefined;
	if (lowest === undefined) return undefined;
	const wire = mapResponsesEffort(model, lowest);
	return isResponsesStableEffort(wire) ? wire : undefined;
}

/**
 * Whether this model should get the OpenAI custom-tool grammar variant
 * for `apply_patch`. The generated model catalog sets
 * `model.applyPatchToolType` for first-party GPT-5 Responses models; this
 * runtime path only consumes that metadata.
 * @internal Exported for tests.
 */
export function supportsFreeformApplyPatch(
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
): boolean {
	return model.applyPatchToolType === "freeform";
}

/**
 * Tool-name rule for the model's host (`compat.toolNamePrefix` plus the catalog
 * name-length limit), or undefined when the host takes names unchanged.
 */
function responsesToolNaming(
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
): ResponsesToolNaming | undefined {
	const prefix = model.compat.toolNamePrefix;
	if (!prefix) return undefined;
	const maxLength = resolveCatalogPolicy(model).toolCallNameMaxLength;
	return { prefix, maxLength: typeof maxLength === "number" ? maxLength : undefined };
}

/** @internal Exported for tests. */
export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	if (!model.compat.supportsToolChoice) return undefined;
	const naming = responsesToolNaming(model);
	if (isForcedToolChoice(choice) && !model.compat.supportsForcedToolChoice) {
		return "auto";
	}
	if (typeof choice !== "string" && choice?.type === "computer") {
		const computer = tools.find(tool => tool.native?.type === "computer");
		if (!computer) return undefined;
		return model.supportsComputerUse === true
			? { type: "computer" }
			: { type: "function", name: encodeResponsesToolName(computer.name, naming) };
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
	if (offeredTool?.native?.type === "computer") {
		return model.supportsComputerUse === true
			? { type: "computer" }
			: { type: "function", name: encodeResponsesToolName(offeredTool.name, naming) };
	}
	if (!offeredTool) {
		return undefined;
	}
	return customTool
		? { type: "custom", name: customTool.customWireName ?? customTool.name }
		: { ...mapped, name: encodeResponsesToolName(mapped.name, naming) };
}

/** @internal Exported for tests. */
export function convertTools(
	tools: Tool[],
	strictMode: boolean,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	onQuarantine: (toolName: string, schemaPath: string) => void = (toolName, schemaPath) =>
		logger.warn(
			`Tool "${toolName}" omitted from the openai-responses request: its parameter schema is invalid for this provider at ${schemaPath} (an enum/const value cannot match its declared type). Other tools are unaffected.`,
		),
	/** Filled with the source tool of each returned entry, index-aligned with the result. */
	emittedTools?: Tool[],
): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	const rejectRootObjectUnion = model.compat.rejectRootObjectUnion;
	const toolNaming = responsesToolNaming(model);
	const out: OpenAITool[] = [];
	for (const tool of tools) {
		if (tool.native?.type === "computer" && model.supportsComputerUse === true) {
			emittedTools?.push(tool);
			out.push({ type: "computer" });
			continue;
		}
		// Models without native computer support fall through and receive the
		// tool as a plain function tool (name/description/schema below), so
		// function-calling models can still drive the desktop.
		if (allowFreeform && tool.customFormat) {
			emittedTools?.push(tool);
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
		// MFJS must run AFTER the Responses sanitizer: the sanitizer normalizes
		// `{}` → `true` (issue #1179), and Moonshot's validator rejects boolean
		// subschemas ("property schema … must be an object"), so the Moonshot
		// pass re-coerces them last.
		const sanitized = sanitizeSchemaForOpenAIResponses(baseParameters);
		const providerParameters = rejectRootObjectUnion ? flattenExclusiveRequiredRootUnion(sanitized) : sanitized;
		const responseParameters =
			model.compat.toolSchemaFlavor === "moonshot-mfjs"
				? (normalizeSchemaForMoonshot(providerParameters) as Record<string, unknown>)
				: providerParameters;
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		// Quarantine a tool whose emitted schema carries a provider-rejecting
		// enum/const-vs-type contradiction: dropping just that tool keeps the rest
		// of the request valid instead of letting one bad MCP schema 400 the whole
		// turn (#2652). Other tools and built-ins are unaffected. Leftover
		// object-root unions are rejected only when declared by compatibility policy.
		const violation = findStrictToolSchemaViolation(parameters, "#", { rejectRootObjectUnion });
		if (violation) {
			onQuarantine(tool.name, violation);
			continue;
		}
		emittedTools?.push(tool);
		out.push({
			type: "function",
			name: encodeResponsesToolName(tool.name, toolNaming),
			description: tool.description || "",
			parameters,
			// `strict: false` and an omitted `strict` are NOT equivalent for every
			// OpenAI-compat backend — some over-fill optional args when the flag is
			// absent (#4336). Preserve the author's explicit `false` unless the
			// provider is explicitly known not to understand the field
			// (`supportsStrictMode: false`) or the strict-schema fallback is
			// active — both paths rely on a uniformly absent wire flag. Mirrors the
			// `supportsStrictMode !== false` gate used by openai-completions
			// (#4527).
			...(effectiveStrict
				? { strict: true }
				: !NO_STRICT && strictMode && tool.strict === false
					? { strict: false }
					: {}),
		} as OpenAITool);
	}
	return out;
}
