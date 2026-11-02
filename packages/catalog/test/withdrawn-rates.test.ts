import { describe, expect, it } from "bun:test";
import { resolveWithdrawnRates } from "@oh-my-pi/pi-catalog/compat/withdrawn-rates";
import {
	calculateUsageCost,
	calculateWithdrawnRateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
} from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";
import { materializeWithdrawnRates } from "../src/pricing";

const CUTOFF = Date.parse("2026-09-14T04:00:00Z");
// Tuesday 2026-09-15: 06:30Z is inside DeepSeek's 06:00-10:00 peak window, 12:00Z is off-peak.
const PEAK = Date.parse("2026-09-15T06:30:00Z");
const OFF_PEAK = Date.parse("2026-09-15T12:00:00Z");

// `deepseek/deepseek-v4-pro` as `models.json` bundled it in v18.1.17 through
// v18.12.6: the Pro card plus the Flash card #16881 withdrew.
const RELEASED_COST: ModelCost = {
	input: 1.32,
	output: 3.96,
	cacheRead: 0.044,
	cacheWrite: 0,
	timeBased: {
		offPeakMultiplier: 0.5,
		peakWindows: [
			{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
			{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
		],
		effectiveRates: [{ effectiveFrom: 1789358400000, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }],
	},
};

function usage(): Usage {
	return {
		input: 200_000,
		output: 20_000,
		cacheRead: 800_000,
		cacheWrite: 0,
		totalTokens: 1_020_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function pro() {
	const model = getBundledModel("deepseek", "deepseek-v4-pro");
	const [card, ...rest] = resolveWithdrawnRates(model);
	if (!card || rest.length > 0) throw new Error("expected exactly one withdrawn card for deepseek-v4-pro");
	return { model, card };
}

const FLASH_CARD = { effectiveFrom: "2026-09-14T04:00:00Z", input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };

describe("withdrawn rate cards", () => {
	it("records the Flash card withdrawn from first-party DeepSeek V4 Pro, and from no other row", () => {
		expect(resolveWithdrawnRates(getBundledModel("deepseek", "deepseek-v4-pro"))).toEqual([
			{ effectiveFrom: CUTOFF, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		]);
		// The released card sat under `provider "deepseek"` on the exact Pro id only.
		const carriers: string[] = [];
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) {
				if (resolveWithdrawnRates(model).length > 0) carriers.push(`${provider}/${model.id}`);
			}
		}
		expect(carriers).toEqual(["deepseek/deepseek-v4-pro"]);
	});

	it("reproduces the released catalog's price for each request after the card's start", () => {
		const { model, card } = pro();
		for (const [timestamp, withdrawnTotal, currentTotal] of [
			[PEAK, 0.0888, 0.3784],
			[OFF_PEAK, 0.0444, 0.1892],
		] as const) {
			const withdrawn = calculateWithdrawnRateCost(model.cost, card, usage(), timestamp);
			// Same arithmetic as the released card, so a recorded cost matches it exactly.
			expect(withdrawn).toEqual(calculateUsageCost(RELEASED_COST, usage(), timestamp));
			expect(withdrawn?.total).toBeCloseTo(withdrawnTotal, 12);
			expect(calculateUsageCost(model.cost, usage(), timestamp).total).toBeCloseTo(currentTotal, 12);
		}
	});

	it("prices nothing before the card's start, where the released catalog charged the base card", () => {
		const { model, card } = pro();
		expect(calculateWithdrawnRateCost(model.cost, card, usage(), CUTOFF - 1)).toBeUndefined();
		expect(calculateWithdrawnRateCost(model.cost, card, usage(), CUTOFF)?.total).toBeCloseTo(0.0444, 12);
	});

	it("rejects a malformed card instead of ignoring it", () => {
		expect(materializeWithdrawnRates({ flash: FLASH_CARD })).toEqual([
			{ effectiveFrom: CUTOFF, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		]);
		expect(() => materializeWithdrawnRates({ flash: { ...FLASH_CARD, effectiveFrom: "2026-09-14" } })).toThrow();
		const { cacheWrite: _cacheWrite, ...missingLeg } = FLASH_CARD;
		expect(() => materializeWithdrawnRates({ flash: missingLeg })).toThrow();
		expect(() => materializeWithdrawnRates({ flash: { ...FLASH_CARD, outputRate: 1 } })).toThrow();
		expect(() => materializeWithdrawnRates({ flash: FLASH_CARD, again: FLASH_CARD })).toThrow();
		expect(() => materializeWithdrawnRates([FLASH_CARD])).toThrow();
	});
});
