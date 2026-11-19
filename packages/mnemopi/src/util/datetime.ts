import { recencyHalflifeHours } from "../config";
import { LruCache } from "./lru";

const TZ_RE = /(?:Z|[+-]\d\d:?\d\d)$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_CACHE = new LruCache<string, Date>(2000);

export type QueryTime = string | Date | null | undefined;

export function parseIsoDateTimeUtc(value: string): Date {
	let text = value.trim();
	if (!text) throw new RangeError("Invalid ISO datetime: empty string");
	if (DATE_ONLY_RE.test(text)) text += "T00:00:00Z";
	else if (!TZ_RE.test(text)) text += "Z";
	const date = new Date(text);
	if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO datetime: ${value}`);
	return date;
}

export function normalizeDateTimeUtc(value: Date): Date {
	const time = value.getTime();
	if (Number.isNaN(time)) throw new RangeError("Invalid Date");
	return new Date(time);
}

export function parseQueryTime(value: QueryTime): Date {
	if (value === null || value === undefined) return new Date();
	return typeof value === "string" ? parseIsoDateTimeUtc(value) : normalizeDateTimeUtc(value);
}

export function parseTsFast(value: string): Date | undefined {
	if (!value) return undefined;
	const cached = TS_CACHE.get(value);
	if (cached !== undefined) return cached;
	try {
		const parsed = parseIsoDateTimeUtc(value);
		TS_CACHE.set(value, parsed);
		return parsed;
	} catch {
		return undefined;
	}
}

export function toUtcIso(value: Date = new Date()): string {
	return normalizeDateTimeUtc(value).toISOString();
}

export function recencyDecay(
	timestamp: string | Date | null | undefined,
	halflifeHours = recencyHalflifeHours(),
	now: Date = new Date(),
): number {
	if (!timestamp) return 0.5;
	try {
		const ts = typeof timestamp === "string" ? parseIsoDateTimeUtc(timestamp) : normalizeDateTimeUtc(timestamp);
		const ageHours = (now.getTime() - ts.getTime()) / 3_600_000;
		return Math.exp(-ageHours / halflifeHours);
	} catch {
		return 0.5;
	}
}

export function temporalBoost(memoryTimestamp: string, queryTime: QueryTime = undefined, halflifeHours = 24): number {
	let ts = parseTsFast(memoryTimestamp);
	if (ts === undefined) return 0;
	const query = parseQueryTime(queryTime);
	if (ts.getTime() > query.getTime()) ts = query;
	return Math.exp(-((query.getTime() - ts.getTime()) / 3_600_000) / halflifeHours);
}
