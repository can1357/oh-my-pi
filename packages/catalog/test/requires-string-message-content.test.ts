import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import type { ModelSpec } from "../src/types";

function openAICompletionsSpec(compat?: ModelSpec<"openai-completions">["compat"]): ModelSpec<"openai-completions"> {
	return {
		id: "requires-string-message-content-probe",
		name: "Probe",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	};
}

describe("compat.requiresStringMessageContent resolution", () => {
	test("defaults to false for a generic openai-completions provider", () => {
		const model = buildModel(openAICompletionsSpec());
		expect(model.compat.requiresStringMessageContent).toBe(false);
	});

	test("resolves true when the spec's compat override sets it", () => {
		const model = buildModel(openAICompletionsSpec({ requiresStringMessageContent: true }));
		expect(model.compat.requiresStringMessageContent).toBe(true);
	});
});
