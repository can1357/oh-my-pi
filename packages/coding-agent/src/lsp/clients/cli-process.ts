/**
 * Process lifetime for CLI linter/formatter runs (Biome, SwiftLint).
 *
 * A linter binary is often a launcher: npm's `node_modules/.bin/biome` is a
 * Node script that runs the native binary as its own child. Signalling only the
 * direct child orphans that grandchild, which then keeps scanning its project
 * after the edit returned. Every run therefore leads its own process group and
 * is killed as a group on abort, on its deadline, on client dispose, and on
 * process teardown.
 */
import { postmortem, ptree } from "@oh-my-pi/pi-utils";

/** Hard wall-clock bound for one linter or formatter run, whatever the caller's signal. */
export const CLI_LINTER_TIMEOUT_MS = 30_000;

/** Output of a finished run; a non-zero exit is data (linters exit 1 on findings). */
export interface CliLinterRun {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

const running = new Set<ptree.ChildProcess>();
let teardownRegistered = false;

/** Process teardown: hard-kill every linter group still running and wait for each to exit. */
async function killRunning(): Promise<void> {
	const children = [...running];
	for (const child of children) child.kill(new ptree.AbortError(new Error("linter run torn down"), ""), -1);
	await Promise.allSettled(children.map(child => child.exited));
}

/**
 * Run `command args` in `cwd` as the leader of a new process group.
 *
 * Rejects with the process abort error when `signal` aborts or the deadline
 * passes; in both cases the whole group is gone before the promise settles.
 */
export async function runLinterCli(
	command: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	timeoutMs = CLI_LINTER_TIMEOUT_MS,
): Promise<CliLinterRun> {
	if (!teardownRegistered) {
		postmortem.register("cli-linter-runs", killRunning);
		teardownRegistered = true;
	}
	const child = ptree.spawn([command, ...args], {
		cwd,
		signal,
		timeout: timeoutMs,
		detached: true,
		windowsHide: true,
	});
	running.add(child);
	try {
		const { stdout, stderr, exitCode } = await child.wait({ allowNonZero: true });
		return { stdout, stderr, exitCode };
	} finally {
		running.delete(child);
	}
}
