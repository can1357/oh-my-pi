import { parseQueryTime, type QueryTime } from "../util/datetime";

export type DatePrecision = "day" | "week" | "month" | "year" | "relative" | "unknown";
export type ParsedNaturalDate = [eventDate: Date, precision: Exclude<DatePrecision, "unknown">, temporalTags: string[]];

export interface TemporalInfo {
	event_date: string | null;
	event_date_precision: DatePrecision;
	temporal_tags: string[];
	primary_signal: string | null;
}

const MS_PER_DAY = 86_400_000;

// Day name -> weekday number (Monday=0, Sunday=6), matching Python datetime.weekday().
export const DAY_MAP: Readonly<Record<string, number>> = {
	monday: 0,
	tuesday: 1,
	wednesday: 2,
	thursday: 3,
	friday: 4,
	saturday: 5,
	sunday: 6,
	mon: 0,
	tue: 1,
	wed: 2,
	thu: 3,
	fri: 4,
	sat: 5,
	sun: 6,
};

export const MONTH_MAP: Readonly<Record<string, number>> = {
	january: 1,
	february: 2,
	march: 3,
	april: 4,
	may: 5,
	june: 6,
	july: 7,
	august: 8,
	september: 9,
	october: 10,
	november: 11,
	december: 12,
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

export const NAMED_TIMES: Readonly<Record<string, readonly [startHour: number, endHour: number]>> = {
	morning: [6, 12],
	afternoon: [12, 17],
	evening: [17, 21],
	night: [21, 6],
	midnight: [0, 1],
	noon: [12, 13],
	dawn: [5, 7],
	dusk: [18, 21],
};

const NAMED_TIME_KEYS = ["morning", "afternoon", "evening", "night", "midnight", "noon", "dawn", "dusk"] as const;

function dateUtc(year: number, month: number, day: number): Date | undefined {
	const value = new Date(Date.UTC(year, month - 1, day));
	if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
		return undefined;
	}
	return value;
}

function addDays(value: Date, days: number): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addSeconds(value: Date, seconds: number): Date {
	return addDays(new Date(value.getTime() + seconds * 1000), 0);
}

function dateOnly(value: Date): Date {
	return dateUtc(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) as Date;
}

function isoDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function pythonWeekday(value: Date): number {
	return (value.getUTCDay() + 6) % 7;
}

function dayName(value: Date): string {
	const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
	return names[value.getUTCDay()] as string;
}

function isoWeek(value: Date): number {
	const d = dateOnly(value);
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
}

function finiteDate(value: Date): Date | undefined {
	return Number.isFinite(value.getTime()) ? value : undefined;
}

function parseReference(reference?: QueryTime): Date {
	return parseQueryTime(reference);
}

export function resolveRelativeDay(reference: Date, dayNameText: string, qualifier = "this"): Date {
	const targetWd = DAY_MAP[dayNameText.toLowerCase()];
	if (targetWd === undefined) return dateOnly(reference);

	const currentWd = pythonWeekday(reference);
	if (qualifier === "this") {
		const diff = (currentWd - targetWd + 7) % 7;
		return addDays(reference, -diff);
	}
	if (qualifier === "last") {
		const diff = ((currentWd - targetWd + 7) % 7) + 7;
		return addDays(reference, -diff);
	}
	if (qualifier === "next") {
		let diff = (targetWd - currentWd + 7) % 7;
		if (diff === 0) diff = 7;
		return addDays(reference, diff);
	}
	return dateOnly(reference);
}

function tagsForDay(value: Date): string[] {
	return [isoDate(value), `week-${isoWeek(value)}-${value.getUTCFullYear()}`, dayName(value)];
}

