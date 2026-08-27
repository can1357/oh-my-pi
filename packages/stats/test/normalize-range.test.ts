import { describe, expect, it } from "bun:test";
import { normalizeTimeRange } from "../src/aggregator";

describe("normalizeTimeRange", () => {
	it("normalizes a recognized range to its canonical lowercase form", () => {
		expect(normalizeTimeRange("24h")).toBe("24h");
		expect(normalizeTimeRange(" 30D ")).toBe("30d");
		expect(normalizeTimeRange("ALL")).toBe("all");
	});

	it("returns the default range for a missing or blank value", () => {
		expect(normalizeTimeRange(undefined)).toBe("24h");
		expect(normalizeTimeRange(null)).toBe("24h");
		expect(normalizeTimeRange("   ")).toBe("24h");
	});

	it("returns null for an unrecognized value so callers can reject it", () => {
		expect(normalizeTimeRange("12x")).toBeNull();
		expect(normalizeTimeRange("last century")).toBeNull();
	});
});
