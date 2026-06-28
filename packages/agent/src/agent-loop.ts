/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	isApiKeyResolver,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	streamSimple,
	stripSchemaDescriptions,
	type ToolChoice,
	type ToolResultMessage,
	type TSchema,
	toolWireSchema,
	validateToolArguments,
} from "@pk-nerdsaver-ai/pi-ai";
import {
	type Dialect,
	encodeInbandToolHistory,
	renderInbandToolPrompt,
	renderToolExamples,
	wrapInbandToolStream,
} from "@pk-nerdsaver-ai/pi-ai/dialect";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonyDetection,
	type HarmonyRecoveredToolCall,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	signalListLabel,
} from "@pk-nerdsaver-ai/pi-ai/utils/harmony-leak";
import { preferredDialect } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { sanitizeText, structuredCloneJSON } from "@pk-nerdsaver-ai/pi-utils";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import { type AgentRunCoverage, type AgentRunSummary, ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	PiGenAIAttr,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	type Span,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "./telemetry";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentTurnEndContext,
	AsideMessage,
	StreamFn,
} from "./types";
import { isSoftToolRequirement } from "./types";
import { yieldIfDue } from "./utils/yield";

/** Stop-details marker for a provider error after assistant content/tool args already streamed. */
export const STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL = "stream_interrupted_after_content";

/** Sentinel returned by the abort race in `streamAssistantResponse`. */
const ABORTED: unique symbol = Symbol("agent-loop-aborted");

/**
 * Cap on consecutive re-samples triggered by a non-terminal stop
 * (`stopDetails.type === "pause_turn"`) without an intervening tool call. Each
 * continuation is a full model request, so a backend that never stops pausing
 * must not spin the loop forever. Resets whenever a turn carries tool calls.
 */
const MAX_PAUSED_TURN_CONTINUATIONS = 8;

/**
 * Cap on consecutive forced escalations for a single soft tool requirement.
 * A forced `toolChoice` guarantees the call, so this is purely defensive: if a
 * model somehow never satisfies the requirement, give up forcing rather than
 * spin the loop. Reset whenever the requirement id changes or clears.
 */
const MAX_SOFT_TOOL_ESCALATIONS = 3;

/**
 * Whether a hard `toolChoice` for a turn conflicts with a pending soft tool
 * requirement — i.e. forbids tools (`"none"`) or forces a *different* specific
 * tool. `"auto"`/`"required"`/`"any"` and a same-tool force still let the model
 * satisfy the requirement, so they do not conflict and the soft gate stays active.
 */
function hardToolChoiceBlocks(choice: ToolChoice | undefined, requiredTool: string): boolean {
	if (choice === undefined) return false;
	if (typeof choice === "string") return choice === "none";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

/**
 * Cadence (ms) for polling queued steering while an `interruptible` tool is in
 * flight, so a steer cuts the wait short instead of sitting idle until the
 * tool's own window elapses. A cheap synchronous queue check; latency-bounded
 * at one tick.
 */
const STEERING_INTERRUPT_POLL_MS = 250;

class HarmonyLeakInterruption extends Error {
	constructor(
		readonly detection: HarmonyDetection,
		readonly removed: string,
		readonly recovered?: HarmonyRecoveredToolCall,
	) {
		super(`Detected GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`);
		this.name = "HarmonyLeakInterruption";
	}
}
export function resolveOwnedDialectFromEnv(value: string | undefined): Dialect | undefined {
	switch (value) {
		case "1":
		case "true":
			return "glm";
		case "glm":
		case "hermes":
		case "kimi":
		case "xml":
		case "anthropic":
		case "deepseek":
		case "harmony":
		case "qwen3":
		case "gemini":
		case "gemma":
		case "minimax":
			return value;
		default:
			return undefined;
	}
}

type AssistantContentBlock = AssistantMessage["content"][number];
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;

function snapshotAssistantContentBlock(block: AssistantContentBlock): AssistantContentBlock {
	switch (block.type) {
		case "text":
			return { ...block };
		case "thinking":
			return { ...block };
		case "redactedThinking":
			return { ...block };
		case "toolCall":
			return { ...block, arguments: structuredCloneJSON(block.arguments) };
	}
}

function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map(snapshotAssistantContentBlock),
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		disabledFeatures: message.disabledFeatures ? [...message.disabledFeatures] : undefined,
	};
}

/**
 * Deep-clone an assistant streaming event so subscribers get an immutable view.
 * Pass `partialSnapshot` when the caller has already snapshotted `event.partial`
 * (the `message_update` push sites alias it as the event's `message`) so the
 * identical partial is not deep-cloned twice per streaming delta.
 */
function snapshotAssistantMessageEvent(
	event: AssistantMessageEvent,
	partialSnapshot?: AssistantMessage,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial) };
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial) };
		case "toolcall_end":
			return {
				...event,
				toolCall: snapshotAssistantContentBlock(event.toolCall) as AssistantToolCallBlock,
				partial: partialSnapshot ?? snapshotAssistantMessage(event.partial),
			};
		case "done":
			return { ...event, message: snapshotAssistantMessage(event.message) };
		case "error":
			return { ...event, error: snapshotAssistantMessage(event.error) };
	}
}

/**
 * Normalize a value coming back from `tool.execute()` (or its streaming partial-update callback)
 * into a structurally valid {@link AgentToolResult}.
 *
 * The tool interface is typed, but third-party tools (MCP, extensions, user-authored AgentTools)
 * can violate the contract at runtime. Persisting a malformed result corrupts the session file
 * (missing `content` array → crash on reload). We coerce at the single boundary where untyped
 * results enter the agent loop, so every downstream consumer can rely on the type.
 */
const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

