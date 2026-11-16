import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";

/** USD per 1M tokens: API list prices used as the API-equivalent estimate. */
const API_EQUIVALENT_RATES: Record<string, ModelCost> = {
	"gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
	"gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-oss-120b-medium": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
};

describe("antigravity-cli API-equivalent pricing", () => {
	it("bundles the API list rate for every priced model", () => {
		for (const [id, cost] of Object.entries(API_EQUIVALENT_RATES)) {
			expect(getBundledModel("antigravity-cli", id).cost).toEqual(cost);
		}
	});

	it("keeps gemini-4-carbon unpriced", () => {
		expect(getBundledModel("antigravity-cli", "gemini-4-carbon").cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("prices every bundled model except the default", () => {
		const ids = getBundledModels("antigravity-cli")
			.map(model => model.id)
			.sort();
		expect(ids).toEqual(["gemini-4-carbon", ...Object.keys(API_EQUIVALENT_RATES)].sort());
	});

	it("estimates usage at the list rate", () => {
		const usage = () => ({
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(calculateCost(getBundledModel("antigravity-cli", "gemini-4-argon"), usage()).total).toBe(24);
		expect(calculateCost(getBundledModel("antigravity-cli", "gemini-4-carbon"), usage()).total).toBe(0);
	});
});
