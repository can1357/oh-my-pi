/**
 * Process lifetime for CLI linter/formatter runs (Biome, SwiftLint).
 *
 * A linter binary is often a launcher: npm's `node_modules/.bin/biome` is a
 * Node script that runs the native binary as its own child. Signalling only the
 * direct child orphans that grandchild, which then keeps scanning its project
 * after the edit returned. Every run's whole tree is therefore killed on abort,
 * on its deadline, on client dispose, and on process teardown.
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

/** Output of a finished run; a non-zero exit is data (linters exit 1 on findings). */
export interface CliLinterRun {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

const running = new Set<ptree.ChildProcess>();
let teardownRegistered = false;

/** End a run: hard-kill its whole tree (ptree's subreaper sweep on Linux, its group or tree kill elsewhere). */
function stopRun(child: ptree.ChildProcess, reason: ptree.Exception): void {
	child.kill(reason, -1);
}

/** Process teardown: hard-kill every linter run still going and wait for each to exit. */
async function killRunning(): Promise<void> {
	const children = [...running];
	for (const child of children) stopRun(child, new ptree.AbortError(new Error("linter run torn down"), ""));
	await Promise.allSettled(children.map(child => child.exited));
}

/**
 * Run `command args` in `cwd`, supervised so its whole tree can be killed.
 *
 * On Linux the command runs under ptree's child subreaper: every descendant,
 * also one whose parent died (from a signal or otherwise) or that left the
 * process group, is reparented to the supervisor, which lives until the last of
 * them exits. A kill then walks that supervisor's live children, so no process
 * outside the run is ever signalled by a stale pid or group id. Elsewhere the
 * command leads its own process group (Windows: ptree's tree kill).
 *
 * Rejects with the process abort error when `signal` aborts or the deadline
 * passes; in both cases the run's tree is killed before the promise settles.
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
		timeout: timeoutMs,
		// Linux: the subreaper supervises the tree, so no group id is ever signalled.
		detached: process.platform !== "linux",
		subreaper: true,
		windowsHide: true,
	});
	// Listen for the whole run, not only until the supervised process exits
	// (ptree's own `signal` option stops there): output can still be held open
	// by a descendant, and an abort must still kill it.
	const onAbort = () => stopRun(child, new ptree.AbortError(signal?.reason, "<cancelled>"));
	signal?.addEventListener("abort", onAbort, { once: true });
	running.add(child);
	try {
		const { stdout, stderr, exitCode } = await child.wait({ allowNonZero: true });
		return { stdout, stderr, exitCode };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		running.delete(child);
	}
}
