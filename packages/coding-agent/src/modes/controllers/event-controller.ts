import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { batch, isSettled, type Signal, signal } from "@oh-my-pi/pi-tui";
import { notifyTerminal } from "@oh-my-pi/pi-tui/driver/session";
import { formatDuration, isRecord, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD, toolIntentLabel } from "@oh-my-pi/pi-wire";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { WakeSources } from "../../session/agent-session-events";
import {
	isSilentAbort,
	isUserInterruptAbort,
	isUserInvokedSkillPrompt,
	isUserTurnInitiator,
	readQueueChipText,
	resolveAbortLabel,
	USER_INTERRUPT_LABEL,
} from "../../session/messages";
import { detectCacheInvalidation } from "../../session/transcript/cache-invalidation-marker";
import { assistantMessageLinkTargets, refreshAssistantMessageLinkTargets } from "../../session/transcript/link-targets";
import {
	groupedReadUsageCallIds,
	readArgsCollapseIntoGroup,
	readArgsHaveTarget,
} from "../../session/transcript/read-tool-group";
import { isReplyWrite, replyDisplayMessage, toolResultReplies } from "../../session/transcript/reply-write";
import { canonicalizeMessage } from "../../session/transcript/thinking-display";
import {
	asyncJobState,
	isSettledJobFrame,
	parksAsBackground,
	readMediaPath,
	settleWithJobFrame,
	toolRenderName,
} from "../../session/transcript/tool-execution";
import { textContent } from "../../session/transcript/transcript-entry";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../../session/transcript/transcript-render-helpers";
import type { NotificationRule } from "../../session/transcript/ttsr-notification";
import { PROPOSE_COMMAND_NAME } from "../../tools/details/resolve";
import type { TodoPhase } from "../../tools/details/todo";
import { proposeDispatchDetails } from "../../tools/resolve";
import { cfgSpeechEnabled, cfgSpeechMode } from "../../tts/settings";
import { SpeechEnhancer } from "../../tts/speech-enhancer";
import { vocalizer } from "../../tts/vocalizer";
import type { TranscriptBlock } from "../../ui/shell";
import { toolEditMode } from "../../ui/tools/edit";
import { PREVIEW_LIMITS, previewLine, TRUNCATE_LENGTHS } from "../../utils/render-utils";
import { type RunFlowStatus, setRunStatus } from "../../utils/run-status";
import {
	cfgCompletionNotify,
	cfgDisplayCacheMissMarker,
	cfgDisplayShowTokenUsage,
	cfgDisplayShowTurnTime,
	cfgDisplaySmoothStreaming,
	cfgErrorNotify,
	cfgTerminalShowImages,
	cfgTerminalShowProgress,
} from "../settings";
import type { AssistantView, InteractiveModeContext, PendingTool } from "../types";
import { displaceableBy } from "../utils/displaceable";
import { TurnUsageTally, turnElapsedMs } from "../view-model/overlays/usage-row";
import { isWarpCliAgentProtocolActive } from "../warp-events";
import { ComposerPredictionController } from "./composer-prediction-controller";
import { recapBlock, todoReminderBlock, ttsrBlock, usageRowBlock } from "./event-blocks";
import { StreamingRevealController } from "./streaming-reveal";
import { streamingStringKeysForTool, ToolArgsRevealController } from "./tool-args-reveal";

type AgentSessionEventKind = AgentSessionEvent["type"];

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
/**
 * Concurrent IRC cards allowed in the transcript's live region. Cards land
 * below a still-live block (a running task), where they cannot commit to
 * native scrollback (commits are prefix-only) — every visible card inflates
 * the live region and pushes the live block's uncommitted rows above the
 * window top, where they are neither on screen nor in history. A swarm burst
 * (several agents coordinating at once) must therefore stay bounded: the
 * oldest live-region card retires as soon as a new one would exceed the cap.
 */
const MAX_LIVE_IRC_CARDS = 4;

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = {
	bash: true,
	edit: true,
	apply_patch: true,
};

function hasCommittedTodo(events: unknown): boolean {
	return (
		Array.isArray(events) && events.some(event => isRecord(event) && event.op === "todo" && event.committed === true)
	);
}

/** Eval status events live on each cell. */
function hasNestedTodo(details: unknown): boolean {
	if (!isRecord(details)) return false;
	return (
		Array.isArray(details.cells) && details.cells.some(cell => isRecord(cell) && hasCommittedTodo(cell.statusEvents))
	);
}

interface AsyncResultJob {
	jobId?: string;
	type?: string;
	label?: string;
	durationMs?: number;
}

/**
 * Toast text for an `async-result` delivery whose jobs are all background
 * task spawns, or undefined when it is anything else (bash jobs keep their
 * transcript rows). Native rendering only: the task call's agent nodes carry
 * the outcome, so the delivery needs no transcript block of its own.
 */
function nativeTaskJobToast(message: { role: string; customType?: string; details?: unknown }): string | undefined {
	if (message.role !== "custom" || message.customType !== "async-result" || !isRecord(message.details)) return;
	const details = message.details as AsyncResultJob & {
		jobs?: AsyncResultJob[];
	};
	const jobs = details.jobs && details.jobs.length > 0 ? details.jobs : [details];
	if (!jobs.every(job => job.type === "task")) return;
	if (jobs.length > 1) return `${jobs.length} background tasks completed`;
	const job = jobs[0]!;
	const name = sanitizeText(job.label ?? job.jobId ?? "task").trim() || "task";
	const took = typeof job.durationMs === "number" ? ` · ${formatDuration(job.durationMs)}` : "";
	return `Background task ${name} completed${took}`;
}

function exposesRawPartialJson(toolName: string, rawInput: boolean, tool: unknown): boolean {
	if (rawInput) return true;
	if (RAW_PARTIAL_JSON_RENDERERS[toolName]) return true;
	if (tool === null || typeof tool !== "object" || !("renderCall" in tool)) return false;
	return typeof tool.renderCall === "function";
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};
interface ApprovalPreviewGate {
	promise: Promise<void>;
	resolve(): void;
	reject(reason?: unknown): void;
	started: boolean;
}

/** `value` as plan approval details, when it has their shape. */
function planApprovalDetails(value: unknown): PlanApprovalDetails | undefined {
	if (
		value &&
		typeof value === "object" &&
		"planFilePath" in value &&
		"title" in value &&
		"planExists" in value &&
		typeof value.planFilePath === "string" &&
		typeof value.title === "string" &&
		typeof value.planExists === "boolean"
	) {
		return {
			planFilePath: value.planFilePath,
			title: value.title,
			planExists: value.planExists,
		};
	}
	return undefined;
}

/**
 * Working-line text for a streamed tool intent, or `undefined` when unusable.
 * Streamed JSON can deliver non-string `i` (object, number, boolean) before
 * schema validation, so the type is guarded too.
 */
function normalizeIntent(intent: unknown): string | undefined {
	if (typeof intent !== "string") return undefined;
	return (
		intent
			.trim()
			.replace(/\s*\.+$/, "")
			.trim() || undefined
	);
}

function workingIntentLabel(intent: unknown): string | undefined {
	return typeof intent === "string" ? normalizeIntent(toolIntentLabel(intent)) : undefined;
}

/** Ids per kind the awaiting working row lists before collapsing the rest to `+N`. */
const ASYNC_WAIT_LISTED_IDS = 3;

function describeWaitedIds(ids: readonly string[], noun: string): string | undefined {
	if (ids.length === 0) return undefined;
	if (ids.length === 1) return `${noun} ${ids[0]}`;
	const listed = ids.slice(0, ASYNC_WAIT_LISTED_IDS).join(", ");
	const more = ids.length > ASYNC_WAIT_LISTED_IDS ? ` +${ids.length - ASYNC_WAIT_LISTED_IDS}` : "";
	return `${ids.length} ${noun}s: ${listed}${more}`;
}

/**
 * Working-row text while a paused run waits only on outside sources (background
 * jobs, child agents, queued results or peer messages); short enough for a
 * narrow terminal.
 */
function formatAsyncWaitLabel(sources: WakeSources | undefined): string {
	const parts = [
		describeWaitedIds(sources?.jobs ?? [], "background job"),
		describeWaitedIds(sources?.agents ?? [], "agent"),
	].filter(part => part !== undefined);
	if (parts.length > 0) return `Waiting for ${parts.join("; ")}`;
	return sources?.queued ? "Delivering queued results" : "Waiting for background work";
}

/** Render args for a live card: the harness strips `i` from executed args, but the stored block keeps it. */
function renderArgsWithIntent(args: unknown, intent: string | undefined): unknown {
	if (intent === undefined || !isRecord(args) || INTENT_FIELD in args) return args;
	return { ...args, [INTENT_FIELD]: intent };
}

/** Identity of a reply across retries: when it was sent, by which model, how it ended. */
function messagePersistenceKey(view: AssistantView): string | undefined {
	const message = view.message.peek();
	if (!message) return undefined;
	return [
		"assistant",
		message.timestamp,
		message.provider,
		message.model,
		message.responseId ?? "",
		message.stopReason,
	].join(":");
}

/** Merge rules into a TTSR list, deduped by name. */
function mergeRules(rules: readonly NotificationRule[], added: readonly NotificationRule[]): NotificationRule[] {
	const merged = [...rules];
	for (const rule of added) if (!merged.some(existing => existing.name === rule.name)) merged.push(rule);
	return merged;
}

export class EventController {
	#lastReadGroup: PendingTool | undefined = undefined;
	/** Read groups closed to new reads whose block settles once their last pending read lands. */
	#closedReadGroups = new Set<PendingTool>();
	/** Edit-like cards still computing the diff preview an approval dialog waits for, by call id. */
	#previewPending = new Map<string, PromiseWithResolvers<void>>();
	/** Timestamp of the current turn's user prompt; drives the usage row's prompt→yield delta. */
	#turnStartedAt: number | undefined = undefined;
	/** The running turn's token and cost totals, shown under its last answer on a TSP terminal. */
	readonly #turnUsage = new TurnUsageTally();
	/** When the last completed run ended; stale `#turnStartedAt` anchors are cleared against it. */
	#lastAgentEndAt: number | undefined = undefined;
	// Count of visible assistant content blocks (rendered non-empty text/thinking)
	// already seen in the current streaming message. A newly appearing one breaks
	// the read run: the rendered reasoning/answer is a visual separator, so reads
	// after it start a fresh group. Empty/absent thinking — common when a model
	// emits one read per completion — does not break it, so a run of consecutive
	// reads collapses into one group even across completion boundaries.
	#lastVisibleBlockCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	/** Returned calls parked for their background job's frames ({@link parksAsBackground}). */
	#backgroundCallIds = new Set<string>();
	/**
	 * A job's settled frame ({@link isSettledJobFrame}) that landed while its
	 * call was still executing, keyed by call id: a fast job can settle before
	 * the call's `tool_execution_end` carries its `running` start result.
	 */
	#settledBeforeReturn = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();
	#approvalPreviewGates = new Map<string, ApprovalPreviewGate>();
	#pendingStreamPreviews = new Map<string, unknown>();
	#detachToolApprovalPreviewWaiter: (() => void) | undefined;
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantView>();
	#toolTimelineComponents = new Map<string, PendingTool>();
	// Stable identity for a streamed tool call while its assistant message is
	// live: maps the tool-call block's position in the streaming message to the
	// id last seen at that position. A streamed id can CHANGE across cumulative
	// `message_update`s — some providers (GitHub Copilot's `call_id|id`
	// transport, any stream that delivers name/args before the id) emit the
	// block with an empty or partial id first and rewrite it in a later delta
	// (openai-completions sets `id: toolCall.id || ""` then overwrites on the
	// next chunk). Keyed only by id, the changed id reads as a brand-new call
	// and a second card is created — the old-id card orphans as a pending
	// preview while the new-id card takes the result (#6879). Reset per assistant
	// message (indices are per-message).
	#streamedToolCallIdByIndex = new Map<number, string>();
	// A TTSR rewind retracts its uncommitted never-run cards at message_end;
	// retain their ids until agent-loop's synthetic tool_execution_start/end for
	// those calls arrive so the normal no-pending path cannot recreate the
	// retracted card below the rewind's fresh blocks (#6879).
	#retractedToolCallIds = new Set<string>();
	#executionStartedCallIds = new Set<string>();
	// Settled tool cards from the turn that just ended, keyed by call id. A
	// repeated toolCallId in the next run can only be a tool-replay retry
	// (AgentSession.retry re-executing a stripped failed batch);
	// #handleToolExecutionStart evicts the stale aborted card so the fresh
	// execution replaces it in the transcript instead of stacking a duplicate.
	#priorTurnToolComponents = new Map<string, PendingTool>();
	// Cards settled by a synthetic aborted/error `tool_execution_end` (agent-loop
	// emits one per never-run call on a terminal error/abort). They stay visible
	// for a genuinely terminal failure, but if an auto-retry then supersedes the
	// turn (`auto_retry_start`, decided AFTER message_end) they must be removed so
	// the retry's fresh cards do not render the same call twice (Codex review on
	// #6881). Keyed by call id; reset per turn.
	#syntheticFailureCards = new Map<string, PendingTool>();
	// Completions can outrun their streamed tool-call block: server-resolved
	// tools may finish synchronously, and any sufficiently fast tool can settle
	// before the UI dispatch creates its card. Hold the result
	// so the eventual card finalizes instead of pinning transcript retirement.
	// User-facing side effects run only on first arrival; only the component
	// update is deferred. Call ids are unique per turn, and this map is cleared
	// with the other transcript anchors.
	#orphanedToolCompletions = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>();
	#postToolAssistantComponents = new Map<string, AssistantView>();
	/** Reply blocks drawn per call from its frames' `details.replies`, in order; the count dedupes repeated frames. */
	#toolReplyBlocks = new Map<string, AssistantView[]>();
	#lastAssistantComponent: AssistantView | undefined = undefined;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantView | undefined = undefined;
	#pinnedErrorMessage: AssistantMessage | undefined = undefined;
	#restorePinnedErrorInline = true;
	#retrySupersededAssistantComponents = new Map<string, AssistantView>();
	#retrySupersededAssistantQueue: AssistantView[] = [];
	// Set when `auto_retry_start` fires and cleared by `auto_retry_end` (both
	// outcomes) — true for exactly the window a retry is outstanding. Gates
	// `sendErrorNotification`: the wire-level `agent_end` for a retryable
	// failure is coalesced with every other attempt in the same saga while the
	// prompt is in flight (see `AgentSession#emitSessionEvent`), so the single
	// `agent_end` that survives to reach this controller can be either a
	// mid-retry blip or the final settle — only the retry lifecycle events
	// (never deferred) can tell them apart.
	#retryPending = false;
	/** Next-message prediction offered as composer ghost text after a completed turn. */
	readonly composerPrediction: ComposerPredictionController;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// blocks each card contributed (see #retireIrcCard for the guard).
	#liveIrcCards = new Map<string, TranscriptBlock[]>();
	// Most recent `wait` tool block whose result still had every watched job
	// running. Kept un-finalized (live) so the next `wait` call displaces it —
	// one persistent poll instead of a stack of "waiting on N jobs" frames —
	// and sealed in place the moment anything else lands below it.
	#displaceablePollComponent: PendingTool | undefined = undefined;
	// Most recent successful `todo` snapshot in the active turn. Its block settles like any final
	// card: a live one would hold every later block out of terminal scrollback. A later `todo`
	// update removes it while none of its rows reached scrollback, else seals it in place; the
	// turn boundary seals the final snapshot.
	#displaceableTodoComponent: PendingTool | undefined = undefined;
	// Most recent TTSR notification block. A new ttsr_triggered event merges its
	// rules into this block while it is still the (live-region) transcript tail.
	#lastTtsrNotification:
		| {
				readonly block: TranscriptBlock;
				readonly rules: Signal<readonly NotificationRule[]>;
		  }
		| undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	/**
	 * Whether the running auto-compaction turned terminal progress on itself.
	 * Only then does its end turn progress off: a compaction inside a live turn
	 * leaves the turn's progress for that turn's `agent_end`, so Tern (which
	 * reads progress as busy state) never sees the agent stop mid-run.
	 */
	#compactionOwnsProgress = false;
	/**
	 * The working row names what a paused run awaits instead of the last intent,
	 * until the next loop starts or the run ends.
	 */
	#showingAsyncWait = false;
	/**
	 * The user ended a wait on outside work ({@link stopAwaitingAsyncWork}): the
	 * run's next `agent_end` is a user interrupt, though its messages are the
	 * last loop's normal yield.
	 */
	#stoppedWaiting = false;
	// Coalescing window for `message_update` events at the subscription boundary.
	// `message_update` carries the CUMULATIVE assistant message (every update
	// re-lists all content blocks), so when a burst of deltas arrives faster than
	// this window only the latest snapshot needs to rebuild streaming state — the
	// intermediate rebuilds are redundant work. The TUI already caps the paint
	// rate via its own render cadence; this caps the per-token handler work that
	// feeds it. Speech stays intact: `#vocalizeDelta` runs at ARRIVAL for every
	// delta before the snapshot is coalesced away.
	#pendingMessageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> | undefined = undefined;
	// Provider replay resets are not cumulative: retain the boundary even when
	// the empty restart snapshot is replaced by a later delta before painting.
	#pendingMessageRestart = false;
	#messageUpdateTimer: NodeJS.Timeout | undefined = undefined;
	/** Tail of the serialized dispatch chain; see #runSerialized. */
	#dispatchTail: Promise<void> = Promise.resolve();
	/** Whether a chained run is currently in flight (awaiting its own awaits). */
	#dispatchInFlight = false;
	#dispatchGeneration = 0;
	// Deltas already fed to speech at arrival by the coalescer. `#handleMessageUpdate`
	// also vocalizes so the direct `handleEvent` path (tests, session focus replay)
	// keeps working — the WeakSet makes the coalesced path speak each delta exactly
	// once instead of twice.
	#vocalizedMessageUpdates = new WeakSet<object>();
	static readonly #MESSAGE_UPDATE_COALESCE_MS = 33;

