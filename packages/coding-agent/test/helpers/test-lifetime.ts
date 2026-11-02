import { afterEach, beforeEach } from "bun:test";

const RESUMED_AFTER_END = "this test body resumed after its test ended; it stopped before touching shared state";

/** The run of one test, from the start of its setup to the start of its teardown. */
export interface TestRun {
	/**
	 * Throw unless the test this was captured in is still the one running.
	 *
	 * A body that times out keeps running, so everything it does after its next `await` happens
	 * during the next test: a spy it installs is one `vi.restoreAllMocks()` too late to be
	 * removed, and a shared binding it writes is the next test's to read. Call this in the same
	 * await-free run as any such write, and the resumed body stops instead.
	 */
	assertLive(): void;
}

/** Hands each test a {@link TestRun} standing for its own run. */
export interface TestLifetime {
	/**
	 * The run that is current now. Call this before the body's first `await`: the value is what
	 * tells a resumed body which test it belongs to, so taking it afterwards proves nothing.
	 */
	capture(): TestRun;
}

/**
 * Track test runs for a whole test file.
 *
 * Call once at file scope, above the file's own hooks: this registers its `beforeEach` and
 * `afterEach` first, so a run covers each test from before its setup to the start of its
 * teardown, whatever the file's hooks do in between. {@link TestCleanup} already makes this check
 * in `add()`, and a file with one needs no second guard; this is for the shared state no cleanup
 * owns, such as a spy or a describe-level binding.
 */
export function trackTestLifetime(): TestLifetime {
	let generation = 0;
	let running = false;
	beforeEach(() => {
		generation++;
		running = true;
	});
	afterEach(() => {
		running = false;
	});
	return {
		capture(): TestRun {
			const captured = generation;
			return {
				assertLive(): void {
					if (!running || generation !== captured) throw new Error(RESUMED_AFTER_END);
				},
			};
		},
	};
}
