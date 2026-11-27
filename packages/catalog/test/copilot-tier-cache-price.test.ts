/**
 * GitHub Copilot `billing.token_prices` tiers carry no cache-write price and often no `cache_price`.
 * An omitted read price used to become $0, so every `-1m` Claude row priced cache reads as free and
 * dollar estimates fell below the server-reported AI credits. An omitted leg carries over from the
 * row the tier derives from, scaled by the tier's input ratio only where the Copilot KDL
 * (`tier-cache-follows-input`) says the rate card scales it. These assert resolved models, after
 * the merge with bundled rows and `buildModel`.
 */
import { describe, expect, it } from "bun:test";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

interface TierPrice {
	max_prompt_tokens: number;
	input_price: number;
	output_price: number;
	cache_price?: number;
}

interface CopilotPricedEntry {
	id: string;
	name: string;
	capabilities: {
		type: "chat";
		limits: { max_context_window_tokens: number; max_prompt_tokens: number; max_output_tokens: number };
		supports: { vision: boolean };
	};
	billing: { token_prices: { default: TierPrice; long_context: TierPrice } };
}

function entry(id: string, defaultTier: TierPrice, longTier: TierPrice): CopilotPricedEntry {
	return {
		id,
		name: id,
		capabilities: {
			type: "chat",
			limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 },
			supports: { vision: true },
		},
		billing: { token_prices: { default: defaultTier, long_context: longTier } },
	};
}

async function resolveCosts(data: CopilotPricedEntry[]) {
	const options = {
		...githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: async () => Response.json({ data }) }),
		cacheDbPath: ":memory:",
	};
	const { models } = await resolveProviderModels(options, "online");
	const costs = new Map(
		models.map(model => {
			const { input, output, cacheRead, cacheWrite } = model.cost;
			return [model.id, { input, output, cacheRead, cacheWrite }];
		}),
	);
	return (id: string) => costs.get(id);
}

describe("Copilot tier cache pricing", () => {
	it("carries omitted cache legs over unscaled when no rule scales them", async () => {
		// The bundled Sonnet 5.5 row prices a cache read at $0.10/MTok and a write at $2.50/MTok.
		const cost = await resolveCosts([
			entry(
				"claude-sonnet-5.5",
				{ max_prompt_tokens: 200_000, input_price: 200, output_price: 1000 },
				{ max_prompt_tokens: 936_000, input_price: 400, output_price: 1500 },
			),
		]);
		expect(cost("claude-sonnet-5.5")).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
		expect(cost("claude-sonnet-5.5-1m")).toEqual({ input: 4, output: 15, cacheRead: 0.1, cacheWrite: 2.5 });
	});

	it("scales omitted long-tier cache legs with input where the rate card does", async () => {
		const cost = await resolveCosts([
			entry(
				"gpt-6-luna",
				{ max_prompt_tokens: 272_000, input_price: 10, output_price: 50 },
				{ max_prompt_tokens: 936_000, input_price: 20, output_price: 75 },
			),
		]);
		expect(cost("gpt-6-luna")).toMatchObject({ cacheRead: 0.01, cacheWrite: 0.125 });
		expect(cost("gpt-6-luna-1m")).toEqual({ input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 });
	});

	it("prices Haiku 5.5's long tier at the rate card's 5x cache legs", async () => {
		const cost = await resolveCosts([
			entry(
				"claude-haiku-5.5",
				{ max_prompt_tokens: 100_000, input_price: 10, output_price: 50 },
				{ max_prompt_tokens: 936_000, input_price: 50, output_price: 250 },
			),
		]);
		expect(cost("claude-haiku-5.5")).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
		expect(cost("claude-haiku-5.5-1m")).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 });
	});

	it("uses a reported long-tier cache_price over the scaled fallback", async () => {
		const cost = await resolveCosts([
			entry(
				"gpt-6-luna",
				{ max_prompt_tokens: 272_000, input_price: 10, output_price: 50, cache_price: 1 },
				{ max_prompt_tokens: 936_000, input_price: 20, output_price: 75, cache_price: 3 },
			),
		]);
		expect(cost("gpt-6-luna")?.cacheRead).toBe(0.01);
		// The scaled fallback would be 0.02.
		expect(cost("gpt-6-luna-1m")?.cacheRead).toBe(0.03);
	});

	it("keeps the other live rows when a long tier's rules cannot resolve", async () => {
		// The rule tree has no reviewed rank for a reference-less Haiku 4.6, so its `-1m` row
		// hits an equal-rank overlap; only that row may drop out.
		const cost = await resolveCosts([
			entry(
				"claude-haiku-4.6",
				{ max_prompt_tokens: 200_000, input_price: 100, output_price: 500 },
				{ max_prompt_tokens: 936_000, input_price: 200, output_price: 1000 },
			),
			entry(
				"gpt-6-luna",
				{ max_prompt_tokens: 272_000, input_price: 13, output_price: 50 },
				{ max_prompt_tokens: 936_000, input_price: 26, output_price: 75 },
			),
		]);
		// Live prices, not the bundled fallback a rejected response would leave.
		expect(cost("gpt-6-luna")?.input).toBe(0.13);
		expect(cost("gpt-6-luna-1m")?.input).toBe(0.26);
		expect(cost("claude-haiku-4.6-1m")).toBeUndefined();
	});
});
