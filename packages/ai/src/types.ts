export * from "@oh-my-pi/pi-catalog/effort";
export * from "@oh-my-pi/pi-catalog/types";

import type { Type } from "@oh-my-pi/omptype";
import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	PiBashExecArgs,
	PiBashExecResult,
	PiEditExecArgs,
	PiEditExecResult,
	PiFindExecArgs,
	PiFindExecResult,
	PiGrepExecArgs,
	PiGrepExecResult,
	PiLsExecArgs,
	PiLsExecResult,
	PiReadExecArgs,
	PiReadExecResult,
	PiWriteExecArgs,
	PiWriteExecResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, FetchImpl, KnownApi, Model, Provider, ThinkingBudgets, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "./auth-retry";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { FallbackParam, StopDetails } from "./providers/anthropic-wire";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import type { GitLabDuoWorkflowOptions } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { kStreamingPartialJson } from "./utils/block-symbols";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export type { StopDetails } from "./providers/anthropic-wire";
export type { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * Ceiling on the output-token count omp requests from any OpenAI-family endpoint
 * (openai-responses, azure/xai responses, and openai-completions). Mirrors
 * Anthropic's {@link CLAUDE_CODE_MAX_OUTPUT_TOKENS}.
 *
 * Catalog `maxTokens` frequently reflects a model's context window rather than a
 * given upstream's real per-request output cap. OpenRouter, for instance,
 * advertises 131072 output tokens for `z-ai/glm-4.7`, but the Cerebras upstream
 * only allows ~131072 tokens total — so requesting the full ceiling overflows
 * with a 400. Requested output is clamped to this value (and to `model.maxTokens`).
 */
export const OPENAI_MAX_OUTPUT_TOKENS = 64000;

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	openrouter: OpenAIResponsesOptions | OpenAICompletionsOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"ollama-chat": OllamaChatOptions;
	"cursor-agent": CursorOptions;
	"gitlab-duo-agent": GitLabDuoWorkflowOptions;
	"devin-agent": DevinOptions;
}
// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
true satisfies _CheckExhaustive;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

export interface TokenTaskBudget {
	type: "tokens";
	total: number;
	remaining?: number;
}

export type MessageAttribution = "user" | "agent";

export type NativeToolMarker = { type: "computer" };

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string }
	| { type: "computer" };

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * Service tier hint for processing priority / cost control. These are the
 * values providers consume on the wire:
 *
 * - OpenAI / OpenAI-Codex: sent verbatim as the `service_tier` field
 *   (`flex`/`scale`/`priority`).
 * - Google (Gemini API + Vertex AI): sent as the top-level `serviceTier`
 *   field (`flex`/`priority`).
 * - OpenRouter: passed through as `service_tier`; OpenRouter realizes it for
 *   the OpenAI- and Google-family upstreams it supports and ignores it
 *   otherwise.
 * - Direct Anthropic: `"priority"` is translated into `speed: "fast"` plus the
 *   fast-mode beta on supported Opus models. Other tiers are ignored.
 *
 * Per-family scoping is expressed by {@link ServiceTierByFamily}, not by
 * scoped sentinel values — see {@link serviceTierFamily}.
 */
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

/** Provider families that expose an independent service-tier knob. */
export type ServiceTierFamily = "openai" | "anthropic" | "google";

/**
 * Per-family service-tier selection. A request consults only the entry for the
 * family its model belongs to (see {@link resolveModelServiceTier}), so a user
 * can opt one family into priority without affecting the others when switching
 * models mid-session.
 */
export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;

type ServiceTierModel = Pick<Model, "provider" | "api" | "identity">;
// The service-tier matrix below intentionally stays in TypeScript rather than
// the KDL compat tree: `shouldSendServiceTier` accepts bare provider strings
// (agent telemetry, google-shared header placement) and the stats parser
// rebuilds slim `{ provider, api, identity }` models from historical session
// JSONL — neither path holds a resolved compat record, so a KDL axis would
// merely duplicate this table as its own fallback. The functions branch on
// structured `classifyModel` facts, api, and a short provider list, which is
// the sanctioned mechanism layer.

function isOpenAIServiceTierApi(api: Api | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
}

function excludesInferredOpenAIServiceTier(provider: Provider | undefined): boolean {
	// Fireworks has its own priority-only control. GitHub Copilot proxies OpenAI
	// models but rejects OpenAI's `service_tier` request field.
	return provider === "fireworks" || provider === "github-copilot";
}

function isOpenAIServiceTierModel(model: ServiceTierModel): boolean {
	return (
		!excludesInferredOpenAIServiceTier(model.provider) &&
		isOpenAIServiceTierApi(model.api) &&
		model.identity.class === "openai"
	);
}

