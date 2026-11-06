import { logger } from "@oh-my-pi/pi-utils";

const pendingCleanups = new Set<Promise<void>>();

/** Keep timed-out cleanup reachable until its resources really settle. */
export function trackLateCleanup(work: Promise<void>, context: Record<string, unknown>): void {
	const tracked = work
		.catch(error => {
			logger.warn("Deferred cleanup failed", {
				...context,
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => pendingCleanups.delete(tracked));
	pendingCleanups.add(tracked);
}

/**
 * Run every release, even when one throws: a cleanup list holds unrelated
 * resources, so the first failure must not strand the rest — a stranded
 * dependency goes on telling other agents that an ended call still owes them.
 * Rethrows the first failure once all of them have run.
 */
export function releaseAll(releases: Iterable<() => void>): void {
	let failure: { error: unknown } | undefined;
	for (const release of releases) {
		try {
			release();
		} catch (error) {
			failure ??= { error };
		}
	}
	if (failure) throw failure.error;
}
