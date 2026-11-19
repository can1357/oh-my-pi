import { describe, expect, it } from "bun:test";
import { bucketAxis } from "../src/client/data/range";
import { parseHash } from "../src/client/data/useHashRoute";

const HOUR_MS = 3_600_000;

describe("client time ranges", () => {
	it("bucketAxis 2d spans 48 hours ending at the current hour", () => {
		const now = Date.UTC(2026, 10, 19, 14, 37, 12);
		const buckets = bucketAxis("2d", [], undefined, now);
		expect(buckets).toHaveLength(49);
		expect(buckets[0]).toBe(Math.floor((now - 2 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS);
		expect(buckets.at(-1)).toBe(Math.floor(now / HOUR_MS) * HOUR_MS);
		for (let i = 1; i < buckets.length; i++) expect(buckets[i] - buckets[i - 1]).toBe(HOUR_MS);
	});

	it("accepts 2d and 3d in deep links and falls back to 24h for unknown values", () => {
		expect(parseHash("#/overview?range=2d").range).toBe("2d");
		expect(parseHash("#/overview?range=3d").range).toBe("3d");
		expect(parseHash("#/overview?range=2w").range).toBe("24h");
	});
});
