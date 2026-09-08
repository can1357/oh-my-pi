import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Google AI Studio's OpenAI-compatible endpoint
 * (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`)
 * implements a subset of the chat-completions schema and rejects the `store`
 * field with HTTP 400 (`Invalid JSON payload received. Unknown name "store"`).
 * The provider must land in the non-standard set so `supportsStore` resolves
 * false and the wire never carries the field. The native Gemini path
 * (`google-generative-ai` api) is unaffected — it never emits `store`.
 */

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	input: ["text", "image"],
	cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
	maxTokens: 65_536,
	contextWindow: 1_000_000,
	reasoning: true,
};

function aistudioByBaseUrl(provider: string): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		provider,
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
	};
}

describe("openai-completions compat — Google AI Studio openai-compat shim", () => {
	it("disables `store` for the generativelanguage openai-compat host", () => {
		const compat = resolveModelPolicy(aistudioByBaseUrl("gemini")).compat;

		// `isGoogleAistudioOpenAI` participates in the non-standard set, so `store` is off.
		expect(compat.supportsStore).toBe(false);
	});

	it("matches regardless of the custom provider id", () => {
		// users wire the host under arbitrary provider ids (models.yml `gemini`,
		// `google-aistudio`, …); detection is URL-based, not provider-based.
		const compat = resolveModelPolicy(aistudioByBaseUrl("my-custom-gemini")).compat;

		expect(compat.supportsStore).toBe(false);
	});

	it("leaves `store` enabled for standard OpenAI hosts", () => {
		const compat = resolveModelPolicy({
			...baseModel,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		}).compat;

		expect(compat.supportsStore).toBe(true);
	});
});
