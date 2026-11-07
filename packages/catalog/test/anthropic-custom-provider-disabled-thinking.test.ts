import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

function haiku(provider: string, compat?: ModelSpec<"anthropic-messages">["compat"]): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "claude-haiku-5-5",
		name: "claude-haiku-5-5",
		provider,
		baseUrl: "https://api.anthropic.com",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		reasoning: true,
		compat,
	};
}

describe("Anthropic disabledThinking from models.yml compat", () => {
	// A custom provider id misses the provider-keyed rule, so only its own
	// `compat` can switch thinking off when Off is selected.
	it("honors a custom provider's disabledThinking", () => {
		expect(resolveModelPolicy(haiku("claude", { disabledThinking: "disabled" })).compat?.disabledThinking).toBe(
			"disabled",
		);
	});
});
