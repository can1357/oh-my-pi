import * as os from "node:os";
import { scheduler } from "node:timers/promises";
import { calculateCost } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@pk-nerdsaver-ai/pi-catalog/wire/codex";
import {
	$env,
	$flag,
	asRecord,
	fetchWithRetry,
	logger,
	parseStreamingJson,
	readSseJson,
	structuredCloneJSON,
} from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import packageJson from "../../package.json" with { type: "json" };
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
} from "../utils";
import { clearStreamingPartialJson, kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexReasoningContext,
	type CodexRequestOptions,
	type InputItem,
	type RequestBody,
	shouldUseCodexResponsesLite,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { CodexApiError } from "./openai-codex/response-handler";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
} from "./openai-responses-wire";
import {
	accumulateCustomToolCallInputDelta,
	accumulateToolCallArgumentsDelta,
	appendMessageContentPart,
	appendMessageTextDelta,
	appendReasoningSummaryPart,
	appendReasoningSummaryPartDone,
	appendReasoningSummaryTextDelta,
	appendResponsesToolResultMessages,
	applyOpenAIServiceTier,
	buildResponsesDeltaInput,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	finalizeCustomToolCallInputDone,
	finalizePendingResponsesToolCalls,
	finalizeToolCallArgumentsDone,
	isOpenAIResponsesProgressEvent,
	mapOpenAIResponsesStopReason,
	normalizeOpenAIResponsesPromptCacheKey,
	populateResponsesUsageFromResponse,
	promoteResponsesToolUseStopReason,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	/** `reasoning.context` replay scope; defaults to `all_turns` for every Codex request when unset. */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
	/**
	 * Opt into the Responses Lite transport contract. Sends
	 * `x-openai-internal-codex-responses-lite: true` on HTTP requests and on the
	 * WebSocket upgrade (the marker is connection-scoped there, so lite and
	 * non-lite turns never share a pooled socket), strips image detail from
	 * input, and disables parallel tool calling — mirroring codex-rs.
	 */
	responsesLite?: boolean;
	/**
	 * Extra `client_metadata` to include in the request body on both transports.
	 * The canonical Codex envelope is `client_metadata["x-codex-turn-metadata"]`
	 * (JSON string of thread/turn identifiers); flat keys are also accepted.
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Invoked when the server streams a `response.metadata` event carrying
	 * ChatGPT moderation metadata (`metadata.openai_chatgpt_moderation_metadata`)
	 * for first-party presentation parity. Diagnostic observer: failures are
	 * swallowed and must not alter the stream.
	 */
	onModerationMetadata?: (metadata: unknown) => void;
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_PING_INTERVAL_MS = Number($env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS || 10_000);
const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS || 60_000);
const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = Number($env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY || 4096);
/**
 * Maximum quiet period (no inbound frames AND no observed pong) we'll trust a
 * reused WebSocket for before forcing a fresh handshake. Codex backends and
 * intermediaries occasionally evict idle sockets server-side without sending a
 * FIN, leaving the local `readyState` as OPEN while the next `send()` becomes a
 * write into a half-open buffer. Reusing such a socket parks the next request
 * at `#nextMessage` until the first-event/idle timeout fires (issue #1450). The
 * heartbeat below also catches dead sockets, but only after `pongTimeoutMs`
 * (default 60s) and only while a request is active — this gate closes the door
 * earlier and even when the gap between requests is purely client-side (tool
 * execution, user typing, etc.). Set `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS=0`
 * to disable.
 */
const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = Number($env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS || 30_000);
/**
 * Steady-state liveness ceiling for the Codex WebSocket transport. Distinct from
 * the OMP-wide stream watchdog removed in #1392: a WebSocket can stay TCP-open
 * indefinitely without exchanging frames (server crash after upgrade, half-open
 * network path), so we still need a transport-internal cap to detect those
 * states and trigger the WS→SSE fallback. Only applies AFTER the first event
 * has arrived — slow first-token paths wait as long as the caller permits.
 */
const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS || 300_000);
/**
 * Maximum wait for the first WebSocket event before falling back to SSE.
 * Unlike a stream watchdog, this triggers a transport switch (not a request
 * failure) — the outer retry loop catches the timeout error and re-runs on
 * SSE. Generous default so legitimately slow first-token providers still get
 * a chance on the WS transport before falling through.
 */
const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS || 60_000);
const CODEX_WEBSOCKET_RETRY_BUDGET = Number($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET || CODEX_MAX_RETRIES);
const CODEX_WEBSOCKET_RETRY_DELAY_MS = Number($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS || CODEX_RETRY_DELAY_MS);
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;
const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";
const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
const X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
/** WebSocket frames cannot carry per-request HTTP headers; codex-rs mirrors the lite marker into `client_metadata` under this key. */
const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
/** `response.metadata` payload key carrying ChatGPT moderation metadata. */
const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";
/** Connection-level websocket failures that should immediately fall back to SSE without retrying. */
const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES = new Set(["response.done", "response.incomplete"]);
// Provider/model failure mode: Codex can keep a response alive by streaming
// whitespace-only function-call argument deltas forever. Those frames count as
// transport activity, so idle timers never fire; cap the run before raw debug
// buffers and partial JSON grow without semantic progress.
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

function isCodexStreamProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES.has(type);
}

function extractCodexFrameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = (frame as { response?: { id?: unknown } }).response;
	const id = response?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractCodexFrameSequenceNumber(frame: Record<string, unknown>): number | undefined {
	const raw = (frame as { sequence_number?: unknown }).sequence_number;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
}

type CodexWebSocketTimeoutDetails = {
	lastEventAt: number;
	lastEventType?: string;
	lastProgressAt: number;
	lastProgressEventType?: string;
};

