/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { ptree } from "@oh-my-pi/pi-utils";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	/** Process exit code; `-1` when execution was aborted or no exit code was available. */
	code: number;
	/** True when the process was killed by `timeout` or `signal`. */
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const result = await ptree.exec([command, ...args], {
		cwd,
		signal: options?.signal,
		timeout: options?.timeout,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});

	const killed = Boolean(result.exitError?.aborted);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: killed ? -1 : (result.exitCode ?? -1),
		killed,
	};
}
