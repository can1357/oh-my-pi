/**
 * Parallel execution with concurrency control.
 */
/** Result of parallel execution */
export interface ParallelResult<R> {
	/** Results array - undefined entries indicate tasks that were skipped due to abort */
	results: (R | undefined)[];
	/** Whether execution was aborted before all tasks completed */
	aborted: boolean;
}

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * On abort: returns partial results with `aborted: true`. Completed tasks are preserved,
 * in-progress tasks will complete with their abort handling, skipped tasks are `undefined`.
 *
 * On error: fails fast - does not wait for other workers to complete.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item; receives a worker signal that fires on abort or fail-fast so in-flight siblings can cancel
 * @param signal - Optional abort signal to stop scheduling new work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : items.length;
	const effectiveConcurrency = normalizedConcurrency > 0 ? normalizedConcurrency : items.length;
	const limit = Math.max(1, Math.min(effectiveConcurrency, items.length));
	const results: (R | undefined)[] = new Array(items.length);
	let nextIndex = 0;

	// Create internal abort controller to cancel workers on any rejection
	const abortController = new AbortController();
	const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal;

	// Promise that rejects on first error - used to fail fast (not for abort)
	let rejectFirst: (error: unknown) => void;
	const firstErrorPromise = new Promise<never>((_, reject) => {
		rejectFirst = reject;
	});

	const worker = async (): Promise<void> => {
		while (true) {
			// On abort, stop picking up new work - but don't throw
			if (workerSignal.aborted) return;
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = await fn(items[index], index, workerSignal);
			} catch (error) {
				// On abort, the fn itself handles it and returns a result
				// Only propagate non-abort errors
				if (!workerSignal.aborted) {
					abortController.abort();
					rejectFirst(error);
					throw error;
				}
			}
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	try {
		await Promise.race([Promise.all(workers), firstErrorPromise]);
	} catch (error) {
		// If aborted, don't rethrow - return partial results
		if (signal?.aborted) {
			return { results, aborted: true };
		}
		throw error;
	}

	return { results, aborted: signal?.aborted ?? false };
}

/**
 * Simple counting semaphore for limiting concurrency across independently-scheduled async work.
 *
 * `max <= 0` (or any non-finite input) means unbounded — every `acquire()` resolves
 * immediately — matching `task.maxConcurrency = 0`'s "Unlimited" semantics in the
 * settings UI ([#3305](https://github.com/can1357/oh-my-pi/issues/3305)).
 */
export class Semaphore {
	#max: number;
	#current = 0;
	#queue: Array<() => void> = [];

	constructor(max: number) {
		const normalizedMax = Number.isFinite(max) ? Math.trunc(max) : 0;
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
	}

	/**
	 * Resolves when a slot is available. Pass an `AbortSignal` so callers that
	 * stop waiting (parent task cancelled, wall-clock budget elapsed) also stop
	 * occupying a queue slot — otherwise a later `release()` would resolve the
	 * abandoned waiter, permanently shrinking effective concurrency for the
	 * remaining lifetime of the process (issue #3464 review feedback).
	 */
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw semaphoreAbortReason(signal);
		}
		if (this.#current < this.#max) {
			this.#current++;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const queue = this.#queue;
		let waiter: () => void = resolve;
		if (signal) {
			const onAbort = () => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				reject(semaphoreAbortReason(signal));
			};
			waiter = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		queue.push(waiter);
		return promise;
	}

	release(): void {
		if (this.#current > 0) this.#current--;
		// Admit the next waiter only if we are under the (possibly just-lowered) ceiling.
		if (this.#current < this.#max) {
			const next = this.#queue.shift();
			if (next) {
				this.#current++;
				next();
			}
		}
	}

	/**
	 * Adjust the maximum concurrency in place. Raising the ceiling immediately
	 * admits queued waiters that now fit; lowering it lets in-flight holders
	 * drain naturally (new acquires keep blocking until `#current` falls below
	 * the new max). Resizing the single shared instance — instead of replacing
	 * it — keeps in-flight slots counted, so a runtime or mixed limit change can
	 * never push concurrency past the cap (issue #3464 review feedback).
	 */
	resize(max: number): void {
		const normalizedMax = Number.isFinite(max) ? Math.trunc(max) : 0;
		this.#max = normalizedMax > 0 ? normalizedMax : Number.POSITIVE_INFINITY;
		while (this.#current < this.#max) {
			const next = this.#queue.shift();
			if (!next) break;
			this.#current++;
			next();
		}
	}
}

function semaphoreAbortReason(signal: AbortSignal): unknown {
	const reason = signal.reason;
	if (reason !== undefined) return reason;
	return new Error("Semaphore acquire aborted");
}
