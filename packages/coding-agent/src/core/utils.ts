// Utility constant for representing aborted operations
const kAbortError = new Error("Operation aborted");

/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with a standard error.
 *
 * @param signal - Optional AbortSignal to cancel the operation
 * @param pr - Function returning a promise to run
 * @returns Promise resolving as `pr` would, or rejecting on abort
 */
export function untilAborted<T>(signal: AbortSignal | undefined | null, pr: () => Promise<T>): Promise<T> {
	if (!signal) {
		return pr();
	}

	if (signal.aborted) {
		return Promise.reject(kAbortError);
	}

	return new Promise((resolve, reject) => {
		const listener = () => reject(kAbortError);
		signal.addEventListener("abort", listener, { once: true });

		signal.throwIfAborted();

		pr()
			.then(resolve, reject)
			.finally(() => {
				signal.removeEventListener("abort", listener);
			});
	});
}

/**
 * Memoizes a function with no arguments, calling it once and caching the result.
 *
 * @param fn - Function to be called once
 * @returns A function that returns the cached result of `fn`
 */
export function once<T>(fn: () => T): () => T {
	let store = undefined as { value: T } | undefined;
	return () => {
		if (store) {
			return store.value;
		}
		const value = fn();
		store = { value };
		return value;
	};
}
