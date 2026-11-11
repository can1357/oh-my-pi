import { describe, expect, test } from "bun:test";
import { respanModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MODELS_URL = "https://api.respan.ai/api/v1/models";
const GATEWAY_BASE_URL = "https://gateway.respan.ai/v1";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

// Rows in the shape Respan's public `/models` serves: OpenAI-style ids with
// `context_length` plus a per-1M USD `pricing` block whose units vary by leg.
const GPT_55 = {
	id: "gpt-5.5",
	object: "model",
	owned_by: "openai",
	context_length: 400000,
	pricing: { input_cost: 1.25, output_cost: 10.0, input_price_unit: "token", output_price_unit: "token" },
};
const CLAUDE_OPUS = {
	id: "claude-opus-4.7",
	object: "model",
	owned_by: "anthropic",
	context_length: 200000,
	pricing: { input_cost: 5.0, output_cost: 25.0, input_price_unit: "token", output_price_unit: "token" },
};

describe("Respan discovery", () => {
	test("maps context_length and token-unit pricing, points rows at the gateway, and sends no key", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = respanModelManagerOptions({ fetch: rosterFetch([GPT_55, CLAUDE_OPUS], calls) });
		const models = (await options.fetchDynamicModels?.()) ?? [];

		// The public roster is the whole catalog: fetched keyless, and requests
		// resolve against the gateway even though the fetch host is api.respan.ai.
		expect(calls).toEqual([{ url: `${MODELS_URL}`, authorization: null }]);
		expect(new Set(models.map(model => model.baseUrl))).toEqual(new Set([GATEWAY_BASE_URL]));

		const byId = new Map(models.map(model => [model.id, model]));
		expect(byId.get("gpt-5.5")).toMatchObject({
			contextWindow: 400000,
			cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
		});
		// A bundled reference exists for this dash-spelled sibling family; the
		// dot-spelled id keeps its own context_length from the live row.
		expect(byId.get("claude-opus-4.7")).toMatchObject({
			contextWindow: 200000,
			cost: { input: 5, output: 25 },
		});
	});

	test("prices only token-priced legs and drops rows that cannot answer a chat completion", async () => {
		const options = respanModelManagerOptions({
			fetch: rosterFetch([
				GPT_55,
				// Image-priced generation leg: not a token cost, stays zeroed.
				{
					id: "some-image-model",
					object: "model",
					owned_by: "vendor",
					context_length: 32768,
					pricing: { input_cost: 0.01, output_cost: 0.04, input_price_unit: "token", output_price_unit: "image" },
				},
				// No pricing block at all: zeroed, still a chat model.
				{ id: "unpriced-chat-model", object: "model", owned_by: "vendor", context_length: 8192 },
				// Non-chat families caught by the KDL exclusion patterns.
				{ id: "text-embedding-3-small", object: "model", owned_by: "openai" },
				{ id: "whisper-1", object: "model", owned_by: "openai" },
				{ id: "eleven-v4", object: "model", owned_by: "elevenlabs" },
				{ id: "seedream-5-0-flash", object: "model", owned_by: "bytedance" },
				// Gemini's -image rows stay in: the gateway serves them as chat.
				{ id: "gemini-3-pro-image", object: "model", owned_by: "google_gemini_ai" },
			]),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		const byId = new Map(models.map(model => [model.id, model]));
		// Image-priced output leg keeps the zeroed default; the token-priced
		// input leg applies.
		expect(byId.get("some-image-model")).toMatchObject({ cost: { input: 0.01, output: 0 } });
		expect(byId.get("unpriced-chat-model")).toMatchObject({ cost: { input: 0, output: 0 }, contextWindow: 8192 });
		// Kept + excluded are exactly what the filter decides.
		expect(models.map(model => model.id).sort()).toEqual(
			["gemini-3-pro-image", "gpt-5.5", "some-image-model", "unpriced-chat-model"].sort(),
		);
	});
});
