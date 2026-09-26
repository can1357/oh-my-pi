import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcSessionEventForwarder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-events";
import type { RpcAgentSessionEventFrame, RpcRecapUpdateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type ForwardedFrame = RpcAgentSessionEventFrame | RpcRecapUpdateFrame;

const reply = { role: "assistant", content: [] } as unknown as AgentMessage;
const card = { role: "custom", customType: "advisor-card", content: "note" } as unknown as AgentMessage;

function messageEvent(type: "message_start" | "message_end", message: AgentMessage): AgentSessionEvent {
	return { type, message } as AgentSessionEvent;
}

function update(): AgentSessionEvent {
	return {
		type: "message_update",
		message: reply,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: reply },
	} as unknown as AgentSessionEvent;
}

function idsOf(frames: ForwardedFrame[]): Array<[string, string | undefined]> {
	return frames.map(frame => [frame.type, "messageId" in frame ? frame.messageId : undefined]);
}

describe("RpcSessionEventForwarder", () => {
	test("keeps one messageId per message while an external record nests inside a streaming reply", () => {
		const frames: ForwardedFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));

		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_start", card));
		forwarder.forward(messageEvent("message_end", card));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_end", reply));
		forwarder.forward(messageEvent("message_start", reply));

		expect(idsOf(frames)).toEqual([
			["message_start", "msg-1"],
			["message_update", "msg-1"],
			["message_start", "msg-2"],
			["message_end", "msg-2"],
			["message_update", "msg-1"],
			["message_end", "msg-1"],
			["message_start", "msg-3"],
		]);
	});

	test("filters unlisted event types without shifting message ids, and null restores everything", () => {
		const frames: ForwardedFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));

		expect(forwarder.setFilter(["message_end", "agent_end"])).toEqual(["message_end", "agent_end"]);
		forwarder.forward({ type: "agent_start" });
		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_end", reply));
		forwarder.forward({ type: "agent_end", messages: [reply] });

		expect(forwarder.setFilter(null)).toBeNull();
		forwarder.forward(messageEvent("message_start", reply));

		expect(idsOf(frames)).toEqual([
			["message_end", "msg-1"],
			["agent_end", undefined],
			["message_start", "msg-2"],
		]);
	});

	test("drops recap updates unless the filter lists recap_update", () => {
		const frames: ForwardedFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		const recap: RpcRecapUpdateFrame = {
			type: "recap_update",
			recap: { text: "Done. Next: ship.", trigger: "idle", timestamp: 1 },
		};

		forwarder.setFilter(["agent_end"]);
		forwarder.forwardRecap(recap);
		forwarder.setFilter(["recap_update"]);
		forwarder.forwardRecap({ type: "recap_update", recap: null });

		expect(frames).toEqual([{ type: "recap_update", recap: null }]);
	});
});
