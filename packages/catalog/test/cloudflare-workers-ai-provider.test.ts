/** Workers AI discovery: tools filter, capability mapping, pagination, and account-id gating. */
import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { cloudflareWorkersAiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { CLOUDFLARE_WORKERS_AI_BASE_URL } from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const PAGE_ROWS = [
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek: Deepseek V4 Flash",
		input_modalities: ["text"],
		context_length: 1310720,
		max_output_length: 1310720,
		pricing: { prompt: "0.0000004400", completion: "0.0000013200", input_cache_read: "0.0000000140" },
		supported_features: ["structured_outputs", "json_mode", "tools", "reasoning"],
		reasoning: { supported_efforts: ["max", "high", "low", "none"], default_effort: "high", mandatory: false },
	},
	{
		id: "@cf/moonshotai/kimi-k2.7-code",
		name: "MoonshotAI: Kimi K2.7 Code",
		input_modalities: ["text", "image"],
		context_length: 262144,
		max_output_length: 262144,
		pricing: { prompt: "0.0000009500", completion: "0.0000040000", input_cache_read: "0.0000001900" },
		supported_features: ["structured_outputs", "json_mode", "tools", "reasoning"],
		reasoning: { supported_efforts: ["high"], default_effort: "high", mandatory: true },
	},
	{
		// Reasons, no published ladder.
		id: "@cf/openai/gpt-oss-120b",
		name: "OpenAI: Gpt Oss 120B",
		input_modalities: ["text"],
		context_length: 128000,
		max_output_length: 128000,
		pricing: { prompt: "0.0000003500", completion: "0.0000007500" },
		supported_features: ["structured_outputs", "json_mode", "tools", "reasoning"],
	},
	{
		// No `tools`: must be filtered out.
		id: "@cf/meta/llama-guard-3-8b",
		name: "Meta: Llama Guard 3 8B",
		input_modalities: ["text"],
		context_length: 131072,
		max_output_length: 131072,
		pricing: { prompt: "0.0000004840", completion: "0.0000000300" },
		supported_features: [],
	},
];

const DISCOVERY_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function singlePageFetch(): { fetch: FetchImpl; requests: URL[]; authorizations: (string | null)[] } {
	const requests: URL[] = [];
	const authorizations: (string | null)[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new URL(String(input)));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return jsonResponse({ result_info: { total_count: 308 }, data: PAGE_ROWS });
	}) as unknown as FetchImpl;
	return { fetch, requests, authorizations };
}

async function discover(fetch: FetchImpl): Promise<readonly ModelSpec<"openai-completions">[] | null> {
	const options = cloudflareWorkersAiModelManagerOptions({
		apiKey: "wai-test-token",
		baseUrl: DISCOVERY_BASE_URL,
		fetch,
	});
	return (await options.fetchDynamicModels?.()) ?? null;
}

