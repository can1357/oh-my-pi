import { describe, expect, it } from "bun:test";
import { rangeMeta } from "../src/client/components/range-meta";
import type { TimeRange } from "../src/client/types";

describe("client range-meta today", () => {
	it("exposes hourly bucketing like 24h", () => {
		const today = rangeMeta("today" as TimeRange);
		const day = rangeMeta("24h");
		expect(today.bucketMs).toBe(day.bucketMs);
		expect(today.bucketCount).toBe(24);
		expect(today.tickFormat).toBe("HH:mm");
		expect(today.windowLabel).toContain("midnight");
		expect(today.trendLabel).toBe("Today");
	});

	it("keeps other ranges intact", () => {
		expect(rangeMeta("1h").bucketCount).toBe(12);
		expect(rangeMeta("7d").bucketMs).toBe(24 * 60 * 60 * 1000);
		expect(rangeMeta("all").windowLabel).toBe("all time");
	});
});
