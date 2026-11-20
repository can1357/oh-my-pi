import { describe, expect, it } from "bun:test";
import type { Schedule } from "../extension/messages";
import { nextRunAt, planSchedule } from "../extension/worker/schedules";

const local = (year: number, month: number, day: number, hour = 0, minute = 0) =>
	new Date(year, month - 1, day, hour, minute).getTime();

describe("shortcut schedule occurrences", () => {
	it("fires a valid one-off date only in the future", () => {
		const schedule: Schedule = { kind: "once", date: "2028-02-29", time: "08:15" };
		const at = local(2028, 2, 29, 8, 15);
		expect(nextRunAt(schedule, at - 1)).toBe(at);
		expect(nextRunAt(schedule, at)).toBeUndefined();
		expect(nextRunAt({ ...schedule, date: "2027-02-29" }, local(2027, 1, 1))).toBeUndefined();
	});

	it("advances daily and weekly schedules from the exact occurrence to the next local date", () => {
		const now = local(2026, 11, 20, 9, 0); // Friday
		expect(nextRunAt({ kind: "daily", time: "09:00" }, now)).toBe(local(2026, 11, 21, 9));
		expect(nextRunAt({ kind: "weekly", weekday: 5, time: "09:00" }, now)).toBe(local(2026, 11, 27, 9));
		expect(nextRunAt({ kind: "weekly", weekday: 0, time: "09:00" }, now)).toBe(local(2026, 11, 22, 9));
	});

	it("clamps monthly schedules to the last day without changing the next month's requested day", () => {
		const schedule: Schedule = { kind: "monthly", day: 31, time: "08:00" };
		expect(nextRunAt(schedule, local(2027, 1, 31, 9))).toBe(local(2027, 2, 28, 8));
		expect(nextRunAt(schedule, local(2027, 2, 28, 8))).toBe(local(2027, 3, 31, 8));
		expect(nextRunAt(schedule, local(2027, 12, 31, 8))).toBe(local(2028, 1, 31, 8));
	});

	it("clamps an annual leap-day shortcut in ordinary years and restores February 29 in leap years", () => {
		const schedule: Schedule = { kind: "yearly", month: 2, day: 29, time: "11:30" };
		expect(nextRunAt(schedule, local(2027, 1, 1))).toBe(local(2027, 2, 28, 11, 30));
		expect(nextRunAt(schedule, local(2027, 2, 28, 11, 30))).toBe(local(2028, 2, 29, 11, 30));
	});

	it("shifts through spring's missing time and does not run twice in fall's repeated hour", () => {
		const previous = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const spring: Schedule = { kind: "daily", time: "02:30" };
			const gap = Date.parse("2026-03-08T07:30:00Z");
			expect(nextRunAt(spring, Date.parse("2026-03-08T05:00:00Z"))).toBe(gap);
			expect(nextRunAt(spring, gap)).toBe(Date.parse("2026-03-09T06:30:00Z"));
			const fall: Schedule = { kind: "weekly", weekday: 0, time: "01:30" };
			expect(nextRunAt(fall, Date.parse("2026-11-01T04:00:00Z"))).toBe(Date.parse("2026-11-01T05:30:00Z"));
			expect(nextRunAt(fall, Date.parse("2026-11-01T06:00:00Z"))).toBe(Date.parse("2026-11-08T06:30:00Z"));
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	});

	it("catches up an overdue recurring or once schedule exactly once, regardless of missed ticks", () => {
		const now = local(2026, 11, 20, 17);
		const missed = local(2026, 11, 1, 9);
		const daily: Schedule = { kind: "daily", time: "09:00" };
		const first = planSchedule(daily, now, missed);
		expect(first).toEqual({ due: true, nextAt: local(2026, 11, 21, 9) });
		expect(planSchedule(daily, now, first.nextAt)).toEqual({ due: false, nextAt: first.nextAt });
		const once: Schedule = { kind: "once", date: "2026-11-01", time: "09:00" };
		expect(planSchedule(once, now, missed)).toEqual({ due: true, nextAt: undefined });
		expect(planSchedule(once, now)).toEqual({ due: false, nextAt: undefined });
	});
});
