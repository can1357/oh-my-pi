import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	codexRoutingHint,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import {
	$env,
	$flag,
	asRecord,
	toError,
	cloneJsonTree,
	fetchWithRetry,
	getInstallId,
	logger,
	readSseJson,
	structuredCloneJSON,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import * as AIError from "../error";
import { parseToolCallArguments, replayableToolCallArguments } from "../utils/tool-call-arguments";
import { getEnvApiKey } from "../env-api-key";
import type {
	Api,
	AssistantMessage,
	CodexCompactionRequestContext,
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
	ToolResultMessage,
	Usage,
} from "../types";
import { getPremiumServiceTierRequests, parseServiceTier } from "../types";
import {
	clampOpenAIResponsesImageDetailForReplay,
	createOpenAIResponsesHistoryPayload,
	dropMalformedOpenAIResponsesToolCalls,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	stripOpenAIResponsesComputerLinkedReasoningIdsForReplay,
} from "../utils";
import { clearStreamingPartialJson, kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import { hasVisibleAssistantContent } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { escapeHarmonyControlTokens, isHarmonyDialectModel } from "../utils/harmony-leak";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { getProxyForUrl } from "../utils/proxy";
import { wrapFetchForRequestCompression } from "../utils/request-compression";
import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "../utils/retry-after";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { toWebSocketHeaders, toWebSocketUrl } from "../utils/websocket";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexLiteShapedBody,
	type CodexReasoningContext,
	type CodexRequestOptions,
	type InputItem,
	type ReasoningConfig,
	lowestCodexWireEffort,
	type RequestBody,
	resolveCodexResponsesLite,
	sanitizeCodexCallId,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { applyCodexAccessPrograms, dropRejectedCodexAccessPrograms } from "./openai-codex/access-programs";
import {
	type CodexAcceptedSteer,
	type CodexSteerAck,
	CodexSteerPump,
	planSteeredRequest,
	toSteerInputItems,
} from "./openai-codex/live-steering";
import { CodexApiError } from "./openai-codex/response-handler";
import { getCodexAttestationHeader } from "./openai-codex-attestation";
export { createOpenAICodexCompactionRequestContext } from "./openai-codex-compaction";
import { getOpenAICodexWebSocketEnvValue } from "./openai-codex-transport";
import {
	createCodexProviderSessionState,
	getCodexProviderSessionState,
	resetCodexWebSocketAppendState,
} from "./openai-codex-state";
export { setCodexAttestationProvider } from "./openai-codex-attestation";
export type { CodexAttestationProvider } from "./openai-codex-attestation";
import {
	type OpenAIEffortControlState,
	planStableOpenAIEffort,
	resolveOpenAIEffortControlState,
} from "./openai-configuration-update";
import type {
	ResponseComputerToolCall,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputItem,
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
	appendResponsesImageResult,
	appendResponsesToolResultMessages,
	applyOpenAIServiceTier,
	applyReasoningSummaryDone,
	buildResponsesDeltaInput,
	computerCallMetadata,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createSequentialCutoffSummaryState,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	escapeReplayedControlTokens,
	finalizeCustomToolCallInputDone,
	finalizeMessageText,
	finalizePendingResponsesToolCalls,
	isOpenAIResponsesStalePreviousResponseError,
	finalizeReasoningThinking,
	finalizeToolCallArgumentsDone,
	getOpenAIPromptCacheKey,
	hasExecutableIncompleteResponsesToolCalls,
	mapOpenAIResponsesStopReason,
	normalizeOpenAIPromptCacheKey,
	pickUnrecordedResponsesToolCalls,
	populateResponsesUsageFromResponse,
	promoteResponsesToolUseStopReason,
	settleReasoningSummary,
	type SequentialCutoffSummaryState,
} from "./openai-shared";
import {
	isResponsesWebSocketProgressEvent,
	ResponsesWebSocketConnection,
	ResponsesWebSocketTransportError,
} from "./responses-websocket-connection";
import { normalizeToolCallId, redactSensitiveInObject, transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/**
	 * Run with the least reasoning the model allows; takes precedence over
	 * `reasoning`. Sends the `none` tier where the catalog's disable mode is
	 * `none-effort`, else the model's lowest supported effort.
	 */
	disableReasoning?: boolean;
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	/** Explicit `reasoning.context` replay scope. Omitted by default so Codex applies its native request policy. */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
	/**
	 * Responses Lite transport opt-in. Normal inference defaults to full
	 * Responses; provider-native compaction explicitly follows the model's
	 * `useResponsesLite` flag.
	 */
	responsesLite?: boolean;
	/**
	 * Additional fields embedded in the canonical
	 * `client_metadata["x-codex-turn-metadata"]` JSON blob. Reserved identity
	 * keys are ignored; extras are never emitted as top-level metadata fields.
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Turn id of the initiating (parent) Codex turn for nested requests such as
	 * subagent spawns (codex-rs `parent_turn_id`, #35835). Emitted both as the
	 * flat `client_metadata.parent_turn_id` key and inside the
	 * `x-codex-turn-metadata` JSON blob; blank values are ignored. The key is
	 * reserved: `clientMetadata` extras cannot supply it.
	 */
	parentTurnId?: string;
	/**
	 * Invoked when the server streams a `response.metadata` event carrying
	 * ChatGPT moderation metadata (`metadata.openai_chatgpt_moderation_metadata`)
	 * for first-party presentation parity. Diagnostic observer: failures are
	 * swallowed and must not alter the stream.
	 */
	onModerationMetadata?: (metadata: unknown) => void;
}

/** Raw V2 compaction body accepted by the Codex transport selector. */
export interface OpenAICodexCompactionBody extends CodexLiteShapedBody {
	model: string;
	[key: string]: unknown;
}

/** Transport controls for a provider-native Codex V2 compaction stream. */
export interface OpenAICodexCompactionStreamOptions extends OpenAICodexResponsesOptions {
	apiKey: string;
}

/** Inputs for synthesizing Codex request identity outside the normal stream path. */
export interface OpenAICodexCompatibilityMetadataOptions {
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	requestKind: OpenAICodexRequestKind;
	compaction?: CodexCompactionRequestContext;
	startNewTurn?: boolean;
	turnStartedAtUnixMs?: number;
	clientMetadata?: Readonly<Record<string, string>>;
	/** Parent Codex turn id for nested requests; see {@link OpenAICodexResponsesOptions.parentTurnId}. */
	parentTurnId?: string;
	/** Add the direct installation header required by `/responses/compact`. */
	includeInstallationHeader?: boolean;
}

/** Canonical Codex body metadata and compatibility headers for one request. */
export interface OpenAICodexCompatibilityMetadata {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;

function resolveCodexSseMaxAttempts(value: number | undefined): number {
	if (value === undefined) return CODEX_MAX_RETRIES + 1;
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.trunc(value));
}
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
const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS || 300_000);
const CODEX_WEBSOCKET_RETRY_BUDGET = Number($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET || CODEX_MAX_RETRIES);
const CODEX_WEBSOCKET_RETRY_DELAY_MS = Number($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS || CODEX_RETRY_DELAY_MS);
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
// The native-lane steering rejection is replayable: the session stops steering
// first, so the replay cannot trip it again.
const CODEX_RETRYABLE_EVENT_CODES = new Set([
	"model_error",
	"server_error",
	"internal_error",
	AIError.CODEX_NATIVE_LANE_STEER_REJECTED_CODE,
]);
/**
 * Turn lanes (see `#steeringLaneKey`) that refused a steer, shared across sessions so each new
 * session queues follow-ups instead of losing a response to the same refusal. Entries expire so
 * server-side support is picked up once it ships.
 */
const unsupportedSteeringLanes = new LRUCache<string, true>({ max: 256, ttl: 4 * 60 * 60 * 1000 });
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;

const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
/** WebSocket frames cannot carry per-request HTTP headers; codex-rs mirrors the lite marker into `client_metadata` under this key. */
const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
/** `response.metadata` payload key carrying ChatGPT moderation metadata. */
const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";
/** Connection-level websocket failures that should immediately fall back to SSE without retrying. */
const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
// Provider/model failure mode: Codex can keep a response alive by streaming
// whitespace-only function-call argument deltas forever. Those frames count as
// transport activity, so idle timers never fire; cap the run before raw debug
// buffers and partial JSON grow without semantic progress.
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

export type CodexTransport = "sse" | "websocket";
type CodexEventItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| ResponseCustomToolCall
	| ResponseComputerToolCall
	| ResponseOutputItem.ImageGenerationCall;
type CodexOutputBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number });

interface CodexResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		orchestration_input_tokens?: number;
		orchestration_input_cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		orchestration_output_tokens?: number;
	};
}

/** Shape of the Codex request sent on the latest provider turn. */
export interface OpenAICodexTurnRequestDiagnostics {
	transport: "sse" | "websocket";
	previousResponseIdPresent: boolean;
	inputItemCount: number;
	inputItemTypes: string[];
	firstInputItemType?: string;
	inputJsonBytes: number;
	promptCacheKey?: string;
	toolsHash?: string;
	optionsHash: string;
	canAppendBeforeRequest: boolean;
}

/** Raw provider usage plus the normalized buckets OMP displays for the latest Codex turn. */
export interface OpenAICodexTurnUsageDiagnostics {
	rawInputTokens: number;
	rawCachedTokens: number;
	rawUncachedTokens: number;
	rawOutputTokens: number;
	rawTotalTokens?: number;
	rawOrchestrationInputTokens?: number;
	rawOrchestrationCachedTokens?: number;
	rawOrchestrationOutputTokens?: number;
	displayedInputTokens: number;
	displayedOutputTokens: number;
	displayedCacheReadTokens: number;
	displayedCacheWriteTokens: number;
	displayedTotalTokens: number;
	displayedOrchestrationInputTokens: number;
	displayedOrchestrationCacheReadTokens: number;
	displayedOrchestrationOutputTokens: number;
}

/** Latest Codex turn request/usage diagnostics exposed to debug UIs and tests. */
export interface OpenAICodexTurnDiagnostics {
	request: OpenAICodexTurnRequestDiagnostics;
	usage?: OpenAICodexTurnUsageDiagnostics;
}

/**
 * Per-session request-shape counters and latest turn diagnostics. Despite the
 * name, these cover both transports.
 */
export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	lastTurn?: OpenAICodexTurnDiagnostics;
}

/**
 * Per-session transport state shared by both transports: WebSocket turn
 * chaining, models-etag headers, connection pooling, and debug stats. The name
 * is historical — SSE-only sessions use it too.
 */
export type CodexWebSocketSessionState = {
	sessionId: string;
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	/** Last completed response; an in-progress response cannot replace the retry baseline. */
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	/**
	 * Steering the server accepted on `connection` for `lastResponseId`. The
	 * next request reads the server's automatic successor or sends only the
	 * pending tool output; see {@link planSteeredRequest}.
	 */
	acceptedSteering?: { connection: CodexWebSocketConnection; steers: CodexAcceptedSteer[] };
	/** The server refused steering for this session (native turn lane); later responses are not steered. */
	steeringUnsupported?: boolean;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexTurnStateCell {
	value?: string;
}

export interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
	metadataSessions: Map<string, CodexMetadataSessionState>;
	/** `configuration_update` effort baselines, keyed by model + session. */
	effortControls: Map<string, OpenAIEffortControlState<ReasoningConfig["effort"]>>;
}

/** Request classification encoded in Codex turn metadata. */
export type OpenAICodexRequestKind = "turn" | "prewarm" | "compaction";

interface CodexMetadataSessionState {
	sessionId: string;
	threadId: string;
	windowId: string;
	turnId?: string;
	turnStartedAtUnixMs?: number;
	compactionOperationId?: string;
	reuseTurnForNextRequest?: boolean;
	turnStates: Map<string, CodexTurnStateCell>;
}

interface CodexCompatibilityIdentity {
	installationId: string;
	sessionId: string;
	/**
	 * Session the backend derives prompt-cache affinity from, sent in every
	 * session header: the parent conversation's for a side request
	 * (`parentSessionId`), else `sessionId`. Turn metadata keeps `sessionId`.
	 */
	affinitySessionId?: string;
	threadId: string;
	windowId: string;
	turnMetadataJson?: string;
}

interface CodexRequestMetadata extends CodexCompatibilityIdentity {
	turnId: string;
	turnMetadataJson: string;
	clientMetadata: Record<string, string>;
}

const CODEX_RESERVED_METADATA_KEYS: Record<string, true> = {
	installation_id: true,
	[OPENAI_HEADERS.INSTALLATION_ID]: true,
	session_id: true,
	thread_id: true,
	turn_id: true,
	window_id: true,
	[OPENAI_HEADERS.WINDOW_ID]: true,
	[OPENAI_HEADERS.TURN_METADATA]: true,
	[OPENAI_HEADERS.PARENT_THREAD_ID]: true,
	[OPENAI_HEADERS.SUBAGENT]: true,
	request_kind: true,
	compaction: true,
	turn_started_at_unix_ms: true,
	forked_from_thread_id: true,
	parent_thread_id: true,
	parent_turn_id: true,
	subagent_kind: true,
	thread_source: true,
	sandbox: true,
	workspaces: true,
};

