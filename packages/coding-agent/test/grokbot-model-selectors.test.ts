import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildGrokbotStaticSeed } from "@oh-my-pi/pi-catalog/provider-models/grokbot";
import {
	filterAvailableModelsByEnabledPatterns,
	parseModelPattern,
	resolveModelScope,
	resolveProviderModelReference,
} from "../src/config/model-resolver";

const models = buildGrokbotStaticSeed().map(buildModel);
const opus = models.find(model => model.id === "claude-opus-5-5")!;

test("packed Opus selectors retain their requested effort instead of silently using the default", () => {
	const selected = Object.fromEntries(
		[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh].map(effort => {
			const result = parseModelPattern(`grokbot/claude-opus-5-5-${effort}`, models);
			expect(result.model?.id).toBe(opus.id);
			expect(result.explicitThinkingLevel).toBe(true);
			return [effort, result.thinkingLevel];
		}),
	);
	expect(selected).toEqual({ low: Effort.Low, medium: Effort.Medium, high: Effort.High, xhigh: Effort.XHigh });
});

test("canonical model IDs win over colliding advertised aliases and ambiguous aliases do not route", () => {
	const aliased = buildModel({ ...opus, id: "claude-opus-5", aliases: ["auto", "opus"] });
	const competing = buildModel({ ...opus, id: "claude-opus-4-8", aliases: ["opus"] });
	const pool = [...models, aliased, competing];
	expect(resolveProviderModelReference("grokbot", "auto", pool)?.id).toBe("auto");
	expect(resolveProviderModelReference("grokbot", "opus", pool)).toBeUndefined();
});

test("literal bracketed catalog selectors survive --models and enabled-pattern filtering", async () => {
	const bracketed = buildModel({ ...models.find(model => model.id === "default")!, id: "default[]" });
	const pool = [...models, bracketed];
	const scoped = await resolveModelScope(["grokbot/default[]"], { getAvailable: () => pool });
	expect(scoped.map(entry => entry.model.id)).toEqual(["default[]"]);
	expect(filterAvailableModelsByEnabledPatterns(pool, ["grokbot/default[]"]).map(model => model.id)).toEqual([
		"default[]",
	]);
});
