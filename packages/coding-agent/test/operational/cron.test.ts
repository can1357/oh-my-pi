import { describe, expect, it } from "bun:test";
import {
	CronHorizonError,
	CronValidationError,
	getNextOccurrenceUtc,
	parseCron,
	validateCron,
} from "../../src/operational";

describe("cron", () => {
	it("validates bounds, lists, ranges, and steps", () => {
		expect(() => validateCron("0 0 * * *")).not.toThrow();
		expect(() => validateCron("*/15 0-3 1,15 * 1-5")).not.toThrow();
		expect(() => validateCron("60 * * * *")).toThrow(CronValidationError);
		expect(() => validateCron("0 24 * * *")).toThrow(CronValidationError);
		expect(() => validateCron("0 0 32 * *")).toThrow(CronValidationError);
		expect(() => validateCron("0 0 * 13 *")).toThrow(CronValidationError);
		expect(() => validateCron("0 0 * * 8")).toThrow(CronValidationError);
		expect(() => validateCron("* * *")).toThrow(CronValidationError);
		expect(() => validateCron("0 0 * * 7")).not.toThrow();

		const parsed = parseCron("5,10-12,*/20 1-2/1 * 1-3 0,7");
		expect(parsed.minute.values.has(5)).toBe(true);
		expect(parsed.minute.values.has(11)).toBe(true);
		expect(parsed.minute.values.has(0)).toBe(true);
		expect(parsed.dayOfWeek.values.has(0)).toBe(true);
		expect(parsed.dayOfWeek.values.has(7)).toBe(false);
	});

	it("computes next UTC occurrence", () => {
		// 2024-01-01 00:00:00 UTC
		const after = Date.UTC(2024, 0, 1, 0, 0, 0);
		const next = getNextOccurrenceUtc("30 4 * * *", after);
		expect(next).toBe(Date.UTC(2024, 0, 1, 4, 30, 0));

		const afterSameMinute = Date.UTC(2024, 0, 1, 4, 30, 0);
		expect(getNextOccurrenceUtc("30 4 * * *", afterSameMinute)).toBe(Date.UTC(2024, 0, 2, 4, 30, 0));
	});

	it("applies standard DOM/DOW OR semantics when both are restricted", () => {
		// 2024-01-01 was Monday (dow=1). Expression: 0 0 1,15 * 5
		// Should fire on the 1st, the 15th, and every Friday.
		const after = Date.UTC(2023, 11, 31, 0, 0, 0);
		const first = getNextOccurrenceUtc("0 0 1,15 * 5", after);
		expect(first).toBe(Date.UTC(2024, 0, 1, 0, 0, 0)); // 1st

		const afterFirst = Date.UTC(2024, 0, 1, 0, 0, 0);
		const friday = getNextOccurrenceUtc("0 0 1,15 * 5", afterFirst);
		// 2024-01-05 is Friday
		expect(friday).toBe(Date.UTC(2024, 0, 5, 0, 0, 0));

		const afterFriday = Date.UTC(2024, 0, 5, 0, 0, 0);
		const nextFriday = getNextOccurrenceUtc("0 0 1,15 * 5", afterFriday);
		expect(nextFriday).toBe(Date.UTC(2024, 0, 12, 0, 0, 0));
	});

	it("uses only the restricted day field when the other is *", () => {
		const after = Date.UTC(2024, 0, 1, 0, 0, 0); // Monday
		const nextFriday = getNextOccurrenceUtc("0 9 * * 5", after);
		expect(nextFriday).toBe(Date.UTC(2024, 0, 5, 9, 0, 0));

		const nextDom = getNextOccurrenceUtc("0 9 10 * *", after);
		expect(nextDom).toBe(Date.UTC(2024, 0, 10, 9, 0, 0));
	});

	it("errors when no occurrence exists inside the horizon", () => {
		const after = Date.UTC(2024, 0, 1, 0, 0, 0);
		expect(() => getNextOccurrenceUtc("0 0 29 2 *", after, 30 * 24 * 60 * 60 * 1000)).toThrow(CronHorizonError);
	});
});
