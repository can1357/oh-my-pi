import { describe, expect, it } from "bun:test";
import {
	normalizeImageMimeType,
	supportsComputerScreenshotReferences,
	supportsProviderFileReference,
	supportsRemoteImageUrls,
} from "@oh-my-pi/pi-ai/providers/vision-guard";
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

function makeResponsesTargetModel<
	TApi extends "openai-responses" | "openai-codex-responses" | "azure-openai-responses",
>(api: TApi, provider: string, baseUrl: string) {
	return buildModel({
		id: "vision-model",
		name: "Vision Model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<TApi>);
}

function makeGoogleModel() {
	return buildModel({
		id: "vision-model",
		name: "Vision Model",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"google-generative-ai">);
}

function makeGoogleVertexModel() {
	return buildModel({
		id: "vision-model",
		name: "Vision Model",
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "https://us-central1-aiplatform.googleapis.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"google-vertex">);
}

describe("OpenAI provider-file capability", () => {
	it("requires effective computer-use support for screenshot metadata", () => {
		const unsupported = makeResponsesModel("openai", "https://api.openai.com/v1");
		expect(supportsComputerScreenshotReferences(unsupported)).toBe(false);

		const supported = buildModel({
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text", "image"],
			supportsComputerUse: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"openai-responses">);
		expect(supportsComputerScreenshotReferences(supported)).toBe(true);
	});

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

	it("does not reuse OpenAI handles across Responses providers", () => {
		const reference = { provider: "openai", id: "file_image_123" };
		const image = { mimeType: "image/png" };

		expect(
			supportsProviderFileReference(
				makeResponsesTargetModel(
					"openai-codex-responses",
					"openai-codex",
					"https://chatgpt.com/backend-api/codex/responses",
				),
				reference,
				image,
			),
		).toBe(false);
		expect(
			supportsProviderFileReference(
				makeResponsesTargetModel(
					"azure-openai-responses",
					"azure",
					"https://resource.openai.azure.com/openai/deployments/vision",
				),
				reference,
				image,
			),
		).toBe(false);
	});

	it("rejects malformed and non-finite provider-file expirations", () => {
		const model = makeGoogleModel();
		const image = { mimeType: "image/png" };
		const reference = { provider: "google", uri: "https://generativelanguage.googleapis.com/v1/files/vision" };

		for (const expiresAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "invalid", null]) {
			expect(supportsProviderFileReference(model, { ...reference, expiresAt }, image)).toBe(false);
		}
		expect(supportsProviderFileReference(model, { ...reference, expiresAt: Date.now() + 60_000 }, image)).toBe(true);
	});

	it("accepts parameterized MIME types for replayable Google references", () => {
		const image = { mimeType: "image/png;charset=binary" };
		expect(normalizeImageMimeType(image.mimeType)).toBe("image/png");
		expect(
			supportsProviderFileReference(
				makeGoogleModel(),
				{ provider: "google", uri: "https://generativelanguage.googleapis.com/v1/files/vision" },
				image,
			),
		).toBe(true);
		expect(supportsRemoteImageUrls(makeGoogleVertexModel(), image)).toBe(true);
	});
});
