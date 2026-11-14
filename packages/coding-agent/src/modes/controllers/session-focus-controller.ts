import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../../registry/agent-lifecycle";
import {
	AgentRegistry,
	type AgentRegistryApi,
	MAIN_AGENT_ID,
	type AgentRef,
	type RegistryEvent,
} from "../../registry/agent-registry";
import { type AgentViewSession, isAgentViewSession } from "../../session/agent-session-handle";
import type { AgentSessionEvent } from "../../session/agent-session";
import { sameMessageContent, sessionMessagePersistenceKey } from "../../session/turn-persistence";
import { setRunStatus } from "../../utils/run-status";
import type { InteractiveModeContext } from "../types";

/** Whether a rebuild's own reads of the session already show `event`, the `arrival`-th it emitted. */
type ShownByRebuild = (event: AgentSessionEvent, arrival: number) => boolean;

/**
 * A message's identity candidate in both the rebuilt transcript and live events. An extension
 * message (`custom` or `hookMessage`) is persisted as a custom entry under its own timestamp and
 * rebuilt as a new `custom` object, so it is keyed by type and timestamp; the rest by persistence
 * key, else the object. The key can collide for distinct messages minted in the same millisecond,
 * so {@link replayedIncludes} confirms a hit by content, mirroring the persistence path.
 */
function transcriptKey(message: AgentMessage): unknown {
	if (message.role === "custom" || message.role === "hookMessage")
		return `custom:${message.customType}:${message.timestamp}`;
	return sessionMessagePersistenceKey(message) ?? message;
}

/** Whether the rebuilt transcript (grouped by {@link transcriptKey}) already shows this exact message. */
function replayedIncludes(replayed: ReadonlyMap<unknown, readonly AgentMessage[]>, message: AgentMessage): boolean {
	return replayed.get(transcriptKey(message))?.some(candidate => sameMessageContent(candidate, message)) ?? false;
}

