import { describe, expect, it } from "bun:test";
import { wrapInbandToolStream } from "../src/dialect/owned-stream";
import type { AssistantMessage, ToolCall, Usage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const TOOLS = [
	{
		name: "echo",
		description: "Echo a message.",
		parameters: {
			type: "object",
			properties: { msg: { type: "string" } },
			required: ["msg"],
		},
	},
];

const TOOL_CALL_TEXT = "<tool_call>echo\n<arg_key>msg</arg_key>\n<arg_value>hi</arg_value>\n</tool_call>\n";
const FABRICATION_TEXT = "<tool_response>\nFAKE RESULT\n</tool_response>";

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

// An assistant turn that issues one real tool call, then hallucinates its own
// tool result (the fabrication boundary).
function makeInner(): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	const seed = makeAssistant([]);
	inner.push({ type: "start", partial: seed });
	inner.push({ type: "text_delta", contentIndex: 0, delta: TOOL_CALL_TEXT, partial: seed });
	inner.push({ type: "text_delta", contentIndex: 0, delta: FABRICATION_TEXT, partial: seed });
	const full = makeAssistant([{ type: "text", text: TOOL_CALL_TEXT + FABRICATION_TEXT }]);
	inner.push({ type: "done", reason: "stop", message: full });
	inner.end(full);
	return inner;
}

describe("wrapInbandToolStream fabrication handling", () => {
	it("aborts the provider on fabrication when abortOnFabrication is true (default)", async () => {
		let aborted = false;
		const wrapped = wrapInbandToolStream(makeInner(), TOOLS, "glm", () => {
			aborted = true;
		});
		const message = await wrapped.result();

		expect(aborted).toBe(true);
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("echo");
		expect(calls[0]!.arguments).toEqual({ msg: "hi" });
		// The fabricated continuation is dropped, not surfaced as text.
		const text = message.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).not.toContain("FAKE RESULT");
	});

	it("keeps the provider running and discards the continuation when abortOnFabrication is false", async () => {
		let aborted = false;
		const wrapped = wrapInbandToolStream(
			makeInner(),
			TOOLS,
			"glm",
			() => {
				aborted = true;
			},
			false,
		);
		const message = await wrapped.result();

		// No premature abort — the request is allowed to finish.
		expect(aborted).toBe(false);
		// Same canonical outcome: the real call is kept, the fabrication discarded.
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("echo");
		expect(calls[0]!.arguments).toEqual({ msg: "hi" });
		const text = message.content.map(b => (b.type === "text" ? b.text : "")).join("");
		expect(text).not.toContain("FAKE RESULT");
	});
});
