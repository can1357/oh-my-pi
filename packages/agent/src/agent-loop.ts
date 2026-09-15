/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type ComputerAction,
	type ComputerSafetyCheck,
	type Context,
	EventStream,
	isApiKeyResolver,
	type Model,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	streamSimple,
	stripSchemaDescriptions,
	type ToolCallProviderMetadata,
	type ToolChoice,
	type ToolResultMessage,
	type ToolResultProviderMetadata,
	type TSchema,
	toolWireSchema,
	validateToolArguments,
} from "@oh-my-pi/pi-ai";
import {
	type Dialect,
	encodeInbandToolHistory,
	renderInbandToolPrompt,
	renderToolExamples,
	wrapInbandToolStream,
} from "@oh-my-pi/pi-ai/dialect";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	type CursorExecResolvedCarrier,
	copyCursorExecResolved,
	kCursorExecResolved,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonyDetection,
	type HarmonyRecoveredToolCall,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	signalListLabel,
} from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { logger, sanitizeText, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { decideContinuation, NO_QUEUED_MESSAGES, REFUSAL_TEXT } from "./continuation";
import { agentPauseGate } from "./pause";
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
import {
	decideTurn,
	PLACEHOLDER_SPEC,
	type PlaceholderPlan,
	settleTurn,
	type ToolCallBlock,
	type TurnDecision,
} from "./turn-outcome";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentPreModelCallResult,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentTurnEndContext,
	AsideMessage,
	BeforeToolCallResult,
	CommittableAsideMessage,
	SoftToolRequirement,
	SoftToolRequirementState,
	SteeringInterruptSource,
	SteeringQueueState,
	StreamFn,
} from "./types";
import { ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD, isSoftToolRequirement } from "./types";
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
	if (choice.type === "computer") return requiredTool !== "computer";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

/**
 * Cadence (ms) for polling queued steering while an `interruptible` tool is in
 * flight, so a steer cuts the wait short instead of sitting idle until the
 * tool's own window elapses. A cheap synchronous queue check; latency-bounded
 * at one tick.
 */
/**
 * Abort reason for a turn-wide interruption where only some tool calls caused
 * the abort and sibling placeholders need neutral messages.
 */
export interface ToolScopedAbortReason {
	readonly kind: "tool-scoped-abort";
	readonly message: string;
	readonly toolCallMessages: Record<string, string>;
	readonly defaultToolCallMessage: string;
}

/** Creates an abort reason that labels matching tool calls separately from siblings. */
export function createToolScopedAbortReason(
	message: string,
	toolCallMessages: Record<string, string>,
	defaultToolCallMessage: string,
): ToolScopedAbortReason {
	return { kind: "tool-scoped-abort", message, toolCallMessages, defaultToolCallMessage };
}

/**
 * Marks an abort raised by a completed post-tool hook as terminal for the
 * current run. External/user aborts still synthesize an aborted assistant
 * boundary; this reason stops after persisting the completed tool batch.
 */
export const TERMINAL_TOOL_RESULT_ABORT_REASON = Symbol.for("pi-agent-core.terminal-tool-result");

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

function snapshotComputerSafetyChecks(value: unknown): ComputerSafetyCheck[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const checks: ComputerSafetyCheck[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const check = raw as Record<string, unknown>;
		if (typeof check.id !== "string" || check.id.length === 0) return undefined;
		if (check.code !== undefined && check.code !== null && typeof check.code !== "string") return undefined;
		if (check.message !== undefined && check.message !== null && typeof check.message !== "string") return undefined;
		checks.push({
			id: check.id,
			...(check.code !== undefined ? { code: check.code as string | null } : {}),
			...(check.message !== undefined ? { message: check.message as string | null } : {}),
		});
	}
	return checks;
}

function isFiniteCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasValidComputerKeys(value: unknown, optional: boolean): boolean {
	return (
		(optional && value === undefined) ||
		value === null ||
		(Array.isArray(value) && value.every(key => typeof key === "string"))
	);
}

function snapshotComputerAction(value: unknown): ComputerAction | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const action = value as Record<string, unknown>;
	switch (action.type) {
		case "click":
			if (
				!(["left", "right", "wheel", "back", "forward"] as unknown[]).includes(action.button) ||
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "double_click":
			if (
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!hasValidComputerKeys(action.keys, false)
			)
				return undefined;
			break;
		case "drag":
			if (
				!Array.isArray(action.path) ||
				!action.path.every(
					point =>
						point &&
						typeof point === "object" &&
						isFiniteCoordinate((point as Record<string, unknown>).x) &&
						isFiniteCoordinate((point as Record<string, unknown>).y),
				) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "keypress":
			if (!Array.isArray(action.keys) || !action.keys.every(key => typeof key === "string")) return undefined;
			break;
		case "move":
			if (!isFiniteCoordinate(action.x) || !isFiniteCoordinate(action.y) || !hasValidComputerKeys(action.keys, true))
				return undefined;
			break;
		case "screenshot":
		case "wait":
			break;
		case "scroll":
			if (
				!isFiniteCoordinate(action.x) ||
				!isFiniteCoordinate(action.y) ||
				!isFiniteCoordinate(action.scroll_x) ||
				!isFiniteCoordinate(action.scroll_y) ||
				!hasValidComputerKeys(action.keys, true)
			)
				return undefined;
			break;
		case "type":
			if (typeof action.text !== "string") return undefined;
			break;
		default:
			return undefined;
	}
	return structuredCloneJSON(action) as ComputerAction;
}

function snapshotToolCallProviderMetadata(value: unknown): ToolCallProviderMetadata | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const metadata = value as Record<string, unknown>;
	if (
		metadata.type !== "computer" ||
		typeof metadata.providerItemId !== "string" ||
		metadata.providerItemId.length === 0
	)
		return undefined;
	if (!Array.isArray(metadata.actions) || metadata.actions.length === 0) return undefined;
	const actions = metadata.actions.map(snapshotComputerAction);
	if (actions.some(action => action === undefined)) return undefined;
	const pendingSafetyChecks = snapshotComputerSafetyChecks(metadata.pendingSafetyChecks);
	if (!pendingSafetyChecks) return undefined;
	return {
		type: "computer",
		providerItemId: metadata.providerItemId,
		actions: actions as ComputerAction[],
		pendingSafetyChecks,
	};
}

