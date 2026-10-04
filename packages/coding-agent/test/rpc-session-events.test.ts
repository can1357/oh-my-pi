import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { MAX_RPC_FRAME_BYTES, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { RpcSessionEventForwarder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-events";
import type { RpcProjectedSessionEventFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { makeAssistantMessage } from "./session-manager/helpers";

const reply = { role: "assistant", content: [] } as unknown as AgentMessage;
const card = { role: "custom", customType: "advisor-card", content: "note" } as unknown as AgentMessage;

function messageEvent(
	type: "message_start" | "message_end",
	message: AgentMessage,
): Extract<AgentSessionEvent, { type: "message_start" | "message_end" }> {
	return { type, message };
}

function update(): AgentSessionEvent {
	return {
		type: "message_update",
		message: reply,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: reply },
	} as unknown as AgentSessionEvent;
}

function idsOf(frames: RpcProjectedSessionEventFrame[]): Array<[string, string | undefined]> {
	return frames.map(frame => [frame.type, "messageId" in frame ? frame.messageId : undefined]);
}

describe("RpcSessionEventForwarder", () => {
	test("delta updates preserve each streaming subtype without mutating shared events", () => {
		const message = makeAssistantMessage();
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file" } };
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
			{ type: "thinking_start", contentIndex: 1, partial: message },
			{ type: "thinking_delta", contentIndex: 1, delta: "consider", partial: message },
			{ type: "thinking_end", contentIndex: 1, content: "consider", partial: message },
			{
				type: "image_end",
				contentIndex: 2,
				content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				partial: message,
			},
			{ type: "toolcall_start", contentIndex: 3, partial: message },
			{ type: "toolcall_delta", contentIndex: 3, delta: '{"path":"file"}', partial: message },
			{ type: "toolcall_end", contentIndex: 3, toolCall, partial: message },
			{ type: "done", reason: "stop", message },
			{ type: "error", reason: "error", error: message },
		];
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		for (const assistantMessageEvent of events) {
			const event = { type: "message_update" as const, message, assistantMessageEvent, extra: "preserved" };
			const before = JSON.stringify(event);
			Object.freeze(assistantMessageEvent);
			Object.freeze(event);
			forwarder.forward(event);
			const { partial: _partial, ...expected } = assistantMessageEvent as AssistantMessageEvent & {
				partial?: unknown;
			};
			expect(frames.at(-1)).toEqual({
				...event,
				message: { role: "assistant" },
				assistantMessageEvent: expected,
				messageId: "msg-1",
			});
			expect(JSON.stringify(event)).toBe(before);
		}
	});

	test("switching projection mid-message keeps identity and omission restores byte-identical full updates", () => {
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		const event = update();
		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(event);
		forwarder.setFilter(["message_update", "message_end"], "delta");
		forwarder.forward(event);
		forwarder.setFilter(null);
		forwarder.forward(event);
		forwarder.setFilter(null, "full");
		forwarder.forward(event);
		forwarder.setFilter(null, "delta");
		forwarder.forward(messageEvent("message_end", reply));
		expect(idsOf(frames)).toEqual([
			["message_start", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_end", "msg-1"],
		]);
		for (const index of [1, 3, 4])
			expect(JSON.stringify(frames[index])).toBe(JSON.stringify({ ...event, messageId: "msg-1" }));
		expect(frames[2]).toEqual({
			type: "message_update",
			messageId: "msg-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		expect(frames[5]).toEqual({ ...messageEvent("message_end", reply), messageId: "msg-1" });
	});

	test("delta projection avoids v2 chunking caused by accumulated snapshots, not by the text delta", () => {
		const message = makeAssistantMessage();
		message.content = [{ type: "text", text: "x".repeat(3 * 512000) }];
		const event: AgentSessionEvent = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(512000), partial: message },
		};
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const lines: string[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => lines.push(...encoder.encodeFrames(frame)));
		forwarder.setFilter(null, "delta");
		forwarder.forward(event);
		expect(lines).toHaveLength(1);
		expect(Buffer.byteLength(lines[0])).toBeLessThan(MAX_RPC_FRAME_BYTES);
		expect(JSON.parse(lines[0]).assistantMessageEvent.delta).toBe("x".repeat(512000));
		expect(JSON.parse(lines[0]).type).toBe("message_update");
		lines.length = 0;
		forwarder.setFilter(null, "full");
		forwarder.forward(event);
		expect(JSON.parse(lines[0]).type).toBe("rpc_chunk");
	});
	test("keeps one messageId per message while an external record nests inside a streaming reply", () => {
		const frames: RpcProjectedSessionEventFrame[] = [];
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
		const frames: RpcProjectedSessionEventFrame[] = [];
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
});
