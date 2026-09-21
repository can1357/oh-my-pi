import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { searchOpenRouterGrounded } from "@oh-my-pi/pi-coding-agent/web/search/providers/openrouter";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

function createFixture() {
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("openrouter", "selected-openrouter-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const model = buildModel({
		id: "vendor/selected-grounding-model",
		name: "Selected OpenRouter Grounding",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter-grounding.example.test/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
	return { authStorage, modelRegistry, model };
}

describe("OpenRouter grounded search", () => {
	it("sends the selected catalog model through the web plugin and maps url citations", async () => {
		const fixture = createFixture();
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					id: "or-grounded-response",
					model: "vendor/selected-grounding-model",
					choices: [
						{
							message: {
								content: "The selected model returned a grounded answer.",
								annotations: [
									{
										type: "url_citation",
										url_citation: {
											url: "https://example.com/source",
											title: "Grounded source",
											content: "Evidence returned by the OpenRouter web plugin.",
										},
									},
								],
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		try {
			const result = await searchOpenRouterGrounded({
				query: "ground this answer",
				systemPrompt: "Use web search.",
				numSearchResults: 7,
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				model: fixture.model,
				fetch,
			});

			expect(requestUrl).toBe("https://openrouter-grounding.example.test/api/v1/chat/completions");
			expect(requestHeaders?.get("authorization")).toBe("Bearer selected-openrouter-key");
			expect(requestBody).toEqual({
				model: "vendor/selected-grounding-model",
				plugins: [{ id: "web", max_results: 7 }],
				messages: [{ role: "user", content: "ground this answer" }],
			});
			expect(result.sources).toEqual([
				{
					title: "Grounded source",
					url: "https://example.com/source",
					snippet: "Evidence returned by the OpenRouter web plugin.",
				},
			]);
			expect(result.citations).toEqual([
				{
					title: "Grounded source",
					url: "https://example.com/source",
					citedText: "Evidence returned by the OpenRouter web plugin.",
				},
			]);
		} finally {
			fixture.authStorage.close();
		}
	});

	it("surfaces HTTP failures from the plugin transport", async () => {
		const fixture = createFixture();
		try {
			await expect(
				searchOpenRouterGrounded({
					query: "ground this answer",
					systemPrompt: "Use web search.",
					authStorage: fixture.authStorage,
					modelRegistry: fixture.modelRegistry,
					model: fixture.model,
					fetch: async () => new Response("upstream unavailable", { status: 503 }),
				}),
			).rejects.toMatchObject({ provider: "openrouter", status: 503 });
		} finally {
			fixture.authStorage.close();
		}
	});
});
