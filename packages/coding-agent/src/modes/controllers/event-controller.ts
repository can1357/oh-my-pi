import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings";
import { getEditClipboard } from "../../edit/edit-clipboard";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
	readArgsHaveTarget,
} from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import idleRecapPrompt from "../../prompts/system/recap-user.md" with { type: "text" };
import type { AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, isUserInvokedSkillPrompt, readQueueChipText, resolveAbortLabel } from "../../session/messages";
import { type ApprovalMode, resolveApproval } from "../../tools/approval";
import { previewLine, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { PROPOSE_DEVICE_NAME, writeDeviceDispatch } from "../../tools/resolve";
import { nextActionableTask } from "../../tools/todo";
import { SpeechEnhancer } from "../../tts/speech-enhancer";
import { vocalizer } from "../../tts/vocalizer";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { setTerminalTitleState } from "../../utils/title-generator";
import { interruptHint } from "../shared";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { isWarpCliAgentProtocolActive } from "../warp-events";
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
const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

const RAW_PARTIAL_JSON_RENDERERS: Record<string, true> = { bash: true, edit: true, apply_patch: true };

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

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	// Count of visible assistant content blocks (rendered non-empty text/thinking)
	// already seen in the current streaming message. A newly appearing one breaks
	// the read run: the rendered reasoning/answer is a visual separator, so reads
	// after it start a fresh group. Empty/absent thinking — common when a model
	// emits one read per completion — does not break it, so a run of consecutive
	// reads collapses into one group even across completion boundaries.
	#lastVisibleBlockCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundTaskCallIds = new Set<string>();
	/** Tool calls whose approval prompt drove the title into `attention`; cleared
	 *  at their tool_execution_end so the title returns to `working`. */
	#approvalAttentionToolCallIds = new Set<string>();
	#approvalPreviewGates = new Map<string, ApprovalPreviewGate>();
	#detachToolApprovalPreviewWaiter: (() => void) | undefined;
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#toolTimelineComponents = new Map<string, Component>();
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
	// Cards settled by a synthetic aborted/error `tool_execution_end` (agent-loop
	// emits one per never-run call on a terminal error/abort). They stay visible
	// for a genuinely terminal failure, but if an auto-retry then supersedes the
	// turn (`auto_retry_start`, decided AFTER message_end) they must be removed so
	// the retry's fresh cards do not render the same call twice (Codex review on
	// #6881). Keyed by call id; reset per turn.
	#syntheticFailureCards = new Map<string, ToolExecutionHandle>();
	// Completions can outrun their streamed tool-call block: server-resolved
	// tools may finish synchronously, and any sufficiently fast tool can settle
	// before the UI dispatch creates its card. Hold the result
	// so the eventual card finalizes instead of pinning transcript retirement.
	// User-facing side effects run only on first arrival; only the component
	// update is deferred. Call ids are unique per turn, and this map is cleared
	// with the other transcript anchors.
	#orphanedToolCompletions = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>();
	#postToolAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#pinnedErrorMessage: AssistantMessage | undefined = undefined;
	#restorePinnedErrorInline = true;
	#retrySupersededAssistantComponents = new Map<string, AssistantMessageComponent>();
	#retrySupersededAssistantQueue: AssistantMessageComponent[] = [];
	// Set when `auto_retry_start` fires and cleared by `auto_retry_end` (both
	// outcomes) — true for exactly the window a retry is outstanding. Gates
	// `sendErrorNotification`: the wire-level `agent_end` for a retryable
	// failure is coalesced with every other attempt in the same saga while the
	// prompt is in flight (see `AgentSession#emitSessionEvent`), so the single
	// `agent_end` that survives to reach this controller can be either a
	// mid-retry blip or the final settle — only the retry lifecycle events
	// (never deferred) can tell them apart.
	#retryPending = false;
	#idleCompactionTimer?: NodeJS.Timeout;
	#idleRecapTimer?: NodeJS.Timeout;
	// In-flight ephemeral recap turn; aborted by #cancelIdleRecap when any
	// activity (new turn, compaction, editor draft) supersedes the idle recap.
	#idleRecapAbort?: AbortController;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// components each card contributed (see #retireIrcCard for the guard).
	#liveIrcCards = new Map<string, Component[]>();
	// Most recent `hub` tool block whose result still had every watched job
	// running. Kept un-finalized (live) so the next `hub` call displaces it —
	// one persistent poll instead of a stack of "waiting on N jobs" frames —
	// and sealed in place the moment anything else lands below it.
	#displaceablePollComponent: ToolExecutionComponent | undefined = undefined;
	// Most recent successful `todo` snapshot in the active turn. It stays live
	// across intervening tool output so a later `todo` update can replace the
	// old full list; the turn boundary seals the final snapshot as history.
	#displaceableTodoComponent: ToolExecutionComponent | undefined = undefined;
	// Most recent TTSR notification block. A new ttsr_triggered event merges its
	// rules into this block while it is still the (live-region) transcript tail.
	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#toolArgsReveal: ToolArgsRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	// Coalescing window for `message_update` events at the subscription boundary.
	// `message_update` carries the CUMULATIVE assistant message (every update
	// re-lists all content blocks), so when a burst of deltas arrives faster than
	// this window only the latest snapshot needs to rebuild streaming state — the
	// intermediate rebuilds are redundant work. The TUI already caps the paint
	// rate via its own render cadence; this caps the per-token handler work that
	// feeds it. Speech stays intact: `#vocalizeDelta` runs at ARRIVAL for every
	// delta before the snapshot is coalesced away.
	#pendingMessageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> | undefined = undefined;
	#messageUpdateTimer: NodeJS.Timeout | undefined = undefined;
	/** Tail of the serialized dispatch chain; see #runSerialized. */
	#dispatchTail: Promise<void> = Promise.resolve();
	/** Whether a chained run is currently in flight (awaiting its own awaits). */
	#dispatchInFlight = false;
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
		vocalizer.setEnhancer(
			session?.modelRegistry && session.agent && session.settings
				? new SpeechEnhancer({
						settings: session.settings,
						registry: session.modelRegistry,
						sessionId: session.sessionId,
						metadataResolver: provider => session.agent.metadataForProvider(provider),
					})
				: null,
		);
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async e => this.#handleTurnEnd(e),
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			model_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
			},
			advisor_cost_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
			},
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				const hideThinking = this.ctx.effectiveHideThinkingBlock;
				// Only do the expensive full resetDisplay when the effective
				// visibility actually changed. Auto-classification (e.g. high→medium)
				// emits thinking_level_changed without changing visibility — a full
				// terminal replay for those would be disruptive.
				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;
				// Propagate visibility to existing rendered messages.
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(hideThinking);
					}
				}
				if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
					this.ctx.streamingComponent.setHideThinkingBlock(hideThinking);
					this.#streamingReveal.resyncVisibility();
				}
				this.ctx.ui.requestRender(true);
			},
			goal_updated: async () => {},
		} satisfies AgentSessionEventHandlers;
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
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
	}

	#resetReadGroup(): void {
		this.#lastReadGroup?.finalize();
		this.#lastReadGroup = undefined;
	}
	/** Freeze foreground tool cards once no live agent turn can complete them. */
	#sealAbandonedForegroundTools(): void {
		const background = new Set<ToolExecutionHandle>();
		for (const toolCallId of this.#backgroundTaskCallIds) {
			const component = this.ctx.pendingTools.get(toolCallId);
			if (component) background.add(component);
		}
		for (const component of this.#toolTimelineComponents.values()) {
			if (
				(component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) &&
				!background.has(component)
			) {
				component.seal();
			}
		}
		for (const [toolCallId, component] of this.ctx.pendingTools) {
			if (this.#backgroundTaskCallIds.has(toolCallId)) continue;
			component.seal();
			this.ctx.pendingTools.delete(toolCallId);
		}
		this.#backgroundTaskCallIds = new Set(
			Array.from(this.#backgroundTaskCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
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
		const component = this.ctx.pendingTools.get(toolCallId);
		const ready = component instanceof ToolExecutionComponent ? component.whenPreviewSettled() : Promise.resolve();
		void ready.then(() => {
			this.ctx.ui.requestRender();
			gate.resolve();
		}, gate.reject);
	}

	#clearApprovalPreviewGates(): void {
		for (const gate of this.#approvalPreviewGates.values()) gate.resolve();
		this.#approvalPreviewGates.clear();
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#retractToolCardEntry(toolCallId: string, component: ToolExecutionHandle): void {
		component.seal();
		let removeComponent = true;
		if (component instanceof ReadToolGroupComponent) {
			removeComponent = component.removeEntry(toolCallId);
			if (component === this.#lastReadGroup) this.#resetReadGroup();
		}
		if (removeComponent) this.ctx.chatContainer.removeChild(component);
		this.ctx.pendingTools.delete(toolCallId);
		this.#toolTimelineComponents.delete(toolCallId);
		this.#clearReadToolCall(toolCallId);
	}

	/**
	 * Re-key a live streamed tool card whose id changed mid-stream (see
	 * {@link #streamedToolCallIdByIndex}). Moves every id-keyed tracker from the
	 * old id to the new one so the next cumulative `message_update` reuses the
	 * existing card instead of creating a duplicate (#6879). The card component
	 * itself is id-agnostic (routing is via `pendingTools`), so only the maps and
	 * the shared read group's entry need re-keying.
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
		// A collapsed read renders into a shared group keyed by id; rename its
		// entry so the row isn't duplicated under the new id.
		if (pending instanceof ReadToolGroupComponent) pending.renameEntry(oldId, newId);
		// A fast completion can land under `newId` while the card is still keyed
		// by `oldId`. Consume it now that the card owns the final id; the normal
		// creation path is skipped on a re-key (Codex review on #6881).
		if (pending) this.#settleHeldCompletionIfPresent(newId, pending);
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return settings.get("terminal.showImages");
	}

	#insertAfterTranscriptComponent(anchor: Component | undefined, component: Component): boolean {
		const children = this.ctx.chatContainer.children;
		const anchorIndex = anchor ? children.indexOf(anchor) : -1;
		if (anchorIndex < 0) return false;
		if (children.slice(anchorIndex + 1).some(child => !this.ctx.chatContainer.canRemoveBlock(child))) {
			return false;
		}
		this.ctx.chatContainer.addChild(component);
		children.splice(children.length - 1, 1);
		children.splice(anchorIndex + 1, 0, component);
		return true;
	}

	#upsertPostToolAssistantSegment(
		toolCallId: string,
		segment: AssistantMessage | undefined,
	): AssistantMessageComponent | undefined {
		if (!segment || !assistantHasVisibleContent(segment)) return undefined;
		const existing = this.#postToolAssistantComponents.get(toolCallId);
		if (existing) {
			existing.updateContent(segment);
			return existing;
		}
		const component = createAssistantMessageComponent(this.ctx);
		component.updateContent(segment);
		this.#postToolAssistantComponents.set(toolCallId, component);
		if (!this.#insertAfterTranscriptComponent(this.#toolTimelineComponents.get(toolCallId), component)) {
			this.ctx.chatContainer.addChild(component);
		}
		return component;
	}

	#updateWorkingMessageFromIntent(intent: unknown): void {
		if (this.ctx.session.isAborting) return;
		// Streamed JSON can deliver non-string `i` (object, number, boolean) before
		// schema validation; `?.` only guards null/undefined, so guard the type too.
		if (typeof intent !== "string") return;
		const trimmed = intent.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed}${interruptHint()}`);
	}

	subscribeToAgent(): void {
		// Serialize non-update dispatch behind any in-flight handler run:
		// AgentSession.#emit fires listeners fire-and-forget (it does not await
		// listener promises), so without this a rapid stream tail
		// (message_update → message_end → agent_end) could let a later callback
		// overtake the coalesced flush's handler mid-await — agent_end removing
		// `streamingComponent` before #handleMessageEnd finalizes and records
		// the final message (issue #7443 follow-up). When the tail has settled,
		// dispatch stays synchronous: the flush's streaming rebuild runs before
		// the listener's first await, preserving the timing the coalescing
		// tests assert on. `message_update` enqueue is itself synchronous and
		// needs no serialization.
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			// Coalesce the cumulative `message_update` deltas of a streaming turn
			// into at most one handler run per window. `#handleMessageUpdate` is
			// synchronous, so without this every token re-runs the whole
			// streaming rebuild (splitAssistantMessageToolTimeline, reveal
			// setTarget, per-block tool-call reconciliation) even though the TUI
			// paints at most ~30fps — at 40-100 tps the handler work then
			// dominates the CPU profile of an idle-looking streaming session
			// (issue #7443). Only the latest snapshot is meaningful; non-update
			// events flush the pending snapshot first so ordering is preserved.
			if (event.type === "message_update") {
				this.#enqueueMessageUpdate(event);
				return;
			}
			await this.#runSerialized(async () => {
				await this.#flushPendingMessageUpdate();
				await this.handleEvent(event);
			});
		});
	}

	/**
	 * Run `run` in the serialized dispatch chain: every run is its own link on
	 * the tail, so a burst of events queued behind an in-flight run start one
	 * after the other, never concurrently. This closes two races (issue #7443
	 * follow-up): a rapid stream tail (message_update → message_end →
	 * agent_end) cannot overtake the coalesced flush mid-await — agent_end
	 * removing `streamingComponent` before #handleMessageEnd finalizes and
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
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#backgroundTaskCallIds.clear();
		this.#approvalAttentionToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.#retryPending = this.ctx.viewSession.isRetrying;
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
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
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		// Each handler explicitly requests a render (or leaves it out, when it
		// changed nothing visible). A blanket pre-render fired on every event —
		// including the ~hundreds of `message_update` deltas per streaming turn —
		// doubled the paint rate: the pre-render's frame fires while the handler
		// is awaiting, then the handler's own final requestRender schedules a
		// second identical frame. Removing it lets the render cadence follow real
		// state changes rather than event volume (issue #4353).
		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			if (this.#terminalProgressActive || this.ctx.settings?.get("terminal.showProgress") !== true) return;
			this.ctx.ui.terminal.setProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.ui.terminal.setProgress(false);
		this.#terminalProgressActive = false;
	}

	#trackRetrySupersededAssistantComponent(component: AssistantMessageComponent | undefined): void {
		if (!component) return;
		const persistenceKey = component.messagePersistenceKey();
		if (persistenceKey) this.#retrySupersededAssistantComponents.set(persistenceKey, component);
		if (!this.#retrySupersededAssistantQueue.includes(component)) {
			this.#retrySupersededAssistantQueue.push(component);
		}
	}

	#takeRetrySupersededAssistantComponent(persistenceKey: string | undefined): AssistantMessageComponent | undefined {
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
			const key = component.messagePersistenceKey();
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
		this.#clearApprovalPreviewGates();
		// A new turn cannot inherit a foreground tool execution. A dropped
		// agent_end (for example after a renderer exception) otherwise leaves a
		// live-only tool card without a persisted result; ordered transcript
		// retirement then remains pinned behind that invisible stale card.
		this.#sealAbandonedForegroundTools();
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		// Restore terminal errors in transcript history when their banner clears.
		// Recoverable empty-output attempts are discarded by session recovery and
		// must stay hidden rather than resurfacing as a stale inline error.
		if (this.#restorePinnedErrorInline) this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.#pinnedErrorMessage = undefined;
		this.#restorePinnedErrorInline = true;
		this.ctx.clearPinnedError();
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		this.ctx.ensureLoadingAnimation();
		setTerminalTitleState("working");
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			if (
				event.message.role === "custom" &&
				this.ctx.optimisticSkillMessagePending &&
				isUserInvokedSkillPrompt(event.message)
			) {
				// The optimistic `/skill:` row painted at submit time (issue #8895):
				// swap it for the canonical message instead of appending a duplicate.
				this.ctx.reconcileOptimisticSkillMessage(event.message);
			} else {
				this.ctx.addMessageToChat(event.message);
			}
			// Queued custom-message chips are derived from the agent queue; refresh the
			// pending bar when the queued custom is consumed so the chip disappears
			// immediately.
			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			vocalizer.clear();
			const textContent = this.ctx.getUserMessageText(event.message);
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
			const signature = `${textContent}\u0000${imageCount}`;

			this.#resetReadGroup();
			this.#resolveDisplaceablePoll();
			this.#resolveDisplaceableTodo();
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			const wasLocallySubmitted = matchedLocalSubmission || wasOptimistic || replacesOptimistic;
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

			// Clear the editor only when the submission did not originate from a
			// local submission (optimistic or queued-while-streaming). Both local
			// paths already cleared the editor at submit time; clearing again here
			// would race with the user typing the next prompt while the previous
			// large redraw lands and erase their in-progress draft (#783).
			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender(true);
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			// A streaming component left over from an attempt that never saw its
			// message_end (a mid-stream throw the loop could not pair) must not stay
			// live: one unfinalized block at the transcript frontier blocks history
			// retirement — and therefore transcript layout — forever. Drop it when
			// still removable, and finalize it regardless so it can retire.
			const abandoned = this.ctx.streamingComponent;
			if (abandoned) {
				if (this.ctx.chatContainer.canRemoveBlock(abandoned)) {
					this.ctx.chatContainer.removeChild(abandoned);
				}
				abandoned.markTranscriptBlockFinalized();
			}
			this.#lastVisibleBlockCount = 0;
			this.#streamedToolCallIdByIndex.clear();
			this.ctx.streamingComponent = createAssistantMessageComponent(this.ctx);
			this.ctx.streamingMessage = event.message;
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.#streamingReveal.begin(
				this.ctx.streamingComponent,
				splitAssistantMessageToolTimeline(this.ctx.streamingMessage).beforeTools,
			);
			this.ctx.ui.requestRender();
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		const components = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, components);
		this.#enforceIrcCardCap(signature);
		this.ctx.ui.requestRender();
	}

	#scheduleIrcExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			this.#retireIrcCard(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
		this.#liveIrcCards.set(signature, components);
	}

	/**
	 * Remove an expired/evicted IRC card only while its transcript entry remains
	 * active. Pending or committed entries already belong to an immutable
	 * ordered history batch and remain as final history.
	 */
	#retireIrcCard(signature: string): void {
		const components = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.canRemoveBlock(component)) continue;
			this.ctx.chatContainer.removeChild(component);
			removed = true;
		}
		if (removed) this.ctx.ui.requestRender();
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
	 * A follow-up `hub` call displaces it — the stale "waiting on N jobs" frame
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
		if (nextToolName === "hub" && previous.isDisplaceableBlock() && this.ctx.chatContainer.canRemoveBlock(previous)) {
			this.ctx.chatContainer.removeChild(previous);
		}
		// Sealing stops the waiting-poll spinner and freezes the block (for a
		// just-removed component it only clears the animation timer).
		previous.seal();
		this.ctx.ui.requestRender();
	}

	#resolveDisplaceableTodo(nextToolName?: string): void {
		const previous = this.#displaceableTodoComponent;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#displaceableTodoComponent = undefined;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#displaceableTodoComponent = undefined;
			if (this.ctx.chatContainer.canRemoveBlock(previous)) {
				this.ctx.chatContainer.removeChild(previous);
			}
			previous.seal();
			this.ctx.ui.requestRender();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#displaceableTodoComponent = undefined;
		previous.seal();
		this.ctx.ui.requestRender();
	}

	/**
	 * Adopt a rebuilt-tail todo snapshot as the controller's tracked live
	 * snapshot. Used by rebuild paths (settings/extensions overlay close, focus
	 * attach, /resume) to preserve displacement continuity when a turn is still
	 * active — without this, the next same-turn `todo` update would stack
	 * another panel because the controller's tracker was reset before rebuild.
	 * Drops the candidate when it is no longer a displaceable todo.
	 */
	inheritDisplaceableTodo(component: ToolExecutionComponent | null | undefined): void {
		this.#displaceableTodoComponent = component?.canBeDisplacedBy("todo") ? component : undefined;
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
		if (!settings.get("speech.enabled")) return;
		const mode = settings.get("speech.mode");
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
		if (!settings.get("speech.enabled")) return;
		if (settings.get("speech.mode") !== "yield") {
			vocalizer.flush();
			return;
		}
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted") return; // interrupted: never speak the aborted partial
		const text = extractTextContent(event.message);
		if (text) vocalizer.speak(text);
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (!this.#vocalizedMessageUpdates.delete(event)) {
			this.#vocalizeDelta(event);
		}
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			const unlockedThinkingVisibility = this.ctx.noteDisplayableThinkingContent(event.message);
			if (unlockedThinkingVisibility) {
				this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
				this.#streamingReveal.resyncVisibility();
			}
			this.ctx.streamingMessage = event.message;
			const timeline = splitAssistantMessageToolTimeline(this.ctx.streamingMessage);
			this.#streamingReveal.setTarget(timeline.beforeTools);

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
			if (this.ctx.streamingMessage.content.some(content => content.type === "toolCall")) {
				this.ctx.streamingComponent.markTranscriptBlockFinalized();
			}
			for (let contentIndex = 0; contentIndex < this.ctx.streamingMessage.content.length; contentIndex++) {
				const content = this.ctx.streamingMessage.content[contentIndex]!;
				if (content.type !== "toolCall") continue;
				// Re-key the live card when a provider rewrites this block's id
				// across deltas, so the changed id reuses the existing card
				// instead of spawning a duplicate (#6879).
				const priorId = this.#streamedToolCallIdByIndex.get(contentIndex);
				if (priorId !== undefined && priorId !== content.id) {
					this.#migrateStreamedToolCallId(priorId, content.id);
				}
				this.#streamedToolCallIdByIndex.set(contentIndex, content.id);
				if (content.name === "read") {
					if (!readArgsHaveTarget(content.arguments)) {
						// Args still streaming — defer until path is parseable so we can route to the
						// read group (files + xd:// devices) vs ToolExecutionComponent (other internal URLs).
						// Creating either component now would lock the read into the wrong shape.
						continue;
					}
					if (readArgsCollapseIntoGroup(content.arguments)) {
						if (!this.ctx.pendingTools.has(content.id)) this.#resolveDisplaceablePoll(content.name);
						this.#trackReadToolCall(content.id, content.arguments);
						const component = this.ctx.pendingTools.get(content.id);
						if (component) {
							component.updateArgs(content.arguments, content.id);
						} else {
							const group = this.#getReadGroup();
							group.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, group);
							this.#toolTimelineComponents.set(content.id, group);
						}
						continue;
					}
					// Other internal-URL reads fall through to ToolExecutionComponent below.
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
				const tool = this.ctx.viewSession.getToolByName(content.name);
				if (partialJson) {
					renderArgs = this.#toolArgsReveal.setTarget(content.id, partialJson, {
						rawInput,
						exposeRawPartialJson: exposesRawPartialJson(content.name, rawInput, tool),
						streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
					});
				} else {
					this.#toolArgsReveal.finish(content.id);
					renderArgs = content.arguments;
				}
				// `message_update` is cumulative — every update re-lists all blocks
				// of the streaming message — so creation must also be guarded by the
				// timeline map: `pendingTools` loses the id the moment a completion
				// settles the card, and for server-resolved (Cursor) tools that can
				// happen while the message is still streaming. Without the second
				// check the next cumulative update would recreate a card for a call
				// that already finished, permanently pending.
				if (!this.ctx.pendingTools.has(content.id) && !this.#toolTimelineComponents.has(content.id)) {
					this.#resolveDisplaceablePoll(content.name);
					this.#resetReadGroup();
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(content.name),
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
							clipboard: getEditClipboard(this.ctx.viewSession),
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
					this.ctx.pendingTools.set(content.id, component);
					this.#toolTimelineComponents.set(content.id, component);
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
				this.#upsertPostToolAssistantSegment(toolCallId, segment);
			}

			// Update working message with intent from streamed tool arguments
			for (const content of this.ctx.streamingMessage.content) {
				if (content.type !== "toolCall") continue;
				const args = content.arguments;
				if (!args || typeof args !== "object") continue;
				if (INTENT_FIELD in args) {
					this.#updateWorkingMessageFromIntent(args[INTENT_FIELD]);
					continue;
				}
				const tool = this.ctx.viewSession.getToolByName(content.name);
				if (typeof tool?.intent !== "function") continue;
				try {
					const derived = tool.intent(args as never)?.trim();
					if (derived) {
						this.#updateWorkingMessageFromIntent(derived);
					}
				} catch {
					// intent function must never break the UI
				}
			}

			this.ctx.ui.requestRender();
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		const unlockedThinkingVisibility =
			event.message.role === "assistant" && this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		if (event.message.role === "assistant" && settings.get("speech.enabled")) {
			if (event.message.stopReason === "aborted") {
				// Esc / Ctrl+C / interrupt: stop speaking now and drop the trailing partial.
				vocalizer.clear();
			} else {
				const mode = settings.get("speech.mode");
				// Speak the last partial sentence of a completed message; yield mode
				// instead speaks the whole final message at turn end.
				if (mode === "assistant" || mode === "all") vocalizer.flush();
			}
		}
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
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
			this.ctx.streamingComponent.updateContent(displayTimeline.beforeTools);

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
					for (const [toolCallId, component] of Array.from(this.ctx.pendingTools.entries())) {
						if (this.#backgroundTaskCallIds.has(toolCallId)) continue;
						if (
							!(component instanceof ToolExecutionComponent) &&
							!(component instanceof ReadToolGroupComponent)
						) {
							continue;
						}
						if (this.ctx.chatContainer.canRemoveBlock(component)) {
							this.#retractToolCardEntry(toolCallId, component);
							this.#retractedToolCallIds.add(toolCallId);
						} else {
							component.seal();
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
				if (settings.get("display.cacheMissMarker")) {
					const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
					if (invalidation) this.ctx.streamingComponent.setCacheInvalidation(invalidation);
				}
				this.ctx.lastAssistantUsage = usage;
			}
			this.ctx.streamingComponent.markTranscriptBlockFinalized();
			let lastPostToolAssistantComponent: AssistantMessageComponent | undefined;
			for (const [toolCallId, segment] of displayTimeline.afterToolCalls) {
				const component = this.#upsertPostToolAssistantSegment(toolCallId, segment);
				component?.markTranscriptBlockFinalized();
				if (component) lastPostToolAssistantComponent = component;
			}
			this.#lastAssistantComponent = lastPostToolAssistantComponent ?? this.ctx.streamingComponent;
			if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(event.message.usage)) {
				const readCallIds = groupedReadUsageCallIds(event.message);
				const usageAttached =
					readCallIds !== undefined &&
					(this.#lastReadGroup?.attachUsage(
						readCallIds,
						event.message.usage,
						event.message.duration,
						event.message.ttft,
						event.message.timestamp,
					) ??
						false);
				if (!usageAttached) {
					this.#resetReadGroup();
					this.ctx.chatContainer.addChild(
						createUsageRowBlock(
							event.message.usage,
							event.message.duration,
							event.message.ttft,
							event.message.timestamp,
						),
					);
				}
			}
			if (displayMessage === event.message) {
				this.ctx.transcriptMessageComponents.set(event.message, this.ctx.streamingComponent);
			}
			this.ctx.streamingComponent = undefined;
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
				this.#lastAssistantComponent?.setErrorPinned(true);
				this.#pinnedErrorComponent = this.#lastAssistantComponent;
				this.#pinnedErrorMessage = event.message;
				this.#restorePinnedErrorInline = !recoverableEmptyOutput;
				if (!recoverableEmptyOutput) this.ctx.showPinnedError(event.message.errorMessage);
			}
			this.ctx.statusLine.invalidate();
			this.ctx.ui.requestRender();
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		if (this.#retractedToolCallIds.has(event.toolCallId)) return;
		this.#ensureWorkingLoaderWhileStreaming();
		this.#updateWorkingMessageFromIntent(event.intent);
		if (event.toolName === "ask" || this.#toolWillPromptForApproval(event.toolName, event.args)) {
			this.#approvalAttentionToolCallIds.add(event.toolCallId);
			setTerminalTitleState("attention");
		}
		this.#resolveDisplaceablePoll(event.toolName);
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsCollapseIntoGroup(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
					this.#toolTimelineComponents.set(event.toolCallId, group);
				}
				this.#startToolApprovalPreview(event.toolCallId);
				this.ctx.ui.requestRender();
				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.viewSession.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(event.toolName),
					snapshots: getFileSnapshotStore(this.ctx.viewSession),
					clipboard: getEditClipboard(this.ctx.viewSession),
					showImages: settings.get("terminal.showImages"),
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setArgsComplete(event.toolCallId);
			component.setExecutionStarted(event.toolCallId);
			this.#executionStartedCallIds.add(event.toolCallId);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.ctx.pendingTools.set(event.toolCallId, component);
			this.#toolTimelineComponents.set(event.toolCallId, component);
			this.#settleHeldCompletionIfPresent(event.toolCallId, component);
			this.ctx.ui.requestRender();
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
			this.#toolArgsReveal.finish(event.toolCallId);
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component && typeof component.updateArgs === "function") {
				component.updateArgs(event.args, event.toolCallId);
				if (typeof component.setArgsComplete === "function") {
					component.setArgsComplete(event.toolCallId);
				}
				if (typeof component.setExecutionStarted === "function") {
					component.setExecutionStarted(event.toolCallId);
				}
				this.#executionStartedCallIds.add(event.toolCallId);
				this.ctx.ui.requestRender();
			}
		}
		this.#startToolApprovalPreview(event.toolCallId);
	}

	/**
	 * Whether this tool call will block on an approval prompt before executing.
	 * The extension wrapper waits on `uiContext.select(...)` after emitting
	 * `tool_execution_start`, so an approval-mode / per-tool `prompt` policy is
	 * user-blocking — the title should read `attention`, not `working`. Mirrors
	 * the wrapper's `resolveApproval` inputs (approvalMode + tools.approval); uses
	 * `resolveApproval` rather than `requiresApproval` so a `deny` policy does not
	 * throw in the render path.
	 */
	#toolWillPromptForApproval(toolName: string, args: unknown): boolean {
		const tool = this.ctx.viewSession.getToolByName(toolName);
		if (!tool) return false;
		const mode = (settings.get("tools.approvalMode") ?? "yolo") as ApprovalMode;
		const userPolicies = (settings.get("tools.approval") ?? {}) as Record<string, unknown>;
		return resolveApproval(tool, args, mode, userPolicies).policy === "prompt";
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			// A final async snapshot is terminal only for a parked background
			// block (the call already returned and was kept alive for its jobs).
			// While the call is still executing — a mixed blocking+async task
			// call whose jobs settle before its blocking subset — treat it as a
			// partial frame: `tool_execution_end` still owns the terminal result.
			const isTerminal = isFinalAsyncState && this.#backgroundTaskCallIds.has(event.toolCallId);
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isTerminal,
				event.toolCallId,
			);
			if (isTerminal) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundTaskCallIds.delete(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	#settleHeldCompletionIfPresent(toolCallId: string, component: ToolExecutionHandle): void {
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
		component: ToolExecutionHandle,
		event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	): void {
		component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
		this.ctx.pendingTools.delete(event.toolCallId);
		if (
			component instanceof ToolExecutionComponent &&
			component.isDisplaceableBlock() &&
			event.toolName === "todo" &&
			component.canBeDisplacedBy("todo")
		) {
			// Mirrors the displacement bookkeeping in `#handleToolExecutionEnd`:
			// a successful snapshot supersedes the previous live panel.
			const previous = this.#displaceableTodoComponent;
			if (previous && previous !== component && previous.isDisplaceableBlock()) {
				this.#displaceableTodoComponent = undefined;
				if (this.ctx.chatContainer.canRemoveBlock(previous)) {
					this.ctx.chatContainer.removeChild(previous);
				}
				previous.seal();
			}
			this.#displaceableTodoComponent = component;
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		// `createAbortedToolResult` emits start/end after an error/aborted
		// assistant message. The matching card was deliberately retracted at
		// message_end; consume the completion instead of recreating/updating UI.
		if (this.#retractedToolCallIds.delete(event.toolCallId)) return;
		this.#executionStartedCallIds.delete(event.toolCallId);
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
		// Return to `working` only when the LAST outstanding user-blocking prompt
		// resolves: with queued approval prompts (always-ask/write), the first tool
		// to finish must not clear the attention signal while another prompt still
		// waits. `ask` ids are in the set too (added at tool_execution_start), so
		// the delete also covers them without leaking ids until turn end.
		if (
			this.#approvalAttentionToolCallIds.delete(event.toolCallId) &&
			this.#approvalAttentionToolCallIds.size === 0
		) {
			setTerminalTitleState("working");
		}
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
				}
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					// A persisted result can win a mid-stream transcript rebuild
					// before this live completion handler runs. Rebuild removes the
					// pending handle and replay owns the completed card, but the
					// original timeline entry remains as proof that a card already
					// existed. Do not create a fallback read group beside replay
					// (#6879); the fallback is only for a completion that genuinely
					// outran every streamed card.
					if (this.#toolTimelineComponents.has(event.toolCallId)) {
						this.#clearReadToolCall(event.toolCallId);
						return;
					}
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#clearReadToolCall(event.toolCallId);
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundTask = event.toolName === "task" && asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundTask, event.toolCallId);
				if (isBackgroundTask) {
					component.parkAsBackground();
					this.#backgroundTaskCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundTaskCallIds.delete(event.toolCallId);
				}
				if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
					if (event.toolName === "hub" && component.canBeDisplacedBy("hub")) {
						// Remember the waiting poll so the next `hub` call can displace it.
						this.#displaceablePollComponent = component;
					} else if (event.toolName === "todo" && component.canBeDisplacedBy("todo")) {
						// Successful todo update supersedes the prior live snapshot. A failed
						// follow-up never reaches this branch (canBeDisplacedBy("todo") returns
						// false for errored results), so the last-good panel stays on screen.
						const previous = this.#displaceableTodoComponent;
						if (previous && previous !== component && previous.isDisplaceableBlock()) {
							this.#displaceableTodoComponent = undefined;
							if (this.ctx.chatContainer.canRemoveBlock(previous)) {
								this.ctx.chatContainer.removeChild(previous);
							}
							previous.seal();
						}
						this.#displaceableTodoComponent = component;
					}
				}
				this.ctx.ui.requestRender();
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
		// Update todo display when todo tool completes
		if (event.toolName === "todo" && !event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setTodos(details.phases);
			}
		} else if (event.toolName === "todo" && event.isError) {
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
		// Plan approval rides a `write` to xd://propose: the dispatch metadata on
		// the write details carries the approval payload as `inner`.
		if (!event.isError) {
			const dispatch = writeDeviceDispatch(event.toolName, event.result);
			const details =
				dispatch?.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute" ? dispatch.inner : undefined;
			if (
				details &&
				typeof details === "object" &&
				"planFilePath" in details &&
				"title" in details &&
				"planExists" in details &&
				typeof details.planFilePath === "string" &&
				typeof details.title === "string" &&
				typeof details.planExists === "boolean"
			) {
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
				void this.ctx
					.handlePlanApproval({
						planFilePath: details.planFilePath,
						title: details.title,
						planExists: details.planExists,
					})
					.catch(err => {
						logger.warn("Plan approval dispatch failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}
		}
	}
	async #handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		// A superseded agent_end: the agent is already streaming a fresh turn, so
		// this event belongs to a turn that has already been replaced. The session
		// dispatches to listeners fire-and-forget across an async extension-emit hop
		// (#emitSessionEvent), so an interrupted turn's agent_end can land AFTER the
		// resumed turn's agent_start (e.g. any post-turn agent.continue()). Running
		// the turn-end teardown now would stop the loader the live turn just created,
		// leaving "Working…" gone while the agent keeps running. The live turn owns
		// the loader and finalizes it at its own agent_end (isStreaming === false by
		// then). Mirrors the collab guest's !isStreaming loader reconciler.
		if (this.ctx.session.isStreaming) return;
		// A non-terminal settle (`isTerminal: false`) is a scheduling pause, not the
		// end of the run: an unsuppressed async job (a `/vibe` worker turn, a bash
		// `async` job, etc.) will re-wake the loop when its result is delivered.
		// `AgentSession` tags this on the deferred event (see `#hasPendingAsyncWake`
		// in agent-session.ts). Skip the idle title/loader teardown so the tab keeps
		// reading "working"; the later terminal `agent_end` performs it. Still flush
		// a deferred model switch — the plan-mode reconciler queues it to apply once
		// the current stream ends, and `#finishAgentEnd` is otherwise its only flush
		// site, so the automatic continuation would otherwise run on the old
		// model/thinking level until the terminal settle.
		if (event.isTerminal === false) {
			await this.ctx.flushPendingModelSwitch();
			// Reaching here means the first guard passed, so `isStreaming` is already
			// false: a command issued from now on mounts immediately. Leaving earlier
			// panels queued would render them out of order, minutes later, after the
			// user was told they were only waiting for the turn. The transcript is
			// quiescent at a settle, which is the condition #4806 wanted.
			this.ctx.flushPendingCommandOutput();
			return;
		}
		setTerminalTitleState("idle");

		await this.#finishAgentEnd(event);
	}

	async #finishAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		this.#setTerminalProgress(false);
		this.ctx.statusLine.markActivityEnd();
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		await this.ctx.flushPendingModelSwitch();
		this.#sealAbandonedForegroundTools();
		this.#approvalAttentionToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#toolTimelineComponents.clear();
		this.#streamedToolCallIdByIndex.clear();
		this.#retractedToolCallIds.clear();
		this.#executionStartedCallIds.clear();
		this.#syntheticFailureCards.clear();
		this.#orphanedToolCompletions.clear();
		this.#postToolAssistantComponents.clear();
		this.#resetReadGroup();
		// The turn is over: nothing else lands this turn, so the waiting poll is
		// final history — seal it instead of letting its spinner tick while idle.
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		this.ctx.flushPendingCommandOutput();
		this.#lastAssistantComponent = undefined;
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.#scheduleIdleRecap();
		this.sendErrorNotification(event);
		this.sendCompletionNotification(event);
	}

	/**
	 * Tear down the live "Working…" loader: stop its animation timer AND clear the
	 * reference. A transient overlay (auto-compaction / auto-retry) can remove the
	 * loader from the container while leaving `ctx.loadingAnimation` set, so the
	 * resumed turn's `agent_start` →
	 * `ensureLoadingAnimation()` (guarded by `if (!this.loadingAnimation)`) skipped
	 * re-adding it and the spinner vanished while the agent kept streaming. Nulling
	 * the reference here lets the next `agent_start` recreate and re-attach it.
	 */
	#stopWorkingLoader(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
	}

	/**
	 * Restore the live "Working…" loader when a streaming event lands after a
	 * transient status overlay cleared the container. Focus mode dispatches events
	 * for `viewSession`, so key the reconciler on that session, not the main one.
	 */
	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		this.ctx.ensureLoadingAnimation();
	}

	/**
	 * Trailing Esc hint for live maintenance loaders. While a subagent is
	 * focused, Esc returns to main instead of cancelling its maintenance
	 * (#2819), so the loader drops the hint entirely rather than advertise a
	 * cancel that no longer happens. Includes the leading space so the focused
	 * label carries no dangling whitespace.
	 */
	#maintenanceEscHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(true);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
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
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		this.#cancelIdleRecap();
		this.#setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
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
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.lastAssistantUsage = undefined;
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });
			this.ctx.statusLine.invalidate();
			// When history collapses behind the summary divider, the frame
			// shrinks far below the committed row count; without clearing, the
			// differential renderer's "duplication, never loss" resync repaints
			// the whole collapsed transcript (welcome box included) BELOW the
			// stale pre-compaction scrollback. Compaction is an intentional
			// transcript replacement then — same as auto-handoff below. With
			// collapse disabled the rebuilt transcript keeps the full history,
			// so the resync handles it and scrollback stays.
			if (settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			this.ctx.clearTransientSessionUi();
			this.ctx.lastAssistantUsage = undefined;
			await this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			await this.ctx.reloadTodos();
			this.ctx.ui.requestRender(true, { clearScrollback: true });
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
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#retryPending = true;
		this.#trackRetrySupersededAssistantComponent(this.#lastAssistantComponent);
		// A retry supersedes the just-failed turn: its assistant + tool calls are
		// pruned from context and re-streamed. Remove the cards that a synthetic
		// aborted/error completion settled in place at message_end so the retry's
		// fresh cards don't render the same call twice (#6879). Only uncommitted
		// cards are removable; one already on the scrollback tape stays as history.
		for (const [toolCallId, component] of this.#syntheticFailureCards) {
			if (this.ctx.chatContainer.canRemoveBlock(component)) {
				this.#retractToolCardEntry(toolCallId, component);
			}
		}
		this.#syntheticFailureCards.clear();
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			// The retry path drops the failed assistant from runtime context. Do not
			// restore its inline Error row; just unpin the fixed-region banner so the
			// retry UI is the visible state.
			this.#pinnedErrorComponent = undefined;
			this.#pinnedErrorMessage = undefined;
			this.#restorePinnedErrorInline = true;
			this.ctx.clearPinnedError();
		}
		const retryStartMs = Date.now();
		const retryLabel = `Retrying (${event.attempt}/${event.maxAttempts})`;
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			() => {
				const remaining = Math.max(0, event.delayMs - (Date.now() - retryStartMs));
				return `${retryLabel} in ${formatDuration(remaining)}…${this.#maintenanceEscHint()}`;
			},
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		this.#retryPending = false;
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		const pinnedError = this.#pinnedErrorMessage?.errorMessage;
		const terminalFailurePinned =
			!event.success &&
			this.#pinnedErrorComponent !== undefined &&
			pinnedError !== undefined &&
			pinnedError === event.finalError;
		let stalePinnedErrorCleared = false;
		if (!event.success && this.#pinnedErrorComponent && !terminalFailurePinned) {
			this.#pinnedErrorComponent.setErrorPinned(false);
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
			component.applyRetryRecovery(retryError.retryRecovery);
			if (!terminalFailurePinned && this.#pinnedErrorComponent === component) {
				this.#pinnedErrorComponent = undefined;
				this.#pinnedErrorMessage = undefined;
				this.#restorePinnedErrorInline = true;
			}
			appliedRetryUpdate = true;
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
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		// Consecutive notifications (e.g. per-tool matches from one assistant
		// message) merge into the previous block instead of stacking. Mutating an
		// existing block is only safe while none of its rows have entered native
		// scrollback — committed rows are immutable visual history and a grown
		// block would shift them.
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.canRemoveBlock(previous)
		) {
			previous.addRules(event.rules);
			this.ctx.ui.requestRender();
			return;
		}
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
		this.#lastTtsrNotification = component;
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}
	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#cancelIdleRecap(): void {
		if (this.#idleRecapTimer) {
			clearTimeout(this.#idleRecapTimer);
			this.#idleRecapTimer = undefined;
		}
		if (this.#idleRecapAbort) {
			this.#idleRecapAbort.abort();
			this.#idleRecapAbort = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.viewSession.isStreaming) return;
			if (this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.viewSession.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#scheduleIdleRecap(): void {
		this.#cancelIdleRecap();
		if (this.ctx.viewSession.isCompacting) return;

		const recapSettings = settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		if (this.ctx.editor.getText().trim()) return;

		const timeoutMs =
			Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, recapSettings.idleSeconds)) * 1000;
		this.#idleRecapTimer = setTimeout(() => {
			this.#idleRecapTimer = undefined;
			void this.#runIdleRecap();
		}, timeoutMs);
		this.#idleRecapTimer.unref?.();
	}

	/**
	 * Generate the idle recap with an ephemeral side-channel turn over the
	 * current conversation (same pipeline as `/btw`) and surface it as a status
	 * line. Live goal/title and the active todo task are passed as anchoring
	 * hints because the snapshot only carries conversation history, not the
	 * controller's todo/goal state. The request is abortable: any activity
	 * cancels it via #cancelIdleRecap, and idle conditions are re-checked after
	 * the reply lands so a stale recap never paints over fresh work.
	 */
	async #runIdleRecap(): Promise<void> {
		if (!this.#idleConditionsHold()) return;
		if (!this.ctx.viewSession.model) return;
		if (this.ctx.viewSession.messages.length === 0) return;

		const promptText = prompt.render(idleRecapPrompt, {
			goal: this.#idleRecapGoalText() ?? "",
			task: nextActionableTask(this.ctx.todoPhases)?.content ?? "",
		});

		const abort = new AbortController();
		this.#idleRecapAbort = abort;
		try {
			const { replyText } = await this.ctx.viewSession.runEphemeralTurn({ promptText, signal: abort.signal });
			if (this.#idleRecapAbort !== abort || abort.signal.aborted || !this.#idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (!recap) return;
			this.ctx.showStatus(theme.fg("dim", theme.italic(`※ recap: ${recap}`)), { dim: false });
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (this.#idleRecapAbort === abort) this.#idleRecapAbort = undefined;
		}
	}

	/** Idle gate shared by the recap timer fire and its post-reply re-check. */
	#idleConditionsHold(): boolean {
		if (this.ctx.viewSession.isStreaming) return false;
		if (this.ctx.viewSession.isCompacting) return false;
		if (this.ctx.editor.getText().trim()) return false;
		return true;
	}

	#idleRecapGoalText(): string | undefined {
		const goal = this.ctx.viewSession.getGoalModeState?.()?.goal.objective.trim();
		if (goal) return goal;
		const title = this.ctx.sessionManager.getSessionName()?.trim();
		return title || undefined;
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	sendErrorNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// A running async job or queued delivery will wake the session again, so
		// its current agent_end is a scheduling pause rather than a user-visible
		// terminal failure. AgentSession marks that stable outcome before
		// dispatching the deferred event; do not infer it from mutable job state.
		if (event.isTerminal === false) return;

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

		const notify = settings.get("error.notify");
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
		TERMINAL.sendNotification({
			title: sessionName || "Oh My Pi",
			body: "Stopped with error",
			type: "error",
			actions: "focus",
		});
	}

	sendCompletionNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const notify = settings.get("completion.notify");
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
		TERMINAL.sendNotification({
			title: sessionName || "Oh My Pi",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}