/**
 * Classify a model into the service-tier family whose knob governs it, or
 * `undefined` when the model exposes no serving-priority control.
 *
 * OpenRouter models are classified by id namespace (`anthropic/`, `google/`,
 * `openai/`); Claude on Bedrock/Vertex (api `anthropic-messages`) is the
 * anthropic family even though its provider is `amazon-bedrock`/`google-vertex`.
 * Custom OpenAI-compatible relays that serve OpenAI model ids are OpenAI family
 * too unless the provider owns a separate tier control (Fireworks) or rejects
 * OpenAI's service-tier field (GitHub Copilot).
 */
export function serviceTierFamily(model: ServiceTierModel): ServiceTierFamily | undefined {
	const provider = model.provider;
	if (provider === "openrouter") {
		if (model.identity.class === "anthropic") return "anthropic";
		if (model.identity.class === "gemini") return "google";
		if (model.identity.class === "openai") return "openai";
		return undefined;
	}
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (model.api === "anthropic-messages") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	if (isOpenAIServiceTierModel(model)) return "openai";
	return undefined;
}

/**
 * Reduce a per-family tier map to the single wire tier for `model` — the entry
 * for the model's family, or `undefined` when the model has no family.
 */
export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: ServiceTierModel,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

/**
 * True when the tier should be sent on the wire as the provider's service-tier
 * request field. `auto` is never forwarded — it is OpenAI's implicit default, so
 * omitting `service_tier` is identical to requesting `auto`, and the Codex
 * (ChatGPT OAuth) endpoint rejects an explicit `auto` outright. OpenAI /
 * OpenAI-Codex accept every other {@link ServiceTier}; Google (Gemini API +
 * Vertex) and OpenRouter accept `flex`/`priority`; Fireworks Serverless
 * realizes only its Priority serving path. Anthropic is absent because it
 * realizes `priority` via `speed: "fast"`.
 */
export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	target: Provider | ServiceTierModel | undefined,
): boolean {
	if (!serviceTier || serviceTier === "auto") return false;
	const provider = typeof target === "string" ? target : target?.provider;
	if (provider === "openai" || provider === "openai-codex") return true;
	if (provider === "openrouter") {
		return serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority";
	}
	if (typeof target !== "string" && target && isOpenAIServiceTierModel(target)) return true;
	if (provider === "google") {
		return serviceTier === "flex" || serviceTier === "priority";
	}
	// Vertex realizes only priority (via header); flex has no documented control.
	if (provider === "google-vertex" || provider === "fireworks") {
		return serviceTier === "priority";
	}
	return false;
}

/**
 * True when `priority` will actually be realized on the wire for `model`.
 * Direct Anthropic realizes fast mode; OpenAI/Google/Fireworks emit the
 * service-tier field; OpenRouter realizes it only for its OpenAI- and
 * Google-family upstreams. Bedrock/Vertex Claude and OpenRouter Anthropic
 * models do not realize priority and return `false`.
 */
export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): boolean {
	if (serviceTier !== "priority") return false;
	if (model.provider === "anthropic") return true;
	if (model.provider === "openrouter") {
		const family = serviceTierFamily(model);
		return family === "openai" || family === "google";
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model);
}

/**
 * Premium-request weight contributed by a priority request to a provider that
 * realizes it and bills extra. Mirrors GitHub Copilot's `premiumRequests`
 * accounting so the "premium requests" stat aggregates priority traffic across
 * the OpenAI family, direct Anthropic fast mode, and Google priority.
 *
 * Returns 1 only when priority is actually realized on the wire for `model`
 * (see {@link realizesPriorityServiceTier}) and the provider bills it as a
 * premium request. OpenRouter is excluded — it bills per its own pricing, not
 * Copilot-premium semantics — as are Bedrock/Vertex Claude, where priority is
 * silently dropped.
 */
export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	const provider = model.provider;
	return provider === "openai" ||
		provider === "openai-codex" ||
		provider === "anthropic" ||
		provider === "google" ||
		provider === "google-vertex"
		? 1
		: 0;
}

/**
 * Coerce a persisted service-tier value to a {@link ServiceTierByFamily}. Newer
 * sessions store the family map directly; legacy sessions stored a single
 * scalar — `"priority"` applied everywhere, `"openai-only"`/`"claude-only"`
 * scoped to one family, and the remaining values were OpenAI-only semantics.
 */
