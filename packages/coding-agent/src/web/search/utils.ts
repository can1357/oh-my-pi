/** Calculate age in seconds from an ISO date string. Returns undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Clamp a result count to [1, maxVal], returning defaultVal when value is absent or NaN. */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

const RECENCY_DAYS: Record<"day" | "week" | "month" | "year", number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

/** UTC `YYYY-MM-DD` lower bound for a relative recency window, for engines that only accept absolute `after` dates. */
export function recencyAfterDate(recency: "day" | "week" | "month" | "year"): string {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);
}
