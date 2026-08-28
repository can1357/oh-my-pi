/** Agent class that uses the agent-loop directly.
 * No transport abstraction - calls streamSimple via the loop.
 */
import { isPromise } from "node:util/types";
import {
	type ApiKey,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type CursorExecHandlers,
	type CursorToolResultHandler,
	type Effort,
	type ImageContent,
	type Message,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type ToolChoice,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import type { HarmonyAuditEvent } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import {
	abortReasonText,
	agentLoop,
	agentLoopContinue,
	createSyntheticToolResultMessage,
	normalizeMessagesForProvider,
	normalizeTools,
	resolveOwnedDialectFromEnv,
} from "./agent-loop";
import type { AppendOnlyContextManager } from "./append-only-context";
import { isProviderRefusalMessage } from "./replay-policy";
import { Tokenizer, tokenizerEncodingForModel } from "./tokenizer";
import type {
	AgentBeforeModelCall,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolContext,
	AgentTurnEndContext,
	AsideMessage,
	StreamFn,
	ToolCallContext,
	ToolChoiceDirective,
} from "./types";
import { isSoftToolRequirement } from "./types";
import { EventLoopKeepalive } from "./utils/yield";

/**
 * Default convertToLlm: Keep only LLM-compatible replay messages.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m): m is Message => {
		if (m.role === "assistant") return !isProviderRefusalMessage(m);
		return m.role === "user" || m.role === "toolResult";
	});
}

function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return toolChoice;
	}
	if (toolChoice.type === "computer") {
		return tools.some(tool => tool.native?.type === "computer") ? toolChoice : undefined;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}

export class AgentBusyError extends Error {
	constructor(
		message: string = "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
	) {
		super(message);
		this.name = "AgentBusyError";
	}
}
export interface AgentOptions {
	initialState?: Partial<AgentState>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 * Default filters to user/assistant/toolResult and converts attachments.
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to context before convertToLlm.
	 * Use for context pruning, injecting external context, etc.
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Optional transform applied after provider context assembly and before
	 * telemetry capture/provider send.
	 */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	/**
	 * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate": check after each tool call (default)
	 * - "wait": defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic")
	 */
	kimiApiFormat?: "openai" | "anthropic";

	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;

	/**
	 * Custom stream function (for proxy backends, etc.). Default uses streamSimple.
	 */
	streamFn?: StreamFn;
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;
	/**
	 * Optional prompt cache key forwarded to LLM providers.
	 * When omitted, providers may fall back to sessionId.
	 */
	promptCacheKey?: string;
	/**
	 * Shared provider state map for session-scoped transport/session caches.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;

	/**
	 * Resolves an API key or resolver dynamically for each LLM call.
	 * Useful for expiring tokens and model-scoped credential routing.
	 */
	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	/**
	 * Inspect or replace provider payloads before they are sent.
	 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/**
	 * Inspect provider response metadata after headers arrive and before streaming body consumption.
	 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/**
	 * Inspect raw Server-Sent Events from HTTP streaming providers.
	 */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/**
	 * Inspect assistant streaming events before they are emitted to subscribers.
	 * Use this when abort decisions must happen before buffered events continue flowing.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/**
	 * Called when GPT-5 Harmony protocol leakage is detected and mitigated.
	 */
	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	/**
	 * Custom token budgets for thinking levels (token-based providers only).
	 */
	thinkingBudgets?: ThinkingBudgets;

	/**
	 * Sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	temperature?: number;

	/** Additional sampling controls for providers that support them. */
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	serviceTier?: ServiceTier;
	/**
	 * Per-call effective service-tier resolver. When set, it authoritatively
	 * supplies the request's tier (replacing the static `serviceTier` and its
	 * telemetry) per model — used to scope a provider/model into a priority
	 * serving path without mutating the shared session `serviceTier`.
	 */
	serviceTierResolver?: (model: Model) => ServiceTier | undefined;
	/**
	 * If true, request that the underlying provider omit reasoning/thinking summaries
	 * from the response. The model still reasons internally; only the human-readable
	 * summary stream is suppressed. Useful when the UI hides thinking blocks anyway.
	 */
	hideThinkingSummary?: boolean;

	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately,
	 * allowing higher-level retry logic to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	/**
	 * Resolve a tool call whose name matched no advertised tool. Lets hosts
	 * route calls to tools exposed through side transports (e.g. `xd://`
	 * device mounts) instead of failing with "Tool not found".
	 */
	resolveFallbackTool?: (name: string) => AgentTool<any> | undefined;

	/** Enable intent tracing schema injection/stripping in the harness. */
	intentTracing?: boolean;
	/**
	 * Strip tool descriptions from provider-bound tool specs (top-level + nested
	 * schema annotations). Use when the full catalog is rendered into the system
	 * prompt so descriptions are not duplicated on the wire. Native tool calling only.
	 */
	pruneToolDescriptions?: boolean;
	/** Owned tool-calling dialect. Undefined keeps provider-native tool calling. */
	dialect?: Dialect;
	/**
	 * When owned tool calling is active and the model fabricates a tool result
	 * mid-turn: `true` (default) aborts the provider request immediately; `false`
	 * drains the request and discards the fabricated continuation. Forwarded to
	 * the loop's {@link AgentLoopConfig.abortOnFabricatedToolResult}.
	 */
	abortOnFabricatedToolResult?: boolean;
	/** Dynamic tool-choice directive (hard {@link ToolChoice} or {@link SoftToolRequirement}), resolved once per turn. */
	getToolChoice?: () => ToolChoiceDirective | undefined;
	/** Reject a deferred hard choice when its named tool is no longer active. */
	onToolChoiceUnavailable?: () => void;

	/**
	 * Cursor exec handlers for local tool execution.
	 */
	cursorExecHandlers?: CursorExecHandlers;
	/** Additional tools Cursor executes through its MCP request-context bridge, resolved before each provider call. */
	getCursorTools?: () => AgentTool[];

	/**
	 * Optional rewrite of Cursor exec-channel tool results. May return a Promise.
	 *
	 * The Agent reserves the original result in its Cursor result buffer first,
	 * then awaits this hook and patches the reserved entry in place. That keeps
	 * the call paired even if `message_end` arrives while the Promise is still
	 * pending, and `#emitCursorSplitAssistantMessage` waits for any transformer
	 * still in flight before persisting, so a late rewrite is not lost. A
	 * rejecting transformer is swallowed and the reserved payload stands in.
	 * Hosts that only pass `cursorExecHandlers` (the coding-agent path) never
	 * hit this hook.
	 */
	cursorOnToolResult?: CursorToolResultHandler;

	/** Current working directory used by local tool execution. */
	cwd?: string;
	/**
	 * Resolver for the live working directory, re-read on every turn. When set, it
	 * overrides the static {@link cwd} at config-build time so a session move
	 * (`/move`, which updates the host's cwd without reconstructing the Agent) is
	 * reflected in provider options — e.g. GitLab Duo Agent namespace/project
	 * discovery keys off this cwd's git remote. Falls back to `cwd` when it returns
	 * `undefined`.
	 */
	cwdResolver?: () => string | undefined;
	/**
	 * Called after a tool call has been validated and is about to execute.
	 * See {@link AgentLoopConfig.beforeToolCall} for full semantics.
	 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and the tool-result
	 * message are emitted. See {@link AgentLoopConfig.afterToolCall} for full semantics.
	 */
	afterToolCall?: AgentLoopConfig["afterToolCall"];

	/**
	 * Called once an assistant message is finalized, before it reaches the
	 * context, the UI, or tool dispatch. May mutate the message in place (text +
	 * tool-call arguments). See {@link AgentLoopConfig.transformAssistantMessage}.
	 */
	transformAssistantMessage?: AgentLoopConfig["transformAssistantMessage"];

	/**
	 * Opt-in OpenTelemetry instrumentation. Passing `{}` enables the loop's
	 * GenAI-semantic-convention spans using the global tracer provider. See
	 * {@link AgentLoopConfig.telemetry} for the full surface.
	 */
	telemetry?: AgentLoopConfig["telemetry"];
	/**
	 * Immutable context mode — stabilizes system prompt + tool spec bytes
	 * across turns so DeepSeek/Anthropic prefix caches hit at maximum rate.
	 */
	appendOnlyContext?: AppendOnlyContextManager;
}

