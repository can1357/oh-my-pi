import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyCatalogCorrections, buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	calculateCost,
	calculateUncachedInputCost,
	calculateUsageCost,
	getBundledModel,
	getBundledModels,
	getNextTimeBasedPricingTransition,
	getTimeBasedPricingPeriod,
} from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, ModelSpec, Usage } from "@oh-my-pi/pi-catalog/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isTimeBasedCost, materializeTimeBasedCost } from "../src/pricing";

function spec(id = "deepseek-v4-flash", provider = "deepseek"): ModelSpec<"openai-completions"> {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
	};
}

function usage(input = 1_000_000, output = 1_000_000, cacheRead = 1_000_000, cacheWrite = 1_000_000): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const monday = Date.parse("2026-09-07T00:00:00Z");
const peak = Date.parse("2026-09-10T02:00:00Z");
const offPeak = Date.parse("2026-09-10T05:00:00Z");

describe("time-based token pricing", () => {
	it("uses half-open intervals at every UTC window edge", () => {
		const model = buildModel(spec());
		for (const [minute, before, at] of [
			[60, 0.15, 0.3],
			[240, 0.3, 0.15],
			[360, 0.15, 0.3],
			[600, 0.3, 0.15],
		] as const) {
			const timestamp = monday + minute * 60_000;
			expect(calculateUncachedInputCost(model.cost, 1_000_000, timestamp - 1)).toBeCloseTo(before, 12);
			expect(calculateUncachedInputCost(model.cost, 1_000_000, timestamp)).toBeCloseTo(at, 12);
		}
	});

	it("charges peak on every weekday and off-peak all weekend, independent of local date", () => {
		const model = buildModel(spec());
		for (let day = 0; day < 7; day++) {
			for (const minute of [120, 420]) {
				expect(
					calculateUncachedInputCost(model.cost, 1_000_000, monday + day * 86_400_000 + minute * 60_000),
				).toBeCloseTo(day < 5 ? 0.3 : 0.15, 12);
			}
		}
		// Both describe Monday 01:00 UTC, despite different local weekdays/hours.
		for (const instant of ["2026-09-06T18:00:00-07:00", "2026-09-07T10:00:00+09:00"]) {
			expect(calculateUncachedInputCost(model.cost, 1_000_000, Date.parse(instant))).toBeCloseTo(0.3, 12);
		}
	});

	it("prices mixed uncached, cached, and output tokens at each request's frozen timestamp", () => {
		const model = buildModel(spec());
		const first = usage();
		const second = usage();
		calculateCost(model, first, peak);
		calculateCost(model, second, offPeak);
		for (const [field, expected] of Object.entries({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.006,
			cacheWrite: 0,
			total: 1.506,
		})) {
			expect(first.cost[field as keyof Usage["cost"]]).toBeCloseTo(expected, 12);
			expect(second.cost[field as keyof Usage["cost"]]).toBeCloseTo(expected * 0.5, 12);
		}
		expect(first.cost.total + second.cost.total).toBeCloseTo(2.259, 12);
	});

	it("keeps Pro at the Pro card across the withdrawn 2026-09-14 transition", () => {
		// Change log 2026-09-10: V4 Pro continues after September 14 with billing unchanged.
		const model = buildModel(spec("deepseek-v4-pro"));
		const cutoff = Date.parse("2026-09-14T04:00:00Z");
		const before = calculateCost(model, usage(), cutoff - 1);
		const after = calculateCost(model, usage(), cutoff);
		const nextPeak = calculateCost(model, usage(), Date.parse("2026-09-14T06:00:00Z"));
		expect(before.input).toBeCloseTo(1.32, 12);
		expect(before.output).toBeCloseTo(3.96, 12);
		expect(before.cacheRead).toBeCloseTo(0.044, 12);
		expect(before.total).toBeCloseTo(5.324, 12);
		// 04:00Z closes the morning peak window: the off-peak half of the Pro card, not the Flash card.
		expect(after.total).toBeCloseTo(2.662, 12);
		expect(nextPeak.total).toBeCloseTo(5.324, 12);
		expect(model.cost.timeBased?.effectiveRates).toBeUndefined();
	});

	it("applies first-party policies to documented aliases but not reseller or expiring products", () => {
		for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
			expect(calculateCost(buildModel(spec(id)), usage(), offPeak).total).toBeCloseTo(0.753, 12);
		}
		for (const candidate of [
			spec("deepseek-v4-flash", "openrouter"),
			spec("deepseek/deepseek-v4-pro", "together"),
			spec("deepseek-v4.1-flash-expires-on-0910"),
		]) {
			const model = buildModel(candidate);
			expect(calculateCost(model, usage(), offPeak).total).toBeCloseTo(30, 12);
		}
		// Bundled rows must carry the same materialized pricing as discovery-built rows.
		expect(calculateCost(getBundledModel("deepseek", "deepseek-v4-flash"), usage(), offPeak).total).toBeCloseTo(
			0.753,
			12,
		);
	});

	it("selects effective rates before context tiers and discounts all billable token dimensions", () => {
		const cost: ModelCost = {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			longContext: { inputThreshold: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [],
				effectiveRates: [
					{ effectiveFrom: 2000, input: 5, output: 6, cacheRead: 0.5, cacheWrite: 6.25 },
					{
						effectiveFrom: 1000,
						input: 3,
						output: 4,
						cacheRead: 0.3,
						cacheWrite: 3.75,
						longContext: {
							inputThreshold: 100,
							inputThresholdInclusive: true,
							input: 4,
							output: 8,
							cacheRead: 0.4,
							cacheWrite: 5,
						},
					},
				],
			},
		};
		const atThreshold = usage(40, 10, 20, 20);
		atThreshold.orchestration = { input: 10, output: 5, cacheRead: 10 };
		atThreshold.cttl = { ephemeral5m: 10, ephemeral1h: 5 };
		const charged = calculateUsageCost(cost, atThreshold, 1000);
		expect(charged.input).toBeCloseTo(((50 * 4) / 1e6) * 0.5, 12);
		expect(charged.output).toBeCloseTo(((15 * 8) / 1e6) * 0.5, 12);
		expect(charged.cacheRead).toBeCloseTo(((30 * 0.4) / 1e6) * 0.5, 12);
		expect(charged.cacheWrite).toBeCloseTo(((15 * 5 + 5 * 8) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 100, 999)).toBeCloseTo(((100 * 1) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 101, 999)).toBeCloseTo(((101 * 2) / 1e6) * 0.5, 12);
		expect(calculateUncachedInputCost(cost, 99, 1000)).toBeCloseTo(((99 * 3) / 1e6) * 0.5, 12);
		// A later full replacement without a tier must not inherit the base/previous tier.
		expect(calculateUncachedInputCost(cost, 101, 2000)).toBeCloseTo(((101 * 5) / 1e6) * 0.5, 12);
	});

	it("defaults scheduled pricing to now but never consults the clock for flat cards", () => {
		const clock = spyOn(Date, "now").mockReturnValue(offPeak);
		try {
			const flat = spec().cost;
			expect(calculateUsageCost(flat, usage()).total).toBeCloseTo(30, 12);
			expect(calculateUncachedInputCost(flat, 1_000_000)).toBeCloseTo(9, 12);
			expect(clock).not.toHaveBeenCalled();
			const scheduled = buildModel(spec()).cost;
			expect(calculateUsageCost(scheduled, usage()).total).toBeCloseTo(0.753, 12);
		} finally {
			clock.mockRestore();
		}
	});
});

