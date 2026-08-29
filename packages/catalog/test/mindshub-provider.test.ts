import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts, requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { mindshubModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const originalMindsHubApiKey = Bun.env.MINDSHUB_API_KEY;

afterEach(() => {
	if (originalMindsHubApiKey === undefined) {
		delete Bun.env.MINDSHUB_API_KEY;
	} else {
		Bun.env.MINDSHUB_API_KEY = originalMindsHubApiKey;
	}
	vi.restoreAllMocks();
});

describe("mindshub provider support", () => {
	test("resolves MINDSHUB_API_KEY from environment", () => {
		Bun.env.MINDSHUB_API_KEY = "mindshub-test-key";
		expect(getEnvApiKey("mindshub")).toBe("mindshub-test-key");
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "mindshub");
		expect(descriptor).toBeDefined();
		// `mindshub_air` is covered by a new organization's included/free
		// allowance; paid aliases like `sonnet` can stay disabled until the
		// wallet is funded, so a fresh account's first default request must
		// land on a model it can actually use.
		expect(descriptor?.defaultModel).toBe("mindshub_air");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(descriptor?.catalogDiscovery?.envVars).toContain("MINDSHUB_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.mindshub).toBe("mindshub_air");
	});

	test("registers MindsHub in the OAuth/login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "mindshub");
		expect(provider?.name).toBe("MindsHub");
	});

	test("fetches and normalizes the MindsHub model catalog", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://api.mindshub.ai/v1/models");
			expect(init?.headers).toMatchObject({ Authorization: "Bearer mindshub-test-key" });
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "sonnet",
							label: "Claude Sonnet 5",
							object: "model",
							created: 0,
							enabled: true,
							reasoning_efforts: ["low", "medium", "high", "max"],
							default_reasoning_effort: "high",
							embedding: false,
							supported_params: ["stop_sequences", "max_tokens", "reasoning_effort", "thinking", "tool_choice"],
							provider: "anthropic",
							family: "sonnet",
						},
						{
							id: "kimi",
							label: "Kimi K3",
							object: "model",
							created: 0,
							enabled: true,
							reasoning_efforts: null,
							embedding: false,
							provider: "moonshot",
							family: "kimi",
						},
						{
							id: "mindshub_air",
							label: "MindsHub Air",
							object: "model",
							created: 0,
							enabled: true,
							reasoning_efforts: null,
							embedding: false,
							provider: "mindshub",
							family: "mindshub_air",
						},
						{
							id: "embed-small",
							label: "Text Embedding 3 (small)",
							object: "model",
							created: 0,
							enabled: true,
							embedding: true,
							provider: "openai",
							family: "embed-small",
						},
						{
							id: "retired-model",
							label: "Retired Model",
							object: "model",
							created: 0,
							enabled: false,
							reasoning_efforts: null,
							embedding: false,
							provider: "openai",
							family: "retired-model",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const options = mindshubModelManagerOptions({ apiKey: "mindshub-test-key", fetch: fetchMock });
		expect(options.providerId).toBe("mindshub");

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.mindshub.ai/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		// Embedding-only rows are dropped: they serve `/v1/embeddings`, not chat.
		expect(models?.some(model => model.id === "embed-small")).toBe(false);

		// Org-disabled rows are unavailable for inference even though discovery
		// still lists them, so they must not surface as selectable either.
		expect(models?.some(model => model.id === "retired-model")).toBe(false);

		const sonnet = models?.find(model => model.id === "sonnet");
		expect(sonnet?.api).toBe("openai-completions");
		expect(sonnet?.baseUrl).toBe("https://api.mindshub.ai/v1");
		expect(sonnet?.name).toBe("Claude Sonnet 5");
		expect(sonnet?.reasoning).toBe(true);
		expect(sonnet?.input).toEqual(["text", "image"]);

		// The restricted advertised ladder (no `minimal`/`xhigh`) must survive
		// into an explicit `ThinkingConfig`, not collapse to a boolean and fall
		// through to the generic inferred Anthropic ladder for the `sonnet`
		// alias id.
		if (!sonnet) throw new Error("sonnet model was not resolved");
		const sonnetModel = buildModel(sonnet);
		expect(getSupportedEfforts(sonnetModel)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(sonnetModel.thinking?.defaultLevel).toBe(Effort.High);

		// `reasoning_efforts: null` means the level isn't adjustable, not that
		// the model never reasons (see docs/models.mdx#reasoning-effort). Kimi
		// K3 reasons internally on every request with no tunable dial, so it
		// must still be `reasoning: true` — just without a `thinking` surface —
		// or `model.reasoning`-gated behavior (the model browser, etc.) would
		// treat it as an ordinary chat model.
		const kimi = models?.find(model => model.id === "kimi");
		expect(kimi?.name).toBe("Kimi K3");
		expect(kimi?.reasoning).toBe(true);
		expect(kimi?.thinking).toBeUndefined();

		// The raw mapper output alone doesn't prove runtime behavior:
		// `resolveModelThinking` (invoked by `buildModel`, and transitively by
		// discovery's `normalizeModelList`) treats an absent `thinking` on a
		// `reasoning: true` model as "derive one from identity" unless the
		// model's resolved compat opts out via `trustExplicitThinkingOnly`.
		// Without that opt-out, `kimi`/`mindshub_air` would surface the
		// generic openai-completions minimal..xhigh ladder at runtime despite
		// the mapper's `thinking: undefined` — exactly the gap the prior fix
		// missed. Assert against the *built* model for both fixed-reasoning
		// aliases: still `reasoning: true`, but no selectable effort and no
		// effort the picker/request path could send.
		for (const alias of ["kimi", "mindshub_air"] as const) {
			const spec = models?.find(model => model.id === alias);
			if (!spec) throw new Error(`${alias} model was not resolved`);
			const built = buildModel(spec);
			expect(built.reasoning).toBe(true);
			expect(built.thinking).toBeUndefined();
			expect(getSupportedEfforts(built)).toEqual([]);
			expect(() => requireSupportedEffort(built, Effort.High)).toThrow();
		}
	});

	test("a non-reasoning model with no advertised ladder and no fixed-reasoning family stays reasoning: false", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "gpt-nano",
								label: "GPT 5.4 Nano",
								object: "model",
								created: 0,
								enabled: true,
								reasoning_efforts: null,
								embedding: false,
								provider: "openai",
								family: "gpt-nano",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const options = mindshubModelManagerOptions({ apiKey: "mindshub-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const gptNano = models?.find(model => model.id === "gpt-nano");
		expect(gptNano?.reasoning).toBe(false);
		expect(gptNano?.thinking).toBeUndefined();
	});

	test("filters out models the org has explicitly disabled", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "active-model",
								label: "Active Model",
								object: "model",
								created: 0,
								enabled: true,
								embedding: false,
								provider: "openai",
								family: "active-model",
							},
							{
								id: "disabled-model",
								label: "Disabled Model",
								object: "model",
								created: 0,
								enabled: false,
								embedding: false,
								provider: "openai",
								family: "disabled-model",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const options = mindshubModelManagerOptions({ apiKey: "mindshub-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.some(model => model.id === "active-model")).toBe(true);
		expect(models?.some(model => model.id === "disabled-model")).toBe(false);
	});

	test("discovery omits the Authorization header without an API key", async () => {
		delete Bun.env.MINDSHUB_API_KEY;
		let sentHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentHeaders = init?.headers;
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const options = mindshubModelManagerOptions({ fetch: fetchMock });
		await options.fetchDynamicModels?.();
		expect(sentHeaders).not.toHaveProperty("Authorization");
	});
});
