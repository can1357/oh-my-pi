// The dedup pass copies an assistant turn's content array only when it mints
// a `_dup` id. Without duplicates the turn must pass through with its content
// array untouched — a per-turn `.map` would rebuild every turn's array on every
// request and throw it away. If this regresses, long transcripts pay one
// wasted array per assistant turn per provider request.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai/types";
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

function toolResult(id: string, text: string, timestamp: number): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	} as Message;
}

describe("dedup pass skips the content copy when nothing diverges", () => {
	it("reuses each assistant turn's content blocks when no id repeats", () => {
		const first = assistantTurn("call_one", "first");
		const second = assistantTurn("call_two", "second");
		const messages: Message[] = [
			first,
			toolResult("call_one", "one", 1),
			second,
			toolResult("call_two", "two", 2),
		];

		const transformed = transformMessages(messages, makeSameModel());

		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		// No `_dup` minted, so the dedup pass copies nothing: every emitted
		// block is the caller's own block object. (The normalization pass may
		// still wrap the turn, so this asserts block identity, not array identity.)
		expect(assistants[0]!.content).toHaveLength(first.content.length);
		expect(assistants[1]!.content).toHaveLength(second.content.length);
		for (const [index, block] of assistants[0]!.content.entries()) {
			expect(block).toBe(first.content[index]);
		}
		for (const [index, block] of assistants[1]!.content.entries()) {
			expect(block).toBe(second.content[index]);
		}
		// The surviving pairings still resolve: no result is orphaned or synthesized.
		const results = transformed.filter(m => m.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.some(r => r.role === "toolResult" && r.content.some(p => p.type === "text" && p.text === "No result provided"))).toBe(false);
	});

	it("still emits the deduplicated ids when an id repeats across turns", () => {
		const dupId = "call_same";
		const first = assistantTurn(dupId, "first");
		const second = assistantTurn(dupId, "second");
		const messages: Message[] = [
			first,
			toolResult(dupId, "one", 1),
			second,
			toolResult(dupId, "two", 2),
		];

		const transformed = transformMessages(messages, makeSameModel());

		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		const ids = assistants.flatMap(m => m.content).filter(b => b.type === "toolCall").map(b => b.type === "toolCall" && "id" in b ? (b as { id: string }).id : "");
		expect(ids).toEqual([dupId, `${dupId}_dup1`]);
		// The untouched first turn keeps its block objects; the rewritten turn
		// keeps its text block and carries the suffixed call.
		for (const [index, block] of assistants[0]!.content.entries()) {
			expect(block).toBe(first.content[index]);
		}
		expect(assistants[1]!.content[0]).toBe(second.content[0]);
	});

	it("routes each result to its own call when one id repeats three times", () => {
		// The per-turn first-occurrence guard drops a stale pending rewrite when
		// the id recurs: without it the older `_dup` id would steal the next
		// result and the pairing would invert. Three repeats exercise the guard
		// across two turn boundaries.
		const dupId = "call_x";
		const messages: Message[] = [
			assistantTurn(dupId, "t1"),
			toolResult(dupId, "r1", 1),
			assistantTurn(dupId, "t2"),
			toolResult(dupId, "r2", 2),
			assistantTurn(dupId, "t3"),
			toolResult(dupId, "r3", 3),
		];

		const transformed = transformMessages(messages, makeSameModel());

		const assistants = transformed.filter((m): m is AssistantMessage => m.role === "assistant");
		const callIds = assistants.flatMap(m => m.content).filter(b => b.type === "toolCall").map(b => (b as { id: string }).id);
		expect(callIds).toEqual([dupId, `${dupId}_dup1`, `${dupId}_dup2`]);
		const results = transformed.filter(m => m.role === "toolResult");
		expect(results.map(r => r.role === "toolResult" ? r.toolCallId : "")).toEqual(callIds);
		expect(results.map(r => r.role === "toolResult" ? r.content : [])).toEqual([
			[{ type: "text", text: "r1" }],
			[{ type: "text", text: "r2" }],
			[{ type: "text", text: "r3" }],
		]);
	});
});