function deltaDate(reference: Date, num: number, unit: string, direction: 1 | -1): Date | undefined {
	if (!Number.isSafeInteger(num)) return undefined;
	let days = 0;
	switch (unit) {
		case "second":
			return finiteDate(addSeconds(reference, direction * num));
		case "minute":
			return finiteDate(addSeconds(reference, direction * num * 60));
		case "hour":
			return finiteDate(addSeconds(reference, direction * num * 3600));
		case "day":
			days = num;
			break;
		case "week":
			days = num * 7;
			break;
		case "month":
			days = num * 30;
			break;
		case "year":
			days = num * 365;
			break;
		default:
			return undefined;
	}
	return finiteDate(addDays(reference, direction * days));
}

export function parseNlDate(text: string, reference?: QueryTime): ParsedNaturalDate | null {
	const ref = parseReference(reference);
	const textLower = text.toLowerCase().trim();

	let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
	if (m !== null) {
		const year = Number.parseInt(m[1] as string, 10);
		const month = Number.parseInt(m[2] as string, 10);
		const day = Number.parseInt(m[3] as string, 10);
		const d = dateUtc(year, month, day);
		if (d !== undefined) return [d, "day", tagsForDay(d)];
	}

	m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
	if (m !== null) {
		const a = Number.parseInt(m[1] as string, 10);
		const b = Number.parseInt(m[2] as string, 10);
		let y = Number.parseInt(m[3] as string, 10);
		if (y < 100) y += 2000;
		const d = a > 12 ? dateUtc(y, b, a) : dateUtc(y, a, b);
		if (d !== undefined) return [d, "day", tagsForDay(d)];
	}

	m =
		/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/.exec(
			textLower,
		);
	if (m !== null) {
		const month = MONTH_MAP[m[1] as string] ?? 1;
		const day = Number.parseInt(m[2] as string, 10);
		const year = m[3] === undefined ? ref.getUTCFullYear() : Number.parseInt(m[3], 10);
		const d = dateUtc(year, month, day);
		if (d !== undefined) return [d, "day", tagsForDay(d)];
	}

	if (/\btoday\b/.test(textLower)) {
		const d = dateOnly(ref);
		return [d, "day", [isoDate(d), dayName(d)]];
	}

	if (/\byesterday\b/.test(textLower)) {
		const d = addDays(ref, -1);
		return [d, "day", [isoDate(d), dayName(d), "yesterday"]];
	}

	if (/\btomorrow\b/.test(textLower)) {
		const d = addDays(ref, 1);
		return [d, "day", [isoDate(d), dayName(d), "tomorrow"]];
	}

	if (/\bday before yesterday\b/.test(textLower) || /\bday\s+before\s+yesterday\b/.test(textLower)) {
		const d = addDays(ref, -2);
		return [d, "day", [isoDate(d)]];
	}

	m =
		/\b(last|this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/.exec(
			textLower,
		);
	if (m !== null) {
		const qualifier = m[1] as string;
		const parsedDayName = m[2] as string;
		const d = resolveRelativeDay(ref, parsedDayName, qualifier);
		return [d, "day", [isoDate(d), `week-${isoWeek(d)}-${d.getUTCFullYear()}`, parsedDayName, qualifier]];
	}

	m = /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(textLower);
	if (m !== null) {
		const parsedDayName = m[2] as string;
		const d = resolveRelativeDay(ref, parsedDayName, "this");
		return [d, "day", [isoDate(d), `week-${isoWeek(d)}-${d.getUTCFullYear()}`, parsedDayName]];
	}

	m = /\b(this|last|next)\s+(week|month|year)\b/.exec(textLower);
	if (m !== null) {
		const qualifier = m[1] as string;
		const unit = m[2] as string;
		const refDate = dateOnly(ref);
		if (qualifier === "this") {
			if (unit === "week")
				return [refDate, "week", [`week-${isoWeek(refDate)}-${refDate.getUTCFullYear()}`, "this-week"]];
			if (unit === "month")
				return [
					refDate,
					"month",
					[`${refDate.getUTCFullYear()}-${String(refDate.getUTCMonth() + 1).padStart(2, "0")}`, "this-month"],
				];
			if (unit === "year") return [refDate, "year", [String(refDate.getUTCFullYear()), "this-year"]];
		} else if (qualifier === "last") {
			if (unit === "week") {
				const d = addDays(ref, -7);
				return [d, "week", [`week-${isoWeek(d)}-${d.getUTCFullYear()}`, "last-week"]];
			}
			if (unit === "month") {
				const year = ref.getUTCMonth() === 0 ? ref.getUTCFullYear() - 1 : ref.getUTCFullYear();
				const month = ref.getUTCMonth() === 0 ? 12 : ref.getUTCMonth();
				const d = dateUtc(year, month, 1) as Date;
				return [
					d,
					"month",
					[`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, "last-month"],
				];
			}
			if (unit === "year") {
				const d = dateUtc(ref.getUTCFullYear() - 1, 1, 1) as Date;
				return [d, "year", [String(d.getUTCFullYear()), "last-year"]];
			}
		} else if (qualifier === "next") {
			if (unit === "week") {
				const d = addDays(ref, 7);
				return [d, "week", [`week-${isoWeek(d)}-${d.getUTCFullYear()}`, "next-week"]];
			}
			if (unit === "month") {
				const year = ref.getUTCMonth() === 11 ? ref.getUTCFullYear() + 1 : ref.getUTCFullYear();
				const month = ref.getUTCMonth() === 11 ? 1 : ref.getUTCMonth() + 2;
				const d = dateUtc(year, month, 1) as Date;
				return [
					d,
					"month",
					[`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, "next-month"],
				];
			}
			if (unit === "year") {
				const d = dateUtc(ref.getUTCFullYear() + 1, 1, 1) as Date;
				return [d, "year", [String(d.getUTCFullYear()), "next-year"]];
			}
		}
	}

	m = /\b(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+(ago|before|earlier|back)\b/.exec(textLower);
	if (m !== null) {
		const num = Number.parseInt(m[1] as string, 10);
		const unit = m[2] as string;
		const d = deltaDate(ref, num, unit, -1);
		if (d === undefined) return null;
		return [d, unit === "day" || unit === "hour" ? "day" : "week", [isoDate(d), `${num}-${unit}s-ago`]];
	}

	m = /\bin\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?\b/.exec(textLower);
	if (m !== null) {
		const num = Number.parseInt(m[1] as string, 10);
		const unit = m[2] as string;
		const d = deltaDate(ref, num, unit, 1);
		if (d === undefined) return null;
		return [d, unit === "day" || unit === "hour" ? "day" : "week", [isoDate(d), `in-${num}-${unit}s`]];
	}

	if (/\b(recently|lately|not long ago)\b/.test(textLower)) {
		return [dateOnly(ref), "relative", ["recently"]];
	}

	if (/\b(a while ago|some time ago|long ago)\b/.test(textLower)) {
		return [dateOnly(ref), "relative", ["vague"]];
	}

	return null;
}

export function extractTemporal(text: string, reference?: QueryTime): TemporalInfo {
	const result = parseNlDate(text, reference);
	const tags: string[] = [];
	const textLower = text.toLowerCase();
	for (const timeName of NAMED_TIME_KEYS) {
		if (textLower.includes(timeName)) {
			tags.push(timeName);
			break;
		}
	}

	if (result === null) {
		return {
			event_date: null,
			event_date_precision: "unknown",
			temporal_tags: tags,
			primary_signal: tags[0] ?? null,
		};
	}

	const [eventDate, precision, parsedTags] = result;
	const allTags = parsedTags.concat(tags);
	return {
		event_date: isoDate(eventDate),
		event_date_precision: precision,
		temporal_tags: allTags,
		primary_signal: allTags[0] ?? null,
	};
}

export function extractDateFromText(text: string, reference?: QueryTime): string | null {
	return extractTemporal(text, reference).event_date;
}
