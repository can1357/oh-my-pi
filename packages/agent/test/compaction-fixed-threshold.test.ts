import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";

const fixed = (thresholdTokens: number, extra: Partial<CompactionSettings> = {}): CompactionSettings => ({
	enabled: true,
	thresholdPercent: -1,
	thresholdTokens,
	keepRecentTokens: 20000,
	...extra,
});

describe("fixed compaction trigger near the window", () => {
	// A provider capping the model below the configured trigger (Factory serves Kimi K3 with 196,608).
	const window = 196_608;
	// max(floor(196608 * 0.15), 16384) = 29,491 reserved for the next prompt and response.
	const budget = window - 29_491;

	it("compacts a trigger at or past the window at the window less its reserve", () => {
		expect(resolveBudgetReserveTokens(window, fixed(300_000))).toBe(29_491);
		expect(resolveThresholdTokens(window, fixed(300_000))).toBe(budget);
		expect(resolveThresholdTokens(window, fixed(window))).toBe(budget);
		expect(shouldCompact(budget, window, fixed(300_000))).toBe(false);
		expect(shouldCompact(budget + 1, window, fixed(300_000))).toBe(true);
		// The same budget the reserve-based default compacts at.
		expect(resolveThresholdTokens(window, fixed(-1))).toBe(budget);
	});

	it("keeps a trigger below the window exact", () => {
		expect(resolveThresholdTokens(window, fixed(window - 1))).toBe(window - 1);
		expect(resolveThresholdTokens(window, fixed(budget + 1))).toBe(budget + 1);
		expect(resolveThresholdTokens(window, fixed(100_000))).toBe(100_000);
		expect(resolveThresholdTokens(1_000_000, fixed(300_000))).toBe(300_000);
	});

	it("uses an explicit reserve as the budget", () => {
		expect(resolveThresholdTokens(200_000, fixed(250_000, { reserveTokens: 50_000 }))).toBe(150_000);
		expect(resolveThresholdTokens(200_000, fixed(180_000, { reserveTokens: 50_000 }))).toBe(180_000);
	});

	it("falls back to the 15% reserve on small windows", () => {
		// The default 16,384 reserve would leave a 16,385 window one token; floor(16385 * 0.15) = 2,457 applies.
		expect(resolveBudgetReserveTokens(16_385, fixed(20_000))).toBe(2_457);
		expect(resolveThresholdTokens(16_385, fixed(20_000))).toBe(13_928);
		expect(resolveThresholdTokens(16_385, fixed(10_000))).toBe(10_000);
		// Degenerate windows stay strictly below the window and never go negative.
		expect(resolveThresholdTokens(2, fixed(5))).toBe(1);
		expect(resolveThresholdTokens(1, fixed(5))).toBe(0);
	});
});
