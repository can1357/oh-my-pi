import { admitSharedStart } from "./request-hold-scope";

/**
 * Work that several callers share, with a lifetime of its own.
 *
 * A single-flight lookup (a token refresh, a credential or usage fetch, a saved-reset redemption) is
 * started by whichever caller comes first, but it serves every caller that joins it. Given the first
 * caller's signal, that caller's cancellation would fail every other caller; given no signal, it would
 * run on after every caller has gone. A `SharedFlight` gives the work a signal of its own, which aborts
 * only once no caller is still waiting. Each caller joins with its own signal, which ends only its own
 * wait, and a caller that joins later keeps the work alive. A held caller (its owner began disposing)
 * may join work in flight but never starts any.
 */
export class SharedFlight<T> {
	readonly #controller = new AbortController();
	readonly #promise: Promise<T>;
	#waiting = 0;
	#done = false;
	/** Settles, never rejecting, once the work has settled. */
	readonly settled: Promise<void>;
	/**
	 * Settles, never rejecting, with the work's failure once it fails, or `undefined` once it succeeds.
	 * A caller that stopped waiting can still learn what the work found (a provider's answer, say).
	 */
	readonly failure: Promise<unknown>;

	private constructor(work: (signal: AbortSignal) => Promise<T>) {
		// The work starts on the next microtask, once the caller that started the flight has joined it: a
		// caller that leaves while the work's first synchronous steps run (a lease taken, a store read)
		// must already count as waiting, so its leaving cancels work no other caller waits for.
		this.#promise = Promise.resolve().then(() => work(this.#controller.signal));
		// Registered before any caller's wait, so `#done` is set before a caller sees the result. It also
		// observes the work: work every caller left must not turn its rejection into an unhandled one.
		const done = (): void => {
			this.#done = true;
		};
		this.settled = this.#promise.then(done, done);
		this.failure = this.#promise.then(
			() => undefined,
			(error: unknown) => error ?? new Error("shared work failed"),
		);
	}

	/**
	 * Start `work` at once, on the flight's own signal, for the caller whose signal is `signal`; the
	 * caller then joins it like any other. A held caller starts nothing: it gets the refusal of
	 * `admitSharedStart`, which rejects once `signal` or the caller's scope ends, and `work` never runs.
	 * The caller registers the flight it gets in the same turn, so no later caller starts a second one.
	 */
	static start<T>(
		signal: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>,
	): SharedFlight<T> | Promise<never> {
		const refusal = admitSharedStart(signal);
		if (refusal) return refusal;
		return new SharedFlight(work);
	}

	/**
	 * Every caller stopped waiting before the work settled, so its signal has aborted and it can serve no
	 * new caller. A caller that finds it in flight waits for `settled`, then starts the work afresh: a
	 * retry never runs beside work that may still be finishing a mutation.
	 */
	get abandoned(): boolean {
		return this.#controller.signal.aborted;
	}

	/**
	 * Wait for the work's result. `signal` ends only this caller's wait, rejecting it with `abortError`;
	 * the work is cancelled when the last caller still waiting leaves. A caller with no signal waits until
	 * the work settles, and keeps it alive until then.
	 */
	join(signal?: AbortSignal, abortError: (signal: AbortSignal) => unknown = aborted => aborted.reason): Promise<T> {
		this.#waiting++;
		if (!signal) return this.#promise;
		if (signal.aborted) {
			this.#leave();
			return Promise.reject(abortError(signal));
		}
		const wait = Promise.withResolvers<T>();
		let waiting = true;
		const onAbort = (): void => {
			if (!waiting) return;
			waiting = false;
			this.#leave();
			wait.reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		this.#promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				if (!waiting) return;
				waiting = false;
				wait.resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				if (!waiting) return;
				waiting = false;
				wait.reject(error);
			},
		);
		return wait.promise;
	}

	#leave(): void {
		this.#waiting--;
		if (this.#waiting === 0 && !this.#done) {
			this.#controller.abort(new DOMException("Every caller stopped waiting for this shared work", "AbortError"));
		}
	}
}

const fetchKeys = new WeakMap<object, number>();
let nextFetchKey = 1;

/**
 * A key for the transport a caller asked for, to share work only among callers of the same `fetch`:
 * work sent through one caller's `fetch` must not serve a caller that brought another. Callers that
 * bring none (the default transport) share key 0.
 */
export function fetchKey(fetchImpl: object | undefined): number {
	if (!fetchImpl) return 0;
	let key = fetchKeys.get(fetchImpl);
	if (key === undefined) {
		key = nextFetchKey++;
		fetchKeys.set(fetchImpl, key);
	}
	return key;
}
