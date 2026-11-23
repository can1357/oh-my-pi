/**
 * Time windows narrowing reads of local history (sessions, prompts, recaps,
 * transcript records). Bounds are Unix milliseconds: `since` inclusive,
 * `until` exclusive; an omitted bound is open.
 */

/** A half-open `[since, until)` span of Unix milliseconds; omitted bounds are open. */
export interface TimeWindow {
	since?: number;
	until?: number;
}

/** Whether the instant `at` falls inside `window`; an absent window holds every instant. */
export function inWindow(at: number, window: TimeWindow | undefined): boolean {
	return (window?.since === undefined || at >= window.since) && (window?.until === undefined || at < window.until);
}

/** Whether activity from `first` through `last` overlaps `window`; an absent window overlaps everything. */
export function overlapsWindow(first: number, last: number, window: TimeWindow | undefined): boolean {
	return (
		(window?.since === undefined || last >= window.since) && (window?.until === undefined || first < window.until)
	);
}
