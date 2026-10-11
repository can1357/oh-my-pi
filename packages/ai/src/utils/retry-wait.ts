import { scheduler } from "node:timers/promises";

/** Injected retry sleep: `StreamOptions.providerRetryWait` / `UsageFetchContext.retryWait`. */
export type RetryWaitHook = (delayMs: number, signal?: AbortSignal) => Promise<void>;

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
