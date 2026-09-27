import { expect, it } from "bun:test";
import type { ResponseInput } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
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

it("does not wedge a repaired orphan-output note between a call and its output (#11473)", () => {
	// One turn: model issued parallel `todo` (call_00) + `bash` (call_01). `todo`
	// failed omp-side arg validation, so the native-replay snapshot (dt:false)
	// carries only the landed `bash` call; `todo` survives as an orphan result.
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
	const types = items.map(wireType);

	// The orphan result is preserved as an assistant note (call_id + output text).
	const note = items.find(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { type?: unknown; role?: unknown; content?: unknown };
		return (
			candidate.type === "message" &&
			candidate.role === "assistant" &&
			typeof candidate.content === "string" &&
			candidate.content.includes("call_00")
		);
	}) as { content?: string } | undefined;
	expect(note?.content).toContain("[Orphan tool result; call_id=call_00]");
	expect(note?.content).toContain("Invalid todo arguments");

	// Invariant: no message sits between a function_call and a function_call_output.
	// Before the fix the note landed at index 2, wedged inside the bash batch.
	const firstOutput = types.indexOf("function_call_output");
	const lastCall = types.lastIndexOf("function_call");
	expect(firstOutput).toBeGreaterThanOrEqual(0);
	expect(lastCall).toBeLessThan(firstOutput);
	expect(types.slice(lastCall + 1, firstOutput)).toEqual([]);
});
