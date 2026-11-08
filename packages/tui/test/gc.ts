/**
 * Garbage-collection probes for release tests.
 *
 * JSC scans the machine stack conservatively. A `Bun.gc(true)` issued from a resumed async function also
 * scans stale promise-job frames whose slots can still hold pointers to released objects, so whether a
 * target survives depends on stack layout. A timer callback runs on the event loop's shallow stack, out of
 * reach of those frames.
 */

/** Runs a full synchronous GC from a fresh timer callback, away from stale async stack frames. */
export function collectGarbage(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(() => {
		Bun.gc(true);
		resolve();
	}, 0);
	return promise;
}

/** Whether `target` becomes collectible within `deadlineMs`; a retained target never does. */
export async function becomesCollectible(target: WeakRef<object>, deadlineMs = 3_000): Promise<boolean> {
	const deadline = performance.now() + deadlineMs;
	do {
		await collectGarbage();
		if (target.deref() === undefined) return true;
	} while (performance.now() < deadline);
	return false;
}