function snapshotToolResultProviderMetadata(value: unknown): {
	metadata?: ToolResultProviderMetadata;
	malformed: boolean;
} {
	if (value === undefined) return { malformed: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { malformed: true };
	const metadata = value as Record<string, unknown>;
	if (
		metadata.type !== "computer" ||
		!metadata.screenshot ||
		typeof metadata.screenshot !== "object" ||
		Array.isArray(metadata.screenshot)
	) {
		return { malformed: true };
	}
	const screenshot = metadata.screenshot as Record<string, unknown>;
	const hasImageUrl = Object.hasOwn(screenshot, "image_url");
	const hasFileId = Object.hasOwn(screenshot, "file_id");
	if (screenshot.type !== "computer_screenshot" || hasImageUrl === hasFileId) return { malformed: true };
	if (hasImageUrl && (typeof screenshot.image_url !== "string" || screenshot.image_url.length === 0))
		return { malformed: true };
	if (hasFileId && (typeof screenshot.file_id !== "string" || screenshot.file_id.length === 0))
		return { malformed: true };
	const acknowledgedSafetyChecks = snapshotComputerSafetyChecks(metadata.acknowledgedSafetyChecks);
	if (!acknowledgedSafetyChecks) return { malformed: true };
	return {
		malformed: false,
		metadata: {
			type: "computer",
			screenshot: hasImageUrl
				? { type: "computer_screenshot", image_url: screenshot.image_url as string }
				: { type: "computer_screenshot", file_id: screenshot.file_id as string },
			acknowledgedSafetyChecks,
		},
	};
}

function snapshotAssistantContentBlock(block: AssistantContentBlock): AssistantContentBlock {
	switch (block.type) {
		case "text":
		case "image":
			return { ...block };
		case "thinking":
			return { ...block };
		case "redactedThinking":
			return { ...block };
		case "anthropicServerTool":
			return { ...block, block: structuredCloneJSON(block.block) };
		case "fallback":
			return { ...block, from: { ...block.from }, to: { ...block.to } };
		case "toolCall": {
			const snap = {
				...block,
				arguments: structuredCloneJSON(block.arguments),
				providerMetadata: snapshotToolCallProviderMetadata(block.providerMetadata),
			};
			// Object spread copies enumerable symbols in Bun, but the Cursor
			// exec-resolved marker is load-bearing for skip-on-dispatch — copy
			// it explicitly so a projector/snapshot path cannot drop it.
			copyCursorExecResolved(snap, block);
			return snap;
		}
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
		toolCallAbortMessages: message.toolCallAbortMessages ? { ...message.toolCallAbortMessages } : undefined,
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
		case "image_end":
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
	const providerMetadataResult = snapshotToolResultProviderMetadata(
		rawObj && "providerMetadata" in rawObj ? rawObj.providerMetadata : undefined,
	);
	const providerMetadata = providerMetadataResult.metadata;
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
	if (providerMetadataResult.malformed) {
		content.push({
			type: "text",
			text: "Tool returned an invalid result: computer providerMetadata had an unsupported shape.",
		});
	}
	const isError = explicitError || invalidBlocks > 0 || providerMetadataResult.malformed;
	// Anthropic rejects tool_result blocks with is_error: true and empty content.
	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	return {
		result: {
			content,
			details,
			providerMetadata,
			...(isError ? { isError: true } : {}),
			...(useless && !isError ? { useless: true } : {}),
		},
		malformed: invalidBlocks > 0 || providerMetadataResult.malformed,
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
		for (const prompt of prompts) {
			(prompt as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
		}

		stream.push({ type: "agent_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn, prompts);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries and resuming queued messages.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. The one exception is a trailing assistant message with
 * `stopReason: "aborted"` (a user-interrupted partial turn): it is replayed as
 * assistant prefill so the model continues where the stream was cut off.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	// Shared with `Agent.continue()`: tail shape × queue snapshot → run | dequeue | refuse.
	// This entry point has no queues, so `dequeue` is unreachable here.
	const decision = decideContinuation(context.messages, NO_QUEUED_MESSAGES);
	if (decision.plan.step === "refuse") {
		throw new Error(REFUSAL_TEXT[decision.plan.reason].loop);
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context, messages: [...context.messages] };

		stream.push({ type: "agent_start" });

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
 *
 * A {@link TERMINAL_TOOL_RESULT_ABORT_REASON} abort is the exception: it is a
 * graceful yield (e.g. a subagent's final `yield` tool), not a user interrupt.
 * The completed tool batch is persisted and the turn must still reach
 * `onTurnEnd` so per-turn bookkeeping — notably advisor review of the yield
 * delta (#9505) — runs exactly as it does for a plain end-of-turn message. The
 * hook receives no signal in that case so downstream waits (advisor catch-up)
 * behave identically to a normal final turn instead of short-circuiting on the
 * spent abort.
 */
async function emitTurnEnd(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	currentContext: AgentContext,
	message: AgentMessage,
	toolResults: ToolResultMessage[],
	config: AgentLoopConfig,
	signal?: AbortSignal,
	context?: Omit<AgentTurnEndContext, "message" | "toolResults">,
	runHookOnAbortedMessage = false,
): Promise<void> {
	stream.push({ type: "turn_end", message, toolResults });
	const terminalYield = signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON;
	const isAbortedOrError =
		message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
	if ((signal?.aborted && !terminalYield) || (isAbortedOrError && !runHookOnAbortedMessage)) return;
	await config.onTurnEnd?.(currentContext.messages, terminalYield ? undefined : signal, {
		message,
		toolResults,
		willContinue: false,
		...context,
	});
}

function createGateStopMessage(model: Model, reason: string | undefined): AssistantMessage {
	return {
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
		stopReason: "aborted",
		errorMessage: reason ?? "Stopped before model call",
		timestamp: Date.now(),
	};
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
const INTENT_SCHEMA_UNION_KEYS = ["anyOf", "oneOf"] as const;

function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const hasOwnProperties =
		propertiesValue !== null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue);

	// Pure union root (anyOf/oneOf with no own properties): push `i` into each
	// alternative branch so each closed shape keeps `additionalProperties: false`
	// honest with intent tracing. Adding a sibling root `properties: { i }` /
	// `required: [i]` would force every input to satisfy both root *and* a
	// branch, leaving no satisfiable shape because each branch's
	// `additionalProperties: false` rejects every other field — and OpenAI
	// strict sanitization later promotes that sibling to a closed root
	// `type: "object"` that rejects every non-`i` key outright. allOf is not
	// alternation (its members are sub-constraints), so we don't recurse into it.
	if (!hasOwnProperties) {
		for (const key of INTENT_SCHEMA_UNION_KEYS) {
			const variants = schemaRecord[key];
			if (!Array.isArray(variants)) continue;
			return {
				...schemaRecord,
				[key]: variants.map(variant => injectIntentIntoSchema(variant, mode, describeIntent)),
			};
		}
	}

	const properties = hasOwnProperties ? (propertiesValue as Record<string, unknown>) : {};
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

export interface NormalizeToolsOptions {
	/** Inject the `i` intent field into tool schemas (subject to `PI_NO_INTENT`). */
	injectIntent: boolean;
	/** Strip descriptions from the wire specs when the catalog rides in the system prompt. */
	pruneDescriptions?: boolean;
}

export function normalizeTools(tools: AgentContext["tools"], options: NormalizeToolsOptions): Context["tools"] {
	const pruneDescriptions = options.pruneDescriptions === true;
	const injectIntent = options.injectIntent && Bun.env.PI_NO_INTENT !== "1";
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
		const examplesBlock = renderToolExamples({ ...t, parameters }, doInjectIntent ? INTENT_FIELD : undefined);
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
	initialMessages: AgentMessage[] = [],
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
				initialMessages,
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
function emitInputMessages(stream: EventStream<AgentEvent, AgentMessage[]>, messages: readonly AgentMessage[]): void {
	for (const message of messages) {
		stream.push({ type: "message_start", message });
		stream.push({ type: "message_end", message });
	}
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
	try {
		for (const entry of entries) {
			const message = typeof entry === "function" ? entry() : entry;
			if (message) out.push(message);
		}
	} catch (error) {
		discardAsides(out, error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
	return out;
}

function discardAsides(messages: readonly AgentMessage[], error: Error): void {
	for (const message of messages) {
		(message as CommittableAsideMessage)[ASIDE_MESSAGE_DISCARD]?.(error);
	}
}

/** One step of the driver's trampoline. A hole that declines to resume its caller
 *  returns `finish` in place of the step the body would have produced: that is how
 *  this loop aborts — no exception, no unwinding, just no continuation. */
type Step =
	| { readonly next: "turn" }
	| { readonly next: "drain" }
	| { readonly next: "finish"; readonly exit: RunExit };

/** How the run ended. Every terminal path funnels through `LoopEffect.finish`, so
 *  the exit ritual has exactly one implementation. */
type RunExit =
	/** The wall-clock deadline passed, before or between turns. */
	| "deadline"
	/** A host hook stopped the run before the provider call. */
	| "gate-stop"
	/** The assistant turn ended the run (`error`/`aborted`, or a terminal tool result). */
	| "turn-end"
	/** Nothing left to do: every queue drained. */
	| "complete";

/** Where an injection can come from. */
type InjectionSource = "steering" | "asides" | "followUp";

/** Messages collected from the named {@link InjectionSource}s. */
interface InjectedMessages {
	steering: AgentMessage[];
	asides: AgentMessage[];
	followUp: AgentMessage[];
}

/** State the driver carries between steps. One object, reused for the whole run. */
interface LoopState {
	/** Messages belonging to the turn being opened, not yet announced to the host. */
	messagesToEmit: AgentMessage[];
	/** Injections waiting for the next turn boundary. */
	pending: AgentMessage[];
	turnOpen: boolean;
	directiveResolvedForTurn: boolean;
	hostToolChoice: ToolChoice | undefined;
	requiredTool: string | undefined;
	satisfies: SoftToolRequirement["satisfies"] | undefined;
	/** Whether the inner loop takes another turn after the current one. */
	continueLoop: boolean;
	pausedContinuations: number;
}

/** Mutable resources the run owns and releases in its `finally`. Handed to the
 *  handler so a stop before the deadline leaves no timer or host state behind. */
interface LoopResources {
	readonly softRequirement: SoftToolRequirementState;
	/** Set by the gate-stop path: the host-owned requirement survives the stop. */
	preserveSoftRequirement: boolean;
	deadlineTimer: Timer | undefined;
}

/** Everything a step needs: the live conversation, the run wiring, the state. */
interface LoopBody {
	readonly state: LoopState;
	readonly resources: LoopResources;
	readonly currentContext: AgentContext;
	readonly newMessages: AgentMessage[];
	readonly config: AgentLoopConfig;
	readonly signal: AbortSignal | undefined;
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly telemetry: AgentTelemetry | undefined;
	readonly span: Span | undefined;
	readonly stepCounter: StepCounter;
	readonly streamFn: StreamFn | undefined;
}

/** The holes: everything the loop cannot decide for itself. Each takes the
 *  continuation it would resume; a hole that never calls it has ended the run. */
interface LoopEffect {
	/** The provider call, including the recovery policy and its retry budget. */
	callModel(next: (message: AssistantMessage) => Promise<Step>): Promise<Step>;
	/** The turn's tool effects: execute the batch, or pair placeholders. */
	applyFate(
		decision: TurnDecision,
		message: AssistantMessage,
		next: (toolResults: ToolResultMessage[]) => Promise<Step>,
	): Promise<Step>;
	/** Injection boundary: collect whatever the named queues hold right now. */
	inject(sources: readonly InjectionSource[]): Promise<InjectedMessages>;
	/** Terminal: close the run's event stream and stop. */
	finish(exit: RunExit): Step;
}

/**
 * The default handler: the loop's own policy. Provider recovery and its budget,
 * tool dispatch, queue injection, and the exit ritual all live here, so the body
 * above is sequencing only. Recovery budget is closure state rather than loop
 * state, and `finish` is the one place a run stops cleanly.
 */
function createLoopEffect(body: LoopBody): LoopEffect {
	const { state, resources, currentContext, newMessages, config, signal, stream, telemetry, stepCounter, streamFn } =
		body;
	// Consecutive GPT-5 Harmony re-samples and truncate-and-resume recoveries. Both
	// reset when a turn lands, so the caps bound *consecutive* leakage only.
	let harmonyRetryAttempt = 0;
	let harmonyTruncateResumeCount = 0;

	/** Announce the current turn's inputs. Used on its own by the stop paths, which
	 *  surface what the user queued without ever opening a turn. */
	const announceInputs = (): void => {
		emitInputMessages(stream, state.messagesToEmit);
		state.messagesToEmit = [];
	};
	/** Open the turn exactly once: `turn_start` precedes the input messages. */
	const openTurn = (): void => {
		if (state.turnOpen) return;
		stream.push({ type: "turn_start" });
		announceInputs();
		state.turnOpen = true;
	};

	return {
		async callModel(next) {
			let preparedProviderCall: PreparedProviderCall;
			let gateResult: AgentPreModelCallResult;
			try {
				if (config.syncContextBeforeModelCall) {
					await config.syncContextBeforeModelCall(currentContext, signal);
				}
				if (!state.directiveResolvedForTurn) {
					const directive = signal?.aborted ? undefined : config.getToolChoice?.();
					const softReq = isSoftToolRequirement(directive) ? directive : undefined;
					state.hostToolChoice =
						directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
					state.requiredTool = softReq?.toolName;
					state.satisfies = softReq?.satisfies;
					if (softReq !== undefined) {
						if (softReq.id !== resources.softRequirement.id) {
							resources.softRequirement.id = softReq.id;
							resources.softRequirement.forcedToolChoice = undefined;
							resources.softRequirement.escalations = 0;
							for (const reminder of softReq.reminder) {
								currentContext.messages.push(reminder);
								newMessages.push(reminder);
								state.messagesToEmit.push(reminder);
							}
						}
					} else {
						resources.softRequirement.id = undefined;
						resources.softRequirement.forcedToolChoice = undefined;
						resources.softRequirement.escalations = 0;
					}
					state.directiveResolvedForTurn = true;
				}

				preparedProviderCall = await prepareProviderCall(currentContext, config, signal);
				gateResult = (await config.beforeModelCall?.(preparedProviderCall.context, signal)) || undefined;
			} catch (error) {
				if (!state.turnOpen) {
					stream.push({ type: "turn_start" });
					announceInputs();
					state.turnOpen = true;
				}
				throw error;
			}
			if (config.beforeModelCall && signal?.aborted) {
				gateResult = { stop: true };
			}
			if (gateResult?.stop) {
				if (gateResult.reason) {
					logger.debug("Agent loop stopped before the model call", { reason: gateResult.reason });
				}
				if (!state.turnOpen && !signal?.aborted) {
					try {
						config.onToolChoiceRejected?.();
					} catch (error) {
						stream.push({ type: "turn_start" });
						announceInputs();
						state.turnOpen = true;
						throw error;
					}
				}
				announceInputs();
				if (state.turnOpen) {
					const stopMessage = createGateStopMessage(preparedProviderCall.model, gateResult.reason);
					currentContext.messages.push(stopMessage);
					newMessages.push(stopMessage);
					stream.push({ type: "message_start", message: stopMessage });
					stream.push({ type: "message_end", message: stopMessage });
					await emitTurnEnd(
						stream,
						currentContext,
						stopMessage,
						[],
						config,
						signal,
						{ willContinue: false },
						true,
					);
					state.turnOpen = false;
				}
				resources.preserveSoftRequirement = !signal?.aborted;
				return this.finish("gate-stop");
			}

			openTurn();

			let recovered: HarmonyRecoveredToolCall | undefined;
			let message: AssistantMessage;
			try {
				message = await streamAssistantResponse(
					currentContext,
					config,
					signal,
					stream,
					telemetry,
					body.span,
					stepCounter,
					streamFn,
					harmonyRetryAttempt,
					state.hostToolChoice,
					resources.softRequirement.forcedToolChoice,
					preparedProviderCall,
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
					// Re-sample the same turn. The driver re-enters this hole with the
					// directive cache intact — the old `continue` — and only while the
					// turn sequence is still running, which is what the old inner-loop
					// condition checked.
					return state.continueLoop ? { next: "turn" } : { next: "drain" };
				}
			}
			if (recovered) {
				message = snapshotAssistantMessage(message);
				currentContext.messages.push(message);
				stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
				stream.push({ type: "message_end", message: snapshotAssistantMessage(message) });
			}
			newMessages.push(message);

			// The escalation choice (if any) applied to the call above; clear it so only
			// the single escalation turn carries the forced choice.
			resources.softRequirement.forcedToolChoice = undefined;

			// A fresh logical turn re-resolves the directive next iteration; a Harmony
			// re-sample returns above and keeps the cached value.
			state.directiveResolvedForTurn = false;

			return next(message);
		},

		async applyFate(decision, message, next) {
			const toolResults: ToolResultMessage[] = [];
			if (decision.kind === "execute") {
				const executionResult = await executeToolCalls(
					currentContext,
					message,
					signal,
					stream,
					config,
					telemetry,
					body.span,
				);

				toolResults.push(...executionResult.toolResults);

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			} else if ((decision.kind === "end" || decision.kind === "hold") && decision.placeholders) {
				toolResults.push(
					...pairPlaceholderResults({
						plan: decision.placeholders,
						message,
						signal,
						stream,
						telemetry,
						currentContext,
						newMessages,
					}),
				);
			}
			return next(toolResults);
		},

		async inject(sources) {
			// Each poll is skipped while the run is externally aborted: draining would
			// inject messages into a run that is about to die, and their queue must keep
			// owning them (the session delivers them into the next run instead).
			const injected: InjectedMessages = { steering: [], asides: [], followUp: [] };
			if (signal?.aborted) return injected;
			for (const source of sources) {
				switch (source) {
					case "steering":
						injected.steering = (await config.getSteeringMessages?.(signal)) || [];
						break;
					case "asides":
						injected.asides = resolveAsides(await config.getAsideMessages?.());
						break;
					case "followUp":
						injected.followUp = (await config.getFollowUpMessages?.(signal)) || [];
						break;
				}
			}
			return injected;
		},

		finish(exit) {
			// A run that stops before its turn opened still reports the queued inputs,
			// the way the pre-turn exits it replaced did.
			if (!state.turnOpen) announceInputs();
			endAgentStream(stream, newMessages, telemetry, stepCounter.count);
			return { next: "finish", exit };
		},
	};
}

/** One turn of the inner loop: absorb injections, then hand off to the model. */
async function stepTurn(body: LoopBody, holes: LoopEffect): Promise<Step> {
	const { state, config, signal } = body;
	if (isDeadlineExceeded(config.deadline)) return holes.finish("deadline");
	// Yield at the top of each iteration to prevent busy-wait when the agent loop
	// is executing tool calls back-to-back.
	await yieldIfDue();
	// Park at the turn boundary while the process-wide pause gate is engaged
	// (host /pause). An external abort releases the park so a cancelled run still
	// unwinds while everything else stays frozen.
	if (agentPauseGate.paused) await agentPauseGate.waitUntilResumed(signal);

	// Queue messages join the context now; their events stay deferred until provider
	// preparation succeeds or opens an error turn.
	for (const message of state.pending) {
		body.currentContext.messages.push(message);
		body.newMessages.push(message);
		state.messagesToEmit.push(message);
		(message as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
	}
	state.pending = [];

	return holes.callModel(message => completeTurn(body, holes, message));
}

/** The turn's bookkeeping after its effects: fate, escalation, `turn_end`, next step. */
async function completeTurn(body: LoopBody, holes: LoopEffect, message: AssistantMessage): Promise<Step> {
	const { state, resources, currentContext, config, signal, stream } = body;
	const toolCalls = message.content.filter(
		(c): c is ToolCallBlock =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
	);
	const requiredTool = state.requiredTool;
	const decision = decideTurn({
		message,
		toolCalls,
		deadlinePassed: isDeadlineExceeded(config.deadline),
		softRequirement:
			requiredTool === undefined
				? null
				: {
						tool: requiredTool,
						satisfied: toolCall => state.satisfies?.(toolCall) ?? toolCall.name === requiredTool,
						active: !hardToolChoiceBlocks(config.toolChoice, requiredTool),
						escalations: resources.softRequirement.escalations,
					},
		maxSoftEscalations: MAX_SOFT_TOOL_ESCALATIONS,
	});

	if (decision.kind === "limit-exhausted") {
		throw new Error(
			`Soft tool requirement '${decision.tool}' was not satisfied after ${decision.max} forced turns; aborting to avoid an unbounded force loop.`,
		);
	}

	return holes.applyFate(decision, message, async toolResults => {
		if (decision.kind === "end") {
			await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, { willContinue: false });
			state.turnOpen = false;
			return holes.finish("turn-end");
		}

		// Settle against facts only the effects can produce: a tool hook may have
		// aborted the run from inside the batch.
		const continuation = settleTurn({
			reengage: decision.reengage,
			terminalAbort: signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON,
			toolCalls: toolCalls.length,
			stopReason: message.stopReason,
			pauseTurn: message.stopDetails?.type === "pause_turn",
			pausedContinuations: state.pausedContinuations,
			maxPausedContinuations: MAX_PAUSED_TURN_CONTINUATIONS,
		});
		const escalation = decision.kind === "hold" ? decision.escalate : null;
		resources.softRequirement.forcedToolChoice = escalation ? { type: "tool", name: escalation.tool } : undefined;
		if (escalation) resources.softRequirement.escalations = escalation.escalations;
		state.pausedContinuations = continuation.pausedContinuations;
		state.continueLoop = continuation.continueLoop;

		await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, {
			willContinue: state.continueLoop && !isDeadlineExceeded(config.deadline),
		});
		state.turnOpen = false;

		if (isDeadlineExceeded(config.deadline)) return holes.finish("deadline");

		// Mid-work folds non-interrupting asides into the next turn alongside steering.
		// At a stop boundary only steering (live user input) forces another turn here:
		// asides wait for the boundary drain so a passive aside cannot preempt a queued
		// follow-up with an extra model turn.
		const injected = await holes.inject(state.continueLoop ? ["steering", "asides"] : ["steering"]);
		state.pending = state.continueLoop ? [...injected.steering, ...injected.asides] : injected.steering;

		return state.continueLoop || state.pending.length > 0 ? { next: "turn" } : { next: "drain" };
	});
}

/** The stop boundary: the agent would stop here, so drain every queue one last time. */
async function drainBoundary(body: LoopBody, holes: LoopEffect): Promise<Step> {
	const { state, config } = body;
	if (isDeadlineExceeded(config.deadline)) return holes.finish("deadline");

	// Agent would stop here. Drain non-interrupting asides + follow-up messages.
	await config.onBeforeYield?.();

	if (isDeadlineExceeded(config.deadline)) return holes.finish("deadline");

	// Steering is re-polled too: a steer can land between the stop-boundary drain
	// above and this yield point (e.g. queued while `onBeforeYield` ran). Without this
	// poll it would strand in the queue until the next manual prompt.
	const injected = await holes.inject(["steering", "asides", "followUp"]);
	if (injected.steering.length === 0 && injected.asides.length === 0 && injected.followUp.length === 0) {
		return holes.finish("complete");
	}

	// The queued batch opens a new turn sequence, which restores the pass-start
	// willingness to continue that every turn re-settles.
	state.pending = [...injected.steering, ...injected.asides, ...injected.followUp];
	state.continueLoop = true;
	return { next: "turn" };
}

/**
 * Trampoline. Steps run one at a time and never recurse per turn, so a long
 * session cannot grow the stack — the caveat every effect-handler implementation
 * inherits in a language without tail calls.
 */
async function drive(body: LoopBody, holes: LoopEffect): Promise<RunExit> {
	let step: Step = { next: "turn" };
	for (;;) {
		if (step.next === "finish") return step.exit;
		step = step.next === "turn" ? await stepTurn(body, holes) : await drainBoundary(body, holes);
	}
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
	initialMessages: AgentMessage[],
	streamFn?: StreamFn,
): Promise<void> {
	let deadlineTimer: Timer | undefined;
	if (config.deadline !== undefined) {
		const deadlineAbortController = new AbortController();
		const deadlineReason = new DOMException("Deadline exceeded", "TimeoutError");
		const delay = config.deadline - Date.now();
		if (delay <= 0) {
			deadlineAbortController.abort(deadlineReason);
		} else {
			deadlineTimer = setTimeout(() => {
				deadlineAbortController.abort(deadlineReason);
			}, delay);
		}
		signal = signal ? AbortSignal.any([signal, deadlineAbortController.signal]) : deadlineAbortController.signal;
	}

	// Soft tool requirement lifecycle (reminder then escalation; see SoftToolRequirement).
	// The host-owned state survives only a gate stop between Agent.prompt calls.
	// Resolved once per logical turn at the fetch site and reused across Harmony-leak
	// re-samples (which re-enter the same turn) so the consuming getToolChoice is
	// never advanced twice; the flag resets at the message boundary.
	const resources: LoopResources = {
		softRequirement: config.softToolRequirementState ?? { escalations: 0 },
		preserveSoftRequirement: false,
		deadlineTimer,
	};
	const state: LoopState = {
		messagesToEmit: [...initialMessages],
		pending: [],
		turnOpen: false,
		directiveResolvedForTurn: false,
		hostToolChoice: undefined,
		requiredTool: undefined,
		satisfies: undefined,
		// A turn sequence starts willing to continue; every turn re-settles this, and a
		// Harmony re-sample reads it exactly where the old inner-loop condition did.
		continueLoop: true,
		pausedContinuations: 0,
	};
	const body: LoopBody = {
		state,
		resources,
		currentContext,
		newMessages,
		config,
		signal,
		stream,
		telemetry,
		span: invokeAgentSpan,
		stepCounter,
		streamFn,
	};

	try {
		const holes = createLoopEffect(body);

		// A run that starts past its deadline never polls a queue: consuming messages it
		// can never deliver would strand them, so it stops before the first poll.
		if (isDeadlineExceeded(config.deadline)) {
			holes.finish("deadline");
			return;
		}

		// Check for steering messages at start (user may have typed while waiting).
		// Skip when the run is already externally aborted — dequeuing would strand
		// the messages in a run that is about to die.
		try {
			state.pending = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
		} catch (error) {
			stream.push({ type: "turn_start" });
			emitInputMessages(stream, state.messagesToEmit);
			throw error;
		}

		await drive(body, holes);
	} finally {
		discardAsides(state.pending, new Error("Aside message was not committed before the agent loop ended"));
		if (!resources.preserveSoftRequirement) {
			resources.softRequirement.id = undefined;
			resources.softRequirement.forcedToolChoice = undefined;
			resources.softRequirement.escalations = 0;
		}
		// `clearTimeout` no-ops for an unset handle, so the undefined case needs no guard.
		clearTimeout(resources.deadlineTimer);
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
			model: config.getModel?.() ?? config.model,
			retryN,
			removed: interruption.removed,
		}),
	);
}

interface PreparedProviderCall {
	model: Model;
	context: Context;
	promptToolWireTools: Context["tools"];
	ownedDialect: Dialect | undefined;
}

async function prepareProviderCall(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedProviderCall> {
	const model = config.getModel?.() ?? config.model;
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, model);
	const ownedDialect: Dialect | undefined = config.dialect ?? resolveOwnedDialectFromEnv(Bun.env.PI_DIALECT);
	const pruneToolDescriptions = !!config.pruneToolDescriptions && !ownedDialect;
	let llmContext: Context;
	if (config.appendOnlyContext) {
		config.appendOnlyContext.syncMessages(normalizedMessages);
		llmContext = config.appendOnlyContext.build(context, {
			intentTracing: !!config.intentTracing,
			pruneToolDescriptions,
		});
	} else {
		llmContext = {
			systemPrompt: context.systemPrompt,
			messages: normalizedMessages,
			tools: normalizeTools(context.tools, {
				injectIntent: !!config.intentTracing,
				pruneDescriptions: pruneToolDescriptions,
			}),
		};
	}
	if (config.transformProviderContext) {
		llmContext = await config.transformProviderContext(llmContext, model);
	}

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
	return { model, context: llmContext, promptToolWireTools, ownedDialect };
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
	prepared?: PreparedProviderCall,
): Promise<AssistantMessage> {
	const providerCall = prepared ?? (await prepareProviderCall(context, config, signal));
	const { model, context: llmContext, promptToolWireTools, ownedDialect } = providerCall;

	const streamFunction = streamFn || streamSimple;

	const dynamicReasoning = config.getReasoning?.();
	const dynamicDisableReasoning = config.getDisableReasoning?.();
	// `getServiceTier` is authoritative when present (replaces the static tier
	// for both the wire request and telemetry), so callers can scope priority
	// per model without touching the shared session `serviceTier`.
	const effectiveServiceTier = config.getServiceTier ? config.getServiceTier(model) : config.serviceTier;
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(model);
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
	const requestApiKey = (config.getApiKey ? await config.getApiKey(model) : undefined) ?? config.apiKey;
	const resolvedApiKey = await resolveApiKeyOnce(requestApiKey, finalRequestSignal);
	const apiKey = isApiKeyResolver(requestApiKey) ? seedApiKeyResolver(resolvedApiKey, requestApiKey) : requestApiKey;

	// Re-resolve metadata after credential selection so the per-request value
	// reflects the credential actually used, not the snapshot from AgentLoopConfig construction.
	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(model.provider) : config.metadata;
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
	const chatSpan = startChatSpan(telemetry, model, {
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
			baseUrl: model.baseUrl,
		});
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			let response = await streamFunction(model, llmContext, {
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

			// One record for the turn in flight: its partial, whether that partial already
			// occupies the context's last slot, and which tool calls completed.
			const turn: StreamingTurn = { partial: null, attached: false, completedToolCallIds: new Set() };

			const responseIterator = response[Symbol.asyncIterator]();
			const finishAbortedStream = async (): Promise<AssistantMessage> => {
				try {
					const cleanup = responseIterator.return?.();
					if (cleanup) void cleanup.catch(() => {});
				} catch {
					// Provider cancellation failures cannot change the committed aborted message.
				}
				const aborted = emitAbortedAssistantMessage(turn, context, config, stream, requestSignal);
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
						let finalMessage = recoverSettledTurn(
							await response.result(),
							turn.completedToolCallIds,
							context.tools,
						);
						const leak = harmonyLeakIn(finalMessage, harmonyMitigationEnabled);
						if (leak) {
							discardStreamingTurn(turn, leak, context, stream);
							throw new HarmonyLeakInterruption(leak.detection, leak.removed, leak.recovered);
						}
						finalMessage = snapshotAssistantMessage(finalMessage);
						// Expand inline macros (and any other registered rewrite) on the
						// finalized message before it reaches the context, the UI, or tool
						// dispatch — so a single mutation is the source of truth for all three.
						if (config.transformAssistantMessage) {
							await config.transformAssistantMessage(finalMessage, requestSignal);
						}
						// Prepare tool dispatch (validation + the `beforeToolCall` hook)
						// BEFORE the message is snapshotted for consumers: a hook args
						// revision is written back into this message's toolCall blocks,
						// so history, the UI, persistence, provider replay, scheduling,
						// and execution all carry the revised arguments.
						if (finalMessage.content.some(c => c.type === "toolCall")) {
							preparedDispatchByMessage.set(
								finalMessage,
								await prepareToolCallDispatch(finalMessage, context, config, requestSignal),
							);
						}
						commitSettlement(turn, { kind: "terminal", message: finalMessage }, context, stream);
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
							openStreamingTurn(turn, event, context, stream);
							break;

						case "text_start":
						case "text_delta":
						case "text_end":
						case "image_end":
						case "thinking_start":
						case "thinking_delta":
						case "thinking_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							advanceStreamingTurn(turn, event, context, stream, config.onAssistantMessageEvent);
							break;
					}
				}
			} finally {
				detachAbortListener?.();
			}

			const trailing = await response.result();
			const leak = harmonyLeakIn(trailing, harmonyMitigationEnabled);
			if (leak) {
				discardStreamingTurn(turn, leak, context, stream);
				throw new HarmonyLeakInterruption(leak.detection, leak.removed, leak.recovered);
			}
			const settled = snapshotAssistantMessage(trailing);
			commitSettlement(turn, { kind: "trailing", message: settled }, context, stream);
			await finishChat(settled);
			return settled;
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
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
	};
}

function recoverTransientErrorToolTurn(
	message: AssistantMessage,
	availableTools: ReadonlyArray<Pick<AgentTool, "name" | "customWireName">>,
): AssistantMessage {
	if (message.stopReason !== "error") return message;
	const toolCalls = message.content.filter(block => block.type === "toolCall");
	if (toolCalls.length === 0) return message;
	const stopDetailType = message.stopDetails?.type;
	const stopDetailCategory = message.stopDetails?.category;
	if (
		stopDetailType === "refusal" ||
		stopDetailType === "sensitive" ||
		stopDetailCategory === "refusal" ||
		stopDetailCategory === "sensitive"
	)
		return message;
	const availableToolNames = new Set<string>();
	for (const tool of availableTools) {
		availableToolNames.add(tool.name);
		if (tool.customWireName !== undefined) availableToolNames.add(tool.customWireName);
	}
	if (!toolCalls.every(toolCall => availableToolNames.has(toolCall.name))) return message;
	const errorText = `${message.errorMessage ?? ""}\n${message.stopDetails?.explanation ?? ""}`;
	if (
		!AIError.isStreamReadErrorText(errorText) &&
		!AIError.isStreamEnvelopeErrorText(errorText) &&
		!AIError.isTransientStreamParseError(message.errorMessage) &&
		!AIError.isTransientStreamParseError(message.stopDetails?.explanation)
	)
		return message;
	return {
		...message,
		stopReason: "toolUse",
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
		errorMessage: undefined,
		errorId: undefined,
		errorStatus: undefined,
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

/** An event that carries the streamed partial: everything the provider emits before
 *  its terminal `done`/`error` event. */
type StreamingEvent = Exclude<AssistantMessageEvent, { type: "done" | "error" }>;

/**
 * The turn currently streaming from the provider: its partial message, whether that
 * partial already occupies the last slot of `context.messages`, and the tool calls
 * that reached `toolcall_end` — the only ones whose arguments are complete enough to
 * replay after an error or abort.
 */
interface StreamingTurn {
	partial: AssistantMessage | null;
	attached: boolean;
	completedToolCallIds: Set<string>;
}

/** How the provider's stream settled once its iterator was exhausted. */
type Settlement =
	/** A terminal `done`/`error` event ended the turn. */
	| { readonly kind: "terminal"; readonly message: AssistantMessage }
	/** The iterator ended without a terminal event. */
	| { readonly kind: "trailing"; readonly message: AssistantMessage };

/** A GPT-5 Harmony protocol leak in a settled message. */
interface HarmonyLeak {
	readonly detection: HarmonyDetection;
	/** Fragment label reported to `onHarmonyLeak`. */
	readonly removed: string;
	/** Set when the leak's tool call can be salvaged and the turn resumed instead of re-sampled. */
	readonly recovered: HarmonyRecoveredToolCall | undefined;
}

/**
 * Scan a settled assistant message for Harmony leakage. `enabled` is the model-target
 * check, so both scan sites cannot disagree about when the scan runs.
 */
function harmonyLeakIn(message: AssistantMessage, enabled: boolean): HarmonyLeak | null {
	if (!enabled) return null;
	const detection = detectHarmonyLeakInAssistantMessage(message);
	if (!detection) return null;
	const recovered = recoverHarmonyToolCall(message, detection);
	return { detection, removed: recovered?.removed ?? extractHarmonyRemoved(message, detection), recovered };
}

/**
 * Open the turn — or reopen it after a re-sample, which replaces the attached partial
 * in place. `message` and `assistantMessageEvent.partial` intentionally share one
 * immutable snapshot: every message_update consumer treats both as read-only, so
 * cloning the same partial twice per delta was pure waste.
 */
function openStreamingTurn(
	turn: StreamingTurn,
	event: Extract<StreamingEvent, { type: "start" }>,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): void {
	turn.partial = event.partial;
	const messageSnapshot = snapshotAssistantMessage(event.partial);
	if (turn.attached) {
		context.messages[context.messages.length - 1] = event.partial;
		turn.completedToolCallIds.clear();
		stream.push({
			type: "message_update",
			assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
			message: messageSnapshot,
		});
		return;
	}
	context.messages.push(event.partial);
	turn.attached = true;
	stream.push({ type: "message_start", message: messageSnapshot });
}

/** Advance the turn with a content delta, recording tool calls whose arguments completed. */
function advanceStreamingTurn(
	turn: StreamingTurn,
	event: Exclude<StreamingEvent, { type: "start" }>,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	onEvent: AgentLoopConfig["onAssistantMessageEvent"],
): void {
	if (!turn.partial) return;
	if (event.type === "toolcall_end") {
		turn.completedToolCallIds.add(event.toolCall.id);
	}
	turn.partial = event.partial;
	context.messages[context.messages.length - 1] = event.partial;
	onEvent?.(event.partial, event);
	const messageSnapshot = snapshotAssistantMessage(event.partial);
	stream.push({
		type: "message_update",
		assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
		message: messageSnapshot,
	});
}

/**
 * Commit a settled message. A terminal message replaces the attached partial, or opens
 * its own slot when the provider never streamed one. A trailing result — the iterator
 * ended without a terminal event — is only committed when a partial was attached: there
 * is nothing to replace, and announcing a turn the provider never started would invent
 * an assistant message for a stream that produced none.
 */
function commitSettlement(
	turn: StreamingTurn,
	settlement: Settlement,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): void {
	if (turn.attached) {
		context.messages[context.messages.length - 1] = settlement.message;
		stream.push({ type: "message_end", message: snapshotAssistantMessage(settlement.message) });
		return;
	}
	if (settlement.kind === "terminal") {
		context.messages.push(settlement.message);
		stream.push({ type: "message_start", message: snapshotAssistantMessage(settlement.message) });
		stream.push({ type: "message_end", message: snapshotAssistantMessage(settlement.message) });
	}
}

/** Drop an attached partial after a Harmony leak: its turn is unusable, so the events
 *  are closed as an error and the context slot is released for the re-sample. */
function discardStreamingTurn(
	turn: StreamingTurn,
	leak: HarmonyLeak,
	context: AgentContext,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): void {
	if (!turn.attached) return;
	emitDiscardedHarmonyPartial(
		turn.partial,
		stream,
		`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(leak.detection.signals)})`,
	);
	context.messages.pop();
	turn.attached = false;
}

/**
 * Recovery for a turn the provider settled: keep only the tool calls that completed,
 * then reinterpret a transient stream failure over a tool turn as a resumable `toolUse`
 * turn so its calls still run. Order matters — the transient check reads the calls the
 * retention pass already vetted.
 */
function recoverSettledTurn(
	message: AssistantMessage,
	completedToolCallIds: ReadonlySet<string>,
	tools: AgentContext["tools"],
): AssistantMessage {
	return recoverTransientErrorToolTurn(retainCompletedToolCalls(message, completedToolCallIds), tools ?? []);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(child => typeof child === "string");
}

function toolScopedAbortReason(signal: AbortSignal | undefined): ToolScopedAbortReason | undefined {
	const reason = signal?.reason;
	if (!reason || typeof reason !== "object") return undefined;
	if (Reflect.get(reason, "kind") !== "tool-scoped-abort") return undefined;
	if (typeof Reflect.get(reason, "message") !== "string") return undefined;
	if (typeof Reflect.get(reason, "defaultToolCallMessage") !== "string") return undefined;
	return isStringRecord(Reflect.get(reason, "toolCallMessages")) ? reason : undefined;
}

function buildToolCallAbortMessages(
	message: AssistantMessage,
	reason: ToolScopedAbortReason,
): Record<string, string> | undefined {
	let hasToolCall = false;
	const messages: Record<string, string> = {};
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		hasToolCall = true;
		messages[block.id] = reason.toolCallMessages[block.id] ?? reason.defaultToolCallMessage;
	}
	return hasToolCall ? messages : undefined;
}

/** Resolve the human-readable reason an abort carried. A caller that aborts via
 *  `AbortController.abort(reason)` with a string or a non-`AbortError` `Error`
 *  (e.g. the coding agent's user-interrupt label) gets that text surfaced on the
 *  synthesized assistant message's `errorMessage`; a bare `abort()` (whose
 *  `signal.reason` is the default `AbortError` `DOMException`) falls back to the
 *  generic sentinel that downstream renderers treat as "no specific reason". */
export function abortReasonText(signal: AbortSignal | undefined): string {
	const scopedReason = toolScopedAbortReason(signal);
	if (scopedReason) return scopedReason.message;
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0) {
		return reason.message;
	}
	return "Request was aborted";
}

function emitAbortedAssistantMessage(
	turn: StreamingTurn,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	requestSignal: AbortSignal | undefined,
): AssistantMessage {
	const model = config.getModel?.() ?? config.model;
	const errorMessage = abortReasonText(requestSignal);
	const errorId =
		errorMessage === "Request was aborted"
			? AIError.create(AIError.Flag.Abort)
			: AIError.classify(requestSignal?.reason) || undefined;
	const base: AssistantMessage = turn.partial
		? { ...turn.partial, stopReason: "aborted", errorMessage, errorId }
		: {
				role: "assistant",
				content: [],
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
				stopReason: "aborted",
				errorMessage,
				errorId,
				timestamp: Date.now(),
			};
	// Only tool calls that reached `toolcall_end` survive abort/error replay. A
	// labeled user interrupt still surfaces through `errorMessage`, but partial
	// tool arguments are unsafe to keep and can carry incomplete provider IDs.
	const retained = retainCompletedToolCalls(base, turn.completedToolCallIds);
	const scopedAbort = toolScopedAbortReason(requestSignal);
	const toolCallAbortMessages = scopedAbort ? buildToolCallAbortMessages(retained, scopedAbort) : undefined;
	if (toolCallAbortMessages) {
		retained.toolCallAbortMessages = toolCallAbortMessages;
	}
	const abortedMessage = snapshotAssistantMessage(retained);
	if (turn.attached) {
		context.messages[context.messages.length - 1] = abortedMessage;
	} else {
		context.messages.push(abortedMessage);
		stream.push({ type: "message_start", message: snapshotAssistantMessage(abortedMessage) });
	}
	stream.push({ type: "message_end", message: snapshotAssistantMessage(abortedMessage) });
	return abortedMessage;
}

/** Per-call outcome of the pre-dispatch prepare phase (validation + `beforeToolCall`). */
interface PreparedToolCall {
	tool: AgentTool<any> | undefined;
	/** Validated (possibly hook-revised) execution args; raw args when validation failed. */
	args: Record<string, unknown>;
	validationErrorMessage?: string;
	blocked?: boolean;
	blockReason?: string;
	prepareError?: unknown;
}

/**
 * Prepare results computed in the stream-done branch (before `message_start`/
 * `message_end`) so a `beforeToolCall` args revision is baked into the message
 * every consumer snapshots. `executeToolCalls` consumes them; a message that
 * bypassed the streamed path (e.g. Harmony-recovered) is prepared at dispatch
 * time instead.
 */
const preparedDispatchByMessage = new WeakMap<AssistantMessage, Map<string, PreparedToolCall>>();

function resolveToolForCall(
	tools: AgentTool<any>[] | undefined,
	toolCall: AgentToolCall,
	resolveFallbackTool: AgentLoopConfig["resolveFallbackTool"],
): AgentTool<any> | undefined {
	// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5)
	// come back under their wire-level name, which may differ from the
	// harness-internal `name`. Match on either, preferring `name` for
	// determinism if both somehow collide.
	return (
		tools?.find(t => t.name === toolCall.name) ??
		tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name) ??
		// Not in the advertised set: let the host route side-transport tools
		// (e.g. xd:// device mounts) called by their top-level name.
		resolveFallbackTool?.(toolCall.name)
	);
}

/**
 * Pre-dispatch phase for every pending tool call on `assistantMessage`, run in
 * call order: intent extraction, argument validation, and the `beforeToolCall`
 * hook. A hook `args` revision is revalidated against the tool schema and
 * written back to `toolCall.arguments`; run before `message_start`/`message_end`
 * (the streamed path) that makes the revision the single source of truth —
 * history, execution events, persistence, provider replay, concurrency
 * scheduling, and `tool.execute` all agree. Failures are recorded per call and
 * surfaced by `executeToolCalls` at the record's scheduled slot.
 */
async function prepareToolCallDispatch(
	assistantMessage: AssistantMessage,
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<Map<string, PreparedToolCall>> {
	const { resolveFallbackTool, intentTracing, beforeToolCall } = config;
	const prepared = new Map<string, PreparedToolCall>();
	for (const toolCall of assistantMessage.content) {
		if (toolCall.type !== "toolCall") continue;
		if ((toolCall as CursorExecResolvedCarrier)[kCursorExecResolved] === true) continue;
		const tool = resolveToolForCall(context.tools, toolCall, resolveFallbackTool);
		const entry: PreparedToolCall = { tool, args: toolCall.arguments as Record<string, unknown> };
		prepared.set(toolCall.id, entry);
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
		const validate = (args: Record<string, unknown>): Record<string, unknown> | undefined => {
			try {
				if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
				return validateToolArguments(tool, { ...toolCall, arguments: args });
			} catch (validationError) {
				if (tool?.lenientArgValidation) {
					const fallback = { ...args };
					delete fallback.__parseError;
					delete fallback.__rawJson;
					return fallback;
				}
				entry.args = "__parseError" in args ? { __parseError: args.__parseError } : args;
				entry.validationErrorMessage =
					validationError instanceof Error ? validationError.message : String(validationError);
				return undefined;
			}
		};
		const effectiveArgs = validate(argsForExecution);
		if (effectiveArgs === undefined) continue;
		entry.args = effectiveArgs;
		if (!beforeToolCall || !tool) continue;
		let beforeResult: BeforeToolCallResult | undefined;
		try {
			beforeResult = await beforeToolCall(
				{ assistantMessage, toolCall, tool, args: effectiveArgs, context },
				signal,
			);
		} catch (e) {
			// Contract: a throwing hook surfaces as a tool-error result without
			// aborting the batch — rethrown inside the execution span in runTool.
			entry.prepareError = e;
			continue;
		}
		if (beforeResult?.block) {
			entry.blocked = true;
			entry.blockReason = beforeResult.reason;
			continue;
		}
		if (beforeResult?.args !== undefined) {
			// Revalidate: a hook revision is untrusted input to the tool schema.
			const revised = validate(beforeResult.args);
			if (revised === undefined) continue;
			// Bake the revision into the message itself. On the streamed path this
			// precedes every consumer snapshot, so there is exactly one version of
			// the call anywhere downstream.
			toolCall.arguments = beforeResult.args;
			entry.args = revised;
		}
	}
	return prepared;
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
		hasIrcInterrupts,
		interruptMode = "immediate",
		getToolContext,
		transformToolCallArguments,
		resolveFallbackTool,
		afterToolCall,
	} = config;
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	// Defensive: the outer loop already filters exec-resolved blocks before
	// deciding to invoke `executeToolCalls`, but skip them here too so the
	// guarantee lives with the code that would re-run the tool.
	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
	);
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const ircAbortController = new AbortController();
	// Cooperative channel: aborted when queued steering (or an interrupting
	// peer IRC) is detected mid-batch. Tools receive it via tool context
	// (`ctx.steeringSignal`) and MAY react — e.g. an auto-backgroundable bash
	// backgrounds itself so the message injects promptly — but it never kills
	// anything; ignoring it is always safe.
	const steeringSoftController = new AbortController();
	// Interruptible tools (pure waits: hub wait, vibe) observe steering +
	// external + IRC aborts. Every other tool sees ONLY the external signal:
	// neither queued steering nor a peer IRC ever hard-kills a partially
	// side-effecting foreground tool (e.g. `bash`) — those get the cooperative
	// `steeringSignal` above, and the message injects at the next boundary.
	const nonInterruptibleSignal: AbortSignal = signal ?? new AbortController().signal;
	const interruptibleSignal: AbortSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal, ircAbortController.signal])
		: AbortSignal.any([steeringAbortController.signal, ircAbortController.signal]);
	const interruptState: { triggered: boolean; source?: SteeringInterruptSource | "irc" } = { triggered: false };

	// Streamed messages were prepared (validation + `beforeToolCall`) before
	// `message_end`, so hook revisions are already part of the message; anything
	// that bypassed the streamed path is prepared here instead.
	const preparedDispatch =
		preparedDispatchByMessage.get(assistantMessage) ??
		(await prepareToolCallDispatch(assistantMessage, currentContext, config, signal));

	const records = toolCalls.map(toolCall => {
		const prepared = preparedDispatch.get(toolCall.id) ?? {
			tool: resolveToolForCall(tools, toolCall, resolveFallbackTool),
			args: toolCall.arguments as Record<string, unknown>,
		};
		const { tool, args } = prepared;
		const interruptibleMode = tool?.interruptible;
		let interruptible = false;
		if (typeof interruptibleMode === "function") {
			try {
				// Resolved from the prepared (possibly hook-revised) args so an
				// argument-dependent policy governs the call that actually runs.
				interruptible = interruptibleMode(args);
			} catch {
				// Resolver failures default to preserving the tool's outcome.
				interruptible = false;
			}
		} else {
			interruptible = interruptibleMode === true;
		}
		return {
			toolCall,
			tool,
			args,
			interruptible,
			signal: interruptible ? interruptibleSignal : nonInterruptibleSignal,
			started: false,
			result: undefined as AgentToolResult<any> | undefined,
			isError: false,
			skipped: false,
			toolResultMessage: undefined as ToolResultMessage | undefined,
			resultEmitted: false,
			validationErrorMessage: prepared.validationErrorMessage,
			blocked: prepared.blocked === true,
			blockReason: prepared.blockReason,
			prepareError: prepared.prepareError,
		};
	});

	const checkIrcInterrupts = async (): Promise<void> => {
		// IRC only fires once: a peer interrupt already recorded on interruptState
		// must not re-abort, and (unlike steering) never re-consumes a queue.
		if (!shouldInterruptImmediately || signal?.aborted || interruptState.triggered) return;
		if (hasIrcInterrupts && (await hasIrcInterrupts())) {
			// Peer IRC hard-aborts interruptible waits only; foreground tools keep
			// running (no partial side effects) but get the cooperative soft
			// signal so backgroundable work can step aside for the peer message.
			interruptState.triggered = true;
			interruptState.source = "irc";
			ircAbortController.abort();
			steeringSoftController.abort();
		}
	};

	const checkSteering = async (): Promise<void> => {
		// `signal` (external/user abort) is checked separately from the internal
		// abort controllers: once the run is externally aborted it is unwinding
		// and the interrupt would be redundant.
		if (!shouldInterruptImmediately || signal?.aborted) {
			return;
		}
		// Mid-batch steering detection must be non-consuming. If a direct
		// integration only provides getSteeringMessages(), the queue drains at the
		// injection boundary below; polling it here would strand or drop messages.
		let steeringQueued = false;
		let steeringSource: SteeringInterruptSource | undefined;
		if (hasSteeringMessages) {
			const queuedState = await hasSteeringMessages();
			if (typeof queuedState === "boolean") {
				steeringQueued = queuedState;
				steeringSource = queuedState ? "user" : undefined;
			} else {
				const state: SteeringQueueState = queuedState;
				steeringQueued = state.queued;
				steeringSource = state.source ?? (state.queued ? "unknown" : undefined);
			}
		}
		if (steeringQueued) {
			// Queued steering hard-aborts only interruptible waits and raises the
			// cooperative soft signal for everything else: the boundary dequeue
			// below injects the message as soon as running tools finish (or
			// background themselves), and not-yet-started tools are skipped.
			// Idempotent — a second steer poll after the abort is a no-op.
			if (!steeringAbortController.signal.aborted) {
				interruptState.triggered = true;
				interruptState.source = steeringSource ?? "unknown";
				steeringAbortController.abort();
				steeringSoftController.abort();
			}
			return;
		}
		await checkIrcInterrupts();
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
			providerMetadata: result.providerMetadata,
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
		// A pending interrupt preempts not-yet-started tools so the message
		// injects promptly. A peer-IRC interrupt is the exception: it aborts
		// interruptible waits only and leaves non-interruptible foreground work
		// untouched (see the emit branch below and the `does not abort a
		// non-interruptible foreground tool` case). That guarantee must hold for
		// work still queued behind the aborted wait too — otherwise a batched
		// `todo`/`write` gets dropped as "Skipped due to pending peer interrupt"
		// purely for being ordered after the wait (#7493). User/system steering
		// still preempts everything queued.
		if (interruptState.triggered && (record.interruptible || interruptState.source !== "irc")) {
			// Skip both span emission and the collector orphan record here. The
			// tail sweep below (after `Promise.allSettled`) is the single path
			// that handles "no result message was produced" — it calls
			// `recordSkippedTool` and `emitToolResult` once per record, so any
			// work we did here would double-count.
			record.skipped = true;
			return;
		}
		// Park before starting this tool while the process-wide pause gate is
		// engaged. Tools already executing are unaffected (pausing never aborts);
		// a batch interrupted mid-pause unwinds via the signal checks below.
		if (agentPauseGate.paused) await agentPauseGate.waitUntilResumed(record.signal);

		const { toolCall, tool } = record;
		// Validation (and the beforeToolCall hook) ran in the prepare phase; a
		// failure recorded there surfaces here at the record's scheduled slot so
		// result emission keeps batch order.
		if (record.validationErrorMessage !== undefined) {
			emitToolResult(
				record,
				{
					content: [{ type: "text" as const, text: record.validationErrorMessage }],
					details: { isError: true, error: record.validationErrorMessage },
				},
				true,
			);
			return;
		}
		const effectiveArgs = record.args;
		if (record.signal.aborted) {
			record.skipped = true;
			recordSkippedTool(telemetry, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				status: "aborted",
			});
			emitToolResult(record, createToolSignalAbortedResult(record.signal), true);
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
		let executionStarted = false;

		await runInActiveSpan(toolSpan, async () => {
			try {
				if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
				if (record.signal.aborted) {
					result = createToolSignalAbortedResult(record.signal);
					isError = true;
					return;
				}

				if (record.prepareError !== undefined) throw record.prepareError;
				if (record.blocked) {
					throw new ToolCallBlockedError(record.blockReason);
				}
				const executionArgs = transformToolCallArguments
					? transformToolCallArguments(effectiveArgs, toolCall.name)
					: effectiveArgs;
				record.args = executionArgs;

				// The cooperative steering signal rides the loop-owned
				// ToolCallContext (surfacing as `ctx.toolCall.steeringSignal`):
				// AgentToolContext itself is app-built via declaration merging, so
				// the loop cannot construct or extend one structurally.
				const toolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
							steeringSignal: steeringSoftController.signal,
							providerMetadata: toolCall.providerMetadata,
						})
					: undefined;
				executionStarted = true;
				const rawResult = await tool.execute(
					toolCall.id,
					executionArgs,
					record.signal,
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

			if (afterToolCall && (!record.signal.aborted || completedToolExecution)) {
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
						record.signal,
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
							providerMetadata: after.providerMetadata ?? result.providerMetadata,
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
		const perToolAborted = record.signal.aborted;
		const abortedDuringExecution = perToolAborted && isError && !completedToolExecution;
		if (interrupted && abortedDuringExecution) {
			// This tool's own signal fired AND it failed to produce a result. The
			// execution may already have performed partial work before throwing on
			// abort, so preserve that distinction in the placeholder metadata.
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(interruptState.source, executionStarted), true);
		} else {
			// No interrupt on this signal, or the tool finished before the interrupt landed
			// (`completedToolExecution`) — even if the signal aborted around completion. Keep
			// its real result: a completed tool already ran its side effects, so the model must
			// see what actually happened (a genuine non-zero exit / error result) rather than a
			// false "skipped" that discards work the tool performed (#4752). A peer-IRC interrupt
			// on the batch leaves non-interruptible tools' signals untouched — their genuine
			// errors survive here too.
			emitToolResult(record, result, isError);
		}

		const firstTextBlock = result.content?.[0];
		const errorMessageForSpan =
			caughtError === undefined && isError && firstTextBlock?.type === "text" ? firstTextBlock.text : undefined;
		const status = abortedDuringExecution
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

	// While tool calls are in flight, queued steering or interrupting IRC would
	// otherwise wait out the tools' own window. Poll only non-consuming queues:
	// detection hard-aborts interruptible waits, soft-signals cooperative tools
	// (auto-background bash), and skips not-yet-started tools, so the boundary
	// dequeue below injects the message promptly. Gated on immediate-interrupt
	// mode; checkSteering is idempotent (no-op once triggered).
	const watchSteeringWhileRunning =
		shouldInterruptImmediately && (hasSteeringMessages !== undefined || hasIrcInterrupts !== undefined);
	const eventDrivenSteeringWatch =
		watchSteeringWhileRunning && config.waitForSteeringMessages !== undefined && hasSteeringMessages !== undefined;
	const steeringWatchAbortController = new AbortController();
	const steeringWatchSignal = signal
		? AbortSignal.any([signal, steeringWatchAbortController.signal])
		: steeringWatchAbortController.signal;
	// Race every wait against one local abort promise. The callback contract does
	// not require an implementation to observe the signal, and one that resolves
	// only on the next queue event would otherwise never settle once the batch
	// finishes, so awaiting it during teardown would hang a batch with no steer.
	const { promise: watchAborted, resolve: resolveWatchAbort } = Promise.withResolvers<void>();
	if (steeringWatchSignal.aborted) {
		resolveWatchAbort();
	} else {
		steeringWatchSignal.addEventListener("abort", () => resolveWatchAbort(), { once: true });
	}
	const watchAbortedFalse = watchAborted.then(() => false);
	const steeringWatchPromise = eventDrivenSteeringWatch
		? (async (): Promise<void> => {
				while (!steeringWatchSignal.aborted) {
					// Subscribe before checking queue state. This closes the edge
					// race where a steer arrives after a check but before listener
					// registration: the subsequent check observes queued state,
					// while later arrivals resolve this already-installed wait.
					const steeringQueued = config.waitForSteeringMessages?.(steeringWatchSignal).then(
						() => true,
						() => false,
					);
					const steeringChecked = checkSteering().then(
						() => true,
						() => false,
					);
					if (!(await Promise.race([steeringChecked, watchAbortedFalse]))) return;
					if (steeringWatchSignal.aborted || interruptState.triggered) return;
					if (!(await Promise.race([steeringQueued, watchAbortedFalse]))) return;
				}
			})()
		: undefined;
	// IRC interrupt records have a separate session-owned queue and no wake
	// callback. Keep its established timer fallback when that queue is present;
	// system steering uses the event-driven path above and does not poll.
	const steeringWatchTimer =
		watchSteeringWhileRunning && (!eventDrivenSteeringWatch || hasIrcInterrupts !== undefined)
			? setInterval(
					() => void (eventDrivenSteeringWatch ? checkIrcInterrupts() : checkSteering()),
					STEERING_INTERRUPT_POLL_MS,
				)
			: undefined;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrencyMode = record.tool?.concurrency;
		let concurrency: "shared" | "exclusive";
		if (typeof concurrencyMode === "function") {
			// Resolved from the prepared (possibly hook-revised) args — raw args
			// only when validation failed, and those records error out before
			// executing. A throwing resolver must not take down the whole batch,
			// so fall back to the safe (serial) mode.
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
	try {
		await Promise.allSettled(tasks);
	} finally {
		steeringWatchAbortController.abort();
		await steeringWatchPromise?.catch(() => undefined);
		clearInterval(steeringWatchTimer);
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
			emitToolResult(record, createSkippedToolResult(interruptState.source, false), true);
		}
	}

	return { toolResults: emittedToolResults };
}

/**
 * Discriminator embedded in {@link AgentToolResult.details} and
 * {@link ToolResultMessage.details} for tool calls that were emitted by the
 * assistant but never actually invoked locally.
 *
 * The synthetic result exists only to preserve the tool_use / tool_result
 * pairing the provider API requires; no `tool.execute()` ran. UI, telemetry,
 * and history consumers can key on `__synthetic === true` to render or
 * classify these as "call emitted, not executed" instead of a real local
 * tool failure — the mislabeling this discriminator was introduced to fix
 * (#4321): a provider-side stream error after tool-call emission (e.g. Codex
 * websocket close) was surfaced by the CLI as if the local tool had failed.
 *
 * `source` names the state that prevented execution — either an assistant-side
 * turn termination (`assistant_stop_*`) or a mid-batch interrupt that skipped a
 * still-pending call to service queued steering/peer input (`interrupt_skipped`).
 * `upstreamError` is the provider-reported message when the turn ended with
 * `stopReason === "error"`.
 */
export interface SyntheticToolResultDetails {
	__synthetic: true;
	source:
		| "assistant_stop_aborted"
		| "assistant_stop_error"
		| "assistant_stop_skipped"
		| "assistant_stop_length"
		| "interrupt_skipped";
	executed: false;
	upstreamError?: string;
}

/**
 * Metadata for an interrupt-aborted call that entered `tool.execute()` but
 * threw before returning a usable result. It may have performed partial work.
 */
interface InterruptedToolResultDetails {
	__interrupted: true;
	source: "interrupt_skipped";
	execution: "started";
}

/**
 * Narrow an {@link AgentMessage} to a synthetic {@link ToolResultMessage} —
 * a tool_result emitted for a tool call the assistant never invoked (see
 * {@link SyntheticToolResultDetails}). Consumers use this to look past the
 * placeholder pairing back to the assistant turn that produced it, e.g.
 * `AgentSession.retry()` walking back over the synthetic results a
 * stalled/aborted mid-tool-call turn leaves behind.
 */
export function isSyntheticToolResultMessage(
	message: AgentMessage | undefined,
): message is ToolResultMessage<SyntheticToolResultDetails> {
	return (
		message?.role === "toolResult" &&
		(message.details as SyntheticToolResultDetails | undefined)?.__synthetic === true
	);
}

function syntheticDetailsFor(
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage: string | undefined,
): SyntheticToolResultDetails {
	const source: SyntheticToolResultDetails["source"] =
		reason === "aborted"
			? "assistant_stop_aborted"
			: reason === "error"
				? "assistant_stop_error"
				: reason === "length"
					? "assistant_stop_length"
					: "assistant_stop_skipped";
	return {
		__synthetic: true,
		source,
		executed: false,
		...(reason === "error" && errorMessage ? { upstreamError: errorMessage } : {}),
	};
}

/**
 * Create the persisted synthetic result for a tool call that was emitted by
 * the assistant but never invoked locally.
 */
export function createSyntheticToolResultMessage(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
): ToolResultMessage<SyntheticToolResultDetails> {
	const message =
		reason === "aborted"
			? "Tool execution was aborted"
			: reason === "length"
				? "Tool call was not executed because the assistant hit its output token limit (stop_reason: length) before the arguments could complete; the recorded arguments are truncated and unsafe to run. Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls (e.g. for `write`/`edit`, write the first chunk then append the rest with subsequent `edit` insert ops, or break the file into multiple `write` targets)"
				: reason === "skipped"
					? "Tool call was not executed because the assistant ended its turn"
					: "Tool call was not executed because the provider stream ended with an error before the tool could run";
	const details = syntheticDetailsFor(reason, errorMessage);
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details,
		isError: true,
		timestamp: Date.now(),
	};
}

/**
 * Pair calls that will not run with placeholder results, committing each one to
 * the live context and the run's message list.
 *
 * The placeholder keeps the API's tool_use/tool_result pairing intact, but no
 * execute_tool span is started for these calls: mirror the run-collector entry
 * directly so the run summary's tool counters and `coverage.toolsInvoked`
 * reflect what the user actually saw on the wire. Text resolution is
 * per-call label → plan text → cause default, so a tool-scoped abort blames only
 * the matching call while its siblings stay neutral.
 */
function pairPlaceholderResults(params: {
	plan: PlaceholderPlan;
	message: AssistantMessage;
	signal: AbortSignal | undefined;
	stream: EventStream<AgentEvent, AgentMessage[]>;
	telemetry: AgentTelemetry | undefined;
	currentContext: AgentContext;
	newMessages: AgentMessage[];
}): ToolResultMessage[] {
	const { plan, message, signal, stream, telemetry, currentContext, newMessages } = params;
	const spec = PLACEHOLDER_SPEC[plan.cause];
	// Only an aborted/errored turn carries per-call labels; provider-built stream
	// error messages carry none, so derive them from a tool-scoped abort signal.
	const scopedAbort = plan.cause === "aborted" || plan.cause === "error" ? toolScopedAbortReason(signal) : undefined;
	const perCallMessages =
		scopedAbort === undefined
			? message.toolCallAbortMessages
			: (message.toolCallAbortMessages ?? buildToolCallAbortMessages(message, scopedAbort));
	const results: ToolResultMessage[] = [];
	for (const toolCall of plan.calls) {
		const result = createAbortedToolResult(
			toolCall,
			stream,
			spec.reason,
			perCallMessages?.[toolCall.id] ?? plan.errorMessage ?? spec.errorMessage,
		);
		currentContext.messages.push(result);
		newMessages.push(result);
		results.push(result);
		recordSkippedTool(telemetry, { toolCallId: toolCall.id, toolName: toolCall.name, status: spec.status });
	}
	return results;
}

/**
 * Create and emit a tool result for a tool call that was emitted by the
 * assistant but never invoked locally.
 */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
): ToolResultMessage {
	const toolResultMessage = createSyntheticToolResultMessage(toolCall, reason, errorMessage);
	const result: AgentToolResult<SyntheticToolResultDetails> = {
		content: toolResultMessage.content,
		details: toolResultMessage.details,
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

function createSkippedToolResult(
	source: SteeringInterruptSource | "irc" | undefined,
	executionStarted: boolean,
): AgentToolResult<SyntheticToolResultDetails | InterruptedToolResultDetails> {
	let reason = "pending steering message";
	let blocker = "queued message";
	if (source === "user") {
		reason = "queued user message";
		blocker = "queued message";
	} else if (source === "agent") {
		reason = "pending parent steering message";
		blocker = "steering message";
	} else if (source === "system") {
		reason = "pending system advisory";
		blocker = "advisory";
	} else if (source === "irc") {
		reason = "pending peer interrupt";
		blocker = "interrupt";
	}
	return {
		content: [
			{
				type: "text",
				text: `Skipped due to ${reason}. Do not count this skipped result as completed work or verification. After the ${blocker} is handled on the next step, retry the skipped tool if it is still needed.`,
			},
		],
		details: executionStarted
			? { __interrupted: true, source: "interrupt_skipped", execution: "started" }
			: { __synthetic: true, source: "interrupt_skipped", executed: false },
	};
}
