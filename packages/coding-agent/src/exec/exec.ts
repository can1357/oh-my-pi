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
	/** Additional environment variables, merged over the inherited environment. */
	env?: Record<string, string>;
	/** Variables to remove from the final merged environment. */
	stripEnv?: readonly string[];
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
	const env = { ...process.env };
	delete env.OMP_MESSAGING_SOCKET;
	delete env.OMP_MESSAGING_TOKEN;
	Object.assign(env, options?.env);
	for (const key of options?.stripEnv ?? []) delete env[key];
	const result = await ptree.exec([command, ...args], {
		cwd,
		env,
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
