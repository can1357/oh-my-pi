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
		expect(url).toBe(`${expectedBaseUrl}/models`);
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
});
