/**
 * Garbage-collection probes for release tests.
 *
 * JSC scans the machine stack conservatively. A `Bun.gc(true)` issued from a resumed async function also
 * scans stale promise-job frames whose slots can still hold pointers to released objects, so whether a
 * target survives depends on stack layout. A timer callback runs on the event loop's shallow stack, out of
 * reach of those frames.
 *
 * The concurrent JIT also holds values: a DFG/FTL plan compiling a hot loop for OSR entry keeps the loop's
 * locals (a rows array a render loop walked) reachable until the plan lands, so a released target can
 * outlive a run of back-to-back full collections. With `BUN_JSC_useConcurrentJIT=0` it does not.
 */

/**
 * Full collections a target gets before it counts as retained, however long they take. A plan's hold
 * lasted 18–34 probe collections whether each took 5 ms or 350 ms (macOS arm64, Linux x64), so it is
 * counted in collections, not time: on a CI worker's grown heap a full collection takes hundreds of
 * milliseconds, and the time deadline alone ran out first.
 */
const MIN_COLLECTIONS = 64;

/** Runs a full synchronous GC from a fresh timer callback, away from stale async stack frames. */
export function collectGarbage(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(() => {
		Bun.gc(true);
		resolve();
	}, 0);
	return promise;
}

/**
 * Whether `target` becomes collectible within `deadlineMs` and {@link MIN_COLLECTIONS} collections; a
 * retained target never does.
 */
export async function becomesCollectible(target: WeakRef<object>, deadlineMs = 3_000): Promise<boolean> {
	const deadline = performance.now() + deadlineMs;
	for (let collections = 1; ; collections++) {
		await collectGarbage();
		if (target.deref() === undefined) return true;
		if (collections >= MIN_COLLECTIONS && performance.now() >= deadline) return false;
	}
}
