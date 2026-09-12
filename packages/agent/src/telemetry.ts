/**
 * OpenTelemetry instrumentation for the agent loop.
 *
 * Implements the OpenTelemetry GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/) plus `pi.gen_ai.*`
 * extension attributes for run summaries, dashboard summaries, and cost hints
 * that are useful to downstream observability UIs.
 *
 * Span hierarchy emitted by the loop:
 *
 *   invoke_agent {agent.name}         (one per runLoop, gen_ai.operation.name=invoke_agent)
 *   ├── chat {model}                  (one per LLM call, gen_ai.operation.name=chat)
 *   ├── execute_tool {tool.name}      (one per tool call, gen_ai.operation.name=execute_tool)
 *   └── ...
 *
 * The `handoff` operation is emitted via the public {@link recordHandoff}
 * helper for hosts that route work between named agents.
 *
 * Activation is opt-in: callers pass an {@link AgentTelemetryConfig} on
 * `AgentLoopConfig.telemetry`. When unset, every helper short-circuits and
 * the loop performs zero tracer lookups. When set but no OTEL SDK is
 * registered, `@opentelemetry/api` returns a no-op tracer and all calls are
 * cheap pass-throughs.
 */

import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	type OneshotRetryOptions,
	retryTransientCompletion,
	type ServiceTier,
	type SimpleStreamOptions,
	type StopReason,
	shouldSendServiceTier,
	type ToolChoice,
	type Usage,
} from "@oh-my-pi/pi-ai";
import {
	type Attributes,
	type AttributeValue,
	context,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { AgentRunCollector, type AgentRunCoverage, type AgentRunSummary, type ToolStatus } from "./run-collector";
import type { AgentTool } from "./types";
import { EventLoopKeepalive } from "./utils/yield";

/** Default tracer name. Override via {@link AgentTelemetryConfig.tracerName}. */
export const DEFAULT_TRACER_NAME = "@oh-my-pi/pi-agent-core";

/** Env var matching the OTEL semconv content-capture toggle. */
const CONTENT_CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

const MAX_TELEMETRY_ARRAY_ITEMS = 64;
const MAX_TELEMETRY_MESSAGE_COUNT = 16;
const MAX_TELEMETRY_OBJECT_DEPTH = 3;
const MAX_TELEMETRY_OBJECT_KEYS = 12;
const MAX_TELEMETRY_TEXT_CHARS = 240;

/**
 * GenAI semantic-convention attribute keys grouped by operation. Hoisted so
 * call sites stay typo-proof and easy to grep.
 */
export const enum GenAIAttr {
	// Common identifiers
	ProviderName = "gen_ai.provider.name",
	OperationName = "gen_ai.operation.name",
	ConversationId = "gen_ai.conversation.id",
	OutputType = "gen_ai.output.type",
	// Agent identity
	AgentId = "gen_ai.agent.id",
	AgentName = "gen_ai.agent.name",
	AgentDescription = "gen_ai.agent.description",
	// Request shape
	RequestModel = "gen_ai.request.model",
	RequestMaxTokens = "gen_ai.request.max_tokens",
	RequestTemperature = "gen_ai.request.temperature",
	RequestTopP = "gen_ai.request.top_p",
	RequestTopK = "gen_ai.request.top_k",
	RequestFrequencyPenalty = "gen_ai.request.frequency_penalty",
	RequestPresencePenalty = "gen_ai.request.presence_penalty",
	RequestStopSequences = "gen_ai.request.stop_sequences",
	RequestSeed = "gen_ai.request.seed",
	RequestChoiceCount = "gen_ai.request.choice.count",
	RequestStream = "gen_ai.request.stream",
	// Response shape
	ResponseModel = "gen_ai.response.model",
	ResponseId = "gen_ai.response.id",
	ResponseFinishReasons = "gen_ai.response.finish_reasons",
	ResponseTimeToFirstChunk = "gen_ai.response.time_to_first_chunk",
	// Usage
	UsageInputTokens = "gen_ai.usage.input_tokens",
	UsageOutputTokens = "gen_ai.usage.output_tokens",
	UsageCacheReadInputTokens = "gen_ai.usage.cache_read.input_tokens",
	UsageCacheCreationInputTokens = "gen_ai.usage.cache_creation.input_tokens",
	UsageReasoningOutputTokens = "gen_ai.usage.reasoning.output_tokens",
	// Tools
	ToolCallId = "gen_ai.tool.call.id",
	ToolName = "gen_ai.tool.name",
	ToolDescription = "gen_ai.tool.description",
	ToolType = "gen_ai.tool.type",
	ToolCallArguments = "gen_ai.tool.call.arguments",
	ToolCallResult = "gen_ai.tool.call.result",
	ToolDefinitions = "gen_ai.tool.definitions",
	// Content capture (opt-in)
	InputMessages = "gen_ai.input.messages",
	OutputMessages = "gen_ai.output.messages",
	SystemInstructions = "gen_ai.system_instructions",
	// Errors
	ErrorType = "error.type",
}

/** OpenAI semantic-convention attribute keys. */
export const enum OpenAIAttr {
	RequestServiceTier = "openai.request.service_tier",
	ResponseServiceTier = "openai.response.service_tier",
}

/** Project extension attributes. Kept out of the reserved `gen_ai.*` namespace. */
export const enum PiGenAIAttr {
	AgentStepNumber = "pi.gen_ai.agent.step.number",
	AgentStepCount = "pi.gen_ai.agent.step.count",
	RequestReasoningEffort = "pi.gen_ai.request.reasoning.effort",
	RequestToolChoice = "pi.gen_ai.request.tool.choice",
	RequestAvailableTools = "pi.gen_ai.request.available_tools",
	RequestMessages = "pi.gen_ai.request.messages",
	ResponseText = "pi.gen_ai.response.text",
	ResponseToolCalls = "pi.gen_ai.response.tool_calls",
	ResponseUpstreamProvider = "pi.gen_ai.response.upstream_provider",
	UsageTotalTokens = "pi.gen_ai.usage.total_tokens",
	UsageServerSideTools = "pi.gen_ai.usage.server_tool_requests",
	CostEstimatedUsd = "pi.gen_ai.cost.estimated_usd",
	CostInputUsd = "pi.gen_ai.cost.input_usd",
	CostOutputUsd = "pi.gen_ai.cost.output_usd",
	CostUnavailableReason = "pi.gen_ai.cost.unavailable_reason",
	ToolStatus = "pi.gen_ai.tool.status",
	ToolCallIntent = "pi.gen_ai.tool.call.intent",
	HandoffFromAgentName = "pi.gen_ai.handoff.from_agent.name",
	HandoffFromAgentId = "pi.gen_ai.handoff.from_agent.id",
	HandoffToAgentName = "pi.gen_ai.handoff.to_agent.name",
	HandoffToAgentId = "pi.gen_ai.handoff.to_agent.id",
	// Marks chat spans emitted outside the agent loop (compaction, handoff, branch
	// summary, image inspection, …). Lets dashboards split oneshot cost / latency
	// from main-turn cost without overloading the semconv `gen_ai.operation.name`.
	OneshotKind = "pi.gen_ai.oneshot.kind",
	// Gateway / proxy (LiteLLM, Helicone, Portkey, …) — populated when a known
	// gateway header pattern is detected on the upstream response. The base
	// `gen_ai.provider.name` continues to track the *upstream* provider (e.g.
	// `anthropic`) that the gateway routed to.
	GatewayName = "pi.gen_ai.gateway.name",
	GatewayEndpoint = "pi.gen_ai.gateway.endpoint",
	GatewayCallId = "pi.gen_ai.gateway.call_id",
	GatewayRoutedTo = "pi.gen_ai.gateway.routed_to",
	/** Cloudflare AI Gateway response-cache status (`cf-aig-cache-status`), never prompt-cache. */
	GatewayResponseCacheStatus = "pi.gen_ai.gateway.response_cache.status",
}

/** GenAI operation names — values for {@link GenAIAttr.OperationName}. */
export const GenAIOperation = {
	Chat: "chat",
	ExecuteTool: "execute_tool",
	InvokeAgent: "invoke_agent",
	Handoff: "handoff",
	GenerateContent: "generate_content",
	TextCompletion: "text_completion",
	CreateAgent: "create_agent",
	Embeddings: "embeddings",
} as const;

export type GenAIOperationName = (typeof GenAIOperation)[keyof typeof GenAIOperation];

/** Identifies which agent span a callback is reporting on. */
export type TelemetrySpanKind = "invoke_agent" | "chat" | "execute_tool" | "handoff";

/**
 * Aggregated usage + cost surface passed to {@link AgentTelemetryConfig.costEstimator}.
 * Mirrors the bucketed shape we already emit as span attributes so the
 * estimator never has to re-derive cache-read vs cache-write breakdowns.
 */
export interface ChatUsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cachedInputTokens: number | undefined;
	readonly cacheWriteTokens: number | undefined;
	readonly reasoningOutputTokens: number | undefined;
}

/** Context passed to the cost estimator. */
export interface CostEstimatorContext {
	readonly provider: string;
	readonly model: string;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
}

/**
 * Cost estimator result.
 *   { usd: number }                — cost is known; emitted as pi.gen_ai.cost.estimated_usd
 *   { unavailable: string }        — cost is intentionally unknown; emitted as
 *                                    pi.gen_ai.cost.unavailable_reason
 *   undefined                      — no opinion; nothing emitted
 */
export type CostEstimate =
	| { readonly usd: number; readonly inputUsd?: number; readonly outputUsd?: number }
	| { readonly unavailable: string };

export interface CostDelta {
	readonly conversationId: string | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly stepNumber: number | undefined;
	readonly provider: string;
	readonly model: string;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
	readonly costUsd: number | undefined;
	readonly inputUsd: number | undefined;
	readonly outputUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
}

/**
 * Event fired for every chat step that produced usage, regardless of whether
 * a {@link AgentTelemetryConfig.costEstimator} is configured. Use this to
 * forward token usage to metrics pipelines or dashboards without taking a
 * dependency on the cost estimator path.
 */
