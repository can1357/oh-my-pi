const RESUMED_AFTER_END = "this test body resumed after its test ended; it released what it was handed and stopped";

/**
 * Cleanup that one test registers as it creates things, run by afterEach and never by the test
 * body: a test that times out never reaches its own `finally`, but its afterEach still runs, so
 * the processes, files and registrations it owns are released before the next file starts.
 *
 * Create one per test in beforeEach, and have the test take it before its first await, so a body
 * that resumes after its test timed out registers with its own cleanup, which has already ended
 * and releases at once. Each cleanup closes over the values it needs, never a variable the next
 * test reassigns. (Results after a timeout are refused by `trackTestLifetime`; this only makes sure
 * nothing the timed-out test made is left running.)
 *
 * afterEach calls `end()` after `vi.restoreAllMocks()`.
 */
export class TestCleanup {
	#releases: Array<() => void> = [];
	#disposals: Array<() => unknown> = [];
	#ended = false;

	/**
	 * Register the removal of a process-wide registration, such as a custom API. Releases run
	 * first and synchronously, so a disposal that hangs cannot keep one alive into the next test.
	 */
	release(release: () => void): void {
		if (this.#ended) {
			release();
			throw new Error(RESUMED_AFTER_END);
		}
		this.#releases.push(release);
	}

	/**
	 * Register the disposal of something the test created. Disposals run after every release,
	 * newest first. Called after the test ended, it disposes at once and throws, so a resumed
	 * body leaves nothing it made behind.
	 */
	async add(dispose: () => unknown): Promise<void> {
		if (this.#ended) {
			await dispose();
			throw new Error(RESUMED_AFTER_END);
		}
		this.#disposals.push(dispose);
	}

	/** Run every release, then every disposal, and return all failures rather than stop at the first. */
	async end(): Promise<unknown[]> {
		this.#ended = true;
		const failures: unknown[] = [];
		for (const release of this.#releases.splice(0).reverse()) {
			try {
				release();
			} catch (error) {
				failures.push(error);
			}
		}
		for (const dispose of this.#disposals.splice(0).reverse()) {
			try {
				await dispose();
			} catch (error) {
				failures.push(error);
			}
		}
		return failures;
	}
}
