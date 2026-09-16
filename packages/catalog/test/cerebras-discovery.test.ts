/**
 * Live endpoint contract for the Cerebras SKU `qwen-3.8-27b` (added to the
 * endpoint 2026-09) — the only bundled cerebras model with an effort dial.
 *
 * Cerebras `/v1/models` is a bare id listing: no reasoning flag, no limits,
 * no pricing. `createBundledReferenceMap` sources that metadata from
 * `models.json`, so the discovered spec must inherit the bundled reference's
 * `reasoning` and low/medium/high `thinking` surface, while ids without a
 * reference stay on the generic discovery defaults. Verified through the real
 * manager/discovery path plus `buildModel`.
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
		const request = { url: "", authorization: null as string | null };
		const fetchMock = (async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
			request.url = input instanceof Request ? input.url : String(input);
			request.authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ data: LIVE_ENDPOINT_MODELS }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const options = cerebrasModelManagerOptions({ apiKey: "cerebras-test-key", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		return { request, specs };
	};

	test("hits the endpoint and inherits the reasoning dial only from the bundled reference", async () => {
		const { request, specs } = await runDiscovery();

		expect(request.url).toBe(CEREBRAS_MODELS_URL);
		expect(request.authorization).toBe("Bearer cerebras-test-key");
		expect(specs).toHaveLength(3);

		const sku = specs?.find(spec => spec.id === "qwen-3.8-27b");
		expect(sku).toBeDefined();
		expect(sku?.reasoning).toBe(true);
		expect(sku?.input).toEqual(["text", "image"]);
		// The listing carries no limits; the bundled reference fills them.
		expect(sku?.contextWindow).toBe(65_536);
		expect(sku?.maxTokens).toBe(32_768);

		// An unreferenced id stays on the generic discovery defaults.
		const sibling = specs?.find(spec => spec.id === "live-only-model");
		expect(sibling?.reasoning).toBe(false);
		expect(sibling?.thinking).toBeUndefined();
	});

	test("buildModel exposes the low/medium/high effort dial for the SKU", async () => {
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