	constructor(private ctx: InteractiveModeContext) {
		// Enhanced speech (`speech.enhanced`) rewrites blocks through the
		// tiny/smol role with this session's registry and credentials; the
		// vocalizer falls back to mechanical cleanup when unset. Tolerates
		// partial contexts (tests, minimal embeddings) by wiring null.
		const session = ctx.session;
		this.#detachToolApprovalPreviewWaiter = session?.extensionRunner?.setToolApprovalPreviewWaiter(toolCallId =>
			this.#waitForToolApprovalPreview(toolCallId),
		);
		vocalizer.setModelSource(
			session?.modelRegistry && session.settings
				? {
						settings: session.settings,
						registry: session.modelRegistry,
						getSessionProvider: () => session.model?.provider,
					}
				: null,
		);
		vocalizer.setEnhancer(
			session?.modelRegistry && session.agent && session.settings
				? new SpeechEnhancer({
						settings: session.settings,
						registry: session.modelRegistry,
						sessionId: session.sessionId,
						metadataResolver: provider => session.agent.metadataForProvider(provider),
						getSessionProvider: () => session.model?.provider,
						usageLedger: session.sessionManager,
					})
				: null,
		);
		this.#streamingReveal = new StreamingRevealController({
			// Extension text renderers get the full text so far on each drawn update (deltas within one
			// frame are coalesced), never a partly revealed prefix from the typing reveal. A terminal that
			// paces streamed `md` itself (Tern) gets the text as it arrives: pacing it here too is wasted work.
			getSmoothStreaming: () =>
				cfgDisplaySmoothStreaming.get(this.ctx.settings) &&
				!this.ctx.shell.native() &&
				!this.ctx.viewSession.extensionRunner?.getAssistantTextRenderers?.().length,
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => cfgDisplaySmoothStreaming.get(this.ctx.settings),
		});
		this.composerPrediction = new ComposerPredictionController(ctx);
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_pause: e => this.#handleAgentPause(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async e => this.#handleTurnEnd(e),
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_stream_update: async event => {
				const tool = this.ctx.pendingTools.get(event.toolCallId);
				if (tool) {
					tool.updateStreamPreview(event.update);
					this.#notePreviewUpdate(event.toolCallId, event.update);
				} else {
					this.#pendingStreamPreviews.set(event.toolCallId, event.update);
				}
			},
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			// `/compact` drives its own loader (command-controller); these exist for RPC hosts.
			manual_compaction_start: async () => {},
			manual_compaction_end: async () => {},
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			// The cache details show a refresh in flight; its hit moves the entry's expiry, a miss turns it cold.
			cache_warming_start: async () => {
				this.ctx.statusLine.refresh();
			},
			cache_warming_end: async () => {
				this.ctx.statusLine.refresh();
			},
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			model_changed: async () => {
				vocalizer.enforceProviderPolicy();
				this.ctx.statusLine.refresh();
			},
			// Header rebuild is owned by InteractiveMode's own session
			// subscription (mirrors model_changed); nothing to do here.
			config_warnings_changed: async () => {},
			advisor_cost_changed: async () => {
				this.ctx.statusLine.refresh();
			},
			advisor_yielded: async () => {
				// The advisor finished reviewing the yielded primary turn (no more
				// comments coming): the closed-eye state lands.
				this.ctx.statusLine.refresh();
			},
			thinking_level_changed: async () => {
				this.ctx.statusLine.refresh();
				this.ctx.updateEditorBorderColor();
				// Rendered replies read the effective visibility reactively; only the
				// running reveal caches it. Auto-classification (e.g. high→medium)
				// emits this without changing visibility.
				const hideThinking = this.ctx.effectiveHideThinkingBlock;
				if (hideThinking === this.#prevHideThinking) return;
				this.#prevHideThinking = hideThinking;
				if (this.ctx.streaming && this.ctx.streamingMessage) this.#streamingReveal.resyncVisibility();
			},
			goal_updated: async () => {},
			// The pending-messages bar mirrors the queue snapshot this event carries.
			// Refreshing only at the TUI's own call sites left pills of messages the
			// agent drained by itself (live steering, a queued batch it delivered)
			// standing above the prompt after they were sent.
			queue_update: async () => {
				this.ctx.updatePendingMessagesDisplay();
			},
		} satisfies AgentSessionEventHandlers;
	}

	/** Surface an idle recap reply in the transcript as a one-line {@link RecapNotice}; a blank reply mounts nothing. */
	presentIdleRecap(reply: string): void {
		const recap = previewLine(reply, TRUNCATE_LENGTHS.RECAP);
		if (recap) this.ctx.present(() => recapBlock(recap));
	}

	dispose(): void {
		this.#detachToolApprovalPreviewWaiter?.();
		this.#detachToolApprovalPreviewWaiter = undefined;
		this.#clearApprovalPreviewGates();
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#pendingMessageRestart = false;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.composerPrediction.cancel();
		this.#setTerminalProgress(false);
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
	}

	/** Close the open read group to new reads; it settles once no read in it is pending. */
	#resetReadGroup(): void {
		const group = this.#lastReadGroup;
		this.#lastReadGroup = undefined;
		if (!group) return;
		this.#closedReadGroups.add(group);
		this.#settleClosedReadGroup(group);
	}

	/** Settle a closed read group whose reads all landed (no call id routes to it any more). */
	#settleClosedReadGroup(group: PendingTool): void {
		if (!this.#closedReadGroups.has(group)) return;
		for (const tool of this.ctx.pendingTools.values()) if (tool === group) return;
		this.#closedReadGroups.delete(group);
		this.ctx.shell.transcript.settle(group.block);
	}

	/** A pending tool left `pendingTools`: a closed read group may now be final. */
	#releasePendingTool(toolCallId: string, tool: PendingTool | undefined): void {
		this.ctx.pendingTools.delete(toolCallId);
		this.#resolvePreview(toolCallId);
		if (tool?.group) this.#settleClosedReadGroup(tool);
	}

	/** A rebuild may replace settled read groups while preserving groups with in-flight reads. */
	reconcileReadGroupAfterRebuild(): void {
		if (this.#lastReadGroup && !this.ctx.shell.transcript.blocks().includes(this.#lastReadGroup.block)) {
			this.#resetReadGroup();
		}
	}

	/** Freeze foreground tool cards once no live agent turn can complete them. */
	#sealAbandonedForegroundTools(): void {
		const background = new Set<PendingTool>();
		for (const toolCallId of this.#backgroundCallIds) {
			const tool = this.ctx.pendingTools.get(toolCallId);
			if (tool) background.add(tool);
		}
		for (const tool of this.#toolTimelineComponents.values()) {
			if ((tool.call || tool.group) && !background.has(tool)) tool.seal();
		}
		for (const [toolCallId, tool] of this.ctx.pendingTools) {
			if (this.#backgroundCallIds.has(toolCallId)) continue;
			tool.seal();
			this.ctx.pendingTools.delete(toolCallId);
			this.#resolvePreview(toolCallId);
		}
		this.#backgroundCallIds = new Set(
			Array.from(this.#backgroundCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
		this.#closedReadGroups.clear();
		this.#finalizeAbandonedPostToolSegments();
	}
	/**
	 * Seal live tool cards no result can reach any more, as a new assistant message opens: a card
	 * no call id routes to, and, when the message is new rather than restored (`fresh`), a streamed
	 * preview from an earlier message whose call never started. One such card at the transcript
	 * frontier blocks history retirement for the rest of the session.
	 */
	#sealOrphanedToolCards(fresh: boolean): void {
		const transcript = this.ctx.shell.transcript;
		const blocks = transcript.blocks();
		const idsByCard = new Map<PendingTool, string[]>();
		for (const [toolCallId, tool] of this.ctx.pendingTools) {
			const ids = idsByCard.get(tool);
			if (ids) ids.push(toolCallId);
			else idsByCard.set(tool, [toolCallId]);
		}
		for (let index = blocks.length - 1; index >= 0 && !transcript.retired(blocks[index]!); index--) {
			const block = blocks[index]!;
			const entry = this.ctx.transcriptEntry(block);
			if (entry?.kind !== "tool" || !entry.tool.call || isSettled(block.node)) continue;
			const card = entry.tool;
			// A card holding its final result is done, not orphaned: a waiting `wait` poll stays
			// live on purpose until the next call replaces it.
			if (card.call?.facts.result() !== undefined && !card.call.facts.partial()) continue;
			const ids = idsByCard.get(card);
			if (ids === undefined) {
				card.seal();
				continue;
			}
			if (!fresh) continue;
			if (ids.some(id => this.#executionStartedCallIds.has(id) || this.#backgroundCallIds.has(id))) continue;
			for (const id of ids) {
				this.#toolArgsReveal.finish(id);
				this.ctx.pendingTools.delete(id);
				this.#resolvePreview(id);
			}
			card.seal();
		}
	}

	/**
	 * Finalize post-tool assistant segments whose `message_end` never fired (a
	 * mid-stream throw or dropped agent_end). They are created live at
	 * `message_update` and finalized only at `message_end`, so a dropped end
	 * leaves one permanently live block — and one live block at the transcript
	 * frontier blocks history retirement. Idempotent for settled segments.
	 */
	#finalizeAbandonedPostToolSegments(): void {
		for (const segment of this.#postToolAssistantComponents.values()) segment.finalized.set(true);
	}

	/**
	 * Reply blocks of calls still executing. Their results are not in the session's committed
	 * messages yet, so a transcript rebuild must carry these over itself; replies of finished
	 * calls are replayed from the persisted results.
	 */
	liveToolReplies(): AssistantView[] {
		const live: AssistantView[] = [];
		for (const toolCallId of this.#executionStartedCallIds) {
			const views = this.#toolReplyBlocks.get(toolCallId);
			if (views) live.push(...views);
		}
		return live;
	}

	/** Draw the replies of a call's frame (`details.replies`, see {@link toolResultReplies}) it has not drawn yet. */
	#showToolReplies(toolCallId: string, details: unknown): void {
		const replies = toolResultReplies(details);
		const shown = this.#toolReplyBlocks.get(toolCallId) ?? [];
		if (replies.length <= shown.length) return;
		for (const text of replies.slice(shown.length)) {
			const view = this.ctx.presentAssistant(replyDisplayMessage(text));
			view.finalized.set(true);
			shown.push(view);
		}
		this.#toolReplyBlocks.set(toolCallId, shown);
	}

	/**
	 * Post-tool text segments of the reply still streaming. The reply is not in the session's
	 * committed messages until `message_end`, so a transcript rebuild must carry these over itself;
	 * segments of replies already committed are replayed instead.
	 */
	liveAssistantSegments(): AssistantView[] {
		const live = this.ctx.viewSession.agent.state.streamMessage;
		if (live?.role !== "assistant") return [];
		const segments: AssistantView[] = [];
		for (const block of live.content) {
			if (block.type !== "toolCall") continue;
			const segment = this.#postToolAssistantComponents.get(block.id);
			if (segment) segments.push(segment);
		}
		return segments;
	}

	/**
	 * The setting enabling extension text renderers changed. Rendered replies pick the renderers up
	 * by themselves; renderers take the full text, so a running typing reveal is dropped.
	 */
	applyAssistantTextRenderers(): void {
		this.#streamingReveal.resyncSmoothStreaming();
	}
	#approvalPreviewGate(toolCallId: string): ApprovalPreviewGate {
		let gate = this.#approvalPreviewGates.get(toolCallId);
		if (!gate) {
			const deferred = Promise.withResolvers<void>();
			gate = { ...deferred, started: false };
			this.#approvalPreviewGates.set(toolCallId, gate);
		}
		return gate;
	}

	async #waitForToolApprovalPreview(toolCallId: string): Promise<void> {
		await this.#approvalPreviewGate(toolCallId).promise;
	}

	#startToolApprovalPreview(toolCallId: string): void {
		const gate = this.#approvalPreviewGate(toolCallId);
		if (gate.started) return;
		gate.started = true;
		const ready = this.#previewPending.get(toolCallId)?.promise ?? Promise.resolve();
		void ready.then(() => gate.resolve(), gate.reject);
	}

	#clearApprovalPreviewGates(): void {
		for (const gate of this.#approvalPreviewGates.values()) gate.resolve();
		this.#approvalPreviewGates.clear();
		for (const pending of this.#previewPending.values()) pending.resolve();
		this.#previewPending.clear();
	}

	/** A new card for `toolCallId`: an edit-like call's approval waits for its diff preview. */
	#trackPreview(toolCallId: string, toolName: string, tool: unknown): void {
		if (toolEditMode(toolName, tool) && !this.#previewPending.has(toolCallId)) {
			this.#previewPending.set(toolCallId, Promise.withResolvers<void>());
		}
	}

	/** A streamed edit preview arrived; `streaming: false` means the diff is final. */
	#notePreviewUpdate(toolCallId: string, update: unknown): void {
		if (isRecord(update) && update.streaming === false) this.#resolvePreview(toolCallId);
	}

	#resolvePreview(toolCallId: string): void {
		this.#previewPending.get(toolCallId)?.resolve();
		this.#previewPending.delete(toolCallId);
	}

	/** Hand a card the preview that streamed in before it existed. */
	#applyPendingStreamPreview(toolCallId: string, tool: PendingTool): void {
		const preview = this.#pendingStreamPreviews.get(toolCallId);
		if (preview === undefined) return;
		tool.updateStreamPreview(preview);
		this.#pendingStreamPreviews.delete(toolCallId);
		this.#notePreviewUpdate(toolCallId, preview);
	}

	#getReadGroup(): PendingTool {
		if (!this.#lastReadGroup) this.#lastReadGroup = this.ctx.presentReadGroup();
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistant = this.ctx.streaming ?? this.#lastAssistantComponent;
		if (assistant) this.#readToolCallAssistantComponents.set(toolCallId, assistant);
	}

	inheritReadToolAssistant(toolCallId: string, view: AssistantView | undefined): void {
		if (view) this.#readToolCallAssistantComponents.set(toolCallId, view);
		else this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#retractToolCardEntry(toolCallId: string, tool: PendingTool): void {
		let removeBlock = true;
		if (tool.group) {
			removeBlock = tool.group.removeEntry(toolCallId);
			if (tool === this.#lastReadGroup) this.#resetReadGroup();
		}
		this.ctx.pendingTools.delete(toolCallId);
		this.#resolvePreview(toolCallId);
		if (removeBlock) {
			tool.seal();
			this.#closedReadGroups.delete(tool);
			this.ctx.shell.transcript.remove(tool.block);
		} else if (tool.group) {
			this.#settleClosedReadGroup(tool);
		}
		this.#toolTimelineComponents.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
	}

	/**
	 * Re-key a live streamed tool card whose id changed mid-stream (see
	 * {@link #streamedToolCallIdByIndex}). Moves every id-keyed tracker from the
	 * old id to the new one so the next cumulative `message_update` reuses the
	 * existing card instead of creating a duplicate (#6879). Routing is via
	 * `pendingTools`; the card (or the shared read group's entry) takes the new
	 * id too, which is what transcript presenters see and refresh by.
	 */
	#migrateStreamedToolCallId(oldId: string, newId: string): void {
		// `oldId` may be "" (the block streamed before its id): that empty key still
		// owns a live card and must migrate. Skip only a no-op or an empty target.
		if (oldId === newId || !newId) return;
		const pending = this.ctx.pendingTools.get(oldId);
		if (pending && !this.ctx.pendingTools.has(newId)) {
			this.ctx.pendingTools.delete(oldId);
			this.ctx.pendingTools.set(newId, pending);
		}
		const timeline = this.#toolTimelineComponents.get(oldId);
		if (timeline && !this.#toolTimelineComponents.has(newId)) {
			this.#toolTimelineComponents.delete(oldId);
			this.#toolTimelineComponents.set(newId, timeline);
		}
		// A held stream preview is id-keyed and consumed under the card's final id
		// (message_update creation / tool_execution_start); move it with the card
		// or the lookup under `newId` misses and the preview is lost.
		const preview = this.#pendingStreamPreviews.get(oldId);
		if (preview !== undefined && !this.#pendingStreamPreviews.has(newId)) {
			this.#pendingStreamPreviews.delete(oldId);
			this.#pendingStreamPreviews.set(newId, preview);
		}
		// The reveal controller is id-keyed; drop the stale target so the loop's
		// setTarget/bind under the new id owns the paced reveal.
		this.#toolArgsReveal.finish(oldId);
		if (this.#executionStartedCallIds.delete(oldId)) {
			this.#executionStartedCallIds.add(newId);
		}
		const readArgs = this.#readToolCallArgs.get(oldId);
		if (readArgs !== undefined) {
			this.#readToolCallArgs.delete(oldId);
			this.#readToolCallArgs.set(newId, readArgs);
		}
		const readAssistant = this.#readToolCallAssistantComponents.get(oldId);
		if (readAssistant !== undefined) {
			this.#readToolCallAssistantComponents.delete(oldId);
			this.#readToolCallAssistantComponents.set(newId, readAssistant);
		}
		const previewReady = this.#previewPending.get(oldId);
		if (previewReady && !this.#previewPending.has(newId)) {
			this.#previewPending.delete(oldId);
			this.#previewPending.set(newId, previewReady);
		}
		// A collapsed read renders into a shared group keyed by id; rename its
		// entry so the row isn't duplicated under the new id.
		pending?.group?.renameEntry(oldId, newId);
		// A card now owning `newId` hands presenters (and refreshTranscript) that id.
		if (pending && !pending.group && this.ctx.pendingTools.get(newId) === pending) pending.rename?.(newId);
		// A fast completion can land under `newId` while the card is still keyed
		// by `oldId`. Consume it now that the card owns the final id; the normal
		// creation path is skipped on a re-key (Codex review on #6881).
		if (pending) this.#settleHeldCompletionIfPresent(newId, pending);
	}

	/**
	 * Reconcile every tool-call block's live card key with the id its content
	 * block currently carries (see {@link #streamedToolCallIdByIndex}), moving
	 * the id-keyed card state via {@link #migrateStreamedToolCallId}. A streamed
	 * id can change across cumulative `message_update`s (#6879), and the final
	 * snapshot can carry a per-index id change no delta ever showed — agent-loop
	 * mints and re-keys tool-call ids at `done`, after the last
	 * `message_update` — so the `message_end` path replays the same
	 * reconciliation the delta path runs. Without it the pre-mint card is never
	 * re-keyed: `tool_execution_start` mounts a second card under the minted id
	 * and the streamed one ghosts until sealed.
	 *
	 * Several indices can share one streamed id (a reused provider id, or
	 * siblings that all streamed before their ids materialized) and then split
	 * into distinct ids. The shared card migrates only when the old id is no
	 * longer referenced by any content index — the last referencer keeps the
	 * card; the other indices pick up their own card at `tool_execution_start`.
	 * Migrating unconditionally would move the one shared card to the first
	 * re-keyed sibling and leave the index that kept the old id with no streamed
	 * card (a reverse ghost).
	 */
	#reconcileStreamedToolCallIds(content: AssistantMessage["content"]): void {
		const finalIdByIndex = new Map<number, string>();
		for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
			const block = content[contentIndex]!;
			if (block.type === "toolCall") finalIdByIndex.set(contentIndex, block.id);
		}
		for (const [contentIndex, id] of finalIdByIndex) {
			const priorId = this.#streamedToolCallIdByIndex.get(contentIndex);
			if (priorId === undefined || priorId === id) {
				this.#streamedToolCallIdByIndex.set(contentIndex, id);
				continue;
			}
			const oldIdStaysOwned = [...finalIdByIndex].some(([otherIndex, otherId]) => {
				if (otherIndex === contentIndex) return false;
				// The other index either already resolved to the old id or still
				// streams under it and has not been re-keyed yet.
				return otherId === priorId || this.#streamedToolCallIdByIndex.get(otherIndex) === priorId;
			});
			if (oldIdStaysOwned) {
				// The shared card stays under `priorId` for its remaining
				// referencer; make it show THAT call's arguments, not the last
				// cumulative update's (every sibling updated the one shared card
				// while the id was still shared).
				const card = this.ctx.pendingTools.get(priorId);
				for (const [keeperIndex, keeperId] of finalIdByIndex) {
					if (keeperId !== priorId || keeperIndex === contentIndex) continue;
					const keeper = content[keeperIndex];
					if (card && keeper?.type === "toolCall") card.updateArgs(keeper.arguments, priorId);
				}
			} else {
				this.#migrateStreamedToolCallId(priorId, id);
			}
			this.#streamedToolCallIdByIndex.set(contentIndex, id);
		}
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: {
			content: ReadonlyArray<{
				type: string;
				data?: string;
				mimeType?: string;
			}>;
			details?: unknown;
		},
	): boolean {
		const assistant = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistant) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({
				type: "image",
				data: content.data,
				mimeType: content.mimeType,
			}));
		const mediaPath = readMediaPath(result.details);
		if (images.length === 0 && !mediaPath) return false;
		assistant.setToolResultMedia(toolCallId, { images, mediaPath });
		// A media-only result (a model, a PDF) still settles through the read group.
		return images.length > 0 && cfgTerminalShowImages.get(settings);
	}

	/**
	 * The block a segment drawn after `anchor` mounts before: the block following the anchor, unless
	 * the anchor is gone, last, or a later block already reached scrollback (then it appends).
	 */
	#blockAfter(anchor: TranscriptBlock | undefined): TranscriptBlock | undefined {
		if (!anchor) return undefined;
		const transcript = this.ctx.shell.transcript;
		const blocks = transcript.blocks();
		const index = blocks.indexOf(anchor);
		if (index < 0) return undefined;
		const later = blocks.slice(index + 1);
		if (later.some(block => transcript.retired(block))) return undefined;
		return later[0];
	}

	#upsertPostToolAssistantSegment(
		toolCallId: string,
		segment: AssistantMessage | undefined,
		contentOffset: number | undefined,
		linkTargets?: ReadonlyMap<string, string>,
		opts?: { transient?: boolean },
	): AssistantView | undefined {
		if (!segment || !assistantHasVisibleContent(segment)) return undefined;
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			if (linkTargets) existing.linkTargets.set(linkTargets);
			// Closed segments may already be in append-only terminal history.
			if (existing.finalized.peek()) return existing;
			batch(() => {
				existing.transient.set(opts?.transient === true);
				existing.message.set(segment);
			});
			return existing;
		}
		const view = this.ctx.presentAssistant(undefined, {
			linkTargets,
			contentOffset,
			before: this.#blockAfter(this.#toolTimelineComponents.get(toolCallId)?.block),
		});
		batch(() => {
			view.transient.set(opts?.transient === true);
			view.message.set(segment);
		});
		this.#postToolAssistantComponents.set(toolCallId, view);
		return view;
	}

	/** Mount a call's card (or reply block) and route its events to it. */
	#presentToolCard(toolCallId: string, name: string, args: unknown, tool: AgentTool | undefined): PendingTool {
		const card = this.ctx.presentToolCall({
			name,
			args,
			tool,
			id: toolCallId,
			cwd: this.ctx.sessionManager.getCwd(),
		});
		this.#trackPreview(toolCallId, name, tool);
		this.#applyPendingStreamPreview(toolCallId, card);
		this.ctx.pendingTools.set(toolCallId, card);
		this.#toolTimelineComponents.set(toolCallId, card);
		return card;
	}

	#updateWorkingMessageFromIntent(trimmed: string | undefined): void {
		if (this.ctx.session.isAborting) return;
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(trimmed);
	}

	subscribeToAgent(): void {
		// Serialize non-update dispatch behind any in-flight handler run:
		// AgentSession.#emit fires listeners fire-and-forget (it does not await
		// listener promises), so without this a rapid stream tail
		// (message_update → message_end → agent_end) could let a later callback
		// overtake the coalesced flush's handler mid-await — agent_end removing
		// `streaming` before #handleMessageEnd finalizes and records
		// the final message (issue #7443 follow-up). When the tail has settled,
		// dispatch stays synchronous: the flush's streaming rebuild runs before
		// the listener's first await, preserving the timing the coalescing
		// tests assert on. `message_update` enqueue is itself synchronous and
		// needs no serialization.
		this.ctx.unsubscribe = this.ctx.session.subscribe(event => this.dispatchSessionEvent(event));
	}

	/**
	 * Route one session event through the same pipeline as the live
	 * subscription: coalesce the cumulative `message_update` deltas of a
	 * streaming turn into at most one handler run per window, and serialize
	 * every other event behind any in-flight run.
	 *
	 * `#handleMessageUpdate` is synchronous, so without coalescing every token
	 * re-runs the whole streaming rebuild (splitAssistantMessageToolTimeline,
	 * reveal setTarget, per-block tool-call reconciliation) even though the TUI
	 * paints at most ~30fps — at 40-100 tps the handler work then dominates the
	 * CPU profile of an idle-looking streaming session (issue #7443). Only the
	 * latest snapshot is meaningful; non-update events flush the pending
	 * snapshot first so ordering is preserved.
	 */
	async dispatchSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#enqueueMessageUpdate(event);
			return;
		}
		await this.runSerialized(async () => {
			await this.handleEvent(event);
		});
	}

	/**
	 * Run `run` in the serialized session-event dispatch pipeline, flushing any
	 * pending coalesced `message_update` first. This does not drop work when the
	 * viewed session changes: a caller that queues across that change must skip
	 * the stale work itself.
	 */
	async runSerialized(run: () => Promise<void>): Promise<void> {
		await this.#runSerialized(async () => {
			await this.#flushPendingMessageUpdate();
			await run();
		});
	}

	/**
	 * Run `run` in the serialized dispatch chain: every run is its own link on
	 * the tail, so a burst of events queued behind an in-flight run start one
	 * after the other, never concurrently. This closes two races (issue #7443
	 * follow-up): a rapid stream tail (message_update → message_end →
	 * agent_end) cannot overtake the coalesced flush mid-await — agent_end
	 * removing `streaming` before #handleMessageEnd finalizes and
	 * records the final message — and two+ events landing in the same window
	 * cannot all resume from one shared await and dispatch in parallel. When
	 * the chain is drained, `run` starts synchronously (no intermediate
	 * microtask), preserving the synchronous-flush timing the coalescing
	 * tests assert on. A rejection propagates to the caller (the session's
	 * fire-and-forget emit) and the next event starts a fresh chain link
	 * instead of being dropped.
	 */
	async #runSerialized(run: () => Promise<void>): Promise<void> {
		if (this.#dispatchInFlight) {
			// Queue behind the CURRENT tail: the next run starts only after
			// the previous one settles. Each waiter gets its own link, so a
			// burst cannot fan out from the same shared await.
			const link = this.#dispatchTail.then(
				() => run(),
				() => run(),
			);
			this.#dispatchTail = link;
			void link.then(
				() => {
					// Only the tail owner clears the flag: a later chained
					// link clears it when it settles as the tail.
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
				() => {
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
			);
			await link;
			return;
		}
		this.#dispatchInFlight = true;
		const link = run();
		this.#dispatchTail = link;
		void link.then(
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
		);
		await link;
	}

	/**
	 * Queue a streaming `message_update` for the next coalesced handler run.
	 * Speech is per-delta, so the delta is vocalized at arrival before the
	 * snapshot is (possibly) superseded by a newer one.
	 */
	#enqueueMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		// Speech is per-delta: every delta is spoken at arrival even when its
		// cumulative snapshot is later superseded and never rebuilt.
		this.#vocalizeDelta(event);
		this.#vocalizedMessageUpdates.add(event);
		this.#pendingMessageUpdate = event;
		this.#pendingMessageRestart ||= event.assistantMessageEvent.type === "start";
		if (this.#messageUpdateTimer) return;
		this.#messageUpdateTimer = setTimeout(() => {
			this.#messageUpdateTimer = undefined;
			// Mirror AgentSession.#emit: attach a catch so a streaming rebuild
			// failure surfaces as a logged warning instead of a process-level
			// unhandled rejection (the timer path has no listener to attach one).
			// Runs inside the serialized dispatch chain so a message_end /
			// agent_end landing mid-window cannot overtake this flush (issue
			// #7443 follow-up).
			void this.#runSerialized(async () => {
				await this.#flushPendingMessageUpdate();
			}).catch(err => {
				logger.warn("Message update flush rejected", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, EventController.#MESSAGE_UPDATE_COALESCE_MS);
	}

	/**
	 * Run the coalesced `message_update` handler on the latest pending snapshot
	 * (dropping any superseded intermediates) and clear the queue. Safe to call
	 * more than once; no-ops when nothing is pending.
	 */
	async #flushPendingMessageUpdate(): Promise<void> {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		const event = this.#pendingMessageUpdate;
		if (!event) return;
		this.#pendingMessageUpdate = undefined;
		const restarted = this.#pendingMessageRestart;
		this.#pendingMessageRestart = false;
		if (restarted && event.assistantMessageEvent.type !== "start") {
			await this.#restartAssistantStream(event.message);
		}
		await this.handleEvent(event);
	}

	/** Whether `#handleToolExecutionStart` has fired for this call id this turn. */
	hasToolExecutionStarted(toolCallId: string): boolean {
		return this.#executionStartedCallIds.has(toolCallId);
	}

	/**
	 * Clear every transcript-anchored/turn-scoped piece of state. Used by the
	 * session focus proxy when re-pointing the transcript at another session:
	 * components, timers, and stream-reveal state all reference the previous
	 * session's transcript and must not bleed into the new one.
	 */
	resetTranscriptAnchors(): void {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#pendingMessageRestart = false;
		this.#dispatchGeneration++;
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#pendingStreamPreviews.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#toolReplyBlocks.clear();
		this.#backgroundCallIds.clear();
		this.#settledBeforeReturn.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.#turnStartedAt = undefined;
		this.#turnUsage.reset();
		this.#lastAgentEndAt = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.#retryPending = this.ctx.viewSession.isRetrying;
		this.composerPrediction.cancel();
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
		this.#displaceablePollComponent = undefined;
		this.#displaceableTodoComponent = undefined;
		this.#lastTtsrNotification = undefined;
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#seedHeldCompletionsFromPendingResults();
	}

	/** Restore display state without replaying completion notifications or persistence. */
	#seedHeldCompletionsFromPendingResults(): void {
		const pending = this.ctx.viewSession.agent.getPendingToolResults();
		for (const result of pending) {
			if (this.#toolTimelineComponents.has(result.toolCallId) && !this.ctx.pendingTools.has(result.toolCallId)) {
				continue;
			}
			this.#orphanedToolCompletions.set(result.toolCallId, {
				type: "tool_execution_end",
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				result: { content: result.content, details: result.details },
				isError: result.isError,
			});
		}
	}

	/** Settle replay-created cards without waiting for another streaming update. */
	restorePendingToolResults(): void {
		this.#seedHeldCompletionsFromPendingResults();
		for (const [toolCallId, component] of this.ctx.pendingTools) {
			this.#toolTimelineComponents.set(toolCallId, component);
			this.#settleHeldCompletionIfPresent(toolCallId, component);
		}
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			// Tern reads the progress as the pane's busy state (its tab's live
			// dot), so it gets it whatever the setting says. Tern's panes carry
			// `KITTY_WINDOW_ID`, so the terminal identity says kitty there.
			const wanted =
				Bun.env.TERM_PROGRAM?.toLowerCase() === "tern" ||
				(this.ctx.settings ? cfgTerminalShowProgress.get(this.ctx.settings) : undefined) === true;
			if (this.#terminalProgressActive || !wanted) return;
			this.ctx.setTerminalProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.setTerminalProgress(false);
		this.#terminalProgressActive = false;
	}

	#trackRetrySupersededAssistantComponent(component: AssistantView | undefined): void {
		if (!component) return;
		const persistenceKey = messagePersistenceKey(component);
		if (persistenceKey) this.#retrySupersededAssistantComponents.set(persistenceKey, component);
		if (!this.#retrySupersededAssistantQueue.includes(component)) {
			this.#retrySupersededAssistantQueue.push(component);
		}
	}

	#takeRetrySupersededAssistantComponent(persistenceKey: string | undefined): AssistantView | undefined {
		if (persistenceKey) {
			const component = this.#retrySupersededAssistantComponents.get(persistenceKey);
			if (component) {
				this.#retrySupersededAssistantComponents.delete(persistenceKey);
				this.#retrySupersededAssistantQueue = this.#retrySupersededAssistantQueue.filter(
					item => item !== component,
				);
				return component;
			}
		}
		while (this.#retrySupersededAssistantQueue.length > 0) {
			const component = this.#retrySupersededAssistantQueue.shift();
			if (!component) continue;
			const key = messagePersistenceKey(component);
			if (key && this.#retrySupersededAssistantComponents.get(key) !== component) continue;
			if (key) this.#retrySupersededAssistantComponents.delete(key);
			return component;
		}
		return undefined;
	}

	#clearRetrySupersededAssistantComponents(): void {
		this.#retrySupersededAssistantComponents.clear();
		this.#retrySupersededAssistantQueue = [];
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		// A loop started before the interrupt landed; that abort ends this loop
		// as a plain user interrupt.
		this.#stoppedWaiting = false;
		// A run with no user prompt in it (synthetic-only: `/goal` kickoff,
		// approved-plan execution) must not measure prompt→yield from an unrelated
		// earlier prompt. Normal user turns reseed via message_start before
		// agent_start; retries of the same turn keep the anchor because it still
		// postdates the last completed run.
		if (
			this.#turnStartedAt !== undefined &&
			this.#lastAgentEndAt !== undefined &&
			this.#turnStartedAt < this.#lastAgentEndAt
		) {
			this.#turnStartedAt = undefined;
		}
		this.#clearApprovalPreviewGates();
		// A new turn cannot inherit a foreground tool execution. A dropped
		// agent_end (for example after a renderer exception) otherwise leaves a
		// live-only tool card without a persisted result; ordered transcript
		// retirement then remains pinned behind that invisible stale card.
		this.#sealAbandonedForegroundTools();
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#pendingStreamPreviews.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#toolReplyBlocks.clear();
		this.#lastIntent = undefined;
		// Something outside woke the run: the row stops naming the wait and
		// follows this loop's intents again.
		if (this.#showingAsyncWait) {
			this.#showingAsyncWait = false;
			this.ctx.setWorkingMessage();
		}
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#seedHeldCompletionsFromPendingResults();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		// Restore terminal errors in transcript history when their banner clears.
		// Recoverable empty-output attempts are discarded by session recovery and
		// must stay hidden rather than resurfacing as a stale inline error.
		if (this.#restorePinnedErrorInline) this.#pinnedErrorComponent?.errorPinned.set(false);
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.ctx.clearPinnedError();
		this.ctx.clearWorking("retry");
		this.composerPrediction.cancel();
		this.ctx.statusLine.markActivityStart();
		// The turn owns progress from here; a compaction that started it hands it over.
		this.#compactionOwnsProgress = false;
		this.#setTerminalProgress(true);
		this.ctx.ensureWorkingRow();
		setRunStatus({ state: "working" });
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			if (event.message.role === "custom" && !this.ctx.initialChatRendered && !this.ctx.viewSession.isStreaming) {
				// Idle custom append while no transcript render has committed (e.g. a startup
				// display:true sendMessage before renderInitialMessages): AgentSession persists the
				// entry before emitting this event, so the replay owns the paint — a render not yet
				// started reads it from session entries, and one in progress sees the entry count
				// change and restarts. Painting live too would duplicate it, since
				// renderInitialMessages({ preserveExistingChat: true }) re-appends existing chat
				// children. Mirrors ExtensionUiController.#applyCustomMessageDisplay's gate.
				// Streaming is excluded so live-turn rendering is unchanged.
				return;
			}
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			// A directly-invoked `/skill:` or writable-collab custom prompt is the
			// run's initiating message (user attribution): seed the prompt→yield
			// delta from it, the same as a user message.
			if (event.message.role === "custom" && isUserTurnInitiator(event.message)) {
				this.#turnStartedAt = event.message.timestamp;
				this.#turnUsage.reset();
			}
			const taskJobToast = this.ctx.shell.native() ? nativeTaskJobToast(event.message) : undefined;
			if (
				event.message.role === "custom" &&
				this.ctx.optimisticSkillMessagePending &&
				isUserInvokedSkillPrompt(event.message)
			) {
				// The optimistic `/skill:` row painted at submit time (issue #8895):
				// swap it for the canonical message instead of appending a duplicate.
				this.ctx.reconcileOptimisticSkillMessage(event.message);
			} else if (taskJobToast) {
				// Native: the task call's `agent` nodes already settled in place
				// (its terminal async update); a toast replaces the appended
				// "Background job completed" rows.
				this.ctx.showStatus(taskJobToast);
			} else {
				this.ctx.addMessageToChat(event.message);
			}
			// Queued custom-message chips are derived from the agent queue; refresh the
			// pending bar when the queued custom is consumed so the chip disappears
			// immediately.
			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
		} else if (event.message.role === "user") {
			vocalizer.clear();
			// Only genuinely user-attributed prompts anchor the delta; a mid-run
			// agent-attributed `user` message (advisor tool-loop redirect) must not.
			if (event.message.attribution !== "agent") {
				this.#turnStartedAt = event.message.timestamp;
				this.#turnUsage.reset();
			}
			const userText = textContent(event.message.content);
			const imageBlocks =
				typeof event.message.content === "string"
					? []
					: event.message.content.filter(
							(content): content is ImageContent =>
								content.type === "image" &&
								typeof content.data === "string" &&
								typeof content.mimeType === "string",
						);
			const imageCount = imageBlocks.length;
			const signature = `${userText}\u0000${imageCount}`;

			this.#resetReadGroup();
			this.#resolveDisplaceablePoll();
			this.#resolveDisplaceableTodo();
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			if (wasOptimistic) {
				this.ctx.clearOptimisticUserMessage();
			} else if (replacesOptimistic) {
				this.ctx.replaceOptimisticUserMessage(event.message);
			} else {
				// Append synchronously: #emit dispatches to this listener fire-and-forget
				// (see AgentSession.#emit), so any await between the user message_start and
				// addMessageToChat lets later events (assistant message_start, tool execution
				// start/end) append their components first and scramble transcript order /
				// live-region block boundaries. addMessageToChat materializes clickable image
				// links via the synchronous putBlobSync fallback, so no await is needed here.
				this.ctx.addMessageToChat(event.message);
			}

			// Never clear the editor here. A local submission (optimistic or
			// queued-while-streaming) already cleared it at submit time, so clearing
			// again races with the user typing the next prompt while the previous
			// large redraw lands and erases their in-progress draft (#783). An inbound
			// user message this session did not submit locally — an extension
			// delivering `sendUserMessage`, e.g. HCOM — is a real non-synthetic prompt
			// that arrives *while* the user may be composing, so it must not touch the
			// draft either.
			if (!event.message.synthetic) {
				this.ctx.updatePendingMessagesDisplay();
			}
		} else if (event.message.role === "developer") {
			// A run-initiating synthetic developer prompt (auto-continue, or a
			// queued follow-up drained inside the current run — plan approval, /goal)
			// starts fresh work without a new agent_start: clear the preceding user
			// prompt's anchor so its rows don't inherit the old turn's span.
			if (event.message.synthetic) {
				// A deliberate operator action (`.`, `c` continue shortcut) is the
				// turn's own prompt: anchor the delta to it instead of clearing.
				if (event.message.userInitiated) this.#turnStartedAt = event.message.timestamp;
				else this.#turnStartedAt = undefined;
				this.#turnUsage.reset();
			}
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
		} else if (event.message.role === "assistant") {
			// A streaming component left over from an attempt that never saw its
			// message_end (a mid-stream throw the loop could not pair) must not stay
			// live: one unfinalized block at the transcript frontier blocks history
			// retirement — and therefore transcript layout — forever. Drop it when
			// still removable, and finalize it regardless so it can retire.
			const abandoned = this.ctx.streaming;
			if (abandoned) {
				abandoned.finalized.set(true);
				this.ctx.shell.transcript.remove(abandoned.block);
			}
			this.#finalizeAbandonedPostToolSegments();
			this.#sealOrphanedToolCards(event.message.content.length === 0);
			this.#lastVisibleBlockCount = 0;
			this.#streamedToolCallIdByIndex.clear();
			const view = this.ctx.presentAssistant();
			this.ctx.streaming = view;
			this.ctx.streamingMessage = event.message;
			const timeline = splitAssistantMessageToolTimeline(event.message);
			this.#streamingReveal.begin(view, timeline.beforeTools, timeline.hasToolCalls);
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		if (!event.message.display) return;
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		const blocks = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, blocks);
		this.#enforceIrcCardCap(signature);
	}

	#scheduleIrcExpiry(signature: string, blocks: TranscriptBlock[]): void {
		if (blocks.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			this.#retireIrcCard(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
		this.#liveIrcCards.set(signature, blocks);
	}

	/**
	 * Remove an expired/evicted IRC card only while none of its rows reached
	 * terminal scrollback; rows already there stay as final history.
	 */
	#retireIrcCard(signature: string): void {
		const blocks = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!blocks) return;
		const transcript = this.ctx.shell.transcript;
		for (const block of blocks) if (!transcript.retired(block)) transcript.remove(block);
	}

	/** Evict oldest live-region cards beyond {@link MAX_LIVE_IRC_CARDS}. */
	#enforceIrcCardCap(latestSignature: string): void {
		while (this.#liveIrcCards.size > MAX_LIVE_IRC_CARDS) {
			const oldest = this.#liveIrcCards.keys().next().value;
			if (oldest === undefined || oldest === latestSignature) return;
			const timer = this.#ircExpiryTimers.get(oldest);
			if (timer) {
				clearTimeout(timer);
				this.#ircExpiryTimers.delete(oldest);
			}
			this.#retireIrcCard(oldest);
		}
	}

	/**
	 * Resolve the pending displaceable poll block before the next block lands.
	 * A follow-up `wait` call displaces it — the stale "waiting on N jobs" frame
	 * is removed so repeated polls read as one persistent poll — while anything
	 * else seals it in place as final history. Removal is gated on none of the
	 * block's rows having entered native scrollback: rows already on the tape
	 * are immutable visual history, so a scrolled-off poll seals instead of
	 * being retracted.
	 */
	#resolveDisplaceablePoll(nextToolName?: string): void {
		const previous = this.#displaceablePollComponent;
		if (!previous) return;
		this.#displaceablePollComponent = undefined;
		if (
			nextToolName === "wait" &&
			displaceableBy(previous) !== undefined &&
			!this.ctx.shell.transcript.retired(previous.block)
		) {
			this.ctx.shell.transcript.remove(previous.block);
		}
		// Sealing stops the waiting-poll spinner and settles the block.
		previous.seal();
	}

	/** The turn is over: the tracked `todo` snapshot is final. */
	#resolveDisplaceableTodo(): void {
		this.#displaceableTodoComponent?.seal();
		this.#displaceableTodoComponent = undefined;
	}

	/**
	 * Detach both displacement trackers and return whichever components were
	 * live, without touching their animation state. `#handleToolExecutionEnd`
	 * settles a displaceable `wait`/`todo` result out of `pendingTools` into
	 * these trackers instead (see the `displaceableBy` branch there), so
	 * a caller that enumerates only `pendingTools` before replacing the whole
	 * transcript — the collab guest resync (`guest.ts#finalizeSnapshot`) —
	 * misses a still-animated "waiting" card. That caller must fold this
	 * method's result into its own live-block accounting.
	 */
	takeDisplaceableComponents(): PendingTool[] {
		const components: PendingTool[] = [];
		if (this.#displaceablePollComponent) components.push(this.#displaceablePollComponent);
		if (this.#displaceableTodoComponent && this.#displaceableTodoComponent !== this.#displaceablePollComponent) {
			components.push(this.#displaceableTodoComponent);
		}
		this.#displaceablePollComponent = undefined;
		this.#displaceableTodoComponent = undefined;
		return components;
	}

	/**
	 * Adopt a rebuilt-tail todo snapshot as the controller's tracked live
	 * snapshot. Used by rebuild paths (settings/extensions overlay close, focus
	 * attach, /resume) to preserve displacement continuity when a turn is still
	 * active — without this, the next same-turn `todo` update would stack
	 * another panel because the controller's tracker was reset before rebuild.
	 * Drops the candidate when it is no longer a displaceable todo.
	 */
	inheritDisplaceableTodo(tool: PendingTool | null | undefined): void {
		this.#displaceableTodoComponent = tool && displaceableBy(tool) === "todo" ? tool : undefined;
	}
	/**
	 * Adopt the rebuild's replayed user-prompt timestamp so a still-running turn
	 * keeps its prompt→yield delta. Focus attach and mid-turn rebuilds reset the
	 * controller's turn start before replaying entries; without the handoff the
	 * in-flight assistant `message_end` would render the usage row without the
	 * elapsed figure. Mirrors {@link inheritDisplaceableTodo}. Drops the
	 * candidate when the rebuild saw no user message.
	 */
	inheritTurnStart(turnStartedAt: number | undefined): void {
		if (turnStartedAt !== undefined) this.#turnStartedAt = turnStartedAt;
	}

	/**
	 * Re-register parked background cards after a transcript rebuild so a
	 * background job's replayed and live progress frames keep routing to the
	 * preserved component. Focus attach clears {@link #backgroundCallIds}
	 * via {@link resetTranscriptAnchors} before the rebuild repopulates it.
	 * Ids whose component did not survive into `pendingTools` are skipped.
	 */
	markBackgroundCalls(toolCallIds: Iterable<string>): void {
		for (const toolCallId of toolCallIds) {
			if (this.ctx.pendingTools.has(toolCallId)) this.#backgroundCallIds.add(toolCallId);
		}
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Speak streamed assistant output as a side effect of the turn. The mode
	 * decides which deltas feed the vocalizer (the vocalizer re-checks enabled):
	 * assistant|all speak text; all also speaks thinking; yield speaks nothing
	 * live (the final message is spoken at turn end).
	 */
	#vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (!cfgSpeechEnabled.get(settings)) return;
		const mode = cfgSpeechMode.get(settings);
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && mode === "all") {
			vocalizer.pushDelta(delta.delta);
		}
	}

	/**
	 * End-of-turn vocalization: yield mode speaks the final assistant message in
	 * one shot here (the only mode that is post-hoc); every other mode just makes
	 * sure the live buffer's trailing partial gets flushed.
	 */
	#handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
		if (!cfgSpeechEnabled.get(settings)) return;
		if (cfgSpeechMode.get(settings) !== "yield") {
			vocalizer.flush();
			return;
		}
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted") return; // interrupted: never speak the aborted partial
		const text = extractTextContent(event.message);
		if (text) vocalizer.speak(text);
	}

	async #restartAssistantStream(message: AgentMessage): Promise<void> {
		this.#retractStreamedToolPreviews();
		await this.handleEvent({ type: "message_start", message });
	}

	#retractStreamedToolPreviews(): void {
		// A provider replay can abandon previews without ever executing them.
		// No result will settle those cards; leaving one pins all later history.
		for (const toolCallId of this.#streamedToolCallIdByIndex.values()) {
			if (this.#executionStartedCallIds.has(toolCallId) || this.#backgroundCallIds.has(toolCallId)) continue;
			this.#toolArgsReveal.finish(toolCallId);
			this.#pendingStreamPreviews.delete(toolCallId);
			const component = this.ctx.pendingTools.get(toolCallId);
			if (component) this.#retractToolCardEntry(toolCallId, component);
			const segment = this.#postToolAssistantComponents.get(toolCallId);
			if (segment) {
				segment.finalized.set(true);
				this.ctx.shell.transcript.remove(segment.block);
				this.#postToolAssistantComponents.delete(toolCallId);
			}
		}
		this.#resetReadGroup();
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		const generation = this.#dispatchGeneration;
		this.#ensureWorkingLoaderWhileStreaming();
		if (!this.#vocalizedMessageUpdates.delete(event)) {
			this.#vocalizeDelta(event);
		}
		if (event.assistantMessageEvent?.type === "start") {
			await this.#restartAssistantStream(event.message);
		}
		// A focus switch reset the view while the restart was in flight: this
		// update belongs to the previous session's stream.
		if (generation !== this.#dispatchGeneration) return;
		if (event.message.role === "assistant") await this.syncAssistantMessage(event.message);
	}

	/** Resync a cumulative snapshot without replay cleanup or speech side effects. */
	async syncAssistantMessage(message: AssistantMessage): Promise<void> {
		const generation = this.#dispatchGeneration;
		const streaming = this.ctx.streaming;
		if (streaming) {
			// Rendered replies read the effective visibility reactively; the reveal caches it.
			if (this.ctx.noteDisplayableThinkingContent(message)) this.#streamingReveal.resyncVisibility();
			this.ctx.streamingMessage = message;
			const timeline = splitAssistantMessageToolTimeline(this.ctx.streamingMessage);
			this.#streamingReveal.setTarget(timeline.beforeTools, timeline.hasToolCalls);

			const visibleBlockCount = this.ctx.streamingMessage.content.filter(
				content =>
					(content.type === "text" && canonicalizeMessage(content.text)) ||
					(content.type === "thinking" && canonicalizeMessage(content.thinking)),
			).length;
			if (visibleBlockCount > this.#lastVisibleBlockCount) {
				this.#resetReadGroup();
				this.#lastVisibleBlockCount = visibleBlockCount;
			}

			// Content blocks stream sequentially: a toolCall block can only begin
			// after every preceding thinking/text block has closed, and the
			// reveal's setTarget above force-completes the visible text for
			// toolCall messages. Finalize the assistant block now instead of at
			// message_end so the transcript's commit-safe run can extend through
			// it into the streaming tool preview below — otherwise a long args
			// stream (a big write/edit/eval) sits below a still-live block and
			// can never reach native scrollback: the head of the preview is
			// neither committed nor on screen and the transcript reads as cut.
			if (
				this.ctx.streamingMessage.content.some(content => content.type === "toolCall") &&
				!streaming.finalized.peek()
			) {
				const linkTargets = await refreshAssistantMessageLinkTargets(this.ctx, [timeline.beforeTools]);
				// A focus switch reset the view during link resolution (it waits
				// behind this run): the streaming state below is gone or the next
				// session's, so none of this snapshot may be drawn into it.
				if (generation !== this.#dispatchGeneration || this.ctx.streaming !== streaming) return;
				streaming.linkTargets.set(assistantMessageLinkTargets(timeline.beforeTools, linkTargets));
				streaming.finalized.set(true);
			}
			// Re-key live cards when a provider rewrites a block's id across
			// deltas, so the changed id reuses the existing card instead of
			// spawning a duplicate (#6879).
			this.#reconcileStreamedToolCallIds(this.ctx.streamingMessage.content);
			for (let contentIndex = 0; contentIndex < this.ctx.streamingMessage.content.length; contentIndex++) {
				const content = this.ctx.streamingMessage.content[contentIndex]!;
				if (content.type !== "toolCall") continue;
				const tool = this.ctx.viewSession.getToolByName(content.name);
				const renderToolName = toolRenderName(content.name, tool);
				if (renderToolName === "read") {
					if (!readArgsHaveTarget(content.arguments)) {
						// Args still streaming — defer until path is parseable so we can route to the
						// read group (files and `help://` doc topics) vs a tool card (other internal URLs).
						// Creating either component now would lock the read into the wrong shape.
						continue;
					}
					if (readArgsCollapseIntoGroup(content.arguments)) {
						const existing = this.ctx.pendingTools.get(content.id);
						if (existing) {
							this.#trackReadToolCall(content.id, content.arguments);
							existing.updateArgs(content.arguments, content.id);
						} else if (!this.#toolTimelineComponents.has(content.id)) {
							// A completed read remains in the timeline after leaving pendingTools.
							this.#resolveDisplaceablePoll(renderToolName);
							this.#trackReadToolCall(content.id, content.arguments);
							const group = this.#getReadGroup();
							group.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, group);
							this.#toolTimelineComponents.set(content.id, group);
							this.#settleHeldCompletionIfPresent(content.id, group);
						}
						continue;
					}
					// Other internal-URL reads fall through to a tool card below.
				}

				// Preserve the raw partial JSON only for renderers that need to surface fields before the JSON object closes.
				// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
				// While the JSON is still open, ToolArgsRevealController paces the
				// reveal (write/edit/bash previews grow smoothly when a slow provider
				// delivers large batches); once it closes, the final args render
				// as-is — mirroring how assistant text snaps at message_end.
				let renderArgs: Record<string, unknown>;
				const partialJson = getStreamingPartialJson(content);
				const rawInput = content.customWireName !== undefined;
				// `message_update` is cumulative — every update re-lists all blocks
				// of the streaming message — so creation must also be guarded by the
				// timeline map: `pendingTools` loses the id the moment a completion
				// settles the card, and for server-resolved (Cursor) tools that can
				// happen while the message is still streaming. Without the second
				// check the next cumulative update would recreate a card for a call
				// that already finished, permanently pending.
				const isNew = !this.ctx.pendingTools.has(content.id) && !this.#toolTimelineComponents.has(content.id);
				if (partialJson) {
					renderArgs = this.#toolArgsReveal.setTarget(content.id, partialJson, {
						rawInput,
						exposeRawPartialJson: exposesRawPartialJson(renderToolName, rawInput, tool),
						streamingStringKeys: streamingStringKeysForTool(renderToolName, rawInput),
					});
				} else {
					this.#toolArgsReveal.finish(content.id);
					renderArgs = content.arguments;
				}
				if (isNew) {
					// A write's streamed path may still grow into a reply URL (`ou…` → `out://`), which
					// draws as prose rather than a card; the block waits until the path tells. Empty partial
					// JSON (`toolcall_start`) is still streaming, not final empty args. An unbound reveal
					// never advances, so drop it: the next update's fresh entry shows all received.
					if (partialJson !== undefined && isReplyWrite(renderToolName, renderArgs) === undefined) {
						this.#toolArgsReveal.finish(content.id);
						continue;
					}
					this.#resolveDisplaceablePoll(renderToolName);
					this.#resetReadGroup();
					const component = this.#presentToolCard(content.id, renderToolName, renderArgs, tool);
					this.#toolArgsReveal.bind(content.id, component);
					// A held completion settles only the new card; its user-facing
					// side effects already ran on first arrival.
					this.#settleHeldCompletionIfPresent(content.id, component);
				} else {
					const component = this.ctx.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(renderArgs, content.id);
						this.#toolArgsReveal.bind(content.id, component);
					}
				}
			}
			for (const [toolCallId, segment] of timeline.afterToolCalls) {
				if (this.#postToolAssistantComponents.get(toolCallId)?.finalized.peek()) continue;
				const closed = toolCallId !== timeline.lastToolCallId;
				const linkTargets = closed ? await refreshAssistantMessageLinkTargets(this.ctx, [segment]) : undefined;
				if (generation !== this.#dispatchGeneration || !this.ctx.streamingMessage) return;
				const component = this.#upsertPostToolAssistantSegment(
					toolCallId,
					segment,
					timeline.contentOffsets.get(toolCallId),
					linkTargets ? assistantMessageLinkTargets(segment, linkTargets) : undefined,
					closed ? undefined : { transient: true },
				);
				if (closed) component?.finalized.set(true);
			}

			// Update working message with the intent of the LAST intent-bearing
			// streamed tool call. Scanning in reverse skips the redundant
			// intermediate setWorkingMessage calls a forward pass would make
			// (only the last one survives the flush anyway).
			const blocks = this.ctx.streamingMessage.content;
			for (let index = blocks.length - 1; index >= 0; index--) {
				const block = blocks[index];
				if (block?.type !== "toolCall") continue;
				const args = block.arguments;
				if (!args || typeof args !== "object") continue;
				let intent: string | undefined;
				if (INTENT_FIELD in args) {
					intent = workingIntentLabel(args[INTENT_FIELD]);
				} else {
					const tool = this.ctx.viewSession.getToolByName(block.name);
					if (typeof tool?.intent !== "function") continue;
					try {
						intent = normalizeIntent(tool.intent(args as never));
					} catch {
						// intent function must never break the UI
					}
				}
				if (!intent) continue;
				this.#updateWorkingMessageFromIntent(intent);
				break;
			}
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		// The persistence slot exists before message_end notification, unlike
		// tool_execution_end. Resolve HUD identity only after canonical append.
		if (event.message.role === "toolResult" && event.message.toolName === "todo" && !event.message.isError) {
			const details = event.message.details as { op?: string; phases?: TodoPhase[] } | undefined;
			if (details?.op !== "view" && details?.phases) {
				const owner = this.ctx.viewSession;
				const sessionId = owner.sessionManager.getSessionId();
				const sessionFile = owner.sessionManager.getSessionFile();
				await owner.settleInFlightMessagePersistence();
				if (
					this.ctx.viewSession === owner &&
					owner.sessionManager.getSessionId() === sessionId &&
					owner.sessionManager.getSessionFile() === sessionFile
				) {
					this.ctx.setTodos(owner.getTodoPhases());
				}
			}
		}
		if (event.message.role === "user") {
			// Live steering stays listed until the agent appends it, which follows
			// message_start: drop its Steering chip now.
			this.ctx.updatePendingMessagesDisplay();
			return;
		}
		const unlockedThinkingVisibility =
			event.message.role === "assistant" && this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility && this.ctx.streaming) this.#streamingReveal.resyncVisibility();
		if (event.message.role === "assistant" && cfgSpeechEnabled.get(settings)) {
			if (event.message.stopReason === "aborted") {
				// Esc / Ctrl+C / interrupt: stop speaking now and drop the trailing partial.
				vocalizer.clear();
			} else {
				const mode = cfgSpeechMode.get(settings);
				// Speak the last partial sentence of a completed message; yield mode
				// instead speaks the whole final message at turn end.
				if (mode === "assistant" || mode === "all") vocalizer.flush();
			}
		}
		const streaming = this.ctx.streaming;
		if (streaming && event.message.role === "assistant") {
			const generation = this.#dispatchGeneration;
			this.ctx.streamingMessage = event.message;
			this.#streamingReveal.stop();
			this.#toolArgsReveal.flushAll();
			let errorMessage: string | undefined;
			const aborted = this.ctx.streamingMessage.stopReason === "aborted";
			const silentlyAborted = aborted && isSilentAbort(this.ctx.streamingMessage);
			if (aborted && !silentlyAborted) {
				// Resolve the operator-facing label: a user-interrupt (Esc) abort
				// carries USER_INTERRUPT_LABEL on errorMessage (threaded through the
				// AbortController), which is preserved verbatim; any other abort with
				// no threaded reason falls back to the retry-aware generic label.
				// AgentSession.#handleAgentEvent already stamped the SilentAbort flag
				// for expected internal transitions (plan-compact, TTSR rule
				// interruption) before this controller ran, so reaching this branch
				// implies the abort was NOT a silent internal transition.
				errorMessage = resolveAbortLabel(this.ctx.streamingMessage, this.ctx.viewSession.retryAttempt);
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			const displayMessage: AssistantMessage = silentlyAborted
				? {
						// Silence the streaming render by downgrading stopReason to "stop" for
						// display only — does NOT mutate the persisted message's stopReason
						// (the structural SilentAbort flag drives replay-side suppression).
						...this.ctx.streamingMessage,
						stopReason: "stop",
					}
				: this.ctx.streamingMessage;
			const displayTimeline = splitAssistantMessageToolTimeline(displayMessage);
			const linkTargets = await refreshAssistantMessageLinkTargets(this.ctx, [displayMessage]);
			if (generation !== this.#dispatchGeneration || this.ctx.streaming !== streaming) return;
			if (!streaming.finalized.peek()) {
				streaming.linkTargets.set(assistantMessageLinkTargets(displayTimeline.beforeTools, linkTargets));
			}
			// The final snapshot can carry a per-index id change no delta ever
			// showed — agent-loop mints and re-keys tool-call ids at `done`, after
			// the last `message_update` — so replay the same reconciliation
			// `#handleMessageUpdate` runs per delta. Without it the pre-mint card
			// is never re-keyed: tool_execution_start mounts a second card under
			// the minted id and the streamed one ghosts until sealed.
			this.#reconcileStreamedToolCallIds(this.ctx.streamingMessage.content);
			batch(() => {
				streaming.transient.set(false);
				streaming.message.set(displayTimeline.beforeTools);
			});

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
				}
			} else {
				// The turn ended without running these calls. What happens next
				// decides whether their cards should vanish or stay:
				//   • TTSR rewind — known NOW via `isTtsrAbortPending` — re-runs the
				//     turn and re-streams fresh cards, so retract the uncommitted
				//     never-run cards here and swallow the synthetic completions
				//     agent-loop emits for them, else the call renders twice (#6879).
				//   • A plain terminal error/abort, or an auto-retry (whose
				//     supersession is only known later at `auto_retry_start`), must
				//     NOT be retracted here: agent-loop emits a synthetic
				//     `tool_execution_end` right after this that settles each card
				//     into a visible aborted/error result. Leave them so the terminal
				//     failure stays visible; `#handleAutoRetryStart` removes them only
				//     if a retry actually supersedes them (Codex review on #6881).
				const supersededByRewind =
					this.ctx.streamingMessage.stopReason === "aborted" && this.ctx.viewSession.isTtsrAbortPending;
				if (supersededByRewind) {
					streaming.rewound.set(true);
					for (const [toolCallId, tool] of Array.from(this.ctx.pendingTools.entries())) {
						if (this.#backgroundCallIds.has(toolCallId)) continue;
						if (!this.ctx.shell.transcript.retired(tool.block)) {
							this.#retractToolCardEntry(toolCallId, tool);
							this.#retractedToolCallIds.add(toolCallId);
						} else {
							tool.seal();
						}
					}
				}
				// These calls will never run this attempt, so the tracked waiting
				// poll cannot be displaced anymore — freeze it in place.
				this.#resolveDisplaceablePoll();
			}
			// Surface a prompt-cache invalidation: if the previous turn cached a
			// meaningful prefix and this request read none of it back, flag the turn.
			const usage = event.message.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				if (cfgDisplayCacheMissMarker.get(settings)) {
					const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
					if (invalidation) streaming.cacheInvalidation.set(invalidation);
				}
				this.ctx.lastAssistantUsage = usage;
			}
			streaming.servedModelMismatch.set(this.ctx.servedModelTracker.check(event.message));
			streaming.finalized.set(true);
			let lastPostToolAssistantComponent: AssistantView | undefined;
			for (const [toolCallId, segment] of displayTimeline.afterToolCalls) {
				const component = this.#upsertPostToolAssistantSegment(
					toolCallId,
					segment,
					displayTimeline.contentOffsets.get(toolCallId),
					assistantMessageLinkTargets(segment, linkTargets),
				);
				component?.finalized.set(true);
				if (component) lastPostToolAssistantComponent = component;
			}
			const lastAssistant = lastPostToolAssistantComponent ?? streaming;
			this.#lastAssistantComponent = lastAssistant;
			const turnUsage = this.#turnUsage.add(event.message, this.#turnStartedAt);
			if (turnUsage) lastAssistant.turnUsage.set(turnUsage);
			if (cfgDisplayShowTokenUsage.get(settings) && assistantUsageIsBilled(event.message.usage)) {
				const readCallIds = groupedReadUsageCallIds(event.message);
				const turnElapsed = cfgDisplayShowTurnTime.get(settings)
					? turnElapsedMs(this.#turnStartedAt, event.message)
					: undefined;
				const usageAttached =
					readCallIds !== undefined &&
					(this.#lastReadGroup?.group?.attachUsage(
						readCallIds,
						event.message.usage,
						event.message.duration,
						event.message.ttft,
						event.message.timestamp,
						turnElapsed,
					) ??
						false);
				if (!usageAttached) {
					this.#resetReadGroup();
					// A usage row below a waiting poll closes its displacement window: the poll stays as history.
					this.#resolveDisplaceablePoll();
					const { usage, duration, ttft, timestamp } = event.message;
					this.ctx.present(() =>
						usageRowBlock({
							usage,
							durationMs: duration,
							ttftMs: ttft,
							timestamp,
							turnElapsedMs: turnElapsed,
						}),
					);
				}
			}
			if (displayMessage === event.message) this.ctx.transcriptBlocks.set(event.message, streaming.block);
			this.ctx.streaming = undefined;
			this.ctx.streamingMessage = undefined;
			// Pin a turn-ending provider error above the editor so it survives
			// transcript scroll and suppress its duplicate inline row. Empty-output
			// errors are known intermediate attempts: hide them entirely while
			// session recovery continues, but retain the component so a terminal
			// retry-cap event can promote its final error into the one banner.
			if (event.message.stopReason === "error" && event.message.errorMessage && !isSilentAbort(event.message)) {
				const recoverableEmptyOutput =
					!event.message.errorMessage.startsWith("Retry budget exhausted") &&
					AIError.is(AIError.classifyMessage(event.message), AIError.Flag.EmptyResponse);
				lastAssistant.errorPinned.set(true);
				this.#pinnedErrorComponent = lastAssistant;
				this.#pinnedErrorMessage = event.message;
				this.#restorePinnedErrorInline = !recoverableEmptyOutput;
				if (!recoverableEmptyOutput) this.ctx.showPinnedError(event.message.errorMessage);
			}
			this.ctx.statusLine.refresh();
		}
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		if (this.#retractedToolCallIds.has(event.toolCallId)) return;
		this.#ensureWorkingLoaderWhileStreaming();
		this.#updateWorkingMessageFromIntent(
			workingIntentLabel(event.intent ?? (isRecord(event.args) ? event.args[INTENT_FIELD] : undefined)),
		);
		const tool = this.ctx.viewSession.getToolByName(event.toolName);
		const renderToolName = toolRenderName(event.toolName, tool);
		this.#resolveDisplaceablePoll(renderToolName);
		if (!this.ctx.pendingTools.has(event.toolCallId) && !this.#toolTimelineComponents.has(event.toolCallId)) {
			const stale = this.#priorTurnToolComponents.get(event.toolCallId);
			if (stale) {
				this.#priorTurnToolComponents.delete(event.toolCallId);
				// Never evict a shared read-group card: it may still carry sibling reads.
				if (stale.call && this.ctx.shell.transcript.blocks().includes(stale.block)) {
					this.ctx.shell.transcript.remove(stale.block);
				}
			}
			if (renderToolName === "read" && readArgsCollapseIntoGroup(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const group = this.#getReadGroup();
				group.updateArgs(event.args, event.toolCallId);
				this.ctx.pendingTools.set(event.toolCallId, group);
				this.#toolTimelineComponents.set(event.toolCallId, group);
				this.#settleHeldCompletionIfPresent(event.toolCallId, group);
				this.#startToolApprovalPreview(event.toolCallId);
				return;
			}

			this.#resetReadGroup();
			const component = this.#presentToolCard(
				event.toolCallId,
				renderToolName,
				renderArgsWithIntent(event.args, event.intent),
				tool,
			);
			component.setArgsComplete(event.toolCallId);
			component.setExecutionStarted(event.toolCallId);
			this.#executionStartedCallIds.add(event.toolCallId);
			this.#settleHeldCompletionIfPresent(event.toolCallId, component);
		} else {
			// The tool is about to run, so its arguments are final and validated.
			// A pending component created while args streamed (message_update) may
			// still show a mid-reveal prefix — or, when the closing full-args
			// `message_update` never lands (smooth-streaming off leaving the
			// throttled `arguments` stale, an owned-dialect projector, or a
			// superseded/aborted turn that still executes the call), a stale body
			// the result render then freezes at its `…` placeholder. Reconcile the
			// authoritative args here and drop any live reveal so a late tick can't
			// re-truncate them: tool_execution_start is the one event every
			// execution path emits with the full args immediately before the result.
			// Also reuses a card already settled in `#toolTimelineComponents` (when
			// `restoreAssistant` consumed a buffered result ahead of a queued start).
			// That card stays out of `pendingTools`: call ids are unique within a
			// run and the timeline is cleared at agent_start/agent_end, so a
			// timeline-only hit cannot be a fresh execution — its queued
			// update/end duplicate the settled result and are dropped as such.
			this.#toolArgsReveal.finish(event.toolCallId);
			if (renderToolName === "read" && readArgsCollapseIntoGroup(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
			}
			const component =
				this.ctx.pendingTools.get(event.toolCallId) ?? this.#toolTimelineComponents.get(event.toolCallId);
			if (component) {
				component.updateArgs(renderArgsWithIntent(event.args, event.intent), event.toolCallId);
				component.setArgsComplete(event.toolCallId);
				component.setExecutionStarted(event.toolCallId);
				this.#executionStartedCallIds.add(event.toolCallId);
			}
		}
		this.#startToolApprovalPreview(event.toolCallId);
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		this.#showToolReplies(event.toolCallId, event.partialResult.details);
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const isFinalAsyncState = isSettledJobFrame(event.partialResult.details);
			// A final async snapshot is terminal only for a parked background
			// block (the call already returned and was kept alive for its jobs).
			// While the call is still executing — a mixed blocking+async task
			// call whose jobs settle before its blocking subset — treat it as a
			// partial frame: `tool_execution_end` still owns the terminal result.
			const isParkedFinal = isFinalAsyncState && this.#backgroundCallIds.has(event.toolCallId);
			if (isParkedFinal) {
				settleWithJobFrame(component, event.partialResult, event.toolCallId);
				this.#releasePendingTool(event.toolCallId, component);
				this.#backgroundCallIds.delete(event.toolCallId);
			} else {
				if (isFinalAsyncState) this.#settledBeforeReturn.set(event.toolCallId, event);
				const isError = asyncJobState(event.partialResult.details) === "failed";
				component.updateResult({ ...event.partialResult, isError }, true, event.toolCallId);
			}
		}
	}

	#settleHeldCompletionIfPresent(toolCallId: string, component: PendingTool): void {
		const event = this.#orphanedToolCompletions.get(toolCallId);
		if (!event) return;
		this.#orphanedToolCompletions.delete(toolCallId);
		this.#settleHeldCompletion(component, event);
	}

	/**
	 * Attach a held completion to the component that was created for it after
	 * the fact (see {@link #orphanedToolCompletions}) and settle the card.
	 *
	 * Deliberately NOT a re-entry into `#handleToolExecutionEnd`: every
	 * user-facing side effect of that handler — the todo panel refresh, the
	 * failure warning, plan approval, the terminal-title transition — already
	 * ran when the completion first arrived. Replaying the whole handler would
	 * show the same warning twice and re-push an identical `setTodos`. Only the
	 * component half was missed, because the component did not exist yet.
	 */
	#settleHeldCompletion(
		component: PendingTool,
		event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	): void {
		if (event.toolName === "read") this.#inlineReadToolImages(event.toolCallId, event.result);
		this.#applyToolCompletion(component, event);
		if (event.toolName === "read") this.#clearReadToolCall(event.toolCallId);
		// Mirrors the displacement bookkeeping in `#handleToolExecutionEnd`:
		// a successful snapshot supersedes the previous live panel.
		if (event.toolName === "todo" && displaceableBy(component) === "todo") this.#adoptTodoSnapshot(component);
	}

	/**
	 * A successful `todo` snapshot replaces the previous one. Rows of it already in scrollback
	 * stay as history: removing them would rewrite all of it.
	 */
	#adoptTodoSnapshot(tool: PendingTool): void {
		const previous = this.#displaceableTodoComponent;
		if (previous && previous !== tool && displaceableBy(previous) !== undefined) {
			previous.seal();
			const transcript = this.ctx.shell.transcript;
			if (!transcript.retired(previous.block)) transcript.remove(previous.block);
		}
		this.#displaceableTodoComponent = tool;
	}

	#applyToolCompletion(
		component: PendingTool,
		event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	): void {
		const settled = this.#settledBeforeReturn.get(event.toolCallId)?.partialResult;
		this.#settledBeforeReturn.delete(event.toolCallId);
		const parks = parksAsBackground(event.toolName, event.result.details, this.ctx.shell.native());
		if (parks && settled) {
			// The job finished before the call returned: its settled frame, not the
			// `running` start result, is the card's final state.
			settleWithJobFrame(component, settled, event.toolCallId);
			this.#releasePendingTool(event.toolCallId, component);
			return;
		}
		component.updateResult({ ...event.result, isError: event.isError }, parks, event.toolCallId);
		if (parks) {
			component.parkAsBackground();
			// The call returned: its card is final for the transcript (a native terminal still
			// repaints it with the job's frames; a plain one retires it as it stands).
			this.ctx.shell.transcript.settle(component.block);
			this.#backgroundCallIds.add(event.toolCallId);
		} else {
			this.#releasePendingTool(event.toolCallId, component);
			this.#backgroundCallIds.delete(event.toolCallId);
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		// `createAbortedToolResult` emits start/end after an error/aborted
		// assistant message. The matching card was deliberately retracted at
		// message_end; consume the completion instead of recreating/updating UI.
		if (this.#retractedToolCallIds.delete(event.toolCallId)) return;
		this.#executionStartedCallIds.delete(event.toolCallId);
		this.#showToolReplies(event.toolCallId, event.result.details);
		// A synthetic aborted/error completion (agent-loop's placeholder for a
		// never-run call on a terminal error/abort) settles the card in place so a
		// terminal failure stays visible. Remember it so `#handleAutoRetryStart`
		// can remove it if an auto-retry then supersedes the turn (Codex review on
		// #6881). Capture the live component now — the settle path below drops it
		// from `pendingTools` but leaves it in the transcript.
		const syntheticFailureDetails = event.result.details as { __synthetic?: boolean; source?: string } | undefined;
		const syntheticFailureCard =
			syntheticFailureDetails?.__synthetic === true &&
			(syntheticFailureDetails.source === "assistant_stop_error" ||
				syntheticFailureDetails.source === "assistant_stop_aborted")
				? this.ctx.pendingTools.get(event.toolCallId)
				: undefined;
		// A transient overlay (auto-compaction / auto-retry / handoff) that ran
		// between this tool's start and end could have detached the working
		// loader. `tool_execution_update` already reconciles this so the spinner
		// reappears mid-tool; mirror it here so subagent (`task`) completions —
		// which only fire `tool_execution_end`, never `_update` — do not leave
		// the UI looking idle while the session keeps streaming (#3857).
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.#releasePendingTool(event.toolCallId, component);
				}
				this.#clearReadToolCall(event.toolCallId);
			} else {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					// A persisted result can win a mid-stream transcript rebuild
					// before this live completion handler runs. Rebuild removes the
					// pending handle and replay owns the completed card, but the
					// original timeline entry remains as proof that a card already
					// existed. Do not create a fallback read group beside replay
					// (#6879). A completion that outran every streamed card is held
					// and settled when the card is created, matching non-read tools.
					if (this.#toolTimelineComponents.has(event.toolCallId)) {
						this.#clearReadToolCall(event.toolCallId);
						return;
					}
					this.#orphanedToolCompletions.set(event.toolCallId, event);
				} else {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.#releasePendingTool(event.toolCallId, component);
					this.#clearReadToolCall(event.toolCallId);
				}
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				this.#applyToolCompletion(component, event);
				const displaceable = displaceableBy(component);
				if (displaceable === "wait" && event.toolName === "wait") {
					// Remember the waiting poll so the next `wait` call can displace it.
					this.#displaceablePollComponent = component;
				} else if (displaceable === "todo" && event.toolName === "todo") {
					// Successful todo update supersedes the prior live snapshot. A failed
					// follow-up never reaches this branch (errored results are not
					// displaceable), so the last-good panel stays on screen.
					this.#adoptTodoSnapshot(component);
				}
			} else if (!this.#toolTimelineComponents.has(event.toolCallId)) {
				// No component yet: the async streamed-block handler lost the race
				// to this completion. Hold the result instead of dropping it. Any
				// tool can finish inside that scheduling window; user-facing side
				// effects below still run now, and `#settleHeldCompletion` later
				// updates only the card.
				this.#orphanedToolCompletions.set(event.toolCallId, event);
			}
		}
		if (syntheticFailureCard) this.#syntheticFailureCards.set(event.toolCallId, syntheticFailureCard);
		if (event.toolName === "todo" && !event.isError) {
			const details = event.result.details as { op?: string; phases?: TodoPhase[] } | undefined;
			if (details?.op !== "view" && details?.phases) this.ctx.setTodos(details.phases);
		}
		if (event.toolName === "eval" && hasNestedTodo(event.result.details)) {
			this.ctx.setTodos(this.ctx.viewSession.getTodoPhases());
		}
		if (event.toolName === "todo" && event.isError) {
			const textContent = event.result.content.find(
				(content: { type: string; text?: string }) => content.type === "text",
			)?.text;
			// This text can be a provider error copied verbatim off the wire (the
			// Cursor todo bridge forwards the server's string), so it may carry
			// ANSI escapes, other C0/C1 controls, tabs, newlines, or a line far
			// wider than the terminal. `showWarning` renders through a plain `Text`,
			// which strips none of that — an escape reaches the terminal
			// and can repaint outside the row. `sanitizeText` drops the control
			// sequences (and returns the same reference when there are none),
			// then `previewLine` collapses the remaining whitespace and bounds
			// the width. Sanitizing first matters: truncating before stripping
			// can cut an escape mid-sequence and leave a dangling introducer.
			//
			// This is the render boundary, not the persisted result: the stored
			// error stays full-fidelity for the transcript and for replays.
			const detail = textContent ? previewLine(sanitizeText(textContent), TRUNCATE_LENGTHS.LINE) : "";
			this.ctx.showWarning(
				`Todo update failed${detail ? `: ${detail}` : ". Progress may be stale until todo succeeds."}`,
				{ hideWithToolActivity: true },
			);
		}
		// A submitted plan carries the approval payload as the `propose` details:
		// on a direct `propose` result, or on its execute record in a `bash` run.
		// A failed direct `propose` submitted nothing; a `bash` run is judged by
		// each record's own exit status, not the outer shell status.
		const details =
			event.isError && event.toolName === PROPOSE_COMMAND_NAME
				? undefined
				: planApprovalDetails(proposeDispatchDetails(event.toolName, event.result));
		if (details) {
			// Dispatch the approval WITHOUT blocking the serialized event
			// dispatch chain. `handlePlanApproval` -> `#approvePlan` awaits
			// `session.prompt` for the ENTIRE approved-execution turn; awaiting
			// it here (this handler runs inside `#runSerialized`) would hold the
			// single dispatch link for the whole run, so the run's own
			// agent_start / message_start / tool / coalesced message_update
			// events queue behind it on `#dispatchTail` and the chat stays blank
			// until execution finishes (issue #7684, follow-up to #5688 which
			// only closed the overlay). Detaching frees the link the moment this
			// handler returns; the approval overlay and the turn's live events
			// then render. The approval flow surfaces its own failures via
			// `showError`, so only an unexpected rejection is logged here.
			void this.ctx.handlePlanApproval(details).catch(err => {
				logger.warn("Plan approval dispatch failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	}
	/**
	 * A model loop stopped and the run goes on. Nothing is torn down and the
	 * program status stays `working`: the session's own continuation follows
	 * (`yielded: false`), or queued input, a peer message, a background job or a
	 * child agent resumes it (`yielded: true`), or the run's `agent_end` closes it.
	 */
	async #handleAgentPause(event: Extract<AgentSessionEvent, { type: "agent_pause" }>): Promise<void> {
		if (event.yielded) this.showAsyncWait();
		// The plan-mode reconciler queues a model switch to apply once the current
		// stream ends; the continuation must not run on the old model.
		await this.ctx.flushPendingModelSwitch();
		// Nothing streams now, so a command issued from here mounts immediately;
		// earlier queued panels would otherwise render out of order much later.
		this.ctx.flushPendingCommandOutput();
	}

	async #handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		const stoppedWaiting = this.#stoppedWaiting;
		this.#stoppedWaiting = false;
		const view = this.ctx.viewSession;
		// A run is open again by the time this event reaches the serialized
		// dispatch chain: a superseded end, or a subscriber that started the next
		// run while this one waited. That ended run still owns its teardown, but
		// it must not report `done`/`idle` now — that tells OSC 7501 receivers
		// such as Rex the agent finished while it is still working (#17307).
		const runActive = this.ctx.session.isRunActive;
		if (view !== this.ctx.session && runActive) {
			// A focused worker's run ended while main's run goes on: tear down
			// only what the viewed worker owns (its working row); main's status stays
			// `working` until main's own `agent_end`.
			this.ctx.clearWorking("turn");
			return;
		}
		if (stoppedWaiting) {
			if (!runActive) setRunStatus({ state: "idle" });
			await this.#finishAgentEnd(event, { interrupted: true });
			const running = this.ctx.session.getAsyncJobSnapshot()?.running.length ?? 0;
			if (running > 0) {
				this.ctx.showStatus(
					`Stopped waiting · ${running} background ${running === 1 ? "job" : "jobs"} still running (/jobs)`,
				);
			}
		} else {
			if (!runActive) setRunStatus(this.#settledRunStatus(event));
			await this.#finishAgentEnd(event);
		}
		// This run may be extension-started while the main input loop remains
		// asleep. Do not await session-idle from its own event.
		if (this.ctx.shutdownRequested) this.ctx.requestShutdown();
	}

	/**
	 * When the main session's run is paused waiting only on outside sources, the
	 * working row says so and names the jobs and child agents, instead of
	 * repeating the last tool call's intent. The label is live, so a job
	 * cancelled without a wake (`/jobs kill`) leaves the row at once. Shown
	 * when the run yields into the wait (its `agent_pause`, a focus return), and
	 * again by {@link restoreAsyncWait}; the next loop or the run's `agent_end`
	 * takes it over.
	 */
	showAsyncWait(): void {
		const session = this.ctx.session;
		if (this.ctx.viewSession !== session || !this.isAwaitingAsyncWork()) return;
		this.#showingAsyncWait = true;
		this.ctx.ensureWorkingRow();
		this.ctx.setWorkingMessage(() => formatAsyncWaitLabel(session.wakeSources));
	}

	/**
	 * Put the wait row back after another row (an error, a maintenance step, the
	 * prompt's own settle) came down while a yielded run still waits. A gap the
	 * run did not yield in (a continuation between its loops) gets no wait label.
	 */
	restoreAsyncWait(): void {
		if (this.#showingAsyncWait) this.showAsyncWait();
	}

	/** The main run is paused waiting only on outside sources, and the interrupt key would end that wait. */
	isAwaitingAsyncWork(): boolean {
		const session = this.ctx.session;
		return session.isRunActive && !session.isStreaming && session.wakeSources !== undefined;
	}

	/**
	 * End a wait on outside work (Esc while {@link isAwaitingAsyncWork}). The
	 * user interrupt ends the paused run with `agent_end` right away; background
	 * results then land in context for the next prompt and the jobs keep running.
	 * That `agent_end` is torn down as user-interrupted and says what still runs.
	 */
	async stopAwaitingAsyncWork(): Promise<void> {
		if (!this.isAwaitingAsyncWork()) return;
		this.#stoppedWaiting = true;
		try {
			await this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		} catch (error) {
			this.#stoppedWaiting = false;
			logger.warn("Ending the background-work wait failed", {
				error: String(error),
			});
		}
	}

	/**
	 * The run status a settled turn leaves: `done` with a result to read,
	 * `error` with the failure, or `idle` when there is nothing new — the user
	 * interrupted, or a pending auto-retry will start the turn over (a cancelled
	 * retry leaves the user at the prompt). Reads the turn's own `agent_end`
	 * messages for the reason `sendErrorNotification` does.
	 */
	#settledRunStatus(event: Extract<AgentSessionEvent, { type: "agent_end" }>): RunFlowStatus {
		if (this.#retryPending) return { state: "idle" };
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason === "error") return { state: "error", msg: last.errorMessage };
		if (!last || last.stopReason === "aborted") return { state: "idle" };
		return { state: "done" };
	}

	async #finishAgentEnd(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		options?: { interrupted?: boolean },
	): Promise<void> {
		this.#showingAsyncWait = false;
		this.#setTerminalProgress(false);
		this.ctx.statusLine.markActivityEnd();
		this.#lastAgentEndAt = Date.now();
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		this.ctx.clearWorking("turn");
		await this.ctx.flushPendingModelSwitch();
		this.#sealAbandonedForegroundTools();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#priorTurnToolComponents = new Map(this.#toolTimelineComponents);
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#pendingStreamPreviews.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#toolReplyBlocks.clear();
		this.#resetReadGroup();
		// The turn is over: nothing else lands this turn, so the waiting poll is
		// final history — seal it instead of letting its spinner tick while idle.
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		this.ctx.flushPendingCommandOutput();
		this.#lastAssistantComponent = undefined;
		// When the interrupted/failed turn died on a tool call, this replaces the
		// torn-down "Working…" row with the "F5 to Retry" affordance.
		this.ctx.syncRetryHintRow();
		// The run yielded: a `/compact` queued behind it runs now. A run the user stopped (Esc, including
		// the loop-mode pause) did not yield: the request goes back to the editor like other queued input.
		if (this.ctx.yieldCompaction) {
			const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			const userStopped = options?.interrupted || (last?.stopReason === "aborted" && isUserInterruptAbort(last));
			if (userStopped)
				this.ctx.restoreCompactionQueueToEditor("Run stopped: queued compaction returned to the editor");
			else this.ctx.runYieldCompaction();
		}
		// The user stopped the run themselves: no prediction or toast for it.
		if (options?.interrupted) return;
		if (this.#settledRunStatus(event).state === "done") this.composerPrediction.request();
		this.sendErrorNotification(event);
		this.sendCompletionNotification(event);
	}

	/**
	 * Restore the turn's working row when a streaming event lands after a
	 * transient row (compaction, retry) took the status row down. Focus mode
	 * dispatches events for `viewSession`, so key it on that session, not the
	 * main one. A row a maintenance run holds stays.
	 */
	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.working === "compaction" || this.ctx.working === "retry") return;
		this.ctx.ensureWorkingRow();
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.composerPrediction.cancel();
		if (!this.#terminalProgressActive) {
			this.#setTerminalProgress(true);
			this.#compactionOwnsProgress = this.#terminalProgressActive;
		}
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel =
			event.action === "remote"
				? "Auto server compaction"
				: event.action === "handoff"
					? "Auto-handoff"
					: event.action === "shake"
						? "Auto-shake"
						: event.action === "snapcompact"
							? "Auto-snapcompact"
							: "Auto context-full maintenance";
		// Replaces the turn's row; while a subagent is focused Esc returns to main
		// instead of cancelling (#2819), so the row offers no cancel then.
		this.ctx.showWorking("compaction", {
			label: `${reasonText}${actionLabel}…`,
			startedAt: Date.now(),
			variant: { kind: "compaction" },
			interruptKey: this.ctx.maintenanceInterruptKey(),
		});
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		if (this.#compactionOwnsProgress) {
			this.#compactionOwnsProgress = false;
			this.#setTerminalProgress(false);
		}
		this.ctx.clearWorking("compaction");
		const isHandoffAction = event.action === "handoff";
		const isRemoteAction = event.action === "remote";
		const isShakeAction = event.action === "shake";
		const isSnapcompactAction = event.action === "snapcompact";
		if (event.aborted) {
			this.ctx.showStatus(
				isHandoffAction
					? "Auto-handoff cancelled"
					: isRemoteAction
						? "Auto server compaction cancelled"
						: isShakeAction
							? "Auto-shake cancelled"
							: isSnapcompactAction
								? "Auto-snapcompact cancelled"
								: "Auto context-full maintenance cancelled",
			);
		} else if (isShakeAction) {
			// Shake produces no CompactionResult; rebuild on success, suppress benign skips.
			// The fallback path (`errorMessage` set, `skipped` false) means shake reclaimed
			// some tokens before deciding the threshold still wasn't cleared — rebuild so
			// the chat reflects the dropped regions even though a context-full pass follows.
			if (event.errorMessage) {
				if (!event.skipped) {
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.refresh();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.lastAssistantUsage = undefined;
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.refresh();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.refresh();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			this.ctx.clearTransientSessionUi();
			this.ctx.lastAssistantUsage = undefined;
			await this.ctx.renderInitialMessages();
			this.ctx.statusLine.refresh();
			await this.ctx.reloadTodos();
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
		} else if (isSnapcompactAction) {
			this.ctx.showWarning("Auto-snapcompact maintenance failed; continuing without maintenance");
		} else if (isRemoteAction) {
			this.ctx.showWarning("Auto server compaction failed; continuing without maintenance");
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#retryPending = true;
		this.#trackRetrySupersededAssistantComponent(this.#lastAssistantComponent);
		// A retry supersedes the just-failed turn: its assistant + tool calls are
		// pruned from context and re-streamed. Remove the cards that a synthetic
		// aborted/error completion settled in place at message_end so the retry's
		// fresh cards don't render the same call twice (#6879). Only uncommitted
		// cards are removable; one already on the scrollback tape stays as history.
		for (const [toolCallId, tool] of this.#syntheticFailureCards) {
			if (!this.ctx.shell.transcript.retired(tool.block)) this.#retractToolCardEntry(toolCallId, tool);
		}
		this.#syntheticFailureCards.clear();
		// The failed attempt is not the turn's outcome while a retry is pending:
		// unpin its banner and keep its inline error hidden, so a recovered retry
		// leaves no error in the transcript. The retry row names the reason;
		// `auto_retry_end` marks the attempt recovered or superseded, or restores
		// its error when the saga fails without accounting for it.
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.ctx.clearPinnedError();
		const reason = previewLine(sanitizeText(event.errorMessage), TRUNCATE_LENGTHS.CONTENT);
		// Replaces the turn's row with the countdown.
		this.ctx.showWorking("retry", {
			label: `Retrying (${event.attempt}/${event.maxAttempts})`,
			startedAt: Date.now(),
			variant: {
				kind: "retry",
				attempt: event.attempt,
				max: event.maxAttempts,
				delayMs: event.delayMs,
				reason: reason || undefined,
			},
			interruptKey: this.ctx.maintenanceInterruptKey(),
		});
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		this.#retryPending = false;
		this.ctx.clearWorking("retry");
		const pinnedError = this.#pinnedErrorMessage?.errorMessage;
		const terminalFailurePinned =
			!event.success &&
			this.#pinnedErrorComponent !== undefined &&
			pinnedError !== undefined &&
			pinnedError === event.finalError;
		let stalePinnedErrorCleared = false;
		if (!event.success && this.#pinnedErrorComponent && !terminalFailurePinned) {
			this.#pinnedErrorComponent.errorPinned.set(false);
			this.#pinnedErrorComponent = undefined;
			this.#pinnedErrorMessage = undefined;
			this.#restorePinnedErrorInline = true;
			this.ctx.clearPinnedError();
			stalePinnedErrorCleared = true;
		}
		let appliedRetryUpdate = false;
		for (const retryError of event.retryErrors ?? []) {
			const component = this.#takeRetrySupersededAssistantComponent(retryError.persistenceKey);
			if (!component) continue;
			const recovered = component.message.peek();
			if (recovered && retryError.retryRecovery) {
				batch(() => {
					component.errorPinned.set(false);
					component.message.set({
						...recovered,
						retryRecovery: retryError.retryRecovery,
					});
				});
			}
			if (!terminalFailurePinned && this.#pinnedErrorComponent === component) {
				this.#pinnedErrorComponent = undefined;
				this.#pinnedErrorMessage = undefined;
				this.#restorePinnedErrorInline = true;
			}
			appliedRetryUpdate = true;
		}
		if (!event.success) {
			// Attempts the saga did not account for (a cancelled wait, a failed
			// local continuation) were hidden at `auto_retry_start`; show their errors.
			for (const component of this.#retrySupersededAssistantQueue) {
				if (component !== this.#pinnedErrorComponent) component.errorPinned.set(false);
			}
		}
		if (
			!terminalFailurePinned &&
			!stalePinnedErrorCleared &&
			(appliedRetryUpdate || (event.retryErrors?.length ?? 0) > 0)
		) {
			this.ctx.clearPinnedError();
		}
		this.#clearRetrySupersededAssistantComponents();
		if (!event.success) {
			if (terminalFailurePinned) {
				const terminalError = this.#restorePinnedErrorInline
					? `Retry failed after ${event.attempt} attempts: ${event.finalError || pinnedError || "Unknown error"}`
					: (pinnedError ?? event.finalError);
				if (terminalError) this.ctx.showPinnedError(terminalError);
				this.#restorePinnedErrorInline = true;
			} else {
				this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
		}
		this.#ensureWorkingLoaderWhileStreaming();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		const reason = event.reason
			? `\n${previewLine(sanitizeText(event.reason), TRUNCATE_LENGTHS.LINE * PREVIEW_LIMITS.COLLAPSED_LINES)}`
			: "";
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}${reason}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		// Consecutive notifications (e.g. per-tool matches from one assistant
		// message) merge into the previous block instead of stacking — only while
		// it is still the transcript tail and none of its rows reached terminal
		// scrollback (a grown block would shift rows already there).
		const previous = this.#lastTtsrNotification;
		const transcript = this.ctx.shell.transcript;
		if (previous && transcript.blocks().at(-1) === previous.block && !transcript.retired(previous.block)) {
			previous.rules.set(mergeRules(previous.rules.peek(), event.rules));
			return;
		}
		const rules = signal<readonly NotificationRule[]>(mergeRules([], event.rules));
		const block = this.ctx.present(() =>
			ttsrBlock(
				rules,
				() => this.ctx.toolOutputExpanded,
				() => !this.ctx.hideToolActivity,
			),
		);
		this.#lastTtsrNotification = { block, rules };
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const { todos, attempt, maxAttempts } = event;
		this.ctx.present(() => todoReminderBlock(todos, attempt, maxAttempts, () => !this.ctx.hideToolActivity));
	}
	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	sendErrorNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// `AgentSession` defers and coalesces the wire-level `agent_end` while a
		// prompt is still in flight (see `#emitSessionEvent` in agent-session.ts):
		// every mid-retry attempt's own settle is superseded, so this method often
		// sees only ONE `agent_end` for an entire multi-attempt retry saga — which
		// can be the final failure, not an intermediate one. Gate purely on the
		// retry lifecycle (`auto_retry_start`/`auto_retry_end`, which are never
		// deferred) rather than consuming this flag against whichever `agent_end`
		// happens to arrive first: `#retryPending` is true only for the actual
		// window a retry is outstanding, so the settled failure that survives
		// coalescing is never mistaken for a mid-retry blip.
		if (this.#retryPending) return;

		// Warp structured OSC 777 already drives native completion UX when the
		// protocol is negotiated — avoid a second legacy desktop/OSC-9 toast.
		if (isWarpCliAgentProtocolActive()) return;

		const notify = cfgErrorNotify.get(settings);
		if (notify === "off") return;

		// Read the turn's own outcome from `agent_end.messages`, not the mutable
		// active context: a classifier-refusal failure is final (stopReason ===
		// "error") but gets pruned from `viewSession`'s active context before this
		// handler runs (see `#removeAssistantMessageFromActiveContext` in
		// agent-session.ts), so `getLastAssistantMessage()` would see a stale or
		// absent assistant and silently drop the notification.
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason !== "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		notifyTerminal({
			title: sessionName || "omp",
			body: "Stopped with error",
			type: "error",
			actions: "focus",
		});
	}

	sendCompletionNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const notify = cfgCompletionNotify.get(settings);
		if (notify === "off") return;

		// Warp structured OSC 777 already drives native completion UX when the
		// protocol is negotiated — avoid a second legacy desktop/OSC-9 toast.
		if (isWarpCliAgentProtocolActive()) return;

		// Read the turn's own outcome from `agent_end.messages`, not the mutable
		// active context (see `sendErrorNotification` above for why `viewSession`'s
		// snapshot can be stale): an aborted or errored turn is not "Task
		// complete", and using the same event `sendErrorNotification` just read
		// keeps the two notifications mutually exclusive for one settled turn.
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		notifyTerminal({
			title: sessionName || "omp",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}
