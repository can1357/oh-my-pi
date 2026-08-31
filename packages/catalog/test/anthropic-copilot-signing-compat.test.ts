import { describe, expect, it } from "bun:test";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

/**
 * Regression for #2851. GitHub Copilot's `anthropic-messages` proxy forwards to
 * signature-enforcing Anthropic and returns full thinking signatures, so it is a
 * SIGNING endpoint. It must NOT be classified `replayUnsignedThinking` — otherwise
 * a stripped/unsigned historical thinking block (e.g. an end_turn-bound checkpoint
 * turn) is replayed as `signature: ""` and 400s the whole request.
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

describe("#2851 anthropic compat: github-copilot is a signing endpoint", () => {
	it("does NOT replay unsigned thinking for the github-copilot anthropic proxy", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("also excludes github-copilot enterprise (copilot-api.*) hosts", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "github-copilot", baseUrl: "https://copilot-api.ghe.example.com" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
	});

	it("still replays unsigned thinking for generic non-official reasoning endpoints (#2005, no regression)", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "custom", baseUrl: "https://llm.example.com/anthropic" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(true);
	});

	it("still degrades unsigned thinking to text for official Anthropic", () => {
		const compat = resolveModelPolicy(spec({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.officialEndpoint).toBe(true);
	});
});
