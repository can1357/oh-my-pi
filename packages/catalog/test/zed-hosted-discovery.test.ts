import { describe, expect, it } from "bun:test";
import { fetchZedHostedModels } from "../src/discovery/zed-hosted";
import type { FetchImpl } from "../src/types";

describe("zed-hosted discovery", () => {
	it("discovers models from cloud.zed.dev/models endpoint", async () => {
		const mockFetch: FetchImpl = async input => {
			const url = String(input);
			expect(url).toBe("https://cloud.zed.dev/models");
			return new Response(
				JSON.stringify({
					models: [
						{
							id: "claude-3-7-sonnet",
							display_name: "Claude 3.7 Sonnet",
							provider: "anthropic",
							supports_thinking: true,
							supports_images: true,
							max_token_count: 200000,
							max_output_tokens: 64000,
						},
						{
							id: "gemini-2.5-pro",
							display_name: "Gemini 2.5 Pro",
							provider: "google",
							supports_thinking: true,
							supports_images: true,
							max_token_count: 1000000,
							max_output_tokens: 65536,
						},
						{
							id: "disabled-model",
							is_disabled: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const models = await fetchZedHostedModels({
			apiKey: "mock_llm_token",
			fetch: mockFetch,
		});

		expect(models).not.toBeNull();
		expect(models?.length).toBe(2);

		const sonnet = models?.find(m => m.id === "claude-3-7-sonnet");
		expect(sonnet).toBeDefined();
		expect(sonnet?.api).toBe("zed-hosted");
		expect(sonnet?.provider).toBe("zed-hosted");
		expect(sonnet?.reasoning).toBe(true);
		expect(sonnet?.input).toEqual(["text", "image"]);
		expect(sonnet?.contextWindow).toBe(200000);
		expect(sonnet?.maxTokens).toBe(64000);
		expect(sonnet?.headers?.["x-provider"]).toBe("anthropic");

		const gemini = models?.find(m => m.id === "gemini-2.5-pro");
		expect(gemini).toBeDefined();
		expect(gemini?.contextWindow).toBe(1000000);
		expect(gemini?.headers?.["x-provider"]).toBe("google");
	});

	it("returns null on fetch failure", async () => {
		const mockFetch: FetchImpl = async () => new Response("Internal Server Error", { status: 500 });
		const models = await fetchZedHostedModels({ fetch: mockFetch });
		expect(models).toBeNull();
	});
});
