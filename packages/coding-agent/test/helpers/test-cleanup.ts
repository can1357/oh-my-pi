const RESUMED_AFTER_END = "this test body resumed after its test ended; it cleaned up and stopped";

/**
 * Cleanup that one test registers as it creates things, run by afterEach and never by the test
 * body: a test that times out never reaches its own `finally`, but its afterEach still runs.
 *
 * Create one per test in beforeEach. A test captures it before its first await, so a body that
 * resumes after its test timed out still reaches its own scope, not the next test's. Each
 * cleanup closes over the values it needs, never a variable the next test reassigns.
 *
 * After its first await a body may touch only what it owns: its locals, and objects it took from
 * a per-test context before that await. Anything another test can see — a spy on a shared module
 * or global, a shared binding, a process-wide registry — it touches only right after
 * `assertLive()` (or an `add()`, which checks the same), with no await in between.
 *
 * afterEach calls `end()` after `vi.restoreAllMocks()` and touches shared state only before it
 * awaits the result: a disposal can outlive the hook's timeout, and code after that await would
 * then run during the next test.
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
	 * Throw if the test that owns this cleanup already ended. A body resumes after its test timed
	 * out and afterEach ran, and whatever it does then happens during the next test; call this
	 * right before a body that has awaited installs a spy on something shared or writes to
	 * anything another test can see.
	 */
	assertLive(): void {
		if (this.#ended) throw new Error(RESUMED_AFTER_END);
	}

	/**
	 * Register the disposal of something the test created. Disposals run after every release,
	 * newest first. Called after the test ended, it disposes at once and throws, so a resumed
	 * body stops before it can touch the next test.
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
