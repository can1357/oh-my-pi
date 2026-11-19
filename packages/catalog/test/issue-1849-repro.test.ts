/**
 * Regression for #1849 — Kimi K2.x maxTokens on Fireworks/Fire Pass was
 * inherited from `/v1/models` discovery (`max_completion_tokens: 65536`),
 * but Kimi K2 on Fireworks is documented to produce runaway reasoning traces
 * unless the output budget is bounded.
 *
 * Contracts this file defends:
 *   1. The `max-tokens-ceiling` rules in `providers/fireworks.kdl` and
 *      `providers/firepass.kdl` cap any Kimi K2.x id (public or wire) at the
 *      published 32,768 ceiling through `buildModel`, never raise a lower
 *      budget, and leave K2.7-Code and every other model alone.
 *   2. Fireworks rows that report no output budget take the rule-owned
 *      fallback (32,768 for K2.x, 65,536 for K2.7-Code).
 *   3. The bundled catalog ships the capped value for the regenerated
 *      `fireworks/kimi-k2.5` / `fireworks/kimi-k2.6` entries.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const FIREWORKS_KIMI_K2_MAX_TOKENS = 32_768;

function builtMaxTokens(provider: "fireworks" | "firepass", id: string, maxTokens: number | null): number | null {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens,
	}).maxTokens;
}

describe("Fireworks Kimi K2 maxTokens cap (#1849)", () => {
	const k2Ids = [
		"kimi-k2.5",
		"kimi-k2.6",
		"kimi-k2.6-turbo",
		"kimi-k2-thinking",
		"accounts/fireworks/models/kimi-k2-instruct",
		"accounts/fireworks/models/kimi-k2-thinking",
		"accounts/fireworks/routers/kimi-k2p6-turbo",
	];

	it("caps Kimi K2.x public and wire ids on Fireworks-backed providers", () => {
		for (const provider of ["fireworks", "firepass"] as const) {
			for (const id of k2Ids) {
				expect(builtMaxTokens(provider, id, 131_072)).toBe(FIREWORKS_KIMI_K2_MAX_TOKENS);
			}
			// Already-low candidate stays low — the ceiling never raises a budget.
			expect(builtMaxTokens(provider, "kimi-k2.5", 4_096)).toBe(4_096);
		}
	});

	it("leaves K2.7-Code and non-Kimi models untouched", () => {
		const uncapped = [
			"kimi-latest",
			"kimi-k1.5",
			"deepseek-v4-pro",
			"glm-5.1",
			"accounts/fireworks/models/minimax-m2.7",
			// K2.7-Code serves its full budget on Fireworks.
			"kimi-k2.7-code",
			"kimi-k2.7-code-fast",
			"kimi-k2.7-code-highspeed",
			"accounts/fireworks/models/kimi-k2p7-code",
		];
		for (const id of uncapped) {
			expect(builtMaxTokens("fireworks", id, 131_072)).toBe(131_072);
		}
	});

	it("seeds the rule-owned fallback when Fireworks reports no output budget", () => {
		expect(builtMaxTokens("fireworks", "kimi-k2.6", null)).toBe(FIREWORKS_KIMI_K2_MAX_TOKENS);
		expect(builtMaxTokens("fireworks", "kimi-k2.7-code", null)).toBe(65_536);
		expect(builtMaxTokens("fireworks", "glm-5.1", null)).toBeNull();
	});

	it("ships the capped maxTokens in the bundled Fireworks catalog", () => {
		const entries: Array<["fireworks", string]> = [
			["fireworks", "kimi-k2.5"],
			["fireworks", "kimi-k2.6"],
		];
		for (const [provider, id] of entries) {
			const model = getBundledModel(provider, id);
			expect(model).toBeDefined();
			expect(model.maxTokens).toBe(FIREWORKS_KIMI_K2_MAX_TOKENS);
		}
	});
});