export function coerceServiceTierByFamily(value: unknown): ServiceTierByFamily | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: ServiceTierByFamily = {};
		for (const family of ["openai", "anthropic", "google"] as const) {
			const tier = src[family];
			if (tier === "auto" || tier === "default" || tier === "flex" || tier === "scale" || tier === "priority") {
				out[family] = tier;
			}
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	switch (value) {
		case "priority":
			return { openai: "priority", anthropic: "priority", google: "priority" };
		case "openai-only":
			return { openai: "priority" };
		case "claude-only":
			return { anthropic: "priority" };
		case "auto":
			return { openai: "auto" };
		case "default":
			return { openai: "default" };
		case "flex":
			return { openai: "flex" };
		case "scale":
			return { openai: "scale" };
		default:
			return undefined;
	}
}

export interface ProviderSessionState {
	close(): void;
}

export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}

export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/** Lifecycle fields shared by every Codex compaction implementation. */
export interface CodexCompactionContext {
	/** Stable only for one logical compaction, including parallel summary calls. */
	operationId: string;
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

/** Canonical nested metadata serialized into the Codex turn envelope. */
export interface CodexCompactionMetadata {
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

/** Dispatch context combining canonical metadata with its local operation identity. */
export interface CodexCompactionRequestContext extends CodexCompactionMetadata {
	operationId: string;
}

/** OpenAI's GPT-5.6+ explicit prompt-cache controls. */
export interface OpenAIPromptCacheOptions {
	/** `explicit` disables OpenAI's automatic latest-message breakpoint. */
	mode: "implicit" | "explicit";
	/** The only currently supported minimum breakpoint lifetime. */
	ttl?: "30m";
	/** By default, mark one existing block from stable history; `none` suppresses that marker. */
	breakpoint?: "latest-stable-message" | "none";
}
export type OpenAIResponseInclude =
	| "file_search_call.results"
	| "web_search_call.results"
	| "web_search_call.action.sources"
	| "message.input_image.image_url"
	| "computer_call_output.output.image_url"
	| "code_interpreter_call.outputs"
	| "reasoning.encrypted_content"
	| "message.output_text.logprobs";

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	/**
	 * Stop sequences. Anthropic encodes as `stop_sequences` (array, max 4);
	 * OpenAI chat-completions encodes as `stop` (string or array of up to 4);
	 * OpenAI Responses API has no `stop` field today (silently dropped by the
	 * provider when present).
	 */
	stopSequences?: string[];
	/**
	 * Frequency penalty (OpenAI). Penalizes new tokens based on existing frequency
	 * in the text so far. Range -2.0 to 2.0. Parallel to {@link presencePenalty}.
	 */
	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	cacheRetention?: CacheRetention;
	/**
	 * Keep Anthropic's 5-minute prompt cache warm across bounded idle gaps.
	 *
	 * This is an ownership flag, not a general provider default: exactly one
	 * primary agent loop sharing `providerSessionState` should enable it.
	 * Side-channel and advisor requests must leave it unset.
	 */
	anthropicCacheRefresh?: boolean;
	/**
	 * Anthropic preserved-thinking behavior when a signed block no longer matches
	 * its conversation prefix. Binding-capable models default to `"drop_block"`.
	 */
	anthropicPrefixMismatchBehavior?: "drop_block" | "error";
	/** @internal Marks a replay-only Anthropic request that must use non-streaming `max_tokens: 0`. */
	anthropicCacheRefreshRequest?: boolean;
	/**
	 * Additional headers to include in provider requests.
	 * These are merged on top of model-defined headers.
	 */
	headers?: Record<string, string>;
	/**
	 * Optional explicit request attribution override for providers that support it.
	 */
	initiatorOverride?: MessageAttribution;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Provider-owned request configuration. Provider hooks interpret this bag;
	 * generic API transports do not forward its fields onto the wire.
	 */
	providerOptions?: Readonly<Record<string, unknown>>;
	/** OpenAI Responses/Codex response fields to include verbatim. */
	include?: OpenAIResponseInclude[];
	/**
	 * Config options for the thinking/response loop guard.
	 */
	loopGuard?: {
		enabled?: boolean;
		checkAssistantContent?: boolean;
	};
	/**
	 * Advisory token budget for a full agentic loop. Anthropic encodes this as
	 * `output_config.task_budget` with the `task-budgets-2026-03-13` beta header.
	 */
	taskBudget?: TokenTaskBudget;
	/**
	 * Optional session identifier for providers that support session-based
	 * routing, request affinity, or transport reuse. Providers may also use this
	 * as the prompt-cache key when `promptCacheKey` is not set.
	 */
	sessionId?: string;
	/**
	 * Optional prompt-cache identity. OpenAI-family providers use this for
	 * `prompt_cache_key` payloads and cache-affinity headers such as
	 * `x-grok-conv-id`; when omitted, they fall back to `sessionId`.
	 */
	promptCacheKey?: string;
	/**
	 * OpenAI GPT-5.6+ prompt-cache policy. Ignored by providers that do not
	 * support explicit OpenAI cache breakpoints; explicit mode fails locally on
	 * incompatible OpenAI-compatible endpoints.
	 */
	promptCache?: OpenAIPromptCacheOptions;
	/**
	 * Disable OpenAI Responses server-side turn chaining for this request.
	 * Diagnostic callers that compare independent requests can set this to
	 * `false` so `previous_response_id` cannot explain a result.
	 */
	statefulResponses?: boolean;
	/**
	 * Disable native reasoning when the caller supplies an external scratchpad.
	 * OpenAI Responses emits `reasoning: { effort: "none" }`; Anthropic and
	 * Google transports use their native thinking-off controls.
	 */
	forceReasoningOff?: boolean;
	/**
	 * Provider-scoped mutable state store for this agent session.
	 * Providers can use this to persist transport/session state between turns.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Canonical Codex compaction classification; ignored by other providers. */
	codexCompaction?: CodexCompactionRequestContext;
	/** Codex Code Mode tool exposure snapshot emitted as `tool_namespaces_info` turn metadata; ignored by other providers. */
	toolNamespacesInfo?: unknown;
	/**
	 * Optional per-provider concurrent request cap for LLM stream calls. Keys are
	 * provider ids (`model.provider`); positive numeric values cap in-flight
	 * requests across local OMP processes that share the same config root. Omitted
	 * providers are unlimited. Non-chat provider APIs that bypass stream helpers
	 * are not covered.
	 */
	maxInFlightRequests?: Record<string, number>;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback for provider response metadata after headers are received.
	 */
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;
	/**
	 * Optional callback for raw Server-Sent Events as they arrive from HTTP streaming providers,
	 * plus synthesized SSE-shaped frames for the Codex WebSocket transport (one synthetic frame
	 * per JSON request/response message). WebSocket frames are tagged with a leading
	 * `: ws → <type>` (outbound) or `: ws ← <type>` (inbound) comment line in `RawSseEvent.raw`.
	 *
	 * Diagnostic only: provider implementations must ignore callback failures and must not
	 * let observers alter stream contents.
	 */
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	/**
	 * Optional override for the first-event watchdog in milliseconds. Built-in
	 * providers apply this budget twice when they can: once to the underlying
	 * SDK/request while waiting for the HTTP stream object to exist, then again
	 * in the iterator while waiting for the first semantic stream event. Set to
	 * `0` to disable both layers for this request. After the first semantic
	 * event arrives, `streamIdleTimeoutMs` governs inter-event stalls. Falls
	 * back to `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` and then to a 100s default.
	 * OpenAI-family transports additionally honor
	 * `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` as the most-specific override and
	 * floor the first-event budget at the resolved idle (per-call
	 * `streamIdleTimeoutMs` or `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`) so slow local
	 * OpenAI-compatible servers are not undercut during prompt processing.
	 *
	 * Iterator-level honored by: every built-in provider (via the lazy-stream
	 * forwarder in `register-builtins`). SDK-request honored by:
	 * `openai-completions`, `openai-responses`, `azure-openai-responses`,
	 * `anthropic-messages`.
	 */
	streamFirstEventTimeoutMs?: number;
	/**
	 * Optional override for the maximum idle gap between streamed events in
	 * milliseconds. Once the first event arrives, this guards against silent
	 * mid-stream stalls (broker dies, half-open socket, model produces no real
	 * progress for too long). Set to `0` to disable. Falls back to
	 * `PI_STREAM_IDLE_TIMEOUT_MS` (alias: `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`)
	 * and then to a 120s default.
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Optional cap on Codex SSE pre-response attempts, including the initial
	 * request. WebSocket retries and outer agent retries have separate budgets.
	 * Finite values below `1` and non-finite values are clamped to one request;
	 * omission preserves the provider default.
	 */
	codexSseMaxAttempts?: number;
	/**
	 * Optional retry delay hook for tests and transports that need custom scheduling.
	 */
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Accept a normal provider stop with no visible text or tool call as a
	 * successful completion. Passive callers and zero-output cache refreshes use
	 * this because silence is their expected result; interactive agent turns
	 * retain empty-response retries by default.
	 */
	acceptEmptyResponse?: boolean;
	/**
	 * Optional `fetch` implementation override. Providers route every HTTP
	 * request — direct calls, SDK clients, and retry helpers — through this
	 * implementation when set. Defaults to `globalThis.fetch`. Providers that
	 * do not use `fetch` (Bedrock's AWS SDK transport, Cursor's HTTP/2
	 * channel) silently ignore the override.
	 */
	fetch?: FetchImpl;
	/** Current session working directory for providers that need workspace-scoped discovery. */
	cwd?: string;

