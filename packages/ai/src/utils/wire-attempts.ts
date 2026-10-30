import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Request attempts one logical provider call has made, counted where the
 * request is handed to a transport.
 *
 * The counter lives on the bottom `fetch` of the provider's stack — the one
 * every request is issued through — so every resend this repository owns sits
 * above it: a provider's own rungs (transport reopen, transport fallback,
 * checkpoint resume, rebuilt parameters, a client's retry budget),
 * `fetchWithRetry`, the uncompressed resend of
 * `wrapFetchForRequestCompression`, the identity resend of
 * `wrapFetchForCopilotFallback`, and any wrapper added between a provider and
 * the wire later. A resend is counted because of where the counter is, not
 * because its author remembered to count it. Each attempt is counted before
 * it goes out, so one that fails to open counts the same as one that answers.
 *
 * On the `stream()` path that bottom is `transportFetch`, which owns the
 * counter; a provider called directly installs the counter over the runtime's
 * `fetch` itself ({@link wireCountedFetch}). Either way a provider reads the
 * count off the `fetch` it was handed: the number and the requests it counts
 * are the same object.
 *
 * **Attempts, not HTTP requests.** Below the counter there is only a transport
 * that issues one request per call — the runtime's `fetch`, or `coworkFetch`
 * — and that can still turn one attempt into more than one HTTP request: a
 * redirect hop is followed inside `fetch`. A redirect is not a second
 * generation of the same request.
 *
 * **A caller-supplied `fetch` makes the count unknown.** It sits below the
 * counter and may resend inside itself, so a count taken above it cannot say
 * the request went out once: {@link providerReplaysFrom} reports `undefined`,
 * never `0`.
 */
export interface WireAttempts {
	count: number;
	/** An attempt went through a caller-supplied `fetch` the counter cannot see into. */
	opaque: boolean;
}

const WIRE_ATTEMPTS = Symbol("omp.wireAttempts");

type CountedFetch = FetchImpl & { [WIRE_ATTEMPTS]?: WireAttempts };

export function createWireAttempts(): WireAttempts {
	return { count: 0, opaque: false };
}

/**
 * `base` with every call counted into `attempts` just before it is issued,
 * and the counter stamped on the result so a provider handed it can read the
 * count ({@link wireAttemptsOf}). `opaque` says `base` is a caller-supplied
 * `fetch`: the first call through it makes the count unknown.
 */
export function countWireAttempts(attempts: WireAttempts, base: FetchImpl, opaque: boolean): FetchImpl {
	const counted: CountedFetch = (input, init) => {
		attempts.count += 1;
		if (opaque) attempts.opaque = true;
		return base(input, init);
	};
	if (base.preconnect) counted.preconnect = base.preconnect;
	counted[WIRE_ATTEMPTS] = attempts;
	return counted;
}

/** The counter on the `fetch` that issues this stack's requests, if it carries one. */
export function wireAttemptsOf(fetchImpl: FetchImpl | undefined): WireAttempts | undefined {
	return (fetchImpl as CountedFetch | undefined)?.[WIRE_ATTEMPTS];
}

/**
 * Lets a wrapper that issues its requests through `base` expose `base`'s
 * counter. Safe for any wrapper, resending or not: the count is still taken
 * in `base`, below it.
 */
export function inheritWireAttempts<T extends FetchImpl>(wrapper: T, base: FetchImpl): T {
	const attempts = wireAttemptsOf(base);
	if (attempts) (wrapper as CountedFetch)[WIRE_ATTEMPTS] = attempts;
	return wrapper;
}

/**
 * The `fetch` a provider builds its wrapper stack on, and the counter its
 * requests are counted into: `fetchImpl` itself when it already carries one
 * (`transportFetch`), else `fetchImpl` — or the runtime's `fetch` — under a
 * new counter. A provider reads its own share as the attempts made after it
 * started ({@link providerReplaysFrom}), so a counter reused across an auth
 * retry or a replay-safe wrapper's attempts is never charged twice.
 */
export function wireCountedFetch(fetchImpl: FetchImpl | undefined): { fetch: FetchImpl; attempts: WireAttempts } {
	const existing = wireAttemptsOf(fetchImpl);
	if (fetchImpl && existing) return { fetch: fetchImpl, attempts: existing };
	const attempts = createWireAttempts();
	return { fetch: countWireAttempts(attempts, fetchImpl ?? fetch, fetchImpl !== undefined), attempts };
}

/**
 * Attempts after the first since `start`, for
 * `AssistantMessage.providerReplays`, or `undefined` when an attempt went
 * through a transport the counter cannot see into. A call that never reached
 * the wire reports `0`, which is the truth a caller needs: nothing below
 * replayed it.
 */
export function providerReplaysFrom(attempts: WireAttempts, start = 0): number | undefined {
	return attempts.opaque ? undefined : Math.max(0, attempts.count - start - 1);
}
