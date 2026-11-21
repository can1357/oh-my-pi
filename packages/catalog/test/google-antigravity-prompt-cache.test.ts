import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";

function antigravityModel(id: string) {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	});
}

describe("google-antigravity prompt-cache lifetimes", () => {
	test("Claude gets Vertex Anthropic's five-minute cache lifetime, so the cache warmer can arm", () => {
		expect(antigravityModel("claude-opus-5-5").promptCache).toEqual({ short: 300 });
	});

	test("Gemini declares no lifetime: its implicit cache has none to warm against", () => {
		expect(antigravityModel("gemini-4-argon").promptCache).toBeUndefined();
	});
});