function hasSubstantiveToolResultContent(content: AgentToolResult["content"]): boolean {
	for (const block of content) {
		if (block.type === "image") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

function coerceToolResult(raw: unknown): { result: AgentToolResult<unknown>; malformed: boolean } {
	const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const rawContent = rawObj?.content;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	// Tools may flag a non-throwing failure on the result itself (e.g. an
	// aggregator that catches per-entry errors and synthesizes a combined
	// result). Preserve the flag so agent-loop can surface it on the wire.
	const explicitError = Boolean(rawObj && "isError" in rawObj && rawObj.isError);
	// Tools may flag the result contextually useless (zero matches, elapsed
	// wait) so compaction can elide it once consumed. Errors are never useless.
	const useless = Boolean(rawObj && "useless" in rawObj && rawObj.useless);

	if (!Array.isArray(rawContent)) {
		return {
			result: {
				content: [{ type: "text", text: "Tool returned an invalid result: missing content array." }],
				details,
				isError: true,
			},
			malformed: true,
		};
	}

	const content: AgentToolResult["content"] = [];
	let invalidBlocks = 0;
	for (const block of rawContent) {
		if (!block || typeof block !== "object" || !("type" in block)) {
			invalidBlocks++;
			continue;
		}
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			content.push({ type: "text", text: sanitizeText((block as { text: string }).text) });
		} else if (
			block.type === "image" &&
			typeof (block as { data?: unknown }).data === "string" &&
			typeof (block as { mimeType?: unknown }).mimeType === "string"
		) {
			content.push(block as { type: "image"; data: string; mimeType: string });
		} else {
			invalidBlocks++;
		}
	}
	if (invalidBlocks > 0) {
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${invalidBlocks} content block${invalidBlocks === 1 ? "" : "s"} had an unsupported shape.`,
		});
	}
	const isError = explicitError || invalidBlocks > 0;
	// Anthropic rejects tool_result blocks with is_error: true and empty content.
	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	return {
		result: {
			content,
			details,
			...(isError ? { isError: true } : {}),
			...(useless && !isError ? { useless: true } : {}),
		},
		malformed: invalidBlocks > 0,
	};
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context, messages: [...context.messages] };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Build the `agent_end` event payload. When telemetry is enabled, snapshots
 * the run collector so consumers receive {@link AgentRunSummary} +
 * {@link AgentRunCoverage} alongside the messages without parsing OTEL spans.
 * When telemetry is unset, returns the bare event for backwards compatibility.
 */
function buildAgentEndEvent(
	messages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): Extract<AgentEvent, { type: "agent_end" }> {
	if (!telemetry) return { type: "agent_end", messages };
	const snapshot = telemetry.collector.snapshot({ stepCount });
	if (telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	return { type: "agent_end", messages, telemetry: snapshot.summary, coverage: snapshot.coverage };
}
/**
 * Push a `turn_end` event and run the awaited per-turn hook when the run is
 * still healthy. The hook is skipped for externally aborted or errored turns so
 * a user interrupt does not hang on a background backlog wait.
 */
async function emitTurnEnd(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	currentContext: AgentContext,
	message: AgentMessage,
	toolResults: ToolResultMessage[],
	config: AgentLoopConfig,
	signal?: AbortSignal,
	context?: Omit<AgentTurnEndContext, "message" | "toolResults">,
): Promise<void> {
	stream.push({ type: "turn_end", message, toolResults });
	const isAbortedOrError =
		message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
	if (signal?.aborted || isAbortedOrError) return;
	await config.onTurnEnd?.(currentContext.messages, signal, { message, toolResults, willContinue: false, ...context });
}

/**
 * Detailed-result handle returned by {@link agentLoopDetailed}. Adds the
 * run-level telemetry/coverage rollup to the existing `AgentMessage[]`
 * payload without changing the resolved type of `stream.result()`.
 */
export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

/**
 * Convenience wrapper over {@link agentLoop} that exposes the run-level
 * summary + coverage alongside the messages. The returned `stream` is the
 * same `EventStream` callers already consume; `detailed()` awaits the
 * stream's `agent_end` event and returns the additive fields.
 *
 * Existing `stream.result()` semantics are preserved — it still resolves to
 * `AgentMessage[]`. Use {@link agentLoopDetailed} when you need the rollup;
 * use {@link agentLoop} when you do not.
 */
export function agentLoopDetailed(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoop(prompts, context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/**
 * Like {@link agentLoopDetailed} but built on top of
 * {@link agentLoopContinue}.
 */
export function agentLoopContinueDetailed(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoopContinue(context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/**
 * Wire an `onRunEnd` telemetry hook onto `config` so the detailed helper can
 * capture the run summary without consuming the event stream. Preserves any
 * existing `onRunEnd` the caller had set.
 */
function createDetailedCapture(config: AgentLoopConfig): {
	readonly config: AgentLoopConfig;
	readonly detailed: (stream: EventStream<AgentEvent, AgentMessage[]>) => Promise<AgentLoopDetailedResult>;
} {
	let captured: { summary: AgentRunSummary; coverage: AgentRunCoverage } | undefined;
	const userHook = config.telemetry?.onRunEnd;
	const wired: AgentLoopConfig = {
		...config,
		telemetry: {
			...(config.telemetry ?? {}),
			onRunEnd: (summary, coverage) => {
				captured = { summary, coverage };
				userHook?.(summary, coverage);
			},
		},
	};
	return {
		config: wired,
		detailed: async stream => {
			const messages = await stream.result();
			return {
				messages,
				telemetry: captured?.summary,
				coverage: captured?.coverage,
			};
		},
	};
}

export function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let hasThinking = false;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "thinking") {
				hasThinking = true;
				break;
			}
		}
		if (hasThinking) break;
	}
	if (!hasThinking) return messages;

	return messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		const filtered = message.content.filter(block => block.type !== "thinking");
		return filtered.length === message.content.length ? message : { ...message, content: filtered };
	});
}

const INTENT_FIELD_DESCRIPTION = "concise intent";

function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const properties =
		propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
			? (propertiesValue as Record<string, unknown>)
			: {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: [...required, INTENT_FIELD] } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: describeIntent
				? { type: "string", description: INTENT_FIELD_DESCRIPTION }
				: { type: "string" },
			...properties,
		},
		...(mode === "require" ? { required: [...required, INTENT_FIELD] } : {}),
	};
}

export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions = false,
): Context["tools"] {
	injectIntent = injectIntent && Bun.env.PI_NO_INTENT !== "1";
	return tools?.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		const doInjectIntent = injectIntent && intentMode !== "omit";
		// When the full catalog is rendered into the system prompt, ship the tool
		// specs without their descriptions (top-level + nested schema annotations)
		// so they are not duplicated on the wire. Strip the STABLE wire schema (the
		// memoized `stripSchemaDescriptions` result is reused across requests), then
		// re-inject `i` (without its hint, which `describeIntent: false` omits) so
		// intent tracing keeps the field while no descriptions ride the wire.
		if (pruneDescriptions) {
			let parameters = stripSchemaDescriptions(toolWireSchema(t)) as TSchema;
			if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode, false) as TSchema;
			return { ...t, parameters, description: "" };
		}
		let parameters = toolWireSchema(t) as TSchema;
		if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
		const description = t.description ?? "";
		const examplesBlock = exampleDialect
			? renderToolExamples({ ...t, parameters }, exampleDialect, doInjectIntent ? INTENT_FIELD : undefined)
			: "";
		const finalDescription = examplesBlock ? `${description}\n\n${examplesBlock}` : description;
		return { ...t, parameters, description: finalDescription };
	});
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	const telemetry = resolveTelemetry(config.telemetry, config.sessionId);
	const invokeAgentSpan = startInvokeAgentSpan(telemetry, config.model);
	const stepCounter = { count: 0 };
	let caughtError: unknown;
	try {
		await runInActiveSpan(invokeAgentSpan, () =>
			runLoopBody(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				telemetry,
				invokeAgentSpan,
				stepCounter,
				streamFn,
			),
		);
	} catch (err) {
		caughtError = err;
		throw err;
	} finally {
		finishInvokeAgentSpan(telemetry, invokeAgentSpan, {
			stepCount: stepCounter.count,
			errorObject: caughtError,
		});
	}
}

interface StepCounter {
	count: number;
}

function isDeadlineExceeded(deadline: number | undefined): boolean {
	return deadline !== undefined && Date.now() >= deadline;
}

function endAgentStream(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	newMessages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): void {
	stream.push(buildAgentEndEvent(newMessages, telemetry, stepCount));
	stream.end(newMessages);
}

/**
 * Resolve aside entries at the moment the loop is about to inject them. Each entry
 * is either a ready {@link AgentMessage} or a sync thunk evaluated here so the
 * producer can make the final inject-or-drop decision (return null) against
 * up-to-the-injection state — e.g. dropping late diagnostics a newer edit
 * superseded. Kept sync so it can never stall the loop.
 */
function resolveAsides(entries: AsideMessage[] | undefined): AgentMessage[] {
	if (!entries || entries.length === 0) return [];
	const out: AgentMessage[] = [];
	for (const entry of entries) {
		const message = typeof entry === "function" ? entry() : entry;
		if (message) out.push(message);
	}
	return out;
}

async function runLoopBody(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
): Promise<void> {
	let deadlineTimer: Timer | undefined;
	if (config.deadline !== undefined) {
		const deadlineAbortController = new AbortController();
		const delay = config.deadline - Date.now();
		if (delay <= 0) {
			deadlineAbortController.abort("Deadline exceeded");
		} else {
			deadlineTimer = setTimeout(() => {
				deadlineAbortController.abort("Deadline exceeded");
			}, delay);
		}
		signal = signal ? AbortSignal.any([signal, deadlineAbortController.signal]) : deadlineAbortController.signal;
	}

	try {
		let firstTurn = true;
		if (isDeadlineExceeded(config.deadline)) {
			endAgentStream(stream, newMessages, telemetry, stepCounter.count);
			return;
		}
		// Check for steering messages at start (user may have typed while waiting).
		// Skip when the run is already externally aborted — dequeuing would strand
		// the messages in a run that is about to die.
		let pendingMessages: AgentMessage[] = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
		let harmonyRetryAttempt = 0;
		let harmonyTruncateResumeCount = 0;
		let pausedTurnContinuations = 0;

		// Soft tool requirement lifecycle (reminder → escalate; see SoftToolRequirement).
		// `forcedToolChoice` carries a one-turn escalation into the next model call. It
		// overrides the static toolChoice but NEVER the host's hard getToolChoice().
		let softRequirementId: string | undefined;
		let forcedToolChoice: ToolChoice | undefined;
		let softEscalations = 0;
		// Resolved once per logical turn at the fetch site below and reused across
		// Harmony-leak re-samples (which re-enter the same turn) so the consuming
		// getToolChoice is never advanced twice; the flag resets at the message boundary.
		let hostToolChoice: ToolChoice | undefined;
		let softRequiredTool: string | undefined;
		let directiveResolvedForTurn = false;

		// Outer loop: continues when queued follow-up messages arrive after agent would stop
		while (true) {
			let hasMoreToolCalls = true;

			// Inner loop: process tool calls and steering messages
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (isDeadlineExceeded(config.deadline)) {
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}
				// Yield at the top of each iteration to prevent busy-wait when
				// the agent loop is executing tool calls back-to-back.
				await yieldIfDue();
				if (!firstTurn) {
					stream.push({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				// Process pending messages (inject before next assistant response)
				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						stream.push({ type: "message_start", message });
						stream.push({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				// Refresh prompt/tool context from live state before each model call
				if (config.syncContextBeforeModelCall) {
					await config.syncContextBeforeModelCall(currentContext);
				}

				// Resolve the per-turn tool-choice directive ONCE per logical turn. The
				// host hard-choice path (getToolChoice → nextToolChoice) is CONSUMING — it
				// advances a generator on every call — so Harmony-leak retries, which
				// re-sample the same turn via `continue` without a turn_end, must reuse the
				// values fetched on the first attempt rather than double-advancing it.
				// Fetched here (after pending-message flush + context sync, immediately
				// before the call) so a throw in between cannot wedge an in-flight
				// directive. A hard ToolChoice is applied verbatim; a SoftToolRequirement
				// triggers the remind-then-escalate lifecycle: inject its reminder inline
				// once per new id (toolChoice stays auto), and the gate below escalates to
				// a forced choice only if the model declines. The host wrapper already
				// dropped a soft requirement whose tool is inactive.
				if (!directiveResolvedForTurn) {
					const directive = signal?.aborted ? undefined : config.getToolChoice?.();
					const softReq = isSoftToolRequirement(directive) ? directive : undefined;
					hostToolChoice = directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
					softRequiredTool = softReq?.toolName;
					if (softReq !== undefined) {
						if (softReq.id !== softRequirementId) {
							softRequirementId = softReq.id;
							softEscalations = 0;
							for (const reminder of softReq.reminder) {
								stream.push({ type: "message_start", message: reminder });
								stream.push({ type: "message_end", message: reminder });
								currentContext.messages.push(reminder);
								newMessages.push(reminder);
							}
						}
					} else {
						softRequirementId = undefined;
						softEscalations = 0;
					}
					directiveResolvedForTurn = true;
				}

				// Stream assistant response
				let recovered: HarmonyRecoveredToolCall | undefined;
				let message: AssistantMessage;
				try {
					message = await streamAssistantResponse(
						currentContext,
						config,
						signal,
						stream,
						telemetry,
						invokeAgentSpan,
						stepCounter,
						streamFn,
						harmonyRetryAttempt,
						hostToolChoice,
						forcedToolChoice,
					);
					harmonyRetryAttempt = 0;
					harmonyTruncateResumeCount = 0;
				} catch (err) {
					if (!(err instanceof HarmonyLeakInterruption)) throw err;
					if (err.recovered) {
						if (harmonyTruncateResumeCount >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak recurred after truncate-and-resume recovery (${signalListLabel(err.detection.signals)}).`,
							);
						}
						harmonyTruncateResumeCount++;
						recovered = err.recovered;
						message = recovered.message;
						await emitHarmonyAudit(config, err, "truncate_resume", harmonyRetryAttempt);
						// A recovered message completes the turn, so the abort-retry counter
						// resets like the normal success path (the truncate-resume counter
						// keeps accumulating for its cross-turn cap).
						harmonyRetryAttempt = 0;
					} else {
						if (harmonyRetryAttempt >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak persisted after ${harmonyRetryAttempt} retries (${signalListLabel(err.detection.signals)}).`,
							);
						}
						await emitHarmonyAudit(config, err, "abort_retry", harmonyRetryAttempt);
						harmonyRetryAttempt++;
						continue;
					}
				}
				if (recovered) {
					message = snapshotAssistantMessage(message);
					currentContext.messages.push(message);
					stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
					stream.push({ type: "message_end", message: snapshotAssistantMessage(message) });
				}
				newMessages.push(message);

				// The escalation choice (if any) applied to the call above; clear it so
				// only the single escalation turn carries the forced choice.
				forcedToolChoice = undefined;

				// A fresh logical turn re-resolves the directive next iteration; a Harmony
				// retry `continue`s before this line and keeps the cached value.
				directiveResolvedForTurn = false;

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					// Create placeholder tool results for any tool calls in the aborted message
					// This maintains the tool_use/tool_result pairing that the API requires
					type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
					const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
					const toolResults: ToolResultMessage[] = [];
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						// The placeholder result above keeps the API's tool_use/tool_result
						// pairing intact, but no execute_tool span is started for these
						// calls. Mirror the run-collector entry directly so the run
						// summary's tool counters and `coverage.toolsInvoked` reflect
						// what the user actually saw on the wire.
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: message.stopReason === "aborted" ? "aborted" : "error",
						});
					}
					await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, { willContinue: false });

					stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count));
					stream.end(newMessages);
					return;
				}

				// Run tools whenever the turn carries tool_use blocks AND was not truncated.
				// `stop_reason` is provider metadata that never goes back on the wire, so it
				// does not gate continuation validity: replaying a tool_use turn with the
				// tool_results appended is accepted whether the turn ended on `tool_use` or
				// `end_turn` (adaptive/interleaved-thinking Opus routinely emits tool calls
				// under `end_turn`; verified against the live Anthropic API). The only
				// continuation hazard is a thinking block carrying a stale/invalid signature,
				// which `transformMessages` already neutralizes — it strips the signature on
				// non-`toolUse` turns and the encoder downgrades the unsigned block to text,
				// which the API accepts. So treat `stop` (end_turn/pause_turn) the same as
				// `toolUse`. `length` (max_tokens) is the one reason we must NOT run: the
				// trailing tool_use may be truncated with incomplete arguments — those calls
				// are abandoned below. (`error`/`aborted` already returned above.)
				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
				const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
				hasMoreToolCalls = runnableStop && toolCalls.length > 0;

				const deadlinePassed = isDeadlineExceeded(config.deadline);
				if (hasMoreToolCalls && deadlinePassed) {
					hasMoreToolCalls = false;
				}

				// A turn is compliant ONLY when it calls the required tool and nothing
				// else — mirroring the forced-tool_choice turn, which can emit only that
				// tool. A required+detour batch is treated as non-compliant so detour
				// tools never run side effects while the requirement is still pending.
				const calledOnlyRequiredTool =
					softRequiredTool !== undefined &&
					toolCalls.length > 0 &&
					toolCalls.every(toolCall => toolCall.name === softRequiredTool);
				const softGateActive =
					softRequiredTool !== undefined && !hardToolChoiceBlocks(config.toolChoice, softRequiredTool);
				const softNonCompliant = softGateActive && !calledOnlyRequiredTool;

				const toolResults: ToolResultMessage[] = [];
				if (softNonCompliant && softRequiredTool !== undefined) {
					if (softEscalations >= MAX_SOFT_TOOL_ESCALATIONS) {
						throw new Error(
							`Soft tool requirement '${softRequiredTool}' was not satisfied after ${MAX_SOFT_TOOL_ESCALATIONS} forced turns; aborting to avoid an unbounded force loop.`,
						);
					}
					// A soft-required tool is pending but the model called something else
					// (or yielded). Do NOT execute the detour — pair each call with a
					// skipped result and force the required tool next turn. This is the
					// only turn that changes toolChoice; a model that complies with the
					// reminder pays no message-cache invalidation. Re-engage so the loop
					// never yields while the requirement is unmet.
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(
							toolCall,
							stream,
							"skipped",
							`Not executed: call the \`${softRequiredTool}\` tool to resolve the pending action before using other tools.`,
						);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: "skipped",
						});
					}
					forcedToolChoice = { type: "tool", name: softRequiredTool };
					softEscalations++;
					hasMoreToolCalls = true;
				} else if (hasMoreToolCalls) {
					const executionResult = await executeToolCalls(
						currentContext,
						message,
						signal,
						stream,
						config,
						telemetry,
						invokeAgentSpan,
					);

					toolResults.push(...executionResult.toolResults);

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				} else if (toolCalls.length > 0) {
					// Turn ended on a non-runnable reason (`length` truncation) or deadline was exceeded
					// but left toolCall blocks behind. pair each with a placeholder result.
					const skipReason = deadlinePassed ? "aborted" : message.stopReason === "length" ? "length" : "skipped";
					const skipErrMsg = deadlinePassed ? "Deadline exceeded" : undefined;
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(toolCall, stream, skipReason, skipErrMsg);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: deadlinePassed ? "aborted" : "skipped",
						});
					}
					if (message.stopReason === "length" && toolResults.length > 0 && !deadlinePassed) {
						hasMoreToolCalls = true;
					}
				}

				if (toolCalls.length > 0) {
					pausedTurnContinuations = 0;
				} else if (
					!hasMoreToolCalls &&
					message.stopReason === "stop" &&
					message.stopDetails?.type === "pause_turn" &&
					pausedTurnContinuations < MAX_PAUSED_TURN_CONTINUATIONS
				) {
					// Non-terminal stop: the provider ended the response but not the turn
					// (e.g. Codex `end_turn: false` on a commentary-only progress update).
					// Re-sample with the assistant message replayed so the model keeps
					// working; the next round folds steering/asides in like any other
					// mid-work turn.
					pausedTurnContinuations++;
					hasMoreToolCalls = true;
				}

				await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, {
					willContinue: hasMoreToolCalls && !isDeadlineExceeded(config.deadline),
				});

				if (isDeadlineExceeded(config.deadline)) {
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}
				// On external abort (user interrupt), leave the steering queue intact: the
				// session aborts then continues, delivering the queue into a fresh run.
				// Draining it here would inject the messages right before a model call that
				// instantly aborts — message lands in history, agent never responds. The
				// mid-batch interrupt poll only peeks (hasSteeringMessages), so the queue
				// still owns every message until this dequeue.
				const steering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
				if (hasMoreToolCalls) {
					// Mid-work: fold any non-interrupting asides into the next turn alongside steering.
					const asides = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
					pendingMessages = asides.length > 0 ? [...steering, ...asides] : steering;
				} else {
					// Stop boundary: only steering (live user input) forces another turn here. Leave
					// asides for the outer drain below so a passive aside can't trigger an extra model
					// turn ahead of a queued follow-up — the outer drain batches asides + follow-ups together.
					pendingMessages = steering;
				}
			}

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}

			// Agent would stop here. Drain non-interrupting asides + follow-up messages.
			await config.onBeforeYield?.();

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}
			// Skip queue drains when externally aborted (same stranding hazard as above).
			// Re-poll steering too: a steer can land between the stop-boundary dequeue
			// above and this yield point (e.g. queued while onBeforeYield ran). Without
			// this poll it would strand in the queue until the next manual prompt.
			const lateSteering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
			const asideMessages = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
			const followUpMessages = signal?.aborted ? [] : (await config.getFollowUpMessages?.()) || [];
			if (lateSteering.length > 0 || asideMessages.length > 0 || followUpMessages.length > 0) {
				// Set as pending so the inner loop processes them before stopping.
				pendingMessages = [...lateSteering, ...asideMessages, ...followUpMessages];
				continue;
			}

			// No more messages, exit
			break;
		}

		endAgentStream(stream, newMessages, telemetry, stepCounter.count);
	} finally {
		if (deadlineTimer) {
			clearTimeout(deadlineTimer);
		}
	}
}