function createCodexMetadataSessionState(sessionId: string): CodexMetadataSessionState {
	return {
		sessionId,
		threadId: crypto.randomUUID(),
		windowId: crypto.randomUUID(),
		turnStates: new Map(),
	};
}

function getOrCreateCodexMetadataSessionState(
	sessionId: string,
	providerState: CodexProviderSessionState | undefined,
): CodexMetadataSessionState {
	if (!providerState) return createCodexMetadataSessionState(sessionId);
	const existing = providerState.metadataSessions.get(sessionId);
	if (existing) return existing;
	const created = createCodexMetadataSessionState(sessionId);
	providerState.metadataSessions.set(sessionId, created);
	return created;
}

function getOrCreateCodexTurnState(
	session: CodexMetadataSessionState,
	compatibilityKey: string | undefined,
): CodexTurnStateCell {
	if (!compatibilityKey) return {};
	const existing = session.turnStates.get(compatibilityKey);
	if (existing) return existing;
	const created: CodexTurnStateCell = {};
	session.turnStates.set(compatibilityKey, created);
	return created;
}

/**
 * Drop every compatibility-scoped sticky-routing token when a fresh logical
 * turn begins, mirroring codex-rs's per-turn `OnceLock`. Standalone compaction
 * owns a throwaway cell, so it never disturbs the live turn's tokens. Runs on
 * every entry path that opens a turn — the normal stream (`createCodexRequestContext`)
 * and the raw compaction routes (`createOpenAICodexCompatibilityMetadata`).
 */
function clearCodexTurnStatesForNewTurn(
	session: CodexMetadataSessionState,
	startNewTurn: boolean,
	compaction: CodexCompactionRequestContext | undefined,
): void {
	if (startNewTurn && compaction?.phase !== "standalone_turn") session.turnStates.clear();
}

function createCodexCompatibilityIdentity(session: CodexMetadataSessionState): CodexCompatibilityIdentity {
	return {
		installationId: getInstallId(),
		sessionId: session.sessionId,
		threadId: session.threadId,
		windowId: session.windowId,
	};
}

function resolveCodexStartNewTurn(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	compaction: CodexCompactionRequestContext | undefined,
	override: boolean | undefined,
): boolean {
	if (requestKind !== "compaction") {
		if (requestKind === "turn") {
			const reuseCompactionTurn = session.reuseTurnForNextRequest === true;
			session.reuseTurnForNextRequest = false;
			session.compactionOperationId = undefined;
			if (reuseCompactionTurn) return false;
		}
		return override ?? requestKind === "turn";
	}
	if (!compaction) return override ?? false;
	const startsNewOperation = session.compactionOperationId !== compaction.operationId;
	if (startsNewOperation) session.reuseTurnForNextRequest = false;
	session.compactionOperationId = compaction.operationId;
	return override ?? (compaction.phase !== "mid_turn" && startsNewOperation);
}

function toAsciiJsonString(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(
		/[\x7f-\uffff]/g,
		char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function createCodexRequestMetadata(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	options: {
		startNewTurn: boolean;
		turnStartedAtUnixMs?: number;
		clientMetadata?: Readonly<Record<string, string>>;
		parentTurnId?: string;
		compaction?: CodexCompactionRequestContext;
		affinitySessionId?: string;
	},
): CodexRequestMetadata {
	if (options.startNewTurn || !session.turnId) {
		session.turnId = crypto.randomUUID();
		session.turnStartedAtUnixMs = options.turnStartedAtUnixMs;
	}
	const identity = createCodexCompatibilityIdentity(session);
	// codex-rs `set_parent_turn_id` ignores blank values; keep the original
	// spelling when non-blank.
	const parentTurnId = options.parentTurnId?.trim() ? options.parentTurnId : undefined;
	const extra: Record<string, string> = {};
	const callerMetadata = options.clientMetadata;
	if (callerMetadata) {
		for (const key in callerMetadata) {
			if (!CODEX_RESERVED_METADATA_KEYS[key]) extra[key] = callerMetadata[key];
		}
	}
	const turnMetadata: Record<string, unknown> = {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: session.turnId,
		window_id: identity.windowId,
		request_kind: requestKind,
	};
	if (parentTurnId) turnMetadata.parent_turn_id = parentTurnId;
	if (options.compaction) {
		turnMetadata.compaction = {
			trigger: options.compaction.trigger,
			reason: options.compaction.reason,
			implementation: options.compaction.implementation,
			phase: options.compaction.phase,
			strategy: options.compaction.strategy,
		};
	}
	if (session.turnStartedAtUnixMs !== undefined) {
		turnMetadata.turn_started_at_unix_ms = session.turnStartedAtUnixMs;
	}
	for (const key in extra) turnMetadata[key] = extra[key];
	const turnMetadataJson = toAsciiJsonString(turnMetadata);
	const clientMetadata: Record<string, string> = {
		[OPENAI_HEADERS.INSTALLATION_ID]: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		[OPENAI_HEADERS.WINDOW_ID]: identity.windowId,
		turn_id: session.turnId,
	};
	// Both projections, mirroring codex-rs `CodexResponsesMetadata::to_client_metadata`:
	// the flat key above/below AND the field inside the turn-metadata JSON.
	if (parentTurnId) clientMetadata.parent_turn_id = parentTurnId;
	clientMetadata[OPENAI_HEADERS.TURN_METADATA] = turnMetadataJson;
	return {
		...identity,
		affinitySessionId: options.affinitySessionId,
		turnId: session.turnId,
		turnMetadataJson,
		clientMetadata,
	};
}

function applyCodexCompatibilityHeaders(headers: Headers, metadata: CodexCompatibilityIdentity): void {
	headers.set(OPENAI_HEADERS.SCOPED_SESSION_ID, metadata.affinitySessionId ?? metadata.sessionId);
	headers.set(OPENAI_HEADERS.THREAD_ID, metadata.threadId);
	headers.set(OPENAI_HEADERS.WINDOW_ID, metadata.windowId);
	if (metadata.turnMetadataJson) {
		headers.set(OPENAI_HEADERS.TURN_METADATA, metadata.turnMetadataJson);
	} else {
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
}

/**
 * Synthesize Codex request identity for raw provider routes such as remote
 * compaction while reusing the live session's thread, window, and turn.
 */
export function createOpenAICodexCompatibilityMetadata(
	options: OpenAICodexCompatibilityMetadataOptions,
): OpenAICodexCompatibilityMetadata {
	const providerState = getCodexProviderSessionState(options.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId) ?? crypto.randomUUID();
	const session = getOrCreateCodexMetadataSessionState(sessionId, providerState);
	const startNewTurn = resolveCodexStartNewTurn(
		session,
		options.requestKind,
		options.compaction,
		options.startNewTurn,
	);
	clearCodexTurnStatesForNewTurn(session, startNewTurn, options.compaction);
	const metadata = createCodexRequestMetadata(session, options.requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: options.turnStartedAtUnixMs ?? (startNewTurn || !session.turnId ? Date.now() : undefined),
		clientMetadata: options.clientMetadata,
		parentTurnId: options.parentTurnId,
		compaction: options.compaction,
	});
	const headers = new Headers();
	applyCodexCompatibilityHeaders(headers, metadata);
	if (options.includeInstallationHeader) {
		headers.set(OPENAI_HEADERS.INSTALLATION_ID, metadata.installationId);
	}
	return {
		clientMetadata: { ...metadata.clientMetadata },
		headers: Object.fromEntries(headers.entries()),
	};
}

interface CodexRequestContext {
	apiKey: string;
	accountId?: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	codexClientVersion: string;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	isolatedTransportState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	turnState: CodexTurnStateCell;
	responsesLite: boolean;
	requestMetadata?: CodexRequestMetadata;
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
	nativeOutputItem?: Record<string, unknown>;
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
	nativeOutputEntries: CodexOpenItem[] = [];
	/** Sequential-cutoff summary sections/emitted text, global to the response (indices span reasoning items). */
	cutoffSummaries: SequentialCutoffSummaryState = createSequentialCutoffSummaryState();
	/** Summary deltas buffered while waiting to see whether atomic `.done` events arrive. */
	pendingSummaryDeltas = new Map<CodexOpenItem, string[]>();
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
		this.nativeOutputEntries.length = 0;
		this.pendingSummaryDeltas.clear();
		this.cutoffSummaries = createSequentialCutoffSummaryState();
	}

	finalizeNativeOutputItems(): Array<Record<string, unknown>> {
		if (this.nativeOutputEntries.length === 0) return this.nativeOutputItems;
		const ordered: Array<Record<string, unknown>> = [];
		for (const entry of this.nativeOutputEntries) {
			if (entry.nativeOutputItem) ordered.push(entry.nativeOutputItem);
		}
		ordered.push(...this.nativeOutputItems);
		this.nativeOutputEntries.length = 0;
		this.nativeOutputItems = ordered;
		return ordered;
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
	queueSummaryDelta(entry: CodexOpenItem | null | undefined, delta: string): void {
		if (entry?.block?.type !== "thinking" || delta.length === 0) return;
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		pending.push(delta);
		this.pendingSummaryDeltas.set(entry, pending);
	}

	takeSummaryDeltas(entry: CodexOpenItem | null | undefined): string[] {
		if (!entry) return [];
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		this.pendingSummaryDeltas.delete(entry);
		return pending;
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
	runtime?: CodexStreamRuntime;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
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

function updateCodexSessionMetadataFromHeaders(
	turnState: CodexTurnStateCell | undefined,
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if ((!turnState && !state) || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const responseTurnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.value === undefined && responseTurnState && responseTurnState.length > 0) {
		turnState.value = responseTurnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (state && modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
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
		if (offeredTool.native?.type === "computer" && model?.supportsComputerUse === true) {
			return { type: "computer" };
		}
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "computer") {
		const computer = tools.find(tool => tool.native?.type === "computer");
		if (!computer) return undefined;
		return model?.supportsComputerUse === true ? { type: "computer" } : { type: "function", name: computer.name };
	}
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
function unrollCodexComputerItems(items: ResponseInput, supportsImageDetailOriginal: boolean): ResponseInput {
	const replayItems = stripOpenAIResponsesComputerLinkedReasoningIdsForReplay(items);
	const unrolled: ResponseInput = [];
	for (const item of replayItems) {
		if (item.type === "computer_call") {
			const actions = item.actions ?? (item.action ? [item.action] : []);
			unrolled.push({
				type: "function_call",
				call_id: item.call_id,
				name: "computer",
				arguments: JSON.stringify({ actions }),
				status: item.status,
			});
			continue;
		}
		if (item.type === "computer_call_output") {
			const image =
				typeof item.output.image_url === "string" && item.output.image_url.length > 0
					? ({
							type: "input_image",
							detail: supportsImageDetailOriginal ? "original" : "auto",
							image_url: item.output.image_url,
						} satisfies ResponseInputContent)
					: typeof item.output.file_id === "string" && item.output.file_id.length > 0
						? ({
								type: "input_image",
								detail: supportsImageDetailOriginal ? "original" : "auto",
								file_id: item.output.file_id,
							} satisfies ResponseInputContent)
						: undefined;
			unrolled.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: image ? "(see attached image)" : "",
			});
			if (image) {
				unrolled.push({
					role: "user",
					content: [{ type: "input_text", text: "Attached image from computer tool result:" }, image],
				});
			}
			continue;
		}
		unrolled.push(item);
	}
	return unrolled;
}

function unrollCodexComputerAssistantMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "toolCall" || block.providerMetadata?.type !== "computer") return block;
		changed = true;
		const call: ToolCall = {
			...block,
			arguments: { actions: structuredCloneJSON(block.providerMetadata.actions) },
		};
		delete call.providerMetadata;
		return call;
	});
	return changed ? { ...message, content } : message;
}

function unrollCodexComputerToolResult(message: ToolResultMessage): ToolResultMessage {
	if (message.providerMetadata?.type !== "computer") return message;
	const result: ToolResultMessage = { ...message };
	delete result.providerMetadata;
	return result;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "serviceTierCost">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	// The subscription route draws on included plan usage, so its cost is the
	// usage-equivalent: each tier's multiplier comes from the catalog table, which
	// uses OpenAI's included-usage rates (Astra: Fast 2.5x, Ultrafast 8x). A tier
	// with no entry stays at 1x rather than an invented multiplier.
	if (serviceTier !== "flex" && serviceTier !== "priority" && serviceTier !== "ultrafast") return 1;
	return model.serviceTierCost?.[serviceTier] ?? 1;
}

