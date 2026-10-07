import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { aiandModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

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
					cached_input_per_1m: "0.080000",
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
				{
					id: "example/video-only",
					context_window: 65536,
					capabilities: ["tool_calling", "video", "document"],
					currency: "usd",
					input_per_1m: "0.100000",
					output_per_1m: "0.200000",
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
		expect(gptOss?.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.08, cacheWrite: 0 });
		expect(gptOss?.input).toEqual(["text"]);

		const gemma = models?.find(model => model.id === "google/gemma-4-31b-it");
		expect(gemma?.reasoning).toBe(false);
		expect(gemma?.thinking).toBeUndefined();
		expect(gemma?.input).toEqual(["text", "image"]);

		// `video`/`document` alone have no ModelSpec modality and must not imply
		// `image`; only `vision` widens the input list.
		const videoOnly = models?.find(model => model.id === "example/video-only");
		expect(videoOnly?.reasoning).toBe(false);
		expect(videoOnly?.input).toEqual(["text"]);
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
					cached_input_per_1m: "50.000000",
				},
			]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("drops ai&'s thinking-off effort and keeps a lone `none` as the minimal wire tier", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			aiandModelsResponse([
				{
					id: "deepseek-ai/deepseek-v4-flash",
					context_window: 1048576,
					capabilities: ["reasoning", "tool_calling"],
					reasoning_efforts: ["none", "high", "max"],
					reasoning_effort_default: "none",
					currency: "usd",
					input_per_1m: "0.150000",
					output_per_1m: "0.250000",
					cached_input_per_1m: "0.080000",
				},
				{
					id: "zai-org/glm-5-off",
					context_window: 1000000,
					capabilities: ["reasoning", "tool_calling"],
					reasoning_efforts: ["none"],
					reasoning_effort_default: "none",
					currency: "usd",
					input_per_1m: "1.000000",
					output_per_1m: "4.000000",
				},
			]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		// `none` is not an Effort level: dropped from the ladder, and it cannot
		// become defaultLevel.
		const flash = models?.find(model => model.id === "deepseek-ai/deepseek-v4-flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(flash?.thinking?.defaultLevel).toBeUndefined();
		expect(flash?.cost.cacheRead).toBe(0.08);

		// The model's whole advertised surface is thinking-off: keep it as the
		// minimal tier bound to the `none` wire value instead of letting the
		// generic ladder be fabricated for it.
		const noneOnly = models?.find(model => model.id === "zai-org/glm-5-off");
		expect(noneOnly?.reasoning).toBe(true);
		expect(noneOnly?.thinking?.efforts).toEqual([Effort.Minimal]);
		expect(noneOnly?.thinking?.effortMap).toEqual({ [Effort.Minimal]: "none" });
		expect(noneOnly?.thinking?.defaultLevel).toBeUndefined();
	});

	test("a none-only discovered ladder does not inherit an out-of-ladder class-rule default", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			aiandModelsResponse([
				{
					id: "zai-org/glm-5.3-flash",
					context_window: 1048550,
					capabilities: ["reasoning", "tool_calling", "vision"],
					reasoning_efforts: ["none"],
					reasoning_effort_default: "none",
					currency: "usd",
					input_per_1m: "0.150000",
					output_per_1m: "0.500000",
					cached_input_per_1m: "0.030000",
				},
			]),
		) as unknown as FetchImpl;

		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		// The glm 5.3-flash class rule grants thinking-default-level "max",
		// but this discovered ladder's only wire value is the `none` off
		// tier. The built model must not carry a default the ladder cannot
		// express — resolveModelPolicy would emit `reasoning_effort: "max"`
		// and the host would reject it with a 400.
		const built = buildModel(models!.find(model => model.id === "zai-org/glm-5.3-flash")!);
		expect(built.thinking?.efforts).toEqual([Effort.Minimal]);
		expect(built.thinking?.effortMap).toEqual({ [Effort.Minimal]: "none" });
		expect(built.thinking?.defaultLevel).toBeUndefined();
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

	test("returns null on a failed ai& discovery so the bundled fallback survives", async () => {
		const failing: FetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as FetchImpl;
		const options = aiandModelManagerOptions({ apiKey: "aiand-key", fetch: failing });
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});
});
