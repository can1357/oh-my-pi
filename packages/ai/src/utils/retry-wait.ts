import { scheduler } from "node:timers/promises";
import type { StreamOptions } from "../types";

/**
 * Waits `delayMs` between provider retry attempts. Honors the caller's
 * `providerRetryWait` hook when one is set (tests and custom transports inject
 * it to avoid real sleeps) and otherwise sleeps on `signal`, so an abort
 * rejects instead of the retry proceeding.
 */
export async function waitForRetry(
	providerRetryWait: StreamOptions["providerRetryWait"],
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (providerRetryWait) await providerRetryWait(delayMs, signal);
	else await scheduler.wait(delayMs, { signal });
}
