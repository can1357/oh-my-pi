import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	buildResponsesInput,
	hoistInterleavedResponsesToolBatchMessages,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

describe("repairOrphanResponsesToolCalls", () => {
	it("appends a synthetic function_call_output after a call with no result", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		const callIndex = repaired.findIndex(
			item =>
				(item as { type?: string }).type === "function_call" && (item as { call_id?: string }).call_id === "call_a",
		);
		const output = repaired[callIndex + 1] as { type?: string; call_id?: string; output?: unknown };
		expect(output.type).toBe("function_call_output");
		expect(output.call_id).toBe("call_a");
		expect(output.output).toMatch(/interrupted/i);
	});

	it("uses custom_tool_call_output for an orphan custom_tool_call", () => {
		const input: ResponseInput = [
			{ type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "patch" } as ResponseInput[number],
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		const output = repaired.find(item => (item as { type?: string }).type === "custom_tool_call_output") as
			| { call_id?: string }
			| undefined;
		expect(output?.call_id).toBe("call_c");
	});

	it("returns the input unchanged when every call is paired", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "ok" } as ResponseInput[number],
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		expect(repaired).toBe(input);
	});

	it("does not pair a call with an output that appears earlier in replay order", () => {
		const input: ResponseInput = [
			{ type: "function_call_output", call_id: "call_a", output: "stale" } as ResponseInput[number],
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
		];

		const repaired = repairOrphanResponsesToolCalls(input);
		expect(repaired.at(-1)).toMatchObject({
			type: "function_call_output",
			call_id: "call_a",
			output: expect.stringMatching(/interrupted/i),
		});
	});
});

describe("repairOrphanResponsesToolOutputs", () => {
	it("does not pair an output with a call that appears later in replay order", () => {
		const input: ResponseInput = [
			{ type: "function_call_output", call_id: "call_a", output: "stale" } as ResponseInput[number],
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
		];

		const repaired = repairOrphanResponsesToolOutputs(input);
		expect(repaired[0]).toMatchObject({
			type: "message",
			role: "assistant",
			content: expect.stringContaining("stale"),
		});
		expect(repaired[1]).toBe(input[1]);
	});

	it("returns the input unchanged when every output follows its matching call", () => {
		const input: ResponseInput = [
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "ok" } as ResponseInput[number],
		];

		expect(repairOrphanResponsesToolOutputs(input)).toBe(input);
	});
});

describe("assistant messages interleaved in a tool-call batch", () => {
	// deepseek-v4-flash on opencode-go (Console Go) rejects an assistant message
	// interleaved between a function_call batch and its function_call_output items.
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

	it("leaves commentary between completed sequential tool rounds in place", () => {
		// Each round's call → output pair is complete before the next round's
		// commentary, so no message interrupts a batch and nothing may move.
		const input = [
			{ type: "message", role: "user", content: "go" },
			{ type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "a" },
			{ type: "message", role: "assistant", content: "after a" },
			{ type: "function_call", call_id: "call_b", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_b", output: "b" },
			{ type: "message", role: "assistant", content: "after b" },
			{ type: "function_call", call_id: "call_c", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_c", output: "c" },
		] as ResponseInput;

		expect(hoistInterleavedResponsesToolBatchMessages(input)).toEqual(input);
	});
});
