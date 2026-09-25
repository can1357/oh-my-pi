import { expect, it } from "bun:test";
import { encodeStream } from "../src/providers/gemini-v1beta-server";
import type { AssistantMessage, ToolCall } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

it("emits one complete Gemini functionCall for an incrementally streamed invocation", async () => {
	const call: ToolCall = { type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "complete" } };
	const message: AssistantMessage = {
		role: "assistant",
		api: "google-generative-ai",
		provider: "google",
		model: "fixture",
		content: [call],
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const events = new AssistantMessageEventStream();
	events.push({ type: "toolcall_start", contentIndex: 0, partial: message });
	events.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"q":"complete"}', partial: message });
	events.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
	events.push({ type: "done", reason: "toolUse", message });
	const text = await new Response(encodeStream(events, "fixture")).text();
	const calls: unknown[] = [];
	for (const frame of text.split("\n\n").filter(Boolean)) {
		const data = JSON.parse(frame.replace(/^data: /, "")) as {
			candidates?: Array<{ content?: { parts?: Array<{ functionCall?: unknown }> } }>;
		};
		for (const candidate of data.candidates ?? [])
			for (const part of candidate.content?.parts ?? []) if (part.functionCall) calls.push(part.functionCall);
	}
	expect(calls).toEqual([{ name: "lookup", args: { q: "complete" }, id: "call_1" }]);
});