async function emitHarmonyAudit(
	config: AgentLoopConfig,
	interruption: HarmonyLeakInterruption,
	action: "truncate_resume" | "abort_retry" | "escalated",
	retryN: number,
): Promise<void> {
	await config.onHarmonyLeak?.(
		createHarmonyAuditEvent({
			action,
			detection: interruption.detection,
			model: config.model,
			retryN,
			removed: interruption.removed,
		}),
	);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
	harmonyRetryAttempt = 0,
	hostToolChoice?: ToolChoice,
	forcedToolChoice?: ToolChoice,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);

	const ownedDialect: Dialect | undefined = config.dialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT);
	const exampleDialect = ownedDialect ?? preferredDialect(config.model.id);
	// Owned/in-band dialects carry the catalog in the prompt as text and send no
	// native `tools`, so description pruning only applies to native tool calling.
	const pruneToolDescriptions = !!config.pruneToolDescriptions && !ownedDialect;
	// Build LLM context — append-only mode caches system prompt + tools
	// AND keeps an append-only message log so prior-turn bytes are stable.
	let llmContext: Context;
	if (config.appendOnlyContext) {
		config.appendOnlyContext.syncMessages(normalizedMessages);
		llmContext = config.appendOnlyContext.build(context, {
			intentTracing: !!config.intentTracing,
			exampleDialect,
			pruneToolDescriptions,
		});
	} else {
		llmContext = {
			systemPrompt: context.systemPrompt,
			messages: normalizedMessages,
			tools: normalizeTools(context.tools, !!config.intentTracing, exampleDialect, pruneToolDescriptions),
		};
	}
	if (config.transformProviderContext) {
		llmContext = await config.transformProviderContext(llmContext, config.model);
	}

	// Owned tool calling: take tool calls away from the provider and run them
	// through the selected in-band prompt dialect. `PI_DIALECT=1` still
	// force-enables GLM; `PI_DIALECT=<dialect>` force-enables that dialect.
	let promptToolWireTools: Context["tools"];
	if (ownedDialect && llmContext.tools && llmContext.tools.length > 0) {
		promptToolWireTools = llmContext.tools;
		llmContext = {
			...llmContext,
			systemPrompt: [...(llmContext.systemPrompt ?? []), renderInbandToolPrompt(promptToolWireTools, ownedDialect)],
			messages: encodeInbandToolHistory(llmContext.messages, ownedDialect, promptToolWireTools),
			tools: undefined,
		};
	}

	const streamFunction = streamFn || streamSimple;

	const dynamicReasoning = config.getReasoning?.();
	const dynamicDisableReasoning = config.getDisableReasoning?.();
	// `getServiceTier` is authoritative when present (replaces the static tier
	// for both the wire request and telemetry), so callers can scope priority
	// per model without touching the shared session `serviceTier`.
	const effectiveServiceTier = config.getServiceTier ? config.getServiceTier(config.model) : config.serviceTier;
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(config.model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignal = harmonyAbortController
		? signal
			? AbortSignal.any([signal, harmonyAbortController.signal])
			: harmonyAbortController.signal
		: signal;
	// Owned tool calling: aborted by the stream wrapper when the model starts
	// fabricating a `<tool_response>`, so the provider stops generating the rest of
	// the hallucinated turn. Merged into the provider signal ONLY (not
	// `requestSignal`), so it cancels the request without tripping the loop's
	// external-abort handling (`abortRacePromise` / `requestSignal.aborted`).
	const promptToolAbortController = ownedDialect ? new AbortController() : undefined;
	const providerAbortSignals: AbortSignal[] = [];
	if (requestSignal) providerAbortSignals.push(requestSignal);
	if (promptToolAbortController) providerAbortSignals.push(promptToolAbortController.signal);
	const finalRequestSignal =
		providerAbortSignals.length === 0
			? undefined
			: providerAbortSignals.length === 1
				? providerAbortSignals[0]!
				: AbortSignal.any(providerAbortSignals);
	const requestApiKey = (config.getApiKey ? await config.getApiKey(config.model) : undefined) ?? config.apiKey;
	const resolvedApiKey = await resolveApiKeyOnce(requestApiKey, finalRequestSignal);
	const apiKey = isApiKeyResolver(requestApiKey) ? seedApiKeyResolver(resolvedApiKey, requestApiKey) : requestApiKey;

	// Re-resolve metadata after credential selection so the per-request value
	// reflects the credential actually used, not the snapshot from AgentLoopConfig construction.
	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(config.model.provider) : config.metadata;
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;
	// Owned tool calling sends no native tools, so any tool_choice would error.
	const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
	const effectiveReasoning = dynamicReasoning ?? config.reasoning;
	const effectiveDisableReasoning = dynamicDisableReasoning ?? config.disableReasoning;
	// `getCwd` is read once per LLM call so a mid-run session move (`/move`) reaches
	// workspace-scoped provider discovery; falls back to the static `cwd` when unset.
	const effectiveCwd = config.getCwd?.() ?? config.cwd;

	const chatStepNumber = stepCounter.count;
	stepCounter.count += 1;
	const chatSpan = startChatSpan(telemetry, config.model, {
		parent: invokeAgentSpan,
		stepNumber: chatStepNumber,
		request: {
			maxTokens: config.maxTokens,
			temperature: effectiveTemperature,
			topP: config.topP,
			topK: config.topK,
			presencePenalty: config.presencePenalty,
			serviceTier: effectiveServiceTier,
			reasoningEffort: typeof effectiveReasoning === "string" ? effectiveReasoning : undefined,
			toolChoice: effectiveToolChoice,
			tools: llmContext.tools,
			systemPrompt: llmContext.systemPrompt,
			messages: llmContext.messages,
		},
	});

	// Wrap the user-supplied onResponse so we always observe response headers
	// for telemetry (`ChatUsageEvent.headers`, gateway auto-detection) without
	// stealing them from the configured hook.
	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = config.onResponse;
	const captureOnResponse: AgentLoopConfig["onResponse"] = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	const finishChat = async (message: AssistantMessage): Promise<void> => {
		await finishChatSpan(telemetry, chatSpan, message, {
			stepNumber: chatStepNumber,
			serviceTier: effectiveServiceTier,
			responseHeaders: capturedHeaders,
			baseUrl: config.model.baseUrl,
		});
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			let response = await streamFunction(config.model, llmContext, {
				...config,
				apiKey,
				metadata: resolvedMetadata,
				toolChoice: effectiveToolChoice,
				reasoning: effectiveReasoning,
				disableReasoning: effectiveDisableReasoning,
				temperature: effectiveTemperature,
				serviceTier: effectiveServiceTier,
				cwd: effectiveCwd,
				signal: finalRequestSignal,
				onResponse: captureOnResponse,
			});
			if (promptToolWireTools && ownedDialect) {
				// Re-materialize in-band tool-call text as native toolCall content blocks
				// so the rest of the loop executes them unchanged. When the model starts
				// fabricating tool results, the abort callback cancels the provider — unless
				// `abortOnFabricatedToolResult` is false, in which case the stream drains and
				// the fabricated continuation is discarded without aborting.
				response = wrapInbandToolStream(
					response,
					promptToolWireTools,
					ownedDialect,
					() => promptToolAbortController?.abort(),
					config.abortOnFabricatedToolResult ?? true,
				);
			}

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;
			const completedToolCallIds = new Set<string>();

			const responseIterator = response[Symbol.asyncIterator]();
			const finishAbortedStream = async (): Promise<AssistantMessage> => {
				try {
					const cleanup = responseIterator.return?.();
					if (cleanup) void cleanup.catch(() => {});
				} catch {
					// Provider cancellation failures cannot change the committed aborted message.
				}
				const aborted = emitAbortedAssistantMessage(
					partialMessage,
					addedPartial,
					completedToolCallIds,
					context,
					config,
					stream,
					requestSignal,
				);
				await finishChat(aborted);
				return aborted;
			};

			// Set up a single abort race: register the abort listener once for the whole
			// stream and reuse the same race promise for every iterator.next() instead of
			// allocating Promise.withResolvers and add/removeEventListener per event.
			let abortRacePromise: Promise<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					return await finishAbortedStream();
				}
				const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
				const onAbort = () => resolve(ABORTED);
				requestSignal.addEventListener("abort", onAbort, { once: true });
				abortRacePromise = promise;
				detachAbortListener = () => requestSignal.removeEventListener("abort", onAbort);
			}

			try {
				while (true) {
					let next: IteratorResult<AssistantMessageEvent>;
					if (abortRacePromise) {
						const result = await Promise.race([responseIterator.next(), abortRacePromise]);
						if (result === ABORTED) {
							return await finishAbortedStream();
						}
						next = result;
					} else {
						next = await responseIterator.next();
					}
					if (next.done) break;

					const event = next.value;
					if (event.type === "done" || event.type === "error") {
						let finalMessage = retainCompletedToolCalls(await response.result(), completedToolCallIds);
						if (harmonyMitigationEnabled) {
							const detection = detectHarmonyLeakInAssistantMessage(finalMessage);
							if (detection) {
								const recovered = recoverHarmonyToolCall(finalMessage, detection);
								const removed = recovered?.removed ?? extractHarmonyRemoved(finalMessage, detection);
								if (addedPartial) {
									emitDiscardedHarmonyPartial(
										partialMessage,
										stream,
										`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
									);
									context.messages.pop();
									addedPartial = false;
								}
								throw new HarmonyLeakInterruption(detection, removed, recovered);
							}
						}
						finalMessage = snapshotAssistantMessage(finalMessage);
						// Expand inline macros (and any other registered rewrite) on the
						// finalized message before it reaches the context, the UI, or tool
						// dispatch — so a single mutation is the source of truth for all three.
						if (config.transformAssistantMessage) {
							await config.transformAssistantMessage(finalMessage, requestSignal);
						}
						if (addedPartial) {
							context.messages[context.messages.length - 1] = finalMessage;
						} else {
							context.messages.push(finalMessage);
						}
						if (!addedPartial) {
							stream.push({ type: "message_start", message: snapshotAssistantMessage(finalMessage) });
						}
						stream.push({ type: "message_end", message: snapshotAssistantMessage(finalMessage) });
						await finishChat(finalMessage);
						return finalMessage;
					}
					if (requestSignal?.aborted) {
						return await finishAbortedStream();
					}

					// Yield to the event loop periodically to prevent busy-wait
					// when the LLM is streaming chunks faster than the loop can rest.
					await yieldIfDue();

					switch (event.type) {
						case "start":
							partialMessage = event.partial;
							if (addedPartial) {
								context.messages[context.messages.length - 1] = partialMessage;
								completedToolCallIds.clear();
								// `message` and `assistantMessageEvent.partial` intentionally share one
								// immutable snapshot of the streaming partial: every message_update
								// consumer treats both as read-only, so cloning the identical partial
								// twice per delta was pure waste.
								const messageSnapshot = snapshotAssistantMessage(partialMessage);
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							} else {
								context.messages.push(partialMessage);
								addedPartial = true;
								stream.push({ type: "message_start", message: snapshotAssistantMessage(partialMessage) });
							}
							break;

						case "text_start":
						case "text_delta":
						case "text_end":
						case "thinking_start":
						case "thinking_delta":
						case "thinking_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							if (partialMessage) {
								if (event.type === "toolcall_end") {
									completedToolCallIds.add(event.toolCall.id);
								}
								partialMessage = event.partial;
								context.messages[context.messages.length - 1] = partialMessage;
								config.onAssistantMessageEvent?.(partialMessage, event);
								// `message` and `assistantMessageEvent.partial` intentionally share one
								// immutable snapshot of the streaming partial: every message_update
								// consumer treats both as read-only, so cloning the identical partial
								// twice per delta was pure waste.
								const messageSnapshot = snapshotAssistantMessage(partialMessage);
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							}
							break;
					}
				}
			} finally {
				detachAbortListener?.();
			}

			let trailing = await response.result();
			if (harmonyMitigationEnabled) {
				const detection = detectHarmonyLeakInAssistantMessage(trailing);
				if (detection) {
					const recovered = recoverHarmonyToolCall(trailing, detection);
					const removed = recovered?.removed ?? extractHarmonyRemoved(trailing, detection);
					if (addedPartial) {
						emitDiscardedHarmonyPartial(
							partialMessage,
							stream,
							`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
						);
						context.messages.pop();
						addedPartial = false;
					}
					throw new HarmonyLeakInterruption(detection, removed, recovered);
				}
			}
			trailing = snapshotAssistantMessage(trailing);
			if (addedPartial) {
				context.messages[context.messages.length - 1] = trailing;
				stream.push({ type: "message_end", message: snapshotAssistantMessage(trailing) });
			}
			await finishChat(trailing);
			return trailing;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: config.model.baseUrl,
		});
		throw err;
	}
}

