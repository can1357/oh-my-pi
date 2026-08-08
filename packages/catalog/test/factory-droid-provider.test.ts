import { describe, expect, it } from "bun:test";
import {
	buildFactoryDroidModel,
	FACTORY_DROID_COMPLETIONS_BASE_URL,
	FACTORY_DROID_MODEL_META,
	FACTORY_DROID_MODELS,
	FACTORY_DROID_UPSTREAMS,
	fetchFactoryDroidModels,
} from "../src/discovery/factory-droid";
import { Effort } from "../src/effort";
import { factoryDroidModelManagerOptions } from "../src/provider-models/special";
import type { FetchImpl } from "../src/types";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("Factory Droid catalog", () => {
	it("publishes Kimi K3 with the registry's limits, upstream, and effort ladder", () => {
		const model = buildFactoryDroidModel({
			id: "kimi-k3",
			name: "Kimi K3 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 196_608,
			maxTokens: 65_536,
			apiProviders: ["fireworks", "baseten"],
			supportedReasoningEfforts: ["off", Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
		});

		expect(model).toMatchObject({
			id: "kimi-k3",
			api: "factory-droid-agent",
			provider: "factory-droid",
			baseUrl: FACTORY_DROID_COMPLETIONS_BASE_URL,
			input: ["text", "image"],
			cost: zeroCost,
			contextWindow: 196_608,
			maxTokens: 65_536,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max], defaultLevel: Effort.High },
		});
		// Upstream routing is exported for the provider transport, not baked
		// into headers: the model cache strips persisted headers.
		expect(FACTORY_DROID_UPSTREAMS["kimi-k3"]).toBe("fireworks");
	});

	it("marks text-only models and requires effort when off is unsupported", () => {
		const model = buildFactoryDroidModel({
			id: "text-model",
			name: "Text model",
			wire: "openai-completions",
			contextWindow: 100_000,
			maxTokens: 10_000,
			apiProviders: ["baseten"],
			noImageSupport: true,
			supportedReasoningEfforts: [Effort.High],
			defaultReasoningEffort: Effort.High,
		});

		expect(model.input).toEqual(["text"]);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High],
			requiresEffort: true,
			defaultLevel: Effort.High,
		});
	});

	it("omits thinking config for models without a controllable ladder", () => {
		const model = buildFactoryDroidModel({
			id: "glm-4.6",
			name: "GLM-4.6 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 128_000,
			apiProviders: ["baseten"],
			supportedReasoningEfforts: ["none"],
			defaultReasoningEffort: "none",
			noImageSupport: true,
		});

		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});

	it("ships the static Droid Core registry with an upstream entry per model", () => {
		const manager = factoryDroidModelManagerOptions();
		expect(manager.providerId).toBe("factory-droid");
		const models = manager.staticModels ?? [];
		expect(models.map(model => model.id)).toEqual(FACTORY_DROID_MODELS.map(model => model.id));
		expect(models.length).toBeGreaterThanOrEqual(50);
		for (const model of models) {
			expect(model.baseUrl).toBe(FACTORY_DROID_COMPLETIONS_BASE_URL);
			expect(FACTORY_DROID_UPSTREAMS[model.id]).toBe(FACTORY_DROID_MODEL_META[model.id].apiProviders[0]);
		}
		expect(models.find(model => model.id === "kimi-k3")).toBeDefined();
	});

	it("filters the static registry by feature flags and org model policy", async () => {
		const flags = Object.fromEntries(
			FACTORY_DROID_MODELS.flatMap(m => (m.featureFlag ? [[m.featureFlag, true]] : [])),
		);
		flags["kimi_k3"] = false; // account gate off -> kimi-k3 hidden
		const fetchImpl: FetchImpl = async url => {
			if (String(url).includes("feature-flags")) {
				return new Response(JSON.stringify({ flags }), { status: 200 });
			}
			return new Response(
				JSON.stringify({
					settings: { modelPolicy: { allowAllFactoryModels: false, allowedModelIds: ["kimi-k2.6"] } },
				}),
				{ status: 200 },
			);
		};
		const models = await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl });
		expect(models?.map(model => model.id)).toEqual(["kimi-k2.6"]);
	});

	it("falls back to null without credentials so the static list stays", async () => {
		const fetchImpl: FetchImpl = async () => {
			throw new Error("network down");
		};
		expect(await fetchFactoryDroidModels({ apiKey: "token", fetch: fetchImpl })).toBeNull();
	});
});
