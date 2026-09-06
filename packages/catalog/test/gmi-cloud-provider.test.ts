import { describe, expect, test } from "bun:test";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	GMI_CLOUD_STATIC_MODELS,
	gmiCloudModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("GMI Cloud provider", () => {
	test("static seed covers the descriptor's default model", () => {
		// Regression for the empty-slice bug: without this seed a regen run
		// without a GMI_API_KEY bundles no gmi-cloud models, and the declared
		// defaultModel is unresolvable at boot before async discovery fires.
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "gmi-cloud");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
			envVars: ["GMI_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(GMI_CLOUD_STATIC_MODELS.map(model => model.id)).toContain("deepseek-ai/DeepSeek-V4-Flash");
	});

	// GMI's `/v1/models` returns only bare `{id}` rows, so discovery defaults
	// carry no limits/reasoning/thinking. The mapper must recover intrinsic
	// capability metadata for resold open-weight models from the cross-provider
	// canonical index while never inheriting another provider's pricing.
	test("dynamic discovery recovers canonical params without borrowing pricing", async () => {
		// Self-select a bundled reasoning model with a thinking ladder that GMI
		// does not seed — the very shape that regressed to null params — instead
		// of hardcoding a churning model id.
		const index = getBundledModelReferenceIndex();
		const resold = [...index.exact.values()].find(model => {
			if (model.provider === "gmi-cloud" || !model.id.includes("/")) return false;
			if (GMI_CLOUD_STATIC_MODELS.some(seed => seed.id === model.id)) return false;
			const ref = resolveModelReference(model.id, index);
			return ref?.reasoning === true && ref.thinking?.mode === "effort" && (ref.contextWindow ?? 0) > 0;
		});
		if (!resold) {
			throw new Error("no bundled resold reasoning model available to exercise canonical recovery");
		}

		const discoveredIds = [resold.id, "gmi-only/nonexistent-model"];
		const fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: discoveredIds.map(id => ({ id, object: "model", created: 0, owned_by: "public" })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;

		const options = gmiCloudModelManagerOptions({ apiKey: "test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		// Resold model recovers intrinsic capabilities from the canonical index...
		const recovered = byId.get(resold.id);
		const canonical = resolveModelReference(resold.id, index);
		expect(recovered?.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered?.reasoning).toBe(true);
		expect(recovered?.thinking?.mode).toBe("effort");
		// ...but pricing is never borrowed across providers.
		expect(recovered?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		// An id absent from every bundle stays bare rather than fabricating params.
		const unknown = byId.get("gmi-only/nonexistent-model");
		expect(unknown?.contextWindow).toBeNull();
		expect(unknown?.reasoning).toBe(false);
	});
});
