import { expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"openai-responses"> = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} as ModelSpec<"openai-responses">);

function assistantWithNativeHistory(items: Array<Record<string, unknown>>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
		providerPayload: { type: "openaiResponsesHistory", provider: "openai", items },
	};
}

it("removes a truncated function call from the next Responses request without losing its durable output", () => {
	const completeArguments = JSON.stringify({ command: "curl https://example.com | jq .", i: "Fetch data" });
	const truncatedArguments = completeArguments.slice(0, -5);
	const previous = assistantWithNativeHistory([
		{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_1" },
		{ type: "function_call", id: "fc_ok", call_id: "call_ok", name: "bash", arguments: "{}" },
		{
			type: "function_call",
			id: "fc_bad",
			call_id: "call_bad",
			name: "bash",
			arguments: truncatedArguments,
		},
		{ type: "function_call_output", call_id: "call_ok", output: "valid result" },
		{ type: "function_call_output", call_id: "call_bad", output: "durable result" },
	]);

	const input = buildParams(
		model,
		{ messages: [previous, { role: "user", content: "continue", timestamp: 2 }] },
		undefined,
		undefined,
	).params.input as unknown as Array<Record<string, unknown>>;

	expect(input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_ok" }));
	expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_ok" }));
	expect(input).not.toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_bad" }));
	expect(input).not.toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_bad" }));
	expect(JSON.stringify(input)).toContain("durable result");
});