	/** Cursor exec/MCP tool handlers (cursor-agent only). */
	execHandlers?: CursorExecHandlers;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	/**
	 * API key for the request: either a static bearer string, or an
	 * {@link ApiKeyResolver} that mints/rotates the key across the central
	 * a/b/c auth-retry policy. `streamSimple`/`completeSimple` resolve a
	 * resolver to a string before per-provider dispatch, so providers only
	 * ever see the resolved {@link StreamOptions.apiKey} string.
	 */
	apiKey?: ApiKey;
	reasoning?: Effort;
	/**
	 * Force-disable reasoning for the request even when the model supports it.
	 * Takes precedence over `reasoning`. Useful for fast utility calls
	 * (e.g. title generation) where the model would otherwise burn the entire
	 * output budget on internal thinking. Provider support is format-specific:
	 * some transports can disable reasoning directly, while generic
	 * effort-based OpenAI-compatible endpoints use the lowest supported effort.
	 */
	disableReasoning?: boolean;
	/**
	 * If true, request that the provider omit thinking/reasoning summaries
	 * from the response (e.g. Anthropic `thinking.display = "omitted"`,
	 * OpenAI Responses `reasoning.summary` left unset). The model still
	 * reasons internally; only the human-readable summary stream is dropped.
	 * Useful when the UI hides thinking blocks anyway and the summary is wasted bandwidth.
	 */
	hideThinkingSummary?: boolean;
	/** OpenAI Responses/Codex `text.verbosity` response detail level. */
	textVerbosity?: "low" | "medium" | "high";
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor exec handlers for local tool execution */
	cursorExecHandlers?: CursorExecHandlers;
	/**
	 * Optional rewrite of Cursor exec-channel tool results. May return a Promise.
	 *
	 * The Agent reserves the original result in its buffer before awaiting this
	 * hook, and the `message_end` drain waits for a still-pending rewrite, so an
	 * async transformer is honored even when the turn closes in the same chunk.
	 * A rejecting transformer is swallowed and the reserved payload stands in.
	 */
	cursorOnToolResult?: CursorToolResultHandler;
	/**
	 * Amazon Bedrock Guardrail settings forwarded through transports that do not
	 * dispatch directly to the Bedrock provider. Model-level values take
	 * precedence when both are present.
	 */
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
	/** Optional tool choice override for compatible providers */
	toolChoice?: ToolChoice;
	/** OpenAI service tier for processing priority/cost control. Ignored by non-OpenAI providers. */
	serviceTier?: ServiceTier;
	/** Explicit Kimi Code API format override; omitted uses live per-model protocol metadata. */
	kimiApiFormat?: "openai" | "anthropic";
	/** API format for Synthetic provider: "openai" or "anthropic" (default: "openai") */
	syntheticApiFormat?: "openai" | "anthropic";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/**
	 * OpenRouter routing-variant suffix automatically appended to model IDs when
	 * the request targets OpenRouter (`model.provider === "openrouter"`). Common
	 * values: `"nitro"` (throughput), `"floor"` (cheapest), `"online"` (web
	 * search plugin), `"exacto"` (cherry-picked high-quality providers, only
	 * defined for some models). Ignored when the resolved model id already
	 * contains a `:<variant>` suffix (e.g. the user typed `:nitro` explicitly
	 * or the catalog entry already names the variant).
	 */
	openrouterVariant?: string;
	/**
	 * Caller-owned Google context-cache resource name. Forwarded only to the
	 * direct Gemini GenerateContent and Vertex GenerateContent APIs; all other
	 * providers ignore it. Callers own the cache lifecycle and compatibility.
	 */
	cachedContent?: string;
	/** Antigravity endpoint routing mode: "auto" (default with failover), "production", "sandbox". */
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	/**
	 * Anthropic `server-side-fallback-2026-06-01` fallback chain (top-level
	 * `fallbacks` request field). Opt-in ONLY — leaving this undefined is
	 * the default and preserves the pre-fallback behavior on every
	 * provider. Non-Anthropic providers ignore the field.
	 */
	fallbacks?: FallbackParam[];
}

// Generic StreamFunction with typed options
export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

/**
 * Anthropic server-side-fallback boundary marker persisted on assistant
 * turns whose provider request opted into
 * `AnthropicOptions.fallbacks`. Consumers other than the Anthropic
 * provider MUST ignore it — `transformMessages` strips the block on any
 * cross-provider hop and on non-official Anthropic replays, so downstream
 * converters never see it.
 */
export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

/**
 * Verbatim Anthropic web-search or tool-search call/result retained for
 * same-provider history replay. Other providers discard it in
 * `transformMessages`.
 */
export interface AnthropicServerToolContent {
	type: "anthropicServerTool";
	block:
		| {
				type: "server_tool_use";
				id: string;
				name: "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25";
				input?: Record<string, unknown> | null;
				[key: string]: unknown;
		  }
		| {
				type: "web_search_tool_result" | "tool_search_tool_result";
				tool_use_id: string;
				content: unknown;
				[key: string]: unknown;
		  };
}

/** Provider-native uploaded file reference for image reuse without retransmitting bytes. */
export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (required for snapcompact frames, whose glyphs do not survive the
	 * default `auto` downscale). Providers without a detail knob ignore it.
	 */
	detail?: "auto" | "low" | "high" | "original";
	/** Provider-native file reference preferred only by its matching provider. */
	providerFile?: ProviderFileReference;
	/**
	 * Optional https mirror of `data`, served by a caller-run blob server.
	 * Providers whose API fetches remote images send this URL instead of the
	 * base64 payload; every other provider ignores it. `data` remains the
	 * source of truth — the URL must serve exactly those bytes, and callers
	 * are responsible for keeping it stable across turns (prefix caches hash
	 * the URL string, and Anthropic silently forgets images when a resent
	 * turn differs byte-wise).
	 */
	url?: string;
}