function createCodexWebSocketTimeoutMessage(reason: string, details: CodexWebSocketTimeoutDetails): string {
	const now = Date.now();
	const lastEvent = details.lastEventType
		? `${details.lastEventType} ${Math.max(0, now - details.lastEventAt)}ms ago`
		: "none";
	const lastProgress = details.lastProgressEventType
		? `${details.lastProgressEventType} ${Math.max(0, now - details.lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

type CodexTransport = "sse" | "websocket";
type CodexEventItem = ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
type CodexOutputBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number });

/**
 * Per-session request-shape counters. Despite the name, these cover both
 * transports: once stateful SSE chaining is enabled, SSE requests are counted
 * too (the shared chained-request builder records every request it shapes).
 */
export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
}

/**
 * Per-session transport state shared by BOTH transports: websocket turn
 * chaining (`previous_response_id` baseline), turn-state/models-etag headers,
 * websocket connection pooling, and debug stats. The name is historical — SSE-only
 * sessions use it too.
 */
type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	turnState?: string;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
}

interface CodexRequestContext {
	apiKey: string;
	accountId: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	responsesLite: boolean;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
}

interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
	firstEventTimeoutMs: number | undefined;
	websocketIdleTimeoutMs: number | undefined;
	websocketFirstEventTimeoutMs: number | undefined;
}

interface CodexOpenItem {
	item: CodexEventItem;
	block: CodexOutputBlock | null;
	/** Index of {@link block} in `output.content`; `-1` when no block was created for this item. */
	contentIndex: number;
	itemId?: string;
	outputIndex?: number;
}

class CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	/**
	 * Items open on the wire keyed by `item.id`. `response.output_item.added`
	 * registers here; `output_item.done` removes. A keyed event whose `item_id`
	 * is not present is dropped rather than appended to a sibling.
	 */
	openItems = new Map<string, CodexOpenItem>();
	/**
	 * Items open on the wire keyed by `output_index` for streams whose function
	 * call items omit `id`; these still carry `output_index` on deltas/done.
	 */
	openItemsByOutputIndex = new Map<number, CodexOpenItem>();
	/**
	 * Most recently added open item for events that omit both `item_id` and
	 * `output_index`. Always tracks the latest `output_item.added`, including
	 * fully keyless items that never make it into the keyed maps; cleared when
	 * its item closes.
	 */
	currentEntry: CodexOpenItem | null = null;
	/** Convenience mirrors of {@link currentEntry} for legacy singleton handlers. */
	currentItem: CodexEventItem | null = null;
	currentBlock: CodexOutputBlock | null = null;
	nativeOutputItems: Array<Record<string, unknown>> = [];
	websocketStreamRetries = 0;
	providerRetryAttempt = 0;
	sawTerminalEvent = false;
	canSafelyReplayWebsocketOverSse = true;
	whitespaceToolCallArgumentsDelta?: CodexWhitespaceToolCallArgumentsDeltaState;
	whitespaceLoopRetries = 0;

	constructor(initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
		websocketState?: CodexWebSocketSessionState;
	}) {
		this.eventStream = initial.eventStream;
		this.requestBodyForState = initial.requestBodyForState;
		this.transport = initial.transport;
		this.websocketState = initial.websocketState;
	}

	/**
	 * Wipe per-attempt accumulator state before a recovery path replays the turn.
	 * Keeps {@link openItems} and the legacy singleton-current pointers in lockstep
	 * with {@link nativeOutputItems} so a stale delta from the failed attempt can't
	 * bind to a sibling on the retry.
	 */
	resetAccumulators(): void {
		this.openItems.clear();
		this.openItemsByOutputIndex.clear();
		this.currentEntry = null;
		this.currentItem = null;
		this.currentBlock = null;
		this.nativeOutputItems.length = 0;
	}

	/**
	 * Look up the open item a Codex stream event targets. `item_id` wins because it
	 * uniquely identifies a response item; `output_index` covers idless function
	 * call items. A keyed event whose target is already closed is dropped instead
	 * of being routed to a sibling. Only streams that omit both keys fall back to
	 * {@link currentEntry} — the most recently added item, including fully keyless
	 * ones that never reached the keyed maps.
	 */
	openItemForEvent(rawEvent: Record<string, unknown>): CodexOpenItem | null {
		const itemId = typeof rawEvent.item_id === "string" ? rawEvent.item_id : "";
		if (itemId) return this.openItems.get(itemId) ?? null;
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		if (outputIndex !== undefined) return this.openItemsByOutputIndex.get(outputIndex) ?? null;
		return this.currentEntry;
	}

	closeOpenItem(entry: CodexOpenItem | null | undefined): void {
		if (!entry) return;
		if (entry.itemId) this.openItems.delete(entry.itemId);
		if (entry.outputIndex !== undefined) this.openItemsByOutputIndex.delete(entry.outputIndex);
		if (this.currentEntry === entry) {
			this.currentEntry = null;
			this.currentItem = null;
			this.currentBlock = null;
		}
	}

	observeWhitespaceToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		delta: string,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		if (!isJsonWhitespaceOnly(delta)) {
			this.whitespaceToolCallArgumentsDelta = undefined;
			return undefined;
		}

		const itemId =
			typeof rawEvent.item_id === "string" && rawEvent.item_id.length > 0
				? rawEvent.item_id
				: (this.currentItem?.id ?? "");
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		const sequenceNumber =
			typeof rawEvent.sequence_number === "number" && Number.isFinite(rawEvent.sequence_number)
				? Math.trunc(rawEvent.sequence_number)
				: undefined;
		let state = this.whitespaceToolCallArgumentsDelta;
		if (!state || state.itemId !== itemId || state.outputIndex !== outputIndex) {
			state = {
				itemId,
				outputIndex,
				consecutiveEvents: 0,
				consecutiveChars: 0,
				firstSequenceNumber: sequenceNumber,
			};
			this.whitespaceToolCallArgumentsDelta = state;
		}

		state.consecutiveEvents += 1;
		state.consecutiveChars += delta.length;
		state.lastSequenceNumber = sequenceNumber;
		if (
			state.consecutiveEvents < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT &&
			state.consecutiveChars < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT
		) {
			return undefined;
		}

		const itemLabel = itemId ? ` for item ${itemId}` : "";
		const sequenceLabel =
			state.firstSequenceNumber === undefined || state.lastSequenceNumber === undefined
				? ""
				: `, sequence ${state.firstSequenceNumber}..${state.lastSequenceNumber}`;
		return {
			message: `Interrupted OpenAI Codex response after ${state.consecutiveEvents} consecutive whitespace-only tool-call argument delta events (${state.consecutiveChars} chars${sequenceLabel})${itemLabel}.`,
		};
	}

	handleToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		// Observe BEFORE the item/block guard: degenerate whitespace frames can keep
		// arriving after the item closed (entry detached) and still count as
		// progress for the idle watchdogs — dropping them unobserved would reopen
		// the infinite-loop hole the breaker exists for.
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		// Route to the entry the event keys to; a delta whose item already closed
		// is dropped instead of leaking into a sibling tool call (#2619).
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "function_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateToolCallArgumentsDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleToolCallArgumentsDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "function_call" || entry.block?.type !== "toolCall") return;
		const args = (rawEvent as { arguments?: string }).arguments;
		if (typeof args === "string") finalizeToolCallArgumentsDone(entry.block, args);
	}

	handleCustomToolCallInputDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		// Observe BEFORE the item/block guard — see handleToolCallArgumentsDelta.
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateCustomToolCallInputDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleCustomToolCallInputDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return;
		const input = (rawEvent as { input?: string }).input;
		if (typeof input === "string") finalizeCustomToolCallInputDone(entry.block, input);
	}

	handleResponseCreated(rawEvent: Record<string, unknown>): void {
		const response = (rawEvent as { response?: { id?: string } }).response;
		const state = this.websocketState;
		if (state && this.transport === "websocket" && typeof response?.id === "string" && response.id.length > 0) {
			state.lastResponseId = response.id;
		}
	}
}

interface CodexWhitespaceToolCallArgumentsDeltaState {
	itemId: string;
	outputIndex?: number;
	consecutiveEvents: number;
	consecutiveChars: number;
	firstSequenceNumber?: number;
	lastSequenceNumber?: number;
}

interface CodexWhitespaceToolCallArgumentsDeltaInterruption {
	message: string;
}

interface CodexStreamFailureContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	options: OpenAICodexResponsesOptions | undefined;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
}

function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
		},
	};
	return state;
}

function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY) as CodexProviderSessionState | undefined;
	if (existing) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof CodexWebSocketTransportError)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("websocket send failed") ||
		message.includes("websocket ping failed") ||
		message.includes("websocket pong timeout") ||
		message.includes("websocket message queue exceeded") ||
		message.includes("websocket request already in progress") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}
function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (!state || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}

function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

// Synthesizes a `RawSseEvent` for a Codex WebSocket frame so the same debug
// pipeline used for HTTP SSE (`onSseEvent` → `RawSseDebugBuffer.recordEvent`)
// also captures WebSocket traffic. The `raw` array mirrors SSE wire format
// (one line per field) so the existing TUI viewer renders it identically:
//   : ws ← <type>
//   event: <type>
//   data: <json>
// Outbound (client → server) uses `: ws → <type>`. The viewer pretty-prints
// `data:` JSON lines, so we keep the wire JSON single-line here and let the
// renderer expand it.
function notifyCodexWebSocketInbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	parsed: Record<string, unknown>,
	text: string,
): void {
	const type = typeof parsed.type === "string" ? parsed.type : null;
	const raw: string[] = [`: ws ← ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: type, data: text, raw });
}

function notifyCodexWebSocketOutbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	request: Record<string, unknown>,
	payload: string,
): void {
	const type = typeof request.type === "string" ? request.type : null;
	const raw: string[] = [`: ws → ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

function notifyCodexWebSocketMalformed(
	observer: ((event: RawSseEvent) => void) | undefined,
	data: unknown,
	error: unknown,
): void {
	const text = typeof data === "string" ? data : "";
	const reason = error instanceof Error ? error.message : String(error);
	const raw: string[] = [`: ws ← (parse-error: ${reason})`];
	if (text) raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: "parse_error", data: text, raw });
}

/** @internal Exported for tests. */
export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? model.applyPatchToolType === "freeform" : false;
	const mapName = (name: string): Record<string, string> | undefined => {
		const directTool = tools.find(tool => tool.name === name);
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		const offeredTool = customTool ?? directTool;
		if (!offeredTool) return undefined;
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function resolveCodexCostServiceTier(res: unknown, req?: unknown): ServiceTier | "default" | undefined {
	switch (res) {
		case "flex":
			return "flex";
		case "priority":
			return "priority";
		default:
			if (req === "flex" || req === "priority") {
				return req;
			}
			return "default";
	}
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "id">,
	usage: AssistantMessage["usage"],
	resTier: unknown,
	reqTier: unknown,
): void {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier);
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resetOutputState(output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "stop";
	output.stopDetails = undefined;
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const websocketIdleTimeoutMs = options?.streamIdleTimeoutMs ?? CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const websocketFirstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isCodexStreamProgressEvent,
		});
	return {
		requestAbortController,
		requestSignal,
		wrapCodexSseStream,
		firstEventTimeoutMs,
		websocketIdleTimeoutMs,
		websocketFirstEventTimeoutMs,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	output: AssistantMessage,
): Promise<CodexRequestContext> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
	const transportSessionId = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);

	const requestHeaders = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: output.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = shouldUseCodexResponsesLite(transformedBody, options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (sessionKey && publicSessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const websocketState =
		sessionKey && providerSessionState ? getCodexWebSocketSessionState(sessionKey, providerSessionState) : undefined;
	if (websocketState && !isCodexWithinTurnContinuation(context)) {
		// codex-rs scopes `x-codex-turn-state` to a single user turn: tool-loop
		// follow-ups echo it, a new user turn starts without it.
		websocketState.turnState = undefined;
	}
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		websocketState,
		responsesLite,
		transformedBody,
		rawRequestDump,
	};
}

/** @internal Exported for tests. */
export async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
): Promise<RequestBody> {
	const params: RequestBody = {
		model: model.id,
		input: convertMessages(model, context),
		stream: true,
		prompt_cache_key: promptCacheKey,
	};

	// `maxTokens` is intentionally not forwarded: transformRequestBody strips
	// `max_output_tokens`/`max_completion_tokens` (the Codex backend rejects
	// caller-supplied output caps). Sampling controls (`temperature`, `top_p`,
	// `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`,
	// `frequency_penalty`, `stop`) are likewise refused with
	// `{"detail":"Unsupported parameter: temperature"}` etc., so we drop
	// everything from `StreamOptions` rather than forwarding any of them.
	// (#3117 — codex-rs sends none of these either.)
	applyOpenAIServiceTier(params, options?.serviceTier, model.provider);
	if (context.tools && context.tools.length > 0) {
		params.tools = convertOpenAICodexResponsesTools(context.tools, model);
		if (options?.toolChoice) {
			const toolChoice = normalizeCodexToolChoice(options.toolChoice, context.tools, model);
			if (toolChoice) {
				params.tool_choice = toolChoice;
			}
		}
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	if (options?.clientMetadata && Object.keys(options.clientMetadata).length > 0) {
		params.client_metadata = { ...options.clientMetadata };
	}
	const codexOptions: CodexRequestOptions = {
		reasoningEffort: options?.reasoning,
		reasoningSummary: options?.reasoningSummary === undefined ? "auto" : options.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	return transformRequestBody(params, model, codexOptions, { developerMessages });
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = CODEX_WEBSOCKET_RETRY_BUDGET;
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					model,
					options,
					requestContext,
					requestSetup,
					websocketState,
					websocketRetries,
					options ? event => options.onSseEvent?.(event, model) : undefined,
				);
			} catch (error) {
				if (!(error instanceof CodexWebSocketTransportError)) throw error;
				const fatalWebSocketMessage = error.message.toLowerCase();
				const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
					fatalWebSocketMessage.includes(pattern.toLowerCase()),
				);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback);
				CODEX_DEBUG &&
					logger.debug("[codex] codex websocket fallback", {
						error: error.message,
						retry: websocketRetries,
						retryBudget: websocketRetryBudget,
						activated: activateFallback,
						fatal: isFatal,
					});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	}
	return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
}
async function openCodexWebSocketTransport(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	websocketState: CodexWebSocketSessionState,
	retry: number,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);
	// WebSocket frames cannot carry per-request HTTP headers, so the Responses
	// Lite marker rides in `client_metadata` on every `response.create`.
	let websocketRequest = {
		type: "response.create",
		...chainedBody,
		...(requestContext.responsesLite
			? {
					client_metadata: {
						...(chainedBody.client_metadata ?? {}),
						[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
					},
				}
			: {}),
	};
	const replacementWebsocketRequest = await options?.onPayload?.(websocketRequest, model);
	if (replacementWebsocketRequest !== undefined) {
		websocketRequest = replacementWebsocketRequest as typeof websocketRequest;
	}
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.responsesLite,
	);
	const requestBodyForState = structuredCloneJSON(requestContext.transformedBody);
	requestContext.rawRequestDump.body = websocketRequest;
	CODEX_DEBUG &&
		logger.debug("[codex] codex websocket request", {
			url: toWebSocketUrl(requestContext.url),
			model: requestContext.transformedBody.model,
			reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
			headers: redactHeaders(websocketHeaders),
			sentTurnStateHeader: websocketHeaders.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: websocketHeaders.has(X_MODELS_ETAG_HEADER),
			requestType: websocketRequest.type,
			retry,
			retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
		});
	const websocketConnection = await getOrCreateCodexWebSocketConnection(
		websocketState,
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		requestSetup.requestSignal,
	);
	const eventStream = websocketConnection.streamRequest(
		websocketRequest,
		{
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		},
		requestSetup.requestSignal,
		onSseEvent,
	);
	return {
		eventStream,
		requestBodyForState,
		transport: "websocket",
	};
}

/**
 * True when the request continues the current turn (everything after the
 * last assistant message is tool results), false when a new user turn starts.
 * Mirrors codex-rs, which scopes `x-codex-turn-state` to a single turn and
 * clears it when the next one begins.
 */
function isCodexWithinTurnContinuation(context: Context): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const role = context.messages[i]?.role;
		if (role === "toolResult") continue;
		return role === "assistant";
	}
	return false;
}

async function openCodexSseTransport(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
	body = requestContext.transformedBody,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const open = async (wireBody: RequestBody) => {
		// Keep the 400 dump honest: record the body actually sent on the wire.
		requestContext.rawRequestDump.body = wireBody;
		return requestSetup.wrapCodexSseStream(
			await openCodexSseEventStream(
				requestContext.url,
				requestContext.requestHeaders,
				requestContext.accountId,
				requestContext.apiKey,
				requestContext.transportSessionId,
				wireBody,
				state,
				requestContext.responsesLite,
				requestSetup.requestSignal,
				requestSetup.firstEventTimeoutMs,
				event => options?.onSseEvent?.(event, model),
				options?.fetch,
			),
		);
	};
	let wireBody = body;
	const replacementWireBody = await options?.onPayload?.(wireBody, model);
	if (replacementWireBody !== undefined) {
		wireBody = replacementWireBody as RequestBody;
	}
	recordCodexWebSocketRequestStats(state, wireBody);
	return { eventStream: await open(wireBody), requestBodyForState: structuredCloneJSON(wireBody), transport: "sse" };
}

function isJsonWhitespaceOnly(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
			return false;
		}
	}
	return true;
}

function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "" };
	}
	if (item.type === "message") {
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		return { type: "text", text: "", textSignature: encodeTextSignatureV1(item.id, phase) };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			[kStreamingPartialJson]: item.arguments || "",
		};
	}
	if (item.type === "custom_tool_call") {
		// Wire name flows through unchanged; the agent-loop dispatcher also
		// matches `Tool.customWireName`. Reuse `partialJson` as the
		// accumulation buffer for the raw input string.
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			[kStreamingPartialJson]: item.input ?? "",
		};
	}
	return null;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

function isCodexStalePreviousResponseError(error: unknown): boolean {
	if (error instanceof CodexProviderStreamError) return error.code === "previous_response_not_found";
	if (!(error instanceof Error)) return false;
	if ((error as { code?: string }).code === "previous_response_not_found") return true;
	// "unsupported": the backend intermittently rejects the parameter outright
	// with `{"detail":"Unsupported parameter: previous_response_id"}` (no
	// `error.code`); treat it like a stale chain so the turn replays with full
	// context instead of surfacing the 400.
	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

async function handleCodexStreamFailure(context: CodexStreamFailureContext, error: unknown): Promise<AssistantMessage> {
	const { output } = context;
	if (context.requestContext.websocketState) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		context.requestContext.websocketState.turnState = undefined;
		context.requestContext.websocketState.modelsEtag = undefined;
	}
	const result = await AIError.finalize(error, {
		api: context.model.api,
		signal: context.options?.signal,
		rawRequestDump: context.requestContext.rawRequestDump,
	});
	output.stopReason = result.stopReason;
	output.errorStatus = result.status;
	output.errorId = result.id;
	output.errorMessage = result.message;
	output.duration = performance.now() - context.startTime;
	if (context.firstTokenTime) {
		output.ttft = context.firstTokenTime - context.startTime;
	}
	return output;
}

/**
 * Owns one `streamOpenAICodexResponses` call: the request scaffolding
 * (model/output/stream/options/request context) plus the per-attempt
 * {@link CodexStreamRuntime}. Drives the event loop in {@link process}, applies
 * the transport-fallback / retry recovery ladder, and emits the final message
 * in {@link finalize}. The runtime object is mutated in place across retries
 * (event stream and accumulators are swapped/reset), never reassigned.
 */
class CodexStreamProcessor {
	runtime: CodexStreamRuntime;
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	options: OpenAICodexResponsesOptions | undefined;
	requestSetup: CodexRequestSetup;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;

	constructor(init: {
		runtime: CodexStreamRuntime;
		model: Model<"openai-codex-responses">;
		output: AssistantMessage;
		stream: AssistantMessageEventStream;
		options: OpenAICodexResponsesOptions | undefined;
		requestSetup: CodexRequestSetup;
		requestContext: CodexRequestContext;
		startTime: number;
	}) {
		this.runtime = init.runtime;
		this.model = init.model;
		this.output = init.output;
		this.stream = init.stream;
		this.options = init.options;
		this.requestSetup = init.requestSetup;
		this.requestContext = init.requestContext;
		this.startTime = init.startTime;
	}

	async process(): Promise<CodexStreamCompletion> {
		const { output, stream } = this;
		stream.push({ type: "start", partial: output });

		while (true) {
			try {
				let firstTokenTime = this.firstTokenTime;
				for await (const rawEvent of this.runtime.eventStream) {
					firstTokenTime = this.#handleStreamEvent(rawEvent, firstTokenTime);
					if (this.runtime.sawTerminalEvent) break;
				}
				return { firstTokenTime };
			} catch (error) {
				const recovered = await this.#recoverStreamError(error);
				if (!recovered) {
					throw error;
				}
				stream.push({ type: "start", partial: output });
			}
		}
	}

	#handleStreamEvent(rawEvent: Record<string, unknown>, firstTokenTime: number | undefined): number | undefined {
		const { output, stream } = this;
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) return firstTokenTime;

		if (eventType === "response.output_item.added") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			if (!firstTokenTime) firstTokenTime = performance.now();
			const item = rawEvent.item as CodexEventItem;
			this.runtime.currentItem = item;
			this.runtime.currentBlock = createOutputBlockForItem(item);
			let contentIndex = -1;
			if (this.runtime.currentBlock) {
				output.content.push(this.runtime.currentBlock);
				contentIndex = output.content.length - 1;
			}
			// Track every open item by every stable key the wire gives us. `item.id`
			// is best; `output_index` preserves idless function/custom tool calls and
			// keeps their final args authoritative when only `output_item.done`
			// carries the full payload.
			const itemId = typeof (item as { id?: string }).id === "string" ? (item as { id: string }).id : undefined;
			const outputIndex =
				typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
					? Math.trunc(rawEvent.output_index)
					: undefined;
			const entry: CodexOpenItem = { item, block: this.runtime.currentBlock, contentIndex, itemId, outputIndex };
			this.runtime.currentEntry = entry;
			if (itemId) this.runtime.openItems.set(itemId, entry);
			if (outputIndex !== undefined) this.runtime.openItemsByOutputIndex.set(outputIndex, entry);
			if (!this.runtime.currentBlock) return firstTokenTime;
			stream.push({
				type: getOutputBlockStartEventType(this.runtime.currentBlock),
				contentIndex,
				partial: output,
			});
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.added") {
			if (this.runtime.currentItem?.type === "reasoning") {
				appendReasoningSummaryPart(
					this.runtime.currentItem,
					(rawEvent as { part: ResponseReasoningItem["summary"][number] }).part,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_text.delta") {
			if (this.runtime.currentItem?.type === "reasoning" && this.runtime.currentBlock?.type === "thinking") {
				appendReasoningSummaryTextDelta(
					this.runtime.currentItem,
					this.runtime.currentBlock,
					(rawEvent as { delta?: string }).delta || "",
					stream,
					output,
					output.content.length - 1,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.done") {
			if (this.runtime.currentItem?.type === "reasoning" && this.runtime.currentBlock?.type === "thinking") {
				appendReasoningSummaryPartDone(
					this.runtime.currentItem,
					this.runtime.currentBlock,
					stream,
					output,
					output.content.length - 1,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.content_part.added") {
			if (this.runtime.currentItem?.type === "message") {
				appendMessageContentPart(
					this.runtime.currentItem,
					(rawEvent as { part?: ResponseOutputMessage["content"][number] }).part,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
			if (this.runtime.currentItem?.type === "message" && this.runtime.currentBlock?.type === "text") {
				appendMessageTextDelta(
					this.runtime.currentItem,
					this.runtime.currentBlock,
					(rawEvent as { delta?: string }).delta || "",
					stream,
					output,
					output.content.length - 1,
					eventType === "response.refusal.delta" ? "refusal" : "output_text",
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.delta") {
			const interruption = this.runtime.handleToolCallArgumentsDelta(rawEvent, stream, output);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleToolCallArgumentsDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.delta") {
			const interruption = this.runtime.handleCustomToolCallInputDelta(rawEvent, stream, output);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleCustomToolCallInputDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.output_item.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.#handleOutputItemDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.created") {
			this.runtime.handleResponseCreated(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
			this.#handleResponseCompleted(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.metadata") {
			const moderation = asRecord(rawEvent.metadata)?.[CODEX_MODERATION_METADATA_KEY];
			if (moderation !== undefined) {
				try {
					this.options?.onModerationMetadata?.(moderation);
				} catch {
					// Diagnostic observer: failures must not disturb the stream.
				}
			}
			return firstTokenTime;
		}

		if (eventType === "error" || eventType === "response.failed") {
			throw createCodexProviderStreamError(rawEvent);
		}

		return firstTokenTime;
	}

	#handleOutputItemDone(rawEvent: Record<string, unknown>): void {
		const { runtime, output, stream } = this;
		const rawItem = rawEvent.item;
		if (!rawItem || typeof rawItem !== "object") return;
		const item = structuredCloneJSON(rawItem) as CodexEventItem;
		runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

		// Match the finalization to the OPEN ITEM that started this block, not the
		// singleton current — interleaved items can finish out of order, so the
		// most-recently-added block may belong to a sibling (#2619). Some Codex
		// function/custom tool items omit `id`; in that case `output_index` still
		// routes `output_item.done` to the block that received `output_item.added`.
		const itemId = typeof (item as { id?: string }).id === "string" ? (item as { id: string }).id : "";
		const entry = (itemId ? runtime.openItems.get(itemId) : null) ?? runtime.openItemForEvent(rawEvent);
		const block = entry?.block ?? null;
		const contentIndex = entry?.contentIndex ?? output.content.length - 1;

		if (item.type === "reasoning" && block?.type === "thinking") {
			block.thinking = item.summary?.map(summary => summary.text).join("\n\n") || "";
			block.thinkingSignature = JSON.stringify(item);
			stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "message" && block?.type === "text") {
			block.text = item.content
				.map(content => (content.type === "output_text" ? content.text : content.refusal))
				.join("");
			const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
			block.textSignature = encodeTextSignatureV1(item.id, phase);
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "function_call") {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: parseStreamingJson(item.arguments || "{}"),
			};
			if (block?.type === "toolCall") {
				// Persist the authoritative final args on the stored block; the throttled
				// delta parser may have left block.arguments stale (often `{}`).
				block.arguments = toolCall.arguments;
				clearStreamingPartialJson(block);
			}
			// Detach so a late/duplicate arguments.delta cannot append to the
			// finished block or trip the whitespace-loop guard against it.
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}

		if (item.type === "custom_tool_call") {
			const partial = block?.type === "toolCall" ? block[kStreamingPartialJson] : undefined;
			const rawInput = partial && partial.length > 0 ? partial : (item.input ?? "");
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: { input: rawInput },
				customWireName: item.name,
			};
			if (block?.type === "toolCall") {
				block.arguments = { input: rawInput };
				clearStreamingPartialJson(block);
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}
	}

	#handleResponseCompleted(rawEvent: Record<string, unknown>): void {
		const { runtime, model, output } = this;
		runtime.sawTerminalEvent = true;
		const response = (
			rawEvent as {
				response?: {
					id?: string;
					usage?: {
						input_tokens?: number;
						output_tokens?: number;
						total_tokens?: number;
						input_tokens_details?: { cached_tokens?: number };
						output_tokens_details?: { reasoning_tokens?: number };
					};
					status?: string;
					service_tier?: ServiceTier | "default";
					end_turn?: boolean;
				};
			}
		).response;

		populateResponsesUsageFromResponse(output, response?.usage);
		if (typeof response?.id === "string" && response.id.length > 0) {
			output.responseId = response.id;
		}

		const state = runtime.websocketState;
		if (state) {
			if (runtime.transport !== "websocket") {
				// SSE turns never chain (previous_response_id is websocket-only on this
				// endpoint); a completed SSE turn also invalidates any websocket append
				// baseline, which no longer matches the transcript.
				resetCodexWebSocketAppendState(state);
			} else {
				state.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
				if (typeof response?.id === "string" && response.id.length > 0) {
					state.lastResponseId = response.id;
					state.lastResponseItems = stripInputItemIds(structuredCloneJSON(runtime.nativeOutputItems));
					state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed";
				} else {
					// Without a response id the append baseline cannot be trusted.
					state.canAppend = false;
				}
			}
		}

		finalizePendingResponsesToolCalls(output);

		calculateCost(model, output.usage);
		applyCodexServiceTierPricing(
			model,
			output.usage,
			response?.service_tier,
			runtime.requestBodyForState.service_tier,
		);
		output.stopReason = mapOpenAIResponsesStopReason(response?.status as ResponseStatus | undefined);
		promoteResponsesToolUseStopReason(output, response?.end_turn);
	}

	async #recoverStreamError(error: unknown): Promise<boolean> {
		if (await this.#tryRecoverWhitespaceToolCallLoop(error)) {
			return true;
		}
		if (await this.#tryReconnectWebSocketOnConnectionLimit(error)) {
			return true;
		}
		if (await this.#tryRecoverPreviousResponseNotFound(error)) {
			return true;
		}
		if (await this.#tryReplayWebsocketFailureOverSse(error)) {
			return true;
		}
		if (await this.#tryRetryProviderError(error)) {
			return true;
		}
		return false;
	}

	/**
	 * Recover from the degenerate whitespace-only tool-call argument loop
	 * ({@link CodexWhitespaceToolCallLoopError}). The interrupted function call has
	 * no usable arguments, so drop the partial turn and replay the request from
	 * scratch — bounded by {@link CODEX_WHITESPACE_LOOP_RETRY_LIMIT}. Sampling
	 * nondeterminism usually breaks the loop on a fresh attempt; once the budget is
	 * exhausted the original error is surfaced (now without the junk tool call
	 * polluting the message). Replay is refused once any visible content was already
	 * delivered to the consumer — a finished tool call (`canSafelyReplayWebsocketOverSse`),
	 * or any streamed text/commentary block still in `output.content` after the degenerate
	 * tool call is dropped — because replaying re-emits already-streamed deltas.
	 */
	async #tryRecoverWhitespaceToolCallLoop(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexWhitespaceToolCallLoopError)) {
			return false;
		}
		// Drop the half-built degenerate tool call whether or not we retry, so it
		// never reaches the caller's message.
		this.#dropTrailingDegenerateToolCall();
		if (
			this.runtime.whitespaceLoopRetries >= CODEX_WHITESPACE_LOOP_RETRY_LIMIT ||
			!this.runtime.canSafelyReplayWebsocketOverSse ||
			this.output.content.some(block => block.type !== "thinking") ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.whitespaceLoopRetries += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.turnState = undefined;
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex turn after whitespace-only tool-call argument loop", {
				retry: this.runtime.whitespaceLoopRetries,
				retryBudget: CODEX_WHITESPACE_LOOP_RETRY_LIMIT,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		this.runtime.whitespaceToolCallArgumentsDelta = undefined;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS * this.runtime.whitespaceLoopRetries, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	/**
	 * Pop the half-built degenerate tool-call block (the one whose arguments were
	 * nothing but whitespace) off the output accumulator so it never surfaces in the
	 * caller's message. Any legitimate content produced before it is preserved.
	 */
	#dropTrailingDegenerateToolCall(): void {
		const { runtime, output } = this;
		const block = runtime.currentBlock;
		if (block && block.type === "toolCall" && output.content[output.content.length - 1] === block) {
			output.content.pop();
		}
		runtime.closeOpenItem(runtime.currentEntry);
	}

	/**
	 * Handles `websocket_connection_limit_reached` errors by closing the stale connection
	 * and opening a fresh websocket. If content has already been emitted to the caller,
	 * falls back to SSE replay (same as other WS failures) since we cannot safely
	 * continue a partial response on a new connection. If a tool call was already
	 * delivered (`canSafelyReplayWebsocketOverSse` is false), the error surfaces
	 * instead — replaying would re-emit the same tool calls.
	 */
	async #tryReconnectWebSocketOnConnectionLimit(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexProviderStreamError) || error.code !== "websocket_connection_limit_reached") {
			return false;
		}
		const websocketState = this.requestContext.websocketState;
		if (!websocketState || this.runtime.transport !== "websocket" || this.options?.signal?.aborted) {
			return false;
		}

		// Close the stale connection so getOrCreateCodexWebSocketConnection creates a fresh one.
		websocketState.connection?.close("connection_limit");
		websocketState.connection = undefined;
		resetCodexWebSocketAppendState(websocketState);

		if (this.output.content.length > 0 && !this.runtime.canSafelyReplayWebsocketOverSse) {
			// A toolcall_end already reached the consumer; a full replay would emit
			// the same tool calls a second time. Let the error surface instead.
			return false;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket connection limit reached, reconnecting", {
				hadContent: this.output.content.length > 0,
				retry: this.runtime.websocketStreamRetries,
			});

		if (this.output.content.length > 0) {
			// Content already emitted to the caller — cannot safely continue on a new WS.
			// Reset and replay the full request over SSE.
			this.runtime.resetAccumulators();
			resetOutputState(this.output);
			this.firstTokenTime = undefined;
			recordCodexWebSocketFailure(websocketState, true);
			await this.#reopenSseStream(websocketState);
			return true;
		}

		// No content emitted yet — clear accumulator state from the failed attempt
		// (blockless native items can exist even with empty content) and reconnect
		// over websocket, bounded by the shared retry budget: an account-scoped
		// limit can reject every fresh connection, and an unbounded loop would
		// hammer the endpoint with zero backoff.
		this.runtime.resetAccumulators();
		this.firstTokenTime = undefined;
		if (this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET) {
			recordCodexWebSocketFailure(websocketState, true);
			await this.#reopenSseStream(websocketState);
			return true;
		}
		this.runtime.websocketStreamRetries += 1;
		await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
			signal: this.requestSetup.requestSignal,
		});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryRecoverPreviousResponseNotFound(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		if (
			!isCodexStalePreviousResponseError(error) ||
			!websocketState ||
			this.output.content.length > 0 ||
			this.options?.signal?.aborted ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES
		) {
			return false;
		}
		if (this.runtime.transport !== "websocket") {
			// SSE never sends previous_response_id; let other recovery handle it.
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		resetCodexWebSocketAppendState(websocketState);
		websocketState.turnState = undefined;
		websocketState.modelsEtag = undefined;
		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;

		CODEX_DEBUG &&
			logger.debug("[codex] codex previous_response_id expired; retrying with full context", {
				retry: this.runtime.providerRetryAttempt,
			});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryReplayWebsocketFailureOverSse(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		const canReplay =
			this.runtime.transport === "websocket" &&
			websocketState &&
			isCodexWebSocketRetryableStreamError(error) &&
			this.runtime.canSafelyReplayWebsocketOverSse &&
			!this.runtime.sawTerminalEvent &&
			!this.options?.signal?.aborted;
		if (!canReplay) return false;

		const state = websocketState;
		const streamError = error instanceof Error ? error : new Error(String(error));
		const replayingBufferedOutputOverSse = this.output.content.length > 0;
		const fatalWebSocketMessage = streamError.message.toLowerCase();
		const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
			fatalWebSocketMessage.includes(pattern.toLowerCase()),
		);
		const activateFallback =
			replayingBufferedOutputOverSse ||
			isFatal ||
			this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET;
		recordCodexWebSocketFailure(state, activateFallback);
		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket stream fallback", {
				error: streamError.message,
				retry: this.runtime.websocketStreamRetries,
				retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
				activated: activateFallback,
				fatal: isFatal,
				replayedBufferedOutput: replayingBufferedOutputOverSse,
			});

		if (!activateFallback) {
			this.runtime.websocketStreamRetries += 1;
			// Full re-send on a fresh socket: clear accumulator state from the failed
			// attempt. Content is empty here, but blockless native items (e.g.
			// web_search_call) may already have accumulated.
			this.runtime.resetAccumulators();
			this.firstTokenTime = undefined;
			await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
				signal: this.requestSetup.requestSignal,
			});
			await this.#reopenWebSocketStream(state);
			return true;
		}

		this.runtime.resetAccumulators();
		resetOutputState(this.output);
		this.firstTokenTime = undefined;

		await this.#reopenSseStream(state);
		return true;
	}

	async #tryRetryProviderError(error: unknown): Promise<boolean> {
		if (
			!(error instanceof CodexProviderStreamError && error.retryable) ||
			this.output.content.length > 0 ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.turnState = undefined;
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex provider stream error", {
				error: error instanceof Error ? error.message : String(error),
				retry: this.runtime.providerRetryAttempt,
				retryBudget: CODEX_MAX_RETRIES,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_RETRY_DELAY_MS * this.runtime.providerRetryAttempt, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	async #reopenWebSocketStream(state: CodexWebSocketSessionState): Promise<void> {
		try {
			const next = await openCodexWebSocketTransport(
				this.model,
				this.options,
				this.requestContext,
				this.requestSetup,
				state,
				this.runtime.websocketStreamRetries,
				this.options ? event => this.options?.onSseEvent?.(event, this.model) : undefined,
			);
			this.runtime.eventStream = next.eventStream;
			this.runtime.requestBodyForState = next.requestBodyForState;
			this.runtime.transport = next.transport;
			state.lastTransport = next.transport;
		} catch (error) {
			if (!(error instanceof CodexWebSocketTransportError)) throw error;
			// Reopen failed at the websocket layer (handshake refused, connect timeout, etc.).
			// Activate fallback so subsequent turns use SSE, and replay this turn over SSE
			// instead of surfacing a raw transport error to the caller.
			recordCodexWebSocketFailure(state, true);
			CODEX_DEBUG &&
				logger.debug("[codex] codex websocket reopen failed, falling back to SSE", {
					error: error.message,
					retry: this.runtime.websocketStreamRetries,
				});
			await this.#reopenSseStream(state);
		}
	}

	async #reopenSseStream(state: CodexWebSocketSessionState | undefined): Promise<void> {
		const next = await openCodexSseTransport(this.model, this.requestContext, this.requestSetup, this.options, state);
		this.runtime.eventStream = next.eventStream;
		this.runtime.requestBodyForState = next.requestBodyForState;
		this.runtime.transport = next.transport;
		if (state) {
			state.lastTransport = next.transport;
		}
	}

	finalize(completion: CodexStreamCompletion): AssistantMessage {
		const { output } = this;
		if (this.options?.signal?.aborted) {
			throw new AIError.AbortError();
		}
		if (!this.runtime.sawTerminalEvent) {
			if (this.requestContext.websocketState) {
				resetCodexWebSocketAppendState(this.requestContext.websocketState);
				this.requestContext.websocketState.turnState = undefined;
				this.requestContext.websocketState.modelsEtag = undefined;
			}
			CODEX_DEBUG &&
				logger.debug("[codex] codex stream ended unexpectedly", {
					transport: this.runtime.transport,
					terminalEventSeen: this.runtime.sawTerminalEvent,
					unexpectedStreamEnd: true,
					sentTurnStateHeader: Boolean(this.requestContext.websocketState?.turnState),
					sentModelsEtagHeader: Boolean(this.requestContext.websocketState?.modelsEtag),
				});
			throw new CodexProviderStreamError("Codex stream ended before terminal completion event", false);
		}
		if (output.stopReason === "aborted" || output.stopReason === "error") {
			throw new CodexProviderStreamError("Codex response failed", false);
		}

		output.providerPayload = createOpenAIResponsesHistoryPayload(this.model.provider, this.runtime.nativeOutputItems);
		output.duration = performance.now() - this.startTime;
		if (completion.firstTokenTime) {
			output.ttft = completion.firstTokenTime - this.startTime;
		}
		return output;
	}
}

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const requestSetup = createRequestSetup(options);
		let processingContext: CodexStreamProcessor | undefined;
		let requestContext: CodexRequestContext | undefined;

		try {
			requestContext = await buildCodexRequestContext(model, context, options, output);
			const initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
			const runtime = new CodexStreamRuntime({
				...initialTransport,
				websocketState: requestContext.websocketState,
			});
			if (requestContext.websocketState) {
				requestContext.websocketState.lastTransport = initialTransport.transport;
			}

			processingContext = new CodexStreamProcessor({
				runtime,
				model,
				output,
				stream,
				options,
				requestSetup,
				requestContext,
				startTime,
			});

			const completion = await processingContext.process();
			processingContext.firstTokenTime = completion.firstTokenTime;
			const message = processingContext.finalize(completion);
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end();
		} catch (error) {
			const failureContext =
				processingContext ??
				({
					model,
					output,
					options,
					requestContext: requestContext ?? {
						apiKey: "",
						accountId: "",
						baseUrl: model.baseUrl || CODEX_BASE_URL,
						url: "",
						requestHeaders: {},
						responsesLite: options?.responsesLite === true,
						transformedBody: { model: model.id },
						rawRequestDump: {
							provider: model.provider,
							api: output.api,
							model: model.id,
							method: "POST",
							url: "",
							body: { model: model.id },
						},
					},
					startTime,
				} satisfies CodexStreamFailureContext);
			try {
				const failure = await handleCodexStreamFailure(failureContext, error);
				stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
			} catch (failureError) {
				// Last resort — the failure handler itself threw (exotic error object or
				// request-dump formatting). Never leave the stream un-ended.
				logger.error("Codex stream failure handler threw", {
					error: failureError instanceof Error ? failureError.message : String(failureError),
				});
				output.stopReason = "error";
				output.errorMessage ??= error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
			}
			stream.end();
		}
	})();

	return stream;
};

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		"apiKey" | "headers" | "sessionId" | "signal" | "preferWebsockets" | "providerSessionState" | "responsesLite"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const transportSessionId = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const promptCacheKey = transportSessionId;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = options?.responsesLite === true;
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
		accountId,
		apiKey,
		promptCacheKey,
		"websocket",
		state,
		responsesLite,
	);
	await logger.time(
		"prewarmCodex:establishWs",
		getOrCreateCodexWebSocketConnection,
		state,
		toWebSocketUrl(url),
		headers,
		options?.signal,
	);
	state.prewarmed = true;
}

function getCodexWebSocketSessionKey(
	normalizedSessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string,
	baseUrl: string,
	responsesLite: boolean,
): string | undefined {
	if (!normalizedSessionId) return undefined;
	// Responses Lite is connection-scoped on the WebSocket upgrade, so lite and
	// non-lite turns must never share a pooled socket or append state.
	const liteSuffix = responsesLite ? ":lite" : "";
	return `${accountId}:${baseUrl}:${model.id}:${normalizedSessionId}${liteSuffix}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: {
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
		},
	};
	providerSessionState.webSocketSessions.set(sessionKey, created);
	return created;
}

