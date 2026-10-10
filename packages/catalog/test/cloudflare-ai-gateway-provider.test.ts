import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry, seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models";
import { apiServesKind } from "@oh-my-pi/pi-catalog/types";
import {
	CLOUDFLARE_AI_GATEWAY_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { bundledSeedRows } from "../scripts/generate-models";

describe("Cloudflare AI Gateway shared catalog", () => {
	test("mirrors active Workers AI chat models into the gateway provider", () => {
		const fallback = modelsDevCatalogFallback("cloudflare-ai-gateway");
		if (!fallback) throw new Error("Cloudflare AI Gateway did not configure a shared catalog fallback");

		const models = fallback.map(
			{
				"cloudflare-workers-ai": {
					models: {
						"@cf/zai-org/glm-5.3-flash": {
							name: "GLM 5.3 Flash",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
						},
						"@cf/example/deprecated": {
							name: "Deprecated",
							tool_call: true,
							status: "deprecated",
						},
						"@cf/example/no-tools": {
							name: "No tools",
							tool_call: false,
						},
					},
				},
			},
			"cloudflare-ai-gateway",
		);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			provider: "cloudflare-ai-gateway",
			id: "workers-ai/@cf/zai-org/glm-5.3-flash",
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
		});
	});
});

describe("Cloudflare AI Gateway Clef judge models", () => {
	const EXPECTED = {
		"workers-ai/@cf/cloudflare/clef": 0.24,
		"workers-ai/@cf/cloudflare/clef-flash": 0.09,
	} as const;

	test("seeds Clef and Clef Flash as judge rows on the System One transport, not the Workers AI chat route", () => {
		for (const [id, input] of Object.entries(EXPECTED)) {
			const spec = seedModels("cloudflare-ai-gateway").find(seed => seed.id === id);
			if (!spec) throw new Error(`missing cloudflare-ai-gateway seed ${id}`);
			const model = buildModel(spec);
			expect(model).toMatchObject({
				api: "cloudflare-systemone",
				kind: "judge",
				baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
				input: ["text", "image"],
				contextWindow: 65_536,
				supportsTools: false,
				cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			expect(apiServesKind(model.api, "judge")).toBe(true);
		}
	});

	test("bundles Clef on every regeneration but the Sonnet fallback only when discovery produced no rows", () => {
		const entry = providerEntry("cloudflare-ai-gateway");
		if (!entry) throw new Error("missing cloudflare-ai-gateway catalog entry");
		const discovered = seedModels("cloudflare-ai-gateway")
			.filter(spec => spec.id.startsWith("workers-ai/"))
			.map(spec => ({ ...spec, id: "workers-ai/@cf/zai-org/glm-5.3-flash" }));

		expect(bundledSeedRows(entry, discovered, new Set()).map(row => row.id)).toEqual(Object.keys(EXPECTED));
		expect(bundledSeedRows(entry, [], new Set()).map(row => row.id)).toEqual([
			"claude-sonnet-4-5",
			...Object.keys(EXPECTED),
		]);
	});
});
