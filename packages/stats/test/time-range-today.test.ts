import { describe, expect, it } from "bun:test";
import { getTimeRangeConfig } from "@oh-my-pi/omp-stats/aggregator";

describe("getTimeRangeConfig 'today'", () => {
	it("anchors the cutoff at local midnight with hourly buckets", () => {
		const config = getTimeRangeConfig("today");
		const midnight = new Date();
		midnight.setHours(0, 0, 0, 0);

		expect(config.cutoff).toBe(midnight.getTime());
		// Hourly bucketing like "24h" — a same-day window still yields an
		// intra-day series.
		expect(config.timeSeriesBucketMs).toBe(60 * 60 * 1000);
	});

	it("is case-insensitive and trims input like other ranges", () => {
		const config = getTimeRangeConfig("  TODAY ");
		const midnight = new Date();
		midnight.setHours(0, 0, 0, 0);
		expect(config.cutoff).toBe(midnight.getTime());
	});

	it("keeps rolling-window ranges distinct from today", () => {
		const rolling = getTimeRangeConfig("24h");
		const today = getTimeRangeConfig("today");
		// Rolling cutoff is now-minus-24h; local midnight always falls inside
		// that window, so today's cutoff must be at or after it.
		expect(rolling.cutoff).not.toBeNull();
		expect(today.cutoff).not.toBeNull();
		expect(today.cutoff!).toBeGreaterThanOrEqual(rolling.cutoff!);
	});

	it("still resolves the known rolling ranges", () => {
		expect(getTimeRangeConfig("7d").timeSeriesBucketMs).toBe(24 * 60 * 60 * 1000);
		expect(getTimeRangeConfig("all").cutoff).toBeNull();
	});
});
