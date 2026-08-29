import { describe, expect, test } from "bun:test";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamSimple } from "../src/stream";

// Bedrock hosts the GPT-5.x SKUs behind OpenAI's own request schema. It rejects
// the Anthropic budget block with HTTP 400 `unknown_parameter: 'thinking'` and
// takes `reasoning.effort` instead, so the Converse provider has to switch wire
// shapes on the catalog's thinking mode rather than assuming Anthropic.

const OPENAI_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;

function bedrockModel(id: string, thinking: Model<"bedrock-converse-stream">["thinking"]) {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		thinking,
	});
}

function payloadFor(model: Model<"bedrock-converse-stream">, reasoning: Effort): Promise<unknown> {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();
	void streamSimple(model, context, {
		providerOptions: { bearerToken: "test-token" },
		signal: controller.signal,
		reasoning,
		maxTokens: 16,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

describe("Bedrock OpenAI-schema reasoning", () => {
	test("sends reasoning.effort and never the Anthropic thinking block", async () => {
		const model = bedrockModel("global.openai.gpt-5.6-luna", { mode: "effort", efforts: OPENAI_LADDER });
		const payload = (await payloadFor(model, Effort.Max)) as {
			additionalModelRequestFields?: Record<string, unknown>;
			inferenceConfig?: { maxTokens?: number };
		};

		expect(payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
		expect(payload.additionalModelRequestFields).not.toHaveProperty("thinking");
		expect(payload.inferenceConfig?.maxTokens).toBe(16);
	});

	test("keeps the budget block for Anthropic models on the same API", async () => {
		const model = bedrockModel("us.anthropic.claude-sonnet-4-5-20250929", {
			mode: "budget",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		const payload = (await payloadFor(model, Effort.High)) as {
			additionalModelRequestFields?: Record<string, unknown>;
		};

		expect(payload.additionalModelRequestFields).toMatchObject({
			thinking: { type: "enabled", budget_tokens: 16384 },
		});
	});
});
