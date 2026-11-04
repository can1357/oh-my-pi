import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";

/** The isolation root a {@link useTempWorktreesDir} block runs against. */
export interface TempWorktreesDir {
	/** This test's root; valid between its `beforeEach` and `afterEach`. */
	readonly dir: string;
}

/**
 * Give every test in the calling `describe` (or file) its own isolation root
 * under the temp directory, and remove it afterwards.
 *
 * A sandbox a test materialises without a root of its own lands in whatever
 * `OMP_WORKTREE_DIR` the shell exported, and one that is never cleaned up
 * stays there: the start-up sweep and `omp worktree clear` then treat it as a
 * real task's tree. `OMP_WORKTREE_DIR` wins over the override, so it is cleared
 * for the test and put back after.
 */
export function useTempWorktreesDir(): TempWorktreesDir {
	let current: string | undefined;
	let savedEnv: string | undefined;
	beforeEach(async () => {
		current = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-wt-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(current);
	});
	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		const dir = current;
		current = undefined;
		if (dir !== undefined) await removeWithRetries(dir);
	});
	return {
		get dir(): string {
			if (current === undefined) throw new Error("useTempWorktreesDir: no test is running");
			return current;
		},
	};
}
