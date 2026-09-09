/**
 * Contract: `--mode json` output stays linear in conversation size. Streaming
 * `message_update` events must not re-serialize the in-progress message, and
 * printed messages must not carry provider-opaque replay payloads (encrypted
 * reasoning history), which previously produced multi-GB transcripts.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { printableEvent } from "../../src/modes/print-mode";
import type { AgentSessionEvent } from "../../src/session/agent-session";

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-test",
	usage: {} as AssistantMessage["usage"],
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", provider: "openai", dt: true, items: [{ big: "blob" }] },
};

describe("printableEvent", () => {
	it("emits only the incremental delta for message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
	});

	it("drops the done-variant message snapshot from message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "done", reason: "stop", message: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
	});

	it("strips providerPayload from message_end but keeps the message content", () => {
		const event: AgentSessionEvent = { type: "message_end", message: assistant };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			message: Record<string, unknown>;
		};
		expect(printed.message.providerPayload).toBeUndefined();
		expect(printed.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(printed.message.model).toBe("gpt-test");
	});

	it("strips providerPayload from every message in agent_end", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [assistant, assistant] };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(printed.messages).toHaveLength(2);
		for (const message of printed.messages) expect(message.providerPayload).toBeUndefined();
	});

	it("passes unrelated events through untouched", () => {
		const event: AgentSessionEvent = { type: "notice", level: "info", message: "hi" };
		expect(printableEvent(event)).toBe(event);
	});
});
