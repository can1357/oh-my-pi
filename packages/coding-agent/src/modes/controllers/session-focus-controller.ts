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

import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type RegistryEvent } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { setTerminalTitleState } from "../../utils/title-generator";
import type { InteractiveModeContext } from "../types";

export class SessionFocusController {
	#focusedAgentId: string | undefined;
	/** Session currently attached while focused; undefined when unfocused. */
	#attachedSession: AgentSession | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#attachGeneration = 0;

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
		const session = await this.lifecycle().ensureLive(id);
		if (id === this.#focusedAgentId && session === this.#attachedSession) return;
		this.#focusedAgentId = id;
		this.#attachedSession = session;
		this.#registryUnsubscribe ??= this.registry.onChange(e => this.#onRegistryEvent(e));
		const attached = await this.#attach(session);
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
		if (!this.#focusedAgentId) return;
		this.#focusedAgentId = undefined;
		this.#attachedSession = undefined;
		const attached = await this.#attach(this.ctx.session);
		if (attached && this.#focusedAgentId === undefined) this.ctx.showStatus("Returned to main session");
	}

	dispose(): void {
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
	}

	#onRegistryEvent(event: RegistryEvent): void {
		if (event.ref.id !== this.#focusedAgentId) return;
		const gone = event.type === "removed";
		const dead = event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted");
		if (!gone && !dead) return;
		void this.unfocus().then(() => {
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
		// Retarget the sticky Todo HUD too. While a subagent is focused the main
		// session's `todo` completions never reach this controller; returning to
		// main must therefore reload its current state instead of retaining the
		// pre-focus snapshot. Passing `target` also restores a focused subagent's
		// own todos rather than overwriting them with the main session's list.
		await this.ctx.reloadTodos(target);
		if (generation !== this.#attachGeneration) return false;
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
