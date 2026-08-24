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
	type ImageContent,
	isApiKeyResolver,
	type Model,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	streamSimple,
	stripSchemaDescriptions,
	type TextContent,
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
import { agentPauseGate } from "./pause";
import type {
	ToolCallPresentation,
	ToolModelContentBlock,
	ToolOutcome,
	ToolPresentationEvent,
	ToolProgressProtocol,
	ToolProgressProtocolKind,
} from "./presentation";
import {
	executionToolArguments,
	outcomeFailed,
	presentationProducerOf,
	publicToolArguments,
	streamId,
	ToolPresentationStream,
} from "./presentation";
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
	AgentPreModelCallResult,
	AgentTool,
	AgentToolCall,
	AgentToolContext,
	AgentToolResult,
	AgentTurnEndContext,
	AsideMessage,
	BeforeToolCallResult,
	CommittableAsideMessage,
	JsonValue,
	SoftToolRequirement,
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

/** Minimal shape check for a raw `outcome` value crossing the untrusted boundary — not full schema validation, matching this function's existing light-touch coercion of `isError`/`useless`. */
function isPlainToolOutcome(value: unknown): value is ToolOutcome {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value.kind === "succeeded" || value.kind === "failed" || value.kind === "interrupted")
	);
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
	// A producer migrated onto the typed contract may already carry
	// its own authoritative outcome; thread it through unchanged so it survives
	// both the direct-execute normalization and an `afterToolCall` re-coercion.
	const rawOutcome = rawObj && "outcome" in rawObj ? rawObj.outcome : undefined;
	const outcome = isPlainToolOutcome(rawOutcome) ? rawOutcome : undefined;

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
	// One invariant enforced at one site instead of five downstream restatements:
	// `useless` never survives alongside a failure. A
	// migrated producer's own `outcome` is authoritative for "succeeded"; an
	// unmigrated producer has none yet (its outcome is derived later, from this
	// same `isError`), so `!isError` reproduces today's behavior exactly.
	const succeeded = outcome !== undefined ? outcome.kind === "succeeded" : !isError;
	return {
		result: {
			content,
			details,
			providerMetadata,
			...(isError ? { isError: true } : {}),
			...(useless && succeeded ? { useless: true } : {}),
			...(outcome !== undefined ? { outcome } : {}),
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

	const softRequirementState = config.softToolRequirementState ?? { escalations: 0 };
	let preserveSoftRequirementState = false;

	let pendingMessages: AgentMessage[] = [];
	try {
		let messagesToEmit = [...initialMessages];
		if (isDeadlineExceeded(config.deadline)) {
			emitInputMessages(stream, messagesToEmit);
			endAgentStream(stream, newMessages, telemetry, stepCounter.count);
			return;
		}
		// Check for steering messages at start (user may have typed while waiting).
		// Skip when the run is already externally aborted — dequeuing would strand
		// the messages in a run that is about to die.
		try {
			pendingMessages = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
		} catch (error) {
			stream.push({ type: "turn_start" });
			emitInputMessages(stream, messagesToEmit);
			throw error;
		}
		let harmonyRetryAttempt = 0;
		let harmonyTruncateResumeCount = 0;
		let pausedTurnContinuations = 0;

		// Soft tool requirement lifecycle (reminder then escalation; see SoftToolRequirement).
		// The host-owned state survives only a gate stop between Agent.prompt calls.
		// Resolved once per logical turn at the fetch site below and reused across
		// Harmony-leak re-samples (which re-enter the same turn) so the consuming
		// getToolChoice is never advanced twice; the flag resets at the message boundary.
		let hostToolChoice: ToolChoice | undefined;
		let softRequiredTool: string | undefined;
		let softSatisfies: SoftToolRequirement["satisfies"];
		let directiveResolvedForTurn = false;
		let turnOpen = false;

		// Outer loop: continues when queued follow-up messages arrive after agent would stop
		while (true) {
			let hasMoreToolCalls = true;

			// Inner loop: process tool calls and steering messages
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (isDeadlineExceeded(config.deadline)) {
					emitInputMessages(stream, messagesToEmit);
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}
				// Yield at the top of each iteration to prevent busy-wait when
				// the agent loop is executing tool calls back-to-back.
				await yieldIfDue();
				// Park at the turn boundary while the process-wide pause gate is
				// engaged (host /pause). An external abort releases the park so a
				// cancelled run still unwinds while everything else stays frozen.
				if (agentPauseGate.paused) await agentPauseGate.waitUntilResumed(signal);

				// Build the provider-bound context before opening the turn. Queue
				// messages are added now but their events remain deferred until
				// provider preparation either succeeds or opens an error turn.
				const turnMessages = messagesToEmit;
				messagesToEmit = [];
				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						currentContext.messages.push(message);
						newMessages.push(message);
						turnMessages.push(message);
						(message as CommittableAsideMessage)[ASIDE_MESSAGE_COMMIT]?.();
					}
					pendingMessages = [];
				}

				let preparedProviderCall: PreparedProviderCall;
				let gateResult: AgentPreModelCallResult;
				try {
					if (config.syncContextBeforeModelCall) {
						await config.syncContextBeforeModelCall(currentContext, signal);
					}

					if (!directiveResolvedForTurn) {
						const directive = signal?.aborted ? undefined : config.getToolChoice?.();
						const softReq = isSoftToolRequirement(directive) ? directive : undefined;
						hostToolChoice = directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
						softRequiredTool = softReq?.toolName;
						softSatisfies = softReq?.satisfies;
						const softRequirementId = softRequirementState.id;
						if (softReq !== undefined) {
							if (softReq.id !== softRequirementId) {
								softRequirementState.id = softReq.id;
								softRequirementState.forcedToolChoice = undefined;
								softRequirementState.escalations = 0;
								for (const reminder of softReq.reminder) {
									currentContext.messages.push(reminder);
									newMessages.push(reminder);
									turnMessages.push(reminder);
								}
							}
						} else {
							softRequirementState.id = undefined;
							softRequirementState.forcedToolChoice = undefined;
							softRequirementState.escalations = 0;
						}
						directiveResolvedForTurn = true;
					}

					preparedProviderCall = await prepareProviderCall(currentContext, config, signal);
					gateResult = (await config.beforeModelCall?.(preparedProviderCall.context, signal)) || undefined;
				} catch (error) {
					if (!turnOpen) {
						stream.push({ type: "turn_start" });
						emitInputMessages(stream, turnMessages);
						turnOpen = true;
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
					if (!turnOpen && !signal?.aborted) {
						try {
							config.onToolChoiceRejected?.();
						} catch (error) {
							stream.push({ type: "turn_start" });
							emitInputMessages(stream, turnMessages);
							turnOpen = true;
							throw error;
						}
					}
					emitInputMessages(stream, turnMessages);
					if (turnOpen) {
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
						turnOpen = false;
					}
					preserveSoftRequirementState = !signal?.aborted;
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}

				if (!turnOpen) {
					stream.push({ type: "turn_start" });
					emitInputMessages(stream, turnMessages);
					turnOpen = true;
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
						softRequirementState.forcedToolChoice,
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
				softRequirementState.forcedToolChoice = undefined;

				// A fresh logical turn re-resolves the directive next iteration; a Harmony
				// retry `continue`s before this line and keeps the cached value.
				directiveResolvedForTurn = false;

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					// Create placeholder tool results for any tool calls in the aborted message
					// This maintains the tool_use/tool_result pairing that the API requires
					type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
					// Cursor exec-resolved blocks already have their toolResult buffered
					// for out-of-band emission; a placeholder aborted result here would
					// pair a duplicate to the same toolCallId (issue #4348 codex review).
					const toolCalls = message.content.filter(
						(c): c is ToolCallContent =>
							c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
					);
					// Provider-built aborted messages (stream error events) carry no
					// per-tool labels; derive them from a tool-scoped abort signal so
					// only the matching call is blamed and siblings stay neutral.
					const scopedAbort = toolScopedAbortReason(signal);
					const toolCallAbortMessages =
						message.toolCallAbortMessages ??
						(scopedAbort ? buildToolCallAbortMessages(message, scopedAbort) : undefined);
					const toolResults: ToolResultMessage[] = [];
					for (const toolCall of toolCalls) {
						const errorMessage = toolCallAbortMessages?.[toolCall.id] ?? message.errorMessage;
						const result = createAbortedToolResult(toolCall, stream, message.stopReason, errorMessage);
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
					turnOpen = false;

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
				// A Cursor exec-channel synthesized `toolCall` block carries
				// `kCursorExecResolved` because Cursor already executed the tool
				// server-side (via the bridge) and buffered the result for
				// out-of-band emission — running it here again would duplicate the
				// same side-effecting call (issue #4348 review by @chatgpt-codex-connector).
				const toolCalls = message.content.filter(
					(c): c is ToolCallContent =>
						c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
				);
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
					toolCalls.every(toolCall => softSatisfies?.(toolCall) ?? toolCall.name === softRequiredTool);
				const softGateActive =
					softRequiredTool !== undefined && !hardToolChoiceBlocks(config.toolChoice, softRequiredTool);
				const softNonCompliant = softGateActive && !calledOnlyRequiredTool;

				const toolResults: ToolResultMessage[] = [];
				if (softNonCompliant && softRequiredTool !== undefined) {
					if (softRequirementState.escalations >= MAX_SOFT_TOOL_ESCALATIONS) {
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
					softRequirementState.forcedToolChoice = { type: "tool", name: softRequiredTool };
					softRequirementState.escalations++;
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

				// A tool hook may mark its completed result as terminal (e.g. subagent yield).
				// Stop before the next provider call without changing external/user abort semantics.
				if (signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON) {
					hasMoreToolCalls = false;
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
				turnOpen = false;

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
				const steering = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
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
			const lateSteering = signal?.aborted ? [] : (await config.getSteeringMessages?.(signal)) || [];
			const asideMessages = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
			const followUpMessages = signal?.aborted ? [] : (await config.getFollowUpMessages?.(signal)) || [];
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
		discardAsides(pendingMessages, new Error("Aside message was not committed before the agent loop ended"));
		if (!preserveSoftRequirementState) {
			softRequirementState.id = undefined;
			softRequirementState.forcedToolChoice = undefined;
			softRequirementState.escalations = 0;
		}
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
						let finalMessage = recoverTransientErrorToolTurn(
							retainCompletedToolCalls(await response.result(), completedToolCallIds),
							context.tools ?? [],
						);
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
						case "image_end":
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
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	completedToolCallIds: ReadonlySet<string>,
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
	const base: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage, errorId }
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
	const retained = retainCompletedToolCalls(base, completedToolCallIds);
	const scopedAbort = toolScopedAbortReason(requestSignal);
	const toolCallAbortMessages = scopedAbort ? buildToolCallAbortMessages(retained, scopedAbort) : undefined;
	if (toolCallAbortMessages) {
		retained.toolCallAbortMessages = toolCallAbortMessages;
	}
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
/**
 * Runtime check that a value is a JSON value (no functions, Dates, Symbols,
 * class instances, or other non-cloneable structures). Hook-revised tool
 * arguments must be JSON values: the execution copy is a deep `structuredClone`
 * that must succeed, and the public/execution views must never share a
 * mutable graph. A non-JSON value is rejected at this boundary, before the
 * clone, so the failure is a deterministic validation error rather than a
 * `DataCloneError` caught later and silently turned into a "skipped" result.
 *
 * Bounded to prevent stack overflow on cyclic extension-provided objects: the
 * depth limit is generous (128 — far beyond any legitimate tool argument) and
 * a cycle or pathologically deep structure is rejected, not crashed on.
 * Rejects `NaN`/`Infinity` (not representable in JSON) and symbol-keyed
 * properties (which `JSON.stringify` drops silently but `structuredClone`
 * preserves — a divergence from the `JsonValue` contract). Rejects `undefined`
 * and sparse arrays (holes serialize differently from the execution clone).
 */
const JSON_MAX_DEPTH = 128;

/**
 * Produces a fresh, plain JSON tree at the untyped hook boundary. Descriptor
 * reads reject accessors without invoking them; the outer catch converts every
 * proxy/reflection failure into a deterministic validation failure.
 */
function normalizeJsonValue(value: unknown): JsonValue | undefined {
	const seen = new WeakSet<object>();
	const visit = (current: unknown, depth: number): JsonValue | undefined => {
		if (depth > JSON_MAX_DEPTH || current === null) return current === null ? null : undefined;
		if (typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") return Number.isFinite(current) ? current : undefined;
		if (typeof current !== "object") return undefined;
		if (seen.has(current)) return undefined;
		seen.add(current);
		if (Array.isArray(current)) {
			const descriptors = Object.getOwnPropertyDescriptors(current);
			const normalized: JsonValue[] = [];
			for (let index = 0; index < current.length; index++) {
				const descriptor = descriptors[String(index)];
				if (descriptor === undefined || !("value" in descriptor)) return undefined;
				const item = visit(descriptor.value, depth + 1);
				if (item === undefined) return undefined;
				normalized.push(item);
			}
			return normalized;
		}
		if (Object.getPrototypeOf(current) !== Object.prototype || Object.getOwnPropertySymbols(current).length > 0)
			return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(current);
		const normalized: { [key: string]: JsonValue } = {};
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
			const item = visit(descriptor.value, depth + 1);
			if (item === undefined) return undefined;
			normalized[key] = item;
		}
		return normalized;
	};
	try {
		return visit(value, 0);
	} catch {
		return undefined;
	}
}

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
			// Enforce JSON at the untyped hook boundary: a non-JSON value (function,
			// Date, Symbol, class instance) is a contract violation, rejected here
			// before the deep clone produces the execution copy. A `DataCloneError`
			// caught later is a silent "skipped" result; this makes it a deterministic
			// validation error.
			const normalized = normalizeJsonValue(beforeResult.args);
			if (
				normalized === undefined ||
				normalized === null ||
				Array.isArray(normalized) ||
				typeof normalized !== "object"
			) {
				entry.validationErrorMessage = "beforeToolCall returned non-JSON arguments";
				entry.args = beforeResult.args;
				continue;
			}
			// Revalidate the normalized tree, not hostile hook-owned objects.
			const revised = validate(normalized);
			if (revised === undefined) continue;
			// Bake the normalized revision into history and every public view.
			toolCall.arguments = normalized;
			entry.args = revised;
		}
	}
	return prepared;
}

/**
 * Total, structural narrowing of a tool's `content` blocks into
 * {@link ToolModelContentBlock} — the presentation package's own mirror of
 * `TextContent`/`ImageContent` (see `events.ts`'s doc comment on why it
 * mirrors rather than imports them). Field-by-field, not a cast: this is the
 * one conversion boundary between the two type algebras, and a future field
 * added to either side fails here loudly (the `never` check on the default
 * arm) instead of silently dropping data into the persisted journal.
 */
function toolModelContentOf(content: readonly (TextContent | ImageContent)[]): readonly ToolModelContentBlock[] {
	return content.map(block => {
		switch (block.type) {
			case "text":
				return block.textSignature === undefined
					? { type: "text" as const, text: block.text }
					: { type: "text" as const, text: block.text, textSignature: block.textSignature };
			case "image":
				return block.detail === undefined
					? { type: "image" as const, data: block.data, mimeType: block.mimeType }
					: { type: "image" as const, data: block.data, mimeType: block.mimeType, detail: block.detail };
			default: {
				const exhaustive: never = block;
				throw new Error(`Unhandled tool content block: ${JSON.stringify(exhaustive)}`);
			}
		}
	});
}
/**
 * The one derivation of a {@link ToolOutcome} at the dispatcher boundary.
 *
 * A completed execution's own `result.outcome` wins when the producer set one:
 * only the producer knows what its process/details actually did.
 * An unmigrated producer sets nothing, so this falls through to the same
 * `isError`-derived synthetic branch it always has -- unchanged behavior,
 * which is what keeps an unmigrated producer's model goldens byte-identical.
 * Every other settlement is synthetic and constructed here, which is what
 * makes "settled exactly once, including on paths that never reached the
 * tool" an ownership property rather than a per-producer obligation.
 */
function deriveToolOutcome(input: {
	readonly result: AgentToolResult<any>;
	readonly isError: boolean;
	readonly caughtError: unknown;
	readonly completedToolExecution: boolean;
	readonly interrupted: boolean;
	readonly interruptReason: string;
}): ToolOutcome {
	if (input.interrupted) {
		return { kind: "interrupted", reason: input.interruptReason };
	}
	const caught = input.caughtError;
	if (caught !== undefined) {
		const message = caught instanceof Error ? caught.message : String(caught);
		// A hook that threw did so *after* the tool completed, so the reason is
		// distinguishable from an executor throw without inspecting the stack.
		const reason =
			caught instanceof ToolCallBlockedError ? "blocked" : input.completedToolExecution ? "hook" : "thrown";
		return { kind: "failed", failure: { reason, message } };
	}
	if (input.completedToolExecution && input.result.outcome !== undefined) {
		return input.result.outcome;
	}
	if (input.isError) {
		const firstText = input.result.content?.find(block => block.type === "text");
		return {
			kind: "failed",
			failure: {
				reason: "tool_reported",
				message: firstText?.type === "text" ? firstText.text : "Tool reported a failure",
			},
		};
	}
	return { kind: "succeeded" };
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
			/**
			 * Which progress protocol this call runs on, decided in `runTool` and read
			 * back by `emitToolResult`.
			 *
			 * It has to live on the record rather than only on the start event: the
			 * settlement is emitted from `emitToolResult`, which is also reachable from
			 * the tail sweep, and a `tool_execution_end` that forgets the declaration
			 * makes a presentation-protocol call render through the legacy mapper as
			 * well — delivering the same output twice.
			 */
			progressProtocol: "legacy_snapshot" as ToolProgressProtocolKind,
			result: undefined as AgentToolResult<any> | undefined,
			isError: false,
			skipped: false,
			toolResultMessage: undefined as ToolResultMessage | undefined,
			resultEmitted: false,
			/**
			 * The exact placeholder chosen to override this call's own `result`
			 * before it settles — the steering-interrupt and lifecycle-rejection
			 * paths in `runTool` set this before calling `settlePresentation`.
			 *
			 * Lives on the shared record, not a `runTool`-local variable: the
			 * lifecycle-rejection path settles inside `runTool`'s own `catch` block
			 * and then rethrows, skipping `runTool`'s own `emitToolResult` entirely —
			 * the record only reaches the *outer* tail sweep in `executeToolCalls`
			 * (a different function, after `Promise.allSettled`), which must reuse
			 * this exact value rather than independently recomputing
			 * `createSkippedToolResult(interruptState.source, false)`. Recomputing
			 * there could observe a `source` a concurrent steering watcher changed
			 * while `settlePresentation`'s internal awaits were in flight, producing
			 * a placeholder that disagrees with the one already frozen into
			 * `modelContent`.
			 */
			emittedResultOverride: undefined as AgentToolResult<any> | undefined,
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
				progressProtocol: record.progressProtocol,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
			progressProtocol: record.progressProtocol,
		});

		// One-way bridge to the LLM wire: `outcome` is authoritative
		// when the producer set one, since a migrated producer is not obliged to keep
		// its legacy `isError` bit consistent with it (e.g. a timed-out process is a
		// failed outcome that may render with a softer border, but is still a wire
		// failure). An unmigrated producer has no `outcome`, so `wireIsError` falls
		// back to the same `isError` this function always used — nothing regresses.
		// This is a bridge, not a dual authority: no presentation-facing code may
		// read `ToolResultMessage.isError` back as a failure signal (that's
		// `AgentToolResult.isError`/`outcome`'s job via `toolResultFailed`).
		const wireIsError = result.outcome !== undefined ? outcomeFailed(result.outcome) : isError;
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			providerMetadata: result.providerMetadata,
			isError: wireIsError,
			...(result.useless && !wireIsError ? { useless: true } : {}),
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
			const validationFailureDetails: ValidationFailureToolResultDetails = {
				isError: true,
				error: record.validationErrorMessage,
			};
			emitToolResult(
				record,
				{
					content: [{ type: "text" as const, text: record.validationErrorMessage }],
					details: validationFailureDetails,
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
		// Argument transformation happens *before* protocol selection, because it can
		// change the route: a transform that flips `pty`/`async`/`timeout` would
		// otherwise have the dispatcher select the presentation protocol for a route the
		// tool never takes, leaving its output with no channel at all (the presentation
		// arm passes no `onUpdate`). The throw is deferred to the execution block below so
		// a failing transform still becomes the same error result it always did.
		//
		// Public and execution views never share a mutable object graph. The execution
		// copy is always a deep clone of the validated public arguments — even on the
		// no-transform path — so a `selects()` implementation or transform that mutates
		// `params.nested.value` corrupts only its own copy, never the public object that
		// `start()`, `tool_execution_start`, and `tool_execution_update` all read.
		// `structuredClone` is used rather than JSON parse/stringify because arguments are
		// model-authored JSON values (no functions, Dates, or other non-JSON types).
		// The hook boundary validates JSON-ness before this point, so a clone failure
		// here is a genuine internal error, not a contract violation — it becomes a
		// deterministic tool failure via `transformError`, never a silent "skipped".
		let transformError: unknown;
		let cloneFailed = false;
		let executionArgs: Record<string, unknown>;
		try {
			executionArgs = structuredClone(effectiveArgs);
		} catch (cloneError) {
			// Should not happen: the hook boundary rejects non-JSON values, and
			// model-authored args are JSON. If it does, surface as a tool failure.
			// Do NOT alias `effectiveArgs` into `executionArgs` — the transform or
			// presentation selector below would mutate the public graph before the
			// deferred failure surfaces, recreating the secret-leak path this
			// boundary was introduced to eliminate. Use an empty object and skip
			// transform/selection entirely; the `transformError` ensures the call
			// becomes a deterministic tool failure in the execution block.
			transformError = cloneError;
			cloneFailed = true;
			executionArgs = {};
		}
		if (!cloneFailed && transformToolCallArguments) {
			try {
				executionArgs = transformToolCallArguments(executionArgs, toolCall.name);
			} catch (error) {
				transformError = error;
			}
		}

		const pushPresentation = (event: ToolPresentationEvent): void => {
			stream.push({
				type: "tool_presentation",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				event,
			});
		};
		const emitLegacyUpdate = (partialResult: AgentToolResult<unknown>): void => {
			stream.push({
				type: "tool_execution_update",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				// Pre-transform arguments, matching `tool_execution_start`: this event reaches
				// the same ACP mapper title/location derivation, and `executionArgs` may carry
				// a host transform's deobfuscated secrets.
				args: effectiveArgs,
				partialResult: coerceToolResult(partialResult).result,
			});
		};
		const buildToolContext = (
			progress: ToolProgressProtocol<AgentToolResult<unknown>>,
		): AgentToolContext | undefined =>
			getToolContext
				? getToolContext({
						batchId,
						index,
						total: toolCalls.length,
						toolCalls: toolCallInfos,
						steeringSignal: steeringSoftController.signal,
						providerMetadata: toolCall.providerMetadata,
						progress,
					})
				: undefined;

		// Protocol selection happens here, before the start event, because the event
		// declares which protocol the call runs on and a consumer must be able to trust
		// that declaration from the first frame. A throwing selector falls back to legacy
		// rather than losing the call's progress entirely.
		const adapter = tool === undefined ? undefined : tool.presentation;
		let call: ToolCallPresentation | undefined;
		let producer: ToolPresentationStream | undefined;
		let toolContext: AgentToolContext | undefined;
		if (adapter !== undefined && tool !== undefined && !cloneFailed) {
			try {
				// Build the whole presentation prerequisite set *before* asking the adapter
				// whether it wants the protocol: the producer, and the host context the tool
				// will actually receive. `selects` needs that context — a route can depend on
				// it (bash's PTY route needs `ctx.hasUI`/`ctx.ui`), and calling `selects` with
				// `undefined` made it judge a route the tool would not take.
				const candidate = new ToolPresentationStream(streamId(toolCall.id), pushPresentation);
				const candidateContext = buildToolContext({ kind: "presentation_events", presentation: candidate });
				// Reachability is verified, never assumed. The producer can only arrive
				// through the host-built `AgentToolContext`, and a host may legitimately
				// build one without `toolCall` (or provide no `getToolContext` at all, as a
				// standalone `Agent` does). Selecting the presentation protocol there would
				// leave the call with no progress channel whatsoever, since the presentation
				// arm deliberately passes no `onUpdate`.
				if (presentationProducerOf(candidateContext?.toolCall?.progress) !== candidate) {
					logger.warn("Host tool context does not carry the presentation producer; using the legacy protocol", {
						toolName: toolCall.name,
					});
				} else {
					const selection = adapter.selects.call(tool, executionToolArguments(executionArgs), candidateContext);
					const selected =
						selection === true ||
						(typeof selection === "object" && selection !== null && selection.kind === "presentation_events");
					if (selected) {
						// `start` can throw on malformed input, so the descriptor is part of the
						// prerequisite set too: a declared protocol is always an announced call.
						// Public, pre-transform arguments only: `title`/`sourceEcho`/`rawInput` all
						// flow onto a client-visible surface, and `executionArgs` may carry a host
						// transform's deobfuscated secrets.
						call = adapter.start.call(
							tool,
							toolCall.id,
							publicToolArguments(effectiveArgs),
							selection === true ? undefined : selection.routing,
						);
						producer = candidate;
						toolContext = candidateContext;
					}
				}
			} catch (error) {
				// A selector or descriptor builder that throws is a presentation bug, not a
				// reason to lose the call: fall back to legacy, which renders through the
				// `tool_execution_*` pair the consumer still receives either way.
				logger.warn("Tool presentation setup threw; falling back to the legacy protocol", {
					toolName: toolCall.name,
					error,
				});
				call = undefined;
				producer = undefined;
				toolContext = undefined;
			}
		}

		// One announcement, one declaration, from the same decision. Because the
		// descriptor and the reachable producer both exist by now, a call declared
		// `presentation_events` is always announced — the earlier order could declare the
		// protocol on `tool_execution_start` and then throw building the descriptor,
		// leaving a call the ACP layer skips on the legacy path and never sees on the new
		// one.
		const activeProducer = producer;
		const legacyUpdate = activeProducer === undefined ? emitLegacyUpdate : undefined;
		if (activeProducer === undefined)
			toolContext = buildToolContext({ kind: "legacy_snapshot", update: emitLegacyUpdate });
		record.started = true;
		record.progressProtocol = activeProducer === undefined ? "legacy_snapshot" : "presentation_events";
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: effectiveArgs,
			intent: toolCall.intent,
			progressProtocol: record.progressProtocol,
		});
		if (activeProducer !== undefined && call !== undefined) {
			// The loop is the sole emitter of `started`; the producer handle cannot.
			pushPresentation({ type: "started", call });
		}

		let result: AgentToolResult<any> = { content: [], details: {} };
		let isError = false;
		let caughtError: unknown;
		let completedToolExecution = false;
		let executionStarted = false;
		let settlementEmitted = false;
		// The result actually emitted to history, once known, when it differs from
		// `result` above — the steering-interrupt/lifecycle-rejection tail decisions
		// below override `result` with a synthesized `createSkippedToolResult`
		// placeholder *after* settlement already ran (a real, previously-shipped bug:
		// `modelContent` snapshotted the pre-override `result`, so the persisted
		// frozen model projection disagreed with the `ToolResultMessage` that
		// actually entered history). Computed once, exactly where each override
		// decision is made, and stored on `record.emittedResultOverride` (not a
		// local variable — see its own doc comment) rather than recomputed a second
		// time: recomputing `createSkippedToolResult` from `interruptState.source` a
		// second time after `settlePresentation`'s awaits — or, for the
		// lifecycle-rejection path, from the *outer* tail sweep in a different
		// function entirely — could observe a source that changed concurrently.

		/**
		 * The one settlement owner for an announced presentation call.
		 *
		 * Called from `finally`, so *every* way out of the block below settles exactly
		 * once: normal return, timeout, user abort, executor throw, `afterToolCall`
		 * failure, a telemetry span constructor that throws, and a failure while deriving
		 * the outcome itself. Before this existed, `startExecuteToolSpan()` or
		 * `adapter.outcome()` throwing left an announced call with no `settled` event at
		 * all: the ACP layer skips the legacy `tool_execution_end` for a
		 * presentation-protocol call, so the card stayed "running" forever.
		 */
		const settlePresentation = async (
			lifecycleError?: unknown,
			resultOverride?: AgentToolResult<any>,
		): Promise<void> => {
			if (activeProducer === undefined || settlementEmitted) return;
			settlementEmitted = true;
			// The flush-before-settlement barrier. A throttled `OutputSink` chunk is only
			// registered as a flusher, so `dispose()` would clear its timer without ever
			// emitting it. Nothing may append after this point, which the producer enforces
			// irrevocably — including when a flusher itself throws.
			try {
				await activeProducer.freeze();
			} catch (error) {
				logger.warn("Tool presentation freeze failed", { toolName: toolCall.name, error });
			}
			let outcome: ToolOutcome;
			try {
				outcome = deriveToolOutcome({
					result,
					isError,
					caughtError: caughtError ?? lifecycleError,
					completedToolExecution,
					// Any abort that left the call without a result is an interruption, not a
					// defect. ACP `session/cancel` aborts the tool signal without touching the
					// steering/IRC `interruptState`, so requiring `interruptState.triggered`
					// classified every user cancellation as a thrown failure.
					interrupted: abortedDuringExecution,
					interruptReason: abortReasonText(record.signal),
				});
			} catch (error) {
				// Deriving presentation data must not be able to swallow the settlement: a
				// typed synthetic failure is strictly better than a card that never resolves.
				logger.error("Tool outcome derivation threw; settling with a synthetic failure", {
					toolName: toolCall.name,
					error,
				});
				outcome = {
					kind: "failed",
					failure: { reason: "internal", message: error instanceof Error ? error.message : String(error) },
				};
			}
			// `resultOverride` is the exact content the caller already knows will be
			// (or already was) emitted to history in place of `result` — see the
			// `emittedResultOverride` doc comment above for why this must never be
			// re-derived independently of that decision.
			pushPresentation({
				type: "settled",
				outcome,
				modelContent: toolModelContentOf((resultOverride ?? result).content),
			});
			try {
				await config.afterPresentationSettlement?.(toolCall.id);
			} catch (error) {
				logger.warn("Tool presentation settlement barrier failed", { toolName: toolCall.name, error });
			}
			try {
				activeProducer.runAfterSettlementCallbacks();
			} catch (error) {
				logger.error("Tool presentation after-settlement callback threw", { toolName: toolCall.name, error });
			}
		};

		let interrupted = false;
		let perToolAborted = false;
		let abortedDuringExecution = false;
		// Declared outside the lifecycle block because `finishExecuteToolSpan` below
		// still has to close it on every path.
		let toolSpan: Span | undefined;

		try {
			toolSpan = startExecuteToolSpan(telemetry, {
				tool,
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				args: effectiveArgs,
				parent: invokeAgentSpan,
			});
			if (toolSpan && toolCall.intent) {
				toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
			}

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
					// Deferred from the pre-announcement transform so the route decision could
					// see the real arguments; the error surfaces exactly where it used to.
					if (transformError !== undefined) throw transformError;
					record.args = executionArgs;

					// The cooperative steering signal rides the loop-owned
					// ToolCallContext (surfacing as `ctx.toolCall.steeringSignal`):
					// AgentToolContext itself is app-built via declaration merging, so
					// the loop cannot construct or extend one structurally. That is also why the
					// presentation producer's reachability through it is verified above rather
					// than assumed.
					//
					// One callback object, surfaced through the protocol union and (on the legacy
					// arm only) as the tool's `onUpdate` parameter. On the presentation arm
					// `onUpdate` is `undefined`, so a migrated route cannot emit a cumulative
					// snapshot beside its direct append events.
					executionStarted = true;
					const rawResult = await tool.execute(
						toolCall.id,
						executionArgs,
						record.signal,
						legacyUpdate,
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
						const effect = await afterToolCall(
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
						if (effect && effect.kind !== "unchanged") {
							// Re-normalize the post-hook result: `afterToolCall` is untyped user/extension
							// code and its effect's payload may be malformed (a raw external object, or a
							// guidance fact prepended onto invalid content), which would otherwise be
							// persisted verbatim and corrupt the session — the same hazard
							// `coerceToolResult` guards on the execute path.
							const raw =
								effect.kind === "transform_external_result"
									? effect.raw
									: {
											content: [{ type: "text" as const, text: effect.fact.text }, ...result.content],
											details: result.details,
											isError: result.isError,
											providerMetadata: result.providerMetadata,
											useless: result.useless,
											...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
										};
							const coerced = coerceToolResult(raw);
							result = coerced.result;
							isError = coerced.malformed || result.isError === true;
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

			interrupted = interruptState.triggered;
			perToolAborted = record.signal.aborted;
			abortedDuringExecution = perToolAborted && isError && !completedToolExecution;
			// Compute the steering-interrupt override, if any, *before* settling: this
			// is the exact placeholder `emitToolResult` will use below in place of
			// `result` when the call aborted without producing one of its own, so
			// `modelContent` must reflect it instead of the pre-override `result`.
			if (interrupted && abortedDuringExecution)
				record.emittedResultOverride = createSkippedToolResult(interruptState.source, executionStarted);
			await settlePresentation(undefined, record.emittedResultOverride);
		} catch (lifecycleError) {
			// Everything from the telemetry span onwards is inside the lifecycle owner, so a
			// scaffolding failure still settles the announced call before it propagates to
			// the tail sweep that emits the tool result. `emitToolResult` is never reached on
			// this path (the rethrow below skips it), so the top-level tail sweep after
			// `Promise.allSettled` is the ONE place this record's result gets emitted — always
			// `createSkippedToolResult(interruptState.source, false)` (line ~3128). Stored on
			// `record.emittedResultOverride` (not a local variable) so that *other* function's
			// tail sweep reuses this exact value instead of recomputing it — a recomputation
			// there could observe a `source` a concurrent steering watcher changed while this
			// call's own `settlePresentation` awaits were in flight, producing a placeholder
			// that disagrees with what was just frozen into `modelContent`.
			record.emittedResultOverride = createSkippedToolResult(interruptState.source, false);
			await settlePresentation(lifecycleError, record.emittedResultOverride);
			throw lifecycleError;
		} finally {
			// Belt and braces for any future early return: settlement is idempotent.
			await settlePresentation(undefined, record.emittedResultOverride);
		}

		if (interrupted && abortedDuringExecution) {
			// This tool's own signal fired AND it failed to produce a result. The
			// execution may already have performed partial work before throwing on
			// abort, so preserve that distinction in the placeholder metadata.
			record.skipped = true;
			emitToolResult(
				record,
				record.emittedResultOverride ?? createSkippedToolResult(interruptState.source, executionStarted),
				true,
			);
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
			// Reuse the exact placeholder `runTool`'s own lifecycle-rejection `catch`
			// block already stored on the record and settled with — never recompute
			// `createSkippedToolResult` independently here, in a different function,
			// after `settlePresentation`'s awaits may have let `interruptState.source`
			// change concurrently (see `emittedResultOverride`'s doc comment). Records
			// that never reached `runTool`'s try block at all (the very-early
			// `interruptState.triggered` return before any settlement) have no stored
			// override, so this is the one place that fallback computation belongs.
			emitToolResult(
				record,
				record.emittedResultOverride ?? createSkippedToolResult(interruptState.source, false),
				true,
			);
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
 * The agent loop's own result for a tool call whose arguments failed schema
 * validation before dispatch (`runTool`'s `record.validationErrorMessage`
 * branch). Named and exported so consumers that must parse it back out of a
 * legacy `details` blob — e.g. the ACP presentation seam's
 * `validationFailureDetailsSchema` — are pinned to this exact producer shape
 * rather than re-declaring it by hand and risking drift.
 */
export interface ValidationFailureToolResultDetails {
	isError: true;
	error: string;
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
