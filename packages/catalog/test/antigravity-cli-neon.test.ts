import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function neonSpec(): ModelSpec<"antigravity-acp"> {
	return {
		id: "gemini-4-neon",
		name: "Gemini 4 Neon",
		api: "antigravity-acp",
		provider: "antigravity-cli",
		baseUrl: "https://antigravity.google",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 262_144,
	};
}

describe("antigravity-cli Gemini 4 Neon", () => {
	it("bundles the limits agy reports for the model", () => {
		const model = getBundledModel<"antigravity-acp">("antigravity-cli", "gemini-4-neon");

		expect(model.api).toBe("antigravity-acp");
		expect(model.contextWindow).toBe(1_048_576);
		// `usage_update.size` and the `maxOutputTokens` agy sends upstream.
		expect(model.maxTokens).toBe(262_144);
	});

	it("selects only the thought levels agy offers, defaulting to high", () => {
		// agy rejects a `thought_level` its roster omits ("Thinking level
		// 'minimal' is not offered"), and Neon opens at `high` rather than the
		// `medium` its siblings default to.
		const model = buildModel(neonSpec());

		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(model.thinking?.efforts).not.toContain(Effort.Minimal);
		expect(model.thinking?.defaultLevel).toBe(Effort.High);
	});
});
