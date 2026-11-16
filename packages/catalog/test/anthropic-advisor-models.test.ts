import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveAdvisorModel } from "@oh-my-pi/pi-catalog/compat/advisor";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// The advisor tool's model must be one the API accepts for the executor;
// any other pairing is a 400. Family aliases pick the strongest accepted
// member, so one setting yields a valid pair on every executor.
//   https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#model-compatibility

function spec(id: string, provider = "anthropic"): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic advisor pairings", () => {
	test.each([
		// executor, configured advisor, resolved advisor
		["claude-opus-5-5", "fable", "claude-fable-5-2"],
		["claude-opus-5-5", "opus", "claude-opus-5-5"],
		["claude-sonnet-5-5", "sonnet", "claude-sonnet-5-5"],
		["claude-sonnet-5", "opus", "claude-opus-5-5"],
		["claude-haiku-4-5-20251001", "fable", "claude-fable-5-2"],
		["claude-haiku-5-5", "haiku", "claude-haiku-5-5"],
		["claude-opus-4-7", "claude-opus-4-8", "claude-opus-4-8"],
		["claude-fable-5-2", "fable", "claude-fable-5-2"],
	])("%s with %s advises through %s", (executor, configured, expected) => {
		expect(resolveAdvisorModel(buildModel(spec(executor)), configured)).toBe(expected);
	});

	test.each([
		// An advisor weaker than the executor, or absent from its documented list.
		["claude-fable-5-2", "opus"],
		["claude-opus-5-5", "sonnet"],
		["claude-opus-5", "claude-opus-4-8"],
		["claude-sonnet-5-5", "haiku"],
	])("%s rejects %s", (executor, configured) => {
		expect(resolveAdvisorModel(buildModel(spec(executor)), configured)).toBeUndefined();
	});

	test("models outside first-party Anthropic have no pairings", () => {
		expect(resolveAdvisorModel(buildModel(spec("claude-opus-5-5", "openrouter")), "fable")).toBeUndefined();
	});
});
