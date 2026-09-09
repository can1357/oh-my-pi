import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { aiandModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ENV = {
	AIAND_API_KEY: Bun.env.AIAND_API_KEY,
	AIAND_BASE_URL: Bun.env.AIAND_BASE_URL,
} as const;

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	restoreEnvVar("AIAND_API_KEY");
	restoreEnvVar("AIAND_BASE_URL");
	vi.restoreAllMocks();
});

/** One entry in ai&'s documented `/v1/models` OpenAI-surface response shape. */
function aiandModelsResponse(entries: Record<string, unknown>[]): Response {
	return new Response(JSON.stringify({ object: "list", data: entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("ai& provider support", () => {
	test("resolves the AIAND_API_KEY environment fallback", () => {
		Bun.env.AIAND_API_KEY = "aiand-test-key";
		expect(getEnvApiKey("aiand")).toBe("aiand-test-key");
	});

	test("registers descriptor, default model, bundled seed, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "aiand");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("moonshotai/kimi-k2.7-code");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.aiand).toBe("moonshotai/kimi-k2.7-code");

		const bundled = getBundledModels("aiand");
		const defaultModel = bundled.find(model => model.id === "moonshotai/kimi-k2.7-code");
		expect(defaultModel).toBeDefined();
		for (const model of bundled) {
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe("https://api.aiand.com/v1");
		}

		const provider = getOAuthProviders().find(item => item.id === "aiand");
		expect(provider?.name).toBe("ai&");
	});

	test("maps ai& /v1/models metadata: context, capabilities, efforts, and USD pricing", async () => {
		delete Bun.env.AIAND_BASE_URL;
		const fetchMock: FetchImpl = vi.fn(async () =>
			aiandModelsResponse([
				{
					id: "openai/gpt-oss-120b",
					name: "openai/gpt-oss-120b",
					description: "OpenAI GPT OSS 120B",
					context_window: 131072,
					capabilities: ["reasoning", "tool_calling"],
					reasoning_efforts: ["low", "medium", "high"],
					reasoning_effort_default: "medium",
					currency: "usd",
					input_per_1m: "0.150000",
					output_per_1m: "0.600000",
				},
				{
					id: "google/gemma-4-31b-it",
					name: "google/gemma-4-31b-it",
					context_window: 262144,
					capabilities: ["tool_calling", "vision", "video", "document"],
					reasoning_efforts: null,
					currency: "usd",
					input_per_1m: "0.200000",
					output_per_1m: "0.500000",
				},
			]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: fetchMock });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.aiand.com/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer aiand-key" }),
			}),
		);

		const gptOss = models?.find(model => model.id === "openai/gpt-oss-120b");
		expect(gptOss?.name).toBe("OpenAI GPT OSS 120B");
		expect(gptOss?.reasoning).toBe(true);
		expect(gptOss?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(gptOss?.thinking?.defaultLevel).toBe(Effort.Medium);
		expect(gptOss?.contextWindow).toBe(131072);
		expect(gptOss?.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 });
		expect(gptOss?.input).toEqual(["text"]);

		const gemma = models?.find(model => model.id === "google/gemma-4-31b-it");
		expect(gemma?.reasoning).toBe(false);
		expect(gemma?.thinking).toBeUndefined();
		expect(gemma?.input).toEqual(["text", "image"]);
	});

	test("ignores non-USD pricing so JPY orgs do not corrupt USD cost accounting", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			aiandModelsResponse([
				{
					id: "zai-org/glm-5.2",
					context_window: 1000000,
					capabilities: ["reasoning", "tool_calling"],
					currency: "jpy",
					input_per_1m: "150.000000",
					output_per_1m: "600.000000",
				},
			]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("prefers explicit base URL over AIAND_BASE_URL and appends /v1", async () => {
		Bun.env.AIAND_BASE_URL = "https://env.aiand.test";
		const fetchMock: FetchImpl = vi.fn(async () =>
			aiandModelsResponse([{ id: "openai/gpt-oss-120b" }]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({
			apiKey: "aiand-key",
			baseUrl: "https://config.aiand.test/",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://config.aiand.test/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});
});
