import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Request attempts one logical request has made, counted where each request is
 * handed to a transport.
 *
 * **Where.** The counter lives on the bottom `fetch` of the provider's stack —
 * the one every request is issued through — so every resend this repository
 * owns sits above it: a provider's own rungs (transport reopen, transport
 * fallback, checkpoint resume, rebuilt parameters, a client's retry budget),
 * `fetchWithRetry`, the uncompressed resend of
 * `wrapFetchForRequestCompression`, the identity resend of
 * `wrapFetchForCopilotFallback`, and any wrapper added between a provider and
 * the wire later. A resend is counted because of where the counter is, not
 * because its author remembered to count it. Each attempt is counted before
 * it goes out, so one that fails to open counts the same as one that answers.
 *
 * **How long.** One counter per logical request, not per provider call and not
 * per transport. It rides on the `fetch` in the request's options, so every
 * layer that sends the request again by calling the provider again with the
 * same options — the authentication retry in `streamSimple`, a replay-safe
 * stream wrapper — reaches the same counter, while a new call starts a new one
 * even when it is handed the same built transport. A provider reports what the
 * counter holds ({@link providerReplaysFrom}), never its own share, so no layer
 * above has to add anything up and no layer can forget to.
 *
 * On the `stream()` path the counter is created per logical request by
 * `withRequestTransport`, over that request's transport; a provider called
 * directly creates it at its outermost entry ({@link withWireCount}). Either
 * way a provider reads the count off the `fetch` it was handed: the number and
 * the requests it counts are the same object.
 *
 * **Attempts, not HTTP requests.** Below the counter there is only a transport
 * that issues one request per call — the runtime's `fetch`, or `coworkFetch`
 * — and that can still turn one attempt into more than one HTTP request: a
 * redirect hop is followed inside `fetch`. A redirect is not a second
 * generation of the same request.
 *
 * **Only model requests.** A request the provider makes for itself on the same
 * transport — an OAuth token, say — goes through {@link uncountedFetchOf}, so
 * it is not mistaken for a second attempt at the model request.
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
const UNCOUNTED_FETCH = Symbol("omp.uncountedFetch");

type CountedFetch = FetchImpl & { [WIRE_ATTEMPTS]?: WireAttempts; [UNCOUNTED_FETCH]?: FetchImpl };

export function createWireAttempts(): WireAttempts {
	return { count: 0, opaque: false };
}

/**
 * `base` with every call counted into `attempts` just before it is issued.
 * The counter is stamped on the result so a provider handed it can read the
 * count ({@link wireAttemptsOf}), and `base` itself is stamped as its uncounted
 * sibling ({@link uncountedFetchOf}). `opaque` says `base` is a
 * caller-supplied `fetch`: the first call through it makes the count unknown.
 */
export function countWireAttempts(attempts: WireAttempts, base: FetchImpl, opaque: boolean): FetchImpl {
	const counted: CountedFetch = (input, init) => {
		attempts.count += 1;
		if (opaque) attempts.opaque = true;
		return base(input, init);
	};
	if (base.preconnect) counted.preconnect = base.preconnect;
	counted[WIRE_ATTEMPTS] = attempts;
	counted[UNCOUNTED_FETCH] = base;
	return counted;
}

/** The counter on the `fetch` that issues this request, if it carries one. */
export function wireAttemptsOf(fetchImpl: FetchImpl | undefined): WireAttempts | undefined {
	return (fetchImpl as CountedFetch | undefined)?.[WIRE_ATTEMPTS];
}

/**
 * Stamps `uncounted` as the sibling of the counted `fetch` that issues the same
 * way without counting: what the request's counted transport
 * (`withRequestTransport`) offers for requests that are not model attempts.
 */
export function withUncountedSibling<T extends FetchImpl>(counted: T, uncounted: FetchImpl): T {
	(counted as CountedFetch)[UNCOUNTED_FETCH] = uncounted;
	return counted;
}

/**
 * The `fetch` to send a request through that is not an attempt at the model
 * request — an OAuth token, a metadata read — over the same transport as
 * `fetchImpl` but without counting. `fetchImpl` itself when it carries no
 * counter, since such a `fetch` counts nothing.
 */
export function uncountedFetchOf(fetchImpl: FetchImpl): FetchImpl {
	return (fetchImpl as CountedFetch)[UNCOUNTED_FETCH] ?? fetchImpl;
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
 * requests are counted into: `fetchImpl` itself when it already carries one —
 * the request's counter, created by `withRequestTransport` or by
 * {@link withWireCount} — else `fetchImpl`, or the runtime's `fetch`, under a
 * new one.
 */
export function wireCountedFetch(fetchImpl: FetchImpl | undefined): { fetch: FetchImpl; attempts: WireAttempts } {
	const existing = wireAttemptsOf(fetchImpl);
	if (fetchImpl && existing) return { fetch: fetchImpl, attempts: existing };
	const attempts = createWireAttempts();
	return { fetch: countWireAttempts(attempts, fetchImpl ?? fetch, fetchImpl !== undefined), attempts };
}

/**
 * `options` with a counted `fetch`, for the outermost entry of a provider
 * called directly: every call it makes to the provider with these options —
 * every attempt a replay-safe wrapper makes — counts into one counter. On the
 * `stream()` path `options.fetch` already carries the request's counter and
 * `options` comes back unchanged.
 */
export function withWireCount<T extends { fetch?: FetchImpl }>(options: T | undefined): T {
	const given = (options ?? {}) as T;
	if (wireAttemptsOf(given.fetch)) return given;
	return { ...given, fetch: wireCountedFetch(given.fetch).fetch };
}

/**
 * Every attempt after the first the logical request has made so far, for
 * `AssistantMessage.providerReplays`, or `undefined` when an attempt went
 * through a transport the counter cannot see into. A request that never
 * reached the wire reports `0`, which is the truth a caller needs: nothing
 * below replayed it.
 */
export function providerReplaysFrom(attempts: WireAttempts): number | undefined {
	return attempts.opaque ? undefined : Math.max(0, attempts.count - 1);
}
