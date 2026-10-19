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

it("replays a truncated function call with parseable diagnostic arguments so its output stays paired", () => {
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

	// No follow-up user message: the repaired history is the tail of the request (#15568).
	const input = buildParams(model, { messages: [previous] }, undefined, undefined).params.input as unknown as Array<
		Record<string, unknown>
	>;

	const badCall = input.find(item => item.type === "function_call" && item.call_id === "call_bad");
	expect(JSON.parse(String(badCall?.arguments))).toEqual({
		__parseError: expect.any(String),
		__rawJson: truncatedArguments,
	});
	expect(input).toContainEqual(
		expect.objectContaining({ type: "function_call", call_id: "call_ok", arguments: "{}" }),
	);
	expect(input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_bad", output: "durable result" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("replays frozen caller-owned function calls without mutating them", () => {
	const items = [
		Object.freeze({ type: "function_call", id: "fc_ok", call_id: "call_ok", name: "bash", arguments: '{"a":1}' }),
		Object.freeze({ type: "function_call", id: "fc_bad", call_id: "call_bad", name: "bash", arguments: '{"a":' }),
		Object.freeze({ type: "function_call_output", call_id: "call_ok", output: "ok" }),
		Object.freeze({ type: "function_call_output", call_id: "call_bad", output: "bad" }),
	];
	const previous = assistantWithNativeHistory(items);

	const input = buildParams(model, { messages: [previous] }, undefined, undefined).params.input as unknown as Array<
		Record<string, unknown>
	>;

	expect(input).toContainEqual(expect.objectContaining({ call_id: "call_ok", arguments: '{"a":1}' }));
	const badCall = input.find(item => item.type === "function_call" && item.call_id === "call_bad");
	expect(JSON.parse(String(badCall?.arguments))).toMatchObject({ __rawJson: '{"a":' });
});
