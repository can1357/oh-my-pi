/**
 * Model-loop ends as the RPC, JSON print and collab wires carry them.
 *
 * The session reports `agent_pause` for a loop that stops inside a run and a
 * single `agent_end` when the run ends. The wires (and the extension
 * `agent_end`) predate that split and keep their contract: every stopped loop
 * is an `agent_end`, flagged `isTerminal: false` while the run goes on.
 * {@link toWireEvent} encodes at each boundary; {@link fromWireEvent} turns a
 * collab host's stream back into session events on the guest.
 */
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "./agent-session-events";

type AgentEndEvent = Extract<AgentEvent, { type: "agent_end" }>;

/** A stopped model loop as the wires carry it; see the module docs. */
export type WireAgentEnd = AgentEndEvent & {
	/** False while the run goes on: a continuation, queued input or outside work resumes it. */
	isTerminal: boolean;
	/** The model finished its turn; false while the session continues its own work (retry, reminders). */
	yielded: boolean;
	/** Only outside work (a background job, child agent or peer message) can resume the run. */
	awaitingAsyncWork?: true;
};

/** A session event as the wires carry it. */
export type WireSessionEvent = Exclude<AgentSessionEvent, { type: "agent_pause" | "agent_end" }> | WireAgentEnd;

/** Encode a session event for a wire: loop pauses and the run's end both become flagged `agent_end`s. */
export function toWireEvent(event: AgentSessionEvent): WireSessionEvent {
	if (event.type === "agent_pause") {
		return {
			type: "agent_end",
			messages: event.messages,
			isTerminal: false,
			yielded: event.yielded,
			...(event.awaiting ? { awaitingAsyncWork: true } : {}),
		};
	}
	if (event.type === "agent_end") return { ...event, isTerminal: true, yielded: true };
	return event;
}

/**
 * Decode a wire event into a session event: an `agent_end` with `isTerminal: false`
 * is a pause; any other `agent_end` (hosts that omit the flags included) ends the run.
 */
export function fromWireEvent(event: WireSessionEvent | AgentSessionEvent): AgentSessionEvent {
	if (event.type !== "agent_end" || !("isTerminal" in event)) return event;
	const { isTerminal, yielded, awaitingAsyncWork, ...end } = event;
	if (isTerminal !== false) return end;
	return { type: "agent_pause", messages: end.messages, yielded, awaiting: awaitingAsyncWork === true };
}
