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
 * A delay as the long-timer helpers read it, so no caller can pass them a
 * value they mishandle: `Number(delay)`, so a numeric string counts as its
 * number; `NaN`, a negative number and anything that is not a number become 0,
 * as a platform timer treats them; `Infinity` stays `Infinity`, a timer that
 * never fires and a wait that is rejected.
 */
function toDelayMs(delay: unknown): number {
	const ms = Number(delay);
	return ms > 0 ? ms : 0;
}

/**
 * Split a delay into equal chunks a platform timer can hold: one chunk within
 * {@link MAX_TIMER_DELAY_MS}, `Infinity` chunks of the maximum for an infinite
 * delay. The chunks add up to the delay, rounded up by less than 1 ms each.
 */
function timerChunks(delay: number): { chunks: number; chunkMs: number } {
	if (!(delay > MAX_TIMER_DELAY_MS)) return { chunks: 1, chunkMs: delay };
	if (delay === Infinity) return { chunks: Infinity, chunkMs: MAX_TIMER_DELAY_MS };
	const chunks = Math.ceil(delay / MAX_TIMER_DELAY_MS);
	return { chunks, chunkMs: Math.ceil(delay / chunks) };
}

/**
 * Wait out `delay` as back-to-back `scheduler.wait` chunks of at most
 * {@link MAX_TIMER_DELAY_MS}, counted against the total. Each chunk is a real
 * wait of known length, so the clock is never read: a clock that stands still
 * while timers resolve (fake timers with a stubbed `scheduler.wait`, as many
 * tests set up) cannot keep it looping, and it makes at most
 * `ceil(delay / MAX_TIMER_DELAY_MS)` waits. A wait of `Infinity` can only end
 * by abort, so it is rejected instead of hanging its caller.
 */
async function waitChunks(delay: number, signal: AbortSignal | undefined): Promise<void> {
	if (delay === Infinity) throw new RangeError("A wait of Infinity ms can never end");
	for (let remaining = delay; remaining > 0; remaining -= MAX_TIMER_DELAY_MS) {
		await scheduler.wait(Math.min(remaining, MAX_TIMER_DELAY_MS), { signal });
		signal?.throwIfAborted();
	}
}

/**
 * Abortable sleep for arbitrarily long delays: it returns at once for a delay
 * of 0 and otherwise waits the delay as counted chunks a timer can hold, never
 * reading the clock (see {@link waitChunks}). An abort during any chunk rejects
 * like `scheduler.wait`. The delay is read as {@link toDelayMs} describes; an
 * infinite one rejects with a `RangeError`.
 */
export async function sleepLong(delayMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await waitChunks(toDelayMs(delayMs), signal);
}

/**
 * `scheduler.wait` for any delay; use it in place of a `scheduler.wait` whose
 * delay can come from a user. A delay within {@link MAX_TIMER_DELAY_MS},
 * including 0, is one `scheduler.wait`, exactly as a direct call; a longer one,
 * which a direct call fires after 1 ms, is waited as counted chunks that never
 * read the clock. The delay is read as {@link toDelayMs} describes; an infinite
 * one rejects with a `RangeError`.
 */
export async function waitLong(delayMs: number, signal?: AbortSignal): Promise<void> {
	const delay = toDelayMs(delayMs);
	if (delay <= MAX_TIMER_DELAY_MS) return scheduler.wait(delay, { signal });
	await waitChunks(delay, signal);
}

/** A pending {@link setLongTimeout} or {@link setLongInterval}. */
export interface LongTimeout {
	/**
	 * The one platform timer that carries every chunk, stable for the whole
	 * delay: `clearTimeout`/`clearInterval`, `ref` and `unref` on it act on the
	 * whole delay.
	 */
	readonly timer: Timer;
	/** Cancel the delay; a no-op once it has fired or been cleared. */
	clear(): void;
}

