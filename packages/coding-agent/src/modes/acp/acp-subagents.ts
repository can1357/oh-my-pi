import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification, SubagentWorkState } from "@oh-my-pi/pi-utils/acp";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { isSilentAbort } from "../../session/messages";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import {
	type AcpLiveMessageState,
	clearLiveAssistantMessageAfterEvent,
	extractAssistantMessageText,
	getLiveMessageId,
	getLiveMessageProgress,
	mapAgentSessionEventToAcpSessionUpdates,
	mapIncomingAgentMessage,
	prepareLiveAssistantMessage,
} from "./acp-event-mapper";

interface ChildStream extends AcpLiveMessageState {
	/** ACP session id the child's own traffic is addressed to. */
	sessionId: string;
	/** ACP session id of the immediate parent, which carries this child's `subagent_update`s. */
	parentSessionId: string;
	title: string;
	description: string | undefined;
	/** Latest work-state snapshot, re-sent when the parent session is loaded again. */
	state: SubagentWorkState;
	toolArgsById: Map<string, unknown>;
	/** Runs started in this child; numbers each run's delegated prompt. */
	runs: number;
	/**
	 * Runs started but not yet terminal. A wake turn can start before the
	 * previous run emits its terminal frame, so idle is reported only when
	 * the last active run ends.
	 */
	activeRuns: number;
	/** Until the run's first assistant message, an agent-attributed user message is the parent's delegation. */
	awaitingAssignment: boolean;
	/** Whether the current turn streamed an assistant error to the client. */
	turnErrorEmitted: boolean;
	/**
	 * Timestamps of assistant messages whose turn ended before their own
	 * `message_end` was mapped. Their events can still arrive later, even after
	 * further turns or runs; they are dropped, because the end-of-turn fallback
	 * already handled them, until that `message_end` drains the entry.
	 */
	settledMessageTimestamps: Set<number>;
	/** The child session's own cwd (its worktree for isolated runs), read from its registry ref. */
	cwd: string | undefined;
}

const IDLE_STATE_BY_LIFECYCLE: Record<Exclude<SubagentLifecyclePayload["status"], "started">, SubagentWorkState> = {
	completed: { state: "idle", stopReason: "end_turn" },
	failed: { state: "idle", stopReason: "error" },
	aborted: { state: "idle", stopReason: "cancelled" },
};

/**
 * Exposes the subagents of one ACP session as ACP child sessions (unstable
 * RFD "Subagent Sessions"). Each child is announced on its immediate parent's
 * stream with `subagent_update` before any traffic that names it; its
 * messages, thoughts and tool calls then stream under the child's session id,
 * and its current-work state is mirrored on the parent association.
 *
 * Only children whose parent is this session or an already-exposed child are
 * exposed: parentage comes from the agent registry and is never guessed.
 * Notifications are written as soon as the subagent bus delivers each frame;
 * the connection writes in call order, so the announcement precedes the
 * child's traffic and any later parent message that names the child. Until
 * {@link start} is called, notifications are held back: a client may drop
 * traffic for a session id it has not received yet.
 *
 * Individual cancellation is not advertised: cancelling a task job in omp
 * hard-aborts the agent, while the RFD requires a cancelled child to stay
 * available for later work.
 */
export class AcpSubagentStreams {
	readonly #connection: AgentSideConnection;
	readonly #session: AgentSession;
	readonly #children = new Map<string, ChildStream>();
	readonly #blobs = new BlobStore(getBlobsDir());
	readonly #unsubscribers: Array<() => void>;
	/** Held-back notifications until {@link start}; `undefined` once streaming. */
	#pending: SessionNotification[] | undefined = [];