/**
 * The tier a Codex turn was served at. The Codex backend echoes
 * `service_tier: "default"` on turns it serves at the sent tier (a `priority`
 * turn decodes at Fast speed yet reports `default`), so a `default` or `auto`
 * echo carries no information and, like an absent one, resolves to the sent
 * tier, or `default` when none was sent. Any other echo (`flex`, `priority`,
 * `ultrafast`, `scale`) is authoritative. The tier's identity is preserved even
 * when it has no pricing entry (`scale`), because the recorded tier also drives
 * premium-request and speed accounting. The echo cannot reveal a genuine
 * downgrade, so a downgraded turn is recorded at the sent tier.
 */
function resolveCodexCostServiceTier(res: ServiceTier | undefined, req?: unknown): ServiceTier {
	if (res !== undefined && res !== "default" && res !== "auto") return res;
	return parseServiceTier(req) ?? "default";
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "provider" | "api" | "identity" | "serviceTierCost">,
	usage: AssistantMessage["usage"],
	resTier: ServiceTier | undefined,
	reqTier: unknown,
): ServiceTier {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier) ?? "default";
	usage.premiumRequests ??= getPremiumServiceTierRequests(resolvedTier, model, { served: true });
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return resolvedTier;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return resolvedTier;
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
			isProgressItem: isResponsesWebSocketProgressEvent,
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

function createCodexRequestContext(
	model: Model<"openai-codex-responses">,
	transformedBody: RequestBody,
	options: OpenAICodexResponsesOptions | undefined,
	contextOptions: {
		isolateCompactionTransport: boolean;
		startNewTurn?: boolean;
		turnStartedAtUnixMs?: number;
	},
): CodexRequestContext {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const accountId = getCodexAccountId(apiKey);
	applyCodexAccessPrograms(transformedBody, model, accountId, options?.codexAccessPrograms);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);

	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const requestHeaders = { ...model.headers, ...options?.headers };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const isolatedTransportState =
		contextOptions.isolateCompactionTransport && options?.codexCompaction
			? createCodexProviderSessionState()
			: undefined;
	const transportProviderSessionState = isolatedTransportState ?? providerSessionState;
	const responsesLite = resolveCodexResponsesLite(options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (sessionKey && publicSessionKey) {
		transportProviderSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const sharedWebsocketState =
		sessionKey && transportSessionId && providerSessionState
			? isolatedTransportState
				? providerSessionState.webSocketSessions.get(sessionKey)
				: getCodexWebSocketSessionState(sessionKey, transportSessionId, providerSessionState)
			: undefined;
	const websocketState =
		sessionKey && transportSessionId && isolatedTransportState
			? getCodexWebSocketSessionState(sessionKey, transportSessionId, isolatedTransportState)
			: sharedWebsocketState;
	if (isolatedTransportState && websocketState && sharedWebsocketState) {
		websocketState.disableWebsocket = sharedWebsocketState.disableWebsocket;
		websocketState.modelsEtag = sharedWebsocketState.modelsEtag;
	}
	const metadataSessionId = transportSessionId ?? crypto.randomUUID();
	const metadataSession = getOrCreateCodexMetadataSessionState(metadataSessionId, providerSessionState);
	const compaction = options?.codexCompaction;
	const requestKind: OpenAICodexRequestKind = compaction ? "compaction" : "turn";
	const startNewTurn = resolveCodexStartNewTurn(metadataSession, requestKind, compaction, contextOptions.startNewTurn);
	const standaloneCompaction = compaction?.phase === "standalone_turn";
	clearCodexTurnStatesForNewTurn(metadataSession, startNewTurn, compaction);
	// Standalone compaction owns a throwaway turn. Every live cell is isolated by
	// the same credential/backend/model/Lite key as its transport session.
	const turnState = standaloneCompaction ? {} : getOrCreateCodexTurnState(metadataSession, sessionKey);
	const requestMetadata = createCodexRequestMetadata(metadataSession, requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: compaction
			? startNewTurn || !metadataSession.turnId
				? Date.now()
				: undefined
			: contextOptions.turnStartedAtUnixMs,
		clientMetadata: transformedBody.client_metadata,
		parentTurnId: options?.parentTurnId,
		compaction,
		affinitySessionId: normalizeOpenAIPromptCacheKey(options?.parentSessionId),
	});
	transformedBody.client_metadata = requestMetadata.clientMetadata;
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		isolatedTransportState,
		websocketState,
		turnState,
		responsesLite,
		requestMetadata,
		codexClientVersion,
		transformedBody,
		rawRequestDump,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<CodexRequestContext> {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);
	return createCodexRequestContext(model, transformedBody, options, {
		isolateCompactionTransport: true,
		startNewTurn: options?.codexCompaction ? undefined : !isCodexWithinTurnContinuation(context),
		turnStartedAtUnixMs: options?.codexCompaction ? undefined : getCodexTurnStartedAtUnixMs(context),
	});
}

/**
 * Codex reasoning controls for the caller's request. `forceReasoningOff` always
 * sends the `none` tier. `disableReasoning` follows the catalog disable mode:
 * `none` where the model accepts it, else the lowest supported effort —
 * omitting effort would let the backend apply its default tier instead.
 */
function codexReasoningControls(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
): Pick<CodexRequestOptions, "reasoningEffort" | "reasoningOff"> {
	if (options?.forceReasoningOff) return { reasoningOff: true };
	if (!options?.disableReasoning) return { reasoningEffort: options?.reasoning };
	if (model.reasoning && model.compat.reasoningDisableMode === "none-effort") return { reasoningOff: true };
	return { reasoningEffort: getSupportedEfforts(model)[0] };
}

/** Serialize normal Codex turns and V2 compaction with the same cacheable prefix. */
export async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = getOpenAIPromptCacheKey(options),
	inputPrefix?: InputItem[],
): Promise<RequestBody> {
	const input = convertMessages(model, context);
	const params: RequestBody = {
		model: model.requestModelId ?? model.id,
		input: inputPrefix?.length ? [...inputPrefix, ...input] : input,
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
	applyOpenAIServiceTier(params, options?.serviceTier, model);
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
		...codexReasoningControls(model, options),
		reasoningSummary: options?.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	const body = await transformRequestBody(params, model, codexOptions, { developerMessages });
	applyCodexStableEffort(model, body, options);
	return body;
}

/**
 * Keep the request-level effort byte-stable across a conversation and carry
 * later changes as `configuration_update` items (GPT-6 family). Requires a
 * session id and provider session state to remember the baseline; without
 * them every request stands alone and sends its own effort.
 */
function applyCodexStableEffort(
	model: Model<"openai-codex-responses">,
	body: RequestBody,
	options: OpenAICodexResponsesOptions | undefined,
): void {
	if (!model.compat.supportsConfigurationUpdate || options?.codexCompaction) return;
	const effort = body.reasoning?.effort;
	if (effort === undefined || effort === "none" || !body.input) return;
	const providerState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	if (!providerState || !sessionId) return;
	const state = resolveOpenAIEffortControlState(
		providerState.effortControls,
		id => `${model.id}\u0000${id}`,
		sessionId,
		normalizeOpenAIPromptCacheKey(options?.parentSessionId),
	);
	const lowest = options?.minimizeEffort ? lowestCodexWireEffort(model) : undefined;
	body.reasoning = {
		...body.reasoning,
		effort: planStableOpenAIEffort(state, body.input, effort, lowest === "none" ? undefined : lowest),
	};
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
				// Another request owns the shared socket: send this one over SSE and
				// leave the socket and session state to that request.
				if (error instanceof CodexWebSocketBusyError) break;
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
	} else if (websocketState) {
		releaseIdleCodexWebSocket(websocketState);
	}
	try {
		return await openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
	} catch (error) {
		if (!dropRejectedCodexAccessPrograms(transformedBody, model, requestContext.accountId, error)) throw error;
		return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
	}
}

function toCodexRequestBody(body: OpenAICodexCompactionBody): RequestBody {
	const request: RequestBody = { model: body.model };
	for (const key in body) {
		if (key !== "model") request[key] = body[key];
	}
	return request;
}

/**
 * Open a provider-native V2 compaction stream through Codex's WebSocket-first
 * transport, replaying WebSocket transport failures over SSE.
 */
export async function openCodexCompactionEventStream(
	model: Model<"openai-codex-responses">,
	body: OpenAICodexCompactionBody,
	options: OpenAICodexCompactionStreamOptions,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const requestSetup = createRequestSetup(options);
	let requestContext: CodexRequestContext;
	let initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	};
	try {
		requestContext = createCodexRequestContext(model, toCodexRequestBody(body), options, {
			isolateCompactionTransport: false,
		});
		initial = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
	} catch (error) {
		requestSetup.requestAbortController.abort();
		throw error;
	}

	if (requestContext.websocketState) {
		requestContext.websocketState.lastTransport = initial.transport;
		// The compaction request may use the existing append baseline, but the
		// replacement history makes that baseline stale for the next normal turn.
		resetCodexWebSocketAppendState(requestContext.websocketState);
	}
	return streamCodexCompactionEvents(model, options, requestSetup, requestContext, initial);
}

async function* streamCodexCompactionEvents(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexCompactionStreamOptions,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
	initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	},
): AsyncGenerator<Record<string, unknown>> {
	let completed = false;
	const websocketState = requestContext.websocketState;
	const previousTurnState = requestContext.turnState.value;
	const previousModelsEtag = websocketState?.modelsEtag;
	try {
		if (initial.transport === "websocket") {
			// Do not expose a WebSocket attempt until it finishes: an SSE replay
			// must replace, not extend, any partial compaction output.
			const bufferedEvents: Array<Record<string, unknown>> = [];
			try {
				for await (const event of initial.eventStream) bufferedEvents.push(event);
			} catch (error) {
				if (options.signal?.aborted || !(error instanceof CodexWebSocketTransportError)) {
					throw error;
				}
				const state = requestContext.websocketState;
				if (state && !(error instanceof CodexWebSocketBusyError)) recordCodexWebSocketFailure(state, true);
				const fallback = await openCodexSseTransport(model, requestContext, requestSetup, options, state);
				if (state) state.lastTransport = fallback.transport;
				yield* drainCodexCompactionEvents(fallback.eventStream, requestContext);
				completed = true;
				return;
			}
			const failure = bufferedEvents.findLast(event => event.type === "error" || event.type === "response.failed");
			if (
				failure !== undefined &&
				dropRejectedCodexAccessPrograms(
					requestContext.transformedBody,
					model,
					requestContext.accountId,
					createCodexProviderStreamError(failure),
				)
			) {
				const replay = await openCodexSseTransport(model, requestContext, requestSetup, options, websocketState);
				if (websocketState) websocketState.lastTransport = replay.transport;
				yield* drainCodexCompactionEvents(replay.eventStream, requestContext);
				completed = true;
				return;
			}
			// Apply metadata only once the WebSocket attempt succeeded: a discarded
			// attempt must not leak its `x-codex-turn-state` into the session.
			for (const event of bufferedEvents) {
				applyCodexCompactionResponseMetadata(requestContext, event);
				yield event;
			}
		} else {
			yield* drainCodexCompactionEvents(initial.eventStream, requestContext);
		}
		completed = true;
	} finally {
		if (!completed) {
			requestSetup.requestAbortController.abort();
			requestContext.turnState.value = previousTurnState;
			if (websocketState) websocketState.modelsEtag = previousModelsEtag;
		}
	}
}

/**
 * Capture `x-codex-turn-state`/`x-models-etag` response metadata after a
 * compaction attempt succeeds.
 */
function applyCodexCompactionResponseMetadata(
	requestContext: CodexRequestContext,
	event: Record<string, unknown>,
): void {
	if (event.type !== "response.metadata") return;
	updateCodexSessionMetadataFromHeaders(
		requestContext.turnState,
		requestContext.websocketState,
		toWebSocketHeaders(event.headers),
	);
}

