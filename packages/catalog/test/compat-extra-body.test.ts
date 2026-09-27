import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

/**
 * Regression for #12087. `compat.extraBody` is accepted by the models.yml schema
 * for every supported API, but the anthropic-messages resolved record had no such
 * field, so `applyCompatOverrides` dropped the configured value silently and the
 * `/v1/messages` body never carried it.
 */
function spec(overrides: Partial<ModelSpec<"anthropic-messages">>): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		provider: "custom",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("#12087 compat.extraBody survives the anthropic-messages overlay", () => {
	it("keeps a configured extraBody on the resolved record", () => {
		const compat = resolveModelPolicy(spec({ compat: { extraBody: { gateway: "proxy-a", route: "eu" } } })).compat;

		expect(compat.extraBody).toEqual({ gateway: "proxy-a", route: "eu" });
	});
});