export interface ChatUsageEvent {
	readonly span: Span;
	readonly agent: AgentIdentity | undefined;
	readonly conversationId: string | undefined;
	readonly stepNumber: number | undefined;
	readonly model: string;
	readonly provider: string | undefined;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
	readonly cost: CostEstimate | undefined;
	/** Resolved dynamic attributes for this chat span (from `resolveAttributes`). */
	readonly attributes: Attributes | undefined;
	/**
	 * Response headers captured from the upstream HTTP response, with keys
	 * lowercased (mirrors {@link ProviderResponseMetadata.headers}). `undefined`
	 * when the provider transport did not surface headers (non-HTTP providers,
	 * mocked streams, requests that aborted before headers arrived).
	 *
	 * Use this to reconcile gateway-issued ids (e.g. `x-litellm-call-id`) with
	 * downstream billing / spend dashboards. Known gateway patterns are also
	 * auto-stamped on the chat span as `pi.gen_ai.gateway.*` attributes.
	 */
	readonly headers: Readonly<Record<string, string>> | undefined;
}

export type TelemetryContentCapture = boolean | "none" | "summary" | "full";

export type ResolvedTelemetryContentCapture = "none" | "summary" | "full";

export interface TelemetryContentSerializer {
	readonly requestMessages?: (request: ChatRequestSnapshot) => string | undefined;
	readonly responseText?: (message: AssistantMessage) => string | undefined;
	readonly responseToolCalls?: (message: AssistantMessage) => string | undefined;
	readonly toolCallArguments?: (args: unknown) => string | undefined;
	readonly toolCallResult?: (result: unknown) => string | undefined;
}

/** Identity recorded on every invoke_agent and on emitted handoff spans. */
export interface AgentIdentity {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AgentTelemetryWarning {
	readonly code:
		| "resolve_attributes_failed"
		| "content_serializer_failed"
		| "on_cost_delta_failed"
		| "on_chat_usage_failed"
		| "cost_estimator_failed"
		| "on_run_end_failed"
		| "on_span_start_failed"
		| "on_span_end_failed"
		| "normalize_agent_name_failed"
		| "normalize_provider_failed"
		| "on_telemetry_warning_failed";
	readonly message: string;
	readonly error?: unknown;
}

/** Context passed to attribute resolvers and lifecycle hooks. */
export interface TelemetryAttributeContext {
	readonly kind: TelemetrySpanKind;
	readonly model: Model | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly conversationId: string | undefined;
	/** Per-step number on chat spans (0-indexed); undefined on other kinds. */
	readonly stepNumber?: number;
	/** Tool call info on execute_tool spans. */
	readonly toolCallId?: string;
	readonly toolName?: string;
}

/** Context passed to {@link AgentTelemetryConfig.onSpanStart} / `onSpanEnd`. */
export interface TelemetryHookContext extends TelemetryAttributeContext {
	readonly span: Span;
}
/**
 * Opt-in OpenTelemetry configuration accepted by the agent loop.
 *
 * All fields are optional. Passing the empty object `{}` enables
 * instrumentation with sensible defaults. Pass `undefined` (or omit the
 * `telemetry` field entirely) to disable everything — the loop performs zero
 * tracer lookups in that case.
 */
export interface AgentTelemetryConfig {
	/**
	 * Override the tracer instance. When omitted, the loop calls
	 * `trace.getTracer(tracerName ?? DEFAULT_TRACER_NAME)` lazily on first use.
	 */
	readonly tracer?: Tracer;
	/** Override the tracer name passed to `trace.getTracer`. */
	readonly tracerName?: string;
	/**
	 * Capture request/response content. `true` preserves the historical full
	 * payload capture; `"summary"` emits bounded dashboard-friendly summaries;
	 * `"full"` emits both summaries and full OTEL message payloads.
	 *
	 * Defaults to the value of the `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
	 * env var (`true`/`1`/`yes` => `"full"`, `"summary"` => `"summary"`).
	 */
	readonly captureMessageContent?: TelemetryContentCapture;
	/** Extra attributes merged onto every emitted span. */
	readonly attributes?: Attributes;
	/**
	 * Attribute resolver merged onto every emitted span after static
	 * `attributes` and before span-specific attributes. Use this for ambient
	 * run, tenant, deployment, or request metadata.
	 */
	readonly resolveAttributes?: (ctx: TelemetryAttributeContext) => Attributes | undefined;
	/** Agent identity stamped onto invoke_agent + propagated to children. */
	readonly agent?: AgentIdentity;
	/**
	 * Conversation identifier. When omitted, the loop falls back to
	 * `AgentLoopConfig.sessionId` for the `gen_ai.conversation.id` attribute.
	 */
	readonly conversationId?: string;
	/**
	 * Per-step cost estimator. Synchronous on purpose — runs inside the chat
	 * span's finish path. Return `undefined` to emit no cost attribute.
	 */
	readonly costEstimator?: (input: CostEstimatorContext) => CostEstimate | undefined;
	/** Called after cost estimation for a chat step. */
	readonly onCostDelta?: (delta: CostDelta) => void;
	/**
	 * Fired once per chat step that produced usage, regardless of whether a
	 * {@link costEstimator} is configured. Use this for usage-only metrics
	 * pipelines (token counters, cache-hit ratios) without paying the cost of
	 * estimating dollars per call.
	 *
	 * **Non-fatal.** Synchronous and asynchronous failures are caught, surfaced
	 * via {@link onTelemetryWarning}, and swallowed.
	 */
	readonly onChatUsage?: (event: ChatUsageEvent) => void | Promise<void>;
	/** Override provider labels before they are emitted or passed to cost hooks. */
	readonly normalizeProvider?: (provider: string | undefined) => string | undefined;
	/** Override agent names before they are emitted on spans. */
	readonly normalizeAgentName?: (name: string | undefined) => string | undefined;
	/** Override the default bounded JSON serializers used by summary capture. */
	readonly contentSerializer?: TelemetryContentSerializer;
	/**
	 * Called immediately after a span starts. Use to stamp request-side
	 * context (user id, deployment id, route name) without forking the loop.
	 */
	readonly onSpanStart?: (ctx: TelemetryHookContext) => void;
	/**
	 * Called just before `span.end()`. Use to stamp response-side context
	 * that depends on the final result.
	 */
	readonly onSpanEnd?: (ctx: TelemetryHookContext) => void;
	/**
	 * Fired once per `invoke_agent`, immediately after the run-level summary
	 * is built and aggregate attributes are stamped on the `invoke_agent`
	 * span. Use this to persist, log, or forward the {@link AgentRunSummary} /
	 * {@link AgentRunCoverage} value without parsing OTEL spans.
	 *
	 * **Non-fatal.** Exceptions thrown from this callback are caught, logged
	 * via `console.warn`, and swallowed — a misbehaving telemetry consumer can
	 * NEVER turn a successful agent run into a failed one.
	 */
	readonly onRunEnd?: (summary: AgentRunSummary, coverage: AgentRunCoverage) => void;
	/** Receives non-fatal telemetry callback failures and host-defined warnings. */
	readonly onTelemetryWarning?: (warning: AgentTelemetryWarning) => void;
}

/**
 * Public handle used internally to thread the resolved tracer + config
 * through the loop. Constructed once per `agentLoop` invocation.
 */
export interface AgentTelemetry {
	readonly config: AgentTelemetryConfig;
	readonly tracer: Tracer;
	readonly captureMessageContent: boolean;
	readonly contentCapture: ResolvedTelemetryContentCapture;
	readonly conversationId: string | undefined;
	readonly agent: AgentIdentity | undefined;
	/** Per-invocation event collector. See {@link AgentRunCollector}. */
	readonly collector: AgentRunCollector;
}

/** Lazily resolve the {@link AgentTelemetry} handle. Returns `undefined` when disabled. */
export function resolveTelemetry(
	config: AgentTelemetryConfig | undefined,
	sessionId: string | undefined,
): AgentTelemetry | undefined {
	if (!config) return undefined;
	const tracer = config.tracer ?? trace.getTracer(config.tracerName ?? DEFAULT_TRACER_NAME);
	const contentCapture = resolveContentCapture(config.captureMessageContent);
	return {
		config,
		tracer,
		captureMessageContent: contentCapture === "full",
		contentCapture,
		conversationId: config.conversationId ?? sessionId,
		agent: config.agent,
		collector: new AgentRunCollector(),
	};
}

let contentCaptureEnvCache: ResolvedTelemetryContentCapture | undefined;
function readContentCaptureEnv(): ResolvedTelemetryContentCapture {
	if (contentCaptureEnvCache !== undefined) return contentCaptureEnvCache;
	const raw = process.env[CONTENT_CAPTURE_ENV];
	if (!raw) {
		contentCaptureEnvCache = "none";
		return "none";
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "summary") {
		contentCaptureEnvCache = "summary";
	} else {
		contentCaptureEnvCache =
			normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "full" ? "full" : "none";
	}
	return contentCaptureEnvCache;
}

function resolveContentCapture(value: TelemetryContentCapture | undefined): ResolvedTelemetryContentCapture {
	const capture = value ?? readContentCaptureEnv();
	if (capture === true || capture === "full") return "full";
	if (capture === "summary") return "summary";
	return "none";
}

/**
 * Start a span with the standard attribute envelope (provider, operation,
 * conversation, agent identity, user-supplied extras) pre-applied. Returns
 * `undefined` when telemetry is disabled.
 */
function startSpan(
	telemetry: AgentTelemetry | undefined,
	kind: TelemetrySpanKind,
	name: string,
	options: {
		readonly spanKind: SpanKind;
		readonly model?: Model;
		readonly parent?: Span;
		readonly attributes?: Attributes;
		readonly stepNumber?: number;
		readonly toolCallId?: string;
		readonly toolName?: string;
	},
): Span | undefined {
	if (!telemetry) return undefined;
	const attrCtx = buildTelemetryAttributeContext(telemetry, kind, options);
	const attrs: Attributes = {};
	const operation = kindToOperation(kind);
	if (operation) attrs[GenAIAttr.OperationName] = operation;
	if (options.model) {
		attrs[GenAIAttr.RequestModel] = options.model.id;
		const provider = normalizeProviderName(telemetry, options.model.provider);
		if (provider) attrs[GenAIAttr.ProviderName] = provider;
	}
	if (telemetry.conversationId) {
		attrs[GenAIAttr.ConversationId] = telemetry.conversationId;
	}
	if (attrCtx.agent) applyAgentAttributes(attrs, attrCtx.agent);
	if (telemetry.config.attributes) Object.assign(attrs, telemetry.config.attributes);
	const dynamicAttributes = resolveDynamicAttributes(telemetry, attrCtx);
	if (dynamicAttributes) Object.assign(attrs, dynamicAttributes);
	if (options.attributes) Object.assign(attrs, options.attributes);

	const ctx = options.parent ? trace.setSpan(context.active(), options.parent) : context.active();
	const span = telemetry.tracer.startSpan(name, { kind: options.spanKind, attributes: attrs }, ctx);
	safeOnSpanStart(telemetry, { ...attrCtx, span });
	return span;
}

function buildTelemetryAttributeContext(
	telemetry: AgentTelemetry,
	kind: TelemetrySpanKind,
	options: {
		readonly model?: Model;
		readonly stepNumber?: number;
		readonly toolCallId?: string;
		readonly toolName?: string;
	},
): TelemetryAttributeContext {
	return {
		kind,
		model: options.model,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		stepNumber: options.stepNumber,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	};
}

function resolveDynamicAttributes(telemetry: AgentTelemetry, ctx: TelemetryAttributeContext): Attributes | undefined {
	const resolver = telemetry.config.resolveAttributes;
	if (!resolver) return undefined;
	try {
		return resolver(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "resolve_attributes_failed",
			message: "resolveAttributes threw; ignoring dynamic telemetry attributes",
			error: err,
		});
		return undefined;
	}
}