function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

function recordCodexWebSocketFailure(state: CodexWebSocketSessionState, activateFallback: boolean): void {
	resetCodexWebSocketAppendState(state);
	// Never tear down a CONNECTING socket: it belongs to a concurrent caller's
	// in-flight handshake (prewarm/request race); closing it would reject that
	// caller with a fatal "websocket closed before open" and disable websockets
	// for the whole session.
	if (state.connection && !state.connection.isConnecting()) {
		state.connection.close("fallback");
		state.connection = undefined;
	}
	state.lastFallbackAt = Date.now();
	if (activateFallback && !state.disableWebsocket) {
		state.disableWebsocket = true;
		state.fallbackCount += 1;
	}
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	if (!state || state.disableWebsocket) return false;
	if (preferWebsockets === false) return false;
	return $flag("PI_CODEX_WEBSOCKET") || preferWebsockets === true || model.preferWebsockets === true;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const normalizedSessionId = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const publicSessionKey = normalizedSessionId ? `${baseUrl}:${model.id}:${normalizedSessionId}` : undefined;
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const websocketPreferred =
		options?.preferWebsockets === false
			? false
			: $flag("PI_CODEX_WEBSOCKET") || options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = getCodexWebSocketStateForPublicSession(model, options);

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		lastFallbackAt: state?.lastFallbackAt,
	};
}

