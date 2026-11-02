import { describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { nanoGptModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

async function discoverNanoGptModels(
	payload: unknown,
	apiKey = "nanogpt-test-key",
	expectedBaseUrl = "https://nano-gpt.com/api/v1",
) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		expect(url).toBe(`${expectedBaseUrl}/models?detailed=true`);
		expect(init?.method).toBe("GET");
		expect(init?.headers).toEqual({
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		});
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	const options = nanoGptModelManagerOptions({ apiKey, baseUrl: expectedBaseUrl, fetch: fetchMock });
	expect(options.fetchDynamicModels).toBeDefined();
	const models = await options.fetchDynamicModels?.();
	expect(models).not.toBeNull();
	return { models: models ?? [], fetchMock };
}

describe("nanogpt model limits mapping", () => {
	it("prefers OpenAI bundled metadata over Copilot metadata for gpt-5.4-mini", async () => {
		const { models, fetchMock } = await discoverNanoGptModels({
			data: [
				{
					id: "gpt-5.4-mini",
					name: "GPT-5.4 mini",
					context_length: 400_000,
					max_completion_tokens: 128_000,
				},
			],
		});

		const model = models.find(candidate => candidate.id === "gpt-5.4-mini");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.provider).toBe("nanogpt");
		expect(model?.reasoning).toBe(true);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.cost).toEqual({ input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 });
		expect(model?.premiumMultiplier).toBeUndefined();
		expect(model?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("prices rows from the detailed roster, cache legs per thousand tokens, over the bundled reference", async () => {
		const { models } = await discoverNanoGptModels({
			data: [
				{
					id: "google/gemini-4-argon",
					pricing: {
						prompt: 2,
						completion: 10,
						cacheReadInputPer1kTokens: 0.0001,
						cacheWriteInputPer1kTokens: 0.0001875,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
				{
					// Bundled at $0.75/$4.50; the live card wins, and the cache-read
					// leg it omits keeps the reference rate.
					id: "gpt-5.4-mini",
					pricing: { prompt: 0.8, completion: 4.8, currency: "USD", unit: "per_million_tokens" },
				},
			],
		});

		const argon = models.find(candidate => candidate.id === "google/gemini-4-argon");
		expect(argon?.cost.input).toBe(2);
		expect(argon?.cost.output).toBe(10);
		expect(argon?.cost.cacheRead).toBeCloseTo(0.1, 10);
		expect(argon?.cost.cacheWrite).toBeCloseTo(0.1875, 10);
		expect(models.find(candidate => candidate.id === "gpt-5.4-mini")?.cost).toEqual({
			input: 0.8,
			output: 4.8,
			cacheRead: 0.075,
			cacheWrite: 0,
		});
	});

	it("takes names and limits from the detailed roster, over the bundled reference", async () => {
		const { models } = await discoverNanoGptModels({
			data: [
				// Not bundled: the live name and limits are all there is.
				{
					id: "nimbz/gemma-4-giftige-blume-31b-v2",
					name: "Gemma 4 Giftige-Blume V2 31B",
					context_length: 65_536,
					max_output_tokens: 8_192,
				},
				// Bundled: live limits replace the reference's.
				{ id: "gpt-5.4-mini", name: "GPT-5.4 mini", context_length: 300_000, max_output_tokens: 64_000 },
			],
		});

		const unbundled = models.find(candidate => candidate.id === "nimbz/gemma-4-giftige-blume-31b-v2");
		expect(unbundled).toMatchObject({
			name: "Gemma 4 Giftige-Blume V2 31B",
			contextWindow: 65_536,
			maxTokens: 8_192,
		});
		expect(models.find(candidate => candidate.id === "gpt-5.4-mini")).toMatchObject({
			contextWindow: 300_000,
			maxTokens: 64_000,
		});
	});
});
