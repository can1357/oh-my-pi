import { scheduler } from "node:timers/promises";

// "reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// JSON field: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// "try again in 250ms" / "try again in 12s" / "try again in 12sec" /
// "try again in 5 min" / "try again in ~158 min." / "try again in 2h" /
// "try again in 90 minutes" / "try again in 1 hour"
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// "Your limit will reset in 13 minutes" / "reset in 13 minutes" / "will reset in 2h"
// OpenCode Go quota errors use "Resets in …" with day units and compound
// remainders ("Resets in 3 days", "Resets in 2hr 15min", "Resets in 45min").
const WILL_RESET_IN_PATTERN =
	/(?:will\s+)?resets?\s+in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
// OpenCode Go compound remainder: "Resets in 2hr 15min".
const RESET_IN_HR_MIN_PATTERN = /resets?\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*hr\s*(\d+(?:\.\d+)?)\s*min\b/i;
// "Your limit will reset at 2026-09-01 09:44:51" / "reset at 2026-09-01T09:44:51Z"
const WILL_RESET_AT_PATTERN =
	/(?:will\s+)?reset at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;
// Both grammars carry a timezone-naive wall clock. The default reading is UTC;
// a provider-specific offset (Z.AI/Zhipu Beijing time) is applied only through
// `RetryHintOptions.naiveResetTimezoneOffset`, never inferred from the language.
const CN_RESET_AT_PATTERN = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/;
const RESET_AT_PATTERNS: readonly RegExp[] = [WILL_RESET_AT_PATTERN, CN_RESET_AT_PATTERN];
// "retry-after-ms=98497000" / "retry-after-ms: 7200000" / "retry-after-ms = 7200000"
const RETRY_AFTER_MS_BODY_PATTERN = /\bretry-after-ms\s*[:=]\s*([0-9]+)\b/i;
// Legacy text form "retry-after: 30" (a delta in seconds, or a timestamp written
// as one token) and the `x-ratelimit-reset[-ms]` counters folded into a message.
const RETRY_AFTER_BODY_PATTERN = /retry-after\s*[:=]\s*([^\s,;]+)/i;
// `retry-after: <date>` in text. The delta pattern above stops at the first space
// or comma, so it cannot capture a date. This finds a candidate in any shape
// `parseRetryAfterDate` reads, ending at a token boundary so a prefix of a
// longer number is never taken for a year or a time; the reader then checks it
// field by field.
const RETRY_AFTER_DATE_BODY_PATTERN =
	/retry-after\s*[:=]\s*((?:[A-Za-z]{3,9},?\s+)?(?:\d{1,2}(?:\s+|-)[A-Za-z]{3,9}(?:\s+|-)\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?|[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{4})?\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s+\d{4})?|\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s*(?:(?:GMT|UTC|UT)(?:[+-]\d{2}:?\d{2})?|Z|[ECMP][SD]T|[+-]\d{2}:?\d{2}))?(?:\s*\([^()]*\))*)(?![\w:])/i;
// The shapes a Retry-After date takes. RFC 9110 section 5.6.7 names three
// (IMF-fixdate, RFC 850, asctime) and asks recipients to be robust: a date
// forwarded from an RFC 5322 message may omit the weekday or the seconds, name
// UT, a US zone or a numeric offset, and end in a comment. Servers also send
// JavaScript's `Date#toString` shape and RFC 3339 timestamps. Every shape that
// names its instant without guessing the machine's zone is read; a time with
// no zone is GMT only in the HTTP shapes, where GMT is the rule.
const DATE_ZONE = String.raw`(?:GMT|UTC|UT)(?:[+-]\d{2}:?\d{2})?|Z|[ECMP][SD]T|[+-]\d{2}:?\d{2}`;
const DATE_TIME = String.raw`(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?`;
const DATE_WEEKDAY = String.raw`(?:(?<weekday>[A-Za-z]{3,9})(?:,\s*|\s+))?`;
const DATE_END = String.raw`(?:\s*(?<zone>${DATE_ZONE}))?(?:\s*\([^()]*\))*$`;
/**
 * IMF-fixdate and RFC 850: day, month and year, joined by hyphens or by
 * whitespace (RFC 5322 folding whitespace may be more than one space).
 */