/**
 * Pick the most recently active focusable subagent. Advisors are read-only
 * transcripts and killed agents wait for an explicit revive, so neither is
 * cycled to; the main session is the view itself, not a focus target. A focused caller passes
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
	#attachedSession: AgentViewSession | undefined;
	#focusAttachment: Promise<void> | undefined;
	#registryUnsubscribe: (() => void) | undefined;
	#attachGeneration = 0;
	/** Monotonic focus-request id: a request that resolves after a newer one drops instead of clobbering the view. */
	#focusRequestSeq = 0;

	constructor(
		private ctx: InteractiveModeContext,
		private registry: AgentRegistryApi = AgentRegistry.global(),
		private lifecycle: () => AgentLifecycleApi = () => AgentLifecycleManager.global(),
	) {}

	get focusedAgentId(): string | undefined {
		return this.#focusedAgentId;
	}

	/** Focused live session, undefined when unfocused. */
	get target(): AgentViewSession | undefined {
		return this.#attachedSession;
	}
	/** Focus the main view on an agent's live session. Throws an Error with a user-displayable message. */
	async focusAgent(id: string): Promise<void> {
		if (this.ctx.collabGuest) throw new Error("Viewing agents is unavailable in a collab session.");
		if (id === MAIN_AGENT_ID) return this.unfocus();
		const request = ++this.#focusRequestSeq;
		let session: AgentViewSession;
		try {
			const live = await this.lifecycle().ensureLive(id);
			// Main-thread handles are local sessions or mirrors of worker-homed ones, both viewable; only a
			// worker's peer handle (a session homed on another thread, seen from a worker) is not.
			if (!isAgentViewSession(live)) {
				throw new Error(`Agent ${id} is homed on another thread and can only be viewed from the main thread.`);
			}
			session = live;
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
		try {
			await attachment;
		} catch (error) {
			if (request !== this.#focusRequestSeq) return;
			throw error;
		} finally {
			if (this.#focusAttachment === attachment) this.#focusAttachment = undefined;
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
		await this.#attach(this.ctx.session);
	}

	dispose(): void {
		this.ctx.syncIdleMaintenanceView(null);
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
	#runSerialized(generation: number, run: () => Promise<void>): Promise<void> {
		return this.ctx.eventController.runSerialized(async () => {
			if (generation !== this.#attachGeneration) return;
			await run();
		});
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
	async #attach(target: AgentViewSession): Promise<void> {
		const generation = ++this.#attachGeneration;
		this.ctx.syncIdleMaintenanceView(target);
		try {
			this.ctx.unsubscribe?.();
			this.ctx.clearTransientSessionUi({ viewOnly: true });
			this.ctx.eventController.resetTranscriptAnchors();
			let assistantStreamSynced = false;
			const restoreAssistant = async (message: AssistantMessage): Promise<void> => {
				if (generation !== this.#attachGeneration) return;
				if (!assistantStreamSynced) {
					assistantStreamSynced = true;
					await this.ctx.eventController.handleEvent({ type: "message_start", message });
					if (generation !== this.#attachGeneration) return;
				}
				await this.ctx.eventController.syncAssistantMessage(message);
				if (generation === this.#attachGeneration) this.ctx.eventController.restorePendingToolResults();
			};
			// Events are numbered as they arrive and queued behind the rebuild, which is queued in
			// this same tick: no handler runs in the middle of it, and it drops each event its own
			// reads of `target` already show, so nothing is drawn twice or into a replaced chat.
			let arrivals = 0;
			let shown: ShownByRebuild | undefined;
			this.ctx.unsubscribe = target.subscribe(event => {
				const arrival = ++arrivals;
				const streamMessage = target.agent.state.streamMessage;
				return this.#runSerialized(generation, async () => {
					if (shown?.(event, arrival)) return;
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
							// A replay `start` opens the message itself via the restart path.
							if (event.assistantMessageEvent?.type !== "start") {
								await this.ctx.eventController.handleEvent({ type: "message_start", message: event.message });
							}
						}
						if (generation !== this.#attachGeneration) return;
					} else if (
						event.type === "tool_execution_start" &&
						!assistantStreamSynced &&
						streamMessage?.role === "assistant"
					) {
						await restoreAssistant(streamMessage);
						if (generation !== this.#attachGeneration) return;
					}
					if (event.type === "message_end" && event.message.role === "assistant") assistantStreamSynced = false;
					await this.ctx.eventController.handleEvent(event);
				});
			});
			let restored: Promise<void> | undefined;
			await this.#runSerialized(generation, async () => {
				const rebuilt = await this.#rebuild(target, generation, () => arrivals, restoreAssistant);
				shown = rebuilt?.shown;
				restored = rebuilt?.restored;
			});
			await restored;
			if (generation !== this.#attachGeneration) return;
			await this.ctx.reloadTodos(target);
			if (generation !== this.#attachGeneration) return;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.updateEditorBorderColor();
			this.ctx.ui.requestRender();
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

	/**
	 * Rebuild the view of `target` from its own state (run status, transcript, buffered tool
	 * results) as one run of the serialized dispatch chain, and queue the restore of its live reply
	 * and running tools (`restored`) behind the events that arrived by then, so an older reply
	 * ending in between is drawn first. `shown` says which events, numbered by `arrivals` as they
	 * came in, those reads already show. Undefined when a newer attachment took over.
	 */
	async #rebuild(
		target: AgentViewSession,
		generation: number,
		arrivals: () => number,
		restoreAssistant: (message: AssistantMessage) => Promise<void>,
	): Promise<{ shown: ShownByRebuild; restored: Promise<void> } | undefined> {
		// A tool result emitted while nothing listened must be in the transcript rebuilt below.
		await target.settleInFlightMessagePersistence();
		if (generation !== this.#attachGeneration) return undefined;
		this.ctx.statusLine.setSession(target, this.#focusedAgentId);
		// Reset run bookkeeping before replay populates pending tool handles.
		const statusRead = arrivals();
		if (target.isStreaming) await this.ctx.eventController.handleEvent({ type: "agent_start" });
		else {
			setRunStatus({ state: "idle" });
			this.ctx.eventController.markViewIdle();
		}
		if (generation !== this.#attachGeneration) return undefined;
		const replayed = new Map<unknown, AgentMessage[]>();
		const resultTools = new Set<string>();
		await this.ctx.renderInitialMessages({
			clearTerminalHistory: true,
			onCommit: context => {
				for (const message of context.messages) {
					const key = transcriptKey(message);
					const colliding = replayed.get(key);
					if (colliding) colliding.push(message);
					else replayed.set(key, [message]);
					if (message.role === "toolResult") resultTools.add(message.toolCallId);
				}
			},
		});
		if (generation !== this.#attachGeneration) return undefined;
		this.ctx.eventController.restorePendingToolResults();

		// Read and queued in one tick: every event up to `liveRead` runs before the restore, every
		// later one after it.
		const liveRead = arrivals();
		const live = target.agent.state.streamMessage;
		const running = target.activeToolExecutionUpdates();
		const restored = this.#runSerialized(generation, async () => {
			if (live?.role === "assistant") await restoreAssistant(live);
			for (const event of running) {
				if (generation !== this.#attachGeneration) return;
				await this.ctx.eventController.handleEvent(event);
			}
		});
		const shown: ShownByRebuild = (event, arrival) => {
			switch (event.type) {
				case "agent_start":
					// The status read started this run, or found it already over.
					return arrival <= statusRead;
				case "tool_execution_start":
					// The replay drew this call with its result. Its updates and end still count (a
					// detached task's persisted result says "running" and its job keeps reporting), as
					// does a later retry of the same call id.
					return arrival <= liveRead && resultTools.has(event.toolCallId);
				case "tool_execution_update":
					// `running` holds each running tool's newest update.
					return arrival <= liveRead;
				case "message_start":
				case "message_update":
				case "message_end":
					// The replay drew this message as persisted. A reply still streaming at `liveRead`
					// is `live`, drawn by the restore; one that ended by then is drawn by its own end.
					return (
						replayedIncludes(replayed, event.message) ||
						(event.message.role === "assistant" && event.type !== "message_end" && arrival <= liveRead)
					);
				default:
					return false;
			}
		};
		return { shown, restored };
	}
}
