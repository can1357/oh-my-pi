import { describe, expect, it } from "bun:test";
import { buildRequest } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function createModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "gemini",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

describe("issue #976 — legacy string systemPrompt", () => {
	it("accepts a single string systemPrompt without crashing request building", () => {
		const context = {
			systemPrompt: "Stay concise.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		} as unknown as Context;

		const request = buildRequest(createModel(), context, "proj-123");

		expect(request.request.systemInstruction).toEqual({
			parts: [{ text: "Stay concise." }],
		});
	});
});
