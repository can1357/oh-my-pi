import { afterEach, describe, expect, test, vi } from "bun:test";
import { openllmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_OPENLLM_BASE_URL = Bun.env.OPENLLM_BASE_URL;

function restoreOpenLLMBaseUrl(): void {
	if (ORIGINAL_OPENLLM_BASE_URL === undefined) {
		delete Bun.env.OPENLLM_BASE_URL;
		return;
	}
	Bun.env.OPENLLM_BASE_URL = ORIGINAL_OPENLLM_BASE_URL;
}

function inputUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

const GATEWAY_MODELS = {
	object: "list",
	data: [
		{
			id: "ultra",
			object: "model",
			owned_by: "fallback-chain",
			display_name: "ultra",
			capabilities: ["chat", "tools", "vision", "streaming", "reasoning"],
			context_window: 1_000_000,
			max_output_tokens: 128_000,
		},
		{
			id: "claude_code/claude-haiku-4-5",
			object: "model",
			owned_by: "claude_code",
			display_name: "Claude Haiku 4.5 (sub)",
			capabilities: ["chat", "tools", "vision", "streaming"],
			context_window: 200_000,
			max_output_tokens: 64_000,
		},
		{
			id: "chatgpt/gpt-image-2",
			object: "model",
			owned_by: "chatgpt",
			display_name: "GPT Image 2 (sub)",
			capabilities: ["image_generation"],
		},
	],
} as const;

function makeFetchMock(expectedModelUrl: string): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = inputUrl(input);
		expect(init?.method).toBe("GET");
		expect(init?.headers).toMatchObject({
			Accept: "application/json",
			Authorization: "Bearer sk-llm-test",
		});
		expect(url).toBe(expectedModelUrl);
		return new Response(JSON.stringify(GATEWAY_MODELS), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as FetchImpl;
}

afterEach(() => {
	restoreOpenLLMBaseUrl();
});

describe("openllmModelManagerOptions", () => {
	test("discovers chat models with gateway metadata and skips media models", async () => {
		delete Bun.env.OPENLLM_BASE_URL;
		const fetchMock = makeFetchMock("https://openllm.sh/v1/models");
		const options = openllmModelManagerOptions({ apiKey: "sk-llm-test", fetch: fetchMock });

		expect(options.providerId).toBe("openllm");
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map(models?.map(model => [model.id, model]));

		const ultra = byId.get("ultra");
		expect(ultra).toBeDefined();
		expect(ultra?.reasoning).toBe(true);
		expect(ultra?.input).toEqual(["text", "image"]);
		expect(ultra?.contextWindow).toBe(1_000_000);
		expect(ultra?.maxTokens).toBe(128_000);

		const haiku = byId.get("claude_code/claude-haiku-4-5");
		expect(haiku).toBeDefined();
		expect(haiku?.name).toBe("Claude Haiku 4.5 (sub)");
		expect(haiku?.reasoning).toBe(false);

		// image_generation-only rows are not chat models and must be filtered.
		expect(byId.has("chatgpt/gpt-image-2")).toBe(false);
	});

	test("honors OPENLLM_BASE_URL for local daemon discovery", async () => {
		Bun.env.OPENLLM_BASE_URL = "http://127.0.0.1:8787/v1";
		const fetchMock = makeFetchMock("http://127.0.0.1:8787/v1/models");
		const options = openllmModelManagerOptions({ apiKey: "sk-llm-test", fetch: fetchMock });

		const models = await options.fetchDynamicModels?.();
		expect(models?.some(model => model.id === "ultra")).toBe(true);
	});

	test("scopes the model cache to credential and endpoint", () => {
		delete Bun.env.OPENLLM_BASE_URL;
		const first = openllmModelManagerOptions({ apiKey: "sk-llm-one" }).cacheProviderId;
		const second = openllmModelManagerOptions({ apiKey: "sk-llm-two" }).cacheProviderId;
		const daemon = openllmModelManagerOptions({
			apiKey: "sk-llm-one",
			baseUrl: "http://127.0.0.1:8787/v1",
		}).cacheProviderId;
		expect(first).not.toBe(second);
		expect(first).not.toBe(daemon);
	});
});
