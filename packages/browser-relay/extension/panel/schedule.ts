/** Schedule wording and time-entry helpers for the shortcut editor; run times come from the worker's own calendar. */
import type { Schedule } from "../messages";
import { nextRunAt } from "../worker/schedules";

/** Short weekday names, Sunday first (matches `Date#getDay` and `Schedule.weekday`). */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Short month names, January first. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Every quarter hour of the day as `HH:MM`: the 96 entries of the time list. */
export const QUARTER_HOURS: readonly string[] = Array.from(
	{ length: 96 },
	(_, index) => `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`,
);

/** `HH:MM` from what people type: `9`, `9am`, `9:30 pm`, `0930`, `21:15`. Null when it is not a time. */
export function parseTime(raw: string): string | null {
	const match = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?\s*$/i.exec(raw);
	if (match === null) return null;
	let hour = Number(match[1]);
	const minute = match[2] === undefined ? 0 : Number(match[2]);
	const meridiem = match[3]?.toLowerCase()[0];
	if (minute > 59) return null;
	if (meridiem !== undefined) {
		if (hour < 1 || hour > 12) return null;
		hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
	} else if (hour > 23) return null;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Local `YYYY-MM-DD` for a date input. */
export function isoDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The schedule in a few words: “Daily 09:00”, “Mon 09:00”, “Monthly on the 1st 09:00”. */
export function scheduleCaption(schedule: Schedule): string {
	switch (schedule.kind) {
		case "once":
			return `Once ${schedule.date} ${schedule.time}`;
		case "daily":
			return `Daily ${schedule.time}`;
		case "weekly":
			return `${WEEKDAYS[schedule.weekday]} ${schedule.time}`;
		case "monthly":
			return `Monthly on ${schedule.day} · ${schedule.time}`;
		case "yearly":
			return `${MONTHS[schedule.month - 1] ?? "?"} ${schedule.day} ${schedule.time}`;
	}
}

/** “Next: Mon 09:00”, with the date once it is more than six days out; null when the schedule never runs again. */
export function nextRunLabel(schedule: Schedule, now: number): string | null {
	const at = nextRunAt(schedule, now);
	if (at === undefined) return null;
	const date = new Date(at);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const days = Math.floor((at - now) / 86_400_000);
	if (days < 6) return `Next: ${WEEKDAYS[date.getDay()]} ${time}`;
	const year = date.getFullYear() === new Date(now).getFullYear() ? "" : ` ${date.getFullYear()}`;
	return `Next: ${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${time}`;
}
