import { expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	buildResponsesInput,
	hoistInterleavedResponsesToolBatchMessages,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// DeepSeek via openai-responses (#11473): its validator pairs tool calls by
// turn, so an assistant `message` wedged between a `function_call` and its
// `function_call_output` closes the round early → `400 No tool output found`.
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

function toolResult(callId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

it("pairs a call missing from a native snapshot before sending its result (#11473)", () => {
	// A tool call omitted from a native snapshot still has a block and a result.
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_00", name: "todo", arguments: {} },
			{ type: "toolCall", id: "call_01", name: "bash", arguments: { command: "ls" } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "toolUse",
		providerPayload: createOpenAIResponsesHistoryPayload(
			model.provider,
			[
				{ type: "reasoning", id: "rs_1", summary: [], content: [] },
				{ type: "function_call", call_id: "call_01", name: "bash", arguments: "{}" },
			],
			false,
		),
		timestamp: 1,
	};
	const context: Context = {
		messages: [
			assistant,
			toolResult("call_00", "todo", "Invalid todo arguments: op must be operation to apply", true),
			toolResult("call_01", "bash", "file listing"),
			{ role: "user", content: "continue", timestamp: 5 },
		],
	};

	const items = buildResponsesInput({
		model,
		context,
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		repairOrphanOutputs: true,
		nativeHistory: { replay: true, filterReasoning: false },
	});
	expect(items.map(wireType)).toEqual([
		"reasoning",
		"function_call",
		"function_call",
		"function_call_output",
		"function_call_output",
		"message:user",
	]);
	expect(JSON.stringify(items)).not.toContain("[Orphan tool result; call_id=call_00]");
	expect(items.find(item => item.type === "function_call" && item.call_id === "call_00")).toMatchObject({
		name: "todo",
		arguments: "{}",
	});
	expect(items.find(item => item.type === "function_call_output" && item.call_id === "call_00")).toMatchObject({
		output: "Invalid todo arguments: op must be operation to apply",
	});
});

it("leaves commentary between completed sequential tool rounds in place (#13083)", () => {
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
