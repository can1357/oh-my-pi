// OpenRouter BYOK turns run on the account's own provider key: `usage.cost`
// carries only the credits charge OpenRouter bills the turn (its BYOK fee:
// plan-dependent, $0 inside the free allowance) and
// `usage.cost_details.upstream_inference_cost` carries the provider spend. Both
// are real charges, so `applyProviderReportedCost` records their sum; reading
// `cost` alone used to drop the spend (verified live 2026-10-02 on
// openrouter/openai/gpt-6.1-sol: cost=0, is_byok=true, upstream=6.6e-05).
import { describe, expect, it } from "bun:test";
import { applyProviderReportedCost } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Model, Usage } from "@oh-my-pi/pi-ai/types";

const openRouterModel: Pick<Model, "provider"> = { provider: "openrouter" };
const openAiModel: Pick<Model, "provider"> = { provider: "openai" };

/** Local estimate for one gpt-6.1-sol turn (3 in / 382 out / 47326 cache-write). */
function usageEstimate(): Usage {
	return {
		input: 0.000006,
		output: 0.00382,
		cacheRead: 0,
		cacheWrite: 0.118315,
		totalTokens: 47711,
		cost: { input: 0.000006, output: 0.00382, cacheRead: 0, cacheWrite: 0.118315, total: 0.122141 },
	};
}

describe("applyProviderReportedCost (OpenRouter BYOK)", () => {
	it("prices BYOK turns at cost_details.upstream_inference_cost, not $0", () => {
		const usage = usageEstimate();
		applyProviderReportedCost(openRouterModel, usage, {
			cost: 0,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: 0.5,
				upstream_inference_prompt_cost: 0.1,
				upstream_inference_completions_cost: 0.4,
			},
		});
		const scale = 0.5 / 0.122141;
		expect(usage.cost.total).toBe(0.5);
		expect(usage.cost.input).toBeCloseTo(0.000006 * scale, 10);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.118315 * scale, 10);
	});

	it("adds the credits charge on top of the upstream cost", () => {
		const usage = usageEstimate();
		applyProviderReportedCost(openRouterModel, usage, {
			cost: 0.025,
			is_byok: true,
			cost_details: { upstream_inference_cost: 0.5 },
		});
		expect(usage.cost.total).toBe(0.525);
	});

	it("keeps the account charge for non-BYOK turns", () => {
		const usage = usageEstimate();
		applyProviderReportedCost(openRouterModel, usage, { cost: 0.2, is_byok: false });
		expect(usage.cost.total).toBe(0.2);
	});

	it("falls back to cost when a BYOK turn omits cost_details", () => {
		const usage = usageEstimate();
		applyProviderReportedCost(openRouterModel, usage, { cost: 0.02, is_byok: true });
		expect(usage.cost.total).toBe(0.02);
	});

	it("fills component-only usage from the upstream cost when no estimate exists", () => {
		const usage: Usage = {
			input: 3,
			output: 382,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 385,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		applyProviderReportedCost(openRouterModel, usage, {
			cost: 0,
			is_byok: true,
			cost_details: { upstream_inference_cost: 0.5 },
		});
		expect(usage.cost.total).toBe(0.5);
		expect(usage.cost.input).toBe(0.5);
	});

	it("leaves non-gateway providers untouched", () => {
		const usage = usageEstimate();
		applyProviderReportedCost(openAiModel, usage, {
			cost: 0,
			is_byok: true,
			cost_details: { upstream_inference_cost: 0.5 },
		});
		expect(usage.cost.total).toBe(0.122141);
	});
});
