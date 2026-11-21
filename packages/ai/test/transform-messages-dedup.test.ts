// Duplicate Responses-family tool-call ids are composites (`callId|itemId`).
// The dedup suffix must reach the wire call_id — the FIRST segment, which
// normalizeResponsesToolCallId extracts at encode time — otherwise the request
// carries two function_call/function_call_output pairs sharing one call_id.
// Regression for the suffix previously landing on the composite as a whole
// (`call_x|fc_y` → `call_x|fc_y_dup1`, wire call_id `call_x` for both copies).
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
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

function assistantWithCalls(ids: string[]): AssistantMessage {
	return {
		...assistantWithCall(ids[0]!),
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a" } })),
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

	it("suffixes same-turn repeats of one id and pairs them 1:1 with their results in order", () => {
		// One assistant turn emitting the SAME id twice: the second block must
		// still be suffixed (`_dup1`) and the second real result must rewrite onto
		// it. The per-turn first-occurrence rule is what restricts the "drop
		// carried-over pending rewrites" step to an id's FIRST occurrence in a
		// turn; without it the second block would drop the first block's queued
		// rewrite, the first real result would rewrite onto the `_dup1` call and
		// the second would keep the base id — caller/result pairing inverted.
		const dupId = "call_same";
		const messages: Message[] = [
			{ role: "user", content: "read twice", timestamp: 0 },
			assistantWithCalls([dupId, dupId]),
			toolResult(dupId, "first"),
			toolResult(dupId, "second"),
		];

		const transformed = transformMessages(messages, makeModel());

		const assistantIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall")
			.map(b => b.id);
		expect(assistantIds).toEqual([dupId, `${dupId}_dup1`]);

		const results = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map(r => r.toolCallId)).toEqual([dupId, `${dupId}_dup1`]);
		expect(results[0]!.content).toEqual([{ type: "text", text: "first" }]);
		expect(results[1]!.content).toEqual([{ type: "text", text: "second" }]);
		// No synthetic back-fill: both real results found their call.
		expect(results.some(r => r.content.some(p => p.type === "text" && p.text === "No result provided"))).toBe(false);
	});

	it("keeps distinct ids independent when one turn interleaves repeats", () => {
		// A single turn `[A, B, A, B]`: each id's first occurrence is untouched by
		// the other, so both accumulate their own `_dup1` counter and rewrite
		// queue, and the four results pair 1:1 with the four calls in order.
		const idA = "call_a";
		const idB = "call_b";
		const messages: Message[] = [
			{ role: "user", content: "read four times", timestamp: 0 },
			assistantWithCalls([idA, idB, idA, idB]),
			toolResult(idA, "first"),
			toolResult(idA, "second"),
			toolResult(idB, "third"),
			toolResult(idB, "fourth"),
		];

		const transformed = transformMessages(messages, makeModel());

		const assistantIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter((b): b is ToolCall => b.type === "toolCall")
			.map(b => b.id);
		expect(assistantIds).toEqual([idA, idB, `${idA}_dup1`, `${idB}_dup1`]);

		const results = transformed.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map(r => [r.toolCallId, r.content])).toEqual([
			[idA, [{ type: "text", text: "first" }]],
			[`${idA}_dup1`, [{ type: "text", text: "second" }]],
			[idB, [{ type: "text", text: "third" }]],
			[`${idB}_dup1`, [{ type: "text", text: "fourth" }]],
		]);
	});
});
