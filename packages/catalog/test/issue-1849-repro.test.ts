/**
 * Regression for #1849 — Kimi K2.x maxTokens on Fireworks/Fire Pass was
 * inherited from `/v1/models` discovery (`max_completion_tokens: 65536`),
 * but Kimi K2 on Fireworks is documented to produce runaway reasoning traces
 * unless the output budget is bounded.
 *
 * Two contracts this file defends:
 *   1. `clampFireworksKimiMaxTokens` caps any Kimi K2.x id (public or wire)
 *      to the published 32,768 ceiling and leaves every other model alone.
 *   2. The bundled catalog ships the capped value — both for the static
 *      `firepass/kimi-k2.6-turbo` entry (no dynamic discovery) and for the
 *      `fireworks/kimi-k2.5` / `fireworks/kimi-k2.6` entries that the
 *      generator regenerates.
 */
import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	clampFireworksKimiMaxTokens,
	FIREWORKS_KIMI_MAX_TOKENS,
	isFireworksKimiK2ModelId,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Fireworks Kimi K2 maxTokens cap (#1849)", () => {
	it("recognizes Kimi K2.x public and wire ids", () => {
		const positives = [
			"kimi-k2.5",
			"kimi-k2.6",
			"kimi-k2.6-turbo",
			"kimi-k2-thinking",
			"accounts/fireworks/models/kimi-k2-instruct",
			"accounts/fireworks/models/kimi-k2-thinking",
			"accounts/fireworks/routers/kimi-k2p6-turbo",
		];
		for (const id of positives) {
			expect(isFireworksKimiK2ModelId(id)).toBe(true);
		}
		const negatives = [
			"kimi-latest",
			"kimi-k1.5",
			"deepseek-v4-pro",
			"glm-5.1",
			"accounts/fireworks/models/minimax-m2.7",
			// K2.7-Code is excluded from the K2.5/K2.6 cap (Fireworks serves its
			// full context), so it must not match — public, fast, and wire ids.
			"kimi-k2.7-code",
			"kimi-k2.7-code-fast",
			"kimi-k2.7-code-highspeed",
			"accounts/fireworks/models/kimi-k2p7-code",
		];
		for (const id of negatives) {
			expect(isFireworksKimiK2ModelId(id)).toBe(false);
		}
	});

	it("clamps Kimi K2.x candidates to the published ceiling and leaves others untouched", () => {
		// Inflated upstream value collapses to the cap.
		expect(clampFireworksKimiMaxTokens("kimi-k2.6", 65_536)).toBe(FIREWORKS_KIMI_MAX_TOKENS);
		expect(clampFireworksKimiMaxTokens("accounts/fireworks/routers/kimi-k2p6-turbo", 131_072)).toBe(
			FIREWORKS_KIMI_MAX_TOKENS,
		);
		// Already-low candidate stays low — the helper never raises a budget.
		expect(clampFireworksKimiMaxTokens("kimi-k2.5", 4_096)).toBe(4_096);
		// Non-Kimi ids pass through verbatim.
		expect(clampFireworksKimiMaxTokens("deepseek-v4-pro", 65_536)).toBe(65_536);
		expect(clampFireworksKimiMaxTokens("glm-5.1", 65_536)).toBe(65_536);
	});

	it("ships the capped maxTokens in the bundled Fireworks/Fire Pass catalog", () => {
		const entries: Array<["fireworks" | "firepass", string]> = [
			["firepass", "kimi-k2.6-turbo"],
			["fireworks", "kimi-k2.5"],
			["fireworks", "kimi-k2.6"],
		];
		for (const [provider, id] of entries) {
			const model = getBundledModel(provider, id);
			expect(model).toBeDefined();
			expect(model.maxTokens).toBe(FIREWORKS_KIMI_MAX_TOKENS);
		}
	});

	it("leaves Kimi K2.7-Code uncapped on Fireworks", () => {
		// K2.7-Code is not part of the K2.5/K2.6 cap; its output ceiling tracks
		// Fireworks' reported max_completion_tokens rather than being pinned to
		// the 32,768 family ceiling.
		for (const id of ["kimi-k2.7-code", "kimi-k2.7-code-fast"]) {
			const model = getBundledModel("fireworks", id);
			expect(model).toBeDefined();
			expect(model.maxTokens).toBeGreaterThan(FIREWORKS_KIMI_MAX_TOKENS);
		}
	});
});
