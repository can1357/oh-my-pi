import { describe, expect, test } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import {
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
	type Context,
	type ServiceTier,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { DOUBLEWORD_BASE_URL, doublewordModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function doublewordSpec(overrides: Partial<ModelSpec<"openai-responses">> = {}): ModelSpec<"openai-responses"> {
	return {
		id: "deepseek-ai/DeepSeek-V4-Flash",
		name: "DeepSeek V4 Flash",
		api: "openai-responses",
		provider: "doubleword",
		baseUrl: DOUBLEWORD_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

describe("Doubleword provider", () => {
	test("omits discovery without a key", () => {
		expect(doublewordModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("opts the Responses surface into flex by default so /fast can still request priority", () => {
		const spec = doublewordSpec();
		const compat = resolveModelPolicy(spec).compat;
		expect(compat.supportsServiceTier).toBe(true);
		expect(compat.defaultServiceTier).toBe("flex");

		const model = buildModel(spec);
		expect(model.serviceTierCost).toEqual({ priority: 1 });
		expect(serviceTierFamily(model)).toBe("openai");
		expect(resolveModelServiceTier(undefined, model)).toBe("flex");
		expect(resolveModelServiceTier({ openai: "priority" }, model)).toBe("priority");
		expect(resolveModelServiceTier({ openai: "none" }, model)).toBe("none");
		expect(shouldSendServiceTier("flex", model)).toBe(true);
		expect(shouldSendServiceTier("priority", model)).toBe(true);
		expect(shouldSendServiceTier("none", model)).toBe(false);
	});

	test("emits the resolved service_tier on the Responses wire, and none omits it", async () => {
		const model = buildModel(doublewordSpec());
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const capture = (serviceTier?: ServiceTier | "none") => {
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			void streamSimple(model, context, {
				apiKey: "sk-dw-test",
				signal: AbortSignal.abort(),
				serviceTier,
				onPayload: payload => resolve(payload as Record<string, unknown>),
			});
			return promise;
		};
		expect((await capture()).service_tier).toBe("flex");
		expect((await capture("priority")).service_tier).toBe("priority");
		expect("service_tier" in (await capture("none"))).toBe(false);
	});

	test("does not send service_tier for the same weights on an un-opted-in host", () => {
		const model = buildModel(doublewordSpec({ provider: "custom-relay" }));
		expect(model.compat.supportsServiceTier).toBeUndefined();
		expect(serviceTierFamily(model)).toBeUndefined();
		expect(shouldSendServiceTier("flex", model)).toBe(false);
	});

	test("dynamic discovery recovers canonical params, drops non-chat SKUs, and never borrows pricing or thinking", async () => {
		const index = getBundledModelReferenceIndex();
		const resold = [...index.exact.values()].find(model => {
			if (model.provider === "doubleword" || !model.id.includes("/")) return false;
			const ref = resolveModelReference(model.id, index);
			return ref?.reasoning === true && ref.thinking !== undefined && (ref.contextWindow ?? 0) > 0;
		});
		if (!resold) {
			throw new Error("no bundled resold reasoning model available to exercise canonical recovery");
		}

		const discoveredIds = [
			resold.id,
			"Qwen/Qwen3-Embedding-8B",
			"allenai/olmOCR-2-7B-1025-FP8",
			"deepseek-ai/DeepSeek-OCR-2",
			"doubleword-only/nonexistent-model",
		];
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: discoveredIds.map(id => ({ id, object: "model", created: 0, owned_by: "None" })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = doublewordModelManagerOptions({ apiKey: "test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));

		expect(byId.has("Qwen/Qwen3-Embedding-8B")).toBe(false);
		expect(byId.has("allenai/olmOCR-2-7B-1025-FP8")).toBe(false);
		expect(byId.has("deepseek-ai/DeepSeek-OCR-2")).toBe(false);

		const recovered = byId.get(resold.id);
		const canonical = resolveModelReference(resold.id, index);
		expect(recovered?.api).toBe("openai-responses");
		expect(recovered?.provider).toBe("doubleword");
		expect(recovered?.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered?.reasoning).toBe(true);
		expect(recovered?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// The canonical reference belongs to another host: its thinking ladder
		// (effort vocabulary, wire routing) must not leak onto the Doubleword row.
		expect(canonical?.thinking).toBeDefined();
		expect(recovered?.thinking).toBeUndefined();

		const unknown = byId.get("doubleword-only/nonexistent-model");
		expect(unknown?.contextWindow).toBeNull();
		expect(unknown?.reasoning).toBe(false);
	});
});