async function* drainCodexCompactionEvents(
	events: AsyncGenerator<Record<string, unknown>>,
	requestContext: CodexRequestContext,
): AsyncGenerator<Record<string, unknown>> {
	for await (const event of events) {
		applyCodexCompactionResponseMetadata(requestContext, event);
		yield event;
	}
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
	let canAppendBeforeRequest = websocketState.canAppend === true;
	let chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.codexClientVersion,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.turnState,
		requestContext.responsesLite,
		requestContext.requestMetadata,
		await getCodexAttestationHeader(requestContext.accountId),
		requestContext.transformedBody,
	);
	// One socket carries one request at a time. While another request on this
	// session streams over it, reusing, replacing, or closing it would cut that
	// request off, so this one goes over SSE instead.
	if (websocketState.connection?.hasActiveRequest()) {
		throw new CodexWebSocketBusyError("websocket request already in progress");
	}
	// Accepted steering belongs to whichever request ends up owning the socket,
	// so it is only consumed once this request takes it (see `onOwned` below).
	const steered = websocketState.acceptedSteering;
	const onOwned = () => {
		if (websocketState.acceptedSteering === steered) websocketState.acceptedSteering = undefined;
	};
	let websocketConnection = await getOrCreateCodexWebSocketConnection(
		websocketState,
		requestContext.turnState,
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		model.provider,
		requestSetup.requestSignal,
	);
	let releaseReservation = websocketConnection.reserveForRequest();
	try {
		// Reconnecting (closed socket, idle eviction, token refresh, or routing-hint
		// change) resets `canAppend`; discard any delta built against the old socket.
		if (!websocketState.canAppend) {
			canAppendBeforeRequest = false;
			chainedBody = requestContext.transformedBody;
		}
		// Input the server already holds for a chained request (everything before
		// the delta); a hook that drops `previous_response_id` must resend it.
		const fullInput = requestContext.transformedBody.input ?? [];
		let chainCarriedInput: InputItem[] = chainedBody.previous_response_id
			? fullInput.slice(0, fullInput.length - (chainedBody.input?.length ?? 0))
			: [];
		const timeouts: CodexWebSocketRequestTimeouts = {
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		};
		// Steering accepted for the previous response lives only on the socket that
		// accepted it; a replaced socket lost it, so the input is plain history.
		const steers = steered?.connection === websocketConnection ? steered.steers : [];
		const liveSteers = steers.filter(steer => !websocketConnection.hasFailedSteer([steer.id]));
		if (liveSteers.length > 0) {
			const plan = planSteeredRequest(
				chainedBody.previous_response_id ? chainedBody.input : undefined,
				liveSteers.flatMap(steer => steer.items),
			);
			if (plan.kind === "attach") {
				recordCodexTurnRequestDiagnostics(websocketState, chainedBody, "websocket", canAppendBeforeRequest);
				requestContext.rawRequestDump.body = chainedBody;
				return {
					eventStream: websocketConnection.streamRequest(
						{ attachSteerIds: liveSteers.map(steer => steer.id) },
						timeouts,
						requestSetup.requestSignal,
						onSseEvent,
						onOwned,
						releaseReservation,
					),
					requestBodyForState: cloneJsonTree(requestContext.transformedBody),
					transport: "websocket",
				};
			}
			if (plan.kind === "create") {
				// The server prepends the accepted steering itself; it is carried too.
				const delta = chainedBody.input ?? [];
				chainCarriedInput = [...chainCarriedInput, ...delta.filter(item => !plan.input.includes(item))];
				chainedBody = { ...chainedBody, input: plan.input };
			} else {
				// The server continues from input this request cannot line up with; a
				// fresh socket drops its queue and the full transcript carries the input.
				releaseReservation();
				websocketConnection.close("steering-discard");
				websocketState.connection = undefined;
				resetCodexWebSocketAppendState(websocketState);
				canAppendBeforeRequest = false;
				chainedBody = requestContext.transformedBody;
				websocketConnection = await getOrCreateCodexWebSocketConnection(
					websocketState,
					requestContext.turnState,
					toWebSocketUrl(requestContext.url),
					websocketHeaders,
					model.provider,
					requestSetup.requestSignal,
				);
				releaseReservation = websocketConnection.reserveForRequest();
			}
		}
		// WebSocket frames cannot carry per-request HTTP headers. Canonical Codex
		// request identity is already in `client_metadata`; connection-scoped
		// compatibility values that can change after the upgrade ride alongside it
		// on every `response.create`.
		const websocketClientMetadata = { ...chainedBody.client_metadata };
		if (requestContext.responsesLite) {
			websocketClientMetadata[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY] = "true";
		}
		if (requestContext.turnState.value) {
			websocketClientMetadata[X_CODEX_TURN_STATE_HEADER] = requestContext.turnState.value;
		}
		let websocketRequest: RequestBody = {
			type: "response.create",
			...chainedBody,
			client_metadata: websocketClientMetadata,
		};
		const replacementWebsocketRequest = await options?.onPayload?.(websocketRequest, model);
		if (replacementWebsocketRequest !== undefined) {
			websocketRequest = replacementWebsocketRequest as RequestBody;
		}
		// The hook dropped the chain: the server no longer holds the chained
		// prefix, so the frame must carry it. An untouched delta becomes the full
		// transcript; a rewritten one keeps the hook's edits after that prefix.
		if (chainedBody.previous_response_id && !websocketRequest.previous_response_id) {
			websocketRequest.input = Bun.deepEquals(websocketRequest.input, chainedBody.input)
				? requestContext.transformedBody.input
				: [...chainCarriedInput, ...(websocketRequest.input ?? [])];
		}
		recordCodexTurnRequestDiagnostics(websocketState, websocketRequest, "websocket", canAppendBeforeRequest);
		const requestBodyForState = cloneJsonTree(requestContext.transformedBody);
		// `onPayload` may rewrite the outgoing frame (e.g. drop `stream_options` or
		// change `service_tier`); recorded state must reflect what was actually
		// sent — the sequential-cutoff summary decoder and the served-tier
		// fallback key off it.
		if (websocketRequest.stream_options === undefined) {
			delete requestBodyForState.stream_options;
		} else {
			requestBodyForState.stream_options = websocketRequest.stream_options;
		}
		if (websocketRequest.service_tier === undefined) {
			delete requestBodyForState.service_tier;
		} else {
			requestBodyForState.service_tier = websocketRequest.service_tier;
		}
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
		const eventStream = websocketConnection.streamRequest(
			{ send: websocketRequest },
			timeouts,
			requestSetup.requestSignal,
			onSseEvent,
			onOwned,
			releaseReservation,
		);
		return {
			eventStream,
			requestBodyForState,
			transport: "websocket",
		};
	} catch (error) {
		releaseReservation();
		throw error;
	}
}

