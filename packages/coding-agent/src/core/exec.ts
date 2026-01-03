/**
 * Shared command execution utilities for hooks and custom tools.
 */

import type { Subprocess } from "bun";
import { logger } from "./logger";

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
				const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();

				// Read both streams and wait for process exit
				const [stdoutResult, stderrResult, exitCode] = await Promise.all([
					(async () => {
						const chunks: Uint8Array[] = [];
						try {
							while (true) {
								const { done, value } = await stdoutReader.read();
								if (done) break;
								chunks.push(value);
							}
						} finally {
							stdoutReader.releaseLock();
						}
						return Buffer.concat(chunks).toString();
					})(),
					(async () => {
						const chunks: Uint8Array[] = [];
						try {
							while (true) {
								const { done, value } = await stderrReader.read();
								if (done) break;
								chunks.push(value);
							}
						} finally {
							stderrReader.releaseLock();
						}
						return Buffer.concat(chunks).toString();
					})(),
					proc.exited,
				]);

				stdout = stdoutResult;
				stderr = stderrResult;

				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: exitCode ?? 0, killed });
			} catch (err) {
				logger.debug("Process stream error", { error: String(err) });
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			}
		})();
	});
}
