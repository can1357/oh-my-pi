import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { type Component, type OverlayHandle, replaceTabs } from "@oh-my-pi/pi-tui";
import type { TspMenuEntry } from "@oh-my-pi/pi-wire";
import { logger, toError, withTimeout } from "@oh-my-pi/pi-utils";
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurnKey,
	getBtwTurns,
} from "../../session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "../../session/btw-turn";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { focusActiveEditorArea } from "./selector-controller";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { BTW_INJECT_LABEL, type BtwInjectState } from "@oh-my-pi/pi-tui/overlays/btw-inject";
import { type BtwNoteAction, BtwNoteComponent, type BtwNoteHost } from "@oh-my-pi/pi-tui/overlays/btw-note";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import type { AgentViewSession, AgentViewSessionManager } from "../../session/agent-session-handle";
import type { DroppedPrompt } from "../../session/agent-session-types";
import { cfgBtwInject } from "../settings";
import type { InteractiveModeContext } from "../types";

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	images?: ImageContent[];
	leafId: string | null;
	sessionId: string;
	session: AgentViewSession;
	/** Manager of the view that asked; the request outlives focus changes. */
	sessionManager: AgentViewSessionManager;
	store: BtwHistoryStore;
	record: BtwHistoryRecord;
	history?: readonly BtwHistoryTurn[];
	/** At least one checkpoint belongs to this request; later failures must block lifecycle changes. */
	persisted: boolean;
	conversationKey: string;
	/**
	 * `btw.inject` eligibility when the question was asked, fixed for the request's life so the
	 * prompt instruction, the highlighted block, and the inject key always agree.
	 */
	injectEnabled: boolean;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({
				type: "thinking",
				thinking: part.thinking,
				...(part.summary !== undefined && { summary: part.summary }),
				...(part.narration && { narration: true }),
			});
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastImages: ImageContent[] | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#lastSessionId: string | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
	#copyInFlight = false;
	#visible = false;
	#starting = false;
	#transitionCount = 0;
	#generation = 0;
	#store: BtwHistoryStore | undefined;
	#storePromise: Promise<BtwHistoryStore> | undefined;
	#storeSessionId: string | undefined;
	#storeArtifactsDir: string | undefined;
	#storeScope: string | undefined;
	#historyPanel: BtwHistoryPanel | undefined;
	#historyOverlay: OverlayHandle | undefined;
	/** Tern's transcript notes of the store's topics on the shown branch, by topic id. */
	readonly #notes = new Map<string, BtwNoteComponent>();
	/** The topic whose note the composer talks to (Tern): drafts become its follow-ups. */
	#focus: string | undefined;
	readonly #noteHost: BtwNoteHost = {
		menu: (record, folded) => this.#noteMenu(record, folded),
		injectState: (record, turnIndex) => this.#noteInjectState(record, turnIndex),
		run: (record, action) => this.#runNoteAction(record, action),
	};
	readonly #writes = new Set<Promise<boolean>>();
	readonly #failedWrites = new Map<BtwRequest, Error>();
	/**
	 * Inject state per answer turn (`getBtwTurnKey`). Only turns answered in this process with
	 * the inject instruction and a closed block get an entry, so history from an earlier run, or
	 * an answer asked while injecting was off, never sends. Record ids are unique, so entries
	 * outlive session changes.
	 */
	readonly #injects = new Map<string, "ready" | "sending" | "sent">();
	/**
	 * Sends awaiting dispatch, by text: a prompt the session drops comes back here instead of the
	 * editor. An idle send keeps its entry until its turn settles, since the session reports drops
	 * by text alone; a typed prompt identical to the block dropped meanwhile would land here.
	 */
	readonly #droppedInjects = new Map<string, (prompt: DroppedPrompt) => void>();
	/** Turns whose send waits for startup-deferred extensions; `dispose()` cancels them back to ready. */
	readonly #awaitingExtensions = new Set<string>();

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** /btw asks about the transcript on screen: the focused agent's session, else main. */
	get #sessionManager(): AgentViewSessionManager {
		return this.ctx.focusedAgentId ? this.ctx.viewSession.sessionManager : this.ctx.sessionManager;
	}

	/** Focused agents share main's artifacts directory; scope their history by session id. */
	get #historyScope(): string | undefined {
		return this.ctx.focusedAgentId ? this.#sessionManager.getSessionId() : undefined;
	}

	/** Whether /btw owns Escape: the inline panel, or a note the composer talks to. */
	hasActiveRequest(): boolean {
		return this.#visible || this.#focus !== undefined;
	}

	/** Whether the composer talks to a note: its drafts go to {@link submitFollowUp}. */
	isFocused(): boolean {
		return this.#focus !== undefined;
	}

	/** Sends a composer draft to the focused note's topic; false when no follow-up started. */
	submitFollowUp(question: string, images?: ImageContent[]): Promise<boolean> {
		const id = this.#focus;
		return id === undefined ? Promise.resolve(false) : this.startFollowUp(id, question, undefined, images);
	}

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	/** The answer lives in the inline panel, or in Tern's open history sheet. */
	#answerShown(): boolean {
		return this.#visible || (this.ctx.ui.nativeRendering && this.#historyOverlay !== undefined);
	}

	/** Whether plain `b` is currently reserved for a completed or pending branch action. */
	handlesBranchKey(): boolean {
		if (this.#branchInFlight) return true;
		if (!this.#answerShown() || this.#activeRequest?.component.isBranchable() !== true) return false;
		// Branch promotion rewrites the main session; focused-subagent answers stay side-only.
		if (this.#activeRequest.session !== this.ctx.session || this.ctx.focusedAgentId) return false;
		return (
			this.#lastQuestion !== undefined &&
			this.#lastReplyText !== undefined &&
			this.#lastAssistantMessage !== undefined &&
			this.#lastLeafId !== undefined &&
			this.#lastSessionId !== undefined
		);
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		if ([...this.#injects.values()].includes("sending")) return "a /btw prompt is still sending";
		if (this.#transitionCount > 0) return "a session operation is in progress";
		const request = this.#activeRequest;
		const shown = this.#answerShown() || (request !== undefined && this.#notes.has(request.record.id));
		if (!shown || request?.component.isBranchable() !== true) return "the answer is not ready";
		if (request.session !== this.ctx.session || this.ctx.focusedAgentId)
			return "only main-session answers can be branched";
		// Inline branch promotion carries one pair; do not drop earlier side turns.
		if (request.history?.length) return "multi-turn side conversations remain in BTW history";
		if (!this.#lastQuestion || !this.#lastReplyText || !this.#lastAssistantMessage)
			return "the answer is unavailable";
		if (!this.#lastLeafId) return "the session has no branch point";
		if (
			this.#lastSessionId !== this.ctx.sessionManager.getSessionId() ||
			this.#lastLeafId !== this.ctx.sessionManager.getLeafId()
		)
			return "the session changed since /btw started";
		if (this.ctx.session.isStreaming) return "a turn is still running";
		return undefined;
	}

	canCopy(): boolean {
		return (
			this.#visible &&
			!this.#copyInFlight &&
			this.#activeRequest?.component.isCopyable() === true &&
			this.#lastCopyText !== undefined
		);
	}

	async #copyAnswer(answer: string, options?: { historyRecordId?: string }): Promise<boolean> {
		if (this.#copyInFlight || !answer.trim()) return false;
		this.#copyInFlight = true;
		// Clipboard writes settle asynchronously; the user may close this panel or
		// start another /btw before they do. Confirm only the still-active surface.
		const inlineRequest = options?.historyRecordId === undefined ? this.#activeRequest : undefined;
		try {
			await copyToClipboard(replaceTabs(answer).trim());
			this.ctx.showStatus("Copied /btw answer to clipboard");
			if (options?.historyRecordId !== undefined) this.#historyPanel?.markCopied(options.historyRecordId, answer);
			else if (inlineRequest && this.#visible && this.#activeRequest === inlineRequest)
				inlineRequest.component.markCopied();
			return true;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || this.#lastCopyText === undefined) return false;
		return this.#copyAnswer(this.#lastCopyText);
	}

	async handleBranch(): Promise<boolean> {
		const unavailableReason = this.#branchUnavailableReason();
		if (unavailableReason) {
			this.ctx.showStatus(`/btw branch unavailable: ${unavailableReason}`, { dim: true });
			return false;
		}
		const request = this.#activeRequest;
		const question = this.#lastQuestion;
		const images = this.#lastImages;
		const assistantMessage = this.#lastAssistantMessage;
		const leafId = this.#lastLeafId;
		const sessionId = this.#lastSessionId;
		if (!request || !question || !assistantMessage || !leafId || !sessionId) return false;
		this.#branchInFlight = true;
		request.component.markBranching();
		try {
			await this.flush();
			await this.ctx.handleBtwBranch(question, assistantMessage, leafId, sessionId, images);
			return true;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(`Cannot branch /btw: ${toError(error).message}`));
			return false;
		} finally {
			this.#branchInFlight = false;
			if (this.#activeRequest === request) request.component.markComplete();
		}
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw branch is in progress", { dim: true });
			return true;
		}
		if (this.#focus !== undefined) {
			this.#setFocus(undefined);
			return true;
		}
		if (!this.#visible) return false;
		if (this.handleCancel()) return true;
		this.#hideInline();
		return true;
	}

	canFollowUp(): boolean {
		const request = this.#activeRequest;
		return (
			this.#visible &&
			!this.#starting &&
			!this.#branchInFlight &&
			this.#transitionCount === 0 &&
			request !== undefined &&
			this.#isActiveRequest(request) &&
			// Follow-ups reopen the request's own history; leaving its view parks them.
			request.sessionId === this.#sessionManager.getSessionId() &&
			getBtwLatestTurn(request.record).status === "complete"
		);
	}

	handleFollowUp(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.canFollowUp()) return false;
		return this.#showHistory(request.store).openFollowUp(request.record.id);
	}

	canInject(): boolean {
		const request = this.#activeRequest;
		return this.#visible && request !== undefined && this.#isActiveRequest(request) && this.#canSend(request.record);
	}

	handleInject(): boolean {
		const request = this.#activeRequest;
		if (!request || !this.canInject()) return false;
		this.#inject(request.record);
		return true;
	}

	/**
	 * Whether side answers asked now may steer the main session: `btw.inject` is on, the main
	 * session is in view, and this host runs its turns (not a collab guest). Read once per
	 * surface (inline answer, history sheet), so one value gates the prompt instruction, the
	 * highlighted block, and the inject key there.
	 */
	#injectEnabled(): boolean {
		return cfgBtwInject.get(this.ctx.settings) && !this.ctx.focusedAgentId && !this.ctx.collabGuest;
	}

	/** The topic's latest answer is ready to send, and no branch or session move would race the new main-session turn. */
	#canSend(record: BtwHistoryRecord): boolean {
		return (
			!this.#starting &&
			!this.#branchInFlight &&
			this.#transitionCount === 0 &&
			this.#injects.get(getBtwTurnKey(record)) === "ready"
		);
	}

	/** How a turn's `<inject>` block shows in history: sent, pending on the latest turn, or plain text. */
	#injectState(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined {
		const state = this.#injects.get(getBtwTurnKey(record, turnIndex));
		if (state === "sent") return "sent";
		return state && turnIndex === getBtwTurns(record).length - 1 ? "pending" : undefined;
	}

	/**
	 * A prompt the session dropped before dispatch: if it is an inject in flight, take it back so
	 * the inject key stays its one retry path. Returns whether it was an inject.
	 */
	reclaimDroppedPrompt(prompt: DroppedPrompt): boolean {
		const reclaim = this.#droppedInjects.get(prompt.text);
		if (!reclaim) return false;
		this.#droppedInjects.delete(prompt.text);
		reclaim(prompt);
		return true;
	}

	/**
	 * Send the topic's steering prompt to the main session as a user message: a steer while the
	 * agent runs, else a new turn. Slash commands and templates are not expanded, so model-written
	 * text never runs as a command. The turn counts as sent once admitted. A send dropped or refused
	 * before it reached the transcript or the steer queue turns back to ready, with the inject key
	 * as its one retry path; a later failure keeps it sent, so it is never sent twice.
	 */
	#inject(record: BtwHistoryRecord): void {
		const text = getBtwRecordInject(record);
		if (!text) return;
		const key = getBtwTurnKey(record);
		const session = this.ctx.session;
		const settle = (sent: boolean, reason?: string): void => {
			this.#injects.set(key, sent ? "sent" : "ready");
			// Only the turn that was sent: a follow-up may have taken the panel while the send waited.
			const request = this.#activeRequest;
			if (request && getBtwTurnKey(request.record) === key) request.component.setInjected(sent);
			this.#refreshHistory();
			this.#notes.get(record.id)?.refresh();
			if (sent) return;
			if (reason) {
				this.ctx.showError(sanitizeErrorLine(`Cannot inject /btw prompt: ${reason}`));
				return;
			}
			const retry = appKey(this.ctx.keybindings, "app.btw.inject");
			this.ctx.showStatus(retry ? `/btw prompt not sent · ${retry} to retry` : "/btw prompt not sent", {
				dim: true,
			});
		};
		const send = (): void => {
			let admitted = false;
			let queued = false;
			let reclaimed = false;
			const lastUserMessage = () => session.messages.findLast(message => message.role === "user");
			const userBefore = lastUserMessage();
			const reclaim = (prompt: DroppedPrompt): void => {
				reclaimed = true;
				settle(false, prompt.reason);
			};
			this.#droppedInjects.set(text, reclaim);
			session
				.prompt(text, {
					expandPromptTemplates: false,
					streamingBehavior: "steer",
					throwOnDrop: true,
					onPromptQueued: () => {
						queued = true;
					},
					onPromptAdmitted: () => {
						admitted = true;
						settle(true);
					},
				})
				.then(
					// A drop while queueing resolves without admission: nothing was sent.
					() => {
						if (!admitted && !reclaimed) settle(false);
					},
					(error: unknown) => {
						if (reclaimed) return;
						const message = toError(error).message;
						// Already in the steer queue or the transcript: it was sent, so keep the mark.
						if (queued || lastUserMessage() !== userBefore) this.ctx.showError(sanitizeErrorLine(message));
						else settle(false, message);
					},
				)
				.finally(() => {
					if (this.#droppedInjects.get(text) === reclaim) this.#droppedInjects.delete(text);
				});
		};
		this.#injects.set(key, "sending");
		if (!session.hasPendingDeferredExtensions) {
			send();
			return;
		}
		// `prompt()` would wait for startup-deferred extensions before its own session-switch
		// checks run, so a `/new` in that wait could land this prompt in the new session. Wait
		// here instead: `dispose()` cancels the wait (and bumps the generation, so the late
		// settlement is ignored), and a session move in progress drops the send.
		const generation = this.#generation;
		const sessionId = this.ctx.sessionManager.getSessionId();
		this.#awaitingExtensions.add(key);
		session.loadDeferredExtensions().then(
			() => {
				if (generation !== this.#generation) return;
				this.#awaitingExtensions.delete(key);
				if (this.#transitionCount === 0 && sessionId === this.ctx.sessionManager.getSessionId()) send();
				else settle(false);
			},
			(error: unknown) => {
				if (generation !== this.#generation) return;
				this.#awaitingExtensions.delete(key);
				settle(false, toError(error).message);
			},
		);
	}

	handleCancel(): boolean {
		const request = this.#activeRequest;
		if (!request || getBtwLatestTurn(request.record).status !== "running") return false;
		this.#updateRequest(request, { status: "cancelled", updatedAt: Date.now() });
		request.abortController.abort();
		request.component.markAborted();
		this.#notes.get(request.record.id)?.update(request.record);
		this.#persist(request);
		this.#refreshHistory();
		return true;
	}

	async dispose(): Promise<void> {
		this.#generation++;
		for (const key of this.#awaitingExtensions) this.#injects.set(key, "ready");
		this.#awaitingExtensions.clear();
		this.#transitionCount++;
		try {
			this.handleCancel();
			// A timeout must stop the caller before it moves/deletes the old path.
			// Keep the current view/store available until outstanding writes settle.
			await this.flush();
			this.#closeHistory();
			this.#hideInline();
			this.#setFocus(undefined);
			this.#notes.clear();
			this.#activeRequest?.component.close();
			this.#activeRequest = undefined;
			this.#clearCompletedState();
			this.#store = undefined;
			this.#storePromise = undefined;
			this.#storeSessionId = undefined;
			this.#storeArtifactsDir = undefined;
			this.#storeScope = undefined;
		} finally {
			this.#transitionCount--;
		}
	}

	async flush(timeoutMs = 10_000): Promise<void> {
		await withTimeout(
			this.#drainWrites(),
			timeoutMs,
			"BTW history is still being saved. The session operation was stopped; retry when storage responds.",
		);
	}

	async #drainWrites(): Promise<void> {
		// Retrying a session operation retries already-failed snapshots without
		// rebasing their disk revisions. Newly failing writes still reject below.
		const failuresAtStart = [...this.#failedWrites.keys()];
		for (const request of failuresAtStart) await this.#persist(request, true);
		while (this.#writes.size > 0) await Promise.all(this.#writes);
		const failure = this.#failedWrites.values().next().value;
		if (failure) {
			throw new Error(
				sanitizeErrorLine(
					`BTW history could not be saved: ${sanitizeErrorLine(failure)}. The session operation was stopped; retry after fixing storage. Unsaved answers remain in /btw.`,
					TRUNCATE_LENGTHS.RECAP,
				),
				{ cause: failure },
			);
		}
	}

	async withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		if (
			this.#starting ||
			this.#branchInFlight ||
			this.#transitionCount > 0 ||
			(this.#activeRequest && getBtwLatestTurn(this.#activeRequest.record).status === "running")
		) {
			this.ctx.showStatus("Wait for the current /btw answer to finish or cancel it before moving.", { dim: true });
			return false;
		}
		this.#transitionCount++;
		try {
			await this.flush();
			const moved = await operation();
			if (moved) await this.dispose();
			return moved;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(error));
			return false;
		} finally {
			this.#transitionCount--;
		}
	}

	/** Whether the store opened (or opening) is the one of the session view on screen. */
	#storeMatchesView(): boolean {
		return (
			this.#storeSessionId === this.#sessionManager.getSessionId() &&
			this.#storeArtifactsDir === (this.#sessionManager.getArtifactsDir() ?? undefined) &&
			this.#storeScope === this.#historyScope
		);
	}

	async #loadHistory(): Promise<BtwHistoryStore> {
		const sessionId = this.#sessionManager.getSessionId();
		const artifactsDir = this.#sessionManager.getArtifactsDir() ?? undefined;
		const scope = this.#historyScope;
		if (!this.#storeMatchesView()) {
			await this.dispose();
			if (
				this.#sessionManager.getSessionId() !== sessionId ||
				(this.#sessionManager.getArtifactsDir() ?? undefined) !== artifactsDir ||
				this.#historyScope !== scope
			) {
				throw new Error("The session changed while opening BTW history.");
			}
			this.#storeSessionId = sessionId;
			this.#storeArtifactsDir = artifactsDir;
			this.#storeScope = scope;
		}
		this.#storePromise ??= BtwHistoryStore.open(artifactsDir, scope);
		const pending = this.#storePromise;
		try {
			const store = await pending;
			if (this.#storePromise === pending) this.#store = store;
			return store;
		} catch (error) {
			if (this.#storePromise === pending) this.#storePromise = undefined;
			throw error;
		}
	}

	/**
	 * Ask a side question; resolves `false` when no question started and no history opened.
	 * `title` heads the topic instead of the question, e.g. `/sitrep` rather than its expanded template.
	 */
	start(question: string, images?: ImageContent[], title?: string): Promise<boolean> {
		return this.#start(question, undefined, undefined, images, title);
	}

	async startFollowUp(
		recordId: string,
		question: string,
		signal?: AbortSignal,
		images?: ImageContent[],
	): Promise<boolean> {
		if (!question.trim()) return false;
		return this.#start(question, recordId, signal, images);
	}

	async #start(
		question: string,
		recordId?: string,
		signal?: AbortSignal,
		images?: ImageContent[],
		title?: string,
	): Promise<boolean> {
		if (signal?.aborted) return false;
		const trimmedQuestion = question.trim();
		if (this.#starting || this.#branchInFlight || this.#transitionCount > 0) {
			this.ctx.showStatus("A /btw action is in progress. Please wait.", { dim: true });
			return false;
		}
		const viewSession = this.ctx.focusedAgentId ? this.ctx.viewSession : this.ctx.session;
		const active = this.#activeRequest;
		if (active && getBtwLatestTurn(active.record).status === "running") {
			if (active.session !== viewSession) {
				// Opening this view's store would dispose (cancel) the other view's live question.
				this.ctx.showStatus(
					"A /btw question is still running in another session view. Wait for it or cancel it first.",
					{ dim: true },
				);
				return false;
			}
			if (trimmedQuestion && active.sessionId === this.#sessionManager.getSessionId()) {
				this.ctx.showStatus("A /btw question is still running. Open /btw to view it or cancel it first.", {
					dim: true,
				});
				return false;
			}
		}
		const originalSessionId = this.#sessionManager.getSessionId();
		this.#starting = true;
		try {
			const store = await this.#loadHistory();
			const generation = this.#generation;
			const sessionId = this.#sessionManager.getSessionId();
			if (signal?.aborted || store !== this.#store || sessionId !== originalSessionId) return false;
			if (!trimmedQuestion) {
				const panel = this.#showHistory(store);
				// Tern: reopening lands on the side question put away while it answered.
				const active = this.#activeRequest;
				if (this.ctx.ui.nativeRendering && active?.store === store && this.#isActiveRequest(active)) {
					panel.showRecord(active.record.id);
				}
				return true;
			}
			// A just-cancelled/completed turn may still be publishing its checkpoint.
			await this.flush();
			if (
				signal?.aborted ||
				generation !== this.#generation ||
				store !== this.#store ||
				sessionId !== this.#sessionManager.getSessionId()
			)
				return false;
			const previous = recordId ? store.getRecords().find(record => record.id === recordId) : undefined;
			if (recordId && (!previous || getBtwLatestTurn(previous).status === "running")) {
				this.ctx.showStatus("This side conversation is unavailable or still running.", { dim: true });
				return false;
			}
			if (!viewSession.model) {
				this.ctx.showError("No active model available for /btw.");
				return false;
			}
			await this.#sessionManager.ensureOnDisk();
			if (signal?.aborted || generation !== this.#generation || sessionId !== this.#sessionManager.getSessionId())
				return false;
			if (!previous) this.#closeHistory();
			this.#activeRequest?.component.close();
			this.#clearCompletedState();
			const leafId = this.#sessionManager.getLeafId();
			const { record, history, conversationKey } = beginBtwTurn(trimmedQuestion, leafId, previous, images, title);
			const injectEnabled = this.#injectEnabled();
			const request: BtwRequest = {
				component: new BtwPanelComponent({
					question: trimmedQuestion,
					title,
					tui: this.ctx.ui,
					canBranch: () => this.canBranch(),
					canFollowUp: () => this.canFollowUp(),
					canInject: injectEnabled ? () => this.canInject() : undefined,
				}),
				abortController: new AbortController(),
				question: trimmedQuestion,
				images,
				leafId,
				sessionId,
				session: viewSession,
				sessionManager: this.#sessionManager,
				store,
				record,
				history,
				conversationKey,
				persisted: false,
				injectEnabled,
			};
			this.#activeRequest = request;
			// Tern draws the topic as a note in its transcript; the text renderer keeps the inline panel.
			const native = this.ctx.ui.nativeRendering;
			this.#visible = !native && (!previous || !this.#historyOverlay);
			this.ctx.btwContainer.clear();
			if (this.#visible) this.ctx.btwContainer.addChild(request.component);
			this.ctx.ui.requestRender();
			if (!(await this.#persist(request))) {
				if (this.#activeRequest === request) {
					this.#activeRequest = undefined;
					request.component.close();
					this.#hideInline();
					this.#store = undefined;
					this.#storePromise = undefined;
					this.#historyPanel?.update(store.getRecords());
				}
				return false;
			}
			if (
				generation !== this.#generation ||
				!this.#isActiveRequest(request) ||
				getBtwLatestTurn(request.record).status !== "running"
			)
				return false;
			if (signal?.aborted) {
				// The initial checkpoint may already own a topic lease. Finish it as
				// cancelled before accepting another turn, without dispatching a model.
				this.handleCancel();
				await this.flush();
				return false;
			}
			this.#refreshHistory();
			if (native) this.#showNote(request.record, { append: !previous });
			void this.#runRequest(request);
			return true;
		} catch (error) {
			this.ctx.showError(sanitizeErrorLine(`Cannot open /btw history: ${toError(error).message}`));
			return false;
		} finally {
			this.#starting = false;
		}
	}

	#showHistory(store: BtwHistoryStore): BtwHistoryPanel {
		if (this.#historyOverlay && this.#historyPanel) {
			this.#refreshHistory();
			return this.#historyPanel;
		}
		this.#hideInline();
		const historySessionId = this.#sessionManager.getSessionId();
		const panel = new BtwHistoryPanel({
			records: this.#historyRecords(store),
			onClose: () => this.#closeHistory(),
			onCopy: record => {
				const answer = getBtwCopyText(record);
				if (answer !== undefined) void this.#copyAnswer(answer, { historyRecordId: record.id });
			},
			onCancel: record => {
				if (this.#activeRequest?.record.id === record.id) this.handleCancel();
			},
			canBranch: record => record.id === this.#activeRequest?.record.id && this.canBranch(),
			onBranch: record => {
				if (record.id !== this.#activeRequest?.record.id) return;
				void this.handleBranch();
			},
			canFollowUp: record =>
				!this.#starting &&
				!this.#branchInFlight &&
				this.#transitionCount === 0 &&
				getBtwLatestTurn(record).status !== "running" &&
				(!this.#activeRequest || getBtwLatestTurn(this.#activeRequest.record).status !== "running"),
			onFollowUp: (record, question, signal, images) => {
				if (historySessionId !== this.#sessionManager.getSessionId()) {
					return Promise.resolve(false);
				}
				return this.startFollowUp(record.id, question, signal, images);
			},
			onPasteImage: () => this.ctx.handleImagePaste(),
			onPasteImagePath: path => this.ctx.handleImagePathPaste(path),
			spaceHoldKeys: this.ctx.keybindings.getKeys("app.stt.pushToTalk"),
			spaceHold: input => this.ctx.dictationSpaceHold(input),
			requestRender: () => this.ctx.ui.requestRender(),
			inject: this.#injectEnabled()
				? {
						state: (record, turnIndex) => this.#injectState(record, turnIndex),
						canSend: record => this.#canSend(record),
						send: record => this.#inject(record),
					}
				: undefined,
			getHeight: () => this.ctx.ui.terminal.rows,
			// Tern has no inline panel: Esc puts the sheet away, `x` cancels.
			escapeHides: this.ctx.ui.nativeRendering,
		});
		this.#historyPanel = panel;
		this.#historyOverlay = this.ctx.ui.showOverlay(panel, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(panel);
		this.ctx.ui.requestRender();
		return panel;
	}

	#historyRecords(store: BtwHistoryStore): readonly BtwHistoryRecord[] {
		const records = store.getRecords();
		const request = this.#activeRequest;
		if (!request || request.store !== store) return records;
		return records.map(record => (record.id === request.record.id ? request.record : record));
	}

	#refreshHistory(): void {
		if (this.#historyPanel && this.#store) this.#historyPanel.update(this.#historyRecords(this.#store));
	}

	#closeHistory(): void {
		const overlay = this.#historyOverlay;
		this.#historyOverlay = undefined;
		this.#historyPanel = undefined;
		if (!overlay) return;
		overlay.hide();
		focusActiveEditorArea(this.ctx);
		// Closing while a BTW still answers keeps it running: text mode returns
		// to its inline panel; Tern answers in its note, or says how to get back.
		const request = this.#activeRequest;
		if (request && this.#isActiveRequest(request) && getBtwLatestTurn(request.record).status === "running") {
			if (this.ctx.ui.nativeRendering) {
				if (!this.#notes.has(request.record.id)) {
					this.ctx.showStatus("/btw is still answering in the background · /btw to reopen it", { dim: true });
				}
			} else {
				request.component.setAnswer(getBtwLatestTurn(request.record).answer);
				this.#visible = true;
				this.ctx.btwContainer.clear();
				this.ctx.btwContainer.addChild(request.component);
			}
		}
		this.ctx.ui.requestRender();
	}

	#persist(request: BtwRequest, retry = false): Promise<boolean> {
		const pending = retry ? request.store.retry(request.record) : request.store.upsert(request.record);
		const write = pending.then(
			() => {
				request.persisted = true;
				this.#failedWrites.delete(request);
				return true;
			},
			error => {
				// An initial rejection never dispatched a model or owned a disk
				// checkpoint; terminal failures must survive removal from #writes.
				if (request.persisted) this.#failedWrites.set(request, toError(error));
				logger.error("BTW history save failed", { error });
				if (request.sessionId === request.sessionManager.getSessionId()) {
					this.ctx.showError(sanitizeErrorLine(`Could not save /btw history: ${toError(error).message}`));
				}
				return false;
			},
		);
		this.#writes.add(write);
		void write.then(
			() => this.#writes.delete(write),
			() => this.#writes.delete(write),
		);
		return write;
	}

	#updateRequest(request: BtwRequest, patch: Partial<BtwHistoryTurn>): void {
		request.record = patchLatestBtwTurn(request.record, patch);
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			const { replyText, assistantMessage } = await runBtwTurn(request.session, {
				question: request.question,
				images: request.images,
				history: request.history,
				// The same eligibility as the block and the key: no instruction where a block could never be sent.
				inject: request.injectEnabled,
				conversationKey: request.conversationKey,
				onTextDelta: delta => {
					const latest = getBtwLatestTurn(request.record);
					if (latest.status !== "running") return;
					this.#updateRequest(request, { answer: latest.answer + delta, updatedAt: Date.now() });
					if (this.#isActiveRequest(request)) {
						if (this.#visible) request.component.appendText(delta);
						this.#refreshHistory();
						this.#notes.get(request.record.id)?.update(request.record);
					}
				},
				signal: request.abortController.signal,
			});
			if (getBtwLatestTurn(request.record).status !== "running") return;
			this.#updateRequest(request, { answer: replyText, status: "complete", updatedAt: Date.now() });
			// Only an answer asked with the inject instruction can be sent, even if the setting is turned on later.
			if (request.injectEnabled && getBtwRecordInject(request.record) !== undefined) {
				this.#injects.set(getBtwTurnKey(request.record), "ready");
			}
			if (this.#isActiveRequest(request)) {
				request.component.setAnswer(replyText);
				request.component.markComplete();
				// Tern: an answer folded away or left only in history says it is ready.
				if (this.ctx.ui.nativeRendering && !this.#historyOverlay) {
					const note = this.#notes.get(request.record.id);
					if (!note) this.ctx.showStatus("/btw answer ready · /btw to read it");
					else if (note.folded) this.ctx.showStatus("/btw answer ready");
				}
				const copyText = request.component.getCopyText();
				if (copyText !== undefined) {
					this.#lastQuestion = request.question;
					this.#lastImages = request.images;
					this.#lastReplyText = replyText;
					this.#lastCopyText = copyText;
					this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
					this.#lastLeafId = request.leafId;
					this.#lastSessionId = request.sessionId;
				} else this.#clearCompletedState();
			}
		} catch (error) {
			if (getBtwLatestTurn(request.record).status !== "running") return;
			const cancelled = request.abortController.signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			this.#updateRequest(request, {
				status: cancelled ? "cancelled" : "error",
				updatedAt: Date.now(),
				...(cancelled ? {} : { error: message }),
			});
			if (this.#isActiveRequest(request)) {
				if (cancelled) request.component.markAborted();
				else request.component.markError(message);
			}
		}
		this.#persist(request);
		if (this.#isActiveRequest(request)) {
			this.#refreshHistory();
			this.#notes.get(request.record.id)?.update(request.record);
		}
	}

	#hideInline(): void {
		this.#visible = false;
		this.ctx.btwContainer.clear();
		this.ctx.ui.requestRender();
	}

	/** Makes the composer talk to topic `id`'s note (undefined: back to the chat); the note rings while it does. */
	#setFocus(id: string | undefined): void {
		if (this.#focus === id) return;
		if (this.#focus !== undefined) this.#notes.get(this.#focus)?.setActive(false);
		this.#focus = id;
		if (id !== undefined) this.#notes.get(id)?.setActive(true);
		// The composer's role, chip and placeholder follow.
		this.ctx.ui.requestRender();
	}

	/** Tern: the topic's note, updated in place, or (`append`) a new one at the transcript's end. */
	#showNote(record: BtwHistoryRecord, options: { append: boolean }): void {
		const note = this.#notes.get(record.id);
		if (note) {
			note.update(record);
			note.setFolded(false);
			return;
		}
		if (!options.append) return;
		this.ctx.chatContainer.addChild(this.#createNote(record, { folded: false }));
		this.ctx.ui.requestRender();
	}

	#createNote(record: BtwHistoryRecord, options: { folded: boolean }): BtwNoteComponent {
		const note = new BtwNoteComponent({ record, folded: options.folded, tui: this.ctx.ui, host: this.#noteHost });
		this.#notes.set(record.id, note);
		return note;
	}

	/** A note's right-click entries: what can be done with its topic now; a press re-checks. */
	#noteMenu(record: BtwHistoryRecord, folded: boolean): TspMenuEntry[] {
		const entries: TspMenuEntry[] = [];
		if (getBtwCopyText(record) !== undefined) entries.push({ id: "btw-copy", label: "Copy answer", icon: "copy" });
		if (this.#canSend(record)) entries.push({ id: "btw-inject", label: BTW_INJECT_LABEL });
		const status = getBtwLatestTurn(record).status;
		if (this.#activeRequest?.record.id === record.id) {
			if (status === "running") entries.push({ id: "btw-stop", label: "Stop answer", icon: "stop" });
			else if (status === "complete" && !record.followUps?.length) {
				entries.push({ id: "btw-branch", label: "Branch into chat", icon: "branch" });
			}
		}
		entries.push(
			{ id: "btw-history", label: "Open in BTW history", icon: "history" },
			"-",
			folded ? { id: "btw-expand", label: "Expand" } : { id: "btw-fold", label: "Fold to one line" },
		);
		return entries;
	}

	/** A note's `<inject>` block: pending while a turn asked with the instruction streams, else as history shows it. */
	#noteInjectState(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined {
		if (getBtwTurns(record)[turnIndex]?.status !== "running") return this.#injectState(record, turnIndex);
		const request = this.#activeRequest;
		return request?.record.id === record.id && request.injectEnabled ? "pending" : undefined;
	}

	#runNoteAction(record: BtwHistoryRecord, action: BtwNoteAction): void {
		const note = this.#notes.get(record.id);
		switch (action) {
			case "btw-focus":
				this.#setFocus(this.#focus === record.id ? undefined : record.id);
				return;
			case "btw-expand":
				note?.setFolded(false);
				this.#setFocus(record.id);
				return;
			case "btw-fold":
				note?.setFolded(true);
				if (this.#focus === record.id) this.#setFocus(undefined);
				return;
			case "btw-copy": {
				const answer = getBtwCopyText(record);
				if (answer !== undefined) void this.#copyAnswer(answer);
				return;
			}
			case "btw-inject":
				if (this.#canSend(record)) this.#inject(record);
				return;
			case "btw-branch":
				void this.handleBranch();
				return;
			case "btw-stop":
				if (this.#activeRequest?.record.id === record.id) this.handleCancel();
				return;
			case "btw-history":
				if (this.#store) this.#showHistory(this.#store).showRecord(record.id);
				return;
		}
	}

	/**
	 * Tern: puts the topics asked on the transcript's branch back into it after a rebuild, each
	 * before the first message newer than it, folded unless already shown in this process. Opens
	 * the view's history first when it is not open, unless that would cancel a question still
	 * answering in another view. Resolves once placed (or skipped); never rejects.
	 */
	async placeNotes(): Promise<void> {
		if (!this.ctx.ui.nativeRendering) return;
		if (this.#store && this.#storeMatchesView()) {
			this.#placeNotes(this.#store);
			return;
		}
		const active = this.#activeRequest;
		const answering = active !== undefined && getBtwLatestTurn(active.record).status === "running";
		if (answering || this.#starting || this.#transitionCount > 0) return;
		const sessionId = this.#sessionManager.getSessionId();
		try {
			const store = await this.#loadHistory();
			if (store === this.#store && sessionId === this.#sessionManager.getSessionId()) this.#placeNotes(store);
		} catch (error) {
			logger.warn("BTW notes not restored", { error: toError(error).message });
		}
	}

	#placeNotes(store: BtwHistoryStore): void {
		const container = this.ctx.chatContainer;
		const shown = new Map<Component, number>();
		container.children.forEach((child, index) => shown.set(child, index));
		const onBranch = new Set<string>();
		// Message blocks in transcript order with when their message was created.
		const anchors: { at: number; index: number }[] = [];
		for (const entry of this.#sessionManager.getBranch()) {
			onBranch.add(entry.id);
			if (entry.type !== "message") continue;
			const component = this.ctx.transcriptMessageComponents.get(entry.message);
			const index = component && shown.get(component);
			if (index !== undefined) anchors.push({ at: entry.message.timestamp, index });
		}
		const notes = new Map<string, BtwNoteComponent>();
		const inserts: { index: number; at: number; note: BtwNoteComponent }[] = [];
		for (const record of this.#historyRecords(store)) {
			if (record.leafId !== null && !onBranch.has(record.leafId)) continue;
			const existing = this.#notes.get(record.id);
			const note = existing ?? this.#createNote(record, { folded: true });
			if (existing) note.update(record);
			notes.set(record.id, note);
			// Still in the transcript (a rebuild that kept it): it stays where it is.
			if (shown.has(note)) continue;
			const index = anchors.find(anchor => anchor.at > record.createdAt)?.index ?? container.children.length;
			inserts.push({ index, at: record.createdAt, note });
		}
		// From the end, so earlier indices hold; the older of two notes at one index goes first.
		inserts.sort((a, b) => b.index - a.index || b.at - a.at);
		for (const { index, note } of inserts) container.insertChildAt(note, index);
		this.#notes.clear();
		for (const [id, note] of notes) this.#notes.set(id, note);
		if (this.#focus !== undefined && !notes.has(this.#focus)) this.#setFocus(undefined);
		this.ctx.ui.requestRender();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastImages = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
		this.#lastSessionId = undefined;
	}

	/** The request is current and its own session is still loaded, whichever view is on screen. */
	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request && request.sessionId === request.sessionManager.getSessionId();
	}
}
