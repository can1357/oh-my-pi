/**
 * Sequence repeated calls to an async job, keeping the last request honest.
 *
 * A plain in-flight skip is the tempting version and it is wrong: a call that
 * arrives while the job is running is asking about state the running job has
 * already read past, so dropping it settles the result on the *older* world. The
 * trailing repeat is what makes "refresh" mean "refresh after this moment".
 *
 * `run` owns its own outcome — success and failure both. A rejection is caught
 * here only so it cannot escape as an unhandled rejection, which under `bun dev`
 * is a full-screen overlay; the caller is expected to have already recorded it.
 */
export function coalesce(run: () => Promise<unknown>): () => void {
	let inFlight = false;
	let pending = false;

	const start = (): void => {
		inFlight = true;
		void (async () => {
			try {
				await run();
			} catch {
				// `run` reports its own failures.
			} finally {
				inFlight = false;
				if (pending) {
					pending = false;
					start();
				}
			}
		})();
	};

	return () => {
		if (inFlight) {
			pending = true;
			return;
		}
		start();
	};
}
