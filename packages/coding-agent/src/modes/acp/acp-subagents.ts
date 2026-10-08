import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification, SubagentWorkState } from "@oh-my-pi/pi-utils/acp";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
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
	getLiveMessageId,
	getLiveMessageProgress,
	mapAgentSessionEventToAcpSessionUpdates,
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
	assignmentReported: boolean;
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
 * child's traffic and any later parent message that names the child.
 *
 * Individual cancellation is not advertised: cancelling a task job in omp
 * hard-aborts the agent, while the RFD requires a cancelled child to stay
 * available for later work.
 */
export class AcpSubagentStreams {
	readonly #connection: AgentSideConnection;
	readonly #session: AgentSession;
	readonly #children = new Map<string, ChildStream>();
	readonly #unsubscribers: Array<() => void>;

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
		if (agentId === this.#session.getAgentId()) return this.#session.sessionId;
		return this.#children.get(agentId)?.sessionId;
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
			// IRC wake turns and revivals restart work in the same child conversation.
			existing.state = payload.status === "started" ? { state: "running" } : IDLE_STATE_BY_LIFECYCLE[payload.status];
			this.#sendUpdate(existing, { state: existing.state });
			return;
		}
		if (payload.status !== "started") return;
		const parentAgentId = AgentRegistry.global().get(payload.id)?.parentId;
		const parentSessionId = parentAgentId === undefined ? undefined : this.resolveAgentSessionId(parentAgentId);
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
			assignmentReported: false,
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
		for (const notification of this.#mapChildEvent(child, payload.event)) this.#deliver(notification);
	}

	#mapChildEvent(child: ChildStream, event: AgentSessionEvent): SessionNotification[] {
		if (event.type === "message_end" && event.message.role === "user") {
			// The child's first user message is the assignment its parent delegated;
			// later parent messages arrive as IRC traffic (`irc_message`) instead.
			if (child.assignmentReported || event.message.attribution !== "agent") return [];
			child.assignmentReported = true;
			const content = event.message.content;
			return [
				{
					sessionId: child.sessionId,
					update: {
						sessionUpdate: "session_message",
						messageId: `assignment:${child.sessionId}`,
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
		prepareLiveAssistantMessage(child, event);
		const notifications = mapAgentSessionEventToAcpSessionUpdates(event, child.sessionId, {
			getMessageId: message => getLiveMessageId(child, message),
			getMessageProgress: message => getLiveMessageProgress(child, message),
			getToolArgs: toolCallId => child.toolArgsById.get(toolCallId),
			cwd: this.#session.sessionManager.getCwd(),
			sessionMessages: this,
		});
		if (event.type === "tool_execution_end") child.toolArgsById.delete(event.toolCallId);
		clearLiveAssistantMessageAfterEvent(child, event);
		return notifications;
	}

	#sendUpdate(child: ChildStream, patch: { title?: string; description?: string; state?: SubagentWorkState }): void {
		this.#deliver({
			sessionId: child.parentSessionId,
			update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, ...patch },
		});
	}

	#deliver(notification: SessionNotification): void {
		this.#connection.sessionUpdate(notification).catch(error => {
			logger.warn("Failed to deliver ACP subagent update", { error: String(error) });
		});
	}
}
