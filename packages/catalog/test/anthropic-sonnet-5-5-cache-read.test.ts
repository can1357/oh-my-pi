import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Anthropic cut Sonnet 5.5 cache reads to $0.10/MTok, 0.05x its $2 input, on
// 2026-10-07; Sonnet 5 keeps the 0.1x $0.20 rate.
//   https://platform.claude.com/docs/en/about-claude/pricing
//
// Upstream catalogs still serve the pre-cut $0.20, so `classes/anthropic.kdl`
// owns the first-party price with a revision-scoped `cost-patch`.

// Synthetic specs carrying the stale upstream rate, so a passing assertion can
// only come from the rule (AGENTS.md: test the rule, not the generated JSON).
function spec(id: string, provider = "anthropic"): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

describe("anthropic Sonnet 5.5 cache-read rule", () => {
	test("first-party Sonnet 5.5 resolves to Anthropic's published $0.10/MTok", () => {
		expect(buildModel(spec("claude-sonnet-5-5")).cost).toMatchObject({
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
		});
	});

	test("an unpriced discovery row gets the full Sonnet 5.5 price", () => {
		const unpriced = { ...spec("claude-sonnet-5-5"), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		expect(buildModel(unpriced).cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
	});

	test("Sonnet 5 keeps the uncut rate", () => {
		expect(buildModel(spec("claude-sonnet-5")).cost?.cacheRead).toBe(0.2);
	});

	test("Vertex prices Sonnet 5.5 cache hits at $0.10/MTok", () => {
		expect(buildModel(spec("claude-sonnet-5-5@default", "google-vertex")).cost?.cacheRead).toBe(0.1);
	});

	test("Bedrock global rates use $0.10/MTok without changing other prices", () => {
		expect(buildModel(spec("global.anthropic.claude-sonnet-5-5", "amazon-bedrock")).cost).toMatchObject({
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
		});
	});

	test("Bedrock regional US keeps its 10% premium on all prices", () => {
		const regional = {
			...spec("us.anthropic.claude-sonnet-5-5", "amazon-bedrock"),
			cost: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
		};
		expect(buildModel(regional).cost).toMatchObject({
			input: 2.2,
			output: 11,
			cacheRead: 0.11,
			cacheWrite: 2.75,
		});
	});

	test("commandcode, priced at Anthropic list, follows the cut", () => {
		expect(buildModel(spec("claude-sonnet-5-5", "commandcode")).cost?.cacheRead).toBe(0.1);
	});
});