const DAY_MONTH_YEAR_PATTERN = new RegExp(
	String.raw`^${DATE_WEEKDAY}(?<day>\d{1,2})(?:\s+|-)(?<month>[A-Za-z]{3,9})(?:\s+|-)(?<year>\d{4}|\d{2})\s+${DATE_TIME}${DATE_END}`,
	"i",
);
/** asctime (year after the time) and `Date#toString` (year before it). */
const MONTH_DAY_PATTERN = new RegExp(
	String.raw`^${DATE_WEEKDAY}(?<month>[A-Za-z]{3,9})\s+(?<day>\d{1,2})(?:,?\s+(?<yearBefore>\d{4}))?\s+${DATE_TIME}(?:\s+(?<yearAfter>\d{4}))?${DATE_END}`,
	"i",
);
// An RFC 3339 timestamp. Only with an explicit zone: without one it names a
// different instant in every machine zone.
const RFC3339_PATTERN =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt ](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?\s*(?<zone>[Zz]|[+-]\d{2}:?\d{2}|GMT|UTC)$/;
const MONTH_NAMES = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
const WEEKDAY_NAMES = new Set([
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
	"sat",
	"sun",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
	"sunday",
]);
/** RFC 5322 section 4.3 named zones, in minutes east of UTC. */
const NAMED_ZONE_MINUTES: Readonly<Record<string, number>> = {
	gmt: 0,
	ut: 0,
	utc: 0,
	z: 0,
	est: -300,
	edt: -240,
	cst: -360,
	cdt: -300,
	mst: -420,
	mdt: -360,
	pst: -480,
	pdt: -420,
};
const MS_PER_400_YEARS = 146_097 * 86_400_000;
const RESET_MS_BODY_PATTERN = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i;
const RESET_BODY_PATTERN = /x-ratelimit-reset\s*[:=]\s*(\d+)/i;

// A timezone-naive `reset at` stamp (no `Z`/offset) is the provider's
// wall clock in an unknown zone: it cannot be converted to a delay without
// guessing the zone, so it resolves only as a fallback when the body
// carries no unambiguous relative signal.

// A conflict probe needs no new signal: when a naive `reset at` wall stamp
// disagrees with the merged relative wait, the merged wait (which already
// ignores the naive stamp) sleeps first, and the retry after it is the
// probe — success proves skew, a fresh 429 re-anchors with live timing.

/** Provider-specific interpretation for timezone-naive retry timestamps. */
export interface RetryHintOptions {
	/** UTC offset appended to an absolute reset stamp that omits its timezone. */
	naiveResetTimezoneOffset?: string;
}

/**
 * Server-suggested retry delay extraction. Merges the patterns historically used
 *
 * Header sources (checked in order):
 *  - `retry-after-ms` (milliseconds)
 *  - `Retry-After` (numeric seconds, or a date read by {@link parseRetryAfterDate})
 *  - `x-ratelimit-reset-ms` (delta ms, or Unix epoch ms/s for large values)
 *  - `x-ratelimit-reset` (Unix epoch seconds)
 *  - `x-ratelimit-reset-after` (seconds)
 *
 * Body patterns:
 *  - `Your quota will reset after 18h31m10s` / `10m15s` / `39s`
 *  - `Please retry in 250ms` / `Please retry in 12s`
 *  - `"retryDelay": "34.074824224s"` (JSON error detail field)
 *  - `try again in 250ms` / `try again in 12s` / `try again in 5 min` / `try again in ~158 min`
 *  - `retry-after-ms=98497000` / `retry-after-ms: 7200000` / `retry-after-ms = 7200000`
 *  - `retry-after: 30` / `retry-after: <date>` (read by {@link parseRetryAfterDate})
 *  - `Your limit will reset at 2026-09-01 09:44:51` / `将在 2026-09-01 09:44:51 重置`
 *    (a provider offset makes a naive wall clock authoritative; otherwise it
 *    resolves only when no relative signal is present)
 *
 * Returns `undefined` if no signal is found, or `0` when the provider
 * explicitly asks for an immediate retry (`retry-after…=0`, or an absolute
 * reset timestamp that has already elapsed).
 */
export function extractRetryHint(
	source: Response | Headers | null | undefined,
	body?: string,
	options?: RetryHintOptions,
): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	if (headers) {
		const retryAfterMs = headers.get("retry-after-ms");
		if (retryAfterMs) {
			const ms = Number(retryAfterMs);
			if (Number.isFinite(ms) && ms >= 0) return ms;
		}
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const ms = parseRetryAfter(retryAfter);
			if (ms !== undefined) return ms;
		}
		const rateLimitResetMs = headers.get("x-ratelimit-reset-ms");
		if (rateLimitResetMs) {
			const value = Number(rateLimitResetMs);
			if (Number.isFinite(value) && value > 0) {
				// > 1e12 → epoch ms; > 1e9 → epoch s; otherwise a delta in ms.
				const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
				if (targetMs === undefined) return value;
				const delta = targetMs - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delta = resetSeconds * 1000 - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const seconds = Number(rateLimitResetAfter);
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		}
	}

	if (!body) return undefined;
	return bodyRetryHint(body, options, false);
}