function getCodexTurnStartedAtUnixMs(context: Context): number {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role === "user" && Number.isFinite(message.timestamp)) {
			return Math.trunc(message.timestamp);
		}
	}
	return Date.now();
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
				requestContext.turnState,
				requestContext.responsesLite,
				requestContext.codexClientVersion,
				requestContext.requestMetadata,
				requestSetup.requestSignal,
				requestSetup.firstEventTimeoutMs,
				options?.codexSseMaxAttempts,
				event => options?.onSseEvent?.(event, model),
				wrapFetchForRequestCompression(options?.fetch ?? fetch, model),
			),
		);
	};
	const canAppendBeforeRequest = state?.canAppend === true;
	let wireBody = body;
	const replacementWireBody = await options?.onPayload?.(wireBody, model);
	if (replacementWireBody !== undefined) {
		wireBody = replacementWireBody as RequestBody;
	}
	recordCodexTurnRequestDiagnostics(state, wireBody, "sse", canAppendBeforeRequest);
	// SSE turns never chain, so later reads need only the per-turn knobs (summary
	// delivery, service tier); copying the whole transcript would be wasted work.
	const requestBodyForState: RequestBody = {
		model: wireBody.model,
		stream_options: wireBody.stream_options ? { ...wireBody.stream_options } : undefined,
		service_tier: wireBody.service_tier,
	};
	return { eventStream: await open(wireBody), requestBodyForState, transport: "sse" };
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
	if (item.type === "computer_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: "computer",
			arguments: {},
			providerMetadata: computerCallMetadata(item),
			[kStreamingPartialJson]: "",
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

const CODEX_APPEND_PRESERVING_REJECTION_CODES: Record<string, true> = {
	rate_limit_exceeded: true,
	slow_down: true,
};

function isCodexStalePreviousResponseError(error: unknown): boolean {
	if (isOpenAIResponsesStalePreviousResponseError(error)) return true;
	// Some Codex proxies report their own code for an expired response anchor.
	return error instanceof Error && "code" in error && error.code === "codex_previous_response_stale";
}

function shouldPreserveCodexWebSocketAppendState(context: CodexStreamFailureContext, error: unknown): boolean {
	if (!(error instanceof CodexProviderStreamError) || !error.code) return false;
	const state = context.requestContext.websocketState;
	return (
		Object.hasOwn(CODEX_APPEND_PRESERVING_REJECTION_CODES, error.code.toLowerCase()) &&
		context.runtime?.transport === "websocket" &&
		state?.canAppend === true &&
		state.lastRequest !== undefined &&
		state.lastResponseId !== undefined &&
		state.lastResponseItems !== undefined
	);
}

async function handleCodexStreamFailure(context: CodexStreamFailureContext, error: unknown): Promise<AssistantMessage> {
	const { output } = context;
	if (context.requestContext.websocketState && !shouldPreserveCodexWebSocketAppendState(context, error)) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		context.requestContext.websocketState.modelsEtag = undefined;
	}
	const result = await AIError.finalize(error, {
		api: context.model.api,
		provider: context.model.provider,
		model: context.model.id,
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
	/** Submits caller steering to the response currently streaming. */
	#steerPump?: CodexSteerPump;
	/** Socket {@link #steerPump} submits through. */
	#steerConnection?: CodexWebSocketConnection;
	/** A replaced attempt accepted steering its socket may still act on. */
	#steerTainted = false;

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

	/**
	 * Whether the request actually sent (post-`onPayload`) opted into
	 * sequential-cutoff summary delivery. Atomic `.done` events are preferred;
	 * incremental deltas remain buffered as a compatibility fallback when a
	 * transport emits them instead.
	 */
	get #sequentialCutoffSummaries(): boolean {
		return this.runtime.requestBodyForState.stream_options?.reasoning_summary_delivery === "sequential_cutoff";
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
				if (!this.runtime.sawTerminalEvent) {
					CODEX_DEBUG &&
						logger.debug("[codex] codex stream ended unexpectedly", {
							transport: this.runtime.transport,
							terminalEventSeen: false,
							unexpectedStreamEnd: true,
							sentTurnStateHeader: Boolean(this.requestContext.turnState.value),
							sentModelsEtagHeader: Boolean(this.requestContext.websocketState?.modelsEtag),
						});
					throw new CodexProviderStreamError("Codex stream ended before terminal completion event", true);
				}
				await this.#settleSteering(true);
				return { firstTokenTime };
			} catch (error) {
				// The failed attempt's response no longer takes input; a retry
				// steers its own response.
				const steered = await this.#retireSteering();
				this.#stopSteeringOnNativeLaneRejection(error, steered);
				const recovered = await this.#recoverStreamError(error);
				if (!recovered) {
					await this.#settleSteering(false);
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

		if (eventType === "response.created") {
			this.#startSteering(rawEvent);
			return firstTokenTime;
		}

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
			this.runtime.nativeOutputEntries.push(entry);
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
			if (this.#sequentialCutoffSummaries) return firstTokenTime;
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "reasoning") {
				appendReasoningSummaryPart(
					entry.item,
					(rawEvent as { part: ResponseReasoningItem["summary"][number] }).part,
				);
			}
			return firstTokenTime;
		}
		if (eventType === "response.reasoning_summary_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (this.#sequentialCutoffSummaries) {
				// Some Codex transports still emit incremental summary deltas even
				// after opting into sequential-cutoff delivery. Buffer them until
				// output_item.done so atomic `.done` events can supersede them
				// without duplicate UI output.
				this.runtime.queueSummaryDelta(entry, delta);
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryTextDelta(entry.item, entry.block, delta, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_text.done") {
			// Outside the cutoff contract the text already streamed via `.delta`.
			if (!this.#sequentialCutoffSummaries) return firstTokenTime;
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				this.runtime.takeSummaryDeltas(entry);
				if (!firstTokenTime) firstTokenTime = performance.now();
				const summaryIndex =
					typeof rawEvent.summary_index === "number" && Number.isFinite(rawEvent.summary_index)
						? Math.trunc(rawEvent.summary_index)
						: 0;
				applyReasoningSummaryDone(
					this.runtime.cutoffSummaries,
					entry.block,
					typeof rawEvent.text === "string" ? rawEvent.text : "",
					summaryIndex,
					stream,
					output,
					entry.contentIndex,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				entry.block.thinking += delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: entry.contentIndex,
					delta,
					partial: output,
				});
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.done") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (this.#sequentialCutoffSummaries) {
				if (entry && this.runtime.pendingSummaryDeltas.has(entry)) this.runtime.queueSummaryDelta(entry, "\n\n");
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.content_part.added") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "message") {
				appendMessageContentPart(
					entry.item,
					(rawEvent as { part?: ResponseOutputMessage["content"][number] }).part,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "message" && entry.block?.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					(rawEvent as { delta?: string }).delta || "",
					stream,
					output,
					entry.contentIndex,
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

		if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
			this.#handleResponseCompleted(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.metadata") {
			// The WebSocket transport has no per-response HTTP headers; codex-rs
			// mirrors them into this event's `headers` and reads
			// `x-codex-turn-state` from there (ResponsesStreamEvent::turn_state).
			// Capture only the first non-empty value so same-turn follow-ups keep
			// the server's original sticky-routing token on either transport.
			updateCodexSessionMetadataFromHeaders(
				this.requestContext.turnState,
				this.requestContext.websocketState,
				toWebSocketHeaders(rawEvent.headers),
			);
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

	/** The server-side turn lane this request runs on: what the endpoint sees, not the local model entry. */
	get #steeringLaneKey(): string {
		const { url, transformedBody, accountId, apiKey, responsesLite } = this.requestContext;
		return JSON.stringify([url, transformedBody.model, getCodexCredentialKey(accountId, apiKey), responsesLite]);
	}

	/** Start delivering caller steering into the response `response.created` announced. */
	#startSteering(rawEvent: Record<string, unknown>): void {
		const source = this.options?.liveSteering;
		const state = this.runtime.websocketState;
		const connection = state?.connection;
		const responseId = asRecord(rawEvent.response)?.id;
		if (
			!source ||
			!connection ||
			state?.steeringUnsupported ||
			this.#steerPump ||
			typeof responseId !== "string" ||
			this.runtime.transport !== "websocket" ||
			!this.model.compat.supportsSteering ||
			unsupportedSteeringLanes.has(this.#steeringLaneKey)
		) {
			return;
		}
		this.#steerConnection = connection;
		this.#steerPump = new CodexSteerPump(source, connection, messages =>
			toSteerInputItems(convertMessages(this.model, { messages: [...messages] })),
		);
		this.#steerPump.start(responseId);
	}

	/** Stop steering an attempt that is being replaced; anything it delivered taints its socket. */
	async #retireSteering(): Promise<boolean> {
		const pump = this.#steerPump;
		if (!pump) return false;
		this.#steerPump = undefined;
		const outcome = await pump.finish();
		if (outcome.accepted.length > 0 || outcome.uncertain) this.#steerTainted = true;
		return outcome.submitted;
	}

	/**
	 * Settle steering once the stream is over. Steering accepted for the final
	 * response is handed to the next request; anything the session cannot line
	 * up with the server's queue drops the socket so no stray successor streams
	 * into a later request.
	 */
	async #settleSteering(completed: boolean): Promise<void> {
		const pump = this.#steerPump;
		this.#steerPump = undefined;
		const outcome = pump ? await pump.finish() : undefined;
		const accepted = outcome?.accepted ?? [];
		const tainted = this.#steerTainted || outcome?.uncertain === true;
		const state = this.runtime.websocketState;
		const connection = this.#steerConnection;
		if (!state || !connection || (accepted.length === 0 && !tainted)) return;
		if (
			completed &&
			!tainted &&
			state.canAppend &&
			state.connection === connection &&
			state.lastResponseId === outcome?.responseId
		) {
			state.acceptedSteering = { connection, steers: accepted };
			return;
		}
		connection.close("steering-discard");
		if (state.connection === connection) state.connection = undefined;
		resetCodexWebSocketAppendState(state);
	}

	#flushSummaryDeltas(entry: CodexOpenItem | null): void {
		if (entry?.block?.type !== "thinking") return;
		for (const delta of this.runtime.takeSummaryDeltas(entry)) {
			entry.block.thinking += delta;
			entry.block.summary = true;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: entry.contentIndex,
				delta,
				partial: this.output,
			});
		}
	}
	#handleOutputItemDone(rawEvent: Record<string, unknown>): void {
		const { runtime, output, stream } = this;
		const rawItem = rawEvent.item;
		if (!rawItem || typeof rawItem !== "object") return;
		const item = cloneJsonTree(rawItem) as CodexEventItem;
		if (item.type === "image_generation_call" && item.result) item.status = "completed";

		// Match the finalization to the OPEN ITEM that started this block, not the
		// singleton current — interleaved items can finish out of order, so the
		// most-recently-added block may belong to a sibling (#2619). Some Codex
		// function/custom tool items omit `id`; in that case `output_index` still
		// routes `output_item.done` to the block that received `output_item.added`.
		const itemId = "id" in item && typeof item.id === "string" ? item.id : "";
		const entry = (itemId ? runtime.openItems.get(itemId) : null) ?? runtime.openItemForEvent(rawEvent);
		const nativeOutputItem = item as unknown as Record<string, unknown>;
		if (entry) entry.nativeOutputItem = nativeOutputItem;
		else runtime.nativeOutputItems.push(nativeOutputItem);
		const block = entry?.block ?? null;
		const contentIndex = entry?.contentIndex ?? output.content.length - 1;

		if (item.type === "image_generation_call" && item.result) {
			appendResponsesImageResult(output, stream, item.result);
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "reasoning" && block?.type === "thinking") {
			this.#flushSummaryDeltas(entry);
			block.thinking = finalizeReasoningThinking(
				item,
				block.thinking,
				this.#sequentialCutoffSummaries ? this.runtime.cutoffSummaries : undefined,
			);
			block.thinkingSignature = JSON.stringify(item);
			settleReasoningSummary(item, block);
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
			block.text = finalizeMessageText(item, block.text);
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
			const partial = block?.type === "toolCall" ? block[kStreamingPartialJson] : undefined;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				// An empty terminal item falls back to what `.delta`/`.done` already delivered.
				arguments: item.arguments
					? parseToolCallArguments(item.arguments)
					: block?.type === "toolCall" && !partial
						? block.arguments
						: parseToolCallArguments(partial),
			};
			item.arguments = replayableToolCallArguments(item.arguments, toolCall.arguments);
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

		if (item.type === "computer_call") {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: "computer",
				arguments: {},
				providerMetadata: computerCallMetadata(item),
			};
			let resolvedContentIndex = contentIndex;
			if (block?.type === "toolCall") {
				block.id = toolCall.id;
				block.providerMetadata = toolCall.providerMetadata;
				clearStreamingPartialJson(block);
			} else {
				output.content.push(toolCall);
				resolvedContentIndex = output.content.length - 1;
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex: resolvedContentIndex, toolCall, partial: output });
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
		const rawResponse = rawEvent.response;
		const response = rawResponse && typeof rawResponse === "object" ? rawResponse : undefined;
		const responseId = response && "id" in response && typeof response.id === "string" ? response.id : undefined;
		const usage = response && "usage" in response ? parseCodexResponseUsage(response.usage) : undefined;
		const serviceTier = response && "service_tier" in response ? parseServiceTier(response.service_tier) : undefined;
		const status = response && "status" in response ? parseCodexResponseStatus(response.status) : undefined;
		const endTurn = response && "end_turn" in response ? response.end_turn : undefined;

		populateResponsesUsageFromResponse(output, usage);
		recordCodexTurnUsageDiagnostics(runtime.websocketState, usage, output.usage);
		if (responseId) {
			output.responseId = responseId;
		}

		const incompleteDetails =
			response &&
			"incomplete_details" in response &&
			response.incomplete_details &&
			typeof response.incomplete_details === "object"
				? response.incomplete_details
				: undefined;
		const incompleteReason =
			incompleteDetails && "reason" in incompleteDetails ? incompleteDetails.reason : undefined;
		// Steering stopped the response at an output boundary: every item is
		// complete and the server continues from it, so it chains and ends like a
		// completed response.
		const steered = status === "incomplete" && incompleteReason === "steered";
		if (steered) logger.debug("Codex response stopped for steering", { responseId });

		const state = runtime.websocketState;
		if (state) {
			if (runtime.transport !== "websocket") {
				// SSE turns never chain (previous_response_id is websocket-only on this
				// endpoint); a completed SSE turn also invalidates any websocket append
				// baseline, which no longer matches the transcript.
				resetCodexWebSocketAppendState(state);
			} else {
				// requestBodyForState is already a private copy and is not mutated after
				// the request, so the append baseline takes ownership of it.
				state.lastRequest = runtime.requestBodyForState;
				const nativeOutputItems = runtime.finalizeNativeOutputItems();
				const replayableResponseItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
					cloneJsonTree(nativeOutputItems),
					{ supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal },
				);
				if (responseId && replayableResponseItems && replayableResponseItems.length === nativeOutputItems.length) {
					state.lastResponseId = responseId;
					state.lastResponseItems = replayableResponseItems;
					state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed" || steered;
				} else {
					// No response id, or replay sanitization dropped an item the server
					// still holds. Sanitization is 1:1-or-fewer, so either case makes the
					// append baseline untrustworthy; next turn must replay in full.
					resetCodexWebSocketAppendState(state);
				}
			}
		}

		const shouldPromoteIncompleteToolUse =
			status === "incomplete" &&
			incompleteReason === "max_output_tokens" &&
			hasExecutableIncompleteResponsesToolCalls(output);
		finalizePendingResponsesToolCalls(output);

		calculateCost(model, output.usage, output.timestamp);
		output.serviceTier = applyCodexServiceTierPricing(
			model,
			output.usage,
			serviceTier,
			runtime.requestBodyForState.service_tier,
		);
		output.stopReason = mapOpenAIResponsesStopReason(steered ? "completed" : status);
		promoteResponsesToolUseStopReason(
			output,
			endTurn === true ? true : endTurn === false ? false : undefined,
			shouldPromoteIncompleteToolUse,
		);
	}

	/**
	 * The native turn lane dropped the response with its socket: stop steering
	 * this session. Only share the refusal with other sessions when this attempt
	 * submitted a steer, not when a chained create encountered a busy lane.
	 */
	#stopSteeringOnNativeLaneRejection(error: unknown, steered: boolean): void {
		const state = this.runtime.websocketState;
		if (
			!state ||
			!(error instanceof CodexProviderStreamError) ||
			error.code !== AIError.CODEX_NATIVE_LANE_STEER_REJECTED_CODE
		) {
			return;
		}
		state.steeringUnsupported = true;
		if (steered) unsupportedSteeringLanes.set(this.#steeringLaneKey, true);
		state.connection?.close("native-lane-steer-rejected");
		state.connection = undefined;
		resetCodexWebSocketAppendState(state);
	}

	async #recoverStreamError(error: unknown): Promise<boolean> {
		if (
			error instanceof CodexSteerCommitError &&
			this.runtime.websocketState &&
			this.output.content.length === 0 &&
			!this.options?.signal?.aborted
		) {
			// No successor is coming: send this request explicitly, steering
			// input included as ordinary history.
			await this.#reopenWebSocketStream(this.runtime.websocketState);
			return true;
		}
		if (await this.#tryDropRejectedAccessPrograms(error)) {
			return true;
		}
		if (await this.#tryRecoverWhitespaceToolCallLoop(error)) {
			return true;
		}
		if (await this.#tryReconnectWebSocketOnConnectionLimit(error)) {
			return true;
		}
		if (await this.#tryRecoverNativeTurnLaneRejection(error)) {
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

	/**
	 * Replay the request without `access_programs` after the backend rejected the
	 * requested cyber program (see `openai-codex/access-programs.ts`). A
	 * rejection arrives before any output, so the replay is always safe.
	 */
	async #tryDropRejectedAccessPrograms(error: unknown): Promise<boolean> {
		if (
			hasVisibleAssistantContent(this.output) ||
			this.options?.signal?.aborted ||
			!dropRejectedCodexAccessPrograms(
				this.requestContext.transformedBody,
				this.model,
				this.requestContext.accountId,
				error,
			)
		) {
			return false;
		}
		this.#closeOpenBlocksForReplay();
		const websocketState = this.requestContext.websocketState;
		if (websocketState) resetCodexWebSocketAppendState(websocketState);
		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;
		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
		} else {
			await this.#reopenSseStream(websocketState);
		}
		return true;
	}

	/**
	 * Recover when Codex's experimental native turn lane refuses a stateful frame
	 * because the previous native turn has not released the lane
	 * (`unsupported_native_inflight_message`). The provider's own remedy is to
	 * start an independent turn, so drop the append baseline AND the sticky
	 * `x-codex-turn-state` token and replay the full transcript. Keeping the token
	 * — as the stale-chain recovery deliberately does — would re-enter the same
	 * lane and be rejected again.
	 */
	async #tryRecoverNativeTurnLaneRejection(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		if (
			!(error instanceof CodexProviderStreamError) ||
			error.code !== "unsupported_native_inflight_message" ||
			!websocketState ||
			this.runtime.transport !== "websocket" ||
			this.output.content.length > 0 ||
			this.options?.signal?.aborted ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES
		) {
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		resetCodexWebSocketAppendState(websocketState);
		this.requestContext.turnState.value = undefined;
		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.output);
		this.firstTokenTime = undefined;

		CODEX_DEBUG &&
			logger.debug("[codex] codex native turn lane busy; retrying as an independent turn", {
				retry: this.runtime.providerRetryAttempt,
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
		if (error instanceof CodexWebSocketBusyError) {
			// Another request claimed the shared socket first. The socket is fine and
			// belongs to that request: send this one over SSE without closing it or
			// disabling websockets for the session.
			this.runtime.resetAccumulators();
			resetOutputState(this.output);
			this.firstTokenTime = undefined;
			await this.#reopenSseStream(state);
			return true;
		}
		const streamError = toError(error);
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

	/**
	 * Emit balancing `*_end` events for every block that opened (pushed a
	 * `*_start`) but never committed visible content, so a retry that resets
	 * `output` and replays cannot leave the consumer with an orphaned
	 * `text_start`/`thinking_start` from the abandoned attempt. Only reachable
	 * blocks are empty text/reasoning ones — a committed tool/text block blocks
	 * the retry upstream.
	 */
	#closeOpenBlocksForReplay(): void {
		const { runtime, output, stream } = this;
		const open = new Set<CodexOpenItem>(runtime.openItems.values());
		for (const entry of runtime.openItemsByOutputIndex.values()) open.add(entry);
		if (runtime.currentEntry) open.add(runtime.currentEntry);
		for (const entry of open) {
			const block = entry.block;
			if (block?.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: entry.contentIndex,
					content: block.thinking,
					partial: output,
				});
			} else if (block?.type === "text") {
				stream.push({ type: "text_end", contentIndex: entry.contentIndex, content: block.text, partial: output });
			}
		}
	}

	async #tryRetryProviderError(error: unknown): Promise<boolean> {
		const retryable =
			error instanceof CodexProviderStreamError ? error.retryable : AIError.isProviderRetryableError(error);
		// A leading `response.output_item.added` opens an empty block and emits only
		// a `*_start` before any delta; that is replay-safe. But once any text or
		// thinking delta has streamed — including a whitespace-only
		// `output_text.delta`, which still reaches consumers as `text_delta` — or a
		// visible tool/image block exists, replaying would duplicate/reorder those
		// already-delivered events, so treat the attempt as committed. Emptiness is
		// measured by the streamed block length (whitespace counts), not by visible
		// final content.
		const streamedContent = this.output.content.some(
			block =>
				(block.type === "text" && block.text.length > 0) ||
				(block.type === "thinking" && block.thinking.length > 0),
		);
		if (
			!retryable ||
			hasVisibleAssistantContent(this.output) ||
			streamedContent ||
			!this.runtime.canSafelyReplayWebsocketOverSse ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		// A leading `output_item.added` already pushed a `*_start` for the (empty)
		// open block; balance it with the matching end before the reset+replay so
		// consumers never see an orphaned start from the abandoned attempt.
		this.#closeOpenBlocksForReplay();
		this.runtime.providerRetryAttempt += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
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
		if (this.requestSetup.requestAbortController.signal.aborted) {
			this.requestSetup = createRequestSetup(this.options);
		}
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
			// instead of surfacing a raw transport error to the caller. A socket busy
			// with another request is not a failure and stays untouched.
			if (!(error instanceof CodexWebSocketBusyError)) recordCodexWebSocketFailure(state, true);
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
		if (output.stopReason === "aborted" || output.stopReason === "error") {
			throw new CodexProviderStreamError("Codex response failed", false);
		}

		output.providerPayload = createOpenAIResponsesHistoryPayload(
			this.model.provider,
			this.runtime.finalizeNativeOutputItems(),
		);
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
			requestContext = await buildCodexRequestContext(model, context, options);
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
						codexClientVersion: CODEX_CLIENT_VERSION,
						turnState: {},
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
		} finally {
			requestContext?.isolatedTransportState?.close();
		}
	})();

	return stream;
};

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		| "apiKey"
		| "headers"
		| "sessionId"
		| "signal"
		| "preferWebsockets"
		| "providerSessionState"
		| "responsesLite"
		| "serviceTier"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getCodexAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const promptCacheKey = transportSessionId;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = resolveCodexResponsesLite(options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !transportSessionId || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, transportSessionId, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const metadataSession = getOrCreateCodexMetadataSessionState(transportSessionId, providerSessionState);
	const turnState = getOrCreateCodexTurnState(metadataSession, sessionKey);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const requestIdentity = createCodexCompatibilityIdentity(metadataSession);
	const attestation = await getCodexAttestationHeader(accountId);
	const routedRequest: Pick<RequestBody, "model" | "service_tier"> = {
		model: model.requestModelId ?? model.id,
	};
	applyOpenAIServiceTier(routedRequest, options?.serviceTier, model);
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...model.headers, ...options?.headers },
		accountId,
		apiKey,
		codexClientVersion,
		promptCacheKey,
		"websocket",
		state,
		turnState,
		responsesLite,
		requestIdentity,
		attestation,
		routedRequest,
	);
	const existing = state.connection;
	if (
		existing?.isReserved() ||
		(state.acceptedSteering !== undefined && state.acceptedSteering.connection === existing)
	) {
		return;
	}
	if (existing?.isConnecting()) {
		// Another caller owns this handshake: join it rather than racing it with a
		// routing-change close once it opens.
		try {
			await existing.connect(options?.signal);
		} catch {
			return;
		}
		if (state.connection === existing && existing.isOpen()) state.prewarmed = true;
		return;
	}
	try {
		await logger.time(
			"prewarmCodex:establishWs",
			getOrCreateCodexWebSocketConnection,
			state,
			turnState,
			toWebSocketUrl(url),
			headers,
			model.provider,
			options?.signal,
		);
	} catch (error) {
		if (error instanceof CodexWebSocketBusyError) return;
		throw error;
	}
	state.prewarmed = true;
}

