import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BEDROCK_TEST_CONTEXT, bedrockTestModel, capturingBedrockFetch } from "./helpers/bedrock-stream";

describe("Bedrock sampling parameters", () => {
	test("generates a Grok 4.6 title without rejected sampling fields", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.xai.grok-4.6");
		const seen: { body?: unknown } = {};
		const result = await streamBedrock(model, BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: capturingBedrockFetch(seen),
			maxTokens: 1024,
			temperature: 0,
			topP: 0.8,
			reasoning: Effort.High,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "hi" }]);
		expect(seen.body).toMatchObject({
			inferenceConfig: { maxTokens: 1024 },
			additionalModelRequestFields: { reasoning: { effort: "high" } },
		});
		expect(seen.body).not.toHaveProperty("inferenceConfig.temperature");
		expect(seen.body).not.toHaveProperty("inferenceConfig.topP");
	});

	test("applies the Grok 4.6+ rule to newly discovered Grok 4.7", async () => {
		const model = bedrockTestModel({ id: "us.xai.grok-4.7", reasoning: true });
		const seen: { body?: unknown } = {};
		await streamBedrock(model, BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: capturingBedrockFetch(seen),
			temperature: 0,
			topP: 0.8,
		}).result();
		expect(seen.body).not.toHaveProperty("inferenceConfig.temperature");
		expect(seen.body).not.toHaveProperty("inferenceConfig.topP");
	});

	test("omits rejected sampling fields for Bedrock OpenAI GPT-6", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "us.openai.gpt-6-astra");
		const seen: { body?: unknown } = {};
		await streamBedrock(model, BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: capturingBedrockFetch(seen),
			temperature: 0,
			topP: 0.8,
		}).result();
		expect(seen.body).not.toHaveProperty("inferenceConfig.temperature");
		expect(seen.body).not.toHaveProperty("inferenceConfig.topP");
	});

	test("keeps explicit sampling fields on models that accept them", async () => {
		const model = bedrockTestModel();
		const seen: { body?: unknown } = {};
		await streamBedrock(model, BEDROCK_TEST_CONTEXT, {
			bearerToken: "test-token",
			fetch: capturingBedrockFetch(seen),
			temperature: 0,
			topP: 0.8,
		}).result();
		expect(seen.body).toMatchObject({ inferenceConfig: { temperature: 0, topP: 0.8 } });
	});
});