/**
 * The longest wait a response names, across every retry header it carries and
 * every occurrence of every phrase in `body`. A malformed or shorter hint never
 * hides a longer valid one, and duplicate header lines joined by a comma are
 * each read. `0` when the only signals ask for an immediate retry; `undefined`
 * when nothing names a wait.
 *
 * {@link extractRetryHint} stops at the first recognized header and the first
 * occurrence of each phrase, which is what the retry loop has always slept on.
 * A caller that bounds its retries by a budget needs this reading instead: a
 * retry sent inside a window the server said is closed is a guaranteed failure.
 */
export function longestRetryHint(
	source: Response | Headers | null | undefined,
	body?: string,
	options?: RetryHintOptions,
): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	const hints = headers ? headerRetryHints(headers) : [];
	const fromBody = body ? bodyRetryHint(body, options, true) : undefined;
	if (fromBody !== undefined) hints.push(fromBody);
	return hints.length === 0 ? undefined : Math.max(...hints);
}

/** Every wait the retry headers name, each comma-separated value read on its own. */
function headerRetryHints(headers: Headers): number[] {
	const hints: number[] = [];
	const read = (name: string, parse: (value: string) => number | undefined): void => {
		const raw = headers.get(name);
		if (!raw) return;
		for (const value of new Set([raw.trim(), ...raw.split(",").map(part => part.trim())])) {
			if (value === "") continue;
			const ms = parse(value);
			if (ms !== undefined) hints.push(ms);
		}
	};
	read("retry-after-ms", value => nonNegative(Number(value)));
	const retryAfter = headers.get("retry-after");
	const retryAfterMs = retryAfter ? parseRetryAfter(retryAfter) : undefined;
	if (retryAfterMs !== undefined) hints.push(retryAfterMs);
	read("x-ratelimit-reset-ms", value => resetCounterMs(Number(value), 1));
	read("x-ratelimit-reset", value => resetCounterMs(Number(value), 1000));
	read("x-ratelimit-reset-after", value => {
		const seconds = nonNegative(Number(value));
		return seconds === undefined ? undefined : seconds * 1000;
	});
	return hints;
}

/**
 * The wait, in ms, a `Retry-After` header value names: delta seconds or a date
 * ({@link parseRetryAfterDate}), the longest across the values a duplicated
 * header joins with commas (the comma after a date's weekday stays with its
 * date). A date already past and a negative delta name `0`; `undefined` when
 * no value is a wait.
 *
 * The one reading of the header: every retry parser uses it, with or without a
 * replay budget, and only bounds the result its own way (a cap, a floor), so
 * two readers of the same header never disagree about what it says.
 */
export function parseRetryAfter(value: string, nowMs = Date.now()): number | undefined {
	let longest: number | undefined;
	for (const entry of retryAfterEntries(value, nowMs)) {
		const seconds = Number(entry);
		let ms: number | undefined;
		if (Number.isFinite(seconds)) {
			ms = Math.max(0, seconds * 1000);
		} else {
			const dateMs = parseRetryAfterDate(entry, nowMs);
			ms = dateMs === undefined ? undefined : Math.max(0, dateMs - nowMs);
		}
		if (ms !== undefined && (longest === undefined || ms > longest)) longest = ms;
	}
	return longest;
}

/** The values a Retry-After header carries: the whole value when it is one, else its comma-separated parts. */
function retryAfterEntries(value: string, nowMs: number): string[] {
	const whole = value.trim();
	if (whole === "") return [];
	if (Number.isFinite(Number(whole)) || parseRetryAfterDate(whole, nowMs) !== undefined) return [whole];
	const parts = whole.split(",").map(part => part.trim());
	const entries: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		if (part === "") continue;
		// A bare word is a weekday whose date follows its comma.
		if (/^[A-Za-z]+$/.test(part) && index + 1 < parts.length) {
			entries.push(`${part}, ${parts[++index]}`);
			continue;
		}
		entries.push(part);
	}
	return entries;
}

/**
 * The instant a `Retry-After` date names, in ms since the epoch, or `undefined`
 * when `value` is not one. Reads RFC 9110 section 5.6.7's three forms with the
 * robustness it asks for: the RFC 5322 date-time they derive from (optional
 * weekday and seconds, UT, the US zone names, a numeric offset, a trailing
 * comment), month and weekday names short or long, JavaScript's `Date#toString`
 * shape, and an RFC 3339 timestamp that names its zone. Every field is
 * range-checked: the day must exist in its month, and second 60 is accepted
 * only as a leap second at 23:59, read as the instant after 23:59:59. A time
 * with no zone is GMT in the HTTP shapes and is not read in any other, where it
 * would name a different instant in every machine zone. A two-digit year is the
 * latest year with those digits that is not more than fifty years after `nowMs`.
 *
 * The one reader of a `Retry-After` date, used by {@link parseRetryAfter} and by
 * the readers of a date written in error text.
 */
