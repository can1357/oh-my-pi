import { describe, expect, test } from "bun:test";
import { shortAge } from "../src/components/Sidebar";

/**
 * The sidebar lists sessions whose titles repeat — three called "hola" is
 * normal — and nothing on the row told them apart. This is what does.
 *
 * Coarse by design: it is a disambiguator, not a clock, so the boundaries only
 * have to be sane, never precise.
 */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("shortAge", () => {
	test("minutes, then hours, then days, then weeks", () => {
		expect(shortAge(ago(5 * MIN))).toBe("5m");
		expect(shortAge(ago(3 * HOUR))).toBe("3h");
		expect(shortAge(ago(2 * DAY))).toBe("2d");
		expect(shortAge(ago(14 * DAY))).toBe("2w");
	});

	test("months past a month", () => {
		expect(shortAge(ago(60 * DAY))).toBe("2mo");
	});

	test("just now is 0m, not a negative or an empty cell", () => {
		expect(shortAge(new Date().toISOString())).toBe("0m");
	});

	test("a clock skewed into the future clamps rather than showing -3m", () => {
		expect(shortAge(new Date(Date.now() + 3 * MIN).toISOString())).toBe("0m");
	});

	test("an unparseable date renders nothing at all", () => {
		// Old sessions can carry junk here; a row reading "NaNm" would be worse
		// than a row with no age.
		expect(shortAge("")).toBe("");
		expect(shortAge("not a date")).toBe("");
	});
});
