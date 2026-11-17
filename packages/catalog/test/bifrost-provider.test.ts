import { describe, expect, test } from "bun:test";
import { bifrostModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

async function discover(rows: Record<string, unknown>[]) {
	const options = bifrostModelManagerOptions({
		apiKey: "sk-bf-test",
		baseUrl: "http://bifrost.test:8080/v1",
		fetch: async () => Response.json({ data: rows }),
	});
	const models = (await options.fetchDynamicModels?.()) ?? [];
	return new Map(models.map(model => [model.id, model]));
}

describe("Bifrost discovery", () => {
	test("routes decision models to openai-decisions and drops non-chat rows", async () => {
		const models = await discover([
			{
				id: "anthropic/claude-opus-5-5",
				context_length: 1_000_000,
				max_output_tokens: 128_000,
				architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
				supported_parameters: ["tools", "reasoning"],
				pricing: { prompt: "0.000005", completion: "0.000025" },
			},
			// Declared by the row (OpenRouter's decision roster).
			{ id: "openrouter/google/gemini-decision-1", architecture: { output_modalities: ["decisions"] } },
			// The upstream provider's bundled row is a judge.
			{ id: "openai/gpt-6-luna-decisions" },
			// Unknown upstream name: the model part is a bundled judge id.
			{ id: "custom/drex-max-v1.1" },
			// Unknown upstream name: the full id is a bundled judge id.
			{ id: "cloudflare/clef" },
			// The upstream's bundled row is a chat model, although the id is a judge on OpenRouter.
			{ id: "nanogpt/cloudflare/clef" },
			// Declared chat output wins over a bundled judge id.
			{ id: "custom/gpt-6-luna-decisions", architecture: { output_modalities: ["text"] } },
			{ id: "openai/text-embedding-3-large" },
			{ id: "openai/sora-9", architecture: { output_modalities: ["video"] } },
		]);

		expect(Object.fromEntries([...models].map(([id, model]) => [id, model.api]))).toEqual({
			"anthropic/claude-opus-5-5": "openai-completions",
			"openrouter/google/gemini-decision-1": "openai-decisions",
			"openai/gpt-6-luna-decisions": "openai-decisions",
			"custom/drex-max-v1.1": "openai-decisions",
			"cloudflare/clef": "openai-decisions",
			"nanogpt/cloudflare/clef": "openai-completions",
			"custom/gpt-6-luna-decisions": "openai-completions",
		});
		expect(models.get("openai/gpt-6-luna-decisions")?.kind).toBe("judge");
		// A judge matched by its full id also takes its metadata from the bundled reference for that id.
		expect(models.get("cloudflare/clef")?.contextWindow).toBeGreaterThan(0);
		expect(models.get("anthropic/claude-opus-5-5")).toMatchObject({
			reasoning: true,
			supportsTools: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 5, output: 25 },
		});
	});

	test("keeps explicit zero pricing and inherits bundled rates only when pricing is absent", async () => {
		const free = await discover([{ id: "anthropic/claude-opus-5-5", pricing: { prompt: "0", completion: "0" } }]);
		const unpriced = await discover([{ id: "anthropic/claude-opus-5-5" }]);

		expect(free.get("anthropic/claude-opus-5-5")?.cost).toMatchObject({ input: 0, output: 0 });
		expect(unpriced.get("anthropic/claude-opus-5-5")?.cost.input).toBeGreaterThan(0);
	});
});
