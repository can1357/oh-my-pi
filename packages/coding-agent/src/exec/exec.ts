/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { definedEnv } from "../sandbox/env";
import { SandboxRuntime } from "../sandbox/runtime";

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
 * Supports timeout and abort signal. Runs contained when the sandbox applies to the `exec` scope;
 * `workspace` is the session workspace that sandbox writes are confined to (the per-call `cwd`
 * only picks where the command starts).
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
	workspace: string = cwd,
): Promise<ExecResult> {
	const runtime = await SandboxRuntime.for(workspace);
	if (runtime.applies("exec")) return await execContained(runtime, [command, ...args], cwd, options);

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

/**
 * Contained counterpart of the `ptree.exec` path: same result shape; timeout and abort kill the
 * contained tree and report `killed` with code `-1`, a non-zero exit is returned as-is.
 */
async function execContained(
	runtime: SandboxRuntime,
	argv: string[],
	cwd: string,
	options: ExecOptions | undefined,
): Promise<ExecResult> {
	const child = await runtime.spawn({ argv, cwd, env: definedEnv(Bun.env) });
	child.stdin.end();
	let killed = false;
	let running = true;
	const kill = (): void => {
		if (!running || killed) return;
		killed = true;
		child.kill();
	};
	const signal = options?.signal;
	const timeoutMs = options?.timeout ?? -1;
	const timer = timeoutMs > 0 ? setTimeout(kill, timeoutMs) : undefined;
	if (signal?.aborted) kill();
	else signal?.addEventListener("abort", kill, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited.finally(() => {
				running = false;
			}),
		]);
		return { stdout, stderr, code: killed ? -1 : exitCode, killed };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
	}
}
