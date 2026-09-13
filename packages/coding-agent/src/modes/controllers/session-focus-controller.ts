import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

/**
 * Pick the most recently active focusable subagent. Advisors are read-only
 * transcripts and aborted agents are terminal, so neither is focusable; the
 * main session is the view itself, not a focus target. A focused caller passes
 * its id to cycle to the next-most-recent agent (wrapping), so repeated
 * presses walk the roster instead of sticking on the newest row.
 */
export function pickRecentFocusableAgentId(refs: readonly AgentRef[], currentId?: string): string | undefined {
	const ordered = refs
		.filter(ref => ref.id !== MAIN_AGENT_ID && ref.kind !== "advisor" && ref.status !== "aborted")
		.filter(ref => ref.status === "running" || ref.status === "idle" || ref.status === "parked")
		.toSorted(
			(a, b) =>
				b.lastActivity - a.lastActivity || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
	if (ordered.length === 0) return undefined;
	if (!currentId) return ordered[0]?.id;
	const currentIndex = ordered.findIndex(ref => ref.id === currentId);
	if (currentIndex === -1) return ordered[0]?.id;
	return ordered[(currentIndex + 1) % ordered.length]?.id;
}

/**
 * SessionFocusController - Weak retargeting primitive between the rendering/
 * input layer and the AgentSession it displays.
 *
 * Focusing re-points the transcript, streaming event subscription, status
 * line, and editor prompt/interrupt at a subagent's live AgentSession (from
 * AgentRegistry) without touching the main session underneath; unfocusing
 * re-attaches the main session and rebuilds the transcript from its
 * authoritative state.
 */
export class SessionFocusController {
	#focusedAgentId: string | undefined;
	/** Session currently attached while focused; undefined when unfocused. */
	#attachedSession: AgentSession | undefined;
	#focusAttachment: Promise<boolean> | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#attachGeneration = 0;
	/** Monotonic focus-request id: a request that resolves after a newer one drops instead of clobbering the view. */
	#focusRequestSeq = 0;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistry = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentSession | undefined {
		return this.#attachedSession;
	}
	/** Focus the main view on an agent's live session. Throws an Error with a user-displayable message. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const request = ++this.#focusRequestSeq;
		let session: AgentSession;
		try {
			session = await this.lifecycle().ensureLive(id);
		} catch (error) {
			// A newer request owns the view now: a stale revive failure must
			// not surface after the winner already focused.
			if (request !== this.#focusRequestSeq) return;
			throw error;
		}
		// A newer focus request (e.g. a second click while a parked agent was
		// still reviving) wins: drop the stale completion instead of letting
		// the slower revive replace the view.
		if (request !== this.#focusRequestSeq) return;
		const sameSession = id === this.#focusedAgentId && session === this.#attachedSession;
		let attachment = this.#focusAttachment;
		// Reuse an in-flight rebuild without discarding unpersisted tool cards.
		if (sameSession) {
			if (!attachment) return;
		} else {
			++this.#attachGeneration;
			this.#focusedAgentId = id;
			this.#attachedSession = session;
			this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
			attachment = this.#attach(session);
			this.#focusAttachment = attachment;
		}
		let attached = false;
		try {
			attached = await attachment;
		} catch (error) {
			if (request !== this.#focusRequestSeq) return;
			throw error;
		} finally {
			if (this.#focusAttachment === attachment) this.#focusAttachment = undefined;
		}
		if (request !== this.#focusRequestSeq) return;
		if (attached && this.#focusedAgentId === id && this.#attachedSession === session) {
			this.ctx.showStatus(`Viewing agent ${id} — Esc returns to main, ←← hops to parent`);
		}
	}

	/** Focus the focused agent's parent agent, falling back to the main session. No-op when unfocused. */
	async focusParent(): Promise<void> {
		if (!this.#focusedAgentId) return;
		const parentId = this.registry.get(this.#focusedAgentId)?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.registry.get(parentId)) {
			return this.focusAgent(parentId);
		}
		return this.unfocus();
	}

	/** Return to the main session. No-op when unfocused. */
	async unfocus(): Promise<void> {
		// Explicit leave-main invalidates pending focus requests: without this,
		// an Esc pressed while a parked agent is still reviving would be
		// followed by the delayed focus landing anyway.
		this.#focusRequestSeq++;
		return this.#detachToMain();
	}

	/**
	 * Detach back to the main session without invalidating pending focus
	 * requests. Reactive teardown (a focused agent dying under us) must not
	 * cancel a newer explicit focus the way an explicit leave-main does.
	 */
	async #detachToMain(): Promise<void> {
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		const attached = await this.#attach(this.ctx.session);
		if (attached && this.#focusedAgentId === undefined) this.ctx.showStatus("Returned to main session");
	}

	dispose(): void {
		// A pending revive — or a running attachment — must not land during
		// teardown: invalidate both generations the way leave-main does.
		this.#focusRequestSeq++;
		++this.#attachGeneration;
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}
	/**
	 * Drop pending focus requests without touching the current view. Clicking
	 * the already-focused agent reaffirms it: that newer explicit act must win
	 * over an older still-reviving request.
	 */
	invalidatePendingFocus(): void {
		this.#focusRequestSeq++;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.#detachToMain().then(() => {
			this.ctx.showStatus(`Agent ${event.ref.id} is ${gone ? "gone" : event.ref.status}; returned to main session`);
		});
	}

	/** Retarget core, both directions: swap subscription, transcript, and status line onto `target`. */
	async #attach(target: AgentSession): Promise<boolean> {
		const generation = ++this.#attachGeneration;
		try {
			this.ctx.unsubscribe?.();
			this.ctx.clearTransientSessionUi();
			this.ctx.eventController.resetTranscriptAnchors();
			let assistantStreamSynced = false;
			const restoreAssistant = async (message: AssistantMessage): Promise<void> => {
				if (generation !== this.#attachGeneration) return;
				if (!assistantStreamSynced) {
					assistantStreamSynced = true;
					await this.ctx.eventController.handleEvent({ type: "message_start", message });
					if (generation !== this.#attachGeneration) return;
				}
				await this.ctx.eventController.handleEvent({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "start", partial: message },
				});
				if (generation === this.#attachGeneration) this.ctx.eventController.restorePendingToolResults();
			};
			this.ctx.unsubscribe = target.subscribe(async event => {
				if (generation !== this.#attachGeneration) return;
				if (event.type === "message_start" && event.message.role === "assistant") {
					assistantStreamSynced = true;
				} else if (
					(event.type === "message_update" || event.type === "message_end") &&
					event.message.role === "assistant" &&
					!assistantStreamSynced
				) {
					if (event.type === "message_end") await restoreAssistant(event.message);
					else {
						assistantStreamSynced = true;
						await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
					}
					if (generation !== this.#attachGeneration) return;
				}
				if (event.type === "message_end" && event.message.role === "assistant") assistantStreamSynced = false;
				await this.ctx.eventController.handleEvent(event);
			});

			await target.settleInFlightMessagePersistence();
			if (generation !== this.#attachGeneration) return false;
			this.ctx.statusLine.setSession(target, this.#focusedAgentId);
			// Reset run bookkeeping before replay populates pending tool handles.
			if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
			else setTerminalTitleState("idle");
			if (generation !== this.#attachGeneration) return false;
			await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
			if (generation !== this.#attachGeneration) return false;
			this.ctx.eventController.restorePendingToolResults();

			const live = target.agent.state.streamMessage;
			if (live?.role === "assistant") await restoreAssistant(live);
			if (generation !== this.#attachGeneration) return false;
			for (const event of target.activeToolExecutionUpdates()) {
				await this.ctx.eventController.handleEvent(event);
				if (generation !== this.#attachGeneration) return false;
			}
			await this.ctx.reloadTodos(target);
			if (generation !== this.#attachGeneration) return false;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.updateEditorBorderColor();
			this.ctx.ui.requestRender();
			return true;
		} catch (error) {
			if (generation === this.#attachGeneration) {
				this.#focusedAgentId = undefined;
				this.#attachedSession = undefined;
				// Keep a failed main replay subscribed; never recursively recover it.
				if (target !== this.ctx.session) {
					try {
						await this.#attach(this.ctx.session);
					} catch (recoveryError) {
						throw new AggregateError(
							[error, recoveryError],
							"Focus attachment and main-session recovery both failed",
						);
					}
				}
			}
			throw error;
		}
	}
}
