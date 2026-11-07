import { describe, expect, it } from "bun:test";
import { fetchZedHostedModels } from "../src/discovery/zed-hosted";
import type { FetchImpl } from "../src/types";

describe("zed-hosted discovery", () => {
	it("discovers models and exchanges token when user credentials given", async () => {
		const mockFetch: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.includes("/client/llm_tokens")) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Authorization: "user123 secret_access_token",
				});
				return new Response(JSON.stringify({ token: "exchanged_llm_token" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			expect(url).toBe("https://cloud.zed.dev/models");
			const authHeader = (init?.headers as Record<string, string>)?.Authorization;
			expect(authHeader).toBe("Bearer exchanged_llm_token");
			return new Response(
				JSON.stringify({
					models: [
						{
							id: "claude-opus-4-6",
							display_name: "Claude Opus 4.6",
							provider: "anthropic",
							supports_thinking: true,
							supports_images: true,
							max_token_count: 1000000,
							max_output_tokens: 64000,
						},
						{
							id: "gemini-3-1-pro",
							display_name: "Gemini 3.1 Pro",
							provider: "google",
							supports_thinking: true,
							supports_images: true,
							max_token_count: 200000,
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
			apiKey: "user123:secret_access_token",
			fetch: mockFetch,
		});

		expect(models).not.toBeNull();
		expect(models?.length).toBe(2);

		const opus = models?.find(m => m.id === "claude-opus-4-6");
		expect(opus).toBeDefined();
		expect(opus?.api).toBe("zed-hosted");
		expect(opus?.provider).toBe("zed-hosted");
		expect(opus?.reasoning).toBe(true);
		expect(opus?.input).toEqual(["text", "image"]);
		expect(opus?.contextWindow).toBe(1000000);
		expect(opus?.maxTokens).toBe(64000);
		expect(opus?.cost.input).toBe(5.5);
		expect(opus?.cost.output).toBe(27.5);
		expect(opus?.headers?.["x-provider"]).toBe("anthropic");

		const gemini = models?.find(m => m.id === "gemini-3-1-pro");
		expect(gemini).toBeDefined();
		expect(gemini?.contextWindow).toBe(200000);
		expect(gemini?.cost.input).toBe(2.2);
		expect(gemini?.headers?.["x-provider"]).toBe("google");
	});

	it("returns null on fetch failure", async () => {
		const mockFetch: FetchImpl = async () => new Response("Internal Server Error", { status: 500 });
		const models = await fetchZedHostedModels({ fetch: mockFetch });
		expect(models).toBeNull();
	});
});
