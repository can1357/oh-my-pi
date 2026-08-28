import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Usage } from "@oh-my-pi/pi-catalog/types";

function usage(fields: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): Usage {
	return {
		...fields,
		totalTokens: fields.input + fields.output + fields.cacheRead + fields.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("long-context pricing tier", () => {
	// GPT-5.6 Sol: $5/$30 standard, $10/$45 above 272K input tokens; the tier
	// rate applies to the ENTIRE request once total prompt input (input +
	// cacheRead + cacheWrite) crosses the threshold, matching OpenAI's billing.
	const sol = getBundledModel("openai", "gpt-5.6-sol");

	it("bills at standard rates at or below the 272K input threshold", () => {
		const atThreshold = usage({ input: 72_000, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, atThreshold);
		expect(atThreshold.cost.input).toBeCloseTo((5 / 1e6) * 72_000, 10);
		expect(atThreshold.cost.output).toBeCloseTo((30 / 1e6) * 10_000, 10);
		expect(atThreshold.cost.cacheRead).toBeCloseTo((0.5 / 1e6) * 200_000, 10);
	});

	it("bills the whole request at tier rates once prompt input crosses the threshold", () => {
		const overThreshold = usage({ input: 72_001, output: 10_000, cacheRead: 200_000, cacheWrite: 0 });
		calculateCost(sol, overThreshold);
		expect(overThreshold.cost.input).toBeCloseTo((10 / 1e6) * 72_001, 10);
		expect(overThreshold.cost.output).toBeCloseTo((45 / 1e6) * 10_000, 10);
		expect(overThreshold.cost.cacheRead).toBeCloseTo((1 / 1e6) * 200_000, 10);
		expect(overThreshold.cost.total).toBeCloseTo(
			overThreshold.cost.input + overThreshold.cost.output + overThreshold.cost.cacheRead,
			10,
		);
	});

	it("prices subscription Codex SKUs with the same tier for cost attribution", () => {
		const codexSol = getBundledModel("openai-codex", "gpt-5.6-sol");
		const overThreshold = usage({ input: 300_000, output: 1_000, cacheRead: 0, cacheWrite: 0 });
		calculateCost(codexSol, overThreshold);
		expect(overThreshold.cost.input).toBeCloseTo((10 / 1e6) * 300_000, 10);
		expect(overThreshold.cost.output).toBeCloseTo((45 / 1e6) * 1_000, 10);
	});
});
