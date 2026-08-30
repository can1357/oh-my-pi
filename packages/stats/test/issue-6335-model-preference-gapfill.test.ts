import { describe, expect, test } from "bun:test";
import { buildModelPreferenceSeries } from "../src/client/routes/ModelsRoute";
import type { ModelTimeSeriesPoint, TimeRange } from "../src/client/types";

// Issue #6335: the Model Preference chart plotted only the buckets that had at
// least one request, so a category x-axis rendered gaps as adjacent points and
// the time axis became non-uniform. buildModelPreferenceSeries must pre-fill
// one row per range bucket (mirroring buildModelPerformanceLookup) so every
// fixed range yields a uniform grid; the "all" range keeps sparse timestamps.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function point(timestamp: number, model: string, requests: number): ModelTimeSeriesPoint {
	return { timestamp, model, provider: "prov", requests };
}

describe("issue #6335: model preference series bucket grid", () => {
	test("24h range fills every hour bucket, uniformly spaced, anchored at the last observed bucket", () => {
		const anchor = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
		const older = anchor - 5 * HOUR;
		const points = [point(older, "model-a", 10), point(anchor, "model-a", 3), point(anchor, "model-b", 1)];

		const { data, series } = buildModelPreferenceSeries(points, "24h" as TimeRange);

		expect(series).toEqual(["model-a", "model-b"]);
		expect(data.length).toBe(24);
		// Uniform grid ending at the last observed bucket.
		for (let i = 0; i < data.length; i++) {
			expect(data[i]?.timestamp).toBe(anchor - (23 - i) * HOUR);
		}
		// Populated buckets keep their request shares.
		const olderRow = data.find(row => row.timestamp === older);
		expect(olderRow?.["model-a"]).toBe(100);
		expect(olderRow?.["model-b"]).toBe(0);
		const lastRow = data[data.length - 1];
		expect(lastRow?.["model-a"]).toBe(75);
		expect(lastRow?.["model-b"]).toBe(25);
		// Empty buckets render as zero shares, not missing rows.
		const emptyRow = data.find(row => row.timestamp === anchor - 1 * HOUR);
		expect(emptyRow).toBeDefined();
		expect(emptyRow?.total).toBe(0);
		expect(emptyRow?.["model-a"]).toBe(0);
		expect(emptyRow?.["model-b"]).toBe(0);
	});

	test("7d range fills every day bucket", () => {
		const anchor = Math.floor(1_700_000_000_000 / DAY) * DAY;
		const points = [point(anchor - 6 * DAY, "model-a", 4), point(anchor, "model-a", 2)];

		const { data } = buildModelPreferenceSeries(points, "7d" as TimeRange);

		expect(data.length).toBe(7);
		for (let i = 1; i < data.length; i++) {
			expect((data[i]?.timestamp ?? 0) - (data[i - 1]?.timestamp ?? 0)).toBe(DAY);
		}
	});

	test("out-of-grid points are kept rather than dropped", () => {
		const anchor = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
		// A stale bucket older than the 24-bucket window must still appear.
		const stale = anchor - 30 * HOUR;
		const points = [point(stale, "model-a", 1), point(anchor, "model-a", 1)];

		const { data } = buildModelPreferenceSeries(points, "24h" as TimeRange);

		expect(data.length).toBe(25);
		expect(data[0]?.timestamp).toBe(stale);
		expect(data[0]?.["model-a"]).toBe(100);
	});

	test("'all' range keeps the sparse observed timestamps", () => {
		const base = Math.floor(1_700_000_000_000 / DAY) * DAY;
		const points = [point(base, "model-a", 1), point(base + 9 * DAY, "model-a", 2)];

		const { data } = buildModelPreferenceSeries(points, "all" as TimeRange);

		expect(data.map(row => row.timestamp)).toEqual([base, base + 9 * DAY]);
	});

	test("empty input still short-circuits to an empty result", () => {
		expect(buildModelPreferenceSeries([], "24h" as TimeRange)).toEqual({ data: [], series: [] });
	});
});
