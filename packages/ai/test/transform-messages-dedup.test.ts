// Duplicate Responses-family tool-call ids are composites (`callId|itemId`).
// The dedup suffix must reach the wire call_id — the FIRST segment, which
// normalizeResponsesToolCallId extracts at encode time — otherwise the request
// carries two function_call/function_call_output pairs sharing one call_id.
// Regression for the suffix previously landing on the composite as a whole
// (`call_x|fc_y` → `call_x|fc_y_dup1`, wire call_id `call_x` for both copies).
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function assistantWithCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("deduplicateToolCallIds with composite Responses ids", () => {
	it("suffixes the call_id segment so wire ids stay distinct", () => {
		const dupId = "call_x|fc_y";
		const messages: Message[] = [
			assistantWithCall(dupId),
			toolResult(dupId, "first"),
			assistantWithCall(dupId),
			toolResult(dupId, "second"),
		];

		const transformed = transformMessages(messages, makeModel());

		const callIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter(b => b.type === "toolCall")
			.map(b => normalizeResponsesToolCallId((b as { id: string }).id).callId);
		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);

		// Each rewritten toolResult resolves to the same wire call_id as its call.
		const resultIds = transformed
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map(m => normalizeResponsesToolCallId(m.toolCallId).callId);
		expect(resultIds).toEqual(callIds);
	});
});
