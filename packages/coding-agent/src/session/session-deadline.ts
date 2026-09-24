/** Remaining wall-clock budget until an absolute `--max-time` deadline. */
export function remainingSessionDeadlineMs(deadline: number | undefined, now = Date.now()): number | undefined {
	if (deadline === undefined) return undefined;
	return Math.max(0, deadline - now);
}

/**
 * Smallest budget a fallback hop needs to reach first token on a healthy
 * model. Fixed rather than proportional so a slow-but-viable primary is only
 * preempted near the deadline instead of at half the remaining budget.
 */
export const FALLBACK_HOP_RESERVE_MS = 15_000;

/**
 * Bound a per-attempt hang/backoff so `--max-time` cannot expire before a
 * configured fallback chain hop.
 *
 * The reserve is `min(FALLBACK_HOP_RESERVE_MS, remaining / 2)`: a fixed slice
 * for one hop, never more than half the budget so the primary always keeps at
 * least half. Callers must pass `reserveFallbackHop` only when this
 * request/model has an eligible configured hop (`retry.modelFallback` plus a
 * non-empty `retry.fallbackChains` candidate). Without a hop only 1s is
 * withheld, so the attempt still fails as retryable rather than as a terminal
 * deadline abort, and a primary with no chain keeps nearly the full budget.
 *
 * `durationMs <= 0` (including an explicit disabled watchdog) is replaced by
 * the cap when a deadline exists: `--max-time` must still be able to abort a
 * hung primary. With no deadline the caller-supplied duration is unchanged.
 *
 * This does trade happy path for reachability: a primary that would have
 * answered within the last `FALLBACK_HOP_RESERVE_MS` of the budget now fails
 * over instead of finishing. That window is bounded and independent of
 * `--max-time`, unlike a proportional reserve which preempts any attempt
 * needing more than half the remaining time.
 */
export function capDurationToSessionDeadline(
	durationMs: number | undefined,
	remainingMs: number | undefined,
	reserveFallbackHop: boolean,
): number | undefined {
	if (remainingMs === undefined) return durationMs;
	const desiredReserveMs = reserveFallbackHop ? FALLBACK_HOP_RESERVE_MS : 1_000;
	const hopReserveMs = Math.min(desiredReserveMs, Math.floor(remainingMs / 2));
	const cap = Math.max(1, remainingMs - hopReserveMs);
	if (durationMs === undefined || durationMs <= 0) return cap;
	return Math.min(durationMs, cap);
}
