import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import {
	calculateCost,
	calculateUsageCost,
	getBundledModel,
	getBundledModels,
	getEffectiveTokenCost,
} from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, ModelCost, ModelSpec, TokenCost } from "@oh-my-pi/pi-catalog/types";

/** USD per 1M tokens: API list prices used as the API-equivalent estimate. */
const API_EQUIVALENT_RATES: Record<string, TokenCost> = {
	"gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
	"gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-oss-120b-medium": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
};
const UNPRICED: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ROSTER = ["gemini-4-carbon", ...Object.keys(API_EQUIVALENT_RATES)].sort();
const FLASH_DOUBLING = Date.parse("2027-01-01T00:00:00Z");
const BEFORE_DOUBLING = FLASH_DOUBLING - 1;

function legs(cost: ModelCost, at?: number): TokenCost {
	const { input, output, cacheRead, cacheWrite } = getEffectiveTokenCost(cost, at);
	return { input, output, cacheRead, cacheWrite };
}

function buildAt(timestamp: number, spec: ModelSpec<Api>): Model<Api> {
	const clock = spyOn(Date, "now").mockReturnValue(timestamp);
	try {
		return buildModel(spec);
	} finally {
		clock.mockRestore();
	}
}

function seed(id: string): ModelSpec<Api> {
	const spec = seedModels("antigravity-cli").find(candidate => candidate.id === id);
	if (!spec) throw new Error(`missing seed ${id}`);
	return spec;
}

function usage(input = 1_000_000, output = 1_000_000) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("antigravity-cli API-equivalent pricing", () => {
	it("bundles the API list rate for every priced model", () => {
		for (const [id, rate] of Object.entries(API_EQUIVALENT_RATES)) {
			expect(legs(getBundledModel("antigravity-cli", id).cost, BEFORE_DOUBLING), id).toEqual(rate);
		}
	});

	it("keeps gemini-4-carbon unpriced", () => {
		expect(legs(getBundledModel("antigravity-cli", "gemini-4-carbon").cost, BEFORE_DOUBLING)).toEqual(UNPRICED);
	});

	it("prices every bundled model except the default", () => {
		const ids = getBundledModels("antigravity-cli")
			.map(model => model.id)
			.sort();
		expect(ids).toEqual(ROSTER);
	});

	it("estimates usage at the list rate", () => {
		expect(calculateCost(getBundledModel("antigravity-cli", "gemini-4-argon"), usage(), BEFORE_DOUBLING).total).toBe(
			24,
		);
		expect(calculateCost(getBundledModel("antigravity-cli", "gemini-4-carbon"), usage(), BEFORE_DOUBLING).total).toBe(
			0,
		);
	});

	it("authors the same rates in the provider seed", () => {
		const seeds = seedModels("antigravity-cli");
		expect(seeds.map(spec => spec.id).sort()).toEqual(ROSTER);
		const builtAt = BEFORE_DOUBLING;
		for (const [id, rate] of Object.entries(API_EQUIVALENT_RATES)) {
			expect(legs(buildAt(builtAt, seed(id)).cost, builtAt), id).toEqual(rate);
		}
		expect(legs(buildAt(builtAt, seed("gemini-4-carbon")).cost, builtAt)).toEqual(UNPRICED);
	});

	it("doubles gemini-3.8-flash from 2027-01-01", () => {
		const before = buildAt(BEFORE_DOUBLING, seed("gemini-3.8-flash"));
		expect(legs(before.cost, BEFORE_DOUBLING)).toEqual(API_EQUIVALENT_RATES["gemini-3.8-flash"]);
		const doubled = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };
		expect(legs(before.cost, FLASH_DOUBLING)).toEqual(doubled);
		// A row built after the switch still bills an earlier request at the old card.
		const after = buildAt(FLASH_DOUBLING, seed("gemini-3.8-flash"));
		expect(legs(after.cost, FLASH_DOUBLING)).toEqual(doubled);
		expect(legs(after.cost, BEFORE_DOUBLING)).toEqual(API_EQUIVALENT_RATES["gemini-3.8-flash"]);
		const billed = calculateUsageCost(before.cost, usage(), FLASH_DOUBLING);
		expect(billed.total).toBe(9);
	});
});
