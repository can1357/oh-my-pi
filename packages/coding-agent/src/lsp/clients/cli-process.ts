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
import { postmortem, ptree, resolveEquivalentPath } from "@oh-my-pi/pi-utils";

/**
 * The physical path a linter acts on for `filePath`: every symlink followed in
 * order, a dangling one to the file it will create, `..` applied to the
 * physical directory (see `resolveEquivalentPath`'s `followDanglingLinks`).
 * Root selection, the linter's argv and its output matching all use this one
 * spelling, so they always name the same file.
 */
export function linterFilePath(filePath: string): string {
	return resolveEquivalentPath(filePath, { throughMissing: true, followDanglingLinks: true });
}

/** Hard wall-clock bound for one linter or formatter run, whatever the caller's signal. */
export const CLI_LINTER_TIMEOUT_MS = 30_000;

/** How long after the deadline ptree stops waiting for output still held open outside the group. */
const PIPE_CUTOFF_GRACE_MS = 2_000;

/** Output of a finished run; a non-zero exit is data (linters exit 1 on findings). */
export interface CliLinterRun {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

const running = new Set<ptree.ChildProcess>();
let teardownRegistered = false;

/**
 * End a run: ptree's own kill, then SIGKILL to the run's whole process group.
 *
 * The group signal is what reaches a grandchild once the launcher is gone:
 * ptree's kill takes its dead-leader group path only for a leader that exited
 * normally, not one killed by a signal or not reaped yet, and a SIGTERM-ignoring
 * child then outlived every stop path. Sending to `-pid` is safe here: it runs
 * only while the run is still collecting the group's output, so the group (and
 * its id) still exists. Windows has no process groups; ptree's tree kill covers it.
 */
function stopRun(child: ptree.ChildProcess, reason: ptree.Exception): void {
	child.kill(reason, -1);
	if (process.platform === "win32") return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The group already ended.
	}
}

/** Process teardown: hard-kill every linter group still running and wait for each to exit. */
async function killRunning(): Promise<void> {
	const children = [...running];
	for (const child of children) stopRun(child, new ptree.AbortError(new Error("linter run torn down"), ""));
	await Promise.allSettled(children.map(child => child.exited));
}

/**
 * Run `command args` in `cwd` as the leader of a new process group.
 *
 * Rejects with the process abort error when `signal` aborts or the deadline
 * passes; in both cases the whole group is killed before the promise settles.
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
	signal?.throwIfAborted();
	const child = ptree.spawn([command, ...args], {
		cwd,
		// ptree's deadline, a little after ours: it stops collecting output that a
		// holder outside the group keeps open. Ours (below) kills the group first.
		timeout: timeoutMs + PIPE_CUTOFF_GRACE_MS,
		detached: true,
		windowsHide: true,
	});
	// Listen for the whole run, not only until the leader exits (ptree's own
	// `signal` option stops there): a launcher can exit while its child still
	// holds the output pipes, and an abort must still kill that group.
	const onAbort = () => stopRun(child, new ptree.AbortError(signal?.reason, "<cancelled>"));
	signal?.addEventListener("abort", onAbort, { once: true });
	const deadline = setTimeout(() => stopRun(child, new ptree.TimeoutError(timeoutMs, child.peekStderr())), timeoutMs);
	running.add(child);
	try {
		const { stdout, stderr, exitCode } = await child.wait({ allowNonZero: true });
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", onAbort);
		running.delete(child);
	}
}
