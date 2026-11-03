import { afterAll, beforeEach, onTestFinished, vi } from "bun:test";

/**
 * Advances whenever a test starts or a test file ends. The package test preload
 * (`test-preload.ts`, loaded by each package's `bunfig.toml`) advances it for every
 * test of every file, so a lifetime created by one test is stale once any later test
 * starts, even when Bun skipped that test's `onTestFinished` after a hook timeout.
 */
let testGeneration = 0;

/** Marks the start of a test or the end of a test file. Called by the test preload and the helper. */
export function advanceTestGeneration(): void {
	testGeneration++;
}

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
		advanceTestGeneration();
		// After an afterEach timeout Bun skips onTestFinished, so this restores what that test left.
		vi.restoreAllMocks();
		// Bun runs onTestFinished callbacks after every afterEach hook, so teardown keeps its mocks.
		onTestFinished(() => {
			vi.restoreAllMocks();
		});
	});
	// The last test of a scope whose afterEach timed out leaves its mocks to this restore.
	afterAll(() => {
		vi.restoreAllMocks();
	});
}

export interface TestLifetime {
	readonly ended: boolean;
	/** Throws once the test that created this lifetime has finished or a later test has started. */
	assertLive(): void;
}

/**
 * Tracks whether the current test is still the running one. Call `assertLive()` after an
 * `await` and before installing shared state: a body that resumes after its test timed out
 * then stops before it installs state that its finished cleanup cannot undo.
 */
export function testLifetime(): TestLifetime {
	const generation = testGeneration;
	let finished = false;
	onTestFinished(() => {
		finished = true;
	});
	const ended = (): boolean => finished || generation !== testGeneration;
	return {
		get ended() {
			return ended();
		},
		assertLive() {
			if (ended()) throw new Error("test body resumed after its test ended");
		},
	};
}
