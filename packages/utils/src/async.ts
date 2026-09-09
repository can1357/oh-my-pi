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
