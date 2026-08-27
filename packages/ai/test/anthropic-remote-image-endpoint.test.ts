import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { supportsRemoteImageUrls } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv } from "./helpers";

// Only the first-party Claude API fetches `source: { type: "url" }` images.
// Custom proxies and Azure AI Foundry ignore the reference, so a valid inline
// payload must stay on the wire instead of being replaced by the URL.

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const REMOTE_URL = "https://images.example.invalid/screenshot.png";

const DEFAULT_ANTHROPIC_ENV = {
	ANTHROPIC_BASE_URL: undefined,
	CLAUDE_CODE_USE_FOUNDRY: undefined,
	FOUNDRY_BASE_URL: undefined,
};

function makeAnthropicModel(baseUrl: string): Model<"anthropic-messages"> {
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

const userWithReferencedImage: UserMessage = {
	role: "user",
	content: [
		{ type: "text", text: "describe" },
		{ type: "image", data: PNG_B64, mimeType: "image/png", url: REMOTE_URL },
	],
	timestamp: 0,
};

function serializedImageSource(model: Model<"anthropic-messages">): Record<string, unknown> {
	const params = convertAnthropicMessages([userWithReferencedImage], model, false);
	const blocks = params.at(-1)?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const image = blocks.find(block => block.type === "image");
	expect(image).toBeDefined();
	return image?.source as Record<string, unknown>;
}

describe("Anthropic remote image URL capability", () => {
	it("replays remote URLs on the official API and keeps inline bytes on a proxy", async () => {
		await withEnv(DEFAULT_ANTHROPIC_ENV, () => {
			const official = makeAnthropicModel("https://api.anthropic.com");
			expect(supportsRemoteImageUrls(official, { mimeType: "image/png" })).toBe(true);
			expect(serializedImageSource(official)).toEqual({ type: "url", url: REMOTE_URL });

			const proxy = makeAnthropicModel("https://claude-proxy.example.invalid/v1");
			expect(supportsRemoteImageUrls(proxy, { mimeType: "image/png" })).toBe(false);
			expect(serializedImageSource(proxy)).toEqual({
				type: "base64",
				media_type: "image/png",
				data: PNG_B64,
			});
		});
	});

	it("keeps inline bytes when an enterprise gateway reroutes the request", async () => {
		await withEnv({ ...DEFAULT_ANTHROPIC_ENV, ANTHROPIC_BASE_URL: "https://gateway.example.invalid" }, () => {
			const model = makeAnthropicModel("https://api.anthropic.com");
			expect(supportsRemoteImageUrls(model, { mimeType: "image/png" })).toBe(false);
			expect(serializedImageSource(model)).toEqual({
				type: "base64",
				media_type: "image/png",
				data: PNG_B64,
			});
		});
	});

	it("keeps inline bytes when Foundry redirects the request", async () => {
		await withEnv(
			{
				...DEFAULT_ANTHROPIC_ENV,
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://resource.services.ai.azure.com/anthropic",
			},
			() => {
				const model = makeAnthropicModel("https://api.anthropic.com");
				expect(supportsRemoteImageUrls(model, { mimeType: "image/png" })).toBe(false);
				expect(serializedImageSource(model)).toEqual({
					type: "base64",
					media_type: "image/png",
					data: PNG_B64,
				});
			},
		);
	});
});