function kindToOperation(kind: TelemetrySpanKind): GenAIOperationName | undefined {
	switch (kind) {
		case "invoke_agent":
			return GenAIOperation.InvokeAgent;
		case "chat":
			return GenAIOperation.Chat;
		case "execute_tool":
			return GenAIOperation.ExecuteTool;
		case "handoff":
			return GenAIOperation.Handoff;
	}
}

function applyAgentAttributes(attrs: Attributes, agent: AgentIdentity): void {
	if (agent.id) attrs[GenAIAttr.AgentId] = agent.id;
	if (agent.name) attrs[GenAIAttr.AgentName] = agent.name;
	if (agent.description) attrs[GenAIAttr.AgentDescription] = agent.description;
}

function normalizeProviderName(
	telemetry: AgentTelemetry | undefined,
	provider: string | undefined,
): string | undefined {
	const otelProvider = mapProviderNameToOtel(provider);
	const normalize = telemetry?.config.normalizeProvider;
	if (!normalize) return otelProvider;
	try {
		return normalize(provider) ?? otelProvider;
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "normalize_provider_failed",
			message: "normalizeProvider threw; using the OTEL provider label",
			error: err,
		});
		return otelProvider;
	}
}

function mapProviderNameToOtel(provider: string | undefined): string | undefined {
	switch (provider) {
		case undefined:
		case "":
			return provider;
		case "amazon-bedrock":
			return "aws.bedrock";
		case "google":
		case "google-antigravity":
		case "google-gemini-cli":
			return "gcp.gemini";
		case "google-vertex":
			return "gcp.vertex_ai";
		case "mistral":
			return "mistral_ai";
		case "openai-codex":
			return "openai";
		case "xai":
			return "x_ai";
		default:
			return provider;
	}
}

function normalizeAgentIdentity(telemetry: AgentTelemetry, agent: AgentIdentity): AgentIdentity {
	const normalize = telemetry.config.normalizeAgentName;
	if (!normalize || !agent.name) return agent;
	try {
		const name = normalize(agent.name);
		if (name === agent.name) return agent;
		return {
			...agent,
			name,
		};
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "normalize_agent_name_failed",
			message: "normalizeAgentName threw; using the original agent name",
			error: err,
		});
		return agent;
	}
}

function normalizedTelemetryAgent(telemetry: AgentTelemetry | undefined): AgentIdentity | undefined {
	return telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent) : undefined;
}

export function recordTelemetryWarning(telemetry: AgentTelemetry | undefined, warning: AgentTelemetryWarning): void {
	emitTelemetryWarning(telemetry, warning);
}

function emitTelemetryWarning(telemetry: AgentTelemetry | undefined, warning: AgentTelemetryWarning): void {
	const hook = telemetry?.config.onTelemetryWarning;
	if (!hook) {
		if (warning.error === undefined) console.warn(`[pi-agent] ${warning.message}`);
		else console.warn(`[pi-agent] ${warning.message}`, warning.error);
		return;
	}
	try {
		hook(warning);
	} catch (err) {
		console.warn("[pi-agent] onTelemetryWarning threw; swallowing:", err);
	}
}

function safeOnSpanStart(telemetry: AgentTelemetry | undefined, ctx: TelemetryHookContext): void {
	const hook = telemetry?.config.onSpanStart;
	if (!hook) return;
	try {
		hook(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_span_start_failed",
			message: "onSpanStart threw; swallowing telemetry hook failure",
			error: err,
		});
	}
}

function safeOnSpanEnd(telemetry: AgentTelemetry | undefined, ctx: TelemetryHookContext): void {
	const hook = telemetry?.config.onSpanEnd;
	if (!hook) return;
	try {
		hook(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_span_end_failed",
			message: "onSpanEnd threw; swallowing telemetry hook failure",
			error: err,
		});
	}
}

/**
 * Start the outer `invoke_agent` span that wraps a full `runLoop` invocation.
 * Returns `undefined` when telemetry is disabled.
 */
export function startInvokeAgentSpan(telemetry: AgentTelemetry | undefined, model: Model): Span | undefined {
	const agentName = telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent).name : undefined;
	const name = agentName ? `invoke_agent ${agentName}` : "invoke_agent";
	return startSpan(telemetry, "invoke_agent", name, { spanKind: SpanKind.INTERNAL, model });
}

/** Stamp the final step count on the `invoke_agent` span. */
export function applyInvokeAgentFinish(span: Span | undefined, stepCount: number): void {
	if (!span) return;
	span.setAttribute(PiGenAIAttr.AgentStepCount, stepCount);
}

/**
 * Start a `chat` span representing one provider call. Parented under the
 * supplied `invoke_agent` span (or whatever is active if none is passed).
 */
export function startChatSpan(
	telemetry: AgentTelemetry | undefined,
	model: Model,
	options: {
		readonly parent?: Span;
		readonly stepNumber: number;
		readonly request: ChatRequestSnapshot;
	},
): Span | undefined {
	const span = startSpan(telemetry, "chat", `chat ${model.id}`, {
		spanKind: SpanKind.CLIENT,
		model,
		parent: options.parent,
		stepNumber: options.stepNumber,
		attributes: buildChatRequestAttributes(options.stepNumber, options.request, model.provider),
	});
	if (span) {
		telemetry?.collector.beginChat(span, {
			stepNumber: options.stepNumber,
			model,
			provider: normalizeProviderName(telemetry, model.provider),
		});
		telemetry?.collector.noteAvailableTools(options.request.tools);
		if (telemetry && telemetry.contentCapture !== "none") {
			applyContentCaptureForRequest(telemetry, span, options.request);
		}
	}
	return span;
}

/** Mutable snapshot of every request-side field worth recording. */
export interface ChatRequestSnapshot {
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
	readonly topK?: number;
	readonly frequencyPenalty?: number;
	readonly presencePenalty?: number;
	readonly stopSequences?: readonly string[];
	readonly seed?: number;
	readonly serviceTier?: ServiceTier;
	readonly reasoningEffort?: string;
	readonly toolChoice?: ToolChoice;
	readonly tools?: readonly { readonly name: string }[];
	readonly systemPrompt?: string | readonly string[];
	readonly messages?: readonly Message[];
}

function buildChatRequestAttributes(stepNumber: number, request: ChatRequestSnapshot, provider: string): Attributes {
	const attrs: Attributes = {
		[PiGenAIAttr.AgentStepNumber]: stepNumber,
		[GenAIAttr.OutputType]: "text",
		[GenAIAttr.RequestStream]: true,
	};
	if (request.maxTokens != null) attrs[GenAIAttr.RequestMaxTokens] = request.maxTokens;
	if (request.temperature != null) attrs[GenAIAttr.RequestTemperature] = request.temperature;
	if (request.topP != null) attrs[GenAIAttr.RequestTopP] = request.topP;
	if (request.topK != null) attrs[GenAIAttr.RequestTopK] = request.topK;
	if (request.frequencyPenalty != null) attrs[GenAIAttr.RequestFrequencyPenalty] = request.frequencyPenalty;
	if (request.presencePenalty != null) attrs[GenAIAttr.RequestPresencePenalty] = request.presencePenalty;
	if (request.seed != null) attrs[GenAIAttr.RequestSeed] = request.seed;
	if (request.stopSequences && request.stopSequences.length > 0) {
		attrs[GenAIAttr.RequestStopSequences] = [...request.stopSequences];
	}
	if (request.serviceTier && shouldSendServiceTier(request.serviceTier, provider)) {
		attrs[OpenAIAttr.RequestServiceTier] = request.serviceTier;
	}
	if (request.reasoningEffort) attrs[PiGenAIAttr.RequestReasoningEffort] = request.reasoningEffort;
	const toolChoice = serializeToolChoice(request.toolChoice);
	if (toolChoice) attrs[PiGenAIAttr.RequestToolChoice] = toolChoice;
	if (request.tools && request.tools.length > 0) {
		attrs[PiGenAIAttr.RequestAvailableTools] = request.tools.map(tool => tool.name);
	}
	return attrs;
}

