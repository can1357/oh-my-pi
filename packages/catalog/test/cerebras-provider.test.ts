import { describe, expect, test } from "bun:test";
import { cerebrasModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Cerebras provider discovery", () => {
	test("maps live limits while retaining reference fallbacks", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "gemma-4-31b",
							object: "model",
							context_length: 0,
							max_completion_tokens: "not-a-number",
						},
						{
							id: "llama3.1-8b",
							object: "model",
							context_length: 64_000,
							max_completion_tokens: 16_000,
						},
						{
							id: "cerebras-future",
							object: "model",
							context_length: "262144",
							max_completion_tokens: 65_536,
						},
						{ id: "cerebras-id-only", object: "model" },
						{
							id: "cerebras-invalid-limits",
							object: "model",
							context_length: -1,
							max_completion_tokens: "not-a-number",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = cerebrasModelManagerOptions({ apiKey: "cerebras-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.cerebras.ai/v1/models",
				authorization: "Bearer cerebras-test-key",
			},
		]);
		expect(models?.find(model => model.id === "gemma-4-31b")).toMatchObject({
			provider: "cerebras",
			api: "openai-completions",
			input: ["text", "image"],
			contextWindow: 131_072,
			maxTokens: 40_960,
		});
		expect(models?.find(model => model.id === "llama3.1-8b")).toMatchObject({
			input: ["text"],
			contextWindow: 64_000,
			maxTokens: 16_000,
		});
		expect(models?.find(model => model.id === "cerebras-future")).toMatchObject({
			provider: "cerebras",
			api: "openai-completions",
			contextWindow: 262_144,
			maxTokens: 65_536,
		});
		for (const id of ["cerebras-id-only", "cerebras-invalid-limits"]) {
			expect(models?.find(model => model.id === id)).toMatchObject({
				contextWindow: null,
				maxTokens: null,
			});
		}
	});
});
