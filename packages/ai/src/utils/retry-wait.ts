import { scheduler } from "node:timers/promises";

/** Injected retry sleep: `StreamOptions.providerRetryWait` / `UsageFetchContext.retryWait`. */
export type RetryWaitHook = (delayMs: number, signal?: AbortSignal) => Promise<void>;

/** Default cap on a server-stated retry wait: `StreamOptions.maxRetryDelayMs`. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Delay before a provider retry: the longer of the wait the server stated and
 * the loop's own backoff. `undefined` means the stated wait exceeds
 * `maxRetryDelayMs`, so the caller surfaces the failure instead of parking the
 * stream; a non-positive cap disables the bound.
 */
export function resolveRetryDelayMs(
	statedWaitMs: number | undefined,
	backoffMs: number,
	maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
): number | undefined {
	if (statedWaitMs === undefined) return backoffMs;
	if (maxRetryDelayMs > 0 && statedWaitMs > maxRetryDelayMs) return undefined;
	return Math.max(statedWaitMs, backoffMs);
}

/**
 * Waits `delayMs` between retry attempts. Honors the caller's retry-wait hook
 * when one is set (tests and custom transports inject it to avoid real sleeps)
 * and otherwise sleeps on `signal`, so an abort rejects instead of the retry
 * proceeding.
 */
export async function waitForRetry(
	retryWait: RetryWaitHook | undefined,
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (retryWait) await retryWait(delayMs, signal);
	else await scheduler.wait(delayMs, { signal });
}
