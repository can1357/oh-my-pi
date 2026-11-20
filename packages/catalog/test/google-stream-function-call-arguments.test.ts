import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

function googleSpec(
	id: string,
	api: "google-vertex" | "google-generative-ai",
	provider: string,
	compat?: ModelSpec<"google-vertex" | "google-generative-ai">["compat"],
): ModelSpec<"google-vertex" | "google-generative-ai"> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl:
			api === "google-vertex"
				? "https://aiplatform.googleapis.com"
				: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		...(compat !== undefined && { compat }),
	};
}

describe("Google stream-function-call-arguments compat policy", () => {
	it("enables streamFunctionCallArguments for Vertex Gemini 3+ except 3.1 Flash-Lite, and leaves Gemini 2.x and public Gemini API unset", () => {
		expect(
			resolveModelPolicy(googleSpec("gemini-3.1-pro-preview", "google-vertex", "google-vertex")).compat
				.streamFunctionCallArguments,
		).toBe(true);
		expect(
			resolveModelPolicy(googleSpec("gemini-3.5-flash-lite", "google-vertex", "google-vertex")).compat
				.streamFunctionCallArguments,
		).toBe(true);
		expect(
			resolveModelPolicy(googleSpec("gemini-4-argon", "google-vertex", "google-vertex")).compat
				.streamFunctionCallArguments,
		).toBe(true);
		expect(
			resolveModelPolicy(googleSpec("gemini-3.1-flash-lite", "google-vertex", "google-vertex")).compat
				.streamFunctionCallArguments,
		).toBe(false);
		expect(
			resolveModelPolicy(googleSpec("gemini-2.5-pro", "google-vertex", "google-vertex")).compat
				.streamFunctionCallArguments,
		).toBeUndefined();
		expect(
			resolveModelPolicy(googleSpec("gemini-3.1-pro-preview", "google-generative-ai", "google")).compat
				.streamFunctionCallArguments,
		).toBeUndefined();
	});

	it("allows explicit models.yml compat opt-in on custom google-generative-ai and opt-out on google-vertex", () => {
		expect(
			resolveModelPolicy(
				googleSpec("gemini-4-neon", "google-generative-ai", "custom-vertex-proxy", {
					streamFunctionCallArguments: true,
				}),
			).compat.streamFunctionCallArguments,
		).toBe(true);
		expect(
			resolveModelPolicy(
				googleSpec("gemini-4-argon", "google-vertex", "google-vertex", {
					streamFunctionCallArguments: false,
				}),
			).compat.streamFunctionCallArguments,
		).toBe(false);
	});
});
