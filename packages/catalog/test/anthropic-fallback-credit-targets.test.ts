import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fallbackCreditTargets } from "@oh-my-pi/pi-catalog/compat/fallback-credit";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// A refusal's fallback-credit token can only be redeemed on the refused
// model's permitted fallback targets. Turn recovery redeems it only when the
// fallback model is in this list, so a model with no targets pays the full
// cache write on every refusal retry.
//   https://platform.claude.com/docs/en/build-with-claude/fallback-credit
//   "For Claude Fable 5.1, Claude Fable 5, and Claude Opus 5.5, those are
//   Claude Opus 4.8 (`claude-opus-4-8`) and Claude Opus 5 (`claude-opus-5`).
//   For Claude Opus 5, it is Claude Opus 4.8. For Claude Sonnet 5.5, it is
//   Claude Sonnet 5 (`claude-sonnet-5`)."

// Synthetic specs, so the assertions hold the rule, not the bundled snapshot.
function spec(id: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic fallback-credit targets", () => {
	test.each([
		["claude-fable-5-1", ["claude-opus-4-8", "claude-opus-5"]],
		["claude-opus-5-5", ["claude-opus-4-8", "claude-opus-5"]],
		["claude-opus-5", ["claude-opus-4-8"]],
		["claude-sonnet-5-5", ["claude-sonnet-5"]],
	])("%s redeems on exactly its documented targets", (id, expected) => {
		expect([...fallbackCreditTargets(buildModel(spec(id)))].sort()).toEqual(expected);
	});

	// The Opus and Sonnet rules are revision-scoped: a family-wide rule would
	// let a model with no documented targets attempt a redemption the API rejects.
	test.each(["claude-opus-4-8", "claude-sonnet-5", "claude-opus-5-1"])("%s has no targets", id => {
		expect(fallbackCreditTargets(buildModel(spec(id)))).toEqual([]);
	});
});
