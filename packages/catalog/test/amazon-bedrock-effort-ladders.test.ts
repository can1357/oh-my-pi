import { describe, expect, test } from "bun:test";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// AWS's Bedrock adaptive-thinking effort table (checked 2026-11-15):
// https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html
// - `max`: Opus 4.6/4.7/4.8/5/5.5, Sonnet 4.6/5/5.5, Haiku 5.5, Fable/Mythos 5/5.1/5.2
// - `xhigh`: Opus 4.7/4.8/5/5.5, Sonnet 5/5.5, Haiku 5.5, Fable/Mythos 5/5.1/5.2
//   (not on Opus 4.6 or Sonnet 4.6)
// Before the family-scoped provider rules, the class-level `>=4.7 <5.1`
// four-tier ladder clamped `xhigh` on Opus 4.7/4.8/5, Sonnet 5, Fable 5 and
// Mythos 5, and Sonnet 4.6 was missing `max` on Bedrock (#13274).

const FIVE_TIER: Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
const FOUR_TIER_MAX: Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];

const spec = (id: string, provider = "amazon-bedrock"): ModelSpec => ({
	id,
	name: id,
	api: provider === "amazon-bedrock" ? "bedrock-converse-stream" : "anthropic-messages",
	provider,
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const ladder = (id: string, provider?: string): readonly Effort[] | undefined =>
	resolveModelPolicy(spec(id, provider)).thinking?.efforts;

describe("Bedrock adaptive-thinking effort ladders (#13274)", () => {
	test("opus 4.7+ gets the five-tier ladder the host documents", () => {
		for (const id of ["anthropic.claude-opus-4-7", "anthropic.claude-opus-4-8", "anthropic.claude-opus-5"]) {
			expect(ladder(id)).toEqual(FIVE_TIER);
		}
	});

	test("opus 4.6 keeps low..max without xhigh", () => {
		expect(ladder("anthropic.claude-opus-4-6")).toEqual(FOUR_TIER_MAX);
	});

	test("sonnet 5/5.5 get the five-tier ladder", () => {
		expect(ladder("anthropic.claude-sonnet-5")).toEqual(FIVE_TIER);
		expect(ladder("anthropic.claude-sonnet-5-5")).toEqual(FIVE_TIER);
	});

	test("sonnet 4.6 gains max on bedrock without xhigh", () => {
		expect(ladder("anthropic.claude-sonnet-4-6")).toEqual(FOUR_TIER_MAX);
	});

	test("fable and mythos 5.x get the five-tier ladder", () => {
		for (const id of [
			"anthropic.claude-fable-5",
			"anthropic.claude-fable-5-1",
			"anthropic.claude-fable-5-2",
			"anthropic.claude-mythos-5",
			"anthropic.claude-mythos-5-1",
			"anthropic.claude-mythos-5-2",
		]) {
			expect(ladder(id)).toEqual(FIVE_TIER);
		}
	});

	test("haiku 5.5 gets the five-tier ladder", () => {
		expect(ladder("anthropic.claude-haiku-5-5")).toEqual(FIVE_TIER);
	});

	test("haiku 4.5 is not granted xhigh", () => {
		const efforts = ladder("anthropic.claude-haiku-4-5");
		expect(efforts).toBeDefined();
		expect(efforts).not.toContain("xhigh");
	});

	test("the sonnet 4.6 max extension stays scoped to bedrock", () => {
		// The classes/anthropic.kdl row shared with cursor/google-antigravity/
		// openrouter is doc-verified for Bedrock only, so those hosts keep
		// their existing ladder.
		expect(ladder("anthropic.claude-sonnet-4-6", "openrouter")).not.toContain("max");
	});
});
