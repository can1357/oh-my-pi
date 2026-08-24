import type {
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	ImageContent,
	Message,
	Model,
	ServiceTier,
	SimpleStreamOptions,
	Static,
	streamSimple,
	TextContent,
	Tool,
	ToolCallProviderMetadata,
	ToolChoice,
	ToolResultMessage,
	ToolResultProviderMetadata,
	TSchema,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import type { HarmonyAuditEvent } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import type { AppendOnlyContextManager } from "./append-only-context";
import type {
	ExecutionToolArguments,
	JsonValue,
	PublicToolArguments,
	ToolCallPresentation,
	ToolFact,
	ToolOutcome,
	ToolPresentationEvent,
	ToolProgressProtocol,
	ToolProgressProtocolKind,
} from "./presentation";
import type { AgentRunCoverage, AgentRunSummary } from "./run-collector";
import type { AgentTelemetryConfig } from "./telemetry";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Called once an aside has been inserted into the agent's live context. */
export const ASIDE_MESSAGE_COMMIT = Symbol("aside-message-commit");
/** Called when an aside was drained but the agent loop ended before inserting it. */
export const ASIDE_MESSAGE_DISCARD = Symbol("aside-message-discard");

export type CommittableAsideMessage = AgentMessage & {
	[ASIDE_MESSAGE_COMMIT]?: () => void;
	[ASIDE_MESSAGE_DISCARD]?: (error: Error) => void;
};

/**
 * An aside entry: a ready {@link AgentMessage}, or a sync thunk evaluated at
 * injection time that returns the message to inject or `null` to skip it. Thunks
 * let the producer make the final inject-or-drop decision against current state
 * (e.g. dropping late diagnostics a newer edit superseded).
 */
export type AsideMessage = CommittableAsideMessage | (() => CommittableAsideMessage | null);

export interface AgentTurnEndContext {
	/** Assistant/user message that just completed this turn boundary. */
	message: AgentMessage;
	/** Tool results produced by this turn, already paired with `message` in the live context. */
	toolResults: ToolResultMessage[];
	/** True when the current tool-loop batch is continuing without yielding to post-turn steering. */
	willContinue: boolean;
}

export interface AgentPreModelCallStop {
	/** Stop the agent loop before sending the next provider request. */
	stop: true;
	/** Optional owner-facing reason, logged by the loop when it stops. */
	reason?: string;
}

export type AgentPreModelCallResult = AgentPreModelCallStop | undefined;

/**
 * A pre-model-call gate. Return {@link AgentPreModelCallStop} to refuse the
 * request, or nothing to proceed; the signal aborts with the run.
 */
export type AgentBeforeModelCall = (
	context: Context,
	signal?: AbortSignal,
) => AgentPreModelCallResult | void | Promise<AgentPreModelCallResult | void>;

/**
 * A soft tool requirement: the host wants `toolName` called before the loop
 * runs other tools or yields, but WITHOUT paying the forced-`toolChoice` cost
 * up front (changing `tool_choice` invalidates the provider message cache).
 * Returned from {@link AgentLoopConfig.getToolChoice} in place of a hard
 * {@link ToolChoice}: the loop injects `reminder` once when a new `id` becomes
 * active, runs with `toolChoice` unchanged, and escalates to a one-turn forced
 * choice only if the model fails to call `toolName`. Auto-clears when the host
 * stops returning it or `toolName` is no longer an active tool.
 */
export interface SoftToolRequirement {
	/** Discriminates a soft requirement from a hard {@link ToolChoice}. */
	soft: true;
	/**
	 * Stable id of the *current* requirement. The loop injects `reminder` when
	 * this id first becomes active and again whenever it changes (e.g. one
	 * stacked preview resolves and the next becomes the head), but never
	 * re-injects for an unchanged id across turns.
	 */
	id: string;
	/** Tool that must be called before the loop runs other tools or yields. */
	toolName: string;
	/**
	 * Per-call compliance check: a turn satisfies the requirement only when every
	 * tool call passes. Defaults to `name === toolName`. Lets a host demand a
	 * specific invocation shape (e.g. `write` targeting a virtual device path)
	 * instead of any call to `toolName`. Escalation still forces `toolName`.
	 */
	satisfies?(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean;
	/** Host-owned reminder messages, injected once per `id` activation. */
	reminder: AgentMessage[];
}

/**
 * A per-turn tool-choice directive: either a hard provider {@link ToolChoice}
 * (applied verbatim) or a {@link SoftToolRequirement} (remind-then-escalate).
 */
export type ToolChoiceDirective = ToolChoice | SoftToolRequirement;

/** Mutable soft-requirement lifecycle retained across stopped agent runs. */
export interface SoftToolRequirementState {
	id?: string;
	forcedToolChoice?: ToolChoice;
	escalations: number;
}

/** True when a {@link ToolChoiceDirective} is a soft requirement, not a hard choice. */
export function isSoftToolRequirement(directive: ToolChoiceDirective | undefined): directive is SoftToolRequirement {
	return typeof directive === "object" && directive !== null && (directive as SoftToolRequirement).soft === true;
}

/**
 * Source category for a queued steering interrupt observed without consuming the queue.
 * Distinguishes real-user, agent-authored, system/advisor, and unknown steering.
 */
export type SteeringInterruptSource = "user" | "agent" | "system" | "unknown";

/** Non-consuming summary of whether queued steering should interrupt a tool batch. */
export interface SteeringQueueState {
	/** True when at least one steering message is queued. */
	queued: boolean;
	/** Best-effort origin used only to word synthetic skipped-tool results. */
	source?: SteeringInterruptSource;
}

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate" = check after each tool call (default)
	 * - "wait" = defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;

	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/**
	 * Optional resolver called per LLM request to produce request metadata.
	 * When set, the agent loop evaluates it **after** `getApiKey` resolves the
	 * session-sticky credential, ensuring the metadata's `account_uuid` reflects
	 * the credential actually used for the request (not the credential that was
	 * current when `AgentLoopConfig` was first constructed). Overrides the static
	 * `metadata` field when present.
	 */
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (agent.tokenizer.countMessages(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Optional transform applied to the final provider context after conversion,
	 * normalization, and append-only context handling, but before telemetry capture
	 * and provider send.
	 */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	/**
	 * Resolves the API key or resolver for the current model before each LLM call.
	 *
	 * Returning an ApiKeyResolver lets the stream retry policy refresh or rotate
	 * the model-scoped credential after auth/usage-limit errors.
	 */
	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called at injection boundaries only (loop start and after a tool batch
	 * fully settles), so dequeued messages are immediately injected. The
	 * mid-batch interrupt poll uses {@link hasSteeringMessages} instead and
	 * never consumes the queue.
	 */
	getSteeringMessages?: (signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Peeks whether steering messages are queued, without consuming them.
	 *
	 * Called after each tool execution (unless interruptMode is "wait") to decide
	 * whether to skip the remaining tool calls in the batch. The queue keeps
	 * owning its messages until the loop reaches the next injection boundary and
	 * dequeues via {@link getSteeringMessages} — so callers can still cancel or
	 * restore queued messages while in-flight tools settle, and an external
	 * abort in that window leaves the queue intact for a post-abort continue.
	 *
	 * Returning `true` is treated as user-originated steering for compatibility.
	 * Return a {@link SteeringQueueState} when the queue can distinguish system
	 * advisories from real user messages.
	 *
	 * When omitted, steering never interrupts a running tool batch; queued
	 * messages are still delivered at the next injection boundary.
	 */
	hasSteeringMessages?: () => boolean | SteeringQueueState | Promise<boolean | SteeringQueueState>;

	/**
	 * Wakes the in-flight tool interrupt watcher when a steering message is queued.
	 * The callback must not consume the queue; the loop still calls
	 * {@link hasSteeringMessages} before aborting and injects through
	 * {@link getSteeringMessages}.
	 */
	waitForSteeringMessages?: (signal?: AbortSignal) => Promise<void>;

	/**
	 * Peeks whether IRC messages should interrupt an interruptible waiting tool.
	 *
	 * Uses the same delivery rules as steering: the poll is non-consuming, only
	 * runs for interruptible tools, and is ignored when interruptMode is "wait".
	 * The host owns message injection at the next boundary.
	 */
	hasIrcInterrupts?: () => boolean | Promise<boolean>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 */
	getFollowUpMessages?: (signal?: AbortSignal) => Promise<AgentMessage[]>;
	/**
	 * Returns non-interrupting "aside" messages to inject at a step boundary.
	 *
	 * Polled after each tool batch (before the next LLM call) AND at the yield
	 * check. Unlike steering, these NEVER abort in-flight tools — they are passive
	 * notifications (e.g. background-job completions, late LSP diagnostics) that
	 * should reach the model between requests without waiting for the agent to
	 * fully stop. Returned messages are appended to the context with normal
	 * message events and keep the loop running so the model can react.
	 */
	getAsideMessages?: () => Promise<AsideMessage[]>;
	/**
	 * Hook fired right before the loop would exit.
	 *
	 * Called when the agent has no more tool calls and no steering messages,
	 * immediately before polling follow-up messages.
	 */
	onBeforeYield?: () => Promise<void> | void;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Refreshes prompt/tool context from live session state before each model call.
	 * Use this when tool availability or the system prompt can change mid-turn.
	 *
	 * Runs after pending messages are folded in and before provider conversion.
	 * Mutate the agent context here; use `beforeModelCall` to inspect the
	 * provider-bound context.
	 */
	syncContextBeforeModelCall?: (context: AgentContext, signal?: AbortSignal) => void | Promise<void>;

	/**
	 * Asked after the complete provider context has been built, including
	 * message conversion, provider transforms, normalized tools, and owned
	 * dialect prompt injection. Returning {@link AgentPreModelCallStop} ends
	 * the stream without emitting `turn_start`, so no turn is left open and no
	 * request is billed. Return nothing to proceed. The signal aborts when
	 * the run is canceled or its deadline expires.
	 */
	beforeModelCall?: AgentBeforeModelCall;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	/**
	 * Resolve a tool call whose name matched no advertised tool (including
	 * `customWireName` aliases). Lets hosts route calls to tools they expose
	 * through side transports (e.g. `xd://` device mounts) instead of failing
	 * with "Tool not found". Returning `undefined` keeps the failure.
	 */
	resolveFallbackTool?: (name: string) => AgentTool<any> | undefined;

	/**
	 * Enable intent tracing for tool calls.
	 * When enabled, the harness injects a `string` field into tool schemas sent to the model,
	 * then strips from arguments before executing tools.
	 */
	intentTracing?: boolean;
	/**
	 * Strip tool descriptions (top-level + nested schema annotations) from the
	 * provider-bound tool specs. Use when the full catalog is rendered into the
	 * system prompt instead, so descriptions are not duplicated on the wire.
	 */
	pruneToolDescriptions?: boolean;
	/**
	 * Owned tool calling dialect.
	 *
	 * Undefined keeps provider-native tool calling. A dialect value sends no
	 * native `tools`, forces `toolChoice` off, appends that dialect's tool catalog
	 * instructions, re-encodes prior tool calls/results as text, and parses the
	 * model's text output back into canonical `toolCall` blocks.
	 */
	dialect?: Dialect;
	/**
	 * When owned (in-band) tool calling is active and the model starts
	 * fabricating a tool result inside its own turn, control how the loop reacts:
	 * - `true` (default): abort the provider request immediately so it stops
	 *   generating the hallucinated continuation (cheaper, lower latency).
	 * - `false`: let the request finish and silently discard everything past the
	 *   fabrication boundary (keeps the connection alive but pays for the tokens
	 *   the model spends on the discarded tail).
	 * Only meaningful when {@link dialect} (or `PI_DIALECT`) selects an
	 * owned dialect; native tool calling never fabricates results in text.
	 */
	abortOnFabricatedToolResult?: boolean;
	/**
	 * Append-only context mode — stabilizes system prompt + tool spec bytes
	 * across turns so provider prefix caches hit at maximum rate.
	 *
	 * When set, the loop reads messages from the append-only log (stable
	 * byte prefix) and caches system prompt + tools. Tools exclude per-turn
	 * `i` intent fields.
	 */
	appendOnlyContext?: AppendOnlyContextManager;

	/**
	 * Inspect assistant streaming events before they are published to the outer agent event stream.
	 * Callers may abort synchronously to stop consuming buffered provider events.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/**
	 * Called when GPT-5 Harmony protocol leakage is detected and mitigated.
	 */
	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;

	/**
	 * Dynamic tool-choice directive, resolved once per turn. Returns a hard
	 * {@link ToolChoice} (applied verbatim, overriding the static `toolChoice`),
	 * a {@link SoftToolRequirement} (the loop reminds-then-escalates instead of
	 * forcing `tool_choice` immediately, so a model that complies with the
	 * reminder pays no message-cache invalidation), or `undefined` to fall back
	 * to the static `toolChoice`.
	 */
	getToolChoice?: () => ToolChoiceDirective | undefined;

	/**
	 * Soft-requirement lifecycle retained by the host when a pre-model-call
	 * gate stops a run before its pending reminder or escalation is served.
	 */
	softToolRequirementState?: SoftToolRequirementState;

	/**
	 * Notifies the host that the pre-model-call gate stopped the run after a
	 * hard tool choice was obtained from {@link getToolChoice} but before it
	 * was served, so the host can retain it for the next admitted request.
	 */
	onToolChoiceRejected?: () => void;

	/**
	 * Dynamic reasoning effort override, resolved per LLM call.
	 * When set and returns a value, overrides the static `reasoning` captured
	 * at run-loop start. Use this so mid-run thinking-level changes apply on
	 * the next model call instead of waiting for the next prompt.
	 */
	getReasoning?: () => Effort | undefined;
	/**
	 * Dynamic model override, resolved once per LLM call. When set, each
	 * provider call re-reads the model (like {@link getReasoning}) so mid-run
	 * model switches — context promotion, retry fallback — apply on the next
	 * call instead of the run finishing on the stale model captured at
	 * run-loop start. Falls back to the static {@link model} when unset.
	 */
	getModel?: () => Model;

	/**
	 * Dynamic reasoning-disable override, resolved per LLM call. When set,
	 * its return value overrides the static `disableReasoning` from
	 * `SimpleStreamOptions` for that request. Pair with `getReasoning` so
	 * mid-run transitions into and out of the explicit `off` state propagate
	 * to the next provider call.
	 */
	getDisableReasoning?: () => boolean | undefined;

	/**
	 * Per-call effective service-tier resolver. Unlike {@link getReasoning},
	 * this is *authoritative*: when set, its return value (including
	 * `undefined`) fully replaces the static `serviceTier` for the request and
	 * its telemetry. The resolver receives the model being requested so the
	 * caller can scope the tier per provider/model without mutating the shared
	 * session `serviceTier` (e.g. opting a Fireworks model into the Priority
	 * serving path while leaving the OpenAI/Anthropic tier untouched).
	 */
	getServiceTier?: (model: Model) => ServiceTier | undefined;

	/**
	 * Per-call working-directory resolver, read once per LLM call. When set, its
	 * return value overrides the static {@link SimpleStreamOptions.cwd} for the
	 * request (falling back to that static `cwd` when it returns `undefined`).
	 * Lets the host reflect a session move (`/move`, which updates the working
	 * directory without reconstructing the loop config) into provider options —
	 * e.g. GitLab Duo Agent namespace/project discovery keys off this cwd's git
	 * remote, so a stale value would strand discovery on the original repo.
	 */
	getCwd?: () => string | undefined;

	/**
	 * Called once per tool call after argument validation, in call order, before
	 * the call is scheduled — ahead of concurrency resolution,
	 * `tool_execution_start`, and `tool.execute`. On the streamed path it runs
	 * before the assistant message's `message_start`/`message_end` are emitted.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool
	 * result instead (using `reason` as the error text, or a default if omitted).
	 *
	 * Return `{ args }` to replace the arguments the call runs with. The
	 * replacement is revalidated against the tool schema and written back to the
	 * tool-call block, making it the single source of truth: history, execution
	 * events, persistence, provider replay, concurrency scheduling, and
	 * `tool.execute` all see the revised arguments. Mutating `context.args` in
	 * place also survives into execution, but a returned `args` object wins.
	 *
	 * The hook receives the run's request abort signal and is responsible for
	 * honoring it. Throwing surfaces as a tool-error result and does not abort the
	 * rest of the batch.
	 */
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	/**
	 * Called after a turn ends and before the loop polls steering/asides for the
	 * next iteration. `context` carries the just-finished turn; `context.willContinue`
	 * is true when the current tool-loop batch is continuing without yielding to
	 * post-turn steering.
	 */
	onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;

	/**
	 * Called once an assistant message is finalized from the model stream, before
	 * it is appended to the context, emitted as `message_end`, or its tool calls
	 * are validated and dispatched. The hook may mutate the message in place —
	 * both its text content and its tool-call arguments — and those edits are seen
	 * by the transcript, the UI, and tool execution alike (single source of truth).
	 *
	 * Used for inline macro expansion: rewriting `@[[runtime.name(args)]]` tokens
	 * to host-computed values before anything downstream consumes the message.
	 * Runs at most once per assistant message; must not throw (a throw would abort
	 * the turn).
	 */
	transformAssistantMessage?: (message: AssistantMessage, signal?: AbortSignal) => Promise<void> | void;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and the
	 * tool-result message are emitted.
	 *
	 * Return an {@link AfterToolCallEffect} to apply a structured effect to the
	 * executed tool result; `undefined` (or `{kind: "unchanged"}`) leaves it as
	 * is. The loop applies the effect through `coerceToolResult`, the same
	 * untrusted-boundary normalizer the direct-execute path uses, before
	 * freezing/persisting the final record.
	 *
	 * Throwing surfaces as a tool-error result and does not abort the rest of the batch.
	 */
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallEffect | undefined> | AfterToolCallEffect | undefined;
	/**
	 * Wait for the active representation to deliver a typed call's settled frame.
	 *
	 * ACP installs this so manager follow-ups cannot overtake the literal terminal
	 * settlement on its outbound FIFO. Other representations leave it undefined,
	 * preserving the loop-only settlement boundary.
	 */
	afterPresentationSettlement?: (toolCallId: string) => Promise<void> | void;
	/**
	 * Opt-in OpenTelemetry instrumentation. Passing `{}` enables the loop's
	 * GenAI-semantic-convention spans (`invoke_agent`, `chat`, `execute_tool`)
	 * using the global tracer provider. Leaving this field undefined disables
	 * the instrumentation entirely — the loop performs zero tracer lookups.
	 *
	 * See {@link AgentTelemetryConfig} for the full surface (hooks, content
	 * capture, cost estimator, agent identity).
	 */
	telemetry?: AgentTelemetryConfig;
}

/**
 * Batch/sequencing metadata for the tool call currently being processed.
 */
export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
	/** Provider-native metadata for the current call, when present. */
	providerMetadata?: ToolCallProviderMetadata;
	/**
	 * Cooperative steering signal: aborted when a queued user/steering message
	 * (or an interrupting peer IRC) is detected while this tool batch runs.
	 * Unlike the hard abort signal it NEVER kills the tool — long-running
	 * tools MAY observe it (via `ctx.toolCall.steeringSignal`) to finish early
	 * or background themselves so the message injects promptly; ignoring it is
	 * always safe (the message injects at the next batch boundary).
	 */
	steeringSignal?: AbortSignal;
	/**
	 * The progress protocol the dispatcher selected for **this** call.
	 *
	 * Exactly one is offered per call, as a type. On the `presentation_events` arm
	 * the tool's `onUpdate` parameter is `undefined`, so a migrated route cannot
	 * also publish a cumulative legacy snapshot; on the `legacy_snapshot` arm
	 * `update` is the *same function object* the tool receives as `onUpdate`, so
	 * there is one callback surfaced two ways rather than two channels.
	 */
	progress?: ToolProgressProtocol<AgentToolResult<unknown>>;
}

/** A single tool-call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * A JSON value: the only kind of value that can cross the hook boundary as
 * revised tool arguments. Tool arguments are model-authored JSON, and the
 * execution copy is a deep clone that must succeed; a hook that returns a
 * non-JSON value (function, Date, Symbol, class instance) is a contract
 * violation rejected at the boundary, not a `DataCloneError` caught later.
 */
export type { JsonValue } from "./presentation/json";
/**
 * Result returned from `beforeToolCall`.
 *
 * Set `block: true` to prevent the tool from executing. The loop emits an error tool
 * result instead, using `reason` as the error text (or a default if omitted).
 *
 * Set `args` to replace the tool-call arguments. The replacement is revalidated
 * against the tool schema (a failure surfaces as a validation-error tool result),
 * written back to the tool-call block on the assistant message, and seen by
 * history, scheduling, execution events, and `tool.execute` alike. It is
 * ignored when `block` is true.
 *
 * `args` is typed as `Record<string, JsonValue>`: hook-revised arguments are
 * JSON values, validated at this untyped boundary. A non-JSON value is
 * rejected here, before the deep clone that produces the execution copy.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	args?: Record<string, JsonValue>;
}

/**
 * Structured effect returned from `afterToolCall`.
 *
 * Replaces the old field-by-field `AfterToolCallResult` patch, which let a
 * hook silently rewrite already-produced presentation state (including
 * `isError`/`useless`, independently of the executed result's own
 * `outcome`). Each arm names what it does instead of leaving the loop to
 * guess from which fields happened to be set:
 * - `"transform_external_result"` replaces the entire result with an
 *   untrusted `raw` value, routed back through `coerceToolResult` exactly
 *   like a tool's own return value — the boundary that already proves
 *   hostile/malformed values must be normalized, never trusted verbatim.
 * - `"add_guidance_fact"` prepends one `model_guidance` fact's rendered text
 *   ahead of the executed result's own content (TTSR's only in-tree use —
 *   `ttsr-coordinator.ts`'s `#afterToolCall`). Placement is always prepend,
 *   matching what TTSR already does today; this is not configurable per call.
 * - `"unchanged"` (or returning `undefined`) leaves the executed result as is.
 */
export type AfterToolCallEffect =
	| { kind: "transform_external_result"; raw: unknown }
	| { kind: "add_guidance_fact"; fact: Extract<ToolFact, { kind: "model_guidance" }> }
	| { kind: "unchanged" };

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** The resolved tool the call dispatches to. */
	tool: AgentTool<any>;
	/**
	 * Validated tool arguments. The same reference is forwarded to `tool.execute`
	 * (after any `transformToolCallArguments` pass), so in-place mutations stick;
	 * a returned `BeforeToolCallResult.args` replaces them entirely.
	 */
	args: Record<string, unknown>;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments used for execution (post `beforeToolCall` mutations). */
	args: Record<string, unknown>;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@oh-my-pi/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel?: Effort;
	disableReasoning?: boolean;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
	// Marks a non-throwing failure (e.g. an aggregator catching per-entry errors).
	// agent-loop honors this and surfaces it as a tool error on the wire.
	isError?: boolean;
	/** Provider-native metadata that must survive into history replay unchanged. */
	providerMetadata?: ToolResultProviderMetadata;
	/** Marks the result as contextually useless: safe for compaction to elide once consumed (e.g. zero matches, wait timeout). Ignored when isError is set. */
	useless?: boolean;
	/**
	 * The authoritative outcome of this call. Producers migrated onto
	 * the typed presentation protocol set this directly; `deriveToolOutcome`
	 * (`agent-loop.ts`) reads it when present instead of deriving one. Optional
	 * and terminal-only: an unmigrated producer omits it (and keeps falling
	 * through `deriveToolOutcome`'s existing synthetic/isError-derived branches
	 * unchanged, so its model goldens stay byte-identical), and a streamed
	 * `partialResult` (`AgentToolUpdateCallback`) never carries one — a partial
	 * has not terminated.
	 *
	 * Optional beside the retained `isError?` is the intended interim design,
	 * not a gap (plan §8 amendment, 2026-08-24): external/extension producers
	 * cannot author an `outcome`, so §3.5's required-field end state waits for
	 * derive-and-require at the `coerceToolResult` boundary. Until then,
	 * `deriveToolOutcome`'s precedence (explicit `outcome` first, then the
	 * synthetic/isError-derived branches) is the single authority reconciling
	 * the two fields; nothing else may arbitrate between them.
	 */
	outcome?: ToolOutcome;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/** Capability tier a tool exercises. Determines which approval modes auto-approve it. */
export type ToolTier = "read" | "write" | "exec";

/**
 * How an enabled tool is presented to the model. `"essential"` tools are exposed
 * as normal top-level tools. `"discoverable"` tools are removed from the top-level
 * schema and either mounted under `xd://` device URLs (when that transport is
 * active) or surfaced through BM25 tool search — keeping their schemas off every
 * request. Selection (settings, `hidden`, `defaultInactive`, explicit `--tools`,
 * provider availability) decides whether a tool is enabled; `loadMode` only
 * decides how an enabled tool is presented.
 */
export type ToolLoadMode = "essential" | "discoverable";

/**
 * Per-tool approval declaration.
 * - bare tier ("read" / "write" / "exec") — static classification.
 * - object form — adds a `reason` (shown in the prompt) and/or `override: true`
 *   (force-prompt even in modes that would otherwise auto-approve this tier).
 *   `policy: "deny"` blocks the call at the approval gate.
 * - function — dynamic, given parsed args. Returns either form above.
 *
 * Omitted approvals are treated as "exec" by callers that enforce approvals.
 */
export type ToolApprovalDecision =
	| ToolTier
	| {
			tier: ToolTier;
			reason?: string;
			override?: boolean;
			policy?: "allow" | "deny" | "prompt";
			/** User-policy key for this decision. When set, `tools.approval.<policyKey>`
			 *  is consulted instead of `tools.approval.<tool.name>`. Lets a dispatcher
			 *  tool (e.g. `write` for an `xd://` device call) scope user allow/deny/
			 *  prompt policies to the tool it dispatches into. */
			policyKey?: string;
	  };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

/**
 * Context passed to tool execution.
 * Apps can extend via declaration merging.
 */
export interface AgentToolContext {
	/**
	 * The dispatcher's per-call context, including the selected
	 * {@link ToolProgressProtocol}.
	 *
	 * Core-owned rather than an app convention, because the dispatcher has to be able
	 * to *verify* that the context a host built actually carries the producer it
	 * created. A host that drops this (there are legitimately such hosts — a
	 * standalone `Agent` supplies no `getToolContext` at all) makes the presentation
	 * protocol undeliverable, and the loop must fall back to legacy snapshots rather
	 * than run a call whose output has no channel. Apps still extend the rest of this
	 * interface via declaration merging.
	 */
	toolCall?: ToolCallContext;
}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails>>;

/**
 * A registered tool's presentation adapter.
 *
 * Its presence is what makes a tool *eligible* for the presentation protocol;
 * {@link ToolPresentationAdapter.selects} decides per call, because a single tool
 * can serve several routes (bash: local executor, client-bridge terminal, PTY,
 * async/background) and only some of them are migrated. An unmigrated route stays
 * explicitly on `legacy_snapshot`.
 *
 * The adapter's `outcome` hook used to exist because the dispatcher holds the
 * real tool instance when it invokes `execute`, so the input/detail generics
 * were still known there -- the only place a typed outcome could be derived
 * without the ACP mapper switching on `toolName` to guess a detail shape.
 * Phase 5 moved {@link ToolOutcome} onto {@link AgentToolResult} itself
 * (`outcome?`), so producers return it directly and the hook is gone; the
 * adapter now only selects the presentation route and builds the `started`
 * descriptor.
 */
export interface SelectedToolPresentationRoute<TRouting> {
	/** The execution route selected from transformed, non-public arguments. */
	readonly kind: "presentation_events";
	/**
	 * A tool-owned, display-safe capability derived while selecting the execution
	 * route. It is deliberately not the transformed argument object: descriptors
	 * remain unable to inspect a host's deobfuscated values.
	 */
	readonly routing: TRouting;
}

export interface ToolPresentationAdapter<TParameters extends TSchema = TSchema, TDetails = any, TRouting = unknown> {
	/**
	 * Whether *this* call runs on the presentation protocol. `false` keeps it legacy.
	 *
	 * Takes {@link ExecutionToolArguments}: a transform can flip `pty`/`async`/
	 * `timeout`, and route selection must judge the arguments the tool will
	 * actually execute with, not what the model wrote.
	 */
	selects: (
		this: AgentTool<TParameters, TDetails>,
		params: ExecutionToolArguments<Static<TParameters>>,
		context?: AgentToolContext,
	) => boolean | SelectedToolPresentationRoute<TRouting>;
	/**
	 * The call descriptor the loop emits as the `started` event.
	 *
	 * Takes {@link PublicToolArguments}: `title`, `sourceEcho`, and `rawInput` all
	 * flow from this descriptor onto a client-visible surface, so it must never see
	 * a host's post-transform (e.g. deobfuscated) arguments.
	 */
	start: (
		this: AgentTool<TParameters, TDetails>,
		toolCallId: string,
		params: PublicToolArguments<Static<TParameters>>,
		routing?: TRouting,
	) => ToolCallPresentation;
}

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool can stage a pending action that requires explicit resolution via the resolve tool. */
	deferrable?: boolean;
	/** How an enabled tool is presented. See {@link ToolLoadMode}. Omitted is treated as `"essential"` for built-ins; custom-tool adapters normalize omission to `"discoverable"`. */
	loadMode?: ToolLoadMode;
	/** Short one-line summary used for tool discovery indexes. */
	summary?: string;
	/**
	 * Concurrency mode for tool scheduling when multiple calls are in one turn.
	 * - "shared": can run alongside other shared tools (default)
	 * - "exclusive": runs alone; other tools wait until it finishes
	 * - function: resolved per call from the (raw, pre-validation) arguments
	 */
	concurrency?: "shared" | "exclusive" | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");
	/** If true, argument validation errors are non-fatal: raw args are passed to execute() instead of returning an error to the LLM. */
	lenientArgValidation?: boolean;
	/**
	 * Whether the agent loop may abort this tool mid-execution to deliver a
	 * queued steering message. A function resolves this per call from the raw,
	 * pre-validation arguments.
	 *
	 * Enable only for calls that purely *wait* and observe their abort signal
	 * cleanly (e.g. `job` poll), so the abort surfaces the tool's current
	 * snapshot rather than corrupting a side effect. Honored only when
	 * `interruptMode` is "immediate".
	 */
	interruptible?: boolean | ((args: Partial<Static<TParameters>>) => boolean);
	/**
	 * Controls how the INTENT_FIELD (`i`) is handled for this tool.
	 * - `"require"` (default): `i` is injected and required in the parameter schema.
	 * - `"optional"`: `i` is injected as an optional/nullable field.
	 * - `"omit"`: `i` is NOT injected. Use for tools where intent is obvious (yield, resolve, todo, …).
	 * - function: `i` is NOT injected; intent is derived dynamically from (potentially partial / streaming) args.
	 */
	intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);

	/**
	 * Normalize (potentially partial) streamed arguments into the plain text that
	 * stream-content matchers (e.g. TTSR rules) should inspect — the real content
	 * the call introduces, without wire grammar such as patch prefixes or JSON
	 * string escaping. Return `undefined` to fall back to raw argument-delta
	 * matching.
	 */
	matcherDigest?: (args: unknown) => string | undefined;

	/**
	 * Surface the target file paths a (potentially partial) streamed call would
	 * touch, so path-scoped stream matchers (e.g. TTSR `tool:edit(*.ts)` globs)
	 * can match without a top-level `path`/`paths` argument. Used for tools whose
	 * wire grammar embeds paths inside the streamed payload (hashline section
	 * headers, apply_patch envelope markers). Return `undefined` (or an empty
	 * array) to fall back to the caller's top-level argument scan.
	 */
	matcherPaths?: (args: unknown) => readonly string[] | undefined;

	/**
	 * Per-file projection of a (potentially partial) streamed call, pairing each
	 * touched file path with the digest of only the lines added to that file.
	 * Path-scoped stream matchers (TTSR) evaluate each entry in isolation, so a
	 * scoped rule like `tool:edit(*.ts)` never fires on text that actually
	 * belongs to a sibling Markdown hunk in a multi-file payload. Takes
	 * precedence over {@link matcherDigest} + {@link matcherPaths} when present;
	 * returns `undefined` (or empty) to fall back to the combined hooks.
	 */
	matcherEntries?: (args: unknown) => readonly { path: string; digest: string }[] | undefined;

	/** Capability tier declaration used by approval gates. Omitted means "exec". */
	approval?: ToolApproval;

	/** Lines appended after the standard approval prompt header. */
	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;

	/** The main execution callback for this tool. */
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/**
	 * Opt-in to the typed presentation protocol. See {@link ToolPresentationAdapter}.
	 *
	 * Note the adapter carries no second `execute`: the permission gate and the
	 * output-meta wrapper both proxy `execute`, and a parallel entry point would
	 * bypass them. The producer handle reaches the tool through
	 * `ctx.toolCall.progress` instead.
	 */
	presentation?: ToolPresentationAdapter<TParameters, TDetails>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (result: AgentToolResult<TDetails>, options: RenderResultOptions, theme: TTheme) => unknown;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string[];
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			/** Present iff `AgentTelemetryConfig` was supplied on this run. */
			telemetry?: AgentRunSummary;
			coverage?: AgentRunCoverage;
	  }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: any;
			intent?: string;
			/**
			 * Which progress protocol this call runs on. Omitted means
			 * `legacy_snapshot`: every emitter other than the dispatcher's own
			 * `runTool` is structurally incapable of creating a producer handle, so
			 * absence is a fact about the emitter rather than a default nobody chose.
			 * A consumer that renders presentation events reads this to know it must
			 * ignore the legacy start/end pair for the same call.
			 */
			progressProtocol?: ToolProgressProtocolKind;
	  }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError?: boolean;
			progressProtocol?: ToolProgressProtocolKind;
	  }
	/**
	 * One typed presentation event for one tool call.
	 *
	 * Additive and fully typed on purpose: routing new structure back through
	 * `details: any` would recreate the drift class this work exists to delete.
	 * `started`/`settled` are emitted by the agent loop alone; everything between
	 * comes from the call's scoped producer handle.
	 */
	| { type: "tool_presentation"; toolCallId: string; toolName: string; event: ToolPresentationEvent };