export function parseRetryAfterDate(value: string, nowMs = Date.now()): number | undefined {
	const text = value.trim();
	let groups = DAY_MONTH_YEAR_PATTERN.exec(text)?.groups;
	if (groups) {
		if (!isWeekday(groups.weekday)) return undefined;
		const month = monthIndex(groups.month!);
		const year = groups.year!.length === 4 ? Number(groups.year) : twoDigitYear(groups, month, nowMs);
		return year === undefined ? undefined : utcInstant(year, month, groups, groups.zone);
	}
	groups = MONTH_DAY_PATTERN.exec(text)?.groups;
	if (groups) {
		if (!isWeekday(groups.weekday)) return undefined;
		const { yearBefore, yearAfter, zone } = groups;
		// Exactly one year. The `Date#toString` shape (year before the time) is not
		// an HTTP date, so it is read only with a zone.
		if ((yearBefore === undefined) === (yearAfter === undefined)) return undefined;
		if (yearBefore !== undefined && zone === undefined) return undefined;
		return utcInstant(Number(yearBefore ?? yearAfter), monthIndex(groups.month!), groups, zone);
	}
	groups = RFC3339_PATTERN.exec(text)?.groups;
	if (groups) return utcInstant(Number(groups.year), Number(groups.month) - 1, groups, groups.zone);
	return undefined;
}

function isWeekday(name: string | undefined): boolean {
	return name === undefined || WEEKDAY_NAMES.has(name.toLowerCase());
}

function monthIndex(name: string): number {
	const index = MONTH_NAMES.indexOf(name.toLowerCase());
	return index < 0 ? -1 : index % 12;
}

/**
 * The year a two-digit year names: the latest of the three centuries that is
 * not more than fifty years after `nowMs` (RFC 9110 section 5.6.7), chosen
 * first and then checked, so a 29 February that only exists in another century
 * is not moved there.
 */
function twoDigitYear(fields: Record<string, string | undefined>, month: number, nowMs: number): number | undefined {
	if (month < 0) return undefined;
	const now = new Date(nowMs);
	const limitMs = Date.UTC(
		now.getUTCFullYear() + 50,
		now.getUTCMonth(),
		now.getUTCDate(),
		now.getUTCHours(),
		now.getUTCMinutes(),
		now.getUTCSeconds(),
		now.getUTCMilliseconds(),
	);
	const nearest = Math.floor(now.getUTCFullYear() / 100) * 100 + Number(fields.year);
	const day = Number(fields.day);
	const hour = Number(fields.hour);
	const minute = Number(fields.minute);
	const second = Number(fields.second ?? 0);
	return [nearest + 100, nearest, nearest - 100].find(
		candidate => Date.UTC(candidate, month, day, hour, minute, second) <= limitMs,
	);
}

