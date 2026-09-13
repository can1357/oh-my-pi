/**
 * Serializes async switch operations so the LATEST requested one always wins.
 *
 * Tasks are invoked in request order, but a task still queued when a newer
 * request arrives is skipped entirely; a task already executing cannot be
 * stopped, so the newest request re-runs after it. The net effect: after all
 * settles, the most recent request's task has run last — exactly the
 * guarantee profile-driven model switches need.
 */
export class LatestWinsExecutor {
	#chain: Promise<void> = Promise.resolve();
	#generation = 0;

	/** Request a switch. Returns the task's promise; rejections propagate. */
	run(task: () => Promise<void>): Promise<void> {
		const generation = ++this.#generation;
		const previous = this.#chain;
		const { promise: release, resolve } = Promise.withResolvers<void>();
		this.#chain = release;
		return previous.then(async () => {
			try {
				if (generation === this.#generation) await task();
			} finally {
				resolve();
			}
		});
	}
}