export type ComputerAction =
	| {
			type: "click";
			button: "left" | "right" | "wheel" | "back" | "forward";
			x: number;
			y: number;
			keys?: string[] | null;
	  }
	| { type: "double_click"; x: number; y: number; keys: string[] | null }
	| { type: "drag"; path: Array<{ x: number; y: number }>; keys?: string[] | null }
	| { type: "keypress"; keys: string[] }
	| { type: "move"; x: number; y: number; keys?: string[] | null }
	| { type: "screenshot" }
	| { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number; keys?: string[] | null }
	| { type: "type"; text: string }
	| { type: "wait" };

export interface ComputerSafetyCheck {
	id: string;
	code?: string | null;
	message?: string | null;
}

export interface ComputerToolCallMetadata {
	type: "computer";
	providerItemId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}

export type ToolCallProviderMetadata = ComputerToolCallMetadata;

export type ComputerScreenshotRef =
	| { type: "computer_screenshot"; image_url: string; file_id?: never }
	| { type: "computer_screenshot"; file_id: string; image_url?: never };

export interface ComputerToolResultMetadata {
	type: "computer";
	screenshot: ComputerScreenshotRef;
	acknowledgedSafetyChecks: ComputerSafetyCheck[];
}

export type ToolResultProviderMetadata = ComputerToolResultMetadata;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
	/** Provider-native metadata required to execute and faithfully replay this call. */
	providerMetadata?: ToolCallProviderMetadata;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload;