/** Minutes east of UTC a zone names; `0` when none is named, `undefined` when it is out of range. */
function zoneOffsetMinutes(zone: string | undefined): number | undefined {
	if (zone === undefined) return 0;
	const named = NAMED_ZONE_MINUTES[zone.toLowerCase()];
	if (named !== undefined) return named;
	// A numeric offset, alone or after GMT/UTC/UT (`GMT+0000`, `UTC+05:30`).
	const offset = /[+-]\d{2}:?\d{2}$/.exec(zone)?.[0];
	if (offset === undefined) return undefined;
	const digits = offset.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2, 4));
	if (hours > 23 || minutes > 59) return undefined;
	return (offset[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/** The UTC instant of a checked calendar date and time of day; `undefined` when a field is out of range. */
function utcInstant(
	year: number,
	month: number,
	fields: Record<string, string | undefined>,
	zone: string | undefined,
): number | undefined {
	const day = Number(fields.day);
	const hour = Number(fields.hour);
	const minute = Number(fields.minute);
	const second = Number(fields.second ?? 0);
	const offsetMinutes = zoneOffsetMinutes(zone);
	if (offsetMinutes === undefined || month < 0 || month > 11 || year < 0) return undefined;
	if (day < 1 || day > daysInMonth(year, month)) return undefined;
	if (hour > 23 || minute > 59 || second > (hour === 23 && minute === 59 ? 60 : 59)) return undefined;
	const ms = fields.fraction === undefined ? 0 : Number(fields.fraction.slice(0, 3).padEnd(3, "0"));
	// `Date.UTC` reads years 0-99 as 1900-1999; a 400-year shift is exact.
	const shift = year < 100 ? MS_PER_400_YEARS : 0;
	return Date.UTC(year + (shift ? 400 : 0), month, day, hour, minute, second, ms) - shift - offsetMinutes * 60_000;
}

function daysInMonth(year: number, month: number): number {
	if (month === 1) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month]!;
}

function nonNegative(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A reset counter: a Unix epoch in ms (> 1e12) or s (> 1e9), otherwise a delta in `unitMs`. */
function resetCounterMs(value: number, unitMs: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
	if (targetMs === undefined) return value * unitMs;
	const delta = targetMs - Date.now();
	return delta > 0 ? delta : undefined;
}

const GLOBAL_PATTERNS = new Map<RegExp, RegExp>();

/** The first match of `pattern` in `body`, or every match when `everyOccurrence` is set. */
function occurrences(pattern: RegExp, body: string, everyOccurrence: boolean): Iterable<RegExpMatchArray> {
	if (!everyOccurrence) {
		const match = pattern.exec(body);
		return match ? [match] : [];
	}
	let global = GLOBAL_PATTERNS.get(pattern);
	if (!global) {
		global = new RegExp(pattern.source, `${pattern.flags}g`);
		GLOBAL_PATTERNS.set(pattern, global);
	}
	return body.matchAll(global);
}

/** The retry wait `body` names: from the first occurrence of each phrase, or from every occurrence. */
function bodyRetryHint(
	body: string,
	options: RetryHintOptions | undefined,
	everyOccurrence: boolean,
): number | undefined {
	// A body can carry several timing signals at once: the account-reset
	// window plus header timing folded into the message text (already the
	// max across response headers — see getRetryAfterMsFromHeaders in
	// pi-ai). Honor the longest: retrying before either window clears
	// re-hits a still-blocked credential and burns the retry budget.
	let longestMs: number | undefined;
	// A parsed-but-non-positive signal is a provider "retry now": an explicit
	// `retry-after…=0` or an absolute reset that already elapsed. It must
	// survive as 0 rather than collapse into "no hint found" — consumers
	// substitute a heuristic wait (30-minute quota guess, default backoff)
	// when the parse returns undefined, which would sleep a session the
	// provider told to retry immediately.
	let retryNow = false;

	// Timezone-naive `reset at` stamps (no `Z`/offset) are the provider's
	// wall clock in an unknown zone — converting them to a delay requires
	// guessing the zone. They resolve AFTER every unambiguous signal below,
	// and only as a fallback when none was found.
	let longestNaiveMs: number | undefined;
	const considerNaive = (ms: number | undefined): void => {
		if (ms !== undefined && ms > 0 && (longestNaiveMs === undefined || ms > longestNaiveMs)) longestNaiveMs = ms;
	};
	const consider = (ms: number | undefined): void => {
		if (ms !== undefined && ms > 0 && (longestMs === undefined || ms > longestMs)) longestMs = ms;
	};
	const considerClamped = (ms: number | undefined): void => {
		if (ms === undefined) return;
		if (ms > 0) consider(ms);
		else retryNow = true;
	};

	for (const quotaMatch of occurrences(QUOTA_RESET_PATTERN, body, everyOccurrence)) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]!);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			consider(totalMs > 0 ? totalMs : undefined);
		}
	}
	for (const pattern of RESET_AT_PATTERNS) {
		for (const match of occurrences(pattern, body, everyOccurrence)) {
			if (!match[1]) continue;
			// Offset-bearing stamps are unambiguous and compete by longest-wins.
			// A configured provider offset makes an otherwise naive wall clock
			// unambiguous too. Without one, preserve the relative-signal-first
			// fallback and interpret the wall clock as UTC only when it stands alone.
			const normalized = match[1].replace(" ", "T");
			const hasOffset = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized);
			const configuredOffset = options?.naiveResetTimezoneOffset;
			const parsed = Date.parse(hasOffset ? normalized : `${normalized}${configuredOffset ?? "Z"}`);
			if (!Number.isNaN(parsed) && parsed > Date.now()) {
				if (hasOffset || configuredOffset !== undefined) consider(parsed - Date.now());
				else considerNaive(parsed - Date.now());
			}
		}
	}
	// OpenCode Go compound remainder ("Resets in 2hr 15min"): the generic
	// pattern only captures the leading "2hr", so add the trailing minutes.
	for (const compoundResetMatch of occurrences(RESET_IN_HR_MIN_PATTERN, body, everyOccurrence)) {
		if (!compoundResetMatch[1] || !compoundResetMatch[2]) continue;
		const hours = Number.parseFloat(compoundResetMatch[1]);
		const minutes = Number.parseFloat(compoundResetMatch[2]);
		if (Number.isFinite(hours) && Number.isFinite(minutes) && hours >= 0 && minutes > 0) {
			consider(hours * 60 * 60_000 + minutes * 60_000);
		}
	}
	for (const accountResetMatch of occurrences(WILL_RESET_IN_PATTERN, body, everyOccurrence)) {
		if (!accountResetMatch[1]) continue;
		const value = Number.parseFloat(accountResetMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const unitMs = unitToMs(accountResetMatch[2]!);
			if (unitMs !== undefined) consider(value * unitMs);
		}
	}

	for (const retryAfterMsMatch of occurrences(RETRY_AFTER_MS_BODY_PATTERN, body, everyOccurrence)) {
		if (!retryAfterMsMatch[1]) continue;
		const ms = Number(retryAfterMsMatch[1]);
		if (Number.isFinite(ms)) considerClamped(ms);
	}

	for (const pattern of [PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
		for (const match of occurrences(pattern, body, everyOccurrence)) {
			if (!match[1]) continue;
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]!);
				if (unitMs !== undefined) consider(value * unitMs);
			}
		}
	}

	// Legacy text forms (also honored by older local parsers): a plain
	// `retry-after` delta in seconds, a timestamp written as one token, or an
	// HTTP date, and `x-ratelimit-reset[-ms]` counters. They compete in the same
	// maximum — a longer legacy hint must not lose to a shorter reset phrase.
	// Their non-positive readings (explicit zero, elapsed epoch/date) are the
	// clamped retry-now signals above.
	for (const retryAfterMatch of occurrences(RETRY_AFTER_BODY_PATTERN, body, everyOccurrence)) {
		const token = retryAfterMatch[1]!;
		const seconds = Number(token);
		if (Number.isFinite(seconds)) {
			considerClamped(seconds * 1000);
		} else {
			const dateMs = parseRetryAfterDate(token);
			if (dateMs !== undefined) considerClamped(dateMs - Date.now());
		}
	}
	for (const dateMatch of occurrences(RETRY_AFTER_DATE_BODY_PATTERN, body, everyOccurrence)) {
		const dateMs = parseRetryAfterDate(dateMatch[1]!);
		if (dateMs !== undefined) considerClamped(dateMs - Date.now());
	}

	for (const resetMsMatch of occurrences(RESET_MS_BODY_PATTERN, body, everyOccurrence)) {
		const resetMs = Number(resetMsMatch[1]);
		if (!Number.isNaN(resetMs)) {
			considerClamped(resetMs > 1_000_000_000_000 ? resetMs - Date.now() : resetMs);
		}
	}

	for (const resetMatch of occurrences(RESET_BODY_PATTERN, body, everyOccurrence)) {
		const resetSeconds = Number(resetMatch[1]);
		if (!Number.isNaN(resetSeconds)) {
			considerClamped(resetSeconds > 1_000_000_000 ? resetSeconds * 1000 - Date.now() : resetSeconds * 1000);
		}
	}
	// Elapsed naive stamps were ignored before this change and stay ignored:
	// only an explicit zero/expired relative signal is authoritative retry-now.
	return longestMs ?? longestNaiveMs ?? (retryNow ? 0 : undefined);
}

