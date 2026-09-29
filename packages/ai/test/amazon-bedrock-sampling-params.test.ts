import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = { messages: [{ role: "user", content: "Name this session.", timestamp: 0 }] };

function inferenceConfig(model: Model<"bedrock-converse-stream">): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		maxTokens: 1024,
		temperature: 0,
		topP: 0.9,
		onPayload: payload => {
			if (payload && typeof payload === "object" && "inferenceConfig" in payload) resolve(payload.inferenceConfig);
		},
	});
	return promise;
}

function bundled(id: string): Model<"bedrock-converse-stream"> {
	const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", id);
	expect(model).toBeDefined();
	return model!;
}

describe("Bedrock Converse sampling params (#13730)", () => {
	test("omits temperature and topP for models that 400 on them", async () => {
		const grok47 = buildModel({
			id: "us.xai.grok-4.7",
			name: "Grok 4.7",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 500_000,
			maxTokens: 500_000,
		});
		for (const model of [
			bundled("us.xai.grok-4.6"),
			grok47,
			bundled("us.openai.gpt-6-astra"),
			bundled("us.anthropic.claude-opus-5-5"),
		]) {
			expect(await inferenceConfig(model)).toEqual({ maxTokens: 1024 });
		}
	});

	test("keeps temperature and topP for models that accept them", async () => {
		for (const id of ["us.anthropic.claude-opus-4-6-v1", "openai.gpt-oss-120b-1:0"]) {
			expect(await inferenceConfig(bundled(id))).toEqual({ maxTokens: 1024, temperature: 0, topP: 0.9 });
		}
	});
});
