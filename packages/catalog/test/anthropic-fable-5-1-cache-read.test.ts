import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Anthropic priced Fable 5.1 cache reads at $0.25/MTok, 0.025x its $10 input,
// a 75% cut from Fable 5's $1.00. Every other current Claude model keeps the
// Anthropic-wide 0.1x.
//   https://www.anthropic.com/claude/fable
//   https://www.anthropic.com/claude-fable-and-mythos-5-1
//
// `classes/anthropic.kdl` pins Fable pricing family-wide because Anthropic's
// /v1/models omits it. That patch predates Fable 5.1, so the 5.1 revision
// inherited Fable 5's pre-cut cache-read rate; a revision-scoped patch
// corrects 5.1 without disturbing the family default.

// Synthetic specs, so the rule assertions hold regardless of what upstream
// metadata the bundled snapshot happens to carry (AGENTS.md: test the rule,
// not the generated JSON).
function spec(id: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		// Deliberately wrong on every axis the family patch owns, so a passing
		// assertion can only come from the rule.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic Fable cache-read rules", () => {
	test("the 5.1 revision resolves to Anthropic's published $0.25/MTok", () => {
		expect(buildModel(spec("claude-fable-5-1")).cost?.cacheRead).toBe(0.25);
	});

	test("the 5.1 revision keeps the rest of the family cost and limits patch", () => {
		const built = buildModel(spec("claude-fable-5-1"));
		expect(built.cost).toMatchObject({ input: 10, output: 50, cacheWrite: 12.5 });
		expect(built.contextWindow).toBe(1_000_000);
		expect(built.maxTokens).toBe(128_000);
	});

	test("Fable 5 keeps the family default, which Anthropic did not cut", () => {
		expect(buildModel(spec("claude-fable-5")).cost?.cacheRead).toBe(1);
	});

	test("the Mythos family is untouched", () => {
		expect(buildModel(spec("claude-mythos-5")).cost?.cacheRead).toBe(1);
	});

	test("other Claude families stay on their own patches", () => {
		expect(buildModel(spec("claude-opus-4-5")).cost?.cacheRead).toBe(0.5);
	});
});

describe("anthropic Fable 5.1 bundled row", () => {
	// `getProviderModels` consumes models.json verbatim and never reruns
	// `buildModel`, so an offline/static startup reports whatever the committed
	// row says. The rule fix only reaches users once the row is regenerated.
	test("ships the corrected cache-read rate", () => {
		const bundled = getBundledModels("anthropic").find(model => model.id === "claude-fable-5-1");
		expect(bundled?.cost?.cacheRead).toBe(0.25);
	});

	test("still ships Fable 5 at the uncut rate", () => {
		const bundled = getBundledModels("anthropic").find(model => model.id === "claude-fable-5");
		expect(bundled?.cost?.cacheRead).toBe(1);
	});
});