/** Provider-reported rewrite applied to request content before inference. */
export interface ProviderInputTransformation {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** Timestamp of a client-side history rewrite represented by this message. */
	historyRewriteAt?: number;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** True if the message was injected by the system (e.g., auto-continue) and initiates a fresh run rather than continuing the current one. */
	synthetic?: boolean;
	/** True when the synthetic prompt was a deliberate operator action (`.`, `c` continue shortcut) rather than an automatic continuation — its timestamp is the turn's prompt time. */
	userInitiated?: boolean;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

/** How an automatic retry recovered or ultimately settled a failed attempt. */
export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

/** Persisted presentation state for an assistant error superseded by an automatic retry saga. */
export type AssistantRetryRecovery =
	| {
			kind: "auto-retry";
			status: "recovered";
			attempt: number;
			recoveredAt: string;
			recovery: AssistantRetryRecoveryKind;
			note: string;
			supersededBy?: {
				timestamp: number;
				responseId?: string;
				provider: string;
				model: string;
			};
	  }
	| {
			kind: "auto-retry";
			status: "superseded";
			attempt: number;
			recovery: AssistantRetryRecoveryKind;
			note: string;
	  };

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	/** Estimated prompt tokens removed by local history rewrites after this provider snapshot was recorded. */
	historyRewriteTokensRemoved?: number;
	/**
	 * Compaction epoch current when this snapshot's provider request was recorded.
	 * A later compaction bumps the session epoch, so an anchor whose epoch is
	 * older than the current in-flight snapshot describes pre-compaction history
	 * and must not override the rebased estimate.
	 */
	compactionEpoch?: number;
	lastMessageTimestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (
		| TextContent
		| ThinkingContent
		| RedactedThinkingContent
		| AnthropicFallbackContent
		| AnthropicServerToolContent
		| ImageContent
		| ToolCall
	)[];
	api: Api;
	provider: Provider;
	model: string;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	/** Provider-reported concrete model when a router selected one for this turn. */
	upstreamModel?: string;
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Stable recovery-classification text when errorMessage includes display-only diagnostics. */
	errorClassificationMessage?: string;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-reported input rewrites such as dropped bound-thinking blocks. */
	inputTransformations?: ProviderInputTransformation[];
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/** Local wall-clock time the response finished streaming (ms since epoch); stamped by the session at message_end so prompt→yield timing never depends on provider-reported duration. */
	completedAt?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/** Provider-native metadata required to faithfully replay this result. */
	providerMetadata?: ToolResultProviderMetadata;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

/**
 * Optional rewrite of a Cursor exec-channel tool result.
 * May return a Promise. Returning `undefined` keeps the original result.
 *
 * The Agent reserves the original result in its buffer before awaiting this
 * hook, and the `message_end` drain waits for a still-pending rewrite, so an
 * async transformer is honored even when the turn closes in the same chunk.
 * A rejecting transformer is swallowed and the reserved payload stands in.
 */
export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

/**
 * Identifies the synthesized assistant block a Cursor exec call was filed
 * under, so paths that produce no handler `toolResult` can still pair one.
 */
export interface CursorExecPairing {
	toolCallId: string;
	toolName: string;
}

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
	/**
	 * The frame asks only whether this call would be permitted — it must not
	 * run. The server sends it to resolve a smart-mode approval decision ahead
	 * of the real invocation, and answers with the dedicated `approved`
	 * variant, so executing here would fire a side-effecting tool the user has
	 * not yet been asked about (and fire it twice once the real call arrives).
	 */
	approvalOnly?: boolean;
}

