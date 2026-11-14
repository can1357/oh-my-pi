import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { carriesReasoning } from "@oh-my-pi/pi-catalog/compat/reasoning-carry";
import {
	kimiCodeModelManagerOptions,
	modelsDevCatalogFallback,
	moonshotModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

// Live `/models` rows: neither roster carries pricing or an output cap.
const KIMI_CODE_K31_PRO = {
	id: "k3.1-pro",
	display_name: "K3.1 Pro",
	context_length: 1_048_576,
	supports_reasoning: true,
	supports_image_in: true,
	supports_video_in: true,
	supports_thinking_type: "only",
	think_efforts: { support: true, valid_efforts: ["low", "high", "max"], default_effort: "max" },
};
const MOONSHOT_K31_PRO = {
	id: "kimi-k3.1-pro",
	object: "model",
	owned_by: "moonshot",
	context_length: 1_048_576,
	supports_image_in: true,
	supports_reasoning: true,
	supports_thinking_type: "only",
};

// https://platform.kimi.ai/docs/pricing/chat (5m cache-write tier, omp's default).
const K31_PRO_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 };
const K31_PRO_HIGHSPEED_COST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 };

function rosterFetch(data: readonly Record<string, unknown>[]): FetchImpl {
	return async () => Response.json({ object: "list", data });
}

describe("Kimi K3.1 Pro catalog contract", () => {
	it("gives Kimi Code K3.1 rows K3's wire contract, K3.1 list pricing, and K3.1's output cap", async () => {
		const discovered = await kimiCodeModelManagerOptions({
			apiKey: "test-key",
			fetch: rosterFetch([
				KIMI_CODE_K31_PRO,
				{ ...KIMI_CODE_K31_PRO, id: "k3.1-pro-highspeed", display_name: "K3.1 Pro Highspeed" },
			]),
		}).fetchDynamicModels?.();
		const models = new Map((discovered ?? []).map(spec => [spec.id, buildModel(spec)]));

		for (const [id, cost] of [
			["k3.1-pro", K31_PRO_COST],
			["k3.1-pro-highspeed", K31_PRO_HIGHSPEED_COST],
		] as const) {
			expect(models.get(id)).toMatchObject({
				maxTokens: 131_072,
				cost,
				compat: { nativeKimiK3Reasoning: true, clampOutputToModelMax: true },
			});
		}
	});

	it("bills Moonshot K3.1 rows at K3.1 rates, not the K3 list price discovery seeds", async () => {
		const discovered = await moonshotModelManagerOptions({
			apiKey: "test-key",
			fetch: rosterFetch([MOONSHOT_K31_PRO, { ...MOONSHOT_K31_PRO, id: "kimi-k3.1-pro-highspeed" }]),
		}).fetchDynamicModels?.();
		const models = new Map((discovered ?? []).map(spec => [spec.id, buildModel(spec)]));

		expect(models.get("kimi-k3.1-pro")?.cost).toMatchObject(K31_PRO_COST);
		expect(models.get("kimi-k3.1-pro-highspeed")?.cost).toMatchObject(K31_PRO_HIGHSPEED_COST);
	});

	it("caps Moonshot K3.1 rows from the shared catalog at K3's output budget, not the full window", () => {
		const fallback = modelsDevCatalogFallback("moonshot");
		if (!fallback) throw new Error("Moonshot did not configure a shared catalog fallback");
		// The shared catalog lists Moonshot's settable `max_completion_tokens`
		// ceiling (the whole 1M window) as the output limit.
		const catalogRow = {
			reasoning: true,
			tool_call: true,
			modalities: { input: ["text", "image"], output: ["text"] },
			limit: { context: 1_048_576, output: 1_048_576 },
		};
		const specs = fallback.map(
			{
				moonshotai: {
					models: {
						"kimi-k3.1-pro": { ...catalogRow, name: "Kimi K3.1 Pro" },
						"kimi-k3.1-pro-highspeed": { ...catalogRow, name: "Kimi K3.1 Pro Highspeed" },
					},
				},
			},
			"moonshot",
		);
		const models = new Map(specs.map(spec => [spec.id, buildModel(spec)]));

		expect(models.get("kimi-k3.1-pro")?.maxTokens).toBe(131_072);
		expect(models.get("kimi-k3.1-pro-highspeed")?.maxTokens).toBe(131_072);
	});

	it("replays reasoning between K3.1 Pro hosts but never from K3 into K3.1 Pro", () => {
		const kimiCodeK31 = { provider: "kimi-code", api: "openai-completions", id: "k3.1-pro" } as const;

		expect(
			carriesReasoning({ provider: "moonshot", api: "openai-completions", model: "kimi-k3.1-pro" }, kimiCodeK31),
		).toBe(true);
		expect(carriesReasoning({ provider: "moonshot", api: "openai-completions", model: "kimi-k3" }, kimiCodeK31)).toBe(
			false,
		);
	});
});
