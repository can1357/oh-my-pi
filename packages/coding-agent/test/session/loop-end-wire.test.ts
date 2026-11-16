/**
 * The RPC, JSON print and collab wires keep one flagged `agent_end` per stopped
 * model loop while the session reports `agent_pause` / a single `agent_end`.
 * External clients parse these exact fields.
 */
import { describe, expect, it } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { fromWireEvent, toWireEvent } from "@oh-my-pi/pi-coding-agent/session/loop-end-wire";

describe("loop-end wire codec", () => {
	it("encodes a pause as a non-terminal agent_end and the run's end as a terminal one", () => {
		expect(toWireEvent({ type: "agent_pause", messages: [], yielded: true, awaiting: true })).toEqual({
			type: "agent_end",
			messages: [],
			isTerminal: false,
			yielded: true,
			awaitingAsyncWork: true,
		});
		expect(toWireEvent({ type: "agent_pause", messages: [], yielded: false, awaiting: false })).toEqual({
			type: "agent_end",
			messages: [],
			isTerminal: false,
			yielded: false,
		});
		expect(toWireEvent({ type: "agent_end", messages: [] })).toEqual({
			type: "agent_end",
			messages: [],
			isTerminal: true,
			yielded: true,
		});
	});

	it("decodes a host's stream back into pauses and run ends, flag-less ends included", () => {
		const pause: AgentSessionEvent = { type: "agent_pause", messages: [], yielded: true, awaiting: true };
		expect(fromWireEvent(toWireEvent(pause))).toEqual(pause);
		expect(fromWireEvent(toWireEvent({ type: "agent_end", messages: [] }))).toEqual({
			type: "agent_end",
			messages: [],
		});
		expect(fromWireEvent({ type: "agent_end", messages: [] })).toEqual({ type: "agent_end", messages: [] });
	});
});
