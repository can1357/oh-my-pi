import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { mapEffortToAnthropicAdaptiveEffort } from "@oh-my-pi/pi-catalog/model-thinking";

/**
 * Custom `anthropic-messages` provider (issue #10994): unlike the built-in
 * Claude ladders, its adaptive effort ladder exposes `minimal`, which the
 * Anthropic Messages wire rejects as an `output_config.effort` value.
 */
function customAdaptiveModel(): Model<"anthropic-messages"> {
	const base = buildModel({
		id: "claude-opus-5",
		name: "claude-opus-5",
		api: "anthropic-messages",
		provider: "ccs",
		baseUrl: "https://ccs.example/anthropic",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	return buildModel({
		...base,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const c = new AbortController();
	c.abort();
	return c.signal;
}

describe("issue #10994 — anthropic adaptive minimal effort clamp", () => {
	it("clamps minimal to low in the adaptive effort mapper", () => {
		const model = customAdaptiveModel();
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.Minimal)).toBe("low");
		// Higher tiers pass through unchanged.
		expect(mapEffortToAnthropicAdaptiveEffort(model, Effort.Medium)).toBe("medium");
	});

	it("never serializes output_config.effort=minimal", async () => {
		const model = customAdaptiveModel();
		const { promise, resolve } = Promise.withResolvers<{ output_config?: { effort?: string } }>();
		streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			signal: abortedSignal(),
			thinkingEnabled: true,
			reasoning: Effort.Minimal,
			onPayload: p => resolve(p as { output_config?: { effort?: string } }),
		});
		const payload = await promise;
		expect(payload.output_config?.effort).toBe("low");
	});
});
