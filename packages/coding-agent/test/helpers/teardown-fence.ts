/**
 * Stops a test body that Bun abandoned on timeout before it does anything a later test would see.
 *
 * After a timeout Bun runs the `afterEach` hooks while the abandoned body keeps running. Those hooks
 * restore the body's spies and reset shared state, so a body that resumes later can install new
 * mocks during another test, or reach real code that ends the process (`runRootCommand` calling
 * `postmortem.quit`, `runConfigCommand` calling `process.exit`) and lose every later test's result.
 *
 * Use:
 * - Call `close()` as the first statement of the first `afterEach` that runs for the fenced tests
 *   (the innermost scope's first one), before anything is restored or reset.
 * - Take a guard with `forThisTest()` at the start of the test, and pass every await of the body and
 *   its fixtures that comes before a mock install or a process-ending call through it. A guarded step
 *   settles only while its test is still running; afterwards it never settles, so the body stops there.
 *
 * A guarded step settles in the same task as the body code that follows it, so that code runs to its
 * next await before any hook can. That is why the guard holds up to the install, or up to a
 * process-ending call reached without another real await (`runRootCommand` awaits the session's
 * `dispose()`, then calls `postmortem.quit` without yielding to a timer).
 *
 * `testLifetime()` is not enough for these bodies: it ends in `onTestFinished`, after the `afterEach`
 * hooks have run, so a body resuming during an `afterEach` await still passes `assertLive()`, and any
 * real await after its install lets the hooks restore the stub before the process-ending call.
 */
export interface TeardownFence {
	/** Ends the current test for every guard taken so far. Call first in `afterEach`. */
	close(): void;
	/** A guard for this test's awaits. */
	forThisTest(): <T>(step: () => Promise<T>) => Promise<T>;
}

export function createTeardownFence(): TeardownFence {
	let generation = 0;
	return {
		close() {
			generation++;
		},
		forThisTest() {
			const own = generation;
			const parked = <T>(): Promise<T> => new Promise<T>(() => {});
			return <T>(step: () => Promise<T>): Promise<T> => {
				if (own !== generation) return parked<T>();
				return step().then(
					value => (own === generation ? value : parked<T>()),
					error => (own === generation ? Promise.reject(error) : parked<T>()),
				);
			};
		},
	};
}
