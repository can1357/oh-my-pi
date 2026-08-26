import { describe, expect, it } from "bun:test";
import { supportsProviderFileReference } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeResponsesModel(provider: string, baseUrl: string) {
	return buildModel({
		id: "vision-model",
		name: "Vision Model",
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"openai-responses">);
}

describe("OpenAI provider-file capability", () => {
	it("requires the official OpenAI provider and endpoint", () => {
		const reference = { provider: "openai", id: "file_image_123" };
		const image = { mimeType: "image/png" };

		expect(
			supportsProviderFileReference(makeResponsesModel("openai", "https://api.openai.com/v1"), reference, image),
		).toBe(true);
		expect(supportsProviderFileReference(makeResponsesModel("xai", "https://api.x.ai/v1"), reference, image)).toBe(
			false,
		);
		expect(
			supportsProviderFileReference(
				makeResponsesModel("openai", "https://proxy.example.invalid/v1"),
				reference,
				image,
			),
		).toBe(false);

		for (const baseUrl of [
			"https://api.openai.com/proxy",
			"https://api.openai.com:8443/v1",
			"https://user:pass@api.openai.com/v1",
			"https://api.openai.com/v1?proxy=1",
			"https://api.openai.com/v1#fragment",
		]) {
			expect(supportsProviderFileReference(makeResponsesModel("openai", baseUrl), reference, image)).toBe(false);
		}

		expect(
			supportsProviderFileReference(makeResponsesModel("openai", "https://api.openai.com/v1/"), reference, image),
		).toBe(true);
	});
});
