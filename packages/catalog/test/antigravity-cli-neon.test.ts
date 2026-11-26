import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";

function neon() {
	return buildModel({
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
	});
}

it("antigravity-cli Gemini 4 Neon offers only agy's thought levels, defaulting to high", () => {
	// agy rejects a `thought_level` its roster omits ("Thinking level 'minimal' is not offered"),
	// and Neon opens at `high` rather than the `medium` its siblings default to.
	const model = neon();

	expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	expect(model.thinking?.defaultLevel).toBe(Effort.High);
});

it("bundled antigravity-cli rows resolve to included pricing rather than free", () => {
	// The runtime reads this materialized row directly from models.json, so this
	// assertion fails when the KDL changed but the bundled catalog was not regenerated.
	const model = getBundledModel("antigravity-cli", "gemini-4-neon");
	expect(getModelPricingStatus(model)).toBe("included");
});
