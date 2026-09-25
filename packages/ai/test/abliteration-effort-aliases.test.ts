import { describe, expect, test } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function bundled(id: string): Model<"openai-responses"> {
	const model = getBundledModel<"openai-responses">("abliteration", id);
	if (!model) throw new Error(`abliteration/${id} must be in bundled models.json`);
	return model;
}

function wireEffort(model: Model<"openai-responses">, reasoning: Effort) {
	return buildParams(model, context, { reasoning }, undefined).params.reasoning?.effort;
}

// docs.abliteration.ai/capabilities/thinking: the large models accept the full
// effort ladder but run fewer modes, rounding aliases up (medium → high,
// xhigh → max). The request must carry the documented mode, not a clamped
// lower neighbour.
describe("Abliteration Responses effort aliases", () => {
	test("Large V2 sends high for medium and max for xhigh", () => {
		const largeV2 = bundled("abliterated-model-large-v2");
		expect(wireEffort(largeV2, Effort.Medium)).toBe("high");
		expect(wireEffort(largeV2, Effort.XHigh)).toBe("max");
		expect(wireEffort(largeV2, Effort.Low)).toBe("low");
	});

	test("Large sends max for xhigh", () => {
		const large = bundled("abliterated-model-large");
		expect(wireEffort(large, Effort.XHigh)).toBe("max");
		expect(wireEffort(large, Effort.High)).toBe("high");
	});
});