/**
 * `setTimeout` for any delay. A platform timer fires a delay past
 * {@link MAX_TIMER_DELAY_MS} after 1 ms, so a longer delay runs as equal chunks
 * of one timer, re-armed with `refresh()` and counted against the total: the
 * clock is never read, so a clock that stands still cannot keep it from firing.
 * A delay within the limit is one ordinary timer. The delay is read as
 * {@link toDelayMs} describes; `Infinity` never fires. `unref` keeps the
 * pending timer from holding the process open.
 */
export function setLongTimeout(callback: () => void, delayMs: number, options?: { unref?: boolean }): LongTimeout {
	const plan = timerChunks(toDelayMs(delayMs));
	let chunks = plan.chunks;
	const timer = setTimeout(() => {
		chunks -= 1;
		if (chunks > 0) timer.refresh();
		else callback();
	}, plan.chunkMs);
	if (options?.unref) timer.unref();
	return { timer, clear: () => clearTimeout(timer) };
}

/**
 * `setInterval` for any period. A platform timer repeats a period past
 * {@link MAX_TIMER_DELAY_MS} every 1 ms, so a longer period runs as an interval
 * of equal chunks that calls back once every period's worth of chunks, never
 * reading the clock. A period within the limit is one ordinary interval. The
 * period is read as {@link toDelayMs} describes; `Infinity` never calls back.
 */
export function setLongInterval(callback: () => void, intervalMs: number, options?: { unref?: boolean }): LongTimeout {
	const { chunks, chunkMs } = timerChunks(toDelayMs(intervalMs));
	let elapsedChunks = 0;
	const timer = setInterval(() => {
		elapsedChunks += 1;
		if (elapsedChunks < chunks) return;
		elapsedChunks = 0;
		callback();
	}, chunkMs);
	if (options?.unref) timer.unref();
	return { timer, clear: () => clearInterval(timer) };
}

/**
 * Wait for a wall-clock deadline, including time spent suspended. Some platforms
 * exclude suspend from relative timers, so recheck the wall clock at least once
 * per second. Each wait also counts against the time left when it started, so a
 * wall clock that stands still or steps back cannot keep it waiting longer than
 * that: it makes at most `ceil(remaining / 1000)` waits. A deadline that is not a
 * number has passed; an infinite one rejects with a `RangeError`.
 */
export async function sleepUntil(deadlineMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Number(deadlineMs);
	if (deadline === Infinity) throw new RangeError("A wait until an infinite deadline can never end");
	let budget = deadline - Date.now();
	while (true) {
		signal?.throwIfAborted();
		const remaining = deadline - Date.now();
		if (!(remaining > 0) || !(budget > 0)) return;
		const chunk = Math.min(remaining, budget, 1_000);
		await scheduler.wait(chunk, { signal });
		budget -= chunk;
	}
}

/**
 * Wrap a promise with a timeout and optional abort signal.
 * Rejects with the given error or a new error containing the given message if
 * the timeout fires first. Cleans up all listeners on settlement. A timeout
 * past {@link MAX_TIMER_DELAY_MS} is honoured, not fired after 1 ms.
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
	const timeoutTimer = setLongTimeout(() => {
		if (settled) return;
		settled = true;
		if (signal) signal.removeEventListener("abort", onAbort);
		reject(typeof timeout === "string" ? new Error(timeout) : timeout);
	}, ms);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		timeoutTimer.clear();
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(
		value => {
			if (settled) return;
			settled = true;
			timeoutTimer.clear();
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		err => {
			if (settled) return;
			settled = true;
			timeoutTimer.clear();
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
 *
 * `unref` lets a long batch window not hold the process open; the owner must
 * then {@link flush} on shutdown or the pending batch is lost.
 */
export class AsyncDrain<T> {
	#queue?: T[];
	#promise = Promise.resolve();
	#flush?: () => void;
	readonly #unref: boolean;

	constructor(
		readonly delayMs: number = 0,
		options?: { unref?: boolean },
	) {
		this.#unref = options?.unref === true;
	}

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
				const timer = setLongTimeout(exec, this.delayMs, { unref: this.#unref });
				this.#flush = () => {
					timer.clear();
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