describe("Cloudflare Workers AI models-search discovery", () => {
	test("maps the openrouter projection onto tool-capable specs", async () => {
		const { fetch } = singlePageFetch();
		const models = await discover(fetch);
		expect(models).not.toBeNull();
		const ids = models?.map(model => model.id);
		expect(ids).toEqual([
			"@cf/deepseek-ai/deepseek-v4-flash-0731",
			"@cf/moonshotai/kimi-k2.7-code",
			"@cf/openai/gpt-oss-120b",
		]);

		const deepseek = models?.find(model => model.id === "@cf/deepseek-ai/deepseek-v4-flash-0731");
		expect(deepseek).toBeDefined();
		expect(deepseek?.cost).toEqual({ input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 });
		expect(deepseek?.contextWindow).toBe(1_310_720);
		expect(deepseek?.maxTokens).toBe(32_768);
		expect(deepseek?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.High,
		});
		expect(deepseek?.compat?.reasoningDisableMode).toBe("none-effort");
		expect(deepseek?.baseUrl).toBe(CLOUDFLARE_WORKERS_AI_BASE_URL);
	});

	test("a mandatory reasoner cannot be switched off and keeps its single rung", async () => {
		const { fetch } = singlePageFetch();
		const models = await discover(fetch);
		const kimi = models?.find(model => model.id === "@cf/moonshotai/kimi-k2.7-code");
		expect(kimi).toBeDefined();
		expect(kimi?.thinking?.efforts).toEqual([Effort.High]);
		expect(kimi?.thinking?.requiresEffort).toBe(true);
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.maxTokens).toBe(32_768);
		expect(kimi?.compat?.reasoningDisableMode).toBeUndefined();
	});

	test("a reasoner with no advertised ladder keeps `reasoning: true` and no explicit thinking", async () => {
		const { fetch } = singlePageFetch();
		const models = await discover(fetch);
		const gptOss = models?.find(model => model.id === "@cf/openai/gpt-oss-120b");
		expect(gptOss).toBeDefined();
		expect(gptOss?.reasoning).toBe(true);
		expect(gptOss?.thinking).toBeUndefined();
		expect(gptOss?.cost.cacheRead).toBe(0);
		expect(gptOss?.maxTokens).toBe(32_000);
	});

	test("the seeded output cap leaves room for the prompt on small-context rows", async () => {
		// The cap is always sent, so it must leave room for the prompt.
		const smallRow = (id: string, contextLength: number) => ({
			id,
			name: id,
			input_modalities: ["text"],
			context_length: contextLength,
			max_output_length: contextLength,
			pricing: { prompt: "0.0000001000", completion: "0.0000002000" },
			supported_features: ["tools"],
		});
		const fetch = (async () =>
			jsonResponse({
				result_info: { total_count: 2 },
				data: [
					smallRow("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 24_000),
					smallRow("@cf/qwen/qwen3-30b-a3b-fp8", 32_768),
				],
			})) as unknown as FetchImpl;

		const models = await discover(fetch);
		const byId = new Map(models?.map(model => [model.id, model]));
		const llama = byId.get("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
		expect(llama?.contextWindow).toBe(24_000);
		expect(llama?.maxTokens).toBe(6000);
		const qwen = byId.get("@cf/qwen/qwen3-30b-a3b-fp8");
		expect(qwen?.contextWindow).toBe(32_768);
		expect(qwen?.maxTokens).toBe(8192);
		for (const model of models ?? []) {
			expect(model.maxTokens).toBeLessThan(model.contextWindow ?? 0);
		}
	});

	test("paginates until a short page and sends the documented query", async () => {
		const requestedUrls: URL[] = [];
		const authorizations: (string | null)[] = [];
		const syntheticToolRow = (index: number) => ({
			id: `@cf/synthetic/tool-model-${index}`,
			name: `Synthetic Tool Model ${index}`,
			input_modalities: ["text"],
			context_length: 8192,
			pricing: { prompt: "0.0000001000", completion: "0.0000002000" },
			supported_features: ["tools"],
		});
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			requestedUrls.push(url);
			authorizations.push(new Headers(init?.headers).get("authorization"));
			const page = url.searchParams.get("page");
			if (page === "1") {
				return jsonResponse({
					result_info: { total_count: 308 },
					data: Array.from({ length: 100 }, (_, index) => syntheticToolRow(index)),
				});
			}
			return jsonResponse({ result_info: { total_count: 308 }, data: PAGE_ROWS });
		}) as unknown as FetchImpl;

		const models = await discover(fetch);
		expect(models).not.toBeNull();
		expect(requestedUrls).toHaveLength(2);

		const first = requestedUrls[0];
		expect(first.searchParams.get("task")).toBe("Text Generation");
		expect(first.searchParams.get("format")).toBe("openrouter");
		expect(first.searchParams.get("per_page")).toBe("100");
		expect(first.searchParams.get("page")).toBe("1");

		expect(requestedUrls[1].searchParams.get("page")).toBe("2");
		expect(authorizations).toEqual(["Bearer wai-test-token", "Bearer wai-test-token"]);
	});

	test("keeps the cached roster when a page fails", async () => {
		const fetch = (async () => new Response("server error", { status: 500 })) as unknown as FetchImpl;
		const result = await discover(fetch);
		expect(result).toBeNull();
	});

	test("discovery is withheld until an account id replaces the placeholder", () => {
		expect(cloudflareWorkersAiModelManagerOptions({ apiKey: "wai-test-token" }).fetchDynamicModels).toBeUndefined();
		expect(
			cloudflareWorkersAiModelManagerOptions({
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1",
			}).fetchDynamicModels,
		).toBeUndefined();
		expect(
			typeof cloudflareWorkersAiModelManagerOptions({
				apiKey: "wai-test-token",
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1",
			}).fetchDynamicModels,
		).toBe("function");
	});

	test("the descriptor carries the provider identity and no catalog discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "cloudflare-workers-ai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("@cf/moonshotai/kimi-k2.7-code");
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(descriptor?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("cloudflare-workers-ai");
	});
});