/**
 * Thrown by a transport gate when a retry or resend can no longer begin inside
 * its caller's budget, at the moment it would be handed to the transport.
 * `replaced` is the failure the refused request would have replaced, when the
 * caller that admitted the request named one. {@link fetchWithRetry} answers a
 * refused retry with the response or error that retry would have replaced.
 */
export class RetryRefusedError extends Error {
	readonly replaced: unknown;

	constructor(replaced?: unknown) {
		super("The retry was not sent: the caller's replay budget ran out before it could begin");
		this.name = "RetryRefusedError";
		this.replaced = replaced;
	}
}

/** The {@link RetryRefusedError} in `error` or in its cause chain, which transport wrappers may add. */
export function findRetryRefusal(error: unknown): RetryRefusedError | undefined {
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 8; depth++) {
		if (current instanceof RetryRefusedError) return current;
		current = current.cause;
	}
	return undefined;
}

function unitToMs(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 60 * 60_000;
		case "d":
		case "day":
		case "days":
			return 24 * 60 * 60_000;
		default:
			return undefined;
	}
}

export interface FetchWithRetryOptions extends RequestInit {
	/** Total fetch attempts (initial + retries). Default `5`. */
	maxAttempts?: number;
	/**
	 * Per-delay cap. Server-provided `Retry-After` hints exceeding this return
	 * the current response immediately — caller deals with the `!response.ok`.
	 * Default `60_000`.
	 */
	maxDelayMs?: number;
	/**
	 * Fallback delay schedule when no server hint is present. Number, array
	 * (indexed by attempt, clamped to last), or function. Default exponential
	 * `500ms * 2 ** attempt` capped at `maxDelayMs`.
	 */
	defaultDelayMs?: number | readonly number[] | ((attempt: number) => number);
	/**
	 * Optional per-attempt overlay merged into the base `RequestInit` each try.
	 * Headers from the overlay shallow-merge over the base. Useful for auth
	 * token refresh or user-agent rotation.
	 */
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	/**
	 * Optional `fetch` implementation override. Defaults to `globalThis.fetch`.
	 * Useful for routing requests through a proxy, instrumented transport, or
	 * mock during tests.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/**
	 * Optional retry gate for HTTP responses whose status is retryable. Receives a
	 * cloned body string so callers can fail fast on deterministic provider
	 * failures that happen to use a 5xx status.
	 */
	shouldRetryResponse?: (response: Response, bodyText: string, attempt: number) => boolean | Promise<boolean>;
	/**
	 * Consulted before every retry with the wait that retry would take, and again
	 * with `0` immediately before the retry is sent, after the wait and
	 * `prepareInit`. Return `false` to stop retrying: a thrown network failure is
	 * rethrown and a retryable response is returned, exactly as when
	 * `maxAttempts` runs out. While a gate is set, the wait for a response is the
	 * longest one its headers or body name. Lets a caller bound one call's
	 * retries by its own budget. Omitted, every retry the other options allow is
	 * taken.
	 */
	retryGate?: (delayMs: number) => boolean;
	/**
	 * Bun extension forwarded verbatim to the underlying `fetch` call. `false`
	 * disables Bun's native ~300s pre-response timeout (callers that own a
	 * configurable first-event/idle watchdog or an external `AbortSignal`
	 * supply this so the runtime ceiling cannot pre-empt them); a positive
	 * number sets a custom ceiling in ms. Bare browser/Node fetch ignores it.
	 */
	timeout?: number | false;
}

