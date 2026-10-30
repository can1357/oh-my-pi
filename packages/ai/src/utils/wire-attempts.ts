import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Wire requests one logical provider call has issued so far.
 *
 * Counted at the request boundary — incremented before the request goes out,
 * so an attempt that fails to open counts the same as one that answers. One
 * counter lives for the whole call and survives every recovery rung the
 * provider owns (transport reopen, transport fallback, checkpoint resume,
 * rebuilt parameters), because each of those re-sends the request.
 *
 * The count a caller above the provider needs is
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
 * Wraps a `fetch` so every request it carries is counted.
 *
 * Installing the counter here rather than at each retry rung is what makes the
 * count complete: `fetchWithRetry` replays a 5xx or a thrown network failure on
 * its own budget through this same implementation, and those replays are
 * invisible to every layer above it. Counting before the call keeps an attempt
 * that throws on the way out — a refused connection, a rejected reopen — in the
 * total.
 */
export function countWireAttempts(attempts: WireAttempts, impl: FetchImpl): FetchImpl {
	return (input, init) => {
		attempts.count += 1;
		return impl(input, init);
	};
}
