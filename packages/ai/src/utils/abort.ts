import * as AIError from "../error";

export interface AbortSourceTracker {
	requestAbortController: AbortController;
	requestSignal: AbortSignal;
	abortLocally(reason: Error): Error;
	getLocalAbortReason(): Error | undefined;
	wasCallerAbort(): boolean;
}

/**
 * Tracks whether a merged request signal was aborted by the caller or by provider-local logic.
 *
 * Caller aborts always take priority. When both the caller and a local watchdog fire near
 * each other, the merged `requestSignal.reason` reflects whichever AbortController called
 * `.abort()` first — but ordering is racy and not meaningful for upstream consumers. What
 * matters is intent: if the caller's signal aborted, the request was cancelled by the
 * caller, and any local watchdog reason is incidental and **MUST NOT** be surfaced as a
 * retryable transient error (which would cause auto-retry to re-enter streaming and leave
 * the UI showing a spinner the user already tried to cancel).
 */
export function createAbortSourceTracker(callerSignal?: AbortSignal): AbortSourceTracker {
	const requestAbortController = new AbortController();
	const requestSignal = callerSignal
		? AbortSignal.any([callerSignal, requestAbortController.signal])
		: requestAbortController.signal;
	let localAbortReason: Error | undefined;

	return {
		requestAbortController,
		requestSignal,
		abortLocally(reason) {
			localAbortReason = reason;
			requestAbortController.abort(reason);
			return reason;
		},
		getLocalAbortReason() {
			// Caller intent dominates. Surface a local reason only when the caller did not
			// abort, so timeout/idle-watchdog errors don't masquerade as the user's cancel.
			if (!localAbortReason || callerSignal?.aborted) return undefined;
			return requestSignal.reason === localAbortReason ? localAbortReason : undefined;
		},
		wasCallerAbort() {
			// If the caller signal aborted, treat it as a caller abort regardless of which
			// AbortController won the race to set `requestSignal.reason`. The previous
			// `requestSignal.reason !== localAbortReason` heuristic flipped the result to
			// `false` when a local watchdog fired microseconds before the user's ESC, which
			// then routed user-initiated cancels through the auto-retry transient-error
			// path.
			return callerSignal?.aborted === true;
		},
	};
}

/**
 * Race a shared promise against a caller's AbortSignal without coupling the
 * underlying work to that signal. The shared promise keeps running (and caches
 * its result) even when an individual caller bails out.
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new AIError.AbortError());
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(signal.reason ?? new AIError.AbortError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
