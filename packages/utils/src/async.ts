import { scheduler } from "node:timers/promises";

/**
 * Largest delay `setTimeout` (and `timers/promises` `scheduler.wait`)
 * accepts without 32-bit signed overflow: larger values wrap and fire
 * almost immediately instead of sleeping. Chunk day-scale provider waits
 * (e.g. a monthly quota reset parsed from an error hint) so the full
 * duration elapses instead of overflowing the timer.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Abortable sleep for arbitrarily long delays. Waits longer than
 * {@link MAX_TIMER_DELAY_MS} chunk the sleep into back-to-back timer waits
 * so no single timer overflows; an abort during any chunk rejects like
 * `scheduler.wait`.
 *
 * The remainder is deliberately consumed by chunk, not recomputed from a
 * monotonic deadline: deadline tracking never terminates under the repo's
 * instant `scheduler.wait` mocks (retry-cap suites spy it to resolve
 * immediately, so `deadline - performance.now()` never reaches zero and the
 * loop spins forever). A premature native wake (Bun `uv_async_send`, see
 * `sleepAtLeast` in `packages/agent/src/utils/yield.ts`) can therefore
 * under-wait by the unelapsed chunk time — but that self-corrects downstream:
 * credential blocks carry the true deadline independently of this sleep, so
 * an early retry re-hits 429 and re-sleeps on a fresh server hint.
 */
export async function sleepLong(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let remaining = delayMs;
	while (remaining > 0) {
		await scheduler.wait(Math.min(remaining, MAX_TIMER_DELAY_MS), { signal });
		remaining -= MAX_TIMER_DELAY_MS;
		signal?.throwIfAborted();
	}
}

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given error or a new error containing the given message if
 * the timeout fires first. Cleans up all listeners on settlement.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	timeout: string | Error,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
		return Promise.reject(reason);
	}

	const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(typeof timeout === "string" ? new Error(timeout) : timeout);
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);

	return wrapped;
}

/**
 * Coalesces rapid-fire writes into one deferred batch. `push` queues a value
 * and returns a promise for the batch flush; the first push of a batch arms a
 * timer (`delayMs`, or a microtask at 0), and every push before it fires joins
 * the same batch and shares the same promise. Used to keep hot paths off
 * synchronous storage (prompt history, model perf).
 */
export class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();
	#flush?: () => void;

	constructor(readonly delayMs: number = 0) {}

	/** Queue `value`; `hnd` receives the whole batch when the window closes. */
	push(value: T, hnd: (values: T[]) => Promise<void> | void): Promise<void> {
		let queue = this.#queue;
		if (!queue) {
			const batch: T[] = [];
			this.#queue = batch;
			queue = batch;
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const exec = (): void => {
				if (this.#queue !== batch) return;
				this.#queue = undefined;
				this.#flush = undefined;
				try {
					resolve(hnd(batch));
				} catch (error) {
					reject(error);
				}
			};
			if (this.delayMs > 0) {
				const timer = setTimeout(exec, this.delayMs);
				this.#flush = () => {
					clearTimeout(timer);
					exec();
				};
			} else {
				this.#flush = exec;
				queueMicrotask(exec);
			}
			this.#promise = promise;
		}
		queue.push(value);
		return this.#promise;
	}

	/** Runs the pending batch handler immediately and returns its completion promise. */
	flush(): Promise<void> {
		this.#flush?.();
		return this.#promise;
	}
}

/**
 * Runs async operations one at a time in call order. Each `run` starts after
 * the previous operation settles (success or failure) and returns that
 * operation's own promise, so a rejected step never poisons the queue. Used by
 * stateful cursors whose concurrent pulls must not interleave.
 */
export class Serial {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(op: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(op, op);
		this.#tail = result.catch(() => {});
		return result;
	}
}
