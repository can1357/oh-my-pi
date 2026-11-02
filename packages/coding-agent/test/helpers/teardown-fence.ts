/**
 * Stops a test body that Bun abandoned on timeout before it reaches code that ends the process.
 *
 * After a timeout Bun runs the `afterEach` hooks while the abandoned body keeps running. Those
 * hooks restore the body's spies, so a `runRootCommand` print run that resumes later calls the real
 * `postmortem.quit`, whose `process.exit` ends the test process and loses every later test's
 * result. `testLifetime()` cannot stop it in time: it ends in `onTestFinished`, after `afterEach`
 * has already restored the spies.
 *
 * Call `close()` as the first statement of the file's `afterEach`, before anything is restored, and
 * wrap each async step the body's fixtures hand to the code under test with the guard from
 * `forThisTest()`. A step then settles only while its test is still running; afterwards it never
 * settles and the abandoned body stops there. `runRootCommand` awaits the session's `dispose()` and
 * then calls `postmortem.quit` without yielding to a timer, so a body that gets past a guarded
 * `dispose()` still meets the quit spy.
 */
export interface TeardownFence {
	/** Ends the current test for every guard taken so far. Call first in `afterEach`. */
	close(): void;
	/** A guard for this test's fixture steps. */
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
