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

/** How long after the deadline ptree stops waiting for output still held open. */
const PIPE_CUTOFF_GRACE_MS = 2_000;

/** Output of a finished run; a non-zero exit is data (linters exit 1 on findings). */
export interface CliLinterRun {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/** A run in flight and how to stop it. */
interface LinterRun {
	child: ptree.ChildProcess;
	stop(reason: ptree.Exception): void;
}

const running = new Set<LinterRun>();
let teardownRegistered = false;

/** Process teardown: hard-kill every linter run still going and wait for each to exit. */
async function killRunning(): Promise<void> {
	const runs = [...running];
	for (const run of runs) run.stop(new ptree.AbortError(new Error("linter run torn down"), ""));
	await Promise.allSettled(runs.map(run => run.child.exited));
}

/**
 * Run `command args` in `cwd`, supervised so its whole tree can be killed.
 *
 * Linux: the command runs under ptree's child subreaper. Every descendant, also
 * one whose parent died or that left the process group, is reparented to the
 * supervisor, and a kill walks the supervisor's live children.
 *
 * Other POSIX (macOS): the command runs under ptree's group keeper, which leads
 * the run's process group and lives until the command exited and its output
 * closed, so a group kill reaches the run (also after its launcher died) and a
 * group id is never signalled once it could belong to another process.
 *
 * Windows: ptree's tree kill from the retained root handle.
 *
 * Rejects when `signal` aborts, the deadline passes, the client is disposed or
 * the process tears down: once a stop was asked for, the run never reports a
 * result, and its tree is killed before the promise settles.
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
		// Backstop only: our own deadline below stops the run first.
		timeout: timeoutMs + PIPE_CUTOFF_GRACE_MS,
		subreaper: true,
		groupKeeper: true,
		windowsHide: true,
	});
	let stopReason: ptree.Exception | undefined;
	const run: LinterRun = {
		child,
		stop(reason) {
			stopReason ??= reason;
			child.kill(reason, -1);
		},
	};
	// Listen for the whole run, not only until the supervised process exits
	// (ptree's own `signal` option stops there).
	const onAbort = () => run.stop(new ptree.AbortError(signal?.reason, "<cancelled>"));
	signal?.addEventListener("abort", onAbort, { once: true });
	const deadline = setTimeout(() => run.stop(new ptree.TimeoutError(timeoutMs, child.peekStderr())), timeoutMs);
	running.add(run);
	try {
		const { stdout, stderr, exitCode } = await child.wait({ allowNonZero: true });
		if (stopReason) throw stopReason;
		return { stdout, stderr, exitCode };
	} catch (err) {
		throw stopReason ?? err;
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", onAbort);
		running.delete(run);
	}
}
