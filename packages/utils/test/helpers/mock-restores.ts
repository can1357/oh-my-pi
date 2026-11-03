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

export interface EnvRestoreOptions {
	/** Runs after every put-back, to rebuild state cached from the variables (e.g. a directory resolver). */
	afterPutBack?: () => void;
}

/**
 * Makes the calling file or `describe` scope the one owner of the environment variables `names`.
 * Call it at the top level of that scope, before its own hooks; no outer hook may set the variables.
 *
 * It saves their values once, when the scope is collected, and puts them back at the end of each
 * test (`onTestFinished`, after the scope's `afterEach` hooks, so teardown still sees the test's
 * values), at the start of each test (Bun skips `onTestFinished` when an `afterEach` times out),
 * and when the scope ends (the scope's last test has no next test). Every put-back is synchronous.
 * The scope's own hooks and tests then only set the variables; none of them puts one back.
 *
 * A variable that was unset is assigned `""` before it is deleted: Bun's `fetch` keeps a proxy
 * variable (`HTTP_PROXY`, `NO_PROXY`, ...) it has read until the next assignment, and a bare
 * `delete` would leave every later fetch in the process routed to the test's proxy.
 */
export function installEnvRestores(names: readonly string[], options: EnvRestoreOptions = {}): void {
	const saved = names.map(name => [name, process.env[name]] as const);
	const putBack = (): void => {
		for (const [name, value] of saved) {
			if (value === undefined) {
				process.env[name] = "";
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		options.afterPutBack?.();
	};
	beforeEach(() => {
		putBack();
		onTestFinished(putBack);
	});
	afterAll(putBack);
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
 *
 * The lifetime ends in `onTestFinished`, after the `afterEach` hooks. State the body installs
 * while those hooks run is still undone by cleanup registered with `onTestFinished` (and by
 * `installMockRestores()`). A body that awaits again after such an install and then calls code
 * that ends the process needs a guard that ends when `afterEach` starts instead, such as
 * coding-agent's `test/helpers/teardown-fence.ts`.
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
