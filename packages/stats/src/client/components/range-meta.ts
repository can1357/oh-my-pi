/**
 * Display metadata for a `TimeRange` — keeps chart labels, sparkline bucket
 * counts, and x-axis date formatting in sync with the server-side bucketing
 * defined in `aggregator.ts`.
 */

import { format } from "@oh-my-pi/pi-utils/dates";
import type { TimeRange } from "../types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_MIN_MS = 5 * 60 * 1000;

export interface RangeMeta {
	/** Human label used in chart subtitles ("the last 24 hours"). */
	windowLabel: string;
	/** Short prefix used in compact column headers ("24h Trend"). */
	trendLabel: string;
	/** Bucket size matching the server query for this range. */
	bucketMs: number;
	/** Number of buckets the server is expected to return for this range. */
	bucketCount: number;
	/** Date format string for x-axis labels and tooltip headings. */
	tickFormat: string;
}

const RANGE_META: Record<TimeRange, RangeMeta> = {
	today: {
		windowLabel: "today since midnight",
		trendLabel: "Today",
		bucketMs: HOUR_MS,
		bucketCount: 24,
		tickFormat: "HH:mm",
	},
	"1h": {
		windowLabel: "the last hour",
		trendLabel: "1h Trend",
		bucketMs: FIVE_MIN_MS,
		bucketCount: 12,
		tickFormat: "HH:mm",
	},
	"24h": {
		windowLabel: "the last 24 hours",
		trendLabel: "24h Trend",
		bucketMs: HOUR_MS,
		bucketCount: 24,
		tickFormat: "HH:mm",
	},
	"7d": {
		windowLabel: "the last 7 days",
		trendLabel: "7d Trend",
		bucketMs: DAY_MS,
		bucketCount: 7,
		tickFormat: "MMM d",
	},
	"30d": {
		windowLabel: "the last 30 days",
		trendLabel: "30d Trend",
		bucketMs: DAY_MS,
		bucketCount: 30,
		tickFormat: "MMM d",
	},
	"90d": {
		windowLabel: "the last 90 days",
		trendLabel: "90d Trend",
		bucketMs: DAY_MS,
		bucketCount: 90,
		tickFormat: "MMM d",
	},
	all: { windowLabel: "all time", trendLabel: "Trend", bucketMs: DAY_MS, bucketCount: 0, tickFormat: "MMM d" },
};
export function rangeMeta(range: TimeRange): RangeMeta {
	return RANGE_META[range];
}

/** Format a bucket timestamp using the active range's tick format. */
export function formatRangeTick(timestamp: number, range: TimeRange): string {
	return format(new Date(timestamp), RANGE_META[range].tickFormat);
}
