import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Anthropic's /v1/models reports neither reasoning, vision, pricing nor limits
// for Fable/Mythos. Until models.dev catalogs a new revision, discovery has no
// reference row and falls back to text-only, non-reasoning, unpriced defaults;
// the rules must restore the model card.
//   https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2
function discovered(id: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

describe("anthropic Fable/Mythos 5.2 discovered rows", () => {
	for (const id of ["claude-fable-5-2", "claude-mythos-5-2"]) {
		test(`${id} resolves to the 5.2 model card`, () => {
			const built = buildModel(discovered(id));
			expect(built.reasoning).toBe(true);
			expect(built.input).toEqual(["text", "image"]);
			expect(built.cost).toMatchObject({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 });
			expect(built.contextWindow).toBe(1_000_000);
			expect(built.maxTokens).toBe(128_000);
			expect(built.thinking).toMatchObject({ mode: "anthropic-adaptive", prefixBinding: true });
		});
	}

	test("the 5.2 price cut does not leak onto Fable 5.1", () => {
		expect(buildModel(discovered("claude-fable-5-1")).cost).toMatchObject({ input: 10, output: 50, cacheRead: 0.25 });
	});
});
