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
	// The CLI's own handler exits at once, leaving the command's programs behind.
	process.removeAllListeners("SIGINT");
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
	process.exit(status);
}
