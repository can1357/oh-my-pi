/**
 * Parallel execution with concurrency control.
 */

import { MAX_CONCURRENCY } from "./types.js";

/**
 * Execute items with a concurrency limit using a worker pool pattern.
 * Results are returned in the same order as input items.
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to execute for each item
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length, MAX_CONCURRENCY));
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await fn(items[index], index);
		}
	};

	// Create worker pool
	const workers = Array(limit)
		.fill(null)
		.map(() => worker());

	await Promise.all(workers);
	return results;
}
