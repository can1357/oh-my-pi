import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type { UsageStatus } from "../usage";

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

/** Maps a used fraction to the standard quota status thresholds. */
export function usageStatus(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}
