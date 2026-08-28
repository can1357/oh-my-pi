import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptor-types";
import {
	CATALOG_PROVIDERS,
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	arkaneCloudModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MODELS_URL = "https://console.arkanecloud.com/api/v2/models";

/**
 * Fixture mirroring the documented `GET /api/v2/models` surface (Arkane Cloud
 * API 1.0.1). The `type: "text"` rows carry the live production catalog's own
 * metadata: per-million token prices, the context window, the recommended
 * output cap (already split to leave room for input), input modalities,
 * capability flags, and a `reasoning` block that is omitted entirely for models
 * that do not reason. The `type: "image"` row is synthetic — production
 * currently publishes text rows only — and is built from the documented image
 * shape purely to prove such rows are dropped.
 */
function arkaneCloudModelsPayload(): unknown {
	return {
		object: "list",
		data: [
			{
				id: "deepseek-ai/DeepSeek-V4-Flash",
				object: "model",
				created: 1_766_534_400,
				owned_by: "arkanecloud",
				name: "DeepSeek-V4-Flash",
				description: "DeepSeek MoE model",
				type: "text",
				pricing: { input: 0.2, output: 0.4, cache_read: 0.05, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "deepseek-ai/DeepSeek-V4-Flash",
				context_length: 1_048_576,
				max_input_tokens: 655_360,
				max_output_tokens: 393_216,
				input_modalities: ["text"],
				reasoning: { can_disable: true, enabled_by_default: true, supported_efforts: ["high", "xhigh"] },
				capabilities: { tool_calling: true, image_input: false },
			},
			{
				id: "moonshotai/Kimi-K2.5",
				object: "model",
				created: 1_769_487_076,
				owned_by: "arkanecloud",
				name: "KIMI-K2.5",
				description: "Moonshot AI multimodal mixture-of-experts model",
				type: "text",
				pricing: { input: 0.6, output: 3, cache_read: 0.2, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "moonshotai/Kimi-K2.5",
				context_length: 262_144,
				max_input_tokens: 131_072,
				max_output_tokens: 131_072,
				input_modalities: ["text", "image"],
				// Reasons by default and can be switched off, but exposes no effort dial.
				reasoning: { can_disable: true, enabled_by_default: true, supported_efforts: [] },
				capabilities: { tool_calling: true, image_input: true },
			},
			{
				id: "meta-llama/Llama-3.3-70B-Instruct",
				object: "model",
				created: 1_728_400_000,
				owned_by: "arkanecloud",
				name: "Llama 3.3 70B Instruct",
				description: "Large language model from Meta",
				type: "text",
				pricing: { input: 0.7, output: 0.7, cache_read: 0.2, unit: "per million tokens" },
				endpoint: "/api/v2/chat/completions",
				huggingface_id: "meta-llama/Llama-3.3-70B-Instruct",
				context_length: 128_000,
				max_input_tokens: 64_000,
				max_output_tokens: 64_000,
				input_modalities: ["text"],
				// No `reasoning` key at all — the documented shape for a non-reasoning model.
				capabilities: { tool_calling: false, image_input: false },
			},
			{
				// `type: "image"` rows are served by /api/v2/images/generations, not the
				// chat endpoint, and are priced per image rather than per token.
				id: "black-forest-labs/flux-dev",
				object: "model",
				created: 1_728_400_000,
				owned_by: "arkanecloud",
				name: "FLUX.1 dev",
				description: "Image generation model",
				type: "image",
				pricing: { image: 0.01, unit: "per image" },
				endpoint: "/api/v2/images/generations",
				huggingface_id: "black-forest-labs/flux-dev",
				context_length: 0,
				max_input_tokens: 0,
				max_output_tokens: 0,
				input_modalities: ["text"],
				capabilities: { tool_calling: false, image_input: false },
			},
		],
	};
}

function arkaneCloudModelsFetch(payload: unknown = arkaneCloudModelsPayload()): {
	calls: string[];
	authorizations: (string | null)[];
	fetch: FetchImpl;
} {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

describe("ArkaneCloud catalog registration", () => {
	test("is a runtime discovery descriptor with the documented default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(entry => entry.providerId === "arkanecloud");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Flash");
		expect(DEFAULT_MODEL_PER_PROVIDER.arkanecloud).toBe("deepseek-ai/DeepSeek-V4-Flash");
		expect(descriptor?.createModelManagerOptions({ apiKey: "ak_test" }).providerId).toBe("arkanecloud");
		// Live discovery is the only source of ArkaneCloud models, so it must prune
		// anything a previous snapshot cached.
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		// `/api/v2/models` needs credentials, so the provider stays out of keyless
		// catalog generation entirely (nothing is bundled in models.json).
		expect(descriptor?.catalogDiscovery).toBeUndefined();
		expect(descriptor?.allowUnauthenticated).toBeUndefined();
	});

	test("ships no bundled catalog — the model list is discovered live", () => {
		// Source of truth: the catalog table owns generator participation via
		// `catalogDiscovery`, so assert against it rather than the descriptors
		// derived from it or the generated models.json type.
		const entry: ProviderCatalogEntry | undefined = CATALOG_PROVIDERS.find(item => item.id === "arkanecloud");
		expect(entry).toBeDefined();
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(entry?.catalogDiscovery).toBeUndefined();
		// No stencil.so mapping may feed the generator either, or `gen:models`
		// would start bundling a slice that live discovery then has to prune.
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "arkanecloud")).toBe(false);
	});
});

