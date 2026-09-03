import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

/**
 * Meta validates echoed Responses reasoning-item ids server-side and 400s
 * expired ones ("Referenced reasoning item ... was not found or has
 * expired"), which wedges every turn once history holds a stale rs_* id.
 * The Responses compat must therefore filter reasoning items from replayed
 * history for muse-spark on OpenRouter — same treatment Anthropic models
 * already get. Covers both the base and -contributor billing variants.
 */
function spec(id: string): ModelSpec<"openrouter"> {
	return {
		id,
		name: id,
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 64_000,
	};
}

describe("meta muse on openrouter responses: filter reasoning history", () => {
	for (const id of ["meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor"]) {
		it(`filters replayed reasoning items for ${id}`, () => {
			const policy = resolveModelPolicy(spec(id));
			expect(policy.identity.class).toBe("meta");
			expect(policy.identity.family).toBe("muse-spark");
			expect(policy.compat.filterReasoningHistory).toBe(true);
		});
	}

	it("leaves non-muse meta models untouched", () => {
		const policy = resolveModelPolicy(spec("meta/llama-4-maverick"));
		expect(policy.identity.family).toBe("llama");
		expect(policy.compat.filterReasoningHistory).toBe(false);
	});
});
