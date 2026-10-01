import { describe, expect, test } from "bun:test";
import {
	KENARI_BASE_URL,
	kenariModelManagerOptions,
	kenariModelsFromPayload,
} from "@oh-my-pi/pi-catalog/provider-models/kenari";

const priced = {
	id: "claude-sonnet-5-5",
	name: "Sonnet",
	tool_call: true,
	reasoning: true,
	context_length: 1_000_000,
	modalities: { input: ["text", "image", "pdf"] },
	pricing: {
		input: 15_000_000_000,
		output: 75_000_000_000,
		cache_read: 1_500_000_000,
		cache_write: 18_750_000_000,
		currency: "IDR",
		unit: "micro_idr_per_1m_tokens",
	},
};

describe("Kenari built-in provider", () => {
	test("keeps tool-capable chat models and drops rupiah prices", () => {
		const models = kenariModelsFromPayload({
			data: [
				priced,
				{ id: "kenari/auto", tool_call: true, context_length: 128_000, pricing: { varies: true } },
				{ id: "embed-only", tool_call: false, context_length: 8_000 },
				{ id: "no-window", tool_call: true },
				{ id: "agnes-2-0-flash:free", tool_call: true, reasoning: false, context_length: 32_000 },
			],
		});

		expect(models?.map(item => item.id)).toEqual(["agnes-2-0-flash:free", "claude-sonnet-5-5"]);
		expect(models?.[1]).toMatchObject({
			provider: "kenari",
			api: "openai-completions",
			baseUrl: KENARI_BASE_URL,
			name: "Sonnet",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("returns null for a body that is not a model list", () => {
		expect(kenariModelsFromPayload({ models: [] })).toBeNull();
	});

	test("discovers the public list without sending a key", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), authorization: headers.get("Authorization") });
			return Response.json({ data: [priced] });
		};

		const options = kenariModelManagerOptions({ fetch: fetchMock, apiKey: "kn-secret" });
		const models = await options.fetchDynamicModels?.();

		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(requests).toEqual([{ url: `${KENARI_BASE_URL}/models`, authorization: null }]);
		expect(models?.map(item => item.id)).toEqual(["claude-sonnet-5-5"]);
		expect(models?.[0]?.cost.input).toBe(0);
	});
});
