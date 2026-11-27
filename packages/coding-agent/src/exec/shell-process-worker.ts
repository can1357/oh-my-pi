/**
 * Shell process: the bash tool's shell run as a process of its own.
 *
 * `omp __omp_worker_shell_process [options] -- <command>` runs one command in
 * the embedded engine with the tool profile (omp's utilities and tools resolve
 * ahead of `PATH`) over this process's own stdin, stdout and stderr, then
 * exits with its status. Externals stay in this process's session and group,
 * so a process started on a pseudo-terminal is that terminal's shell: its
 * programs own the terminal, receive its signals and see `/dev/tty`. Named
 * services and `pty` commands run this way.
 *
 * There is no session here. The script the process sources first
 * (`--source`) mounts the URL paths its command may name (`urlmap`) and
 * defines the functions and aliases of the session it was started from.
 */
import * as fs from "node:fs";
import { Shell } from "@oh-my-pi/pi-natives";
import { parseShellProcessArgs } from "./shell-process-protocol";

/**
 * How long the externals alive at a terminal interrupt have to exit for the
 * interrupt to end the command, as a shell stops a script whose foreground
 * program the interrupt killed. One that outlives it handled the signal itself
 * (a REPL, an editor) and the command goes on.
 */
const INTERRUPT_SETTLE_MS = 250;

/**
 * How long this process waits, once a signal ended its command, for the
 * command's programs to end and be reaped. The spawner sends KILL to what TERM
 * did not end after its grace (1 s); the rest covers reaping on a loaded host.
 * A program that even KILL does not end in this time (one in uninterruptible
 * sleep) is left behind, as it was before this process waited at all. Below the
 * 5 s `omp ps stop` gives a service before it sends KILL.
 */
const SETTLE_LIMIT_MS = 3_000;

/** Run the shell process `args` (the argv after the worker selector) describe, then exit with the command's status. */
export async function runShellProcess(args: readonly string[]): Promise<never> {
	const spec = parseShellProcessArgs(args);
	if (!spec) {
		process.stderr.write("omp: malformed shell process arguments\n");
		process.exit(2);
	}
	const shell = new Shell({
		process: true,
		// A relaunch may outlive the script its first start was given.
		snapshotPath: spec.source !== undefined && fs.existsSync(spec.source) ? spec.source : undefined,
	});

	const abort = new AbortController();
	/** The status this process exits with once a signal ended the command. */
	let signalStatus: number | undefined;
	const stop = (status: number): void => {
		// One stop request can arrive as several signals: the daemon sends TERM to the
		// process group, then to this process, and a terminal's runner adds HUP. The
		// first decides the status; the bounded wait below ends this process.
		signalStatus ??= status;
		abort.abort();
	};
	// The terminal sends its interrupt to the whole foreground group, the externals included.
	const interrupt = (status: number): void => {
		const running = shell.pids();
		if (running.length === 0) {
			stop(status);
			return;
		}
		setTimeout(() => {
			const alive = new Set(shell.pids());
			if (!running.some(pid => alive.has(pid))) stop(status);
		}, INTERRUPT_SETTLE_MS);
	};
	// The CLI's own handlers exit at once, racing the cancel that ends the
	// command's programs: one that loses leaves them running behind this process.
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeAllListeners(signal);
	process.on("SIGINT", () => interrupt(130));
	process.on("SIGTERM", () => stop(143));
	process.on("SIGHUP", () => stop(129));
	if (process.platform !== "win32") process.on("SIGQUIT", () => interrupt(131));

	let status: number;
	try {
		const result = await shell.run({ command: spec.command, cwd: spec.cwd, signal: abort.signal });
		status = signalStatus ?? result.exitCode ?? 1;
	} catch (error) {
		process.stderr.write(`omp: ${error instanceof Error ? error.message : String(error)}\n`);
		status = 1;
	}
	// The cancel ends the command before its programs: they get TERM, then KILL
	// after a grace, in the background of this process. Exiting first would leave
	// them running, or unreaped, behind it. Closing the shell also ends the jobs
	// the cancel spares: those the sourced script or the command's TERM or EXIT
	// trap started. A program the command detached (`nohup`) runs on, and is not
	// waited for.
	if (signalStatus !== undefined) {
		await shell.close();
		await Promise.race([shell.settled(), Bun.sleep(SETTLE_LIMIT_MS)]);
	}
	process.exit(status);
}
