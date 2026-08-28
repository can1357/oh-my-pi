import { describe, expect, it } from "bun:test";
import { resolveResponsesComputerScreenshot } from "@oh-my-pi/pi-ai/providers/openai-shared";
import {
	normalizeImageMimeType,
	supportsComputerScreenshotReferences,
	supportsProviderFileReference,
	supportsRemoteImageUrls,
} from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
		supportsComputerUse: true,
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
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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

function makeAnthropicModel(baseUrl: string) {
	return buildModel({
		id: "claude-vision",
		name: "Claude Vision",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"anthropic-messages">);
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
		expect(
			supportsComputerScreenshotReferences(supported, {
				type: "computer_screenshot",
				image_url: "https://images.example.invalid/screenshot.png",
			}),
		).toBe(true);
	});

	it("requires replayable computer screenshot image URLs", () => {
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

		expect(
			supportsComputerScreenshotReferences(supported, {
				type: "computer_screenshot",
				image_url: `data:image/png;base64,${PNG_B64}`,
			}),
		).toBe(true);
		expect(
			supportsComputerScreenshotReferences(supported, {
				type: "computer_screenshot",
				image_url: "not-a-url",
			}),
		).toBe(false);
		expect(
			supportsComputerScreenshotReferences(supported, {
				type: "computer_screenshot",
				image_url: "data:image/png;base64,ZmFrZQ==",
			}),
		).toBe(false);
		expect(supportsComputerScreenshotReferences(supported, { type: "computer_screenshot", image_url: "" })).toBe(
			false,
		);
	});

	it("applies provider URL replay policy to computer screenshots", () => {
		const screenshot = {
			type: "computer_screenshot" as const,
			image_url: "https://images.example.invalid/screenshot.png",
		};
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel("openai-responses", "openai", "https://api.openai.com/v1"),
				screenshot,
			),
		).toBe(true);
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel("openai-responses", "ollama", "http://localhost:11434/v1"),
				screenshot,
			),
		).toBe(false);
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel(
					"openai-responses",
					"bedrock-mantle",
					"https://bedrock-mantle.us-east-1.api.aws/v1",
				),
				screenshot,
			),
		).toBe(false);
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

	it("does not reuse OpenAI computer screenshot file IDs across Responses targets", () => {
		const screenshot = { type: "computer_screenshot", file_id: "file_image_123" };
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel("openai-responses", "openai", "https://api.openai.com/v1"),
				screenshot,
			),
		).toBe(true);
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel(
					"openai-codex-responses",
					"openai-codex",
					"https://chatgpt.com/backend-api/codex/responses",
				),
				screenshot,
			),
		).toBe(false);
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel("azure-openai-responses", "azure", "https://resource.openai.azure.com/openai/v1"),
				screenshot,
			),
		).toBe(false);
		expect(
			supportsComputerScreenshotReferences(
				makeResponsesTargetModel("openai-responses", "openai", "https://proxy.example.invalid/v1"),
				screenshot,
			),
		).toBe(false);
	});

	it("requires the computer_screenshot discriminant and exactly one source", () => {
		const model = makeResponsesTargetModel("openai-responses", "openai", "https://api.openai.com/v1");

		expect(
			supportsComputerScreenshotReferences(model, { type: "computer_screenshot", file_id: "file_image_123" }),
		).toBe(true);
		expect(supportsComputerScreenshotReferences(model, { type: "bogus", file_id: "file_image_123" })).toBe(false);
		expect(supportsComputerScreenshotReferences(model, { file_id: "file_image_123" })).toBe(false);
		expect(
			supportsComputerScreenshotReferences(model, {
				type: "computer_screenshot",
				file_id: "file_image_123",
				image_url: "https://images.example.invalid/screenshot.png",
			}),
		).toBe(false);
		expect(supportsComputerScreenshotReferences(model, { type: "computer_screenshot" })).toBe(false);
		expect(supportsComputerScreenshotReferences(model, { type: "computer_screenshot", file_id: "" })).toBe(false);
		expect(supportsComputerScreenshotReferences(model, { type: "computer_screenshot", file_id: 42 })).toBe(false);
	});

	it("accepts Anthropic handles on canonical official API bases", () => {
		const reference = { provider: "anthropic", id: "file_anthropic_123" };
		const image = { mimeType: "image/png" };

		for (const baseUrl of [
			"https://api.anthropic.com",
			"https://api.anthropic.com/",
			"https://api.anthropic.com/v1",
			"https://api.anthropic.com/v1/",
		]) {
			expect(supportsProviderFileReference(makeAnthropicModel(baseUrl), reference, image)).toBe(true);
		}
		expect(
			supportsProviderFileReference(makeAnthropicModel("https://api.anthropic.com/v1/proxy"), reference, image),
		).toBe(false);
	});

	it("resolves no computer screenshot for a target that cannot carry one", () => {
		// A stale `computer` marker can ride along with a provider-file image that
		// only the owning non-Responses API can encode. Resolving a Responses
		// screenshot from it used to throw and surface as a gateway 500.
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer",
			toolName: "computer",
			content: [
				{
					type: "image",
					data: "",
					mimeType: "image/png",
					providerFile: { provider: "anthropic", id: "file_screenshot" },
				},
			],
			isError: false,
			timestamp: 0,
		};

		for (const model of [makeAnthropicModel("https://api.anthropic.com/v1"), makeGoogleModel()]) {
			expect(resolveResponsesComputerScreenshot(toolResult, model, false)).toBeUndefined();
		}
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

	it("rejects Google provider files whose URI is not an official Files resource", () => {
		const model = makeGoogleModel();
		const image = { mimeType: "image/png" };

		for (const uri of [
			"https://example.invalid/image.png",
			"https://generativelanguage.googleapis.com/v1beta/files",
			"https://generativelanguage.googleapis.com/v1beta/files/vision/extra",
			"https://generativelanguage.googleapis.com/v1beta999/files/vision",
			"https://generativelanguage.googleapis.com/v2/files/vision",
			"http://generativelanguage.googleapis.com/v1beta/files/vision",
			"https://generativelanguage.googleapis.com.evil.invalid/v1beta/files/vision",
			// Percent-encoded segments decode into another resource path or a
			// control character, so the still-encoded pathname must not qualify.
			"https://generativelanguage.googleapis.com/v1beta/files/a%2Fb",
			"https://generativelanguage.googleapis.com/v1beta/files/%00",
			"https://generativelanguage.googleapis.com/v1beta/files/%2e%2e",
			"not-a-url",
			"",
		]) {
			expect(supportsProviderFileReference(model, { provider: "google", uri }, image)).toBe(false);
		}
		for (const uri of [
			"https://generativelanguage.googleapis.com/v1beta/files/vision",
			"https://generativelanguage.googleapis.com/v1/files/vision",
		]) {
			expect(supportsProviderFileReference(model, { provider: "google", uri }, image)).toBe(true);
		}
	});

	it("resolves an unset Google base URL to the official Files endpoint", () => {
		const image = { mimeType: "image/png" };
		const reference = { provider: "google", uri: "https://generativelanguage.googleapis.com/v1beta/files/vision" };
		const spec = {
			id: "vision-model",
			name: "Vision Model",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"google-generative-ai">;

		// Dispatch resolves an unset base URL to the official `/v1beta` host, and
		// the official `/v1` base serves the same Files resources.
		expect(supportsProviderFileReference(buildModel(spec), reference, image)).toBe(true);
		expect(
			supportsProviderFileReference(
				buildModel({ ...spec, baseUrl: "https://generativelanguage.googleapis.com/v1" }),
				reference,
				image,
			),
		).toBe(true);
		expect(
			supportsProviderFileReference(
				buildModel({ ...spec, baseUrl: "https://proxy.invalid/v1beta" }),
				reference,
				image,
			),
		).toBe(false);
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
