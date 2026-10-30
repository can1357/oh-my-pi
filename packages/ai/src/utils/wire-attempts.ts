import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Request attempts one logical provider call has made so far, as seen at the
 * boundary this repo owns.
 *
 * Counted before the request goes out, so an attempt that fails to open counts
 * the same as one that answers. One counter lives for the whole call and
 * survives every recovery rung the provider owns (transport reopen, transport
 * fallback, checkpoint resume, rebuilt parameters, a client's own retry
 * budget), because each of those puts the request on the wire again.
 *
 * **Attempts, not HTTP requests.** The boundary is the call this repo makes,
 * and below it one attempt may be more or fewer HTTP requests than one:
 *
 * - a redirect hop is followed inside `fetch`, so a 307 is two HTTP requests
 *   and one attempt;
 * - a caller-supplied `fetch` that retries internally is opaque, so its extra
 *   requests are invisible here and the count stays at one attempt;
 * - a transport whose logical turn is several RPCs (Cursor sends `RunSSE` and
 *   `BidiAppend` for one run) counts the run, not the RPCs.
 *
 * What the count is for is the question "did a layer below already replay
 * this request", and an attempt is the unit that answers it: every rung that
 * replays goes through one.
 *
 * The number a caller above the provider needs is
 * {@link providerReplaysFrom}: everything after the first attempt.
 */
export interface WireAttempts {
	count: number;
}

export function createWireAttempts(): WireAttempts {
	return { count: 0 };
}

/**
 * Attempts after the first, for `AssistantMessage.providerReplays`. A call
 * that never reached the wire reports `0`, which is the truth a caller needs:
 * nothing below replayed it.
 */
export function providerReplaysFrom(attempts: WireAttempts | undefined): number {
	return Math.max(0, (attempts?.count ?? 0) - 1);
}

/**
 * Wraps a `fetch` so every call through it counts as one attempt.
 *
 * Installing the counter here rather than at each retry rung is what makes the
 * count complete on the fetch lane: `fetchWithRetry` replays a 5xx or a thrown
 * network failure on its own budget through this same implementation, and
 * those replays are invisible to every layer above it. Counting before the
 * call keeps an attempt that throws on the way out — a refused connection, a
 * rejected reopen — in the total.
 *
 * It sees calls, not HTTP requests: a redirect `fetch` follows and a
 * caller-supplied implementation that retries inside itself are both one call
 * here. Measured equal to counting immediately around the inner `fetchImpl`
 * across HTTP retry, synchronous throw, URL rebuilding and `prepareInit`.
 */
export function countWireAttempts(attempts: WireAttempts, impl: FetchImpl): FetchImpl {
	return (input, init) => {
		attempts.count += 1;
		return impl(input, init);
	};
}