function serializeToolChoice(toolChoice: ToolChoice | undefined): string | undefined {
	if (toolChoice == null) return undefined;
	if (typeof toolChoice === "string") return toolChoice;
	if (typeof toolChoice === "object") {
		// `{ type: "tool", name: "foo" }` shapes used across providers.
		if ("name" in toolChoice && typeof toolChoice.name === "string") return toolChoice.name;
		if ("type" in toolChoice && typeof toolChoice.type === "string") return toolChoice.type;
	}
	return undefined;
}

function applyContentCaptureForRequest(telemetry: AgentTelemetry, span: Span, request: ChatRequestSnapshot): void {
	const requestMessages = serializeRequestMessagesForTelemetry(telemetry, request);
	if (requestMessages) span.setAttribute(PiGenAIAttr.RequestMessages, requestMessages);
	if (telemetry.contentCapture !== "full") return;
	const systemInstructions = serializeFullSystemInstructionsForTelemetry(request);
	if (systemInstructions) span.setAttribute(GenAIAttr.SystemInstructions, systemInstructions);
	const inputMessages = serializeFullInputMessagesForTelemetry(request);
	if (inputMessages) span.setAttribute(GenAIAttr.InputMessages, inputMessages);
}

function applyContentCaptureForResponse(telemetry: AgentTelemetry, span: Span, message: AssistantMessage): void {
	const responseText = serializeResponseTextForTelemetry(telemetry, message);
	if (responseText) span.setAttribute(PiGenAIAttr.ResponseText, responseText);
	const responseToolCalls = serializeResponseToolCallsForTelemetry(telemetry, message);
	if (responseToolCalls) span.setAttribute(PiGenAIAttr.ResponseToolCalls, responseToolCalls);
	if (telemetry.contentCapture === "full") {
		const outputMessages = serializeFullOutputMessagesForTelemetry(message);
		if (outputMessages) span.setAttribute(GenAIAttr.OutputMessages, outputMessages);
	}
}

function normalizeSystemPromptParts(systemPrompt: string | readonly string[] | undefined): readonly string[] {
	if (!systemPrompt) return [];
	return typeof systemPrompt === "string" ? [systemPrompt] : systemPrompt;
}

function serializeRequestMessagesForTelemetry(
	telemetry: AgentTelemetry,
	request: ChatRequestSnapshot,
): string | undefined {
	const serializer = telemetry.config.contentSerializer?.requestMessages;
	if (serializer) return callContentSerializer(telemetry, "requestMessages", () => serializer(request));
	const messages: TelemetryMessageSummary[] = [];
	for (const text of normalizeSystemPromptParts(request.systemPrompt))
		messages.push({ role: "system", content: summarizeTelemetryValue(text) });
	if (request.messages) {
		for (const message of request.messages) {
			messages.push({ role: message.role, content: summarizeTelemetryValue(message.content) });
		}
	}
	return messages.length === 0 ? undefined : stringifyJsonAttribute(limitTelemetryMessages(messages));
}

function serializeResponseTextForTelemetry(telemetry: AgentTelemetry, message: AssistantMessage): string | undefined {
	const serializer = telemetry.config.contentSerializer?.responseText;
	if (serializer) return callContentSerializer(telemetry, "responseText", () => serializer(message));
	const texts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") texts.push(part.text);
	}
	return texts.length === 0 ? undefined : stringifyJsonAttribute(summarizeTelemetryTexts(texts));
}

function serializeResponseToolCallsForTelemetry(
	telemetry: AgentTelemetry,
	message: AssistantMessage,
): string | undefined {
	const serializer = telemetry.config.contentSerializer?.responseToolCalls;
	if (serializer) return callContentSerializer(telemetry, "responseToolCalls", () => serializer(message));
	const toolCalls: TelemetryToolCallSummary[] = [];
	for (const part of message.content) {
		if (part.type === "toolCall") {
			toolCalls.push({
				input: summarizeTelemetryValue(part.arguments),
				toolCallId: part.id,
				toolName: part.name,
			});
		}
	}
	return toolCalls.length === 0 ? undefined : stringifyJsonAttribute(limitTelemetryToolCalls(toolCalls));
}

interface TelemetryMessageSummary {
	readonly role: string;
	readonly content: unknown;
}

interface TelemetryToolCallSummary {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

type OtelMessagePart =
	| { readonly type: "text"; readonly content: string }
	| { readonly type: "reasoning"; readonly content: string }
	| { readonly type: "blob"; readonly modality: "image"; readonly mime_type: string; readonly content: string }
	| { readonly type: "tool_call"; readonly id?: string; readonly name: string; readonly arguments?: unknown }
	| { readonly type: "tool_call_response"; readonly id?: string; readonly response: unknown }
	| { readonly type: string; readonly [key: string]: unknown };

interface OtelInputMessage {
	readonly role: string;
	readonly parts: readonly OtelMessagePart[];
	readonly name?: string;
}

interface OtelOutputMessage extends OtelInputMessage {
	readonly finish_reason: string;
}

function serializeFullSystemInstructionsForTelemetry(request: ChatRequestSnapshot): string | undefined {
	const systemPrompt = normalizeSystemPromptParts(request.systemPrompt);
	if (systemPrompt.length === 0) return undefined;
	return stringifyJsonAttribute(systemPrompt.map(text => ({ type: "text", content: text }) satisfies OtelMessagePart));
}

function serializeFullInputMessagesForTelemetry(request: ChatRequestSnapshot): string | undefined {
	const messages = request.messages;
	if (!messages || messages.length === 0) return undefined;
	return stringifyJsonAttribute(messages.map(messageToOtelInputMessage));
}

function serializeFullOutputMessagesForTelemetry(message: AssistantMessage): string | undefined {
	return stringifyJsonAttribute([assistantMessageToOtelOutputMessage(message)]);
}

function messageToOtelInputMessage(message: Message): OtelInputMessage {
	switch (message.role) {
		case "assistant":
			return { role: "assistant", parts: assistantContentToOtelParts(message.content) };
		case "toolResult":
			return {
				role: "tool",
				name: message.toolName,
				parts: [
					{
						type: "tool_call_response",
						id: message.toolCallId,
						response: {
							content: textOrImageContentToOtelParts(message.content),
							details: message.details,
							is_error: message.isError,
						},
					},
				],
			};
		default:
			return { role: message.role, parts: textOrImageContentToOtelParts(message.content) };
	}
}

function assistantMessageToOtelOutputMessage(message: AssistantMessage): OtelOutputMessage {
	return {
		role: "assistant",
		parts: assistantContentToOtelParts(message.content),
		finish_reason: mapStopReason(message.stopReason) ?? message.stopReason ?? "stop",
	};
}

function textOrImageContentToOtelParts(content: Message["content"]): OtelMessagePart[] {
	if (typeof content === "string") return [{ type: "text", content }];
	const parts: OtelMessagePart[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				parts.push({ type: "text", content: part.text });
				break;
			case "image":
				parts.push({ type: "blob", modality: "image", mime_type: part.mimeType, content: part.data });
				break;
			case "thinking":
				parts.push({ type: "reasoning", content: part.thinking });
				break;
			case "redactedThinking":
				parts.push({ type: "reasoning", content: part.data });
				break;
			case "toolCall":
				parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
				break;
			default:
				break;
		}
	}
	return parts;
}

function assistantContentToOtelParts(content: AssistantMessage["content"]): OtelMessagePart[] {
	const parts: OtelMessagePart[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				parts.push({ type: "text", content: part.text });
				break;
			case "image":
				parts.push({ type: "blob", modality: "image", mime_type: part.mimeType, content: part.data });
				break;
			case "thinking":
				parts.push({ type: "reasoning", content: part.thinking });
				break;
			case "redactedThinking":
				parts.push({ type: "reasoning", content: part.data });
				break;
			case "toolCall":
				parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
				break;
		}
	}
	return parts;
}

function callContentSerializer(
	telemetry: AgentTelemetry,
	name: keyof TelemetryContentSerializer,
	serialize: () => string | undefined,
): string | undefined {
	try {
		return serialize();
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "content_serializer_failed",
			message: `${name} content serializer threw; omitting telemetry content`,
			error: err,
		});
		return undefined;
	}
}

function limitTelemetryMessages(messages: readonly TelemetryMessageSummary[]): TelemetryMessageSummary[] {
	const limited = messages.slice(0, MAX_TELEMETRY_MESSAGE_COUNT);
	if (messages.length > MAX_TELEMETRY_MESSAGE_COUNT) {
		limited.push({
			role: "system",
			content: { kind: "truncated", omittedMessages: messages.length - MAX_TELEMETRY_MESSAGE_COUNT },
		});
	}
	return limited;
}

function limitTelemetryToolCalls(toolCalls: readonly TelemetryToolCallSummary[]): TelemetryToolCallSummary[] {
	const limited = toolCalls.slice(0, MAX_TELEMETRY_ARRAY_ITEMS);
	if (toolCalls.length > MAX_TELEMETRY_ARRAY_ITEMS) {
		limited.push({
			toolCallId: "[truncated]",
			toolName: "[truncated]",
			input: { kind: "truncated", omittedToolCalls: toolCalls.length - MAX_TELEMETRY_ARRAY_ITEMS },
		});
	}
	return limited;
}

function summarizeTelemetryTexts(texts: readonly string[]): string[] {
	const summarized = texts.slice(0, MAX_TELEMETRY_ARRAY_ITEMS).map(text => summarizeTelemetryText(text));
	if (texts.length > MAX_TELEMETRY_ARRAY_ITEMS) {
		summarized.push(`[${texts.length - MAX_TELEMETRY_ARRAY_ITEMS} additional text entries omitted]`);
	}
	return summarized;
}

