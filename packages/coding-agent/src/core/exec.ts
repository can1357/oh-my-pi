/**
 * Shared command execution utilities for hooks and custom tools.
 */

import type { Subprocess } from "bun";

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
	code: number;
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
	return new Promise((resolve) => {
		const proc: Subprocess = Bun.spawn([command, ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: Timer | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill();
				// Force kill after 5 seconds if first kill doesn't work
				setTimeout(() => {
					try {
						proc.kill(9);
					} catch {
						// Ignore if already dead
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		// Read streams asynchronously
		(async () => {
			try {
				const stdoutReader = proc.stdout.getReader();
				const stderrReader = proc.stderr.getReader();

				const [stdoutResult, stderrResult] = await Promise.all([
					(async () => {
						const chunks: Uint8Array[] = [];
						while (true) {
							const { done, value } = await stdoutReader.read();
							if (done) break;
							chunks.push(value);
						}
						return Buffer.concat(chunks).toString();
					})(),
					(async () => {
						const chunks: Uint8Array[] = [];
						while (true) {
							const { done, value } = await stderrReader.read();
							if (done) break;
							chunks.push(value);
						}
						return Buffer.concat(chunks).toString();
					})(),
				]);

				stdout = stdoutResult;
				stderr = stderrResult;

				const exitCode = await proc.exited;

				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: exitCode ?? 0, killed });
			} catch (_err) {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			}
		})();
	});
}
