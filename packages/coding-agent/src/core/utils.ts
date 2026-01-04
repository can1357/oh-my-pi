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

// ScopeSignal is a cancellation/helper utility similar to AbortController but
// allows composition of an existing AbortSignal and/or a timeout. It exposes a
// simple API for cancellation observation (finally, catch).
interface ScopeSignalOptions {
	signal?: AbortSignal;
	timeout?: number;
}

const kTimeoutReason = new Error("Timeout");
const kDisposedReason = new Error("Disposed");

/**
 * Type of signal exit (None = disposed, TimedOut = timed out, Aborted = underlying signal aborted)
 */
enum ExitReason {
	None = 0,
	TimedOut = 1,
	Aborted = 2,
}

/**
 * ScopeSignal: composable cancellation for async work–observes an external AbortSignal and/or a timeout.
 *
 * Use .finally(fn) to register a one-time callback invoked on *any* exit (abort, timeout, or manual dispose).
 * Use .catch(fn) to register a one-time callback invoked only on abort/timeout.
 *
 * Disposing ScopeSignal disables further callbacks.
 */
export class ScopeSignal implements Disposable {
	#signal: AbortSignal | undefined;
	#timer: NodeJS.Timeout | undefined;
	#exit = undefined as ExitReason | undefined;
	#onAbort: (() => void) | undefined;
	#callbacks?: (() => void)[];
	#reason: unknown | undefined;

	/**
	 * Provides abort/timeout reason (Error or user-defined).
	 */
	get reason(): unknown | undefined {
		return this.#reason;
	}

	/**
	 * True if exited due to external AbortSignal or timeout.
	 */
	get aborted(): boolean {
		return this.#exit !== undefined && this.#exit > ExitReason.None;
	}

	/**
	 * True if this ScopeSignal timed out (not external abort).
	 */
	timedOut(): boolean {
		return this.#exit === ExitReason.TimedOut;
	}

	/**
	 * Create a new ScopeSignal, optionally observing an AbortSignal and/or auto-aborting after a timeout (ms).
	 */
	constructor(options?: ScopeSignalOptions) {
		const { signal, timeout } = options ?? {};

		if (signal?.aborted) {
			this.#abort(ExitReason.Aborted, signal.reason); // Immediately abort if already-aborted
			return;
		}
		if (timeout && timeout <= 0) {
			this.#abort(ExitReason.TimedOut, kTimeoutReason);
			return;
		}

		// Observe external signal if provided
		if (signal) {
			const onAbort = () => {
				this.#abort(ExitReason.Aborted, signal.reason);
			};
			this.#signal = signal;
			this.#onAbort = onAbort;
			this.#signal.addEventListener("abort", onAbort, { once: true });
		}

		// Set up timeout if provided
		if (timeout) {
			this.#timer = setTimeout(() => {
				this.#abort(ExitReason.TimedOut, kTimeoutReason);
			}, timeout);
		}
	}

	/**
	 * Register a one-time callback invoked on any exit (abort, timeout, or manual dispose).
	 * Runs immediately if already exited.
	 */
	finally(onfinally: () => void): void {
		if (this.#exit !== undefined) {
			onfinally();
			return;
		}
		this.#callbacks ??= [];
		this.#callbacks.push(onfinally);
	}

	/**
	 * Register a one-time callback invoked only if exited due to abort/timeout (not normal disposal).
	 */
	catch(oncatch: (reason: unknown) => void): void {
		this.finally(() => {
			if (this.aborted) {
				oncatch(this.reason);
			}
		});
	}

	/** Internal: cause exit; only first call takes effect. */
	#abort(exit: ExitReason, reason?: unknown): void {
		if (this.#exit !== undefined) return;
		this.#reason = reason;
		clearTimeout(this.#timer);
		this.#signal?.removeEventListener("abort", this.#onAbort!);

		this.#exit = exit;

		const callbacks = this.#callbacks;
		this.#callbacks = undefined;
		callbacks?.forEach((fn) => void fn());
	}

	/**
	 * Dispose: marks as normally exited (not abort/timeout); disables further callback registration.
	 */
	[Symbol.dispose](): void {
		this.#abort(ExitReason.None, kDisposedReason);
	}
}