function summarizeTelemetryText(text: string): string {
	if (text.length <= MAX_TELEMETRY_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TELEMETRY_TEXT_CHARS)} [${text.length - MAX_TELEMETRY_TEXT_CHARS} chars omitted]`;
}

function summarizeTelemetryValue(value: unknown, depth = 0, seen?: Set<object>): unknown {
	if (typeof value === "string") return summarizeTelemetryText(value);
	if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") return "[Function]";
	if (value instanceof Error) {
		return { name: value.name, message: summarizeTelemetryText(value.message) };
	}
	if (Array.isArray(value)) {
		// Cap array recursion at the same depth as plain-object recursion so
		// pathological nested-array shapes (or arrays containing themselves)
		// cannot blow the stack via `summarizeTelemetryValue`.
		if (depth >= MAX_TELEMETRY_OBJECT_DEPTH) {
			return { kind: "array", length: value.length };
		}
		const ancestors = seen ?? new Set<object>();
		if (ancestors.has(value)) return "[Circular]";
		ancestors.add(value);
		const items = value
			.slice(0, MAX_TELEMETRY_ARRAY_ITEMS)
			.map(item => summarizeTelemetryValue(item, depth + 1, ancestors));
		if (value.length > MAX_TELEMETRY_ARRAY_ITEMS) {
			items.push({ kind: "truncated", omittedItems: value.length - MAX_TELEMETRY_ARRAY_ITEMS });
		}
		ancestors.delete(value);
		return items;
	}
	if (!isPlainTelemetryRecord(value)) return String(value);
	const ancestors = seen ?? new Set<object>();
	if (ancestors.has(value)) return "[Circular]";
	const entries = Object.entries(value);
	if (depth >= MAX_TELEMETRY_OBJECT_DEPTH) {
		return summarizeTelemetryObjectKeys(entries);
	}
	ancestors.add(value);
	const summary: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, MAX_TELEMETRY_OBJECT_KEYS)) {
		summary[key] = summarizeTelemetryValue(item, depth + 1, ancestors);
	}
	if (entries.length > MAX_TELEMETRY_OBJECT_KEYS) {
		summary.telemetrySummary = { omittedKeys: entries.length - MAX_TELEMETRY_OBJECT_KEYS };
	}
	ancestors.delete(value);
	return summary;
}

function summarizeTelemetryObjectKeys(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	const keys = entries.slice(0, MAX_TELEMETRY_OBJECT_KEYS).map(([key]) => key);
	return entries.length > MAX_TELEMETRY_OBJECT_KEYS
		? { kind: "object", keys, telemetrySummary: { omittedKeys: entries.length - MAX_TELEMETRY_OBJECT_KEYS } }
		: { kind: "object", keys };
}

function isPlainTelemetryRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function stringifyJsonAttribute(value: unknown): string | undefined {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? undefined : serialized;
}

function serializeToolCallArgumentsForTelemetry(telemetry: AgentTelemetry, args: unknown): string | undefined {
	const serializer = telemetry.config.contentSerializer?.toolCallArguments;
	if (serializer) return callContentSerializer(telemetry, "toolCallArguments", () => serializer(args));
	return telemetry.contentCapture === "full" ? safeJson(args) : stringifyJsonAttribute(summarizeTelemetryValue(args));
}

function serializeToolCallResultForTelemetry(telemetry: AgentTelemetry, result: unknown): string | undefined {
	const serializer = telemetry.config.contentSerializer?.toolCallResult;
	if (serializer) return callContentSerializer(telemetry, "toolCallResult", () => serializer(result));
	return telemetry.contentCapture === "full"
		? safeJson(result)
		: stringifyJsonAttribute(summarizeTelemetryValue(result));
}

/**
 * Stamp the final response onto a chat span, fire the cost estimator hook,
 * and end the span. No-op when `span` is undefined.
 */
export async function finishChatSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	message: AssistantMessage,
	options: {
		readonly stepNumber: number;
		readonly serviceTier?: ServiceTier;
		readonly responseHeaders?: Readonly<Record<string, string>>;
		readonly baseUrl?: string;
	},
): Promise<void> {
	if (!span) return;
	applyChatResponseAttributes(span, message);
	applyUsageAttributes(span, message.usage);
	applyGatewayAttributes(span, options.responseHeaders, options.baseUrl);
	const cost = applyCostEstimate(telemetry, span, message, options.serviceTier, options.stepNumber);
	if (telemetry) {
		await emitChatUsage(telemetry, span, {
			model: message.model,
			provider: message.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: message.usage,
			applied: cost,
			headers: options.responseHeaders,
		}).catch(err => {
			emitTelemetryWarning(telemetry, {
				code: "on_chat_usage_failed",
				message: "onChatUsage rejected; swallowing telemetry callback failure",
				error: err,
			});
		});
	}
	if (telemetry && telemetry.contentCapture !== "none") {
		applyContentCaptureForResponse(telemetry, span, message);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "chat",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
		stepNumber: options.stepNumber,
	});
	applyTerminalStatus(span, message.stopReason, message.errorMessage);
	telemetry?.collector.endChat(span, message, cost);
	span.end();
}

/**
 * Record a chat that failed before producing a final `AssistantMessage`
 * (e.g. the provider stream threw mid-iteration). Mirrors `finishChatSpan`'s
 * span-end side effects and pushes a failed `ChatRecord` to the collector so
 * the run summary still reflects the failed step.
 */
export function failChatSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: {
		readonly errorObject: unknown;
		readonly errorType?: string;
		readonly responseHeaders?: Readonly<Record<string, string>>;
		readonly baseUrl?: string;
	},
): void {
	if (!span) return;
	applyGatewayAttributes(span, options.responseHeaders, options.baseUrl);
	const err = options.errorObject;
	if (err instanceof Error) {
		span.recordException(err);
		span.setAttribute(GenAIAttr.ErrorType, options.errorType ?? err.name ?? "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
	} else {
		span.setAttribute(GenAIAttr.ErrorType, options.errorType ?? "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
	}
	telemetry?.collector.failChat(span, {
		errorType: options.errorType ?? (err instanceof Error ? err.name || "Error" : "Error"),
	});
	span.end();
}

function applyChatResponseAttributes(span: Span, message: AssistantMessage): void {
	span.setAttribute(GenAIAttr.ResponseModel, message.model);
	if (message.responseId) span.setAttribute(GenAIAttr.ResponseId, message.responseId);
	if (message.upstreamProvider) {
		span.setAttribute(PiGenAIAttr.ResponseUpstreamProvider, message.upstreamProvider);
	}
	if (message.ttft != null) span.setAttribute(GenAIAttr.ResponseTimeToFirstChunk, message.ttft / 1000);
	const finishReason = mapStopReason(message.stopReason);
	if (finishReason) span.setAttribute(GenAIAttr.ResponseFinishReasons, [finishReason]);
}

function applyUsageAttributes(span: Span, usage: Usage | undefined): void {
	if (!usage) return;
	const cacheReadTokens = usage.cacheRead ?? 0;
	const cacheCreationTokens = usage.cacheWrite ?? 0;
	const inputTokens = (usage.input ?? 0) + cacheReadTokens + cacheCreationTokens;
	const outputTokens = usage.output ?? 0;
	span.setAttribute(GenAIAttr.UsageInputTokens, inputTokens);
	span.setAttribute(GenAIAttr.UsageOutputTokens, outputTokens);
	const total = usage.totalTokens ?? inputTokens + outputTokens;
	span.setAttribute(PiGenAIAttr.UsageTotalTokens, total);
	if (usage.cacheRead != null) span.setAttribute(GenAIAttr.UsageCacheReadInputTokens, usage.cacheRead);
	if (usage.cacheWrite != null) span.setAttribute(GenAIAttr.UsageCacheCreationInputTokens, usage.cacheWrite);
	if (usage.reasoningTokens != null) {
		span.setAttribute(GenAIAttr.UsageReasoningOutputTokens, usage.reasoningTokens);
	}
	if (usage.server) {
		const sums = (usage.server.webSearch ?? 0) + (usage.server.webFetch ?? 0);
		if (sums > 0) span.setAttribute(PiGenAIAttr.UsageServerSideTools, sums);
	}
}

/**
 * Result of {@link detectGatewayFromHeaders}. `callId` and `routedTo` are
 * populated only when the gateway surfaces them; consumers should treat
 * `undefined` as "unknown for this gateway" rather than "no value".
 */
export interface GatewayHeaderDetection {
	readonly name: string;
	readonly callId: string | undefined;
	readonly routedTo: string | undefined;
}

/**
 * Identify a known LLM gateway / proxy from response headers (LiteLLM,
 * Helicone, Portkey). Returns `undefined` when no recognizable pattern is
 * present so direct-API traffic stays unaffected.
 *
 * Header keys are matched case-insensitively against the lowercased map that
 * {@link ProviderResponseMetadata.headers} produces.
 */
export function detectGatewayFromHeaders(
	headers: Readonly<Record<string, string>> | undefined,
): GatewayHeaderDetection | undefined {
	if (!headers) return undefined;
	const litellmCallId = headers["x-litellm-call-id"];
	if (litellmCallId) {
		return {
			name: "litellm",
			callId: litellmCallId,
			routedTo: headers["x-litellm-model-id"] ?? headers["x-litellm-model-group"],
		};
	}
	const heliconeId = headers["helicone-id"];
	if (heliconeId) {
		return { name: "helicone", callId: heliconeId, routedTo: headers["helicone-target-provider"] };
	}
	const portkeyId = headers["x-portkey-trace-id"] ?? headers["x-portkey-request-id"];
	if (portkeyId) {
		return {
			name: "portkey",
			callId: portkeyId,
			routedTo: headers["x-portkey-llm-provider"] ?? headers["x-portkey-provider"],
		};
	}
	const openRouterGenerationId = headers["x-generation-id"];
	if (openRouterGenerationId?.startsWith("gen-")) {
		// OpenRouter does not surface the upstream provider in response headers
		// (only the body's `provider` field carries it), so `routedTo` is left
		// undefined here. The `gen-` prefix on `x-generation-id` is OpenRouter-
		// specific and disambiguates from other proxies that also expose a
		// `x-generation-id` header.
		return { name: "openrouter", callId: openRouterGenerationId, routedTo: undefined };
	}
	return undefined;
}

/**
 * Bounded Cloudflare AI Gateway response-cache statuses emitted on
 * {@link PiGenAIAttr.GatewayResponseCacheStatus}. Distinct from provider
 * prompt-cache token counters (`gen_ai.usage.cache_*`).
 *
 * Cloudflare documents `HIT` / `MISS` on `cf-aig-cache-status`; `bypass` covers
 * skip-cache / CDN-aligned BYPASS values. Any other present value is `unknown`.
 */
export type GatewayResponseCacheStatus = "hit" | "miss" | "bypass" | "unknown";

/**
 * Classify Cloudflare AI Gateway `cf-aig-cache-status` into a bounded
 * response-cache status. Returns `undefined` when the allow-listed header is
 * absent so non-Cloudflare traffic stays unaffected. Does not read TTL,
 * skip-cache, custom-key, or other Cloudflare headers.
 */
export function classifyGatewayResponseCacheStatus(
	headers: Readonly<Record<string, string>> | undefined,
): GatewayResponseCacheStatus | undefined {
	if (!headers) return undefined;
	const raw = headers["cf-aig-cache-status"];
	if (raw == null) return undefined;
	switch (raw.trim().toLowerCase()) {
		case "hit":
			return "hit";
		case "miss":
			return "miss";
		case "bypass":
			return "bypass";
		default:
			return "unknown";
	}
}

function applyGatewayAttributes(
	span: Span,
	headers: Readonly<Record<string, string>> | undefined,
	baseUrl: string | undefined,
): void {
	const gateway = detectGatewayFromHeaders(headers);
	if (gateway) {
		span.setAttribute(PiGenAIAttr.GatewayName, gateway.name);
		if (baseUrl) span.setAttribute(PiGenAIAttr.GatewayEndpoint, baseUrl);
		if (gateway.callId) span.setAttribute(PiGenAIAttr.GatewayCallId, gateway.callId);
		if (gateway.routedTo) span.setAttribute(PiGenAIAttr.GatewayRoutedTo, gateway.routedTo);
	}
	const responseCacheStatus = classifyGatewayResponseCacheStatus(headers);
	if (responseCacheStatus) {
		span.setAttribute(PiGenAIAttr.GatewayResponseCacheStatus, responseCacheStatus);
	}
}

interface AppliedCostEstimate {
	readonly costUsd: number | undefined;
	readonly inputUsd: number | undefined;
	readonly outputUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
}

function applyCostEstimate(
	telemetry: AgentTelemetry | undefined,
	span: Span,
	message: AssistantMessage,
	serviceTier: ServiceTier | undefined,
	stepNumber: number | undefined,
): AppliedCostEstimate {
	if (!telemetry) return EMPTY_COST;
	return applyCostEstimateForUsage(telemetry, span, {
		model: message.model,
		provider: message.provider,
		serviceTier,
		stepNumber,
		usage: message.usage,
	});
}

function applyCostEstimateForUsage(
	telemetry: AgentTelemetry,
	span: Span,
	input: {
		readonly model: string;
		readonly provider: string | undefined;
		readonly serviceTier: ServiceTier | undefined;
		readonly stepNumber: number | undefined;
		readonly usage: Usage | undefined;
	},
): AppliedCostEstimate {
	const estimator = telemetry.config.costEstimator;
	if (!estimator || !input.usage) return EMPTY_COST;
	const provider = normalizeProviderName(telemetry, input.provider);
	if (!provider) return EMPTY_COST;
	const usage = buildUsageSnapshot(input.usage);
	let result: CostEstimate | undefined;
	try {
		result = estimator({
			provider,
			model: input.model,
			serviceTier: input.serviceTier,
			usage,
		});
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "cost_estimator_failed",
			message: "costEstimator threw; omitting cost telemetry",
			error: err,
		});
		return EMPTY_COST;
	}
	if (!result) return EMPTY_COST;
	if ("unavailable" in result) {
		span.setAttribute(PiGenAIAttr.CostUnavailableReason, result.unavailable);
		const cost: AppliedCostEstimate = {
			costUsd: undefined,
			inputUsd: undefined,
			outputUsd: undefined,
			costUnavailableReason: result.unavailable,
		};
		emitCostDelta(telemetry, {
			agent: normalizedTelemetryAgent(telemetry),
			conversationId: telemetry.conversationId,
			costUsd: undefined,
			costUnavailableReason: result.unavailable,
			inputUsd: undefined,
			model: input.model,
			outputUsd: undefined,
			provider,
			serviceTier: input.serviceTier,
			stepNumber: input.stepNumber,
			usage,
		});
		return cost;
	}
	span.setAttribute(PiGenAIAttr.CostEstimatedUsd, result.usd);
	if (result.inputUsd != null) span.setAttribute(PiGenAIAttr.CostInputUsd, result.inputUsd);
	if (result.outputUsd != null) span.setAttribute(PiGenAIAttr.CostOutputUsd, result.outputUsd);
	const cost: AppliedCostEstimate = {
		costUsd: result.usd,
		inputUsd: result.inputUsd,
		outputUsd: result.outputUsd,
		costUnavailableReason: undefined,
	};
	emitCostDelta(telemetry, {
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		costUsd: result.usd,
		costUnavailableReason: undefined,
		inputUsd: result.inputUsd,
		model: input.model,
		outputUsd: result.outputUsd,
		provider,
		serviceTier: input.serviceTier,
		stepNumber: input.stepNumber,
		usage,
	});
	return cost;
}

function buildUsageSnapshot(usage: Usage): ChatUsageSnapshot {
	return {
		inputTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		outputTokens: usage.output ?? 0,
		totalTokens:
			usage.totalTokens ??
			(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0),
		cachedInputTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		reasoningOutputTokens: usage.reasoningTokens,
	};
}

function emitCostDelta(telemetry: AgentTelemetry, delta: CostDelta): void {
	const hook = telemetry.config.onCostDelta;
	if (!hook) return;
	try {
		hook(delta);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_cost_delta_failed",
			message: "onCostDelta threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

async function emitChatUsage(
	telemetry: AgentTelemetry,
	span: Span,
	input: {
		readonly model: string;
		readonly provider: string | undefined;
		readonly serviceTier: ServiceTier | undefined;
		readonly stepNumber: number | undefined;
		readonly usage: Usage | undefined;
		readonly applied: AppliedCostEstimate;
		readonly headers: Readonly<Record<string, string>> | undefined;
	},
): Promise<void> {
	const hook = telemetry.config.onChatUsage;
	if (!hook || !input.usage) return;
	const event: ChatUsageEvent = {
		span,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		stepNumber: input.stepNumber,
		model: input.model,
		provider: normalizeProviderName(telemetry, input.provider),
		serviceTier: input.serviceTier,
		usage: buildUsageSnapshot(input.usage),
		cost: costEstimateFromApplied(input.applied),
		attributes: resolveDynamicAttributes(
			telemetry,
			buildTelemetryAttributeContext(telemetry, "chat", { stepNumber: input.stepNumber }),
		),
		headers: input.headers,
	};
	try {
		await hook(event);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_chat_usage_failed",
			message: "onChatUsage threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

function costEstimateFromApplied(applied: AppliedCostEstimate): CostEstimate | undefined {
	if (applied.costUsd != null) {
		return { usd: applied.costUsd, inputUsd: applied.inputUsd, outputUsd: applied.outputUsd };
	}
	if (applied.costUnavailableReason != null) {
		return { unavailable: applied.costUnavailableReason };
	}
	return undefined;
}

const EMPTY_COST: AppliedCostEstimate = Object.freeze({
	costUsd: undefined,
	inputUsd: undefined,
	outputUsd: undefined,
	costUnavailableReason: undefined,
});

function mapStopReason(reason: StopReason | undefined): string | undefined {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
		case "aborted":
			return "error";
		default:
			return undefined;
	}
}

function applyTerminalStatus(span: Span, stopReason: StopReason | undefined, errorMessage: string | undefined): void {
	if (stopReason === "error" || stopReason === "aborted") {
		span.setAttribute(GenAIAttr.ErrorType, stopReason);
		span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage ?? stopReason });
	}
}

export interface ManualChatToolCallTelemetry {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input?: unknown;
}

export interface ManualChatTelemetryOptions {
	readonly span?: Span;
	readonly parent?: Span;
	readonly model: Model;
	readonly usage?: Usage;
	readonly finishReason?: StopReason;
	readonly serviceTier?: ServiceTier;
	readonly stepNumber?: number;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly responseText?: string;
	readonly responseToolCalls?: readonly ManualChatToolCallTelemetry[];
	readonly attributes?: Attributes;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly endSpan?: boolean;
}

export async function recordManualChatTelemetry(
	telemetry: AgentTelemetry | undefined,
	options: ManualChatTelemetryOptions,
): Promise<Span | undefined> {
	const span =
		options.span ??
		startSpan(telemetry, "chat", `chat ${options.model.id}`, {
			spanKind: SpanKind.CLIENT,
			model: options.model,
			parent: options.parent,
			stepNumber: options.stepNumber,
			attributes: options.attributes,
		});
	if (!span) return undefined;
	if (options.span && options.attributes) span.setAttributes(options.attributes);
	if (options.stepNumber != null) span.setAttribute(PiGenAIAttr.AgentStepNumber, options.stepNumber);
	span.setAttribute(GenAIAttr.ResponseModel, options.responseModel ?? options.model.name);
	if (options.responseId) span.setAttribute(GenAIAttr.ResponseId, options.responseId);
	const finishReason = mapStopReason(options.finishReason);
	if (finishReason) span.setAttribute(GenAIAttr.ResponseFinishReasons, [finishReason]);
	applyUsageAttributes(span, options.usage);
	applyGatewayAttributes(span, options.responseHeaders, options.model.baseUrl);
	if (telemetry) {
		const applied = applyCostEstimateForUsage(telemetry, span, {
			model: options.responseModel ?? options.model.id,
			provider: options.model.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: options.usage,
		});
		await emitChatUsage(telemetry, span, {
			model: options.responseModel ?? options.model.id,
			provider: options.model.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: options.usage,
			applied,
			headers: options.responseHeaders,
		}).catch(err => {
			emitTelemetryWarning(telemetry, {
				code: "on_chat_usage_failed",
				message: "onChatUsage rejected; swallowing telemetry callback failure",
				error: err,
			});
		});
	}
	if (options.responseText) {
		const responseText = stringifyJsonAttribute(summarizeTelemetryTexts([options.responseText]));
		if (responseText) span.setAttribute(PiGenAIAttr.ResponseText, responseText);
	}
	if (options.responseToolCalls && options.responseToolCalls.length > 0) {
		const calls = options.responseToolCalls.map(call => ({
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			input: summarizeTelemetryValue(call.input),
		}));
		const responseToolCalls = stringifyJsonAttribute(limitTelemetryToolCalls(calls));
		if (responseToolCalls) span.setAttribute(PiGenAIAttr.ResponseToolCalls, responseToolCalls);
	}
	applyTerminalStatus(span, options.finishReason, undefined);
	if (options.endSpan ?? options.span === undefined) span.end();
	return span;
}

/**
 * Options accepted by {@link instrumentedCompleteSimple}. Mirrors the
 * `streamAssistantResponse` chat-span lifecycle for oneshot LLM calls
 * (compaction summaries, handoff document, branch summary, image_question).
 */
export interface InstrumentedChatSpanOptions {
	readonly telemetry: AgentTelemetry | undefined;
	/** Optional explicit parent span. Defaults to `context.active()`. */
	readonly parent?: Span;
	/** Step index recorded on the span; defaults to `-1` for non-loop calls. */
	readonly stepNumber?: number;
	/**
	 * Tag stamped onto `pi.gen_ai.oneshot.kind`. Values used by the agent:
	 * `compaction_summary`, `compaction_short_summary`, `compaction_turn_prefix`,
	 * `handoff`, `branch_summary`, `image_question`. Free-form to allow callers
	 * outside this package to add new kinds without bumping the helper.
	 */
	readonly oneshotKind?: string;
	/** Extra span attributes applied verbatim. */
	readonly attributes?: Attributes;
	/**
	 * Override for the underlying {@link completeSimple} call. Defaults to
	 * `completeSimple` from `@oh-my-pi/pi-ai`. Use to retain a test injection
	 * seam while still going through the chat-span lifecycle.
	 */
	readonly completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/**
	 * Opt in to transient-failure retry for this oneshot (Anthropic
	 * `overloaded_error`, `rate_limit_error`, 429/500/502/503/529). Omitted or
	 * `undefined` means **no retry** — the failure is surfaced exactly as before.
	 *
	 * Deliberately opt-in rather than default-on: `oneshotKind` is free-form and
	 * callers may pass arbitrary `ctx.tools` / `options.toolChoice`, so this
	 * funnel cannot itself prove a given request is replay-safe. Re-issuing is
	 * only safe when the call performs no side effect and nothing consumed
	 * partial output — true for summaries, titles, handoffs and image
	 * descriptions, which parse a complete response after it resolves. Enable it
	 * per call site, as a reviewed decision.
	 *
	 * Pass `{}` to accept the {@link retryTransientCompletion} defaults
	 * (3 attempts, 500ms base backoff, `retry-after` honored).
	 */
	readonly retry?: OneshotRetryOptions;
}

/**
 * Wrap a {@link completeSimple} round-trip with the same chat-span lifecycle
 * the agent loop uses for streamed turns: `startChatSpan` → run inside the
 * active span → `finishChatSpan` on success, `failChatSpan` on throw.
 *
 * Short-circuits when `telemetry` is `undefined` so cost / overhead stays at
 * zero for installations without an OTEL SDK.
 */
export async function instrumentedCompleteSimple<TApi extends Api>(
	model: Model<TApi>,
	ctx: Context,
	options: SimpleStreamOptions,
	span: InstrumentedChatSpanOptions,
): Promise<AssistantMessage> {
	// Oneshot LLM calls (handoff, compaction/branch summaries) run outside the
	// agent `#runLoop`, which is where the EventLoopKeepalive normally lives.
	// Without it, Bun's JSC loop stops servicing timers while parked on the
	// long-lived completion promise, freezing any host spinner (e.g. the
	// `/handoff` Loader) until an unrelated I/O event (a terminal resize)
	// pokes the loop. Keep the loop healthy for the duration of the call.
	using _keepalive = new EventLoopKeepalive();
	const { telemetry, parent, oneshotKind } = span;
	const stepNumber = span.stepNumber ?? -1;
	const reasoning = options.reasoning;
	const chatSpan = startChatSpan(telemetry, model, {
		parent,
		stepNumber,
		request: {
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			topP: options.topP,
			topK: options.topK,
			presencePenalty: options.presencePenalty,
			serviceTier: options.serviceTier,
			reasoningEffort: typeof reasoning === "string" ? reasoning : undefined,
			toolChoice: options.toolChoice,
			tools: ctx.tools,
			systemPrompt: ctx.systemPrompt,
			messages: ctx.messages,
		},
	});
	if (chatSpan) {
		if (oneshotKind) chatSpan.setAttribute(PiGenAIAttr.OneshotKind, oneshotKind);
		if (span.attributes) chatSpan.setAttributes(span.attributes);
	}

	// Wrap the user-supplied onResponse so we always capture response headers
	// for the cost / gateway hooks without stealing them from the caller.
	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = options.onResponse;
	const captureOnResponse: NonNullable<SimpleStreamOptions["onResponse"]> = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			const complete = span.completeImpl ?? completeSimple;
			// Opt-in only (see `retry` on InstrumentedChatSpanOptions): each attempt
			// re-issues the whole request, which is safe only for replay-safe
			// oneshots. `getResponseHeaders` hands the failed attempt's headers to
			// the retry layer — an AssistantMessage carries none, so this is what
			// makes `retry-after` on a real 429/529 actually honored.
			const runOnce = () => {
				// Clear first so a previous attempt's `retry-after` can never be
				// reused for a later failure that arrived without headers.
				capturedHeaders = undefined;
				return complete(model, ctx, { ...options, onResponse: captureOnResponse });
			};
			const message = span.retry
				? await retryTransientCompletion(runOnce, {
						...span.retry,
						// Framework-owned: the caller must not be able to detach the
						// abort signal or the header source by passing them itself.
						signal: options.signal,
						getResponseHeaders: () => capturedHeaders,
					})
				: await runOnce();
			await finishChatSpan(telemetry, chatSpan, message, {
				stepNumber,
				serviceTier: options.serviceTier,
				responseHeaders: capturedHeaders,
				baseUrl: model.baseUrl,
			});
			return message;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
		throw err;
	}
}

