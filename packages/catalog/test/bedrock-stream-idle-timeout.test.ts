import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function bedrockSpec(
	overrides: Partial<ModelSpec<"bedrock-converse-stream">> = {},
): ModelSpec<"bedrock-converse-stream"> {
	return {
		id: "global.anthropic.claude-fable-5",
		name: "Claude Fable 5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		...overrides,
	};
}

// Bedrock ConverseStream sends no ping keepalives, so reasoning models that go
// quiet mid-thinking previously fell back to the generic 300s idle watchdog and
// died with "Provider stream stalled while waiting for the next event" during
// long plan-writing/reasoning phases (issue #4758's Bedrock variant, worst on
// the adaptive-thinking Fable/Opus 4.7+ family).
describe("Bedrock stream idle-timeout compat", () => {
	test("widens the idle timeout to 900s for adaptive-thinking Claude", () => {
		for (const id of [
			"global.anthropic.claude-fable-5",
			"global.anthropic.claude-fable-5-20260120-v1:0",
			"us.anthropic.claude-opus-4-8",
			"us.anthropic.claude-sonnet-5",
			"us.anthropic.claude-opus-5",
		]) {
			expect(buildModel(bedrockSpec({ id })).compat.streamIdleTimeoutMs).toBe(900_000);
		}
	});

	test("widens the idle timeout to 600s for other reasoning models", () => {
		for (const id of [
			"anthropic.claude-opus-4-6-v1",
			"anthropic.claude-3-7-sonnet-20250219-v1:0",
			"us.amazon.nova-premier-v1:0",
		]) {
			expect(buildModel(bedrockSpec({ id })).compat.streamIdleTimeoutMs).toBe(600_000);
		}
	});

	test("leaves non-reasoning models on the generic default", () => {
		expect(
			buildModel(bedrockSpec({ id: "anthropic.claude-3-5-haiku-20241022-v1:0", reasoning: false })).compat
				.streamIdleTimeoutMs,
		).toBeUndefined();
	});

	test("explicit compat overrides win over the reasoning floors", () => {
		expect(buildModel(bedrockSpec({ compat: { streamIdleTimeoutMs: 120_000 } })).compat.streamIdleTimeoutMs).toBe(
			120_000,
		);
		// 0 disables the idle watchdog entirely.
		expect(buildModel(bedrockSpec({ compat: { streamIdleTimeoutMs: 0 } })).compat.streamIdleTimeoutMs).toBe(0);
	});
});
