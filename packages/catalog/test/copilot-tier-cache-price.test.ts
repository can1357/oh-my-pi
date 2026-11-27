/**
 * GitHub Copilot `billing.token_prices` tiers carry no cache-write price and often no `cache_price`.
 * An omitted read price used to become $0, so every `-1m` Claude row priced cache reads as free and
 * dollar estimates fell below the server-reported AI credits. An omitted price is unknown and must
 * inherit from the row the tier derives from; an explicit `0` is a real price. These assert the raw
 * discovery specs: the model manager's merge with bundled rows treats a zero price as unreported.
 */
import { describe, expect, it } from "bun:test";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

interface TierPrice {
	max_prompt_tokens: number;
	input_price: number;
	output_price: number;
	cache_price?: number;
}

function entry(id: string, defaultTier: TierPrice, longTier: TierPrice) {
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

async function discover(data: ReturnType<typeof entry>[]) {
	const options = githubCopilotModelManagerOptions({
		apiKey: "copilot-test-key",
		fetch: async () => Response.json({ data }),
	});
	const specs = (await options.fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, spec.cost]));
}

describe("Copilot tier cache pricing", () => {
	it("inherits the reference cache legs when a tier omits cache_price", async () => {
		// Sonnet 5.5 bills one rate across both tiers; the bundled row prices a read at $0.10/MTok.
		const costs = await discover([
			entry(
				"claude-sonnet-5.5",
				{ max_prompt_tokens: 200_000, input_price: 200, output_price: 1000 },
				{ max_prompt_tokens: 936_000, input_price: 200, output_price: 1000 },
			),
		]);
		expect(costs.get("claude-sonnet-5.5")).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
		expect(costs.get("claude-sonnet-5.5-1m")).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
	});

	it("scales the omitted long-tier cache legs with the tier's input price", async () => {
		const costs = await discover([
			entry(
				"gpt-6-luna",
				{ max_prompt_tokens: 272_000, input_price: 10, output_price: 50 },
				{ max_prompt_tokens: 936_000, input_price: 20, output_price: 75 },
			),
		]);
		// Live billing frames on a >272K prompt: long tier = 2x input, 2x cache read, 2x cache write.
		expect(costs.get("gpt-6-luna")).toMatchObject({ cacheRead: 0.01, cacheWrite: 0.125 });
		expect(costs.get("gpt-6-luna-1m")).toMatchObject({ input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 });
	});

	it("keeps an explicit zero cache_price as a real price", async () => {
		const costs = await discover([
			entry(
				"claude-sonnet-5.5",
				{ max_prompt_tokens: 200_000, input_price: 200, output_price: 1000, cache_price: 0 },
				{ max_prompt_tokens: 936_000, input_price: 200, output_price: 1000, cache_price: 0 },
			),
		]);
		expect(costs.get("claude-sonnet-5.5")?.cacheRead).toBe(0);
		expect(costs.get("claude-sonnet-5.5-1m")?.cacheRead).toBe(0);
	});

	it("uses a reported cache_price over the inherited rate", async () => {
		const costs = await discover([
			entry(
				"claude-sonnet-5.5",
				{ max_prompt_tokens: 200_000, input_price: 200, output_price: 1000, cache_price: 20 },
				{ max_prompt_tokens: 936_000, input_price: 400, output_price: 1500, cache_price: 40 },
			),
		]);
		expect(costs.get("claude-sonnet-5.5")?.cacheRead).toBe(0.2);
		expect(costs.get("claude-sonnet-5.5-1m")?.cacheRead).toBe(0.4);
	});
});
