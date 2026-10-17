/**
 * Session-event forwarding for RPC mode: the server stamps message lifecycle
 * frames with a `messageId` once, then each connection applies its own
 * `set_event_filter` selection and projection.
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import type {
	RpcAgentSessionEventFrame,
	RpcDeltaMessageUpdateFrame,
	RpcMessageUpdates,
	RpcProjectedSessionEventFrame,
} from "./rpc-types";

/** Drops the accumulated snapshot a streaming event carries; `done` and `error` have none. */
function withoutPartial(event: AssistantMessageEvent): RpcDeltaMessageUpdateFrame["assistantMessageEvent"] {
	if (!("partial" in event)) return event;
	const { partial: _partial, ...increment } = event;
	return increment;
}

/**
 * Mints message ids once per host, so every connection sees the same id for a
 * message. Ids are assigned whether or not a connection's filter passes the
 * frame, so changing a filter mid-message never splits one message across two ids.
 */
export class RpcMessageIdStamper {
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];

	stamp(event: AgentSessionEvent): RpcAgentSessionEventFrame {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId();
				this.#openMessageIds.push(messageId);
				return { ...event, messageId };
			}
			case "message_update": {
				let messageId = this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId();
					this.#openMessageIds.push(messageId);
				}
				return { ...event, messageId };
			}
			case "message_end":
				return { ...event, messageId: this.#openMessageIds.pop() ?? this.#mintMessageId() };
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				return event;
			default:
				return event;
		}
	}

	/** Id of the innermost open message, for mid-turn snapshots. */
	openMessageId(): string | undefined {
		return this.#openMessageIds.at(-1);
	}

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}

/** One connection's view of the stamped session events: its filter and message-update projection. */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: RpcMessageUpdates = "full";
	readonly #output: (frame: RpcProjectedSessionEventFrame) => void;

	constructor(output: (frame: RpcProjectedSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(events: readonly string[] | null, messageUpdates: RpcMessageUpdates = "full"): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		return this.#filter ? Array.from(this.#filter) : null;
	}

	/** Applies this connection's filter and projection to an already-stamped frame. */
	forward(frame: RpcAgentSessionEventFrame): void {
		if (this.#filter && !this.#filter.has(frame.type)) return;
		if (frame.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...frame,
				message: { role: frame.message.role },
				assistantMessageEvent: withoutPartial(frame.assistantMessageEvent),
			});
			return;
		}
		this.#output(frame);
	}
}