describe("recurring tariff period and transitions", () => {
	const weekdayCost: ModelCost = {
		...spec().cost,
		timeBased: {
			offPeakMultiplier: 0.5,
			peakWindows: [
				{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
				{ weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
			],
		},
	};

	it("classifies window boundaries even when both periods have the same price", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 1,
				peakWindows: [{ weekdays: [1], startMinute: 60, endMinute: 120 }],
			},
		};
		const start = monday + 60 * 60_000;
		const end = monday + 120 * 60_000;
		expect(getTimeBasedPricingPeriod(cost, start - 1)).toBe("off-peak");
		expect(getTimeBasedPricingPeriod(cost, start)).toBe("peak");
		expect(getTimeBasedPricingPeriod(cost, end - 1)).toBe("peak");
		expect(getTimeBasedPricingPeriod(cost, end)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(cost, start - 1)).toBe(start);
		expect(getNextTimeBasedPricingTransition(cost, start)).toBe(end);
		expect(getNextTimeBasedPricingTransition(cost, end)).toBe(start + 7 * 86_400_000);
	});

	it("skips overlapping and touching edges rather than waking before the period changes", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [
					{ weekdays: [1], startMinute: 180, endMinute: 240 },
					{ weekdays: [1], startMinute: 60, endMinute: 120 },
					{ weekdays: [1], startMinute: 90, endMinute: 180 },
				],
			},
		};
		const start = monday + 60 * 60_000;
		const end = monday + 240 * 60_000;
		expect(getNextTimeBasedPricingTransition(cost, monday)).toBe(start);
		expect(getNextTimeBasedPricingTransition(cost, start)).toBe(end);
		expect(getNextTimeBasedPricingTransition(cost, monday + 120 * 60_000)).toBe(end);
		expect(getNextTimeBasedPricingTransition(cost, monday + 180 * 60_000)).toBe(end);
	});

	it("crosses the weekend to the next Monday window", () => {
		const cost = weekdayCost;
		const fridayEnd = monday + 4 * 86_400_000 + 600 * 60_000;
		const nextMondayStart = monday + 7 * 86_400_000 + 60 * 60_000;
		expect(getTimeBasedPricingPeriod(cost, fridayEnd)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(cost, fridayEnd)).toBe(nextMondayStart);
		expect(getNextTimeBasedPricingTransition(cost, monday + 6 * 86_400_000)).toBe(nextMondayStart);
	});

	it("merges touching midnight windows across the UTC week rollover", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [
					{ weekdays: [6], startMinute: 1380, endMinute: 1440 },
					{ weekdays: [0], startMinute: 0, endMinute: 60 },
				],
			},
		};
		const sunday = monday + 6 * 86_400_000;
		expect(getTimeBasedPricingPeriod(cost, sunday)).toBe("peak");
		expect(getNextTimeBasedPricingTransition(cost, sunday - 60_000)).toBe(sunday + 60 * 60_000);
		expect(getNextTimeBasedPricingTransition(cost, sunday)).toBe(sunday + 60 * 60_000);
	});

	it("does not schedule a timer when the weekly period never changes", () => {
		const cost: ModelCost = {
			...spec().cost,
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
			},
		};
		expect(getTimeBasedPricingPeriod(cost, monday)).toBe("peak");
		expect(getNextTimeBasedPricingTransition(cost, monday + 1)).toBeUndefined();
		const alwaysOffPeak: ModelCost = {
			...cost,
			timeBased: { offPeakMultiplier: 0.5, peakWindows: [] },
		};
		expect(getTimeBasedPricingPeriod(alwaysOffPeak, monday)).toBe("off-peak");
		expect(getNextTimeBasedPricingTransition(alwaysOffPeak, monday)).toBeUndefined();
	});

	it("consults the current clock only for scheduled cards with no supplied timestamp", () => {
		const clock = spyOn(Date, "now").mockReturnValue(peak);
		try {
			const flat = spec().cost;
			expect(getTimeBasedPricingPeriod(flat)).toBeUndefined();
			expect(getNextTimeBasedPricingTransition(flat)).toBeUndefined();
			const cost = weekdayCost;
			expect(getTimeBasedPricingPeriod(cost, offPeak)).toBe("off-peak");
			expect(getNextTimeBasedPricingTransition(cost, offPeak)).toBe(Date.parse("2026-09-10T06:00:00Z"));
			expect(clock).not.toHaveBeenCalled();
			expect(getTimeBasedPricingPeriod(cost)).toBe("peak");
			expect(getNextTimeBasedPricingTransition(cost)).toBe(Date.parse("2026-09-10T04:00:00Z"));
		} finally {
			clock.mockRestore();
		}
	});
});

