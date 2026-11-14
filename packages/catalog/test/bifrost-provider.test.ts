import { describe, expect, test } from "bun:test";
import { bifrostModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "http://bifrost.test:8080/v1";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ data, extra_fields: { request_type: "list_models" } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("Bifrost discovery", () => {
	test("maps chat rows to Chat Completions and known decision models to openai-decisions judges", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = bifrostModelManagerOptions({
			apiKey: "sk-bf-test",
			baseUrl: BASE_URL,
			fetch: rosterFetch(
				[
					{
						id: "anthropic/claude-opus-5-5",
						name: "Claude Opus 5.5",
						context_length: 1_000_000,
						max_output_tokens: 128_000,
						architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
						supported_parameters: ["tools", "reasoning"],
						pricing: { prompt: "0.000005", completion: "0.000025" },
					},
					{ id: "openai/gpt-6-luna-decisions" },
					{ id: "custom/drex-max-v1.1" },
					{
						id: "openrouter/google/gemini-decision-1",
						architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
					},
					{ id: "openai/text-embedding-3-large" },
					{ id: "openai/dall-e-3", architecture: { output_modalities: ["image"] } },
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer sk-bf-test" }]);
		expect([...byId.keys()].sort()).toEqual([
			"anthropic/claude-opus-5-5",
			"custom/drex-max-v1.1",
			"openai/gpt-6-luna-decisions",
			"openrouter/google/gemini-decision-1",
		]);
		expect(byId.get("anthropic/claude-opus-5-5")).toMatchObject({
			api: "openai-completions",
			baseUrl: BASE_URL,
			reasoning: true,
			supportsTools: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 5, output: 25 },
		});
		expect(byId.get("anthropic/claude-opus-5-5")?.kind).toBeUndefined();
		for (const id of ["openai/gpt-6-luna-decisions", "custom/drex-max-v1.1", "openrouter/google/gemini-decision-1"]) {
			expect(byId.get(id)).toMatchObject({ api: "openai-decisions", kind: "judge", baseUrl: BASE_URL });
		}
	});

	test("keeps explicit zero pricing and inherits bundled rates only when pricing is absent", async () => {
		const discover = async (row: Record<string, unknown>) => {
			const options = bifrostModelManagerOptions({
				apiKey: "sk-bf-test",
				baseUrl: BASE_URL,
				fetch: rosterFetch([row]),
			});
			const models = (await options.fetchDynamicModels?.()) ?? [];
			return models[0]?.cost;
		};

		expect(await discover({ id: "anthropic/claude-opus-5-5", pricing: { prompt: "0", completion: "0" } })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(await discover({ id: "anthropic/claude-opus-5-5" })).toMatchObject({ input: 4, output: 20 });
	});
});
