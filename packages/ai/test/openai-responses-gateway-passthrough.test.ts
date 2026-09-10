import { describe, expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function model() {
	return buildModel({
		api: "openai-responses",
		name: "gpt-test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

describe("openai-responses gateway passthrough fields", () => {
	it("maps responseFormat onto Responses text.format", () => {
		const { params } = buildParams(
			model(),
			context,
			{
				responseFormat: { type: "json_object" },
				parallelToolCalls: false,
				user: "user-1",
				seed: 7,
			},
			undefined,
		);
		expect(params.text?.format).toEqual({ type: "json_object" });
		expect(params.parallel_tool_calls).toBe(false);
		expect(params.user).toBe("user-1");
		// Responses API has no `seed` field; Chat Completions seed must be omitted.
		expect("seed" in params).toBe(false);
		expect("logit_bias" in params).toBe(false);
	});

	it("does not invent logit_bias on the Responses wire (negative)", () => {
		const { params } = buildParams(
			model(),
			context,
			{
				logitBias: { "42": -1 },
			},
			undefined,
		);
		expect("logit_bias" in params).toBe(false);
	});
});