/**
 * Start an `execute_tool` span representing one tool invocation. Parented
 * under the supplied `invoke_agent` span by default — pass `parent` to
 * override.
 */
export function startExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly tool: AgentTool | undefined;
		readonly toolName: string;
		readonly toolCallId: string;
		readonly args: unknown;
		readonly parent?: Span;
	},
): Span | undefined {
	const attrs: Attributes = {
		[GenAIAttr.ToolName]: options.toolName,
		[GenAIAttr.ToolCallId]: options.toolCallId,
		[GenAIAttr.ToolType]: "function",
	};
	if (options.tool?.description) attrs[GenAIAttr.ToolDescription] = options.tool.description;
	const span = startSpan(telemetry, "execute_tool", `execute_tool ${options.toolName}`, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		attributes: attrs,
	});
	if (span) {
		telemetry?.collector.beginTool(span, { toolCallId: options.toolCallId, toolName: options.toolName });
		if (telemetry && telemetry.contentCapture !== "none") {
			const args = serializeToolCallArgumentsForTelemetry(telemetry, options.args);
			if (args) span.setAttribute(GenAIAttr.ToolCallArguments, args);
		}
	}
	return span;
}

/**
 * End an `execute_tool` span. Pass `status` to specify the terminal status
 * explicitly (`"ok" | "error" | "skipped" | "blocked" | "timeout" |
 * "aborted"`); when omitted, `status` is derived from `isError`. Passing
 * `errorObject` (the thrown value) additionally records an exception with
 * stack.
 */
