import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function proxyModel(id: string, api: Api): ModelSpec<Api> {
	return {
		id,
		name: id,
		api,
		provider: "my-proxy",
		baseUrl: "https://proxy.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

describe("hosted web search follows model lineage and transport", () => {
	it.each([
		["gpt-5.6-sol", "openai-responses", "openai"],
		["claude-sonnet-4-5", "anthropic-messages", "anthropic"],
		["gemini-2.5-flash", "google-generative-ai", "gemini"],
	] as const)("grants %s on a custom %s proxy", (id, api, grounding) => {
		expect(buildModel(proxyModel(id, api)).webSearch).toBe(grounding);
	});

	it("declares same-provider swap targets and hosted image on a proxied GPT-5 model", () => {
		const model = buildModel(proxyModel("gpt-5.6-sol", "openai-responses"));
		expect(model).toMatchObject({ webSearchModel: "gpt-5.6-luna", hostedImage: true, imageModel: "gpt-image-2" });
		expect(buildModel(proxyModel("claude-opus-4-5", "anthropic-messages")).webSearchModel).toBe("claude-haiku-4-5");
	});

	it.each([
		["gpt-5.6-sol", "openai-completions"],
		["gpt-4o", "openai-responses"],
		["claude-3-5-haiku", "anthropic-messages"],
	] as const)("withholds it from %s over %s", (id, api) => {
		expect(buildModel(proxyModel(id, api)).webSearch).toBeUndefined();
	});
});
