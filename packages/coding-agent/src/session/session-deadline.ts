/** Remaining wall-clock budget until an absolute `--max-time` deadline. */
export function remainingSessionDeadlineMs(deadline: number | undefined, now = Date.now()): number | undefined {
	if (deadline === undefined) return undefined;
	return Math.max(0, deadline - now);
}

/**
 * Bound a per-attempt hang/backoff so `--max-time` cannot expire before a
 * configured fallback chain hop. When model fallback is enabled, leave at
 * least half the remaining budget (and at least 1s) for the hop.
 */
export function capDurationToSessionDeadline(
	durationMs: number | undefined,
	remainingMs: number | undefined,
	modelFallback: boolean,
): number | undefined {
	if (remainingMs === undefined) return durationMs;
	const hopReserveMs = modelFallback ? Math.max(1_000, Math.floor(remainingMs / 2)) : 1_000;
	const cap = Math.max(1, remainingMs - Math.min(hopReserveMs, Math.max(0, remainingMs - 1)));
	if (durationMs === undefined || durationMs <= 0) return cap;
	return Math.min(durationMs, cap);
}
