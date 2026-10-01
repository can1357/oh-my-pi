import { describe, expect, test } from "bun:test";
import { kenariModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const DISCOVERY_URL = "https://kenari.id/v1/models";

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

function catalogFixture(): Response {
	return Response.json({
		data: [
			priced,
			{ id: "kenari/auto", tool_call: true, context_length: 128_000, pricing: { varies: true } },
			{ id: "embed-only", tool_call: false, context_length: 8_000 },
			{ id: "no-window", tool_call: true, reasoning: false },
			{ id: "agnes-2-0-flash:free", tool_call: true, reasoning: false, context_length: 32_000 },
		],
	});
}

describe("Kenari built-in provider", () => {
	test("keeps tool-capable chat models and drops rupiah prices", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({ url: String(input), authorization: headers.get("Authorization") });
			return catalogFixture();
		};

		const options = kenariModelManagerOptions({ fetch: fetchMock, apiKey: "kn-secret" });
		const models = await options.fetchDynamicModels?.();

		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(requests).toEqual([{ url: DISCOVERY_URL, authorization: null }]);
		expect(models?.map(item => item.id)).toEqual(["agnes-2-0-flash:free", "claude-sonnet-5-5", "no-window"]);

		const sonnet = models?.find(item => item.id === "claude-sonnet-5-5");
		expect(sonnet).toMatchObject({
			provider: "kenari",
			api: "openai-completions",
			baseUrl: "https://kenari.id/v1",
			name: "Sonnet",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models?.find(item => item.id === "no-window")).toMatchObject({
			reasoning: false,
			contextWindow: null,
			maxTokens: null,
		});
	});

	test("returns null when the list body is not a model catalog", async () => {
		const fetchMock = async (): Promise<Response> => Response.json({ data: "nope" });
		const models = await kenariModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});
});
