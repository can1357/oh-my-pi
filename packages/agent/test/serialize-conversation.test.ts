import { describe, expect, test } from "bun:test";
import { serializeConversation, serializeConversationForSummary } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResultMessage(toolCallId: string, text: string, extra: Partial<ToolResultMessage> = {}): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "search",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
		...extra,
	};
}

describe("serializeConversation — useless pairs", () => {
	test("skips a useless-flagged tool call/result pair but keeps its sibling", () => {
		const out = serializeConversation([
			assistantMessage([
				{ type: "toolCall", id: "c-keep", name: "search", arguments: { pattern: "alpha" } },
				{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
			]),
			toolResultMessage("c-keep", "alpha match found in src/alpha.ts"),
			toolResultMessage("c-drop", "No matches found", { useless: true }),
		]);

		expect(out).toContain('search(pattern="alpha")');
		expect(out).toContain("alpha match found in src/alpha.ts");
		expect(out).not.toContain("zzz_nothing");
		expect(out).not.toContain("No matches found");
	});

	test("error results stay serialized even when flagged useless", () => {
		const out = serializeConversation([
			assistantMessage([{ type: "toolCall", id: "c-err", name: "search", arguments: { pattern: "beta" } }]),
			toolResultMessage("c-err", "grep crashed", { useless: true, isError: true }),
		]);

		expect(out).toContain('search(pattern="beta")');
		expect(out).toContain("[Tool Result]: grep crashed");
	});

	test("renders native dialect transcripts when a dialect is provided", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "text", text: "Searching." },
					{ type: "toolCall", id: "c-native", name: "search", arguments: { pattern: "gamma" } },
				]),
				toolResultMessage("c-native", "gamma match found"),
			],
			"anthropic",
		);

		expect(out).toContain("\n\nAssistant:");
		expect(out).toContain("<function_calls>");
		expect(out).toContain("<function_results>");
		expect(out).not.toContain("[Tool Call]:");
		expect(out).not.toContain("[Assistant tool calls]:");
	});

	test("summary serialization escapes Harmony control tokens while preserving assistant thinking", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "Need to inspect the failing compaction path." },
				{ type: "text", text: "The final answer stays visible." },
			]),
		];

		const out = serializeConversationForSummary(messages, "harmony");

		expect(out).not.toContain("<|channel|>analysis");
		expect(out).not.toContain("<|message|>");
		expect(out).toContain("<\\|channel\\|>analysis");
		expect(out).toContain("<\\|channel\\|>final");
		expect(out).toContain("Need to inspect the failing compaction path.");
		expect(out).toContain("The final answer stays visible.");
	});

	test("native Harmony serialization keeps raw transcript markers", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "thinking", thinking: "Native transcript includes analysis." },
					{ type: "text", text: "Native final text." },
				]),
			],
			"harmony",
		);

		expect(out).toContain("<|channel|>analysis");
		expect(out).toContain("<|message|>Native transcript includes analysis.");
		expect(out).toContain("<|channel|>final");
		expect(out).toContain("Native final text.");
	});

	test("native dialect serialization drops empty assistants left by useless calls", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
				]),
				toolResultMessage("c-drop", "No matches found", { useless: true }),
			],
			"harmony",
		);

		expect(out).toBe("");
	});

	test("strips assistant reasoning from Anthropic-dialect summary input but keeps text and tool calls", () => {
		const reasoning = "PRIVATE chain of thought that must not be replayed to Claude";
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "thinking", thinking: reasoning },
					{ type: "text", text: "The visible answer." },
					{ type: "toolCall", id: "c1", name: "search", arguments: { pattern: "delta" } },
				]),
			],
			"anthropic",
		);

		expect(out).not.toContain(reasoning);
		expect(out).not.toContain("<thinking>");
		expect(out).toContain("The visible answer.");
		expect(out).toContain("<function_calls>");
	});

	test("keeps assistant reasoning for non-Anthropic dialects", () => {
		const reasoning = "reasoning kept for the XML transcript";
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "thinking", thinking: reasoning },
					{ type: "text", text: "answer" },
				]),
			],
			"xml",
		);

		expect(out).toContain(reasoning);
		expect(out).toContain("<thinking>");
	});
});
