/**
 * `bun test` preload for every package (see each package's `bunfig.toml`). Bun 1.4.4 runs
 * a `beforeEach` registered here before every test of every file, and an `afterAll` at the
 * end of each file under `--parallel` (once at the end of the run otherwise). Both mark a
 * new test generation, so `testLifetime()` goes stale when its test is over even if Bun
 * skipped that test's `onTestFinished`.
 */
import { afterAll, beforeEach } from "bun:test";
import { advanceTestGeneration } from "./mock-restores";

beforeEach(() => {
	advanceTestGeneration();
});

afterAll(() => {
	advanceTestGeneration();
});
