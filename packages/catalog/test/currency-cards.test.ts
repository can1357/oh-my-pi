import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, ModelSpec, Usage } from "@oh-my-pi/pi-catalog/types";
import { materializeCurrencyCards } from "../src/pricing";

function spec(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		provider: "deepseek",
		name: id,
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function usage(input = 1_000_000, output = 1_000_000, cacheRead = 1_000_000, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Wednesday 2026-09-16 02:00 UTC: inside the weekday morning peak window.
const laterPeak = Date.parse("2026-09-16T02:00:00Z");
// Thursday 2026-09-10 05:00 UTC: between the two peak windows, so off-peak.
const offPeak = Date.parse("2026-09-10T05:00:00Z");

describe("per-model currency cards", () => {
	it("prices DeepSeek Flash's exact CNY card beside USD at the request timestamp", () => {
		const model = buildModel(spec("deepseek-v4-flash"));
		expect(model.cost.currencyCards?.CNY).toEqual({ input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 });

		const peakUsage = usage();
		calculateUsageCost(model.cost, peakUsage, laterPeak);
		expect(peakUsage.costByCurrency?.USD?.total).toBeCloseTo(1.506, 12);
		expect(peakUsage.costByCurrency?.CNY?.total).toBeCloseTo(10.04, 12);

		// Off-peak is a 50% discount on both published cards, not a second FX rate.
		const offUsage = usage();
		calculateUsageCost(model.cost, offUsage, offPeak);
		expect(offUsage.costByCurrency?.USD?.total).toBeCloseTo(0.753, 12);
		expect(offUsage.costByCurrency?.CNY?.total).toBeCloseTo(5.02, 12);
		// `cost` stays the base-currency view.
		expect(offUsage.cost.total).toBeCloseTo(0.753, 12);
	});

	it("mirrors Pro's dated flash-price switch in CNY too", () => {
		const model = buildModel(spec("deepseek-v4-pro"));
		expect(model.cost.currencyCards?.CNY).toEqual({ input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 });

		// Before 2026-09-14 the live Pro card applies (Wednesday 2026-09-09 02:00 UTC, peak).
		const beforeUsage = usage();
		calculateUsageCost(model.cost, beforeUsage, Date.parse("2026-09-09T02:00:00Z"));
		expect(beforeUsage.costByCurrency?.CNY?.total).toBeCloseTo(36.3, 12);
		expect(beforeUsage.costByCurrency?.USD?.total).toBeCloseTo(5.324, 12);

		// After the documented transition the Flash card applies in both currencies.
		const afterUsage = usage();
		calculateUsageCost(model.cost, afterUsage, laterPeak);
		expect(afterUsage.costByCurrency?.USD?.total).toBeCloseTo(1.506, 12);
		expect(afterUsage.costByCurrency?.CNY?.total).toBeCloseTo(10.04, 12);
	});

	it("omits the per-currency map for a model that publishes a single card", () => {
		const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
		const record = usage(1_000_000, 1_000_000, 0);
		calculateUsageCost(cost, record);
		expect(record.costByCurrency).toBeUndefined();
	});

	it("clears a previous card's totals when a record is repriced against a single-card model", () => {
		const record = usage();
		calculateUsageCost(buildModel(spec("deepseek-v4-flash")).cost, record, laterPeak);
		expect(record.costByCurrency?.CNY?.total).toBeCloseTo(10.04, 12);

		calculateUsageCost({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, record);
		expect(record.costByCurrency).toBeUndefined();
	});

	it("rejects malformed currency cards instead of pricing with them", () => {
		expect(() => materializeCurrencyCards({ eur: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })).toThrow(
			/unsupported currency/,
		);
		expect(() => materializeCurrencyCards({ cny: { input: 1, output: 1 } })).toThrow(/currency-card/);
		expect(() => materializeCurrencyCards({ cny: { input: 1, output: 1, cacheRead: 1, cacheWrite: -1 } })).toThrow(
			/currency-card/,
		);
	});

	it("normalizes KDL lowercase currency keys to ISO codes", () => {
		expect(materializeCurrencyCards({ cny: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } })).toEqual({
			CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 },
		});
	});
});
