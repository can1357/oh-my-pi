import { describe, expect, it } from "bun:test";
import { blendPredictions } from "../src/predict/blend";

describe("blendPredictions", () => {
	it("lets agreement lift a word neither engine is sure of over a lone confident rival", () => {
		// SmolLM alone: 0.7·0.5 = 0.35; `eral` agreed: 0.3·0.3 + 0.7·0.4 = 0.37.
		const agreed = blendPredictions({ suffix: "eral", confidence: 0.3 }, { suffix: "ERAL", confidence: 0.4 });
		expect(agreed?.suffix).toBe("eral");
		expect(agreed?.confidence).toBeCloseTo(0.37);
		expect(blendPredictions({ suffix: "ate", confidence: 0.3 }, { suffix: "ic", confidence: 0.5 })).toEqual({
			suffix: "ic",
			confidence: 0.35,
		});
	});

	it("falls back to n-gram alone and hides weak blends", () => {
		expect(blendPredictions({ suffix: "ut", confidence: 0.9 }, null)?.suffix).toBe("ut");
		expect(blendPredictions({ suffix: "ut", confidence: 0.1 }, null)).toBeNull();
		expect(blendPredictions(null, { suffix: "ut", confidence: 0.05 })).toBeNull();
	});
});