function getCodexCredentialKey(accountId: string | undefined, apiKey: string): string {
	return accountId ? `account:${accountId}` : `token:${Bun.hash(apiKey).toString(36)}`;
}

function getCodexWebSocketSessionKey(
	normalizedSessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	apiKey: string,
	baseUrl: string,
	responsesLite: boolean,
): string | undefined {
	if (!normalizedSessionId) return undefined;
	const credentialKey = getCodexCredentialKey(accountId, apiKey);
	// Responses Lite is connection-scoped on the WebSocket upgrade, so lite and
	// non-lite turns must never share a pooled socket or append state.
	const liteSuffix = responsesLite ? ":lite" : "";
	return `${credentialKey}:${baseUrl}:${model.id}:${normalizedSessionId}${liteSuffix}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	sessionId: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		sessionId,
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

/**
 * WebSocket not selected for this request (e.g. the preference was switched off
 * mid-session): close an idle cached socket so it stops heartbeating and is
 * never reused against a transcript advanced over SSE.
 */
function releaseIdleCodexWebSocket(state: CodexWebSocketSessionState): void {
	const connection = state.connection;
	if (!connection || connection.isBusy()) return;
	connection.close("transport_not_selected");
	state.connection = undefined;
	resetCodexWebSocketAppendState(state);
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	// Explicitly disabled by the model or session state.
	if (model.preferWebsockets === false) return false;
	// Explicitly disabled by the session state.
	if (!state || state.disableWebsocket) return false;
	// Env val > Preference
	const envVal = getOpenAICodexWebSocketEnvValue();
	if (envVal !== undefined) return envVal;
	// Negative preference overrides model preference; otherwise use the model's preference.
	if (preferWebsockets === false) return false;
	return true;
}

function hashJson(value: unknown): string {
	const json = JSON.stringify(value);
	return String(Bun.hash(json === undefined ? "undefined" : json));
}

function parseCodexResponseStatus(value: unknown): ResponseStatus | undefined {
	switch (value) {
		case "completed":
		case "failed":
		case "in_progress":
		case "cancelled":
		case "queued":
		case "incomplete":
			return value;
		default:
			return undefined;
	}
}

function parseCodexResponseUsage(value: unknown): CodexResponseUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage: CodexResponseUsage = {};
	let hasUsage = false;
	if ("input_tokens" in value && typeof value.input_tokens === "number") {
		usage.input_tokens = value.input_tokens;
		hasUsage = true;
	}
	if ("output_tokens" in value && typeof value.output_tokens === "number") {
		usage.output_tokens = value.output_tokens;
		hasUsage = true;
	}
	if ("total_tokens" in value && typeof value.total_tokens === "number") {
		usage.total_tokens = value.total_tokens;
		hasUsage = true;
	}
	if ("prompt_cache_hit_tokens" in value && typeof value.prompt_cache_hit_tokens === "number") {
		usage.prompt_cache_hit_tokens = value.prompt_cache_hit_tokens;
		hasUsage = true;
	}
	if (
		"input_tokens_details" in value &&
		value.input_tokens_details &&
		typeof value.input_tokens_details === "object"
	) {
		const details = value.input_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["input_tokens_details"]> = {};
		let hasDetails = false;
		if ("cached_tokens" in details && typeof details.cached_tokens === "number") {
			parsedDetails.cached_tokens = details.cached_tokens;
			hasDetails = true;
		}
		if ("cache_write_tokens" in details && typeof details.cache_write_tokens === "number") {
			parsedDetails.cache_write_tokens = details.cache_write_tokens;
			hasDetails = true;
		}
		if ("orchestration_input_tokens" in details && typeof details.orchestration_input_tokens === "number") {
			parsedDetails.orchestration_input_tokens = details.orchestration_input_tokens;
			hasDetails = true;
		}
		if (
			"orchestration_input_cached_tokens" in details &&
			typeof details.orchestration_input_cached_tokens === "number"
		) {
			parsedDetails.orchestration_input_cached_tokens = details.orchestration_input_cached_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.input_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	if (
		"output_tokens_details" in value &&
		value.output_tokens_details &&
		typeof value.output_tokens_details === "object"
	) {
		const details = value.output_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["output_tokens_details"]> = {};
		let hasDetails = false;
		if ("reasoning_tokens" in details && typeof details.reasoning_tokens === "number") {
			parsedDetails.reasoning_tokens = details.reasoning_tokens;
			hasDetails = true;
		}
		if ("orchestration_output_tokens" in details && typeof details.orchestration_output_tokens === "number") {
			parsedDetails.orchestration_output_tokens = details.orchestration_output_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.output_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	return hasUsage ? usage : undefined;
}

function describeCodexInputItemType(item: unknown): string {
	if (item && typeof item === "object") {
		if ("type" in item && typeof item.type === "string") return item.type;
		if ("role" in item && typeof item.role === "string") return item.role;
	}
	return typeof item;
}

function createCodexOptionsHash(request: Record<string, unknown>): string {
	const options: Record<string, unknown> = {};
	for (const key in request) {
		if (key === "input" || key === "previous_response_id" || key === "type" || key === "client_metadata") {
			continue;
		}
		options[key] = request[key];
	}
	return hashJson(options);
}

function buildCodexTurnRequestDiagnostics(
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): OpenAICodexTurnRequestDiagnostics {
	const input = request.input;
	const inputItems = Array.isArray(input) ? input : [];
	const inputItemTypes = inputItems.map(describeCodexInputItemType);
	const promptCacheKey = typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined;
	const toolsHash = request.tools === undefined ? undefined : hashJson(request.tools);
	return {
		transport,
		previousResponseIdPresent:
			typeof request.previous_response_id === "string" && request.previous_response_id.length > 0,
		inputItemCount: inputItems.length,
		inputItemTypes,
		...(inputItemTypes[0] ? { firstInputItemType: inputItemTypes[0] } : {}),
		inputJsonBytes: Buffer.byteLength(JSON.stringify(inputItems), "utf8"),
		...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
		...(toolsHash !== undefined ? { toolsHash } : {}),
		optionsHash: createCodexOptionsHash(request),
		canAppendBeforeRequest,
	};
}

function recordCodexTurnRequestDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	const previousResponseId =
		typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
	if (previousResponseId && previousResponseId.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = previousResponseId;
	} else {
		state.stats.fullContextRequests += 1;
		state.stats.lastDeltaInputItems = undefined;
		state.stats.lastPreviousResponseId = undefined;
	}
	// Measured at send time: the request object may be reused or mutated by an
	// `onPayload` hook afterwards, and retaining it would pin the transcript.
	state.stats.lastTurn = {
		request: buildCodexTurnRequestDiagnostics(request, transport, canAppendBeforeRequest),
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn request diagnostics", { diagnostics: state.stats.lastTurn.request });
}

function recordCodexTurnUsageDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	rawUsage: CodexResponseUsage | undefined,
	displayedUsage: Usage,
): void {
	if (!state?.stats.lastTurn || !rawUsage) return;
	const details = rawUsage.input_tokens_details;
	const outputDetails = rawUsage.output_tokens_details;
	const rawInputTokens = rawUsage.input_tokens ?? 0;
	const rawCachedTokens = details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const usageDiagnostics: OpenAICodexTurnUsageDiagnostics = {
		rawInputTokens,
		rawCachedTokens,
		rawUncachedTokens: Math.max(0, rawInputTokens - rawCachedTokens),
		rawOutputTokens: rawUsage.output_tokens ?? 0,
		...(typeof rawUsage.total_tokens === "number" ? { rawTotalTokens: rawUsage.total_tokens } : {}),
		...(typeof details?.orchestration_input_tokens === "number"
			? { rawOrchestrationInputTokens: details.orchestration_input_tokens }
			: {}),
		...(typeof details?.orchestration_input_cached_tokens === "number"
			? { rawOrchestrationCachedTokens: details.orchestration_input_cached_tokens }
			: {}),
		...(typeof outputDetails?.orchestration_output_tokens === "number"
			? { rawOrchestrationOutputTokens: outputDetails.orchestration_output_tokens }
			: {}),
		displayedInputTokens: displayedUsage.input,
		displayedOutputTokens: displayedUsage.output,
		displayedCacheReadTokens: displayedUsage.cacheRead,
		displayedCacheWriteTokens: displayedUsage.cacheWrite,
		displayedTotalTokens: displayedUsage.totalTokens,
		displayedOrchestrationInputTokens: displayedUsage.orchestration?.input ?? 0,
		displayedOrchestrationCacheReadTokens: displayedUsage.orchestration?.cacheRead ?? 0,
		displayedOrchestrationOutputTokens: displayedUsage.orchestration?.output ?? 0,
	};
	state.stats.lastTurn = {
		...state.stats.lastTurn,
		usage: usageDiagnostics,
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn diagnostics", { diagnostics: state.stats.lastTurn });
}

const CODEX_CHAIN_TOP_LEVEL_EXCLUDE_MAP = {
	service_tier: true,
};

/**
 * Shape the next websocket turn's request body: when the session's strict
 * history prefix is intact and request options other than the per-turn
 * service_tier match, chain via previous_response_id + delta-only input;
 * replay the full transcript. SSE requests never chain — the HTTP endpoint's
 * request schema has no `previous_response_id` (codex-rs carries it only on
 * websocket `response.create` frames) and strict gateway validators 400 it
 * with `{"detail":"Unsupported parameter: previous_response_id"}`.
 *
 * Entering or leaving `ultrafast` still breaks the chain: that tier is a
 * separate serving path, and codex-rs sends a full `response.create` across
 * such a switch rather than a `previous_response_id` delta.
 */
function buildCodexChainedRequestBody(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): RequestBody {
	const chainable =
		state?.canAppend === true &&
		(state.lastRequest?.service_tier === "ultrafast") === (requestBody.service_tier === "ultrafast");
	const appendInput = chainable
		? buildResponsesDeltaInput(
				state.lastRequest,
				state.lastResponseItems,
				requestBody,
				CODEX_CHAIN_TOP_LEVEL_EXCLUDE_MAP,
			)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		return { ...requestBody, previous_response_id: state.lastResponseId, input: appendInput };
	}
	if (state?.canAppend) {
		// Chaining was eligible but the prefix/options check failed: history
		// mutated or options changed — break the chain.
		CODEX_DEBUG &&
			logger.debug("[codex] codex append reset", {
				hadModelsEtagHeader: Boolean(state.modelsEtag),
			});
		resetCodexWebSocketAppendState(state);
		state.modelsEtag = undefined;
	}
	return requestBody;
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

/** What {@link CodexWebSocketConnection.streamRequest} puts on the wire before reading a response. */
type CodexWebSocketExchange =
	| { send: Record<string, unknown> }
	/** Read the successor the server creates from accepted steering; nothing is sent. */
	| { attachSteerIds: readonly string[] };

interface CodexSteerWaiter {
	previousResponseId: string;
	resolve: (ack: CodexSteerAck) => void;
	reject: (error: Error) => void;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
	proxy?: string;
}

/** Codex steering and legacy error boundary around the shared physical channel. */
class CodexWebSocketConnection {
	#channel: ResponsesWebSocketConnection;
	#headers: Record<string, string>;
	#pendingRequests = 0;
	#steerWaiters: CodexSteerWaiter[] = [];
	#acceptedSteers = new Set<string>();
	#failedSteers = new Set<string>();
	#attachSteerIds?: ReadonlySet<string>;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#headers = headers;
		this.#channel = new ResponsesWebSocketConnection({
			url,
			headers,
			proxy: options.proxy,
			connectTimeoutMs: CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS,
			maxIdleReuseMs: CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS,
			messageQueueCapacity: CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY,
			heartbeat: {
				intervalMs: CODEX_WEBSOCKET_PING_INTERVAL_MS,
				pongTimeoutMs: CODEX_WEBSOCKET_PONG_TIMEOUT_MS,
			},
			onHandshakeHeaders: options.onHandshakeHeaders,
			controlFrames: {
				consume: frame => {
					if (typeof frame.type === "string" && frame.type.startsWith("response.steer.")) {
						return this.#handleSteerEvent(frame) ?? true;
					}
					// The native lane refuses the submission and ends the response.
					if (frame.type === "error" && frame.code === AIError.CODEX_NATIVE_LANE_STEER_REJECTED_CODE) {
						this.#refuseSteerWaiters(frame.code, typeof frame.message === "string" ? frame.message : undefined);
					}
					return false;
				},
				closed: error => {
					if (error instanceof ResponsesWebSocketTransportError) {
						const reason = error.reason;
						if (
							reason === "aborted" ||
							reason === "ping-failed" ||
							reason === "pong-timeout" ||
							reason === "queue-overflow"
						) {
							this.#rejectSteerWaiters(`websocket closed (${reason})`);
							return;
						}
					}
					this.#rejectSteerWaiters(error.message);
				},
			},
		});
	}

	isOpen(): boolean {
		return this.#channel.isOpen();
	}

	isConnecting(): boolean {
		return this.#channel.isConnecting();
	}

	/** True while a handshake is in flight or a request owns or has reserved this socket. */
	isBusy(): boolean {
		return this.isReserved() || this.#channel.isConnecting();
	}

	hasActiveRequest(): boolean {
		return this.#channel.hasActiveRequest();
	}

	/** True while a request stream owns this socket or a request has reserved it. */
	isReserved(): boolean {
		return this.#channel.hasActiveRequest() || this.#pendingRequests > 0;
	}

	/**
	 * Reserve the socket for a request that selected it but has not started
	 * streaming yet (e.g. while `onPayload` runs). The reservation only keeps
	 * prewarm and routing-hint reconnects off the socket; concurrent turns still
	 * race for it, and the first to start streaming wins (the other falls back to
	 * SSE). Pass the returned release to {@link streamRequest}, which drops the
	 * reservation once it owns the socket; callers that never iterate that stream
	 * MUST call the release themselves, or the socket stays reserved until
	 * {@link close}.
	 */
	reserveForRequest(): () => void {
		this.#pendingRequests += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#pendingRequests = Math.max(0, this.#pendingRequests - 1);
		};
	}

	isHealthyForReuse(): boolean {
		return this.#channel.isHealthyForReuse();
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	matchesRoutingHint(headers: Record<string, string>): boolean {
		return this.#headers[OPENAI_HEADERS.ROUTING_HINT] === headers[OPENAI_HEADERS.ROUTING_HINT];
	}

	close(reason = "done"): void {
		this.#pendingRequests = 0;
		this.#channel.close(reason);
	}

	async connect(signal?: AbortSignal): Promise<void> {
		logger.time(this.#channel.isConnecting() ? "codexWs:awaitSharedHandshake" : "codexWs:awaitTcpHandshake");
		try {
			await this.#channel.connect(signal);
		} catch (error) {
			throw translateCodexWebSocketError(error);
		}
	}

	async *streamRequest(
		exchange: CodexWebSocketExchange,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
		onOwned?: () => void,
		releaseReservation?: () => void,
	): AsyncGenerator<Record<string, unknown>> {
		releaseReservation?.();
		let owned = false;
		try {
			yield* this.#channel.streamRequest(
				"send" in exchange ? exchange : { receive: true },
				timeouts,
				signal,
				onSseEvent,
				() => {
					owned = true;
					onOwned?.();
					if ("attachSteerIds" in exchange) {
						this.#attachSteerIds = new Set(exchange.attachSteerIds);
						if (this.hasFailedSteer(exchange.attachSteerIds)) {
							throw new CodexSteerCommitError("accepted steering was not committed to a successor response");
						}
					}
				},
			);
		} catch (error) {
			CODEX_DEBUG &&
				logger.debug("[codex] codex websocket transport failure", {
					error: error instanceof Error ? error.message : String(error),
				});
			throw translateCodexWebSocketError(error);
		} finally {
			if (owned) this.#attachSteerIds = undefined;
		}
	}

	/** Submit steering on the current socket, even between response readers. */
	steer(previousResponseId: string, input: InputItem[]): Promise<CodexSteerAck> {
		if (!this.#channel.isOpen()) {
			return Promise.reject(new CodexWebSocketTransportError("websocket connection is unavailable"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<CodexSteerAck>();
		const waiter: CodexSteerWaiter = { previousResponseId, resolve, reject };
		this.#steerWaiters.push(waiter);
		try {
			this.#channel.sendControl({ type: "response.steer", previous_response_id: previousResponseId, input });
		} catch (error) {
			const index = this.#steerWaiters.indexOf(waiter);
			if (index >= 0) this.#steerWaiters.splice(index, 1);
			reject(translateCodexWebSocketError(error));
		}
		return promise;
	}

	hasFailedSteer(ids: readonly string[]): boolean {
		return ids.some(id => this.#failedSteers.has(id));
	}

	#handleSteerEvent(event: Record<string, unknown>): Error | undefined {
		const steer = asRecord(event.steer);
		const id = typeof steer?.id === "string" ? steer.id : undefined;
		const previousResponseId = typeof steer?.previous_response_id === "string" ? steer.previous_response_id : "";
		if (event.type === "response.steer.accepted") {
			if (!id) return;
			this.#acceptedSteers.add(id);
			this.#takeSteerWaiter(previousResponseId)?.resolve({ accepted: true, id });
			return;
		}
		if (event.type === "response.steer.failed") {
			const error = asRecord(event.error);
			const code = typeof error?.code === "string" ? error.code : undefined;
			const message = typeof error?.message === "string" ? error.message : undefined;
			if (id && this.#acceptedSteers.has(id)) {
				this.#failedSteers.add(id);
				if (this.#attachSteerIds?.has(id)) {
					return new CodexSteerCommitError(`steering ${id} was not committed: ${code ?? message ?? "unknown"}`);
				}
				return;
			}
			this.#takeSteerWaiter(previousResponseId)?.resolve({ accepted: false, code, message });
			return;
		}
		CODEX_DEBUG && logger.debug("[codex] codex steering event", { type: event.type, id, previousResponseId });
	}

	#takeSteerWaiter(previousResponseId: string): CodexSteerWaiter | undefined {
		const index = this.#steerWaiters.findIndex(waiter => waiter.previousResponseId === previousResponseId);
		return index < 0 ? undefined : this.#steerWaiters.splice(index, 1)[0];
	}

	#refuseSteerWaiters(code: string, message: string | undefined): void {
		const waiters = this.#steerWaiters;
		this.#steerWaiters = [];
		for (const waiter of waiters) waiter.resolve({ accepted: false, code, message });
	}

	#rejectSteerWaiters(reason: string): void {
		const waiters = this.#steerWaiters;
		this.#steerWaiters = [];
		for (const waiter of waiters) waiter.reject(new CodexWebSocketTransportError(reason));
	}
}

function translateCodexWebSocketError(error: unknown): unknown {
	if (!(error instanceof ResponsesWebSocketTransportError)) return error;
	if (error.reason === "busy") return new CodexWebSocketBusyError(error.message, { cause: error });
	return new CodexWebSocketTransportError(error.message, { cause: error.cause ?? error });
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	turnState: CodexTurnStateCell,
	url: string,
	headers: Headers,
	provider: string,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const proxy = getProxyForUrl(provider, new URL(url));
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
			await pending.connect();
		} catch {
			// The handshake owner surfaces its own failure; re-evaluate below
			// (state.connection may have been replaced or cleared).
		}
	}
	if (state.connection?.hasActiveRequest()) {
		throw new CodexWebSocketBusyError("websocket request already in progress");
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (!state.canAppend && !state.connection.isBusy() && !state.connection.matchesRoutingHint(headerRecord)) {
			state.connection.close("routing-change");
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
			updateCodexSessionMetadataFromHeaders(turnState, state, handshakeHeaders);
		},
		proxy,
	});
	await state.connection.connect(signal);
	return state.connection;
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	turnState: CodexTurnStateCell,
	responsesLite: boolean,
	codexClientVersion: string,
	requestMetadata: CodexRequestMetadata | undefined,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	codexSseMaxAttempts: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const headers = createCodexHeaders(
		requestHeaders,
		accountId,
		apiKey,
		codexClientVersion,
		sessionId,
		"sse",
		state,
		turnState,
		responsesLite,
		requestMetadata,
		await getCodexAttestationHeader(accountId),
		body,
	);
	// `wrapCodexSseStream` arms the iterator-level idle watchdog only after this
	// fetch resolves. Each transport attempt needs its own pre-response timer:
	// the retry loop's base signal remains reserved for caller cancellation, so
	// an internal timeout stays retryable while an explicit abort fails fast.
	let clearPreResponseTimeout: (() => void) | undefined;
	const fetchAttempt: FetchImpl = async (input, init) => {
		let response: Response | undefined;
		try {
			response = await (fetchOverride ?? fetch)(input, init);
			return response;
		} finally {
			// A successful streaming body is governed by the iterator-level idle
			// watchdog, so disarm the pre-response guard the instant headers arrive.
			// Keep it armed for a non-2xx response: the error body is still
			// consumed under this deadline — by fetchWithRetry's
			// retry-status inspection and by CodexApiError.fromResponse — otherwise a
			// server that sends headers then stalls the body hangs the turn past every
			// configured first-event/idle deadline (issue #12664).
			if (!response || response.ok) {
				clearPreResponseTimeout?.();
				clearPreResponseTimeout = undefined;
			}
		}
	};
	CODEX_DEBUG &&
		logger.debug("[codex] codex request", {
			url,
			model: body.model,
			headers: redactHeaders(headers),
			sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
		});

	let response: Response;
	try {
		response = await fetchWithRetry(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
			prepareInit: () => {
				// A retried non-2xx attempt leaves its guard armed for the retry-status
				// body read; disarm it before arming the next attempt's guard.
				clearPreResponseTimeout?.();
				const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
				clearPreResponseTimeout = watchdog.clear;
				return { signal: watchdog.signal };
			},
			maxAttempts: resolveCodexSseMaxAttempts(codexSseMaxAttempts),
			defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
			maxDelayMs: CODEX_RATE_LIMIT_BUDGET_MS,
			fetch: fetchAttempt,
			timeout: false,
		});
	} catch (error) {
		clearPreResponseTimeout?.();
		// Transport rejection after the retry budget: name the host and the cause
		// instead of surfacing the runtime's bare `getaddrinfo …` text.
		throw AIError.networkFailureError(error, url);
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
		// The pre-response guard is still armed for a non-2xx response; keep it live
		// across the error-body read so a stalled body is bounded, then disarm once
		// the read settles (issue #12664).
		try {
			throw await CodexApiError.fromResponse(response);
		} finally {
			clearPreResponseTimeout?.();
		}
	}
	updateCodexSessionMetadataFromHeaders(turnState, state, response.headers);
	if (!response.body) {
		throw new CodexProviderStreamError("No response body", false);
	}
	// Attach the observer only when a diagnostic listener exists: any observer
	// turns on per-line raw capture in `readSseJson`.
	return readSseJson<Record<string, unknown>>(
		response.body,
		signal,
		onSseEvent
			? event => onSseEvent({ event: event.event, data: event.data, raw: [...event.raw] }, undefined)
			: undefined,
	);
}

function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	accessToken: string,
	codexClientVersion: string,
	sessionId?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
	turnState?: CodexTurnStateCell,
	responsesLite = false,
	requestMetadata?: CodexCompatibilityIdentity,
	attestation?: string,
	routedRequest?: Pick<RequestBody, "model" | "service_tier">,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	// codex-rs sends the hint on every ChatGPT-OAuth request and WebSocket
	// handshake; this provider only ever speaks to the Codex backend.
	if (routedRequest) {
		headers.set(OPENAI_HEADERS.ROUTING_HINT, codexRoutingHint(routedRequest.model, routedRequest.service_tier));
	} else {
		headers.delete(OPENAI_HEADERS.ROUTING_HINT);
	}
	// Region-pinned enterprise workspaces answer 401 `Workspace is not authorized
	// in this region.` when the request's egress region does not match them and
	// the client did not declare the workspace's residency. The access token
	// already carries it, so this needs no configuration. A caller-supplied
	// header still wins: a proxy fronting Codex may want a different value.
	applyCodexResidencyHeader(headers, accessToken);
	if (attestation) {
		headers.set(OPENAI_HEADERS.ATTESTATION, attestation);
	} else {
		headers.delete(OPENAI_HEADERS.ATTESTATION);
	}
	// codex-rs sends `OpenAI-Beta` only on the WebSocket handshake; HTTP carries none.
	headers.delete(OPENAI_HEADERS.BETA);
	if (transport === "websocket") {
		headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2);
	}
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, codexClientVersion);
	headers.set("User-Agent", USER_AGENT);
	if (sessionId) {
		// The backend derives prompt-cache affinity from the session headers
		// (codex-rs `responses_session_id`); a side request shares its parent's.
		const affinitySessionId = requestMetadata?.affinitySessionId ?? sessionId;
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, affinitySessionId);
		headers.set(OPENAI_HEADERS.SESSION_ID, affinitySessionId);
		headers.set("x-client-request-id", sessionId);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
		headers.delete("x-client-request-id");
	}
	headers.delete(OPENAI_HEADERS.INSTALLATION_ID);
	if (requestMetadata) {
		applyCodexCompatibilityHeaders(headers, requestMetadata);
	} else {
		headers.delete(OPENAI_HEADERS.SCOPED_SESSION_ID);
		headers.delete(OPENAI_HEADERS.THREAD_ID);
		headers.delete(OPENAI_HEADERS.WINDOW_ID);
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
	if (turnState?.value) {
		headers.set(X_CODEX_TURN_STATE_HEADER, turnState.value);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (responsesLite) {
		headers.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
	} else {
		headers.delete(OPENAI_HEADERS.RESPONSES_LITE);
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
			lower.includes("thread") ||
			lower.includes("window") ||
			lower.includes("installation") ||
			lower.startsWith("x-codex-turn") ||
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

/** Resolve a Codex Responses endpoint exactly as the chat and compaction transports do. */
export function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeCodexToolCallId = (id: string): string => {
		const sep = id.search(/[\n|]/);
		const [callId, itemId] = sep > 0 ? [id.slice(0, sep), id.slice(sep + 1)] : [id, undefined];
		const normalizedCallId = sanitizeCodexCallId(callId);
		const rawItemId = itemId ?? Bun.hash(id).toString(36);
		const normalizedItemId = normalizeToolCallId(rawItemId.startsWith("fc") ? rawItemId : `fc_${rawItemId}`).replace(
			/_+$/,
			"",
		);
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeCodexToolCallId);
	// gpt-5.x reject raw Harmony control-token spellings anywhere in replayed
	// input, including the model's own tool-call arguments (#6913).
	const escapeControlTokens = isHarmonyDialectModel(model);
	let msgIndex = 0;
	// Track call_ids that originated as custom tool calls so paired tool-result
	// messages can be replayed as `custom_tool_call_output` rather than
	// `function_call_output` (OpenAI rejects mismatched pairs).
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();
	const computerCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				const redactedHistoryItems = redactSensitiveInObject(historyItems).result as Array<ResponseInput[number]>;
				const sanitizedHistoryItems = dropMalformedOpenAIResponsesToolCalls(redactedHistoryItems);
				const clampedHistoryItems = clampOpenAIResponsesImageDetailForReplay(
					sanitizedHistoryItems,
					model.compat.supportsImageDetailOriginal,
				);
				const replayItems =
					model.supportsComputerUse === true
						? clampedHistoryItems
						: unrollCodexComputerItems(clampedHistoryItems, model.compat.supportsImageDetailOriginal);
				for (const item of replayItems) {
					if (item.type === "custom_tool_call") {
						customCallIds.add(item.call_id);
					}
					if (item.type === "computer_call") computerCallIds.add(item.call_id);
					if ((item.type === "function_call" || item.type === "custom_tool_call") && item.call_id) {
						knownCallIds.add(item.call_id);
					}
				}
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(replayItems) : replayItems));
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
			const historyItems = providerPayload?.items as Array<Record<string, unknown>> | undefined;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(historyItems, {
					supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
				});
				if (sanitizedHistoryItems) {
					const rawReplayItems =
						model.supportsComputerUse === true
							? sanitizedHistoryItems
							: unrollCodexComputerItems(sanitizedHistoryItems, model.compat.supportsImageDetailOriginal);
					const missingCalls = pickUnrecordedResponsesToolCalls(assistantMsg, historyItems);
					if (missingCalls.length > 0) {
						const rebuilt = convertResponsesAssistantMessage(
							{ ...assistantMsg, content: missingCalls },
							model,
							msgIndex,
							knownCallIds,
							false,
							customCallIds,
							false,
							true,
							undefined,
							computerCallIds,
						);
						rawReplayItems.push(...rebuilt);
					}
					const replayItems = escapeControlTokens ? escapeReplayedControlTokens(rawReplayItems) : rawReplayItems;
					for (const item of replayItems) {
						if (item.type === "custom_tool_call") {
							customCallIds.add(item.call_id);
						}
						if (item.type === "computer_call") computerCallIds.add(item.call_id);
						if ((item.type === "function_call" || item.type === "custom_tool_call") && item.call_id) {
							knownCallIds.add(item.call_id);
						}
					}
					if (providerPayload?.dt) {
						messages.push(...replayItems);
					} else {
						messages.splice(0, messages.length, ...replayItems);
						// Keep customCallIds from the pre-splice state since historyItems may re-introduce them.
					}
					msgIndex += 1;
					continue;
				}
				suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				model.supportsComputerUse === true ? assistantMsg : unrollCodexComputerAssistantMessage(assistantMsg),
				model,
				msgIndex,
				knownCallIds,
				!suppressHiddenEmptyFallback,
				customCallIds,
				false,
				true,
				undefined,
				computerCallIds,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length > 0) {
				messages.push(...(escapeControlTokens ? escapeReplayedControlTokens(outputItems) : outputItems));
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				model.supportsComputerUse === true ? msg : unrollCodexComputerToolResult(msg),
				model,
				false,
				model.compat.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
				true,
				computerCallIds,
			);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content:
		| string
		| Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string; url?: string }>,
): ResponseInputContent[] {
	// gpt-5.x codex rejects reserved Harmony control-token spellings in input
	// data; escape the transport copy of untrusted user text so ordinary docs or
	// grep results cannot poison the session (#6913). History is left untouched.
	const escapeControlTokens = isHarmonyDialectModel(model);
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		const text = content.toWellFormed();
		return [{ type: "input_text", text: escapeControlTokens ? escapeHarmonyControlTokens(text) : text }];
	}

	return (
		convertResponsesInputContent(
			content,
			model.input.includes("image"),
			model.compat.supportsImageDetailOriginal,
			escapeControlTokens,
		) ?? []
	);
}

