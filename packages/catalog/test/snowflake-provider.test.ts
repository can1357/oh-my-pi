import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function seed(id: string): ModelSpec<Api> {
	const spec = seedModels("snowflake").find(model => model.id === id);
	if (!spec) throw new Error(`missing snowflake seed ${id}`);
	return spec;
}

describe("Snowflake Cortex thinking ladders", () => {
	// Live Cortex probes: Opus 4.7+/Sonnet 5 accept xhigh and max; Opus 4.6 and
	// Sonnet 4.6 reject xhigh; GPT-5.x before 5.2 documents minimal..high.
	test.each([
		["claude-opus-5-5", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]],
		["claude-sonnet-5", [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]],
		["claude-opus-4-6", [Effort.Low, Effort.Medium, Effort.High, Effort.Max]],
		["claude-sonnet-4-6", [Effort.Low, Effort.Medium, Effort.High]],
		["openai-gpt-5.1", [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]],
	])("%s resolves the effort ladder Cortex accepts", (id, efforts) => {
		expect(buildModel(seed(id)).thinking?.efforts).toEqual(efforts);
	});

	test("a GPT-5.2+ row keeps the OpenAI lineage ladder instead of the pre-5.2 restatement", () => {
		const model = buildModel({ ...seed("openai-gpt-5.1"), id: "openai-gpt-5.2", name: "GPT-5.2" });
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
	});
});
