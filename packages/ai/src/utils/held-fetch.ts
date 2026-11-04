import { afterRequestHolds } from "../request-holds";
import type { FetchImpl } from "../types";

/** The form of a fetch that waits for the request holds right before its own I/O. */
const HELD_FORM = Symbol("omp.heldFetch");

type HoldableFetch = FetchImpl & { [HELD_FORM]?: FetchImpl };

/**
 * The fetch a model request is sent through: each call waits for the request
 * holds of the async context it is made in ({@link afterRequestHolds}), then
 * calls `fetchImpl` in the same turn. The call's own abort signal ends the wait
 * with an `AbortError`. Every call is held, so a retry or a fallback sent
 * through it is held again.
 *
 * A fetch given a held form by {@link withHeldForm} returns that form, which
 * waits beneath the fetch's own preparation (signing, a token fetch, debug
 * recording) rather than before it. Build wrappers that prepare the request
 * (compression, body rewrites) on top of the held fetch, not under it.
 */
export function heldFetch(fetchImpl: FetchImpl): FetchImpl {
	const own = (fetchImpl as HoldableFetch)[HELD_FORM];
	if (own) return own;
	const held: HoldableFetch = (input, init) => {
		// As `fetch` reads it: an `init.signal` given — `null` included, `undefined` not — replaces the Request's.
		const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
		return afterRequestHolds(signal ?? undefined, () => fetchImpl(input, init));
	};
	if (fetchImpl.preconnect) held.preconnect = fetchImpl.preconnect;
	held[HELD_FORM] = held;
	return held;
}

/**
 * Makes `held` the form {@link heldFetch} returns for `fetchImpl`: a fetch that
 * prepares each request (a token, a signature) and holds after that
 * preparation. `held` is its own held form. Returns `fetchImpl`.
 */
export function withHeldForm<T extends FetchImpl>(fetchImpl: T, held: FetchImpl): T {
	(held as HoldableFetch)[HELD_FORM] = held;
	(fetchImpl as HoldableFetch)[HELD_FORM] = held;
	return fetchImpl;
}
