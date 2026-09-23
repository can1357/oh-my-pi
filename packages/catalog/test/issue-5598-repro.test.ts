import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

// Z.AI GLM coding-plan token costs all showed as "Free" (issue #5598): the `zai`
// provider descriptor sourced the stencil.so `zai-coding-plan` key, which reports
// all-$0 subscription rates. The `zai` (pay-as-you-go) key carries the real
// per-token rates for the identical GLM ids, matching how other subscription
// providers surface comparison pricing in `/models`.
describe("zai GLM pricing sources the PAYG stencil.so key (issue #5598)", () => {
	test("descriptor maps the `zai` stencil.so key, not `zai-coding-plan`", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "zai");
		expect(descriptor).toBeDefined();
		expect(descriptor?.modelsDevKey).toBe("zai");
		expect(descriptor?.api).toBe("anthropic-messages");
		expect(descriptor?.baseUrl).toBe("https://api.z.ai/api/anthropic");
	});

	test("mapped zai models carry the PAYG per-token costs, not the coding-plan $0 rates", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
			"zai-coding-plan": {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
		};

		const zai = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "zai",
		);
		const glm52 = zai.find(model => model.id === "glm-5.2");
		expect(glm52).toBeDefined();
		expect(glm52?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
	});
});

describe("zai API routing", () => {
	test("routes GLM-5.3-Flash through the native API without moving supported Anthropic models", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						tool_call: true,
					},
					"glm-5.3-flash": {
						name: "GLM-5.3-Flash",
						tool_call: true,
					},
				},
			},
		};

		const models = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS);
		const glm52 = models.find(model => model.provider === "zai" && model.id === "glm-5.2");
		const glm53Flash = models.find(model => model.provider === "zai" && model.id === "glm-5.3-flash");

		expect(glm52).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
		});
		expect(glm53Flash).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		});
	});
});
