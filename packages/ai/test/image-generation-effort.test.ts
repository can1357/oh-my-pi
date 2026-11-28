import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { generateGoogleImage } from "../src/images/google-generative-ai";
import type { ImageGenerationRequest } from "../src/images/types";
import type { FetchImpl } from "../src/types";

const IMAGE_DATA = Buffer.from("image bytes").toString("base64");

function googleImageModel(id: string, reasoning: boolean): Model<"google-generative-ai"> {
	return buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://google.example/v1beta",
		kind: "image",
		reasoning,
		...(reasoning
			? {
					thinking: {
						mode: "google-level" as const,
						efforts: [Effort.Minimal, Effort.High],
						defaultLevel: Effort.Minimal,
					},
				}
			: {}),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65_536,
		maxTokens: 32_768,
	} satisfies ModelSpec<"google-generative-ai">);
}

/** The `generationConfig` each request carried, in order. */
async function generationConfigs(
	model: Model<"google-generative-ai">,
	requests: Array<Omit<ImageGenerationRequest, "prompt">>,
): Promise<unknown[]> {
	const configs: unknown[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		configs.push(JSON.parse(String(init?.body)).generationConfig);
		return Response.json({
			candidates: [{ content: { parts: [{ inlineData: { data: IMAGE_DATA, mimeType: "image/png" } }] } }],
		});
	};
	for (const request of requests) {
		await generateGoogleImage(model, { prompt: "a fox", ...request }, { apiKey: "key", fetch });
	}
	return configs;
}

describe("Gemini image thinking effort", () => {
	test("sends an effort on the model's ladder as thinkingLevel and omits any other", async () => {
		const ladder = await generationConfigs(googleImageModel("gemini-3.1-flash-image", true), [
			{ reasoning: Effort.High },
			{ reasoning: Effort.Minimal },
			{},
			{ reasoning: Effort.Medium },
		]);
		const plain = await generationConfigs(googleImageModel("gemini-2.5-flash-image", false), [
			{ reasoning: Effort.High },
		]);
		expect([...ladder, ...plain]).toEqual([
			{ responseModalities: ["IMAGE"], thinkingConfig: { thinkingLevel: "HIGH" } },
			{ responseModalities: ["IMAGE"], thinkingConfig: { thinkingLevel: "MINIMAL" } },
			{ responseModalities: ["IMAGE"] },
			{ responseModalities: ["IMAGE"] },
			{ responseModalities: ["IMAGE"] },
		]);
	});
});
