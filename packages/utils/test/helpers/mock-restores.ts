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
	// A put-back Bun skipped (a hook of the test that just ended timed out) runs here instead,
	// before the next test's body, exactly as `installEnvRestores()` puts its variables back.
	runDeferredPutBacks();
}

/** The put-backs of overrides shared helpers installed, newest first; each runs at most once. */
const deferredPutBacks: (() => void)[] = [];

function runDeferredPutBacks(): void {
	// Newest first: an inner override saved the value an outer one installed.
	while (deferredPutBacks.length > 0) deferredPutBacks.pop()!();
}

/**
 * Hands `putBack` to the test runtime, and returns the function that runs it where the helper's
 * own body would have. A shared helper that replaces state around an awaited callback
 * (`try { await fn() } finally { putBack() }`) cannot put it back on its own: when the test times
 * out inside the callback, the `finally` runs during a later test, and deletes or overwrites that
 * test's value instead.
 *
 * The returned function runs `putBack` once, whoever calls it first. The runtime calls it when the
 * test ends (`onTestFinished`, after the test's `afterEach` hooks), at the start of the next test
 * and at the end of the file (both through {@link advanceTestGeneration}), so a put-back survives
 * a hook timeout that makes Bun skip `onTestFinished`. The helper calls it where its body reaches
 * its own cleanup, and only while its test is still live, so two overrides in one test still nest.
 */
export function deferPutBack(putBack: () => void): () => void {
	let done = false;
	const run = (): void => {
		if (done) return;
		done = true;
		putBack();
	};
	deferredPutBacks.push(run);
	// A helper called from a `beforeAll`/`afterAll` hook has no test to finish; the next test's
	// `advanceTestGeneration()` and the file's own end still run the put-back.
	try {
		onTestFinished(runDeferredPutBacks);
	} catch {}
	return run;
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
