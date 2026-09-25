import * as AIError from "../error";

/**
 * Race `promise` against `signal`, rejecting only this caller when the signal
 * fires. The underlying promise keeps running so other awaiters on the same
 * single-flight operation aren't punished by a peer's cancel.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new AIError.AbortError(message));
	const abort = Promise.withResolvers<never>();
	const onAbort = (): void => abort.reject(new AIError.AbortError(message));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, abort.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}