describe("ArkaneCloud provider discovery", () => {
	test("bearer-authenticates GET /api/v2/models and maps the published metadata", async () => {
		const { calls, authorizations, fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual([MODELS_URL]);
		expect(authorizations).toEqual(["Bearer ak_test"]);

		const flash = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash).toMatchObject({
			name: "DeepSeek-V4-Flash",
			provider: "arkanecloud",
			api: "openai-completions",
			baseUrl: "https://console.arkanecloud.com/api/v2",
			reasoning: true,
			input: ["text"],
			// Prices are published per million tokens — omp's ModelCost unit.
			cost: { input: 0.2, output: 0.4, cacheRead: 0.05, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 393_216,
		});
		// `tool_calling: true` is the upstream default, so nothing is stamped.
		expect(flash?.supportsTools).toBeUndefined();
		// `can_disable: true` maps to the `reasoning: { enabled: false }` switch
		// ArkaneCloud documents; the thinking-engaged variant keeps intensity on the
		// top-level `reasoning_effort` field instead of inheriting that shape.
		expect(flash?.compat?.reasoningDisableMode).toBe("openrouter-enabled-false");
		expect(flash?.compat?.whenThinking?.reasoningDisableMode).toBe("lowest-effort");
		expect(flash?.thinking).toEqual({ mode: "effort", efforts: [Effort.High, Effort.XHigh] });
	});

	test("keeps a reasoning model without an effort dial reasoning-capable and ladder-free", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		const kimi = models?.find(model => model.id === "moonshotai/Kimi-K2.5");
		expect(kimi?.reasoning).toBe(true);
		// ThinkingConfig.efforts is never empty, so an empty supported_efforts list
		// means "no controllable surface", not "no efforts". This asserts the
		// discovery spec only: `buildModel` may still derive a canonical ladder
		// from model identity, which the wire-level tests in
		// packages/ai/test/arkanecloud-login.test.ts cover.
		expect(kimi?.thinking).toBeUndefined();
		expect(kimi?.input).toEqual(["text", "image"]);
	});

	test("maps an absent reasoning block and an explicit tool-calling opt-out", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		const llama = models?.find(model => model.id === "meta-llama/Llama-3.3-70B-Instruct");
		expect(llama?.reasoning).toBe(false);
		expect(llama?.thinking).toBeUndefined();
		// Only an explicit `false` is a real signal; it must reach the model spec.
		expect(llama?.supportsTools).toBe(false);
		expect(llama?.contextWindow).toBe(128_000);
		expect(llama?.maxTokens).toBe(64_000);
	});

	test("leaves mandatory-reasoning models on the effort-clamping default", async () => {
		// `can_disable: false` withholds the disable switch — there is nothing to
		// switch off — and surfaces as `requiresEffort` instead, which clamps a
		// thinking-off request to the lowest effort the model does accept.
		const payload = arkaneCloudModelsPayload() as { data: Array<Record<string, unknown>> };
		payload.data[0].reasoning = { can_disable: false, enabled_by_default: true, supported_efforts: ["high"] };
		const { fetch } = arkaneCloudModelsFetch(payload);
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		const flash = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash?.compat?.reasoningDisableMode).toBeUndefined();
		expect(flash?.thinking).toEqual({ mode: "effort", efforts: [Effort.High], requiresEffort: true });
	});

	test("drops image-generation rows, which are not served by chat completions", async () => {
		const { fetch } = arkaneCloudModelsFetch();
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(models?.map(model => model.id)).toEqual([
			"deepseek-ai/DeepSeek-V4-Flash",
			"meta-llama/Llama-3.3-70B-Instruct",
			"moonshotai/Kimi-K2.5",
		]);
	});

	test("normalizes the effort ladder to least → most intensive and honors can_disable: false", async () => {
		const { fetch } = arkaneCloudModelsFetch({
			object: "list",
			data: [
				{
					id: "arkane/mandatory-reasoner",
					object: "model",
					name: "Mandatory Reasoner",
					type: "text",
					pricing: { input: 1, output: 2, cache_read: 0.1, unit: "per million tokens" },
					context_length: 200_000,
					max_output_tokens: 100_000,
					input_modalities: ["text"],
					// Wire order is not guaranteed, and `none` is the thinking-off value
					// rather than a selectable level.
					reasoning: { can_disable: false, enabled_by_default: true, supported_efforts: ["max", "none", "low"] },
					capabilities: { tool_calling: true, image_input: false },
				},
			],
		});
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_test", fetch }).fetchDynamicModels?.();

		expect(models?.[0]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Max],
			requiresEffort: true,
		});
	});

	test("honors a configured baseUrl override", async () => {
		const { calls, fetch } = arkaneCloudModelsFetch();
		await arkaneCloudModelManagerOptions({
			apiKey: "ak_test",
			baseUrl: "https://preprod.arkanecloud.com/api/v2/",
			fetch,
		}).fetchDynamicModels?.();

		expect(calls).toEqual(["https://preprod.arkanecloud.com/api/v2/models"]);
	});

	test("returns null when /api/v2/models rejects the key", async () => {
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { code: "unauthorized", message: "..." } }), { status: 401 });
		const models = await arkaneCloudModelManagerOptions({ apiKey: "ak_bogus", fetch }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});

	test("serves no dynamic models without an API key", () => {
		expect(arkaneCloudModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
