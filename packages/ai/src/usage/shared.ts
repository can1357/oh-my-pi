import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type { UsageAmount } from "../usage";

/** Milliseconds in one hour. */
export const HOUR_MS = 60 * 60 * 1000;

/** Milliseconds in one day. */
export const DAY_MS = 24 * HOUR_MS;

/** Milliseconds in one seven-day week. */
export const WEEK_MS = 7 * DAY_MS;

/** Parses a finite positive epoch timestamp, tolerating seconds or milliseconds. */
export function parsePositiveTimestamp(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined || parsed <= 0) return undefined;
	return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

/** Parses an ISO timestamp into epoch milliseconds. */
export function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Builds an amount from absolute counters. Without an authoritative
 * `usedFraction`, it derives one from `used / limit` (capped at 1).
 * Undefined fields are omitted rather than emitted as `undefined` keys.
 */
export function buildUsageAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	usedFraction?: number;
	unit: UsageAmount["unit"];
}): UsageAmount {
	let usedFraction = args.usedFraction;
	if (usedFraction === undefined && args.used !== undefined && args.limit !== undefined && args.limit > 0) {
		usedFraction = Math.min(args.used / args.limit, 1);
	}
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		...(args.used !== undefined ? { used: args.used } : {}),
		...(args.limit !== undefined ? { limit: args.limit } : {}),
		...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
		...(usedFraction !== undefined ? { usedFraction } : {}),
		...(remainingFraction !== undefined ? { remainingFraction } : {}),
		unit: args.unit,
	};
}
