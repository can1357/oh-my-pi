/**
 * Shared command execution utilities for hooks and custom tools.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { spawnContainedCommand } from "../sandbox/command";
import { inheritedContainedEnv } from "../sandbox/env";
import { SandboxRuntime } from "../sandbox/runtime";
import type { SandboxChild } from "../sandbox/types";

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
	const runtime = await SandboxRuntime.forScope(workspace, "exec");
	if (runtime) {
		return await execContained(runtime, [command, ...args], {
			cwd,
			signal: options?.signal,
			timeout: options?.timeout,
		});
	}

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

/** Options of {@link execContained}. */
interface ContainedExecOptions extends ExecOptions {
	cwd: string;
	/** The whole environment; defaults to {@link inheritedContainedEnv}. */
	env?: Record<string, string>;
	/** Writable roots beyond the policy's, as for {@link SandboxRuntime.spawn}. */
	extraWrite?: readonly string[];
}

/**
 * Runs `argv` contained by `runtime` to completion, its stdin closed: the contained counterpart of
 * the `ptree.exec` path, same result shape. Timeout and abort kill the contained tree and report
 * `killed` with code `-1`; an abort that fired before the call spawns nothing, one while spawning
 * kills the fresh child. A non-zero exit is returned as-is.
 */
export async function execContained(
	runtime: SandboxRuntime,
	argv: string[],
	options: ContainedExecOptions,
): Promise<ExecResult> {
	if (options.signal?.aborted) return { stdout: "", stderr: "", code: -1, killed: true };
	const child = await runtime.spawn({
		argv,
		cwd: options.cwd,
		env: options.env ?? inheritedContainedEnv(),
		extraWrite: options.extraWrite,
	});
	return await collectContained(child, options);
}

/** Waits `child` out with its stdin closed, killing it on `options`' timeout or abort. */
async function collectContained(child: SandboxChild, options: ExecOptions): Promise<ExecResult> {
	child.stdin.end();
	let killed = false;
	const kill = (): void => {
		if (killed || child.exitCode !== null) return;
		killed = true;
		child.kill();
	};
	const signal = options.signal;
	const timeoutMs = options.timeout ?? -1;
	const timer = timeoutMs > 0 ? setTimeout(kill, timeoutMs) : undefined;
	if (signal?.aborted) kill();
	else signal?.addEventListener("abort", kill, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code: killed ? -1 : exitCode, killed };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", kill);
	}
}

/**
 * Runs a workspace-resolvable tool (`argv[0]`) to completion contained by `runtime`, started by
 * {@link spawnContainedCommand} and waited out like {@link execContained}. Rejects with an ENOENT
 * error `<what> not found: <command>` when the command does not resolve.
 */
export async function execContainedTool(
	runtime: SandboxRuntime,
	argv: string[],
	cwd: string,
	what: string,
	signal?: AbortSignal,
): Promise<ExecResult> {
	return await collectContained(await spawnContainedCommand(runtime, { argv, cwd, what }), { signal });
}

/**
 * Runs a linter CLI for the LSP clients: contained like the language servers under an applying
 * `lsp`-scope sandbox (`fallback: block` without a backend rejects instead of running it), a plain
 * spawn otherwise. `isSuccess` judges the finished run from its stdout and exit code. A failed
 * run (spawn error, refusal) yields `success: false` with the error in `stderr`; an abort rethrows.
 */
export async function runLinterCli(
	command: string,
	args: string[],
	cwd: string,
	what: string,
	isSuccess: (result: { stdout: string; code: number }) => boolean,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const sandbox = await SandboxRuntime.forScope(cwd, "lsp");

	try {
		if (sandbox) {
			signal?.throwIfAborted();
			const result = await execContainedTool(sandbox, [command, ...args], cwd, what, signal);
			signal?.throwIfAborted();
			return { stdout: result.stdout, stderr: result.stderr, success: isSuccess(result) };
		}

		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			signal,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		signal?.throwIfAborted();

		return { stdout, stderr, success: isSuccess({ stdout, code }) };
	} catch (err) {
		if (signal?.aborted) throw err;
		return { stdout: "", stderr: String(err), success: false };
	}
}