function stripInputItemIds(items: Array<Record<string, unknown>>): InputItem[] {
	return items.map(item => {
		if (item.id == null) return item as InputItem;
		const { id: _id, ...rest } = item;
		return rest as InputItem;
	});
}

function recordCodexWebSocketRequestStats(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	if (typeof request.previous_response_id === "string" && request.previous_response_id.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = request.previous_response_id;
		return;
	}
	state.stats.fullContextRequests += 1;
	state.stats.lastDeltaInputItems = undefined;
	state.stats.lastPreviousResponseId = undefined;
}

/**
 * Shape the next websocket turn's request body: when the session's append
 * baseline is intact (same options, strict history prefix), chain via
 * `previous_response_id` + delta-only `input`; otherwise break the chain and
 * replay the full transcript. SSE requests never chain — the HTTP endpoint's
 * request schema has no `previous_response_id` (codex-rs carries it only on
 * websocket `response.create` frames) and strict gateway validators 400 it
 * with `{"detail":"Unsupported parameter: previous_response_id"}`.
 */
function buildCodexChainedRequestBody(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): RequestBody {
	const chainable = state?.canAppend === true;
	const appendInput = chainable
		? buildResponsesDeltaInput(state.lastRequest, state.lastResponseItems, requestBody)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		const body: RequestBody = { ...requestBody, previous_response_id: state.lastResponseId, input: appendInput };
		recordCodexWebSocketRequestStats(state, body);
		return body;
	}
	if (chainable && state) {
		// Chaining was eligible but the prefix/options check failed: history
		// mutated or options changed — break the chain.
		CODEX_DEBUG &&
			logger.debug("[codex] codex append reset", {
				hadTurnStateHeader: Boolean(state.turnState),
				hadModelsEtagHeader: Boolean(state.modelsEtag),
			});
		resetCodexWebSocketAppendState(state);
		state.turnState = undefined;
		state.modelsEtag = undefined;
	}
	recordCodexWebSocketRequestStats(state, requestBody);
	return requestBody;
}