export interface AgentPromptOptions {
	toolChoice?: ToolChoice;
}

/** Buffered Cursor exec-channel tool result waiting to be emitted after the assistant message. */
interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
	/**
	 * Set while an async `cursorOnToolResult` transformer is still running for
	 * this entry, and cleared once it settles. The drain awaits it so a
	 * transformer that rewrites the payload is not silently discarded when
	 * `message_end` lands in the same chunk as the tool result.
	 */
	pending?: Promise<void>;
}

export class Agent {
	#state: AgentState = {
		systemPrompt: [],
		model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: undefined,
		disableReasoning: false,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};
	#tokenizer = new Tokenizer(this.#state.model);
	#listeners = new Set<(e: AgentEvent) => void>();
	#abortController?: AbortController;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	#transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	#steeringQueue: AgentMessage[] = [];
	#followUpQueue: AgentMessage[] = [];
	#steeringWaiters = new Set<() => void>();

	#steeringMode: "all" | "one-at-a-time";
	#followUpMode: "all" | "one-at-a-time";
	#interruptMode: "immediate" | "wait";
	#sessionId?: string;
	#deadline?: number;
	#promptCacheKey?: string;
	#metadata?: Record<string, unknown>;
	#metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	#providerSessionState?: Map<string, ProviderSessionState>;
	#thinkingBudgets?: ThinkingBudgets;
	#temperature?: number;
	#topP?: number;
	#topK?: number;
	#minP?: number;
	#presencePenalty?: number;
	#repetitionPenalty?: number;
	#serviceTier?: ServiceTier;
	#serviceTierResolver?: (model: Model) => ServiceTier | undefined;
	#hideThinkingSummary?: boolean;
	#maxRetryDelayMs?: number;
	#getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	#cursorExecHandlers?: CursorExecHandlers;
	#getCursorTools?: () => AgentTool[];
	#cursorOnToolResult?: CursorToolResultHandler;
	#cwd?: string;
	#cwdResolver?: () => string | undefined;

	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#kimiApiFormat?: "openai" | "anthropic";
	#preferWebsockets?: boolean;
	#transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	#resolveFallbackTool?: (name: string) => AgentTool<any> | undefined;
	#intentTracing: boolean;
	#pruneToolDescriptions: boolean;
	#dialect?: Dialect;
	#abortOnFabricatedToolResult?: boolean;
	#getToolChoice?: () => ToolChoiceDirective | undefined;
	#onToolChoiceUnavailable?: () => void;
	#softToolRequirementState: NonNullable<AgentLoopConfig["softToolRequirementState"]> = { escalations: 0 };
	#deferredToolChoice?: ToolChoice;
	#onPayload?: SimpleStreamOptions["onPayload"];
	#onResponse?: SimpleStreamOptions["onResponse"];
	#onSseEvent?: SimpleStreamOptions["onSseEvent"];
	#onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	#onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;
	#onBeforeYield?: () => Promise<void> | void;
	#onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;
	#beforeModelCall?: AgentBeforeModelCall;
	#additionalBeforeModelCalls = new Set<AgentBeforeModelCall>();
	#asideMessageProvider?: () => AsideMessage[] | Promise<AsideMessage[]>;
	#telemetry?: AgentLoopConfig["telemetry"];
	#appendOnlyContext?: AppendOnlyContextManager;
	#beforeQueuedMessageDequeueHooks = new Set<(signal?: AbortSignal) => Promise<void> | void>();
	#beforeModelCallHooks = new Set<(signal?: AbortSignal) => Promise<void> | void>();

	/** Buffered Cursor tool results with text length at time of call (for correct ordering) */
	#cursorToolResultBuffer: CursorToolResultEntry[] = [];

	streamFn: StreamFn;
	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;
	/**
	 * Hook invoked after tool arguments are validated and before execution.
	 * Reassign at any time to swap the implementation (e.g. on extension reload).
	 */
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	/**
	 * Hook invoked after tool execution and before `tool_execution_end` / tool-result
	 * message emission. Reassign at any time to swap the implementation.
	 */
	afterToolCall?: AgentLoopConfig["afterToolCall"];
	/**
	 * Hook invoked once an assistant message is finalized, before context append,
	 * UI emission, and tool dispatch. Reassign at any time to swap the implementation.
	 */
	transformAssistantMessage?: AgentLoopConfig["transformAssistantMessage"];
	/**
	 * Hook that peeks whether interrupting IRC asides are queued for the next boundary.
	 */
	hasIrcInterrupts?: AgentLoopConfig["hasIrcInterrupts"];

	constructor(opts: AgentOptions = {}) {
		this.#state = { ...this.#state, ...opts.initialState };
		if (opts.initialState?.messages) this.#state.messages = opts.initialState.messages.slice();
		if (opts.initialState?.pendingToolCalls)
			this.#state.pendingToolCalls = new Set(opts.initialState.pendingToolCalls);
		this.#syncTokenizer(this.#state.model);
		this.#convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.#transformContext = opts.transformContext;
		this.#steeringMode = opts.steeringMode || "one-at-a-time";
		this.#followUpMode = opts.followUpMode || "one-at-a-time";
		this.#interruptMode = opts.interruptMode || "immediate";
		this.streamFn = opts.streamFn || streamSimple;
		this.#sessionId = opts.sessionId;
		this.#deadline = opts.deadline;
		this.#promptCacheKey = opts.promptCacheKey;
		this.#providerSessionState = opts.providerSessionState;
		this.#thinkingBudgets = opts.thinkingBudgets;
		this.#temperature = opts.temperature;
		this.#topP = opts.topP;
		this.#topK = opts.topK;
		this.#minP = opts.minP;
		this.#presencePenalty = opts.presencePenalty;
		this.#repetitionPenalty = opts.repetitionPenalty;
		this.#serviceTier = opts.serviceTier;
		this.#serviceTierResolver = opts.serviceTierResolver;
		this.#hideThinkingSummary = opts.hideThinkingSummary;
		this.#maxRetryDelayMs = opts.maxRetryDelayMs;
		this.getApiKey = opts.getApiKey;
		this.#onPayload = opts.onPayload;
		this.#onResponse = opts.onResponse;
		this.#onSseEvent = opts.onSseEvent;
		this.#getToolContext = opts.getToolContext;
		this.#cursorExecHandlers = opts.cursorExecHandlers;
		this.#getCursorTools = opts.getCursorTools;
		this.#cursorOnToolResult = opts.cursorOnToolResult;
		this.#cwd = opts.cwd;
		this.#cwdResolver = opts.cwdResolver;
		this.#kimiApiFormat = opts.kimiApiFormat;
		this.#preferWebsockets = opts.preferWebsockets;
		this.#transformToolCallArguments = opts.transformToolCallArguments;
		this.#resolveFallbackTool = opts.resolveFallbackTool;
		this.#intentTracing = opts.intentTracing === true;
		this.#pruneToolDescriptions = opts.pruneToolDescriptions === true;
		this.#dialect = opts.dialect;
		this.#abortOnFabricatedToolResult = opts.abortOnFabricatedToolResult;
		this.#getToolChoice = opts.getToolChoice;
		this.#onToolChoiceUnavailable = opts.onToolChoiceUnavailable;
		this.#onAssistantMessageEvent = opts.onAssistantMessageEvent;
		this.#onHarmonyLeak = opts.onHarmonyLeak;
		this.beforeToolCall = opts.beforeToolCall;
		this.afterToolCall = opts.afterToolCall;
		this.transformAssistantMessage = opts.transformAssistantMessage;
		this.#telemetry = opts.telemetry;
		this.#appendOnlyContext = opts.appendOnlyContext;
		this.#transformProviderContext = opts.transformProviderContext;
	}

	/**
	 * Get the current session ID used for provider caching.
	 */
	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	/**
	 * Set the session ID for provider caching.
	 * Call this when switching sessions (new session, branch, resume).
	 */
	set sessionId(value: string | undefined) {
		this.#sessionId = value;
	}

	/**
	 * Get the prompt cache key forwarded to providers.
	 */
	get promptCacheKey(): string | undefined {
		return this.#promptCacheKey;
	}

	/**
	 * Set the prompt cache key forwarded to providers.
	 */
	set promptCacheKey(value: string | undefined) {
		this.#promptCacheKey = value;
	}

	/**
	 * Static metadata forwarded to every API request when no resolver is installed
	 * (e.g. `metadata.user_id` for Anthropic session attribution). Setting this
	 * clears any installed resolver.
	 *
	 * For live/provider-aware metadata (e.g. Anthropic OAuth `account_uuid` that
	 * must reflect the credential selected per-request), use
	 * {@link setMetadataResolver} and read via {@link metadataForProvider}.
	 */
	get metadata(): Record<string, unknown> | undefined {
		return this.#metadata;
	}

	set metadata(value: Record<string, unknown> | undefined) {
		this.#metadata = value;
		this.#metadataResolver = undefined;
	}

	/**
	 * Resolve request metadata for the given provider at call time. When a
	 * resolver is installed via {@link setMetadataResolver}, it is invoked with
	 * the provider string so the result can be scoped (e.g. `account_uuid` is
	 * only included for `"anthropic"` requests). Falls back to the static
	 * {@link metadata} value when no resolver is set.
	 */
	metadataForProvider(provider: string): Record<string, unknown> | undefined {
		if (this.#metadataResolver) return this.#metadataResolver(provider);
		return this.#metadata;
	}

	/**
	 * Install a function that resolves request metadata at call time. The
	 * resolver receives the target provider string and can gate provider-specific
	 * fields (e.g. `account_uuid` only for `"anthropic"`). Invoked per LLM
	 * request by `agent-loop` after `getApiKey` selects the session-sticky
	 * credential. Pass `undefined` to clear and revert to the static
	 * {@link metadata} value.
	 */
	setMetadataResolver(resolver: ((provider: string) => Record<string, unknown> | undefined) | undefined): void {
		this.#metadataResolver = resolver;
	}

	/**
	 * Read the active OpenTelemetry configuration. Returns `undefined` when
	 * instrumentation is disabled. Callers spawning child runs (e.g. subagent
	 * dispatch) forward this to the child's loop so its spans appear under the
	 * parent's active context with the subagent's own identity stamped.
	 */
	get telemetry(): AgentLoopConfig["telemetry"] | undefined {
		return this.#telemetry;
	}

	/**
	 * Replace the active OpenTelemetry configuration. Pass `undefined` to
	 * disable instrumentation. Applies to the *next* `agentLoop` invocation —
	 * in-flight loops keep the configuration they started with.
	 */
	setTelemetry(telemetry: AgentLoopConfig["telemetry"] | undefined): void {
		this.#telemetry = telemetry;
	}

	/**
	 * Get provider-scoped mutable session state store.
	 */
	get providerSessionState(): Map<string, ProviderSessionState> | undefined {
		return this.#providerSessionState;
	}

	/**
	 * Set provider-scoped mutable session state store.
	 */
	set providerSessionState(value: Map<string, ProviderSessionState> | undefined) {
		this.#providerSessionState = value;
	}

	/**
	 * Get the current thinking budgets.
	 */
	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this.#thinkingBudgets;
	}

	/**
	 * Set custom thinking budgets for token-based providers.
	 */
	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this.#thinkingBudgets = value;
	}

	/**
	 * Get the current sampling temperature.
	 */
	get temperature(): number | undefined {
		return this.#temperature;
	}

	/**
	 * Set sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	set temperature(value: number | undefined) {
		this.#temperature = value;
	}

	get topP(): number | undefined {
		return this.#topP;
	}

	set topP(value: number | undefined) {
		this.#topP = value;
	}

	get topK(): number | undefined {
		return this.#topK;
	}

	set topK(value: number | undefined) {
		this.#topK = value;
	}

	get minP(): number | undefined {
		return this.#minP;
	}

	set minP(value: number | undefined) {
		this.#minP = value;
	}

	get presencePenalty(): number | undefined {
		return this.#presencePenalty;
	}

	set presencePenalty(value: number | undefined) {
		this.#presencePenalty = value;
	}

	get repetitionPenalty(): number | undefined {
		return this.#repetitionPenalty;
	}

	set repetitionPenalty(value: number | undefined) {
		this.#repetitionPenalty = value;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.#serviceTier;
	}

	set serviceTier(value: ServiceTier | undefined) {
		this.#serviceTier = value;
	}

	get serviceTierResolver(): ((model: Model) => ServiceTier | undefined) | undefined {
		return this.#serviceTierResolver;
	}

	set serviceTierResolver(value: ((model: Model) => ServiceTier | undefined) | undefined) {
		this.#serviceTierResolver = value;
	}

	get hideThinkingSummary(): boolean | undefined {
		return this.#hideThinkingSummary;
	}

	set hideThinkingSummary(value: boolean | undefined) {
		this.#hideThinkingSummary = value;
	}

	/**
	 * Get the current max retry delay in milliseconds.
	 */
	get maxRetryDelayMs(): number | undefined {
		return this.#maxRetryDelayMs;
	}

	/**
	 * Set the maximum delay to wait for server-requested retries.
	 * Set to 0 to disable the cap.
	 */
	set maxRetryDelayMs(value: number | undefined) {
		this.#maxRetryDelayMs = value;
	}
	get state(): AgentState {
		return this.#state;
	}

	/**
	 * Tokenizer for the active model. The instance is replaced whenever the
	 * active model's encoding changes (see {@link setModel}), so callers must
	 * not cache it across model switches.
	 */
	get tokenizer(): Tokenizer {
		return this.#tokenizer;
	}

	/**
	 * Swap the tokenizer only when the encoding actually changes, so the warm
	 * per-message memo survives same-encoding model switches.
	 */
	#syncTokenizer(model: Model | null | undefined): void {
		if (tokenizerEncodingForModel(model) !== this.#tokenizer.encoding) {
			this.#tokenizer = new Tokenizer(model);
		}
	}

	get appendOnlyContext(): AppendOnlyContextManager | undefined {
		return this.#appendOnlyContext;
	}

	setAppendOnlyContext(manager?: AppendOnlyContextManager): void {
		this.#appendOnlyContext = manager;
	}

	#toolsForModel(model: Model): AgentTool[] {
		if (model.api !== "cursor-agent" || !this.#getCursorTools) return this.#state.tools;
		const cursorTools = this.#getCursorTools();
		if (cursorTools.length === 0) return this.#state.tools;

		const names = new Set(this.#state.tools.map(tool => tool.name));
		let merged: AgentTool[] | undefined;
		for (const tool of cursorTools) {
			if (names.has(tool.name)) continue;
			merged ??= this.#state.tools.slice();
			merged.push(tool);
			names.add(tool.name);
		}
		return merged ?? this.#state.tools;
	}

	/**
	 * Assemble the provider Context for a side-channel (no-loop) request, mirroring
	 * the main loop's prefix (system + normalized tools) so it shares the prompt
	 * cache. Never touches the append-only log or the tool-choice queue. Owned/
	 * in-band dialect sessions stay tools-less (matching their no-native-tools wire
	 * shape and avoiding tool-markup leakage). `llmMessages` is already converted
	 * (and, in production, obfuscated) by the caller.
	 *
	 * `systemPrompt` defaults to the live agent prompt so the side request hits the
	 * same cached prefix as the main loop. Callers that must pin a different prompt
	 * (e.g. handoff generation, which uses the base prompt rather than a per-turn
	 * `before_agent_start` hook override) pass it explicitly.
	 */
	async buildSideRequestContext(
		llmMessages: Message[],
		systemPrompt: string[] = this.#state.systemPrompt,
	): Promise<Context> {
		const model = this.#state.model;
		if (!model) throw new Error("No active model on agent");
		const ownedDialect = this.#dialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT);
		const messages = normalizeMessagesForProvider(llmMessages, model);
		const tools = ownedDialect
			? []
			: (normalizeTools(this.#toolsForModel(model), {
					injectIntent: this.#intentTracing,
					pruneDescriptions: this.#pruneToolDescriptions,
				}) ?? []);
		let context: Context = { systemPrompt, messages, tools };
		if (this.#transformProviderContext) context = await this.#transformProviderContext(context, model);
		return context;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** Register an independently removable hook that runs before queued messages are consumed. */
	addBeforeQueuedMessageDequeueHook(hook: (signal?: AbortSignal) => Promise<void> | void): () => void {
		const registration = (signal?: AbortSignal) => hook(signal);
		this.#beforeQueuedMessageDequeueHooks.add(registration);
		return () => this.#beforeQueuedMessageDequeueHooks.delete(registration);
	}

	/** Register an independently removable hook that runs immediately before each model call. */
	addBeforeModelCallHook(hook: (signal?: AbortSignal) => Promise<void> | void): () => void {
		const registration = (signal?: AbortSignal) => hook(signal);
		this.#beforeModelCallHooks.add(registration);
		return () => this.#beforeModelCallHooks.delete(registration);
	}

	async #runBeforeModelCallHooks(signal?: AbortSignal): Promise<void> {
		for (const hook of this.#beforeModelCallHooks) await hook(signal);
	}

	async #runBeforeQueuedMessageDequeueHooks(signal?: AbortSignal): Promise<void> {
		for (const hook of this.#beforeQueuedMessageDequeueHooks) await hook(signal);
	}

	async #dequeueSteeringMessagesAfterHooks(signal?: AbortSignal): Promise<AgentMessage[]> {
		if (signal?.aborted || this.#steeringQueue.length === 0) return [];
		await this.#runBeforeQueuedMessageDequeueHooks(signal);
		return signal?.aborted ? [] : this.#dequeueSteeringMessages();
	}

	async #dequeueFollowUpMessagesAfterHooks(signal?: AbortSignal): Promise<AgentMessage[]> {
		if (signal?.aborted || this.#followUpQueue.length === 0) return [];
		await this.#runBeforeQueuedMessageDequeueHooks(signal);
		return signal?.aborted ? [] : this.#dequeueFollowUpMessages();
	}

	setProviderResponseInterceptor(fn: SimpleStreamOptions["onResponse"] | undefined): void {
		this.#onResponse = fn;
	}

	setRawSseEventInterceptor(fn: SimpleStreamOptions["onSseEvent"] | undefined): void {
		this.#onSseEvent = fn;
	}

	setAssistantMessageEventInterceptor(
		fn: ((message: AssistantMessage, event: AssistantMessageEvent) => void) | undefined,
	): void {
		this.#onAssistantMessageEvent = fn;
	}

	setOnBeforeYield(fn: (() => Promise<void> | void) | undefined): void {
		this.#onBeforeYield = fn;
	}
	setOnTurnEnd(
		fn:
			| ((messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void)
			| undefined,
	): void {
		this.#onTurnEnd = fn;
	}

	/**
	 * Install or replace the host pre-model-call gate; pass `undefined` to
	 * remove it. Gates are sampled when a run starts: installing the first
	 * gate while a run is in flight takes effect on the next run.
	 */
	setBeforeModelCall(fn: AgentBeforeModelCall | undefined): void {
		this.#beforeModelCall = fn;
	}

	/**
	 * Add a pre-model callback without replacing callbacks owned by the host.
	 * Returns a disposer that removes only this callback. Like
	 * {@link setBeforeModelCall}, the first gate installed while a run is in
	 * flight takes effect on the next run.
	 */
	addBeforeModelCall(fn: AgentBeforeModelCall): () => void {
		this.#additionalBeforeModelCalls.add(fn);
		return () => {
			this.#additionalBeforeModelCalls.delete(fn);
		};
	}

	/**
	 * Provide a source of non-interrupting "aside" messages (e.g. background-job
	 * completions, late LSP diagnostics) drained at each step boundary. Never
	 * aborts in-flight tools. See `AgentLoopConfig.getAsideMessages`.
	 */
	setAsideMessageProvider(fn: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined): void {
		this.#asideMessageProvider = fn;
	}

	emitExternalEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				break;
			case "message_end":
				this.#state.streamMessage = null;
				this.appendMessage(event.message);
				break;
			case "tool_execution_start":
				this.#state.pendingToolCalls.add(event.toolCallId);
				break;
			case "tool_execution_end":
				this.#state.pendingToolCalls.delete(event.toolCallId);
				break;
		}

		this.#emit(event);
	}

	// State mutators
	setSystemPrompt(v: string[] | string) {
		this.#state.systemPrompt = typeof v === "string" ? [v] : v;
	}

	setModel(model: Model) {
		this.#state.model = model;
		this.#syncTokenizer(model);
	}

	setThinkingLevel(l: Effort | undefined) {
		this.#state.thinkingLevel = l;
	}

	setDisableReasoning(disabled: boolean) {
		this.#state.disableReasoning = disabled;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.#steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.#steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.#followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.#followUpMode;
	}

	setInterruptMode(mode: "immediate" | "wait") {
		this.#interruptMode = mode;
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.#interruptMode;
	}

	setTools(t: AgentTool<any>[]) {
		this.#state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		// New array assignment is intentional: caller-owned `ms` may be mutated
		// after handoff; snapshot it so external mutations cannot leak in.
		this.#state.messages = ms.slice();
	}

	replaceQueues(steering: AgentMessage[], followUp: AgentMessage[]) {
		this.#steeringQueue = steering.slice();
		this.#followUpQueue = followUp.slice();
		this.#notifySteeringWaiters();
	}

	appendMessage(m: AgentMessage) {
		this.#state.messages.push(m);
	}

	popMessage(): AgentMessage | undefined {
		const removed = this.#state.messages.pop();
		if (removed && this.#state.streamMessage === removed) {
			this.#state.streamMessage = null;
		}
		return removed;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 * Delivered after current tool execution, skips remaining tools.
	 */
	steer(m: AgentMessage) {
		this.#steeringQueue.push(m);
		this.#notifySteeringWaiters();
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 */
	followUp(m: AgentMessage) {
		this.#followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.#steeringQueue = [];
		this.#notifySteeringWaiters();
	}

	clearFollowUpQueue() {
		this.#followUpQueue = [];
	}

	/**
	 * Drop tool-directive state retained across a gate-stopped run: the
	 * deferred hard choice and the soft-requirement lifecycle.
	 */
	clearDeferredToolDirectives() {
		this.#deferredToolChoice = undefined;
		this.#softToolRequirementState = { escalations: 0 };
	}

	clearAllQueues() {
		this.#steeringQueue = [];
		this.#followUpQueue = [];
		this.#notifySteeringWaiters();
		this.clearDeferredToolDirectives();
	}

	hasQueuedMessages(): boolean {
		return this.#steeringQueue.length > 0 || this.#followUpQueue.length > 0;
	}

	/** Non-consuming view of the pending steering queue (insertion order, newest
	 *  last). The session layer derives its queued-message display/count from
	 *  this live view instead of a mirror, so the agent-core queue stays the
	 *  single source of truth. */
	peekSteeringQueue(): readonly AgentMessage[] {
		return this.#steeringQueue;
	}

	/** Non-consuming view of the pending follow-up queue. See
	 *  {@link peekSteeringQueue}. */
	peekFollowUpQueue(): readonly AgentMessage[] {
		return this.#followUpQueue;
	}

	get isAborting(): boolean {
		return this.#abortController?.signal.aborted === true && this.#state.isStreaming;
	}

	#dequeueSteeringMessages(): AgentMessage[] {
		if (this.#steeringMode === "one-at-a-time") {
			if (this.#steeringQueue.length > 0) {
				const first = this.#steeringQueue[0];
				this.#steeringQueue = this.#steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.#steeringQueue.slice();
		this.#steeringQueue = [];
		return steering;
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		if (this.#followUpMode === "one-at-a-time") {
			if (this.#followUpQueue.length > 0) {
				const first = this.#followUpQueue[0];
				this.#followUpQueue = this.#followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.#followUpQueue.slice();
		this.#followUpQueue = [];
		return followUp;
	}

	/**
	 * Remove and return the last steering message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}

	/**
	 * Remove and return the last follow-up message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}

	clearMessages() {
		this.#state.messages.length = 0;
	}

	abort(reason?: unknown) {
		this.#abortController?.abort(reason);
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	/**
	 * Wait for a steering message without consuming the steering queue.
	 *
	 * The signal releases the waiter when the prompt ends, so an in-flight
	 * tool watcher never survives the tool batch that owns it.
	 */
	#waitForSteeringMessages(signal?: AbortSignal): Promise<void> {
		if (this.#steeringQueue.length > 0 || signal?.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const onAbort = (): void => resolve();
		this.#steeringWaiters.add(resolve);
		signal?.addEventListener("abort", onAbort, { once: true });
		return promise.finally(() => {
			this.#steeringWaiters.delete(resolve);
			signal?.removeEventListener("abort", onAbort);
		});
	}

	#notifySteeringWaiters(): void {
		const waiters = [...this.#steeringWaiters];
		for (const resolve of waiters) resolve();
	}

	reset() {
		this.#state.messages.length = 0;
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls.clear();
		this.#state.error = undefined;
		this.#steeringQueue = [];
		this.#followUpQueue = [];
		this.#notifySteeringWaiters();
		this.clearDeferredToolDirectives();
	}

	/** Send a prompt with an AgentMessage */
	async prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];
		let promptOptions: AgentPromptOptions | undefined;
		let images: ImageContent[] | undefined;

		if (Array.isArray(input)) {
			msgs = input;
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		} else if (typeof input === "string") {
			if (Array.isArray(imagesOrOptions)) {
				images = imagesOrOptions;
				promptOptions = options;
			} else {
				promptOptions = imagesOrOptions;
			}
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		}

		await this.#runLoop(msgs, promptOptions);
	}

	/**
	 * Continue from current context (used for retries and resuming queued messages).
	 */
	#continuationDequeueSignal(signal?: AbortSignal): AbortSignal | undefined {
		const signals: AbortSignal[] = [];
		if (this.#abortController) signals.push(this.#abortController.signal);
		if (signal) signals.push(signal);
		if (this.#deadline !== undefined) {
			const delay = this.#deadline - Date.now();
			if (delay <= 0) {
				const controller = new AbortController();
				controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
				signals.push(controller.signal);
			} else {
				signals.push(AbortSignal.timeout(delay));
			}
		}
		if (signals.length === 0) return undefined;
		return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	}

	async continue(signal?: AbortSignal) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;
		const continuationAbortController = new AbortController();
		this.#abortController = continuationAbortController;
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		try {
			const dequeueSignal = this.#continuationDequeueSignal(signal);
			const messages = this.#state.messages;
			if (messages.length === 0) {
				// An empty transcript has nothing to resume, but a queued steer/follow-up
				// must still be delivered as the opening turn — mirroring the assistant-tail
				// branch below. Throwing here leaves the message undeliverable, and idle-drain
				// callers (AgentSession#scheduleQueuedMessageDrain) re-arm continue() on every
				// microtask because hasQueuedMessages() never clears, spinning an unbounded
				// allocation loop until OOM (issue #6344).
				const queuedSteering = await this.#dequeueSteeringMessagesAfterHooks(dequeueSignal);
				if (queuedSteering.length > 0) {
					await this.#runLoop(queuedSteering, { skipInitialSteeringPoll: true }, signal, true);
					return;
				}
				const queuedFollowUp = await this.#dequeueFollowUpMessagesAfterHooks(dequeueSignal);
				if (queuedFollowUp.length > 0) {
					await this.#runLoop(queuedFollowUp, undefined, signal, true);
					return;
				}
				throw new Error("No messages to continue from");
			}
			if (messages[messages.length - 1].role === "assistant") {
				const queuedSteering = await this.#dequeueSteeringMessagesAfterHooks(dequeueSignal);
				if (queuedSteering.length > 0) {
					await this.#runLoop(queuedSteering, { skipInitialSteeringPoll: true }, signal, true);
					return;
				}

				const queuedFollowUp = await this.#dequeueFollowUpMessagesAfterHooks(dequeueSignal);
				if (queuedFollowUp.length > 0) {
					await this.#runLoop(queuedFollowUp, undefined, signal, true);
					return;
				}

				throw new Error("Cannot continue from message role: assistant");
			}

			await this.#runLoop(undefined, undefined, signal, true);
		} finally {
			resolve();
			if (this.#abortController === continuationAbortController) {
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				this.#state.pendingToolCalls.clear();
				this.#abortController = undefined;
				if (this.#runningPrompt === promise) {
					this.#runningPrompt = undefined;
					this.#resolveRunningPrompt = undefined;
				}
			}
		}
	}

	/**
	 * Run the agent loop.
	 * If messages are provided, starts a new conversation turn with those messages.
	 * Otherwise, continues from existing context.
	 */
	async #runLoop(
		messages?: AgentMessage[],
		options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean },
		continuationSignal?: AbortSignal,
		runStateClaimed = false,
	) {
		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
		using _ = new EventLoopKeepalive();
		if (!runStateClaimed) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#runningPrompt = promise;
			this.#resolveRunningPrompt = resolve;
			this.#abortController = new AbortController();
		}
		const resolveRun = this.#resolveRunningPrompt;
		const loopAbortController = this.#abortController;
		if (!loopAbortController) throw new Error("Agent run state was not initialized");
		const loopSignal = continuationSignal
			? AbortSignal.any([loopAbortController.signal, continuationSignal])
			: loopAbortController.signal;
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		// Clear Cursor tool result buffer at start of each run
		this.#cursorToolResultBuffer = [];

		const reasoning = this.#state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};

		// Installed unconditionally. Both `cursorExecHandlers` and
		// `cursorOnToolResult` are optional, but the Cursor provider resolves
		// native todo calls server-side and synthesizes exec blocks regardless,
		// marking both `kCursorExecResolved` — `agent-loop.ts` then emits no
		// placeholder result for them. The provider always offers a paired result
		// for those blocks (its todo fallback, and every `resolveExecHandler`
		// exit including the no-handler one), but only through this sink: without
		// it the result is dropped on the floor, the assistant block is left
		// unpaired, and `buildSessionContext` strips the whole interaction on
		// replay. A non-Cursor provider never calls this, so the closure costs
		// nothing.
		const cursorOnToolResult = async (message: ToolResultMessage) => {
			// Cursor executes tools server-side during streaming. We buffer each
			// toolResult and emit them right after the assistant message closes
			// (see `#emitCursorSplitAssistantMessage`), so replay receives
			// (assistant with interleaved toolCall blocks) → results.
			//
			// The entry is reserved SYNCHRONOUSLY, before awaiting the optional
			// transformer. The provider's data loop dispatches messages with
			// `void handleServerMessage(...)`, so a `message_end` decoded from the
			// same chunk can drain the buffer while a transformer is still pending
			// — pushing afterwards would drop the result and strip its toolCall
			// block as dangling on replay.
			//
			// The transformer's in-flight promise is recorded on the entry so the
			// drain can await it (`#emitCursorSplitAssistantMessage`). Without
			// that, a transformer resolving after the swap would patch a detached
			// object while the persisted result kept the original payload — the
			// rewrite silently lost.
			const entry: CursorToolResultEntry = { toolResult: message };
			this.#cursorToolResultBuffer.push(entry);
			const transform = this.#cursorOnToolResult;
			if (transform) {
				const pending = (async () => {
					try {
						const updated = await transform(message);
						if (updated) entry.toolResult = updated;
					} catch {}
				})();
				entry.pending = pending;
				await pending;
				entry.pending = undefined;
			}
			return entry.toolResult;
		};

		let claimedToolChoice: ToolChoice | undefined;
		const getToolChoice = (): ToolChoiceDirective | undefined => {
			claimedToolChoice = undefined;
			const deferred = this.#deferredToolChoice;
			if (deferred !== undefined) {
				this.#deferredToolChoice = undefined;
				const active = refreshToolChoiceForActiveTools(deferred, this.#state.tools);
				if (active !== undefined) {
					claimedToolChoice = deferred;
					return active;
				}
				this.#onToolChoiceUnavailable?.();
			}

			const queued = this.#getToolChoice?.();
			if (queued !== undefined) {
				if (isSoftToolRequirement(queued)) {
					return (this.#state.tools ?? []).some(tool => tool.name === queued.toolName) ? queued : undefined;
				}
				const active = refreshToolChoiceForActiveTools(queued, this.#state.tools);
				if (active !== undefined) claimedToolChoice = queued;
				return active;
			}
			return refreshToolChoiceForActiveTools(options?.toolChoice, this.#state.tools);
		};

		const config: AgentLoopConfig = {
			model,
			reasoning,
			disableReasoning: this.#state.disableReasoning,
			temperature: this.#temperature,
			topP: this.#topP,
			topK: this.#topK,
			minP: this.#minP,
			presencePenalty: this.#presencePenalty,
			repetitionPenalty: this.#repetitionPenalty,
			serviceTier: this.#serviceTier,
			hideThinkingSummary: this.#hideThinkingSummary,
			interruptMode: this.#interruptMode,
			sessionId: this.#sessionId,
			deadline: this.#deadline,
			promptCacheKey: this.#promptCacheKey,
			metadata: this.#metadataResolver ? undefined : this.#metadata,
			metadataResolver: this.#metadataResolver,
			providerSessionState: this.#providerSessionState,
			thinkingBudgets: this.#thinkingBudgets,
			maxRetryDelayMs: this.#maxRetryDelayMs,
			kimiApiFormat: this.#kimiApiFormat,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: this.#convertToLlm,
			transformProviderContext: this.#transformProviderContext,
			transformContext: this.#transformContext,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			getApiKey: this.getApiKey,
			getToolContext: this.#getToolContext,
			syncContextBeforeModelCall: async (context, signal) => {
				await this.#runBeforeModelCallHooks(signal);
				if (this.#listeners.size > 0) {
					await Bun.sleep(0);
				}
				context.systemPrompt = this.#state.systemPrompt;
				context.tools = this.#toolsForModel(this.#state.model ?? model);
			},
			beforeModelCall:
				this.#beforeModelCall || this.#additionalBeforeModelCalls.size > 0
					? async (context, signal) => {
							const result = (await this.#beforeModelCall?.(context, signal)) || undefined;
							if (result?.stop) return result;
							for (const callback of this.#additionalBeforeModelCalls) {
								const callbackResult = (await callback(context, signal)) || undefined;
								if (callbackResult?.stop) return callbackResult;
							}
							return undefined;
						}
					: undefined,
			cursorExecHandlers: this.#cursorExecHandlers,
			cursorOnToolResult,
			cwd: this.#cwd,
			getCwd: this.#cwdResolver,
			transformToolCallArguments: this.#transformToolCallArguments,
			resolveFallbackTool: this.#resolveFallbackTool,
			intentTracing: this.#intentTracing,
			pruneToolDescriptions: this.#pruneToolDescriptions,
			dialect: this.#dialect,
			abortOnFabricatedToolResult: this.#abortOnFabricatedToolResult,
			appendOnlyContext: this.#appendOnlyContext,
			beforeToolCall: this.beforeToolCall ? (ctx, signal) => this.beforeToolCall?.(ctx, signal) : undefined,
			afterToolCall: this.afterToolCall ? (ctx, signal) => this.afterToolCall?.(ctx, signal) : undefined,
			transformAssistantMessage: this.transformAssistantMessage
				? (message, signal) => this.transformAssistantMessage?.(message, signal)
				: undefined,
			onAssistantMessageEvent: this.#onAssistantMessageEvent,
			onHarmonyLeak: this.#onHarmonyLeak,
			onTurnEnd: (messages, signal, context) => this.#onTurnEnd?.(messages, signal, context),
			getToolChoice,
			softToolRequirementState: this.#softToolRequirementState,
			onToolChoiceRejected: () => {
				if (claimedToolChoice !== undefined) this.#deferredToolChoice = claimedToolChoice;
			},
			getModel: () => this.#state.model ?? model,
			getReasoning: () => this.#state.thinkingLevel,
			getDisableReasoning: () => this.#state.disableReasoning,
			getServiceTier: this.#serviceTierResolver,
			getSteeringMessages: async signal => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.#dequeueSteeringMessagesAfterHooks(signal);
			},
			hasSteeringMessages: () => {
				if (this.#steeringQueue.length === 0) {
					return { queued: false };
				}
				const messageCount = this.#steeringMode === "one-at-a-time" ? 1 : this.#steeringQueue.length;
				let hasAgentSteering = false;
				for (let i = 0; i < messageCount; i++) {
					const message = this.#steeringQueue[i];
					const role = "role" in message ? message.role : undefined;
					const attribution = "attribution" in message ? message.attribution : undefined;
					if (attribution === "user") {
						return { queued: true, source: "user" };
					}
					if (role !== "user") continue;
					if (attribution !== "agent") {
						return { queued: true, source: "user" };
					}
					hasAgentSteering = true;
				}
				return { queued: true, source: hasAgentSteering ? "agent" : "system" };
			},
			waitForSteeringMessages: signal => this.#waitForSteeringMessages(signal),
			hasIrcInterrupts: this.hasIrcInterrupts,
			getFollowUpMessages: signal => this.#dequeueFollowUpMessagesAfterHooks(signal),
			getAsideMessages: async () => (await this.#asideMessageProvider?.()) ?? [],
			onBeforeYield: () => this.#onBeforeYield?.(),
			telemetry: this.#telemetry,
		};

		let partial: AgentMessage | null = null;
		const completedToolCallIds = new Set<string>();
		let turnOpen = false;

		try {
			const stream = messages
				? agentLoop(messages, context, config, loopSignal, this.streamFn)
				: agentLoopContinue(context, config, loopSignal, this.streamFn);

			for await (const event of stream) {
				if (event.type === "turn_start") turnOpen = true;
				if (event.type === "turn_end") turnOpen = false;
				// Update internal state based on events
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this.#state.streamMessage = event.message;
						if (event.assistantMessageEvent.type === "toolcall_end") {
							completedToolCallIds.add(event.assistantMessageEvent.toolCall.id);
						}
						break;

					case "message_end":
						partial = null;
						// Check if this is an assistant message with buffered Cursor tool results.
						// If so, split the message to emit tool results at the correct position.
						if (event.message.role === "assistant" && this.#cursorToolResultBuffer.length > 0) {
							await this.#emitCursorSplitAssistantMessage(event.message as AssistantMessage);
							continue; // Skip default emit - split method handles everything
						}
						this.#state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start":
						this.#state.pendingToolCalls.add(event.toolCallId);
						break;

					case "tool_execution_end":
						this.#state.pendingToolCalls.delete(event.toolCallId);
						break;

					case "turn_end":
						if (event.message.role === "assistant" && (event.message as any).errorMessage) {
							this.#state.error = (event.message as any).errorMessage;
						}
						break;

					case "agent_end":
						this.#state.isStreaming = false;
						this.#state.streamMessage = null;
						break;
				}

				// Emit to listeners
				this.#emit(event);
			}

			// Handle any remaining partial message
			if (partial && partial.role === "assistant" && Array.isArray(partial.content) && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					c =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				} else {
					if (loopSignal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err) {
			const stoppedForAbort = loopSignal.aborted;
			const errorMessage = stoppedForAbort
				? abortReasonText(loopSignal)
				: err instanceof Error
					? err.message
					: String(err);
			const shouldEmitVisibleError = !stoppedForAbort;
			const assistantPartial = partial?.role === "assistant" ? partial : undefined;
			const hadAssistantStart = assistantPartial !== undefined;
			// Same contract as the normal drain in `#emitCursorSplitAssistantMessage`:
			// a transformer still in flight must be awaited before the payload is
			// snapshotted, or its rewrite patches an entry this catch path already
			// detached and the original is persisted instead. A provider error is
			// exactly when a transform is most likely to be mid-flight.
			const pendingTransforms = this.#cursorToolResultBuffer
				.filter(entry => entry.pending !== undefined)
				.map(entry => entry.pending);
			if (pendingTransforms.length > 0) await Promise.all(pendingTransforms);
			const bufferedCursorResults = this.#cursorToolResultBuffer.map(({ toolResult }) => toolResult);
			const retainedToolCallIds = new Set(completedToolCallIds);
			for (const { toolCallId } of bufferedCursorResults) retainedToolCallIds.add(toolCallId);
			const errorMsg: AssistantMessage =
				shouldEmitVisibleError && assistantPartial
					? {
							...assistantPartial,
							content: assistantPartial.content.filter(
								block => block.type !== "toolCall" || retainedToolCallIds.has(block.id),
							),
							stopReason: "error",
							errorMessage,
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							api: model.api,
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
							stopReason: stoppedForAbort ? "aborted" : "error",
							errorMessage,
							timestamp: Date.now(),
						};

			if (shouldEmitVisibleError) {
				if (!turnOpen) {
					this.#emit({ type: "turn_start" });
					turnOpen = true;
				}
				if (!hadAssistantStart) {
					this.#state.streamMessage = errorMsg;
					this.#emit({ type: "message_start", message: errorMsg });
				}
				this.#state.streamMessage = null;
				this.appendMessage(errorMsg);
				this.#state.error = errorMessage;
				this.#emit({ type: "message_end", message: errorMsg });
				const toolResults: ToolResultMessage[] = [];
				this.#cursorToolResultBuffer = [];
				const bufferedCursorToolCallIds = new Set(bufferedCursorResults.map(({ toolCallId }) => toolCallId));
				for (const toolResult of bufferedCursorResults) {
					this.appendMessage(toolResult);
					this.#emit({ type: "message_start", message: toolResult });
					this.#emit({ type: "message_end", message: toolResult });
					toolResults.push(toolResult);
				}
				for (const block of errorMsg.content) {
					if (block.type !== "toolCall") continue;
					if (bufferedCursorToolCallIds.has(block.id)) continue;
					const toolResult = createSyntheticToolResultMessage(block, "error", errorMessage);
					this.#emit({
						type: "tool_execution_start",
						toolCallId: block.id,
						toolName: block.name,
						args: block.arguments,
						intent: block.intent,
					});
					this.#emit({
						type: "tool_execution_end",
						toolCallId: block.id,
						toolName: block.name,
						result: { content: toolResult.content, details: toolResult.details },
						isError: true,
					});
					this.appendMessage(toolResult);
					this.#emit({ type: "message_start", message: toolResult });
					this.#emit({ type: "message_end", message: toolResult });
					toolResults.push(toolResult);
				}
				this.#emit({ type: "turn_end", message: errorMsg, toolResults });
				turnOpen = false;
				this.#emit({ type: "agent_end", messages: [errorMsg, ...toolResults] });
			} else {
				this.appendMessage(errorMsg);
				this.#state.error = errorMessage;
				this.#emit({ type: "agent_end", messages: [errorMsg] });
			}
		} finally {
			resolveRun?.();
			if (this.#abortController === loopAbortController) {
				this.#state.isStreaming = false;
				this.#state.streamMessage = null;
				this.#state.pendingToolCalls.clear();
				this.#abortController = undefined;
				this.#runningPrompt = undefined;
				this.#resolveRunningPrompt = undefined;
			}
		}
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			try {
				const result = listener(e) as unknown;
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("Agent listener rejected", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("Agent listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Emit a Cursor assistant message with buffered exec-channel toolResults.
	 *
	 * Since the Cursor provider now synthesizes `toolCall` content blocks at the
	 * point each exec tool starts (issue #4348), the assistant message content
	 * already interleaves text/thinking with toolCall blocks in execution order.
	 * We emit the message as-is and let the buffered toolResults follow — the
	 * transcript rebuild in `renderSessionContext` pairs them by `toolCallId`.
	 *
	 * Historical note: this used to split the assistant message at
	 * `textLengthAtCall` to interpose toolResults between preamble and
	 * continuation. That workaround existed because native cursor tools had no
	 * toolCall blocks; it also copied `preambleText` into every text block on
	 * multi-text turns, producing duplicated text on replay.
	 */
	async #emitCursorSplitAssistantMessage(assistantMessage: AssistantMessage): Promise<void> {
		// Snapshot and detach immediately so a still-pending `cursorOnToolResult`
		// cannot push into a drained buffer. Entries already reserved stay paired
		// with their toolCall.
		const buffer = this.#cursorToolResultBuffer;
		this.#cursorToolResultBuffer = [];

		// Await any transformer still running for a reserved entry before reading
		// its payload. The provider dispatches with `void handleServerMessage(…)`,
		// so a `message_end` from the same chunk can reach this point while a
		// transformer is mid-flight; without the await its rewrite would land on
		// the detached entry after the original was already appended and emitted.
		// Each `pending` swallows its own rejection, so this cannot throw.
		const pending = buffer.filter(entry => entry.pending !== undefined).map(entry => entry.pending);
		if (pending.length > 0) await Promise.all(pending);

		this.#state.streamMessage = null;
		this.appendMessage(assistantMessage);
		this.#emit({ type: "message_end", message: assistantMessage });

		for (const { toolResult } of buffer) {
			this.#emit({ type: "message_start", message: toolResult });
			this.appendMessage(toolResult);
			this.#emit({ type: "message_end", message: toolResult });
		}
	}
}
