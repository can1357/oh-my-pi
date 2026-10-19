import { describe, expect, it } from "bun:test";
import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction/compaction";

const base: CompactionSettings = { enabled: true, thresholdPercent: -1, thresholdTokens: -1, keepRecentTokens: 20000 };
const window = 1_000_000;

describe("baseWindowTokens", () => {
	it("rescales the reserve and percentage policies from the base", () => {
		// 400K base minus max(15%, 16384) = 340K, instead of 850K on the real window.
		expect(resolveThresholdTokens(window, { ...base, baseWindowTokens: 400_000 })).toBe(340_000);
		expect(resolveThresholdTokens(window, { ...base, thresholdPercent: 80, baseWindowTokens: 400_000 })).toBe(
			320_000,
		);
	});

	it("leaves a fixed threshold clamped to the real window, not the base", () => {
		expect(resolveThresholdTokens(window, { ...base, thresholdTokens: 500_000, baseWindowTokens: 400_000 })).toBe(
			500_000,
		);
	});
});
