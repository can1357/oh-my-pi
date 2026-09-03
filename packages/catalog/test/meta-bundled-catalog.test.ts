import { describe, expect, it } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import modelsJson from "../src/models.json";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";

describe("meta bundled catalog", () => {
	it("descriptors pin the default model, env keys, and factory identity", () => {
		const meta = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "meta");
		const catalogEntry = CATALOG_PROVIDERS.find(entry => entry.id === "meta");

		expect(meta?.defaultModel).toBe("muse-spark-1.3");
		expect(DEFAULT_MODEL_PER_PROVIDER.meta).toBe("muse-spark-1.3");
		expect(meta?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("meta");
		// First-party documented name (META_API_KEY) first, supported aliases second.
		expect(catalogEntry?.envVars).toEqual(["META_API_KEY", "MODEL_API_KEY", "META_MODEL_API_KEY"]);
	});

	it("bundles the Meta Model API muse models on the api.meta.ai base URL", () => {
		const models = modelsJson.meta;

		expect(Object.keys(models).sort()).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
			"muse-spark-1.3",
			"muse-spark-1.3-contributor",
		]);
		for (const model of Object.values(models)) {
			expect(model.provider).toBe("meta");
			expect(model.baseUrl).toBe("https://api.meta.ai/v1");
		}
		expect(models["muse-spark-1.2"].reasoning).toBe(true);
	});
});
