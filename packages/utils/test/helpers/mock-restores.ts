import { afterAll, beforeEach, onTestFinished, vi } from "bun:test";

/**
 * Restores Bun mocks before each test, after each test's `afterEach` hooks, and when
 * the calling file or `describe` scope ends. Call it at the top level of that scope.
 *
 * Every restore is synchronous, so a timeout cannot stop one partway. A file's own
 * async teardown should not restore mocks after an `await`: a timed-out teardown can
 * resume during a later test and remove that test's mocks.
 */
export function installMockRestores(): void {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Bun runs onTestFinished callbacks after every afterEach hook, so teardown keeps its mocks.
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
	});
	afterAll(() => {
		vi.restoreAllMocks();
	});
}

export interface TestLifetime {
	readonly ended: boolean;
	/** Throws once the test that created this lifetime has finished. */
	assertLive(): void;
}

/**
 * Tracks whether the current test has finished. Call `assertLive()` after an `await`
 * and before installing shared state: a body that resumes after its test timed out
 * then stops before it installs state that its finished cleanup cannot undo.
 */
export function testLifetime(): TestLifetime {
	let ended = false;
	onTestFinished(() => {
		ended = true;
	});
	return {
		get ended() {
			return ended;
		},
		assertLive() {
			if (ended) throw new Error("test body resumed after its test ended");
		},
	};
}
