import { describe, expect, it } from "bun:test";
import { toClinePassPublicModelId, toClinePassWireModelId } from "@oh-my-pi/pi-catalog/cline-pass-model-id";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import { createReferenceResolver } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { clinePassModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CLINEPASS_MODELS_DEV_FIXTURE = {
	"cline-pass": {
		models: {
			"cline-pass/kimi-k3": {
				id: "cline-pass/kimi-k3",
				name: "Kimi K3",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 1_048_576, output: 131_072 },
				cost: { input: 9, output: 12 },
				reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
			},
			"cline-pass/qwen3.7-max": {
				id: "cline-pass/qwen3.7-max",
				name: "Qwen3.7 Max",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 1_000_000, output: 384_000 },
				cost: { input: 5, output: 10 },
			},
		},
	},
};

const sourceModels = mapModelsDevToModels(CLINEPASS_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
	model => model.provider === "cline-pass",
);

function sourceModel(id: string): ModelSpec<"openai-completions"> {
	const model = sourceModels.find(candidate => candidate.id === id);
	if (model?.api !== "openai-completions") {
		throw new Error(`Missing ClinePass source fixture model: ${id}`);
	}
	return model as ModelSpec<"openai-completions">;
}
describe("ClinePass catalog", () => {
	it("maps source metadata into the subscription catalog contract", () => {
		const model = sourceModel("kimi-k3");
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "cline-pass");

		expect(DEFAULT_MODEL_PER_PROVIDER["cline-pass"]).toBe("kimi-k3");
		expect(descriptor).toMatchObject({
			providerId: "cline-pass",
			dynamicModelsAuthoritative: true,
			catalogDiscovery: {
				label: "ClinePass",
				envVars: ["CLINE_API_KEY"],
				allowUnauthenticated: true,
			},
		});
		expect(descriptor?.allowUnauthenticated).toBeUndefined();
		expect(model).toMatchObject({
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "cline-pass",
			baseUrl: "https://api.cline.bot/api/v1",
			reasoning: true,
			input: ["text", "image"],
			// ClinePass pricing is subscription-specific API-equivalent spend, not
			// the generic models.dev list price supplied by this fixture.
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 1_048_576,
		});
	});

	it("maps Cline's per-model reasoning controls from the curated snapshot", () => {
		const model = sourceModel("kimi-k3");

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.High,
			requiresEffort: false,
		});
	});

	it("bundles the full current roster for offline startup", () => {
		expect(getBundledModels("cline-pass").map(model => model.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-pro",
			"deepseek/deepseek-v4-flash",
			"glm-5.2",
			"glm-5.3",
			"kimi-k2.6",
			"kimi-k2.7-code",
			"kimi-k3",
			"mimo-v2.5",
			"mimo-v2.5-pro",
			"minimax-m3",
			"poolside/laguna-s-2.1:free",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
			"stealth/ox-alpha",
		]);
	});

	it("uses the Cline wire namespace without exposing it in model selection", () => {
		expect(toClinePassPublicModelId("cline-pass/kimi-k3")).toBe("kimi-k3");
		expect(toClinePassPublicModelId("kimi-k3")).toBe("kimi-k3");
		expect(toClinePassWireModelId("kimi-k3")).toBe("cline-pass/kimi-k3");
		expect(toClinePassWireModelId("cline-pass/kimi-k3")).toBe("cline-pass/kimi-k3");
	});

	it("excludes ClinePass metadata from generic bare-id references", () => {
		const reference = createReferenceResolver<"openai-completions">(new Map())("kimi-k3");

		expect(reference?.provider).toBe("fireworks");
		expect(reference?.maxTokens).toBe(131_072);
	});

	it("applies the verified Cline gateway request and reasoning compatibility", () => {
		const model = sourceModel("kimi-k3");
		const compat = buildOpenAICompat(model);

		expect(compat.wireModelIdMode).toBe("cline-pass");
		expect(compat.maxTokensField).toBe("max_completion_tokens");
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.reasoningDisableMode).toBe("cline-enabled-false");
		expect(compat.reasoningEffortMap).toEqual({
			minimal: "low",
			medium: "high",
			xhigh: "max",
			max: "max",
		});
		expect(compat.reasoningContentField).toBe("reasoning");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.supportsStore).toBe(true);
		expect(compat.disableReasoningOnForcedToolChoice).toBe(false);
	});

	it("downgrades forced tools for ClinePass Qwen without requiring reasoning replay", () => {
		const compat = buildOpenAICompat(sourceModel("qwen3.7-max"));

		expect(compat.supportsForcedToolChoice).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning");
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
	});

	it("discovers the authoritative public roster and supports new model IDs", async () => {
		const requests: string[] = [];
		const options = clinePassModelManagerOptions({
			fetch: async input => {
				requests.push(String(input));
				return new Response(
					JSON.stringify({
						clinePass: [
							{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" },
							{ id: " cline-pass/future-model ", name: "cline-pass/future-model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		});

		expect(options.providerId).toBe("cline-pass");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeFunction();

		const models = await options.fetchDynamicModels?.();
		expect(requests).toEqual([
			"https://api.cline.bot/api/v1/ai/cline/recommended-models",
			// The live reference catalog is fetched alongside and tolerated away:
			// this mock returns the roster payload for it, which fails the catalog
			// shape check, so the bundled/fallback path below is what is asserted.
			"https://openrouter.ai/api/v1/models",
		]);
		expect(models?.map(model => model.id)).toEqual(["kimi-k3", "future-model"]);
		expect(models?.[0]?.maxTokens).toBe(1_048_576);
		// A reference-backed subscription id surfaces the upstream list price so the
		// picker does not render it as "free" (issue #5598 policy); exact numbers
		// track upstream catalog data, so assert the contract, not the digits.
		expect(models?.[0]?.cost.input).toBeGreaterThan(0);
		expect(models?.[0]?.cost.output).toBeGreaterThan(0);
		expect(models?.[1]).toMatchObject({
			id: "future-model",
			provider: "cline-pass",
			// No upstream reference yet: the honest zero stays until priced upstream.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: true,
			compat: { supportsReasoningEffort: false },
		});
	});

	it("fills ids the bundle has no upstream reference for from the live catalog", async () => {
		// Mirrors the official client's enrichment: when neither the bundle nor
		// its upstream reference knows a roster id (brand-new model between
		// regens), the live catalog supplies limits and list price instead of the
		// conservative constants.
		const options = clinePassModelManagerOptions({
			fetch: async input =>
				String(input).includes("openrouter")
					? new Response(
							JSON.stringify({
								data: [
									{
										id: "acme/future-model-x",
										name: "Acme: Future Model X",
										context_length: 500_000,
										top_provider: { max_completion_tokens: 64_000 },
										pricing: { prompt: "0.000001", completion: "0.000004" },
										supported_parameters: ["tools", "reasoning"],
										architecture: { modality: "text+image->text" },
									},
								],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						)
					: new Response(
							JSON.stringify({
								clinePass: [
									{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" },
									{ id: "cline-pass/future-model-x", name: "cline-pass/future-model-x" },
								],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["kimi-k3", "future-model-x"]);
		// Slug-matched (lab-less roster id → lab-prefixed catalog id), vendor
		// prefix stripped from the display name.
		expect(models?.[1]).toMatchObject({
			id: "future-model-x",
			name: "Future Model X",
			contextWindow: 500_000,
			maxTokens: 64_000,
			cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
			reasoning: true,
			input: ["text", "image"],
		});
	});

	it("keeps free-tier cost at zero even when the live catalog prices the id", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async input =>
				String(input).includes("openrouter")
					? new Response(
							JSON.stringify({
								data: [
									{
										id: "acme/future-free:free",
										name: "Acme: Future Free",
										context_length: 300_000,
										top_provider: { max_completion_tokens: 32_000 },
										pricing: { prompt: "0.000002", completion: "0.000008" },
									},
								],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						)
					: new Response(
							JSON.stringify({
								clinePass: [{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" }],
								free: [{ id: "acme/future-free:free", name: "future-free:free" }],
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						),
		});

		const models = await options.fetchDynamicModels?.();
		// Full-id match for free entries (the official client's lookup order);
		// limits enrich but the tier's $0 is deliberate, never the catalog price.
		expect(models?.[1]).toMatchObject({
			id: "acme/future-free:free",
			name: "Future Free (free)",
			contextWindow: 300_000,
			maxTokens: 32_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("rejects an empty or malformed authoritative roster so the bundled fallback remains available", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						clinePass: [
							{ id: "cline-pass/" },
							{ id: "cline-pass/   " },
							{ id: "   " },
							{ id: "other-provider/model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		await expect(options.fetchDynamicModels?.()).rejects.toThrow("contains no valid model IDs");
	});

	it("rejects a malformed pass bucket even when free entries are present", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						clinePass: [{ id: "cline-pass/" }, { id: "other-provider/model" }],
						free: [{ id: "deepseek/deepseek-v4-flash", name: "deepseek-v4-flash" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		// Free entries must never substitute for the subscription roster: without
		// bucket independence this payload would prune every bundled pass model.
		await expect(options.fetchDynamicModels?.()).rejects.toThrow("contains no valid model IDs");
	});

	it("surfaces free-tier models with raw wire ids and bundled upstream enrichment", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						clinePass: [{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" }],
						free: [
							{ id: "deepseek/deepseek-v4-flash", name: "deepseek-v4-flash" },
							{ id: "poolside/laguna-s-2.1:free", name: "laguna-s-2.1:free" },
							{ id: "acme/future-model-x:free", name: "future-model-x:free" },
							{ id: "cline-free/nemotron-3.5-lightning", name: "nemotron-3.5-lightning" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual([
			"kimi-k3",
			"deepseek/deepseek-v4-flash",
			"poolside/laguna-s-2.1:free",
			"acme/future-model-x:free",
			"cline-free/nemotron-3.5-lightning",
		]);

		// Bundled upstream limits/modalities flow through the reference — beating
		// the conservative fallback — while identity, pricing, and provider stay
		// ClinePass-local. (Exact limits track the largest bundled variant by
		// design; pinning them would couple this test to unrelated catalog data.)
		const enriched = models?.[1] as ModelSpec<"openai-completions">;
		expect(enriched).toMatchObject({
			id: "deepseek/deepseek-v4-flash",
			provider: "cline-pass",
			name: "DeepSeek V4 Flash (free)",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(enriched.contextWindow).toBeGreaterThan(128_000);
		expect(enriched.maxTokens).toBeGreaterThan(8_192);
		// …but the reference's native-host dialect does not: the gateway keeps the
		// cline-pass `reasoning` field with family-scoped replay (DeepSeek requires
		// it), and the bucket-derived raw tag keeps the id unprefixed on the wire.
		const enrichedCompat = buildOpenAICompat(enriched);
		expect(enrichedCompat.wireModelIdMode).toBe("raw");
		expect(enrichedCompat.reasoningContentField).toBe("reasoning");
		expect(enrichedCompat.requiresReasoningContentForToolCalls).toBe(true);

		// References that already carry a free marker (the bundled Laguna entry is
		// "Laguna S 2.1 (free)") get exactly one tier suffix, never two.
		const laguna = models?.[2] as ModelSpec<"openai-completions">;
		expect(laguna.name.endsWith("(free)")).toBe(true);
		expect(laguna.name).not.toContain("(free) (free)");
		expect(laguna.name).not.toContain(":free");

		// Unknown free ids ride conservative defaults with a slug-derived name and
		// a single tier suffix (`:free` stripped from the slug first).
		expect(models?.[3]).toMatchObject({
			id: "acme/future-model-x:free",
			name: "future-model-x (free)",
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		// The cline-free/ shape Cline's SDK reserves passes through raw as well.
		expect(buildOpenAICompat(models?.[4] as ModelSpec<"openai-completions">).wireModelIdMode).toBe("raw");
	});

	it("skips malformed free entries without touching the pass roster", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						clinePass: [{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" }],
						free: [
							{ id: "   " },
							{ id: "cline-pass/kimi-k3" },
							{ id: "kimi-k3" },
							{ name: "no-id" },
							"not-an-object",
							{ id: "nvidia/nemotron-3.5-lightning", name: "nemotron-3.5-lightning" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["kimi-k3", "nvidia/nemotron-3.5-lightning"]);
		// The pass entry keeps its enriched bundled metadata and cline-pass wire mode.
		expect(models?.[0]?.maxTokens).toBe(1_048_576);
		expect(buildOpenAICompat(models?.[0] as ModelSpec<"openai-completions">).wireModelIdMode).toBe("cline-pass");
	});
});