function retainCompletedToolCalls(
	message: AssistantMessage,
	completedToolCallIds: ReadonlySet<string>,
): AssistantMessage {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
	let droppedIncompleteToolCall = false;
	const content = message.content.filter(block => {
		if (block.type !== "toolCall") return true;
		const keep = completedToolCallIds.has(block.id);
		if (!keep) droppedIncompleteToolCall = true;
		return keep;
	});
	if (!droppedIncompleteToolCall) return message;
	return {
		...message,
		content,
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? null,
					},
	};
}

function emitDiscardedHarmonyPartial(
	partialMessage: AssistantMessage | null,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	errorMessage: string,
): void {
	if (!partialMessage) return;
	stream.push({
		type: "message_end",
		message: snapshotAssistantMessage({ ...partialMessage, stopReason: "error", errorMessage }),
	});
}

/** Resolve the human-readable reason an abort carried. A caller that aborts via
 *  `AbortController.abort(reason)` with a string or a non-`AbortError` `Error`
 *  (e.g. the coding agent's user-interrupt label) gets that text surfaced on the
 *  synthesized assistant message's `errorMessage`; a bare `abort()` (whose
 *  `signal.reason` is the default `AbortError` `DOMException`) falls back to the
 *  generic sentinel that downstream renderers treat as "no specific reason". */
