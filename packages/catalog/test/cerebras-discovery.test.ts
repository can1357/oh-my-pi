/**
 * Live endpoint contract for the new 2026-09 Cerebras SKU `qwen-3.8-27b`,
 * which predates its bundled catalog entry.
 *
 * `createBundledReferenceMap` is sourced only from `models.json`, so without
 * a reference the generic discovery default would ship the discovered model
 * with `reasoning: false` and no thinking surface. The cerebras mapper flags
 * exactly this id so `buildModel` bakes the low/medium/high effort dial from
 * the `model-thinking.ts` deriver — verified here through the real
 * manager/discovery path against the unchanged bundled catalog.
 */
import { describe, expect, test } from "bun:test";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { cerebrasModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";

const CEREBRAS_MODELS_URL = "https://api.cerebras.ai/v1/models";

const LIVE_ENDPOINT_MODELS = [
	{ id: "gpt-oss-120b", name: "GPT-OSS 120B", object: "model", owned_by: "cerebras" },
	{ id: "live-only-model", name: "live-only-model", object: "model", owned_by: "cerebras" },
	{ id: "qwen-3.8-27b", name: "qwen-3.8-27b", object: "model", owned_by: "cerebras" },
];

describe("cerebras /v1/models discovery", () => {
	const runDiscovery = async () => {
		let requestedUrl = "";
		const fetchMock = (async (input: string | Request | URL): Promise<Response> => {
			requestedUrl = input instanceof Request ? input.url : String(input);
			return new Response(JSON.stringify({ data: LIVE_ENDPOINT_MODELS }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const options = cerebrasModelManagerOptions({ apiKey: "cerebras-test-key", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		return { requestedUrl, specs };
	};

	test("hits the endpoint and flags only the unreferenced reasoning SKU", async () => {
		const { requestedUrl, specs } = await runDiscovery();

		expect(requestedUrl).toBe(CEREBRAS_MODELS_URL);
		expect(specs).toHaveLength(3);

		const sku = specs?.find(spec => spec.id === "qwen-3.8-27b");
		expect(sku).toBeDefined();
		expect(sku?.reasoning).toBe(true);

		// A still-unreferenced sibling id stays on the generic defaults.
		const sibling = specs?.find(spec => spec.id === "live-only-model");
		expect(sibling?.reasoning).toBe(false);
	});

	test("buildModel bakes the low/medium/high effort dial for the SKU", async () => {
		const { specs } = await runDiscovery();
		const sku = specs?.find(spec => spec.id === "qwen-3.8-27b");
		if (!sku) throw new Error("expected qwen-3.8-27b in the discovered catalog");

		const model = buildModel(sku);
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
	});
});
