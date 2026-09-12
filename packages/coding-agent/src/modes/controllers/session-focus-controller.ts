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
		// Doom in-flight attachments from older requests now that this one is
		// known usable — not at request time, so a newer revival that fails
		// leaves the current attachment undisturbed instead of half torn down.
		++this.#attachGeneration;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		let attached = false;
		try {
			attached = await this.#attach(session);
		} catch (error) {
			// Same supersede rule as the revive above: only the current
			// request may surface attachment failures.
			if (request !== this.#focusRequestSeq) return;
			throw error;
		}
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
		this.ctx.unsubscribe?.();
		this.ctx.clearTransientSessionUi();
		this.ctx.eventController.resetTranscriptAnchors();
		// Orphan-delta guard: when attaching mid-turn the message_start for the
		// in-flight assistant message predates the attach. message_update carries
		// the full accumulating message, so synthesize the missing start before
		// the first orphaned update; every other handler is tolerant of unknown
		// anchors (guarded by streamingComponent/pendingTools lookups).
		let assistantStreamSynced = false;
		this.ctx.unsubscribe = target.subscribe(async event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				assistantStreamSynced = true;
			} else if (event.type === "message_update" && event.message.role === "assistant" && !assistantStreamSynced) {
				assistantStreamSynced = true;
				await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
			}
			await this.ctx.eventController.handleEvent(event);
		});
		// Events emitted while another session was focused had no TUI listener,
		// but their message_end handlers still persist authoritative transcript
		// state asynchronously. Subscribe first, then settle the persistence
		// already in flight at this boundary before replay: an already-emitted
		// tool completion becomes a persisted toolResult, so the rebuild can't
		// resurrect a result-less toolCall whose only completion was lost during
		// the blackout (#9816). Later events reach the newly installed listener.
		await target.settleInFlightMessagePersistence();
		if (generation !== this.#attachGeneration) return false;
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		await this.ctx.renderInitialMessages({ clearTerminalHistory: true });
		if (generation !== this.#attachGeneration) return false;
		// Partial tool results are display events, not persisted messages. Replay
		// each target's latest snapshot after rebuilding so focus navigation does
		// not collapse a live task board back to its bare call arguments (#10446).
		for (const event of target.activeToolExecutionUpdates()) {
			await this.ctx.eventController.handleEvent(event);
			if (generation !== this.#attachGeneration) return false;
		}
		// Retarget the sticky Todo HUD too. While a subagent is focused the main
		// session's `todo` completions never reach this controller; returning to
		// main must therefore reload its current state instead of retaining the
		// pre-focus snapshot. Passing `target` also restores a focused subagent's
		// own todos rather than overwriting them with the main session's list.
		await this.ctx.reloadTodos(target);
		if (generation !== this.#attachGeneration) return false;
		// Rebuild the pending steering/follow-up block the same way. clearTransientSessionUi()
		// disposed pendingMessagesContainer's children, but nothing re-derived them, so returning
		// from a focused agent left the queue intact yet permanently unpainted until an unrelated
		// caller repainted it (#11379). Reads viewSession (target ?? main), so this restores main's
		// queue on unfocus and shows a focused subagent's own queue on focus.
		this.ctx.updatePendingMessagesDisplay();
		// Sync the run-state title to the attached target: a streaming target has no
		// agent_start incoming, so arm the loader/working title manually; an idle
		// target would otherwise inherit the previous session's stuck spinner, so
		// reset it to idle (agent_end teardown already ran via clearTransientSessionUi).
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		else setTerminalTitleState("idle");
		if (generation !== this.#attachGeneration) return false;
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
		return true;
	}
}
