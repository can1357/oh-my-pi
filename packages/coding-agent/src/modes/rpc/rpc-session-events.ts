/**
 * Session-event forwarding for RPC mode: stamps message lifecycle frames with a
 * `messageId` and applies the host's `set_event_filter` selection.
 */
import type { AgentSessionEvent } from "../../session/agent-session";
import type { RpcAgentSessionEventFrame } from "./rpc-types";

/**
 * Writes session events to the RPC output. Message ids are assigned whether or
 * not the frame passes the filter, so changing the filter mid-message never
 * splits one message across two ids.
 */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	readonly #output: (frame: RpcAgentSessionEventFrame) => void;

	constructor(output: (frame: RpcAgentSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(events: readonly string[] | null): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(event: AgentSessionEvent): void {
		const frame = this.#stamp(event);
		if (this.#filter && !this.#filter.has(frame.type)) return;
		this.#output(frame);
	}

	#stamp(event: AgentSessionEvent): RpcAgentSessionEventFrame {
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

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}