export function finishExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: {
		readonly result?: unknown;
		readonly isError: boolean;
		readonly status?: ToolStatus;
		readonly errorMessage?: string;
		readonly errorObject?: unknown;
		readonly toolCallId: string;
		readonly toolName: string;
	},
): void {
	if (!span) return;
	if (telemetry && telemetry.contentCapture !== "none" && options.result !== undefined) {
		const result = serializeToolCallResultForTelemetry(telemetry, options.result);
		if (result) span.setAttribute(GenAIAttr.ToolCallResult, result);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "execute_tool",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	});
	const status: ToolStatus = options.status ?? (options.isError ? "error" : "ok");
	let errorType: string | undefined;
	// `status` is the source of truth for the wire-level `error.type`. The
	// underlying `errorObject` (if any) still gets a `recordException` so the
	// stack trace is preserved, but the attribute reflects the run-level
	// category (`tool_blocked`, `tool_aborted`, …) instead of the JS class
	// name. This keeps dashboards groupable on one column.
	if (status !== "ok") {
		errorType =
			status === "error" && options.errorObject instanceof Error
				? options.errorObject.name || "Error"
				: STATUS_ERROR_TYPE[status];
		span.setAttribute(GenAIAttr.ErrorType, errorType);
		span.setAttribute(EXECUTE_TOOL_STATUS_ATTR, status);
		const msg =
			options.errorObject instanceof Error ? options.errorObject.message : (options.errorMessage ?? errorType);
		span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
	} else {
		span.setAttribute(EXECUTE_TOOL_STATUS_ATTR, status);
	}
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
	}
	telemetry?.collector.endTool(span, { status, errorType });
	span.end();
}

/** Span attribute carrying the terminal {@link ToolStatus}. */
export const EXECUTE_TOOL_STATUS_ATTR = PiGenAIAttr.ToolStatus;