/** @internal Exported for tests. */
export { convertMessages as convertCodexResponsesMessages };

type CodexToolPayload =
	| { type: "computer"; name?: never }
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
	const payloads: CodexToolPayload[] = [];
	for (const tool of tools) {
		// Subscription models default to the function fallback. Explicit metadata
		// remains authoritative for future Codex endpoints that implement GA computer use.
		if (tool.native?.type === "computer" && model.supportsComputerUse === true) {
			payloads.push({ type: "computer" });
			continue;
		}
		if (allowFreeform && tool.customFormat) {
			payloads.push({
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			});
			continue;
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool), { repairArrayItems: true });
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		payloads.push({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict ? { strict: true } : !NO_STRICT && tool.strict === false ? { strict: false } : {}),
		});
	}
	return payloads;
}

export class CodexWebSocketTransportError extends Error {
	constructor(detail: string, options?: ErrorOptions) {
		super(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${detail}`, options);
		this.name = "CodexWebSocketTransportError";
	}
}
/**
 * The session's shared socket is streaming another request. Not a transport
 * failure: the caller falls back to SSE and must not close the socket.
 */
class CodexWebSocketBusyError extends CodexWebSocketTransportError {}
/**
 * The server failed to commit accepted steering to its automatic successor, so
 * the request that was reading that successor must be sent explicitly instead.
 */
class CodexSteerCommitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexSteerCommitError";
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
	readonly headers?: HeadersLike;

	constructor(message: string, retryable: boolean, code?: string, headers?: HeadersLike) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
		this.headers = headers;
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
	return (
		!!message &&
		(CODEX_RETRYABLE_EVENT_MESSAGE.test(message) ||
			AIError.PYTHON_HTTP2_STREAM_RESET_PATTERN.test(message) ||
			AIError.PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN.test(message))
	);
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
	// The nested error's headers are the specific source; the event's own apply when they carry no retry hint.
	const nestedHeaders = getHeadersFromError(nestedError);
	const headers =
		getRetryAfterMsFromHeaders(nestedHeaders) === undefined ? getHeadersFromError(rawEvent) : nestedHeaders;
	return new CodexProviderStreamError(
		formattedMessage,
		isRetryableCodexFailureEvent(rawEvent),
		code || undefined,
		headers,
	);
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
