import { describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	ABLITERATION_STATIC_MODELS,
	abliterationModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

function seed(id: string): Model<"openai-responses"> {
	const spec = ABLITERATION_STATIC_MODELS.find(model => model.id === id);
	if (!spec) throw new Error(`missing abliteration seed ${id}`);
	return buildModel(spec);
}

describe("Abliteration provider support", () => {
	test("registers descriptor, default model, and bundled abliterated models", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "abliteration");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("abliterated-model");
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.abliteration).toBe("abliterated-model");

		const bundled = getBundledModels("abliteration");
		expect(bundled.map(model => model.id).sort()).toEqual([
			"abliterated-model",
			"abliterated-model-large",
			"abliterated-model-large-v2",
		]);

		// Documented limits and USD pricing with 10% cache-read billing
		// (docs.abliteration.ai/models, /pricing).
		const base = bundled.find(model => model.id === "abliterated-model")!;
		expect(base.api).toBe("openai-responses");
		expect(base.input).toEqual(["text", "image"]);
		expect(base.contextWindow).toBe(262_144);
		expect(base.maxTokens).toBe(262_134);
		expect(base.cost).toEqual({ input: 3, output: 3, cacheRead: 0.3, cacheWrite: 0 });

		const large = bundled.find(model => model.id === "abliterated-model-large")!;
		expect(large.input).toEqual(["text"]);
		expect(large.contextWindow).toBe(1_000_000);
		expect(large.maxTokens).toBe(999_990);
		expect(large.cost).toEqual({ input: 5, output: 5, cacheRead: 0.5, cacheWrite: 0 });
	});

	test("derives the documented reasoning surface from the GLM lineage rules", () => {
		// The gateway never returns encrypted reasoning items and streams long
		// reasoning turns without keepalives.
		for (const model of ABLITERATION_STATIC_MODELS.map(spec => buildModel(spec))) {
			expect(model.reasoning).toBe(true);
			expect(model.compat.includeEncryptedReasoning).toBe(false);
			expect(model.compat.streamIdleTimeoutMs).toBe(0);
		}

		// Base honors distinct depths; Responses rejects `max` there.
		const base = seed("abliterated-model");
		expect(base.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(base.thinking?.requiresEffort).toBeUndefined();

		// Large V2 (GLM-5.3) runs low/high/max, defaults to max and cannot
		// disable reasoning.
		const largeV2 = seed("abliterated-model-large-v2");
		expect(largeV2.thinking?.defaultLevel).toBe(Effort.Max);
		expect(largeV2.thinking?.requiresEffort).toBe(true);

		// Large (GLM-5.2) runs high/max and defaults to high.
		const large = seed("abliterated-model-large");
		expect(large.thinking?.defaultLevel).toBe(Effort.High);
		expect(large.thinking?.requiresEffort).toBeUndefined();
	});

	test("keeps documented effort aliases selectable and maps them to the native mode on the wire", () => {
		// docs.abliteration.ai/capabilities/thinking: Large V2 maps medium/high
		// → high and xhigh/max → max; Large maps minimal..high → high and
		// xhigh/max → max. A ladder of only the native modes would clamp
		// `medium` down to `low` and `xhigh` down to `high` before the request
		// is built, so the aliases stay selectable and the wire map sends the
		// mode the gateway documents for them.
		const largeV2 = seed("abliterated-model-large-v2");
		expect(clampThinkingLevelForModel(largeV2, Effort.Medium)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(largeV2, Effort.XHigh)).toBe(Effort.XHigh);
		expect(clampThinkingLevelForModel(largeV2, Effort.Minimal)).toBe(Effort.Low);
		expect(largeV2.compat.reasoningEffortMap).toEqual({ medium: "high", xhigh: "max" });

		const large = seed("abliterated-model-large");
		expect(clampThinkingLevelForModel(large, Effort.XHigh)).toBe(Effort.XHigh);
		expect(clampThinkingLevelForModel(large, Effort.Medium)).toBe(Effort.High);
		expect(large.compat.reasoningEffortMap).toEqual({ xhigh: "max" });
	});

	test("discovers models from the Abliteration Models API with normalized base URL", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "abliterated-model" }, { id: "abliterated-model-next" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const options = abliterationModelManagerOptions({
			apiKey: "ak_test",
			baseUrl: "https://gateway.abliteration.test",
			fetch: fetchMock,
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://gateway.abliteration.test/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer ak_test" }),
			}),
		);
		expect(models?.map(model => model.id).sort()).toEqual(["abliterated-model", "abliterated-model-next"]);

		// Discovered rows for documented ids keep their bundled surface; an
		// unseeded id still reasons and inherits the provider wire quirks and
		// the generic Responses ladder once built.
		const discoveredBase = models?.find(model => model.id === "abliterated-model");
		expect(discoveredBase?.thinking?.efforts).toContain(Effort.XHigh);
		const discoveredNext = buildModel(models!.find(model => model.id === "abliterated-model-next")!);
		expect(discoveredNext.reasoning).toBe(true);
		expect(discoveredNext.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(discoveredNext.compat.includeEncryptedReasoning).toBe(false);
		expect(discoveredNext.compat.streamIdleTimeoutMs).toBe(0);
	});

	test("falls back to bundled seed when discovery fails without a key", () => {
		const options = abliterationModelManagerOptions({ fetch: async () => new Response(null, { status: 503 }) });
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});
});