function schedulePayload() {
	return {
		offPeakMultiplier: 0.5,
		peakWindows: { morning: { weekdays: "1,2,3,4,5", startMinute: 60, endMinute: 240 } },
		effectiveRates: {
			next: { effectiveFrom: "2026-09-14T04:00:00Z", input: 3, output: 4, cacheRead: 0.1, cacheWrite: 0 },
		},
	};
}

describe("financial schedule validation", () => {
	it("normalizes named KDL objects into an executable schedule", () => {
		const model = spec("custom-model", "custom");
		applyCatalogCorrections(model, { timeBased: schedulePayload() });
		expect(calculateUncachedInputCost(model.cost, 1_000_000, Date.parse("2026-09-14T04:00:00Z"))).toBeCloseTo(
			1.5,
			12,
		);
	});

	it("rejects malformed financial payloads instead of silently changing billing", () => {
		const valid = schedulePayload();
		const invalid = [
			{ ...valid, offPeakMultiplier: -0.5 },
			{ ...valid, offPeakMultiplier: Number.NaN },
			{ ...valid, peakWindows: [] },
			{ ...valid, peakWindows: { morning: { ...valid.peakWindows.morning, weekdays: "1,7" } } },
			{ ...valid, peakWindows: { morning: { ...valid.peakWindows.morning, weekdays: "1,1" } } },
			{ ...valid, peakWindows: { morning: { ...valid.peakWindows.morning, startMinute: 240 } } },
			{ ...valid, peakWindows: { morning: { ...valid.peakWindows.morning, endMinute: 1441 } } },
			{
				...valid,
				effectiveRates: { next: { ...valid.effectiveRates.next, effectiveFrom: "2026-02-30T04:00:00Z" } },
			},
			{ ...valid, effectiveRates: { next: { ...valid.effectiveRates.next, input: Infinity } } },
			{ ...valid, effectiveRates: { next: { ...valid.effectiveRates.next, longContext: { inputThreshold: 10 } } } },
			{ ...valid, effectiveRates: { first: valid.effectiveRates.next, second: valid.effectiveRates.next } },
			{ ...valid, peakWindow: valid.peakWindows },
		];
		for (const payload of invalid) expect(() => materializeTimeBasedCost(payload)).toThrow("Invalid time-based-cost");
		const serialized = materializeTimeBasedCost(valid);
		expect(
			isTimeBasedCost({
				...serialized,
				effectiveRates: [{ ...serialized.effectiveRates?.[0], effectiveFrom: Infinity }],
			}),
		).toBe(false);
	});
});

