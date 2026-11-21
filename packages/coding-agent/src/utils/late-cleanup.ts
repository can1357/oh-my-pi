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