export function abortReasonText(signal: AbortSignal | undefined): string {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0) {
		return reason.message;
	}
	return "Request was aborted";
}

function emitAbortedAssistantMessage(
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	completedToolCallIds: ReadonlySet<string>,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	requestSignal: AbortSignal | undefined,
): AssistantMessage {
	const errorMessage = abortReasonText(requestSignal);
	const errorId =
		errorMessage === "Request was aborted"
			? AIError.create(AIError.Flag.Abort)
			: AIError.classify(requestSignal?.reason) || undefined;
	const base: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage, errorId }
		: {
				role: "assistant",
				content: [],
				api: config.model.api,
				provider: config.model.provider,
				model: config.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage,
				errorId,
				timestamp: Date.now(),
			};
	// Only tool calls that reached `toolcall_end` survive abort/error replay. A
	// labeled user interrupt still surfaces through `errorMessage`, but partial
	// tool arguments are unsafe to keep and can carry incomplete provider IDs.
	const retained = retainCompletedToolCalls(base, completedToolCallIds);
	const abortedMessage = snapshotAssistantMessage(retained);
	if (addedPartial) {
		context.messages[context.messages.length - 1] = abortedMessage;
	} else {
		context.messages.push(abortedMessage);
		stream.push({ type: "message_start", message: snapshotAssistantMessage(abortedMessage) });
	}
	stream.push({ type: "message_end", message: snapshotAssistantMessage(abortedMessage) });
	return abortedMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
): Promise<{ toolResults: ToolResultMessage[] }> {
	const tools = currentContext.tools;
	const {
		hasSteeringMessages,
		getSteeringMessages,
		interruptMode = "immediate",
		getToolContext,
		transformToolCallArguments,
		intentTracing,
		beforeToolCall,
		afterToolCall,
	} = config;
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "toolCall");
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const toolSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal])
		: steeringAbortController.signal;
	const interruptState = { triggered: false };

	const records = toolCalls.map(toolCall => ({
		toolCall,
		// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5)
		// come back under their wire-level name, which may differ from the
		// harness-internal `name`. Match on either, preferring `name` for
		// determinism if both somehow collide.
		tool:
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name),
		args: toolCall.arguments as Record<string, unknown>,
		started: false,
		result: undefined as AgentToolResult<any> | undefined,
		isError: false,
		skipped: false,
		toolResultMessage: undefined as ToolResultMessage | undefined,
		resultEmitted: false,
	}));

	const checkSteering = async (): Promise<void> => {
		// `signal` (external/user abort) is checked separately from the internal
		// steeringAbortController: once the run is externally aborted it is
		// unwinding and the interrupt would be redundant.
		if (!shouldInterruptImmediately || interruptState.triggered || signal?.aborted) {
			return;
		}
		// Prefer the non-consuming peek (`hasSteeringMessages`) when available.
		// Fall back to calling `getSteeringMessages` directly when only it is
		// provided (e.g. in tests or minimal integrations without a separate
		// peek function). In that case the message is consumed here rather than
		// at the outer injection boundary, but the interrupt still fires.
		let hasMessages: boolean;
		if (hasSteeringMessages) {
			hasMessages = await hasSteeringMessages();
		} else if (getSteeringMessages) {
			const msgs = await getSteeringMessages();
			hasMessages = (msgs?.length ?? 0) > 0;
		} else {
			return;
		}
		if (hasMessages) {
			if (interruptState.triggered || signal?.aborted) return;
			interruptState.triggered = true;
			steeringAbortController.abort();
		}
	};

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			...(result.useless && !isError ? { useless: true } : {}),
			timestamp: Date.now(),
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered) {
			// Skip both span emission and the collector orphan record here. The
			// tail sweep below (after `Promise.allSettled`) is the single path
			// that handles "no result message was produced" — it calls
			// `recordSkippedTool` and `emitToolResult` once per record, so any
			// work we did here would double-count.
			record.skipped = true;
			return;
		}

		const { toolCall, tool } = record;
		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			} else if (typeof tool?.intent === "function") {
				try {
					const derived = tool.intent(strippedArgs as never)?.trim();
					if (derived) {
						toolCall.intent = derived;
					}
				} catch {
					// intent function must never break tool execution
				}
			}
		}
		let effectiveArgs: Record<string, unknown>;
		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
			effectiveArgs = validateToolArguments(tool, { ...toolCall, arguments: argsForExecution });
		} catch (validationError) {
			if (tool?.lenientArgValidation) {
				effectiveArgs = { ...argsForExecution };
				delete effectiveArgs.__parseError;
				delete effectiveArgs.__rawJson;
			} else {
				if ("__parseError" in argsForExecution) {
					record.args = {
						__parseError: argsForExecution.__parseError,
					};
				} else {
					record.args = argsForExecution;
				}
				emitToolResult(
					record,
					{
						content: [
							{
								type: "text" as const,
								text: validationError instanceof Error ? validationError.message : String(validationError),
							},
						],
						details: {
							isError: true,
							error: validationError instanceof Error ? validationError.message : String(validationError),
						},
					},
					true,
				);
				return;
			}
		}

		record.args = effectiveArgs;
		if (toolSignal.aborted) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				status: "aborted",
			});
			emitToolResult(record, createToolSignalAbortedResult(toolSignal), true);
			return;
		}
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: effectiveArgs,
			intent: toolCall.intent,
		});

		const toolSpan = startExecuteToolSpan(telemetry, {
			tool,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			args: effectiveArgs,
			parent: invokeAgentSpan,
		});
		if (toolSpan && toolCall.intent) {
			toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
		}

		let result: AgentToolResult<any> = { content: [], details: {} };
		let isError = false;
		let caughtError: unknown;
		let completedToolExecution = false;

		await runInActiveSpan(toolSpan, async () => {
			try {
				if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
				if (toolSignal.aborted) {
					result = createToolSignalAbortedResult(toolSignal);
					isError = true;
					return;
				}

				if (beforeToolCall) {
					const beforeResult = await beforeToolCall(
						{
							assistantMessage,
							toolCall,
							args: effectiveArgs,
							context: currentContext,
						},
						toolSignal,
					);
					if (beforeResult?.block) {
						throw new ToolCallBlockedError(beforeResult.reason);
					}
				}
				if (toolSignal.aborted) {
					result = createToolSignalAbortedResult(toolSignal);
					isError = true;
					return;
				}
				const executionArgs = transformToolCallArguments
					? transformToolCallArguments(effectiveArgs, toolCall.name)
					: effectiveArgs;
				record.args = executionArgs;

				const toolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
						})
					: undefined;
				const rawResult = await tool.execute(
					toolCall.id,
					executionArgs,
					toolSignal,
					partialResult => {
						stream.push({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: executionArgs,
							partialResult: coerceToolResult(partialResult).result,
						});
					},
					toolContext,
				);
				completedToolExecution = true;
				const coerced = coerceToolResult(rawResult);
				result = coerced.result;
				if (coerced.malformed || result.isError) isError = true;
			} catch (e) {
				caughtError = e;
				result = {
					content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
					details: {},
				};
				isError = true;
			}

			if (afterToolCall && (!toolSignal.aborted || completedToolExecution)) {
				try {
					const after = await afterToolCall(
						{
							assistantMessage,
							toolCall,
							args: record.args,
							result,
							isError,
							context: currentContext,
						},
						toolSignal,
					);
					if (after) {
						// Re-normalize the post-hook result: `afterToolCall` is untyped user/extension
						// code and may return malformed `content` (non-array / invalid blocks), which
						// would otherwise be persisted verbatim and corrupt the session — the same
						// hazard `coerceToolResult` guards on the execute path.
						const coerced = coerceToolResult({
							content: after.content ?? result.content,
							details: after.details ?? result.details,
							isError: after.isError ?? result.isError,
							useless: after.useless ?? result.useless,
						});
						result = coerced.result;
						isError = coerced.malformed || (after.isError ?? isError);
					}
				} catch (e) {
					caughtError = e;
					result = {
						content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
						details: {},
					};
					isError = true;
				}
			}
		});

		const interrupted = interruptState.triggered;
		const abortedDuringExecution = toolSignal.aborted && isError;
		if (interrupted && isError) {
			// Steering/abort fired AND this tool failed — it was cut off before producing a
			// usable result, so report it as skipped.
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		} else {
			// No interrupt, or the tool finished (successfully or with a genuine error) before
			// the interrupt landed. Keep its real result: a completed tool already ran its side
			// effects, so the model must see what actually happened rather than a false "skipped".
			emitToolResult(record, result, isError);
		}

		const firstTextBlock = result.content?.[0];
		const errorMessageForSpan =
			caughtError === undefined && isError && firstTextBlock?.type === "text" ? firstTextBlock.text : undefined;
		const status =
			(interrupted && isError) || abortedDuringExecution
				? "aborted"
				: caughtError instanceof ToolCallBlockedError
					? "blocked"
					: isError
						? "error"
						: "ok";
		finishExecuteToolSpan(telemetry, toolSpan, {
			result,
			isError,
			status,
			errorMessage: errorMessageForSpan,
			errorObject: caughtError,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});

		await checkSteering();
	};

	let lastExclusive: Promise<void> = Promise.resolve();
	let sharedTasks: Promise<void>[] = [];
	const tasks: Promise<void>[] = [];

	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrencyMode = record.tool?.concurrency;
		let concurrency: "shared" | "exclusive";
		if (typeof concurrencyMode === "function") {
			// Resolved from raw pre-validation args; a throwing resolver must not
			// take down the whole batch, so fall back to the safe (serial) mode.
			try {
				concurrency = concurrencyMode(record.args);
			} catch {
				concurrency = "exclusive";
			}
		} else {
			concurrency = concurrencyMode ?? "shared";
		}
		const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
		const task = start.then(() => runTool(record, index));
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}

	// While an interruptible tool is in flight (e.g. a `job` poll blocking on
	// background work), a queued steer would otherwise wait out the tool's own
	// window. Poll the steering queue and let checkSteering() abort the shared
	// tool signal so the wait returns early; the boundary dequeue below then
	// injects it. Gated on immediate-interrupt mode + an interruptible tool;
	// checkSteering is idempotent (no-op once triggered).
	const watchSteeringWhileRunning =
		shouldInterruptImmediately &&
		(hasSteeringMessages !== undefined || getSteeringMessages !== undefined) &&
		records.some(r => r.tool?.interruptible === true);
	const steeringWatchTimer = watchSteeringWhileRunning
		? setInterval(() => void checkSteering(), STEERING_INTERRUPT_POLL_MS)
		: undefined;
	try {
		await Promise.allSettled(tasks);
	} finally {
		if (steeringWatchTimer !== undefined) clearInterval(steeringWatchTimer);
	}
	// Yield after batch tool execution to let GC and I/O catch up,
	// especially when tool results are large (e.g. bash output).
	await yieldIfDue();

	for (const record of records) {
		if (!record.toolResultMessage) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: record.toolCall.id,
				toolName: record.toolCall.name,
				status: "skipped",
			});
			emitToolResult(record, createSkippedToolResult(), true);
		}
	}

	return { toolResults: emittedToolResults };
}

/**
 * Create a tool result for a tool call that was aborted or errored before execution.
 * Maintains the tool_use/tool_result pairing required by the API.
 */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
): ToolResultMessage {
	const message =
		reason === "aborted"
			? "Tool execution was aborted"
			: reason === "length"
				? "Tool call was not executed because the assistant hit its output token limit (stop_reason: length) before the arguments could complete; the recorded arguments are truncated and unsafe to run. Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls (e.g. for `write`/`edit`, write the first chunk then append the rest with subsequent `edit` insert ops, or break the file into multiple `write` targets)"
				: reason === "skipped"
					? "Tool call was not executed because the assistant ended its turn"
					: "Tool execution failed due to an error";
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

function createToolSignalAbortedResult(signal: AbortSignal): AgentToolResult<unknown> {
	const reason = abortReasonText(signal);
	return {
		content: [{ type: "text", text: `Tool was not executed because the run was aborted: ${reason}.` }],
		details: {},
	};
}

function createSkippedToolResult(): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};
}