/**
 * Mapping from non-ok {@link ToolStatus} values to the `error.type` attribute
 * string written on the span when no thrown error is available. The wire
 * format intentionally matches the status string so dashboards can group on
 * one column.
 */
const STATUS_ERROR_TYPE: Record<Exclude<ToolStatus, "ok">, string> = {
	error: "tool_error",
	skipped: "tool_skipped",
	blocked: "tool_blocked",
	timeout: "tool_timeout",
	aborted: "tool_aborted",
};

/**
 * Record a tool that bypassed the span lifecycle entirely (pre-run
 * interrupt, post-execution tail sweep for calls that never produced a
 * result message). The LLM still asked for the tool, so it counts toward
 * coverage and toward the relevant `tools.<status>` counter; no span is
 * emitted because the loop never started one.
 */
export function recordSkippedTool(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly status: Extract<ToolStatus, "skipped" | "aborted" | "error">;
	},
): void {
	telemetry?.collector.recordOrphanTool(options);
}

/**
 * End an `invoke_agent` span. Snapshots the run collector, stamps aggregate
 * `gen_ai.agent.*` attributes on the span, fires the non-fatal
 * {@link AgentTelemetryConfig.onRunEnd} hook, then records any uncaught
 * error and ends the span.
 */
export function finishInvokeAgentSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: { readonly stepCount: number; readonly errorObject?: unknown },
): { readonly summary: AgentRunSummary; readonly coverage: AgentRunCoverage } | undefined {
	if (!span) return undefined;
	applyInvokeAgentFinish(span, options.stepCount);
	let snapshot: { readonly summary: AgentRunSummary; readonly coverage: AgentRunCoverage } | undefined;
	if (telemetry) {
		snapshot = telemetry.collector.snapshot({ stepCount: options.stepCount });
		applyAggregateAttributes(span, snapshot.summary, snapshot.coverage);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "invoke_agent",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
	});
	if (telemetry && snapshot && telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
		span.setAttribute(GenAIAttr.ErrorType, options.errorObject.name || "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorObject.message });
	}
	span.end();
	return snapshot;
}

/**
 * Invoke {@link AgentTelemetryConfig.onRunEnd} on `telemetry` if set. Throws
 * are caught and surfaced via the `onTelemetryWarning` hook (falling back to `console.warn`
 * when no hook is set) — telemetry callbacks NEVER turn a
 * successful agent run into a failed one. Idempotent at the call site via
 * {@link AgentRunCollector.markRunEnded}; callers must check that before
 * calling this helper.
 */
export function fireOnRunEnd(telemetry: AgentTelemetry, summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	const hook = telemetry.config.onRunEnd;
	if (!hook) return;
	try {
		hook(summary, coverage);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_run_end_failed",
			message: "onRunEnd threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

/** Aggregate `pi.gen_ai.agent.*` attributes stamped on the `invoke_agent` span. */
export const enum PiGenAIAggregateAttr {
	ChatsCount = "pi.gen_ai.agent.chats.count",
	ChatsTotalLatencyMs = "pi.gen_ai.agent.chats.total_latency_ms",
	ChatsStopReasonPrefix = "pi.gen_ai.agent.chats.stop_reason.",
	ToolsCount = "pi.gen_ai.agent.tools.count",
	ToolsOkCount = "pi.gen_ai.agent.tools.ok.count",
	ToolsErrorCount = "pi.gen_ai.agent.tools.error.count",
	ToolsSkippedCount = "pi.gen_ai.agent.tools.skipped.count",
	ToolsBlockedCount = "pi.gen_ai.agent.tools.blocked.count",
	ToolsTimeoutCount = "pi.gen_ai.agent.tools.timeout.count",
	ToolsAbortedCount = "pi.gen_ai.agent.tools.aborted.count",
	ToolsTotalLatencyMs = "pi.gen_ai.agent.tools.total_latency_ms",
	ToolsInvoked = "pi.gen_ai.agent.tools.invoked",
	ToolsAvailable = "pi.gen_ai.agent.tools.available",
	ToolsUnused = "pi.gen_ai.agent.tools.unused",
	UsageInputTokensTotal = "pi.gen_ai.agent.usage.input_tokens.total",
	UsageOutputTokensTotal = "pi.gen_ai.agent.usage.output_tokens.total",
	UsageCacheReadInputTokensTotal = "pi.gen_ai.agent.usage.cache_read.input_tokens.total",
	UsageCacheCreationInputTokensTotal = "pi.gen_ai.agent.usage.cache_creation.input_tokens.total",
	UsageReasoningOutputTokensTotal = "pi.gen_ai.agent.usage.reasoning.output_tokens.total",
	UsageTotalTokensTotal = "pi.gen_ai.agent.usage.total_tokens.total",
	CostEstimatedUsdTotal = "pi.gen_ai.agent.cost.estimated_usd.total",
	ErrorsCount = "pi.gen_ai.agent.errors.count",
}

/** Stamp the aggregate `pi.gen_ai.agent.*` attributes on the given span. */
function applyAggregateAttributes(span: Span, summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	span.setAttribute(PiGenAIAggregateAttr.ChatsCount, summary.chats.total);
	span.setAttribute(PiGenAIAggregateAttr.ChatsTotalLatencyMs, summary.chats.totalLatencyMs);
	for (const [reason, count] of Object.entries(summary.chats.byStopReason)) {
		span.setAttribute(`${PiGenAIAggregateAttr.ChatsStopReasonPrefix}${reason}.count`, count);
	}
	span.setAttribute(PiGenAIAggregateAttr.ToolsCount, summary.tools.total);
	span.setAttribute(PiGenAIAggregateAttr.ToolsOkCount, summary.tools.ok);
	span.setAttribute(PiGenAIAggregateAttr.ToolsErrorCount, summary.tools.error);
	span.setAttribute(PiGenAIAggregateAttr.ToolsSkippedCount, summary.tools.skipped);
	span.setAttribute(PiGenAIAggregateAttr.ToolsBlockedCount, summary.tools.blocked);
	span.setAttribute(PiGenAIAggregateAttr.ToolsTimeoutCount, summary.tools.timeout);
	span.setAttribute(PiGenAIAggregateAttr.ToolsAbortedCount, summary.tools.aborted);
	span.setAttribute(PiGenAIAggregateAttr.ToolsTotalLatencyMs, summary.tools.totalLatencyMs);
	if (coverage.toolsInvoked.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsInvoked, [...coverage.toolsInvoked]);
	}
	if (coverage.toolsAvailable.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsAvailable, [...coverage.toolsAvailable]);
	}
	if (coverage.toolsUnused.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsUnused, [...coverage.toolsUnused]);
	}
	span.setAttribute(PiGenAIAggregateAttr.UsageInputTokensTotal, summary.usage.inputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageOutputTokensTotal, summary.usage.outputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageCacheReadInputTokensTotal, summary.usage.cachedInputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageCacheCreationInputTokensTotal, summary.usage.cacheWriteTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageReasoningOutputTokensTotal, summary.usage.reasoningOutputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageTotalTokensTotal, summary.usage.totalTokens);
	if (summary.cost.estimatedUsd > 0) {
		span.setAttribute(PiGenAIAggregateAttr.CostEstimatedUsdTotal, summary.cost.estimatedUsd);
	}
	span.setAttribute(PiGenAIAggregateAttr.ErrorsCount, summary.errors.total);
}

/**
 * Run `fn` with `span` activated on the OTEL context. Spans created
 * downstream (provider HTTP clients, MCP tools, user code) attach as
 * children. No-op when `span` is undefined.
 *
 * Required because `tracer.startSpan` creates the span object but does not
 * activate it — without this wrapper, downstream spans attach to whatever
 * context was active before and the parent linkage we advertise is lost.
 */
export function runInActiveSpan<T>(span: Span | undefined, fn: () => Promise<T>): Promise<T> {
	if (!span) return fn();
	return context.with(trace.setSpan(context.active(), span), fn);
}

/**
 * Emit a one-shot `handoff` span describing a transition between two named
 * agents. Pass `parent` to make the span a child of an in-flight
 * invoke_agent span; otherwise the active context's span is used.
 */
export function recordHandoff(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly fromAgent: AgentIdentity | undefined;
		readonly toAgent: AgentIdentity;
		readonly parent?: Span;
		readonly attributes?: Attributes;
	},
): void {
	if (!telemetry) return;
	const attrs: Attributes = {};
	const fromAgent = options.fromAgent ? normalizeAgentIdentity(telemetry, options.fromAgent) : undefined;
	const toAgent = normalizeAgentIdentity(telemetry, options.toAgent);
	if (fromAgent?.name) attrs[PiGenAIAttr.HandoffFromAgentName] = fromAgent.name;
	if (fromAgent?.id) attrs[PiGenAIAttr.HandoffFromAgentId] = fromAgent.id;
	if (toAgent.name) attrs[PiGenAIAttr.HandoffToAgentName] = toAgent.name;
	if (toAgent.id) attrs[PiGenAIAttr.HandoffToAgentId] = toAgent.id;
	const name = toAgent.name
		? fromAgent?.name
			? `handoff ${fromAgent.name} → ${toAgent.name}`
			: `handoff to ${toAgent.name}`
		: "handoff";
	const span = startSpan(telemetry, "handoff", name, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		attributes: { ...attrs, ...options.attributes },
	});
	if (!span) return;
	safeOnSpanEnd(telemetry, {
		span,
		kind: "handoff",
		model: undefined,
		agent: toAgent,
		conversationId: telemetry.conversationId,
	});
	span.end();
}

/**
 * Set a single attribute on a possibly-undefined span. Use when the caller
 * needs to attach context outside the standard helpers without a branch.
 */
export function setSpanAttribute(span: Span | undefined, key: string, value: AttributeValue): void {
	if (!span) return;
	span.setAttribute(key, value);
}

/** Re-exports so consumers can write hooks without depending on @opentelemetry/api directly. */
export { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer, trace };

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
