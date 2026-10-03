import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// deepseek-v4-flash on opencode-go (Console Go) — the gateway from #8789 that
// rejects an assistant message interleaved between a function_call batch and
// its function_call_output items.
const model = buildModel({
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function wireType(item: ResponseInput[number]): string {
	if ("type" in item && typeof item.type === "string") return item.type;
	if ("role" in item && typeof item.role === "string") return `message:${item.role}`;
	return "unknown";
}

function toolResult(callId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

describe("buildResponsesInput #8789 interleaved assistant message", () => {
	it("hoists a trailing text block before its tool-call batch", () => {
		// Model streamed [thinking, 3 tool calls, trailing "</thinking" text].
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me call some tools" },
				{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b" } },
				{ type: "toolCall", id: "call_c", name: "read", arguments: { path: "c" } },
				{ type: "text", text: "<think>\n</thinking\n</think>" },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const context: Context = {
			messages: [
				assistant,
				toolResult("call_a", "out a"),
				toolResult("call_b", "out b"),
				toolResult("call_c", "out c"),
				{ role: "user", content: "continue", timestamp: 5 },
			],
		};

		const items = buildResponsesInput({
			model,
			context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
		});

		expect(items.map(wireType)).toEqual([
			"message",
			"function_call",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
			"function_call_output",
			"message:user",
		]);

		// The demoted-thinking text is preserved verbatim as the hoisted message.
		const hoisted = items[0];
		expect(JSON.stringify(hoisted)).toContain("</thinking");

		// Invariant: no assistant message sits between a call and an output.
		const types = items.map(wireType);
		const lastCall = types.lastIndexOf("function_call");
		const firstOutput = types.indexOf("function_call_output");
		expect(lastCall).toBeLessThan(firstOutput);
		expect(types.slice(lastCall + 1, firstOutput)).toEqual([]);
	});

	it("leaves an already-canonical message → calls → outputs turn unchanged", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "calling read on two files" },
				{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const context: Context = {
			messages: [assistant, toolResult("call_a", "out a"), toolResult("call_b", "out b")],
		};

		const items = buildResponsesInput({
			model,
			context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: false,
		});

		expect(items.map(wireType)).toEqual([
			"message",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
		]);
	});
});
