// The dedup pass rewrites an assistant turn's content array only on the turn
// that mints a `_dup` id; a duplicate-free turn keeps the array it was handed.
//
// That skipped copy is NOT observable through `transformMessages`: the
// normalization pass upstream rebuilds every assistant turn's content array
// with `flatMap` before the dedup pass sees it, and both the old per-turn
// `.map` and the new lazy copy emit element-identical content. A
// reference-identity assertion therefore cannot separate the two
// implementations — checked against origin/main, where the copy always
// happens, the emitted blocks are the same objects either way — so the
// allocation claim rests on the source change. What the pass does expose is
// the emitted id contract, asserted here.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeSameModel(): Model<"openai-responses"> {
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

function assistantTurn(id: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name: "read", arguments: { path: "a" } },
		],
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

function toolResult(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function assistantTurns(messages: Message[]): AssistantMessage[] {
	return messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

describe("deduplicateToolCallIds", () => {
	it("suffixes a repeated id across turns and leaves distinct ids alone", () => {
		const model = makeSameModel();
		const withoutRepeat: Message[] = [
			assistantTurn("call_one", "first"),
			toolResult("call_one", "one", 1),
			assistantTurn("call_two", "second"),
			toolResult("call_two", "two", 2),
		];
		const withRepeat: Message[] = [
			assistantTurn("call_same", "first"),
			toolResult("call_same", "one", 1),
			assistantTurn("call_same", "second"),
			toolResult("call_same", "two", 2),
		];

		const ids = (messages: Message[]): string[] =>
			assistantTurns(messages)
				.flatMap(message => message.content)
				.filter(block => block.type === "toolCall")
				.map(block => block.id);

		expect(ids(transformMessages(withoutRepeat, model))).toEqual(["call_one", "call_two"]);
		expect(ids(transformMessages(withRepeat, model))).toEqual(["call_same", "call_same_dup1"]);
	});
});