function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketRequestTimeouts {
	idleTimeoutMs?: number;
	firstEventTimeoutMs?: number;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
}

class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;
	/**
	 * Wall-clock of the most recent inbound activity on this socket — any
	 * decoded message, any pong, or the moment the handshake completed. Used
	 * by {@link isHealthyForReuse} so we don't write a continuation frame into
	 * a TCP-open-but-server-evicted socket whose `readyState` still says OPEN.
	 */
	#lastInboundAt = 0;
	/** Wall-clock of the last heartbeat ping we issued; 0 if none yet. */
	#lastPingAt = 0;
	/**
	 * Most recent `response.id` accepted on this socket, retained across
	 * requests. Lets the next request drop a trailing/duplicate frame from the
	 * previous (cleanly-completed) response that outlived the queue drain.
	 */
	#lastSeenResponseId?: string;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** True while a handshake (possibly started by another caller) is still in flight. */
	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	/**
	 * Stricter variant of {@link isOpen} for the connection-pool reuse gate.
	 * Refuses sockets that have been silent past {@link CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS}.
	 *
	 * Bun's `WebSocket` does not always surface server-side eviction (no
	 * `onclose`, no `onerror`), so a socket can sit in readyState OPEN long
	 * after the upstream has dropped it. Reusing such a socket sends the next
	 * `response.create` into a half-open write buffer and parks the reader
	 * until the first-event / idle timeout fires (issue #1450). Forcing a
	 * reconnect on any suspect socket trades a sub-second handshake for a
	 * 60–300 s stall.
	 */
	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS;
		if (maxIdleMs <= 0) return true;
		// Initial connect sets #lastInboundAt; any later message or pong refreshes
		// it. A zero value means the field was never initialized, which itself is
		// a desync — treat as unhealthy.
		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
		this.#stopHeartbeat();
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const clearPending = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`request was aborted`));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		if (!settled) {
			timeout = setTimeout(() => {
				socket.close(1000, "connect-timeout");
				if (!settled) {
					settled = true;
					clearPending();
					reject(new CodexWebSocketTransportError(`connection timeout`));
				}
			}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
		}

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#lastInboundAt = Date.now();
				this.#captureHandshakeHeaders(socket, event);
				this.#startHeartbeat(socket);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = new CodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(new CodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			// Stamp inbound activity before parsing so even malformed frames refresh
			// the liveness clock — what matters for reuse health is that the upstream
			// is still talking to us, not that every frame is well-formed.
			this.#lastInboundAt = Date.now();
			this.#writeDebugWebSocketFrame(event.data);
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
					const inner = parsed.error as Record<string, unknown>;
					if (typeof parsed.code !== "string" && typeof inner.code === "string") {
						parsed.code = inner.code;
					}
					if (typeof parsed.message !== "string" && typeof inner.message === "string") {
						parsed.message = inner.message;
					}
				}
				notifyCodexWebSocketInbound(this.#streamObserver, parsed, text);
				this.#push(parsed);
			} catch (error) {
				notifyCodexWebSocketMalformed(this.#streamObserver, event.data, error);
				this.#push(new CodexWebSocketTransportError(`${String(error)}`));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
		}
		if (this.#activeRequest) {
			throw new CodexWebSocketTransportError(`websocket request already in progress`);
		}
		if (signal?.aborted) {
			throw new CodexWebSocketTransportError(`request was aborted`);
		}
		this.#activeRequest = true;
		this.#streamObserver = onSseEvent;
		// Drain any non-error frames left over from a prior request before sending.
		// `CodexStreamProcessor.process` breaks its `for-await` on the terminal event,
		// which interrupts our generator at `yield next` (the post-yield `break`
		// never runs). Any frame that landed between the consumer's break and the
		// generator's `finally` lingers in `#queue` and would otherwise become the
		// first frame of THIS request — a stale `response.completed` would end the
		// turn immediately with empty output, and a stale non-progress frame would
		// flip `sawFirstEvent` and silently downgrade the first-event timeout to
		// the longer idle timeout. Transport errors are preserved so we surface
		// the death signal instead of writing into a dead socket.
		this.#dropStaleFrames();
		const onAbort = () => {
			this.close("aborted");
			this.#push(new CodexWebSocketTransportError(`request was aborted`));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		try {
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "websocket",
						method: "POST",
						url: this.#url,
						headers: this.#headers,
						body: request,
					})
				: undefined;
			this.#debugResponseLog = debugSession
				? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
				: undefined;

			const requestPayload = JSON.stringify(request);
			notifyCodexWebSocketOutbound(onSseEvent, request, requestPayload);
			// Re-check liveness: the debug-session await above can outlive the socket.
			const socket = this.#socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
			}
			try {
				socket.send(requestPayload);
			} catch (error) {
				throw new CodexWebSocketTransportError(
					`websocket send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			let sawFirstEvent = false;
			const { idleTimeoutMs, firstEventTimeoutMs } = timeouts;
			let lastProgressAt = Date.now();
			let lastProgressEventType: string | undefined;
			let lastEventAt = lastProgressAt;
			let lastEventType: string | undefined;
			// Cross-request frame guard: lock onto this response's id and reject
			// frames belonging to another response interleaved on the reused socket.
			let activeResponseId: string | undefined;
			let lastSequence: number | undefined;
			const priorResponseId = this.#lastSeenResponseId;
			while (true) {
				let timeoutMs: number | undefined;
				let timeoutReason: string;
				if (sawFirstEvent) {
					timeoutReason = createCodexWebSocketTimeoutMessage("idle timeout waiting for websocket", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
						timeoutMs = idleTimeoutMs - (Date.now() - lastProgressAt);
						if (timeoutMs <= 0) {
							CODEX_DEBUG &&
								logger.debug("[codex] codex websocket idle timeout", {
									lastEventType,
									lastProgressEventType,
									msSinceLastEvent: Date.now() - lastEventAt,
									msSinceLastProgress: Date.now() - lastProgressAt,
								});
							throw new CodexWebSocketTransportError(`${timeoutReason}`);
						}
					}
				} else {
					timeoutReason = createCodexWebSocketTimeoutMessage("timeout waiting for first websocket event", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0) {
						timeoutMs = firstEventTimeoutMs;
					}
				}
				const next = await this.#nextMessage(timeoutMs, timeoutReason);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw new CodexWebSocketTransportError(`websocket closed before response completion`);
				}
				const eventType = typeof next.type === "string" ? next.type : "";
				// Cross-request frame guard. The socket is reused across turns. Upstream
				// codex-rs leans on the protocol guarantee that nothing follows a
				// response's terminal event, but our queue can still surface a trailing
				// or duplicate frame from a cleanly-completed prior response after
				// #dropStaleFrames() drained the queue at send time. Attaching such a
				// frame to THIS turn misattributes an earlier turn's output (a stale
				// `response.completed` ends the turn early; a stale item makes the model
				// see an unrelated call). Only lifecycle events (created/completed/
				// failed/incomplete) carry a `response.id` — exactly the harmful ones —
				// so key the guard on it and let idless frames (deltas, the rate-limit/
				// metadata preamble, created-less streams) pass through, matching
				// upstream rather than gating on `response.created`.
				const frameResponseId = extractCodexFrameResponseId(next);
				const frameSequence = extractCodexFrameSequenceNumber(next);
				if (frameResponseId !== undefined) {
					if (activeResponseId === undefined) {
						if (priorResponseId !== undefined && frameResponseId === priorResponseId) {
							// Trailing/duplicate frame of the previous response that
							// outlived the drain. Drop without locking or advancing the
							// first-event clocks so our own response can still start.
							continue;
						}
						activeResponseId = frameResponseId;
					} else if (frameResponseId !== activeResponseId) {
						// A different response is interleaving on the socket; the idless
						// deltas that follow are indistinguishable, so fail closed
						// (retryable) instead of risking misattribution.
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket frame for response ${frameResponseId} interleaved into active response ${activeResponseId}`,
						);
					}
					this.#lastSeenResponseId = frameResponseId;
				}
				if (frameSequence !== undefined) {
					if (activeResponseId !== undefined && lastSequence !== undefined && frameSequence < lastSequence) {
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket sequence_number ${frameSequence} regressed below ${lastSequence} within response ${activeResponseId}`,
						);
					}
					lastSequence = frameSequence;
				}
				sawFirstEvent = true;
				lastEventAt = Date.now();
				lastEventType = eventType || undefined;
				if (isCodexStreamProgressEvent(next)) {
					lastProgressAt = lastEventAt;
					lastProgressEventType = lastEventType;
				}
				yield next;
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error"
				) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#handshakeHeaders = headers;
		this.#onHandshakeHeaders?.(headers);
	}

	#writeDebugWebSocketFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string") {
			log.write(data);
			return;
		}
		if (data instanceof Uint8Array) {
			log.write(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			log.write(new Uint8Array(data));
			return;
		}
		log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const intervalMs = CODEX_WEBSOCKET_PING_INTERVAL_MS;
		if (intervalMs <= 0) return;

		this.#lastPingAt = 0;
		const socketEventTarget = socket as EventTarget;
		const onPong = () => {
			// Pongs are inbound activity — refresh the reuse-health clock so a quiet
			// but ping-responsive socket stays trustworthy across requests.
			this.#lastInboundAt = Date.now();
		};
		if (
			typeof socketEventTarget.addEventListener === "function" &&
			typeof socketEventTarget.removeEventListener === "function"
		) {
			socketEventTarget.addEventListener("pong", onPong);
			this.#removePongListener = () => socketEventTarget.removeEventListener("pong", onPong);
		}

		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			// Fail-closed on missing pongs even when no pong has ever been observed.
			// The previous `#observedPong &&` guard disabled the timeout entirely on
			// runtimes where Bun does not surface a `pong` event for our outgoing
			// pings (issue #1450) — letting truly dead sockets sail through the
			// pool until the per-request first-event / idle timeout (60–300 s)
			// finally fired. Instead, trigger on inbound silence: if we sent a
			// ping at least `pongTimeoutMs` ago and have received no traffic of
			// any kind (data frame or pong) since, the socket is unhealthy.
			const pongTimeoutMs = CODEX_WEBSOCKET_PONG_TIMEOUT_MS;
			if (
				pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > pongTimeoutMs
			) {
				this.#failQueue(new CodexWebSocketTransportError(`websocket pong timeout`), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					new CodexWebSocketTransportError(
						`websocket ping failed: ${error instanceof Error ? error.message : String(error)}`,
					),
					"ping-failed",
				);
			}
		}, intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatInterval) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = undefined;
		}
		if (this.#removePongListener) {
			this.#removePongListener();
			this.#removePongListener = undefined;
		}
		this.#lastPingAt = 0;
	}

	#failQueue(error: Error, closeReason: string): void {
		CODEX_DEBUG && logger.debug("[codex] codex websocket transport failure", { error: error.message, closeReason });
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(closeReason);
		this.#wakeWaiters();
	}

	/**
	 * Discard data frames from a previous request that remained in `#queue`
	 * after the consumer broke out on the terminal event. Preserves any queued
	 * transport error (from `onerror` / `onclose` / `#failQueue`) so the next
	 * `#nextMessage` surfaces the death signal instead of waiting it out.
	 *
	 * Returns the number of frames dropped (test/debug visibility only).
	 */
	#dropStaleFrames(): number {
		if (this.#queue.length === 0) return 0;
		const surviving = this.#queue.filter(item => item instanceof Error);
		const dropped = this.#queue.length - surviving.length;
		if (dropped === 0) return 0;
		this.#queue.length = 0;
		for (const item of surviving) this.#queue.push(item);
		CODEX_DEBUG && logger.debug("[codex] codex websocket dropped stale frames before request", { dropped });
		return dropped;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error | null): void {
		if (item instanceof Error) {
			// Append after frames already received instead of wiping them: a queued
			// terminal event (e.g. `response.completed` followed by an eager server
			// close) must still reach the consumer rather than morph into a spurious
			// transport failure. `#dropStaleFrames` keeps errors across requests, so
			// the death signal still surfaces if the data frames go unconsumed.
			this.#queue.push(item);
			this.#wakeWaiters();
			return;
		}
		if (item !== null && this.#queue.length >= CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY) {
			this.#failQueue(
				new CodexWebSocketTransportError(
					`websocket message queue exceeded ${CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		timeoutReason: string,
	): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return new CodexWebSocketTransportError(`${timeoutReason}`);
			}
		}
		return this.#queue.shift() ?? null;
	}
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	// Join an in-flight handshake instead of tearing it down: closing a
	// CONNECTING socket rejects the concurrent caller (prewarm racing the first
	// request) with a fatal "websocket closed before open", which would disable
	// websockets for the entire session.
	// Bounded re-join: a fresh handshake may have been started by yet another
	// caller while we awaited the previous one.
	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {
			// The handshake owner surfaces its own failure; re-evaluate below
			// (state.connection may have been replaced or cleared).
		}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			// Open in readyState but no inbound traffic recently — likely server-
			// evicted (issue #1450). Force a fresh handshake instead of writing
			// `response.create` into a half-open buffer and waiting out the
			// first-event timeout. Drop append state because the new socket
			// won't carry the prior `previous_response_id` context.
			CODEX_DEBUG && logger.debug("[codex] codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	responsesLite: boolean,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const headers = createCodexHeaders(requestHeaders, accountId, apiKey, sessionId, "sse", state, responsesLite);
	CODEX_DEBUG &&
		logger.debug("[codex] codex request", {
			url,
			model: body.model,
			headers: redactHeaders(headers),
			sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
		});
	// `wrapCodexSseStream` arms the iterator-level idle watchdog only after this
	// fetch resolves. A pre-response timer still bounds time-to-first-byte (a
	// proxy that accepts the POST but never sends headers would otherwise hang
	// forever, since `timeout: false` disables Bun's native ceiling — issue
	// #2422). It MUST be cleared the instant headers arrive: an absolute
	// `AbortSignal.timeout` would keep aborting the actively-streaming body.
	const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
	let response: Response;
	try {
		response = await fetchWithRetry(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: watchdog.signal,
			maxAttempts: CODEX_MAX_RETRIES + 1,
			defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
			maxDelayMs: CODEX_RATE_LIMIT_BUDGET_MS,
			fetch: fetchOverride,
			timeout: false,
		});
	} finally {
		watchdog.clear();
	}
	CODEX_DEBUG &&
		logger.debug("[codex] codex response", {
			url: response.url,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") || null,
			cfRay: response.headers.get("cf-ray") || null,
		});
	if (!response.ok) {
		throw await CodexApiError.fromResponse(response);
	}
	updateCodexSessionMetadataFromHeaders(state, response.headers);
	if (!response.body) {
		throw new CodexProviderStreamError("No response body", false);
	}
	return readSseJson<Record<string, unknown>>(response.body, signal, event =>
		onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, undefined),
	);
}

function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string,
	accessToken: string,
	sessionId?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
	responsesLite = false,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	const betaHeader =
		transport === "websocket"
			? OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2
			: OPENAI_HEADER_VALUES.BETA_RESPONSES;
	headers.delete(OPENAI_HEADERS.BETA);
	headers.delete("openai-beta");
	headers.set(OPENAI_HEADERS.BETA, betaHeader);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set("User-Agent", `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`);
	if (sessionId) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
		headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		headers.set("x-client-request-id", sessionId);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
		headers.delete("x-client-request-id");
	}
	if (state?.turnState) {
		headers.set(X_CODEX_TURN_STATE_HEADER, state.turnState);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (responsesLite) {
		headers.set(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER, "true");
	} else {
		headers.delete(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER);
	}
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	return headers;
}

function redactHeaders(headers: Headers): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === "authorization") {
			redacted[key] = "Bearer [redacted]";
			continue;
		}
		if (
			lower.includes("account") ||
			lower.includes("session") ||
			lower.includes("conversation") ||
			lower === "x-client-request-id" ||
			lower === "cookie"
		) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function getAccountId(accessToken: string): string {
	const accountId = getCodexAccountId(accessToken);
	if (!accountId) {
		throw new AIError.OAuthError("Failed to extract accountId from token", {
			kind: "validation",
			provider: "openai",
		});
	}
	return accountId;
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let msgIndex = 0;
	// Track call_ids that originated as custom tool calls so paired tool-result
	// messages can be replayed as `custom_tool_call_output` rather than
	// `function_call_output` (OpenAI rejects mismatched pairs).
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				messages.push(...historyItems);
				msgIndex += 1;
				continue;
			}

			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// Native items are model-bound (reasoning carries encrypted content
			// minted by the producing model); after a mid-session model switch fall
			// back to block re-encode, which strips foreign signatures.
			const providerPayload =
				assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items as Array<ResponseInput[number]> | undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				if (providerPayload?.dt) {
					messages.push(...historyItems);
				} else {
					messages.splice(0, messages.length, ...historyItems);
					// Keep customCallIds from the pre-splice state since historyItems may re-introduce them.
				}
				msgIndex += 1;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				true,
				customCallIds,
			);
			if (outputItems.length > 0) {
				messages.push(...outputItems);
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				model,
				false,
				model.compat.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
			);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>,
): ResponseInputContent[] {
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		return [{ type: "input_text", text: content.toWellFormed() }];
	}

	return (
		convertResponsesInputContent(content, model.input.includes("image"), model.compat.supportsImageDetailOriginal) ??
		[]
	);
}

/** @internal Exported for tests. */
export { convertMessages as convertCodexResponsesMessages };

type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

/** @internal Exported for tests. */
export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = model.applyPatchToolType === "freeform";
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		};
	});
}

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string) {
		super(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${detail}`);
		this.name = "CodexWebSocketTransportError";
	}
}
class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code?: string;

	constructor(message: string, retryable: boolean, code?: string) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
	}
}

