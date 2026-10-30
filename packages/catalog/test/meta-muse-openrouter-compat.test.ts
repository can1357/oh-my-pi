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
	it("filters replayed reasoning items for meta/muse-spark-1.3", () => {
		const policy = resolveModelPolicy(spec("meta/muse-spark-1.3"));
		expect(policy.identity.class).toBe("meta");
		expect(policy.identity.family).toBe("muse-spark");
		expect(policy.compat.filterReasoningHistory).toBe(true);
		expect(policy.compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	it("leaves non-muse meta models untouched", () => {
		const policy = resolveModelPolicy(spec("meta/llama-4-maverick"));
		expect(policy.identity.family).toBe("llama");
		expect(policy.compat.filterReasoningHistory).toBe(false);
		expect(policy.compat.supportsToolChoice).toBe(true);
	});
});

/**
 * OpenRouter forwards its hosted Muse SKUs to Meta's backend, which 400s any
 * tool_choice but "auto" and hides the reason behind "Provider returned error".
 * Handoff's cache-first `toolChoice: "none"` must be omitted for those SKUs,
 * without suppressing the open-weight model's advertised tool controls (#15910).
 */
describe("hosted meta muse on openrouter responses: omit tool_choice", () => {
	it.each(["meta/muse-spark-1.3-contributor", "meta/muse-wonder"])("disables tool_choice for %s", id => {
		expect(resolveModelPolicy(spec(id)).compat.supportsToolChoice).toBe(false);
	});
	it("preserves explicit tool choices for the open-weight Muse Spark model", () => {
		const policy = resolveModelPolicy(spec("meta/muse-spark-open"));
		expect(policy.identity.family).toBe("muse-spark");
		expect(policy.compat.supportsToolChoice).toBe(true);
	});
});