const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Fetch with bounded retries and sensible defaults. Retries on any
 * `isRetryableStatus` (5xx, 408, 429) and on transient network errors. Server
 * `Retry-After`/quota hints are honoured up to `maxDelayMs`; a hint that exceeds
 * the cap returns the current response so the caller can fail fast. Aborts on
 * `init.signal` propagate as `"Request was aborted"`.
 *
 * The caller is responsible for inspecting `!response.ok` once the call returns.
 */
export async function fetchWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const {
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		maxDelayMs = DEFAULT_MAX_DELAY_MS,
		defaultDelayMs,
		prepareInit,
		shouldRetryResponse,
		retryGate,
		fetch: fetchImpl = fetch,
		timeout = false,
		...baseInit
	} = options;
	const signal = baseInit.signal as AbortSignal | undefined;
	// Under a gate, the failure a retry would replace is held until the retry
	// is on the wire: the wait and `prepareInit` take real time, so the gate is
	// asked again immediately before the request goes out, and the transport may
	// still refuse it at handoff (`RetryRefusedError`). Either refusal returns this.
	let pending: { response: Response } | { error: Error } | undefined;
	const releasePending = (): void => {
		if (pending && "response" in pending && !pending.response.bodyUsed) {
			pending.response.body?.cancel().catch(() => {});
		}
		pending = undefined;
	};
	const takePending = (): Response => {
		const refused = pending!;
		pending = undefined;
		if ("error" in refused) throw refused.error;
		return refused.response;
	};

	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) {
			releasePending();
			throw new Error("Request was aborted");
		}
		const requestUrl = typeof url === "function" ? url(attempt) : url;
		// `timeout` is destructured out of `baseInit`, so forward it to the underlying
		// fetch on the no-`prepareInit` path too. Without this, callers that pass
		// `timeout: false` (every streaming provider, to disable Bun's native ~300s
		// fetch ceiling in favor of their own first-event/idle watchdog) had it
		// silently dropped, so long-running streams were killed at ~300s (issue #602).
		// Only forward when the caller actually set `timeout`, so callers that never
		// set it keep Bun's default ceiling.
		const init = prepareInit
			? mergeInit(baseInit, await prepareInit(attempt), timeout)
			: "timeout" in options
				? ({ ...baseInit, timeout } as unknown as RequestInit)
				: baseInit;

		if (pending && retryGate && !retryGate(0)) return takePending();

		let response: Response;
		try {
			response = await fetchImpl(requestUrl, init);
		} catch (error) {
			if (findRetryRefusal(error)) {
				// Refused at handoff: a held failure stands; a refused first request
				// belongs to the caller that admitted it.
				if (pending) return takePending();
				throw error;
			}
			releasePending();
			if (signal?.aborted) throw new Error("Request was aborted");
			const wrapped = wrapNetworkError(error);
			if (attempt + 1 >= maxAttempts) throw wrapped;
			const networkDelayMs = resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs);
			if (retryGate) {
				if (!retryGate(networkDelayMs)) throw wrapped;
				pending = { error: wrapped };
			}
			await waitForRetry(networkDelayMs, signal);
			continue;
		}
		releasePending();

		if (!isRetryableStatus(response.status)) return response;
		if (attempt + 1 >= maxAttempts) return response;

		const retryBody = await response.clone().text();
		if (shouldRetryResponse && !(await shouldRetryResponse(response, retryBody, attempt))) return response;

		// Under a gate the longest wait the server named counts, so a header that
		// says zero cannot beat a body that says thirty seconds.
		const hint = retryGate ? longestRetryHint(response, retryBody) : extractRetryHint(response, retryBody);
		if (hint !== undefined && hint > maxDelayMs) return response;

		const delayMs = Math.min(hint ?? resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), maxDelayMs);
		if (retryGate) {
			if (!retryGate(delayMs)) return response;
			pending = { response };
		} else if (!response.bodyUsed) {
			// The retried response is discarded; release its unread tee branch.
			response.body?.cancel().catch(() => {});
		}
		try {
			await waitForRetry(delayMs, signal);
		} catch (error) {
			releasePending();
			throw error;
		}
	}
}

