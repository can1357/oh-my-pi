import { describe, expect, it } from "bun:test";
// Relative import: exercise THIS worktree's policy engine, not the symlinked
// node_modules copy (which resolves to the primary checkout).
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

/**
 * Regression for #4192. ZenMux's `anthropic-messages` route
 * (`zenmux.ai/api/anthropic`) forwards to signature-enforcing Anthropic and
 * returns full thinking signatures, so it is a SIGNING endpoint. It must NOT be
 * classified `replayUnsignedThinking` — otherwise a stripped/unsigned historical
 * thinking block (e.g. an end_turn-bound checkpoint turn, or a cross-model
 * replay) is emitted as `signature: ""` and 400s the whole request with
 * `messages.1.content.0: Invalid signature in thinking`. Same failure class as
 * GitHub Copilot #2851.
 */
function spec(overrides: Partial<ModelSpec<"anthropic-messages">>): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "anthropic/claude-sonnet-5",
		name: "Claude Sonnet 5",
		provider: "zenmux",
		baseUrl: "https://zenmux.ai/api/anthropic",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 128_000,
		contextWindow: 1_000_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("#4192 anthropic compat: zenmux is a signing endpoint", () => {
	it("does NOT replay unsigned thinking for the zenmux anthropic proxy (sonnet 5)", () => {
		const compat = resolveModelPolicy(spec({})).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.officialEndpoint).toBe(false);
	});

	it("also excludes the free tier (anthropic/claude-sonnet-5-free)", () => {
		const compat = resolveModelPolicy(
			spec({ id: "anthropic/claude-sonnet-5-free", name: "Claude Sonnet 5 (Free)" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
	});

	it("classifies by provider id even if the baseUrl is customized", () => {
		// User-configured Zenmux entries may point at a mirror path. Provider id
		// is authoritative because the anthropic route always forwards to
		// signature-enforcing Anthropic.
		const compat = resolveModelPolicy(spec({ baseUrl: "https://mirror.example.com/zenmux/anthropic" })).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
	});

	it("classifies by url marker even under a custom provider id", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "custom", baseUrl: "https://zenmux.ai/api/anthropic" }),
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
		const compat = resolveModelPolicy(
			spec({ provider: "anthropic", baseUrl: "https://api.anthropic.com", id: "claude-opus-4.8" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
		expect(compat.officialEndpoint).toBe(true);
	});
});
