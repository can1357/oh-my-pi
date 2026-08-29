import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { calculateCost, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS, DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { applyXaiCatalogPricing, xaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec, Usage } from "@oh-my-pi/pi-catalog/types";

const XAI_RESPONSES_SPEC: ModelSpec<"openai-responses"> = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-responses",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
};
const XAI_COMPLETIONS_SPEC: ModelSpec<"openai-completions"> = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-completions",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
};

describe("paid xai (XAI_API_KEY) Responses contract", () => {
	it("registers xai on the catalog Responses discovery path", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai");
		expect(entry, "xai catalog descriptor").toBeDefined();
		expect(entry!.defaultModel).toBe("grok-4.6");
		expect(DEFAULT_MODEL_PER_PROVIDER.xai).toBe("grok-4.6");
		expect(
			getBundledModels("xai").find(model => model.id === "grok-4.6"),
			"xai/grok-4.6 must be bundled for the default",
		).toBeDefined();
		expect(entry!.envVars).toContain("XAI_API_KEY");
		const options = xaiModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("xai");
		expect(options.fetchDynamicModels, "live /v1/models overlay").toBeTypeOf("function");
		expect(options.dropCachedModelIdsOnStaticMismatch).toEqual(getBundledModels("xai").map(model => model.id));
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("grok-4.6");
	});

	it("bundles every paid xai chat model on openai-responses", () => {
		const models = getBundledModels("xai");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api, `${model.provider}/${model.id}`).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://api.x.ai/v1");
		}
	});

	it("prices public xAI and matching SuperGrok models with the 200K tier", () => {
		const oauthSpec: ModelSpec<"openai-responses"> = {
			...XAI_RESPONSES_SPEC,
			provider: "xai-oauth",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const composerSpec: ModelSpec<"openai-responses"> = {
			...oauthSpec,
			id: "grok-composer-2.5-fast",
			name: "Grok Composer 2.5 Fast",
		};
		const priced = applyXaiCatalogPricing([XAI_RESPONSES_SPEC, oauthSpec, composerSpec]);
		const paid = priced[0];
		const oauth = priced[1];
		const composer = priced[2];
		if (!paid || !oauth || !composer) throw new Error("xAI pricing policy dropped a model");

		expect(paid.cost.longContext).toEqual({
			inputThreshold: 200_000,
			inputThresholdInclusive: true,
			input: 4,
			output: 12,
			cacheRead: 0.6,
			cacheWrite: 0,
		});
		expect(oauth.cost).toEqual(paid.cost);
		expect(composer.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const usage: Usage = {
			input: 100_000,
			output: 1_000,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 201_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(buildModel(oauth), usage);
		expect(usage.cost.input).toBeCloseTo(0.4, 10);
		expect(usage.cost.output).toBeCloseTo(0.012, 10);
		expect(usage.cost.cacheRead).toBeCloseTo(0.06, 10);
	});

	it("bridges the SuperGrok multi-agent alias to its public xAI catalog price", () => {
		// Paid catalog uses `grok-4.20-multi-agent-beta-latest`; SuperGrok exposes
		// the same model as `grok-4.20-multi-agent-0309`, so an exact-ID fallback
		// misses it. The alias bridge must copy the paid price (and its 200K tier).
		const paidSpec: ModelSpec<"openai-responses"> = {
			...XAI_RESPONSES_SPEC,
			id: "grok-4.20-multi-agent-beta-latest",
			name: "Grok 4.20 (Multi-Agent)",
			cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		};
		const oauthSpec: ModelSpec<"openai-responses"> = {
			...paidSpec,
			id: "grok-4.20-multi-agent-0309",
			provider: "xai-oauth",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const [paid, oauth] = applyXaiCatalogPricing([paidSpec, oauthSpec]);
		if (!paid || !oauth) throw new Error("xAI pricing policy dropped a model");

		expect(paid.cost.longContext).toEqual({
			inputThreshold: 200_000,
			inputThresholdInclusive: true,
			input: 4,
			output: 12,
			cacheRead: 0.4,
			cacheWrite: 0,
		});
		expect(oauth.cost).toEqual(paid.cost);
	});

	it("drops stale Chat Completions cache rows so Responses takes effect immediately", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-xai-completions-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			await resolveProviderModels(
				{
					providerId: "xai",
					staticModels: [XAI_COMPLETIONS_SPEC],
					fetchDynamicModels: async () => [XAI_COMPLETIONS_SPEC],
					cacheDbPath: dbPath,
				},
				"online",
			);

			let fetches = 0;
			const migrated = await resolveProviderModels(
				{
					...xaiModelManagerOptions(),
					staticModels: [XAI_RESPONSES_SPEC],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => {
						fetches += 1;
						return [XAI_RESPONSES_SPEC];
					},
				},
				"online-if-uncached",
			);

			expect(fetches).toBe(1);
			expect(migrated.models.find(model => model.id === "grok-4.5")?.api).toBe("openai-responses");

			const offline = await resolveProviderModels(
				{
					...xaiModelManagerOptions(),
					staticModels: [XAI_RESPONSES_SPEC],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => null,
				},
				"offline",
			);
			expect(offline.models.find(model => model.id === "grok-4.5")?.api).toBe("openai-responses");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