const optionalCodexString = type("unknown").pipe(raw => {
	const out = type("string")(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerErrorDetailSchema = type({
	"code?": optionalCodexString,
	"type?": optionalCodexString,
	"message?": optionalCodexString,
});

const codexErrorDetailSchema = type("unknown").pipe(raw => {
	const out = innerErrorDetailSchema(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerFailureEventSchema = type({
	"type?": optionalCodexString,
	"code?": optionalCodexString,
	"message?": optionalCodexString,
	"status?": optionalCodexString,
	"error?": codexErrorDetailSchema,
	"response?": type("unknown").pipe(raw => {
		const out = type({
			"error?": codexErrorDetailSchema,
			"message?": optionalCodexString,
			"status?": optionalCodexString,
		})(raw);
		return out instanceof type.errors ? undefined : out;
	}),
});

const codexFailureEventSchema = type("unknown").pipe(raw => {
	const out = innerFailureEventSchema(raw);
	return out instanceof type.errors
		? {
				type: undefined,
				code: undefined,
				message: undefined,
				status: undefined,
				error: undefined,
				response: undefined,
			}
		: out;
});

export function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return false;
	}
	const error = event.error ?? event.response?.error;
	const code = error?.code ?? error?.type ?? event.code;
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = error?.message ?? event.message ?? event.response?.message;
	return !!message && CODEX_RETRYABLE_EVENT_MESSAGE.test(message);
}

export function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return new CodexProviderStreamError("Codex response failed", false);
	}
	const nestedError = event.error ?? event.response?.error;
	const code = nestedError?.code ?? nestedError?.type ?? event.code ?? "";
	const message = event.message ?? "";
	const formattedMessage =
		event.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, isRetryableCodexFailureEvent(rawEvent), code || undefined);
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const event = codexFailureEventSchema(rawEvent);
	if (event instanceof type.errors) {
		return null;
	}
	const error = event.error ?? event.response?.error;
	const message = error?.message ?? event.message ?? event.response?.message;
	const code = error?.code ?? error?.type ?? event.code;
	const status = event.response?.status ?? event.status;

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex response failed: ${truncatedRawEventJson}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex error event: ${truncatedRawEventJson}`;
	} catch {
		return "Codex error event";
	}
}