export interface CursorTodoSnapshotItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

/**
 * Authoritative todo list state settled by Cursor's server-side
 * `update_todos` / `read_todos` tools.
 */
export interface CursorTodoSnapshot {
	todos: CursorTodoSnapshotItem[];
	/** True when the server reported the update as a merge. Presentation only. */
	merged: boolean;
}

/**
 * Settles a native todo call in the host.
 *
 * Called for every completed native todo call, not just successful ones: the
 * interactive todo card only resolves on a matching `tool_execution_end`, so a
 * refused or failed call that stayed silent would animate forever.
 *
 * `snapshot` is the server-confirmed list, or `null` when there is nothing to
 * mirror — a server error (`error` set), or a benign refusal with `error` null:
 * a filtered, truncated, or empty read, or a snapshot the local model cannot
 * represent (two rows sharing content). Local state MUST be left untouched
 * unless a snapshot is supplied.
 *
 * `toolCallId` is the id of the streamed native call, which is also the key the
 * interactive transcript filed the visible block under. The host MUST reuse it
 * when emitting the synthetic completion, or that block never resolves.
 *
 * Returns the result to persist for that block — always, since every settle
 * needs a paired result or `buildSessionContext` strips the block as dangling.
 * Only the host knows the phase grouping the todo renderer replays from, so the
 * provider persists this value verbatim. When no handler is registered at all,
 * the provider falls back to its own summary-only result.
 */
export type CursorTodoSyncHandler = (
	snapshot: CursorTodoSnapshot | null,
	toolCallId: string,
	error: string | null,
) => ToolResultMessage;

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

/**
 * A modern Pi exec frame plus the call id the dispatcher minted for it.
 *
 * Unlike the legacy exec args (`ReadArgs`, `ShellArgs`, ...), the Pi frames
 * carry no `tool_call_id` field: on modern builds the id rides the streamed
 * `ToolCall` envelope (`ToolCall.tool_call_id = 57`) instead of each variant's
 * args. The exec channel has no access to that envelope, so the dispatcher
 * mints an id and hands it to the handler, keeping the synthesized transcript
 * block and its paired `toolResult` on the same key.
 */
export interface CursorPiCall<TArgs> {
	args: TArgs;
	toolCallId: string;
}

/** One resource a host's MCP servers advertise. */
export interface CursorMcpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	/** The server advertising it; Cursor addresses reads by this name. */
	server: string;
}

/**
 * The content of one resource read.
 *
 * `text` and `blob` are the wire's content oneof: exactly one is sent, with
 * `text` winning when a host supplies both. A download instead sets
 * `downloadPath` and no content at all — the model is told where the file
 * landed rather than being handed its bytes.
 */
