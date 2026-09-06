import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { OPENAI_CURATED_FALLBACK_MODELS } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import { parseArgs } from "../src/cli/args";
import { ModelOverrideSchema } from "../src/config/models-config-schema";
import { Settings } from "../src/config/settings";
import { getThinkingLevelMetadata, parseConfiguredThinkingLevel, resolveThinkingLevelForModel } from "../src/thinking";

const astra = buildModel(OPENAI_CURATED_FALLBACK_MODELS[0]!);

describe("Astra reasoning selection", () => {
	it("preserves max and Ultra in custom model configurations", () => {
		const config = ModelOverrideSchema.assert({
			thinking: {
				mode: "effort",
				efforts: ["low", "xhigh", "max", "ultra"],
				defaultLevel: "max",
				effortMap: { ultra: "xhigh", max: "max" },
			},
		});
		expect(config.thinking?.efforts).toEqual(["low", "xhigh", "max", "ultra"]);
		expect(config.thinking?.defaultLevel).toBe("max");
		expect(config.thinking?.effortMap).toEqual({ ultra: "xhigh", max: "max" });
	});

	it("keeps max and Ultra as distinct CLI choices", () => {
		expect(parseArgs(["--thinking", "max"]).thinking).toBe(ThinkingLevel.Max);
		expect(parseArgs(["--ultra"]).thinking).toBe(ThinkingLevel.Ultra);
		expect(parseConfiguredThinkingLevel("max")).toBe(ThinkingLevel.Max);
		expect(getThinkingLevelMetadata(ThinkingLevel.Max).label).toBe("max");
	});

	it("supports maximum reasoning in settings and on Astra without enabling Ultra", () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "max" });
		expect(settings.get("defaultThinkingLevel")).toBe("max");
		expect(resolveThinkingLevelForModel(astra, ThinkingLevel.Max)).toBe(Effort.Max);
		expect(resolveThinkingLevelForModel(astra, ThinkingLevel.Ultra)).toBe(Effort.Ultra);
		expect(settings.get("serviceTier")).toBe("none");
		expect(settings.get("providers.openaiWebsockets")).toBe("auto");
	});

	it("clamps max to the supported ceiling when switching to a legacy model", () => {
		const legacy = buildModel({
			...astra,
			id: "gpt-5.2",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});
		expect(resolveThinkingLevelForModel(legacy, ThinkingLevel.Max)).toBe(Effort.XHigh);
	});
});
