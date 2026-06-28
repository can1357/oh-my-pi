import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { getStreamingPartialJson } from "@pk-nerdsaver-ai/pi-ai/utils/block-symbols";
import { type Component, Loader, TERMINAL } from "@pk-nerdsaver-ai/pi-tui";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import {
	ReadToolGroupComponent,
	readArgsHaveTarget,
	readArgsTargetInternalUrl,
} from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, readQueueChipText, resolveAbortLabel } from "../../session/messages";
import type { ResolveToolDetails } from "../../tools/resolve";
import { vocalizer } from "../../tts/vocalizer";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { interruptHint } from "../shared";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import { StreamingRevealController } from "./streaming-reveal";
import { ToolArgsRevealController } from "./tool-args-reveal";

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

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

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
	#backgroundToolCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// components each card contributed (see #retireIrcCard for the guard).
	#liveIrcCards = new Map<string, Component[]>();
	// Most recent `job` tool block whose result still had every watched job
	// running. Kept un-finalized (live) so the next `job` call displaces it —
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

	constructor(private ctx: InteractiveModeContext) {
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: () => this.ctx.ui.requestRender(),
		});
		this.#toolArgsReveal = new ToolArgsRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			requestRender: () => this.ctx.ui.requestRender(),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => this.#handleTurnStart(),
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
				this.ctx.ui.resetDisplay();
			},
			goal_updated: async () => {},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#streamingReveal.stop();
		this.#toolArgsReveal.stop();
		this.#cancelIdleCompaction();
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

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
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
		return true;
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
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.handleEvent(event);
		});
	}
	/**
	 * Clear every transcript-anchored/turn-scoped piece of state. Used by the
	 * session focus proxy when re-pointing the transcript at another session:
	 * components, timers, and stream-reveal state all reference the previous
	 * session's transcript and must not bleed into the new one.
	 */
	resetTranscriptAnchors(): void {
		this.#resetReadGroup();
		this.#lastVisibleBlockCount = 0;
		this.#renderedCustomMessages.clear();
		this.#lastIntent = undefined;
		this.#backgroundToolCallIds.clear();
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#cancelIdleCompaction();
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

		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();

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

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		// Restore the previous turn's inline error in the transcript before dropping
		// the banner, so the error stays in history once the banner is gone.
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.#cancelIdleCompaction();
		this.#setTerminalProgress(true);
		this.ctx.ensureLoadingAnimation();
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
			this.ctx.addMessageToChat(event.message);
			// Queued custom-message chips are derived from the agent queue; refresh the
			// pending bar when the queued custom is consumed so the chip disappears
			// immediately.
			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
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
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.#lastVisibleBlockCount = 0;
			this.ctx.streamingComponent = createAssistantMessageComponent(this.ctx);
			this.ctx.streamingMessage = event.message;
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.#streamingReveal.begin(this.ctx.streamingComponent, this.ctx.streamingMessage);
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
	 * Remove an expired/evicted IRC card — but only while it still sits below a
	 * live block, where its rows cannot have entered native scrollback. Once
	 * everything above it has finalized, its rows may already be committed;
	 * removing them then is an interior deletion of the committed prefix, which
	 * the engine can only repair by recommitting every row below the gap —
	 * exactly the duplicated-block artifact this guard exists to prevent. Such
	 * a card simply stays: it is final history, and the window scrolls past it.
	 */
	#retireIrcCard(signature: string): void {
		const components = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.isWithinLiveRegion(component)) continue;
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
	 * A follow-up `job` call displaces it — the stale "waiting on N jobs" frame
	 * is removed so repeated polls read as one persistent poll — while anything
	 * else seals it in place as final history. Removal is safe only because a
	 * displaceable block never finalizes: commits stop at the first live block,
	 * so none of its rows have entered native scrollback (see
	 * ToolExecutionComponent.isDisplaceableBlock).
	 */
	#resolveDisplaceablePoll(nextToolName?: string): void {
		const previous = this.#displaceablePollComponent;
		if (!previous) return;
		this.#displaceablePollComponent = undefined;
		if (nextToolName === "job" && previous.isDisplaceableBlock()) {
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
			this.ctx.chatContainer.removeChild(previous);
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

	/** A new turn interrupts any speech still queued/playing from the previous one. */
	#handleTurnStart(): void {
		vocalizer.clear();
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
		this.#vocalizeDelta(event);
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			this.ctx.streamingMessage = event.message;
			this.#streamingReveal.setTarget(this.ctx.streamingMessage);

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
			for (const content of this.ctx.streamingMessage.content) {
				if (content.type !== "toolCall") continue;
				if (content.name === "read") {
					if (!readArgsHaveTarget(content.arguments)) {
						// Args still streaming — defer until path is parseable so we can route to the
						// read group (regular files) vs ToolExecutionComponent (internal URLs).
						// Creating either component now would lock the read into the wrong shape.
						continue;
					}
					if (!readArgsTargetInternalUrl(content.arguments)) {
						if (!this.ctx.pendingTools.has(content.id)) this.#resolveDisplaceablePoll(content.name);
						this.#trackReadToolCall(content.id, content.arguments);
						const component = this.ctx.pendingTools.get(content.id);
						if (component) {
							component.updateArgs(content.arguments, content.id);
						} else {
							const group = this.#getReadGroup();
							group.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, group);
						}
						continue;
					}
					// Internal URL read falls through to ToolExecutionComponent below.
				}

				// Preserve the raw partial JSON for renderers that need to surface fields before the JSON object closes.
				// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
				// While the JSON is still open, ToolArgsRevealController paces the
				// reveal (write/edit/bash previews grow smoothly when a slow provider
				// delivers large batches); once it closes, the final args render
				// as-is — mirroring how assistant text snaps at message_end.
				let renderArgs: Record<string, unknown>;
				const partialJson = getStreamingPartialJson(content);
				if (partialJson) {
					renderArgs = this.#toolArgsReveal.setTarget(
						content.id,
						partialJson,
						content.customWireName !== undefined,
						content.arguments,
					);
				} else {
					this.#toolArgsReveal.finish(content.id);
					renderArgs = content.arguments;
				}
				if (!this.ctx.pendingTools.has(content.id)) {
					this.#resolveDisplaceablePoll(content.name);
					this.#resetReadGroup();
					const tool = this.ctx.viewSession.getToolByName(content.name);
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
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
					this.#toolArgsReveal.bind(content.id, component);
				} else {
					const component = this.ctx.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(renderArgs, content.id);
						this.#toolArgsReveal.bind(content.id, component);
					}
				}
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
			const ttsrSilenced = aborted && this.ctx.viewSession.isTtsrAbortPending;
			if (aborted && !silentlyAborted && !ttsrSilenced) {
				// Resolve the operator-facing label: a user-interrupt (Esc) abort
				// carries USER_INTERRUPT_LABEL on errorMessage (threaded through the
				// AbortController), which is preserved verbatim; any other abort with
				// no threaded reason falls back to the retry-aware generic label.
				// AgentSession.#handleAgentEvent already stamped SILENT_ABORT_MARKER for
				// the plan-compact transition before this controller ran, so reaching
				// this branch implies the abort was NOT a silent internal transition.
				errorMessage = resolveAbortLabel(this.ctx.streamingMessage, this.ctx.viewSession.retryAttempt);
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			if (silentlyAborted || ttsrSilenced) {
				// Silence the streaming render by downgrading stopReason to "stop" for
				// display only — does NOT mutate the persisted message's stopReason
				// (the marker on errorMessage drives replay-side suppression).
				const msgWithoutAbort = { ...this.ctx.streamingMessage, stopReason: "stop" as const };
				this.ctx.streamingComponent.updateContent(msgWithoutAbort);
			} else {
				this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			}

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
				}
			} else {
				// The turn ended without running these calls (abort/error/TTSR rewind),
				// so they will never produce a result. Seal them so they stop animating
				// and freeze instead of pinning the transcript live region while a retry
				// streams fresh blocks below them. Background tools keep updating.
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					if (!this.#backgroundToolCallIds.has(toolCallId) && component instanceof ToolExecutionComponent) {
						component.seal();
					}
				}
				// These calls will never produce a result either, so the tracked
				// waiting poll cannot be displaced anymore — freeze it in place.
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
			this.#lastAssistantComponent = this.ctx.streamingComponent;
			this.#lastAssistantComponent.markTranscriptBlockFinalized();
			if (settings.get("display.showTokenUsage")) {
				this.ctx.chatContainer.addChild(createUsageRowBlock(event.message.usage));
			}
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
			// Pin a turn-ending provider error (e.g. Anthropic content-filter block)
			// above the editor so it survives transcript scroll. Cleared at the next
			// turn's agent_start. Suppress the transcript's inline `Error: …` line for
			// the same message while pinned so the error isn't rendered twice.
			if (event.message.stopReason === "error" && event.message.errorMessage && !isSilentAbort(event.message)) {
				this.#lastAssistantComponent?.setErrorPinned(true);
				this.#pinnedErrorComponent = this.#lastAssistantComponent;
				this.ctx.showPinnedError(event.message.errorMessage);
			}
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		this.#updateWorkingMessageFromIntent(event.intent);
		this.#resolveDisplaceablePoll(event.toolName);
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read" && readArgsHaveTarget(event.args) && !readArgsTargetInternalUrl(event.args)) {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				this.ctx.ui.requestRender();
				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.viewSession.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					snapshots: getFileSnapshotStore(this.ctx.viewSession),
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.ctx.chatContainer,
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.ctx.pendingTools.set(event.toolCallId, component);
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
				this.ctx.ui.requestRender();
			}
		}
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isFinalAsyncState,
				event.toolCallId,
			);
			if (isFinalAsyncState) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundToolCallIds.delete(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				if (asyncState === "running") {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
				}
				if (component instanceof ToolExecutionComponent && component.isDisplaceableBlock()) {
					if (event.toolName === "job" && component.canBeDisplacedBy("job")) {
						// Remember the waiting poll so the next `job` call can displace it.
						this.#displaceablePollComponent = component;
					} else if (event.toolName === "todo" && component.canBeDisplacedBy("todo")) {
						// Successful todo update supersedes the prior live snapshot. A failed
						// follow-up never reaches this branch (canBeDisplacedBy("todo") returns
						// false for errored results), so the last-good panel stays on screen.
						const previous = this.#displaceableTodoComponent;
						if (previous && previous !== component && previous.isDisplaceableBlock()) {
							this.#displaceableTodoComponent = undefined;
							this.ctx.chatContainer.removeChild(previous);
							previous.seal();
						}
						this.#displaceableTodoComponent = component;
					}
				}
				this.ctx.ui.requestRender();
			}
		}
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
			this.ctx.showWarning(
				`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo succeeds."}`,
			);
		}
		if (event.toolName === "resolve" && !event.isError) {
			const details = event.result.details as ResolveToolDetails | undefined;
			if (details?.sourceToolName === "plan_approval" && details.action === "apply") {
				const planDetails = details.sourceResultDetails as PlanApprovalDetails | undefined;
				if (planDetails) {
					await this.ctx.handlePlanApproval(planDetails);
				}
			}
		}
	}
	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
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

		await this.#finishAgentEnd();
	}

	async #finishAgentEnd(): Promise<void> {
		this.#setTerminalProgress(false);
		this.#streamingReveal.stop();
		this.#toolArgsReveal.flushAll();
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.clear();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		await this.ctx.flushPendingModelSwitch();
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			if (!this.#backgroundToolCallIds.has(toolCallId)) {
				// A foreground tool still pending at turn end never delivered a result;
				// seal it so it freezes (and stops animating) rather than lingering in
				// the transcript live region as a streaming preview until the next thaw.
				const component = this.ctx.pendingTools.get(toolCallId);
				// A foreground read still pending at turn end shares a group component
				// keyed by every read's id; seal it too so a never-delivered read does
				// not keep the group live (and pinning the live region) indefinitely.
				if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent) {
					component.seal();
				}
				this.ctx.pendingTools.delete(toolCallId);
			}
		}
		this.#backgroundToolCallIds = new Set(
			Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#resetReadGroup();
		// The turn is over: nothing else lands this turn, so the waiting poll is
		// final history — seal it instead of letting its spinner tick while idle.
		this.#resolveDisplaceablePoll();
		this.#resolveDisplaceableTodo();
		this.#lastAssistantComponent = undefined;
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.sendCompletionNotification();
	}

	/**
	 * Tear down the live "Working…" loader: stop its animation timer AND clear the
	 * reference. A transient overlay (auto-compaction / auto-retry) that only ran
	 * `statusContainer.clear()` detached the loader from the container but left
	 * `ctx.loadingAnimation` set, so the resumed turn's `agent_start` →
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
		this.#setTerminalProgress(true);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.clear();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel =
			event.action === "handoff"
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
		this.#setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		const isHandoffAction = event.action === "handoff";
		const isShakeAction = event.action === "shake";
		const isSnapcompactAction = event.action === "snapcompact";
		if (event.aborted) {
			this.ctx.showStatus(
				isHandoffAction
					? "Auto-handoff cancelled"
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
					this.ctx.updateEditorTopBorder();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.lastAssistantUsage = undefined;
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorTopBorder();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			this.ctx.chatContainer.clear();
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			await this.ctx.reloadTodos();
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
		} else if (isSnapcompactAction) {
			this.ctx.showWarning("Auto-snapcompact maintenance failed; continuing without maintenance");
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#stopWorkingLoader();
		this.ctx.statusContainer.clear();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			// The retry path drops the failed assistant from runtime context. Do not
			// restore its inline Error row; just unpin the fixed-region banner so the
			// retry UI is the visible state.
			this.#pinnedErrorComponent = undefined;
			this.ctx.clearPinnedError();
		}
		const delaySeconds = Math.round(event.delayMs / 1000);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		if (!event.success) {
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
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
		// existing block is only safe while it sits inside the live region — a
		// still-mutating block above it means none of its rows have been committed
		// to native scrollback yet (commits are prefix-only and stop at the first
		// live block), so the grown block still repaints.
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.isWithinLiveRegion(previous)
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

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	sendCompletionNotification(): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		// Skip when the turn was aborted (e.g. ask cancelled with Ctrl+C) or
		// errored — those are not "Task complete" events. Mirrors the gate
		// already used by #currentContextTokens, #handleMessageEnd, and the
		// retry / TTSR / compaction skip paths across agent-session.ts.
		const last = this.ctx.viewSession.getLastAssistantMessage?.();
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