function mergeInit(base: RequestInit, overlay: RequestInit, timeout: number | false): RequestInit {
	const merged = { ...base, ...overlay, timeout } as unknown as RequestInit;
	if (base.headers || overlay.headers) {
		const baseHeaders = new Headers(base.headers ?? undefined);
		const overlayHeaders = new Headers(overlay.headers ?? undefined);
		overlayHeaders.forEach((value, key) => {
			baseHeaders.set(key, value);
		});
		merged.headers = baseHeaders;
	}
	return merged;
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await scheduler.wait(delayMs, { signal });
	} catch (error) {
		if (signal?.aborted) throw new Error("Request was aborted");
		throw error;
	}
}

function wrapNetworkError(error: unknown): Error {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.message === "Request was aborted") {
			return new Error("Request was aborted");
		}
		if (error.message === "fetch failed" && error.cause instanceof Error) {
			// Keep the original rejection as `cause`: undici nests the errno under
			// `fetch failed` (often through an AggregateError), and
			// classifyNetworkCause (packages/ai/src/error/network-cause.ts) walks
			// `cause`/`errors` off this error. Flattening to text alone loses it.
			return new Error(`Network error: ${error.cause.message}`, { cause: error });
		}
		return error;
	}
	return new Error(String(error));
}

function resolveDefaultDelay(
	option: FetchWithRetryOptions["defaultDelayMs"],
	attempt: number,
	maxDelayMs: number,
): number {
	if (option === undefined) return Math.min(500 * 2 ** attempt, maxDelayMs);
	if (typeof option === "number") return Math.min(option, maxDelayMs);
	if (typeof option === "function") return Math.min(option(attempt), maxDelayMs);
	return Math.min(option[Math.min(attempt, option.length - 1)] ?? 0, maxDelayMs);
}

/**
 * Inspect an arbitrary error value (or its `cause` chain, up to depth 2) for an
 * HTTP status code. Reads `status`, `statusCode`, and `response.status` fields,
 * coerces string values, and falls back to scanning the error message for
 * common patterns like `Error: 401`, `error (429)`, or `HTTP 503`.
 */
export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	const rawStatus = info.status ?? info.statusCode ?? info.response?.status;

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) status = parsed;
	}
	if (status !== undefined && status >= 100 && status <= 599) return status;

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	if (info.cause) return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	return undefined;
}

const STATUS_MESSAGE_PATTERNS = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
] as const;

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

/**
 * `true` if the given HTTP status code is one we treat as transient: 408
 * (Request Timeout), 429 (Too Many Requests), or any 5xx (server error).
 */
export function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * `true` if the message describes an unexpected socket closure — Bun and some
 * proxies surface these for any HTTP/2 stream reset.
 */
export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return (
		/\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message) ||
		/^(?:error:\s*)?socket is closed\.?$/i.test(message.trim())
	);
}

const TRANSIENT_MESSAGE_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|network error|stream stall|other side closed|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;

const VALIDATION_MESSAGE_PATTERN =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/**
 * Identify errors that should be retried: aborts/timeouts in the error name or
 * message, retryable HTTP statuses (see `isRetryableStatus`), unexpected socket
 * closes, and the standard transient phrases. 4xx statuses other than 408/429
 * and validation-shaped messages short-circuit to `false`.
 */
export function isRetryableError(error: unknown): boolean {
	const info = error as { message?: string; name?: string } | null;
	const message = info?.message ?? "";
	const name = info?.name ?? "";
	if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) return true;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		if (isRetryableStatus(status)) return true;
		if (status >= 400 && status < 500) return false;
	}

	if (VALIDATION_MESSAGE_PATTERN.test(message)) return false;
	return isUnexpectedSocketCloseMessage(message) || TRANSIENT_MESSAGE_PATTERN.test(message);
}
