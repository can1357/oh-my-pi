/**
 * Parallel execution with concurrency control.
 */

import { MAX_CONCURRENCY } from "./types";

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
 * @param fn - Async function to execute for each item
 * @param signal - Optional abort signal to stop scheduling new work
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<ParallelResult<R>> {
	const limit = Math.max(1, Math.min(concurrency, items.length, MAX_CONCURRENCY));
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
				results[index] = await fn(items[index], index);
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