describe("pricing discovery and cache", () => {
	it("reapplies current first-party policy to stale cached rates without a schedule", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-scheduled-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const options = { providerId: "deepseek", staticModels: [], cacheDbPath: dbPath };
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [spec()] },
				"online",
			);
			expect(calculateCost(online.models[0]!, usage(), offPeak).total).toBeCloseTo(0.753, 12);
			const db = new Database(dbPath);
			try {
				db.run("UPDATE model_cache SET models = ? WHERE provider_id = ?", [JSON.stringify([spec()]), "deepseek"]);
			} finally {
				db.close();
			}
			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(calculateCost(offline.models[0]!, usage(), offPeak).total).toBeCloseTo(0.753, 12);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("retains custom static schedules when merging discovery ratecards and restoring cache", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-scheduled-merge-"));
		const base = spec("scheduled-model", "custom-scheduled");
		base.cost.timeBased = { offPeakMultiplier: 0.5, peakWindows: [] };
		const dynamic = { ...base, cost: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1 } };
		const options = { providerId: base.provider, staticModels: [base], cacheDbPath: path.join(tempDir, "models.db") };
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [dynamic] },
				"online",
			);
			expect(calculateCost(online.models[0]!, usage(), offPeak).total).toBeCloseTo(5, 12);
			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(calculateCost(offline.models[0]!, usage(), offPeak).total).toBeCloseTo(5, 12);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("deepseek provider metadata corrections", () => {
	// The bundled bare alias predates the discovery metadata that carries its
	// limits, and the agent sizes its context budget from the resolved model:
	// with a null window it skips over-context compaction entirely. The manager
	// takes spec-shaped rows and re-builds them, so the bundled row is cast here
	// exactly as the other catalog tests do.
	it("gives the bare Flash alias its documented limits through provider resolution", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-bare-alias-limits-"));
		const bundled = getBundledModels("deepseek").find(model => model.id === "deepseek-flash");
		if (!bundled) throw new Error("Expected a bundled deepseek-flash row");
		const staticSpec = bundled as ModelSpec<"openai-completions">;
		try {
			const { models } = await resolveProviderModels<"openai-completions">(
				{ providerId: "deepseek", staticModels: [staticSpec], cacheDbPath: path.join(tempDir, "models.db") },
				"offline",
			);
			const resolved = models.find(model => model.id === "deepseek-flash");
			expect(resolved?.contextWindow).toBe(1_000_000);
			expect(resolved?.maxTokens).toBe(384_000);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("materializes the bare Flash alias limits in the bundled row for offline startup", () => {
		// The registry serves committed rows verbatim on the cacheless,
		// pre-discovery path, so the documented 1M/384K limits must live in
		// models.json itself — not only in the live KDL rule.
		const bundled = getBundledModels("deepseek").find(model => model.id === "deepseek-flash");
		expect(bundled?.contextWindow).toBe(1_000_000);
		expect(bundled?.maxTokens).toBe(384_000);
	});
	it("resolves the V4.1 thinking ladder for the bare Flash alias", () => {
		const bundled = getBundledModels("deepseek").find(model => model.id === "deepseek-flash");
		if (!bundled) throw new Error("Expected a bundled deepseek-flash row");
		const resolved = buildModel(bundled as ModelSpec<"openai-completions">);
		expect(resolved.reasoning).toBe(true);
		expect(resolved.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	});
	it("upgrades a stale non-reasoning Flash alias spec to the V4.1 ladder", () => {
		const resolved = buildModel({ ...spec("deepseek-flash"), reasoning: false });
		expect(resolved.reasoning).toBe(true);
		expect(resolved.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});
	it("resolves the V4.1 tool-call replay contract for the bare Flash alias", () => {
		const bundled = getBundledModels("deepseek").find(model => model.id === "deepseek-flash");
		if (!bundled) throw new Error("Expected a bundled deepseek-flash row");
		const resolved = buildModel(bundled as ModelSpec<"openai-completions">);
		expect(resolved.compat.supportsToolChoice).toBe(false);
		expect(resolved.compat.maxTokensField).toBe("max_tokens");
		expect(resolved.compat.reasoningContentField).toBe("reasoning_content");
		expect(resolved.compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(resolved.compat.requiresAssistantContentForToolCalls).toBe(true);
		expect(resolved.compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});
});