export interface CursorMcpResourceContent {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	text?: string;
	blob?: Uint8Array;
	/**
	 * Where the host wrote the resource, workspace-relative, when the frame
	 * asked for a download. Set this INSTEAD of `text`/`blob`: the wire
	 * contract is that a download returns no content to the model.
	 */
	downloadPath?: string;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (args: DiagnosticsArgs) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
	/**
	 * Answers "would this MCP call be permitted", without running it.
	 *
	 * A modern `mcpArgs` frame carrying `smart_mode_approval_only` asks for the
	 * permission decision alone, ahead of the real invocation. Executing the
	 * tool to answer it would fire a side effect the user never approved — and
	 * fire it twice once the real call arrives.
	 *
	 * `true` only when the host's policy resolves to a definite allow. A pending
	 * prompt is `false`: it can only be answered interactively at execution
	 * time, and there is no "ask me later" reply in this frame's result. When no
	 * handler is registered the provider refuses, since it cannot decide.
	 */
	mcpApprovalPreflight?: (call: CursorMcpCall) => Promise<boolean>;
	/**
	 * Modern Cursor CLI Pi tool frames (`ExecServerMessage` 45-51). They are a
	 * distinct frame family from the legacy `readArgs`/`shellArgs`/... set, not
	 * an alias: different args, different result oneofs, and no `tool_call_id`.
	 */
	piRead?: (call: CursorPiCall<PiReadExecArgs>) => Promise<CursorExecHandlerResult<PiReadExecResult>>;
	piBash?: (call: CursorPiCall<PiBashExecArgs>) => Promise<CursorExecHandlerResult<PiBashExecResult>>;
	piEdit?: (call: CursorPiCall<PiEditExecArgs>) => Promise<CursorExecHandlerResult<PiEditExecResult>>;
	piWrite?: (call: CursorPiCall<PiWriteExecArgs>) => Promise<CursorExecHandlerResult<PiWriteExecResult>>;
	piGrep?: (call: CursorPiCall<PiGrepExecArgs>) => Promise<CursorExecHandlerResult<PiGrepExecResult>>;
	piFind?: (call: CursorPiCall<PiFindExecArgs>) => Promise<CursorExecHandlerResult<PiFindExecResult>>;
	piLs?: (call: CursorPiCall<PiLsExecArgs>) => Promise<CursorExecHandlerResult<PiLsExecResult>>;
	/**
	 * The resources the host's MCP servers advertise, optionally filtered to one
	 * server. Without a handler the provider answers an empty catalog, which
	 * hides resources a host is in fact holding live connections to.
	 */
	listMcpResources?: (args: { server?: string }) => Promise<CursorMcpResource[]>;
	/**
	 * Read one resource. `null` means the server or uri is genuinely unknown,
	 * which the provider answers as `not_found`; throwing surfaces as `error`.
	 */
	readMcpResource?: (args: {
		server: string;
		uri: string;
		/**
		 * When set, write the resource here (workspace-relative) and return
		 * `downloadPath` instead of content.
		 */
		downloadPath?: string;
	}) => Promise<CursorMcpResourceContent | null>;
	/** Mirror Cursor's server-owned todo list into local session state. */
	todoSync?: CursorTodoSyncHandler;
	onToolResult?: CursorToolResultHandler;
}

/**
 * Plain JSON Schema document used by extension-authored tools (legacy TypeBox
 * emits this shape). Distinguished from arktype at runtime.
 */
export type TJsonSchema = Record<string, unknown>;

/**
 * Schema type accepted by the {@link Tool} interface.
 *
 * Canonical authoring uses ArkType. Extension compat may supply a JSON Schema
 * object (including TypeBox static schema objects).
 */
export type TSchema = Type | TJsonSchema;

/** Resolve parameter types for tool execution / handlers. */
export type Static<S> = S extends Type ? S["infer"] : S extends { static: infer T } ? T : unknown;

export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/**
	 * Optional grammar constraint for OpenAI custom-tool emission.
	 * When set, providers that support grammar-constrained tools (currently only
	 * `openai-responses` against models with the right capability flag) may emit
	 * this tool as `{type: "custom", format: {type: "grammar", …}}` instead of a
	 * JSON function tool. Other providers ignore the field.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Optional wire-level name used when this tool is emitted as a custom tool
	 * (e.g. OpenAI's `{type: "custom"}` shape). Models trained on specific tool
	 * names — like GPT-5 on `apply_patch` — need to see that exact name on the
	 * wire, but it may differ from the harness-internal `name`. The agent-loop
	 * dispatcher matches both `name` and `customWireName` so returned tool
	 * calls route correctly. Absent for regular JSON function tools.
	 */
	customWireName?: string;
	/** Selects a provider-native hosted tool instead of a JSON-schema function tool. */
	native?: NativeToolMarker;
	/**
	 * Illustrative calls/notes; the AI layer renders them into an `<examples>`
	 * block in the model's native tool-call syntax and appends to the wire
	 * description. Author `call`/`bad`/`good` as plain argument objects WITHOUT
	 * `i` — when intent tracing injects `i` into the schema, the renderer adds
	 * a placeholder `i` automatically. Type each tool's `examples` against its
	 * own schema (e.g. `readonly ToolExample<typeof schema["type"]>[]`).
	 */
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