	constructor(connection: AgentSideConnection, session: AgentSession, subagentEventBus: EventBus) {
		this.#connection = connection;
		this.#session = session;
		this.#unsubscribers = [
			subagentEventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.#handleLifecycle(data as SubagentLifecyclePayload);
			}),
			subagentEventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.#handleEvent(data as SubagentEventPayload);
			}),
		];
	}

	/** ACP session id of an omp agent in this session's tree, or `undefined` when it is not exposed. */
	resolveAgentSessionId(agentId: string): string | undefined {
		// Held-back announcements have not reached the client, so direct root traffic may not name a child yet.
		if (this.#pending && agentId !== this.#session.getAgentId()) return undefined;
		return this.#routing.resolveAgentSessionId(agentId);
	}

	/**
	 * Participant ids for notifications sent through {@link #deliver}. Those
	 * share one ordered stream with the announcements, held back together, so
	 * a known child may always be named.
	 */
	readonly #routing = {
		resolveAgentSessionId: (agentId: string): string | undefined =>
			agentId === this.#session.getAgentId() ? this.#session.sessionId : this.#children.get(agentId)?.sessionId,
	};

	/**
	 * Report an agent message that reached the root outside an ACP prompt turn
	 * (e.g. a detached child writing to the root), in order with child traffic.
	 */
	reportRootIncoming(message: { customType?: unknown; details?: unknown }): void {
		for (const notification of mapIncomingAgentMessage(message, this.#session.sessionId, this.#routing)) {
			this.#deliver(notification);
		}
	}

	/** Release `unsubscribe` with this stream. */
	track(unsubscribe: () => void): void {
		this.#unsubscribers.push(unsubscribe);
	}

	/**
	 * Begin streaming once the client knows the root session id, sending any
	 * notifications held back until then in their original order.
	 */
	start(): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		for (const notification of pending) this.#deliver(notification);
	}

	/**
	 * Re-establish every known child, parents before their children, while the
	 * parent session is loaded or resumed again: the client need not have kept
	 * the earlier tree. Routing only; current state follows the response via
	 * {@link reportStates}.
	 */
	announceAll(): void {
		for (const child of this.#children.values()) {
			this.#sendUpdate(child, {
				title: child.title,
				...(child.description ? { description: child.description } : {}),
			});
		}
	}

	/** Send each known child's current work state; called after a load/resume response. */
	reportStates(): void {
		for (const child of this.#children.values()) this.#sendUpdate(child, { state: child.state });
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers.length = 0;
		this.#children.clear();
	}

	#handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#children.get(payload.id);
		if (existing) {
			// IRC wake turns, follow-up assignments and revivals restart work in the same child conversation.
			if (payload.status === "started") {
				existing.runs++;
				existing.activeRuns++;
				existing.awaitingAssignment = true;
				// A late `message_end` from the previous run may never have arrived; a new
				// run must not append its text to that run's message.
				existing.liveMessageId = undefined;
				existing.liveMessageProgress = undefined;
				existing.state = { state: "running" };
			} else {
				existing.activeRuns = Math.max(0, existing.activeRuns - 1);
				// An older run ending while a newer one is active leaves the child running.
				if (existing.activeRuns > 0) return;
				existing.state = IDLE_STATE_BY_LIFECYCLE[payload.status];
			}
			this.#sendUpdate(existing, { state: existing.state });
			return;
		}
		if (payload.status !== "started") return;
		const parentAgentId = AgentRegistry.global().get(payload.id)?.parentId;
		const parentSessionId =
			parentAgentId === this.#session.getAgentId()
				? this.#session.sessionId
				: parentAgentId === undefined
					? undefined
					: this.#children.get(parentAgentId)?.sessionId;
		if (parentSessionId === undefined) return;
		const child: ChildStream = {
			// omp agent ids are unique within one root session's tree, so prefixing the
			// root id keeps child ids unique across the sessions sharing this connection.
			sessionId: `${this.#session.sessionId}/${payload.id}`,
			parentSessionId,
			title: payload.id,
			description: payload.description,
			state: { state: "running" },
			toolArgsById: new Map(),
			runs: 1,
			activeRuns: 1,
			awaitingAssignment: true,
			turnErrorEmitted: false,
			settledMessageTimestamps: new Set(),
			cwd: undefined,
			liveMessageId: undefined,
			liveMessageProgress: undefined,
		};
		this.#children.set(payload.id, child);
		this.#sendUpdate(child, {
			title: child.title,
			...(child.description ? { description: child.description } : {}),
			state: child.state,
		});
	}

	#handleEvent(payload: SubagentEventPayload): void {
		const child = this.#children.get(payload.id);
		if (!child) return;
		// The session is attached to the ref once constructed, before it emits events.
		child.cwd ??= AgentRegistry.global().get(payload.id)?.session?.sessionManager.getCwd();
		for (const notification of this.#mapChildEvent(child, payload.event)) this.#deliver(notification);
	}

	#mapChildEvent(child: ChildStream, event: AgentSessionEvent): SessionNotification[] {
		if (event.type === "message_start" && event.message.role === "assistant") child.awaitingAssignment = false;
		if (event.type === "message_end" && event.message.role === "user") {
			// A run opens with the work its parent delegated (the initial task or a
			// workpool/vibe follow-up); later agent-attributed user messages are
			// harness notices, and parent messages arrive as IRC traffic instead.
			if (!child.awaitingAssignment || event.message.attribution !== "agent") return [];
			child.awaitingAssignment = false;
			const content = event.message.content;
			return [
				{
					sessionId: child.sessionId,
					update: {
						sessionUpdate: "session_message",
						messageId: `assignment:${child.sessionId}:${child.runs}`,
						senderSessionId: child.parentSessionId,
						recipientSessionId: child.sessionId,
						content: typeof content === "string" ? [{ type: "text", text: content }] : content,
					},
				},
			];
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			child.toolArgsById.set(event.toolCallId, event.args);
		}
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			child.settledMessageTimestamps.has(event.message.timestamp)
		) {
			if (event.type === "message_end") child.settledMessageTimestamps.delete(event.message.timestamp);
			return [];
		}
		if (event.type === "agent_start") child.turnErrorEmitted = false;
		const fallback = event.type === "agent_end" ? this.#endOfTurnFallback(child, event) : [];
		prepareLiveAssistantMessage(child, event);
		const notifications = mapAgentSessionEventToAcpSessionUpdates(event, child.sessionId, {
			getMessageId: message => getLiveMessageId(child, message),
			getMessageProgress: message => getLiveMessageProgress(child, message),
			getToolArgs: toolCallId => child.toolArgsById.get(toolCallId),
			resolveImageData: data => resolveImageDataSync(this.#blobs, data),
			// Never fall back to the root cwd: an isolated child's relative paths would
			// then name files in the parent workspace instead of its worktree.
			cwd: child.cwd,
			sessionMessages: this.#routing,
		});
		if (event.type === "tool_execution_end") child.toolArgsById.delete(event.toolCallId);
		clearLiveAssistantMessageAfterEvent(child, event);
		if (event.type === "agent_end") {
			// The next turn (a reminder or follow-up) starts a new message; this
			// turn's late events are recognized through `settledMessageTimestamps`.
			child.liveMessageId = undefined;
			child.liveMessageProgress = undefined;
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "error" && notifications.length > 0) {
			child.turnErrorEmitted = true;
		}
		return [...notifications, ...fallback];
	}

	/**
	 * Text the client never received for a finished turn, mirroring the root
	 * session's prompt-turn fallbacks: `agent_end` can overtake the final
	 * assistant `message_end`, leaving its answer unsent, and a request that
	 * fails before streaming emits only `agent_end` with the error.
	 */
	#endOfTurnFallback(
		child: ChildStream,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): SessionNotification[] {
		const lastAssistant = event.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!lastAssistant) return [];
		// The in-flight message's `message_end` has not been mapped: expect it late.
		if (child.liveMessageProgress) child.settledMessageTimestamps.add(lastAssistant.timestamp);
		const texts: string[] = [];
		// A live message whose `message_end` has not been mapped yet still holds its progress.
		const progress = child.liveMessageProgress;
		const answer = extractAssistantMessageText(lastAssistant);
		if (progress && !progress.textEmitted && answer) {
			progress.textEmitted = true;
			texts.push(answer);
		}
		if (
			lastAssistant.stopReason === "error" &&
			lastAssistant.errorMessage &&
			!isSilentAbort(lastAssistant) &&
			!child.turnErrorEmitted
		) {
			child.turnErrorEmitted = true;
			texts.push(lastAssistant.errorMessage);
		}
		const messageId = child.liveMessageId ?? crypto.randomUUID();
		return texts.map(text => ({
			sessionId: child.sessionId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId },
		}));
	}

	#sendUpdate(child: ChildStream, patch: { title?: string; description?: string; state?: SubagentWorkState }): void {
		this.#deliver({
			sessionId: child.parentSessionId,
			update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, ...patch },
		});
	}

	#deliver(notification: SessionNotification): void {
		if (this.#pending) {
			this.#pending.push(notification);
			return;
		}
		this.#connection.sessionUpdate(notification).catch(error => {
			logger.warn("Failed to deliver ACP subagent update", { error: String(error) });
		});
	}
}
