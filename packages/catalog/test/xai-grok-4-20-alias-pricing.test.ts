import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import type { Api, ModelCost, ModelSpec, Provider, TokenCost } from "../src/types";

// stencil.so reports the retired 4.5-generation card on the grok-4.20
// `-beta-latest` aliases, which api.x.ai serves at the 0309 generation's
// list price ($1.25 input / $0.20 cached / $2.50 output). The class "xai"
// `cost-patch` owns the correction on both xAI surfaces, and its 2x
// long-context multiplier derives the >=200K prompt tier from it (#18404).
const STENCIL_ALIAS_CARD: TokenCost = { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 };
const GROK_4_7_CARD: TokenCost = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
const GENERATION_0309_CARD: TokenCost = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 };

function xaiSpec(provider: Provider, id: string, cost: TokenCost): ModelSpec<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost,
		contextWindow: 2_000_000,
		maxTokens: 2_000_000,
	};
}

/** One request past the 200K tier boundary bills at the doubled card. */
const DOUBLED_TIER: ModelCost["longContext"] = {
	inputThreshold: 200_000,
	inputThresholdInclusive: true,
	input: 2.5,
	output: 5,
	cacheRead: 0.4,
	cacheWrite: 0,
};

function flatCard(cost: ModelCost): TokenCost {
	return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}

describe("xai grok-4.20 alias pricing (regression)", () => {
	const aliases = [
		"grok-4.20-beta-latest-reasoning",
		"grok-4.20-beta-latest-non-reasoning",
		"grok-4.20-multi-agent-beta-latest",
	] as const;

	for (const id of aliases) {
		it(`reprices ${id} at the grok-4.20-0309 generation card`, () => {
			const { cost } = buildModel(xaiSpec("xai", id, STENCIL_ALIAS_CARD));
			expect(flatCard(cost)).toEqual(GENERATION_0309_CARD);
			expect(cost.longContext).toEqual(DOUBLED_TIER);
		});
	}

	it("reprices SuperGrok's peer id for the multi-agent alias the same way", () => {
		// `pricing-peer` copies the paid `grok-4.20-multi-agent-beta-latest` card
		// onto SuperGrok's `grok-4.20-multi-agent-0309`; both surfaces must show
		// the same generation price.
		const { cost } = buildModel(xaiSpec("xai-oauth", "grok-4.20-multi-agent-0309", STENCIL_ALIAS_CARD));
		expect(flatCard(cost)).toEqual(GENERATION_0309_CARD);
		expect(cost.longContext).toEqual(DOUBLED_TIER);
	});

	it("leaves grok-4.7 on its own card", () => {
		for (const provider of ["xai", "xai-oauth"] as const) {
			const { cost } = buildModel(xaiSpec(provider, "grok-4.7", GROK_4_7_CARD));
			expect(flatCard(cost), provider).toEqual(GROK_4_7_CARD);
			expect(cost.longContext, provider).toEqual({ ...DOUBLED_TIER, input: 4, output: 12, cacheRead: 1 });
		}
	});

	it("leaves the grok-4.20-0309 rows already priced at that card untouched", () => {
		for (const id of ["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"] as const) {
			const { cost } = buildModel(xaiSpec("xai", id, GENERATION_0309_CARD));
			expect(flatCard(cost), id).toEqual(GENERATION_0309_CARD);
			expect(cost.longContext, id).toEqual(DOUBLED_TIER);
		}
	});
});
