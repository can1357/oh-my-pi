/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import stripAnsi from "strip-ansi";
import { getShellConfig, killProcessTree, sanitizeBinaryOutput } from "../utils/shell.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command with optional streaming and cancellation support.
 *
 * Features:
 * - Streams sanitized output via onChunk callback
 * - Writes large output to temp file for later retrieval
 * - Supports cancellation via AbortSignal
 * - Sanitizes output (strips ANSI, removes binary garbage, normalizes newlines)
 * - Truncates output if it exceeds the default max bytes
 *
 * @param command - The bash command to execute
 * @param options - Optional streaming callback and abort signal
 * @returns Promise resolving to execution result
 */
export function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	return new Promise((resolve, reject) => {
		const { shell, args } = getShellConfig();
		const child: Subprocess = Bun.spawn([shell, ...args, command], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		// Track sanitized output for truncation
		const outputChunks: string[] = [];
		let outputBytes = 0;
		const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

		// Temp file for large output
		let tempFilePath: string | undefined;
		let tempFileStream: WriteStream | undefined;
		let totalBytes = 0;

		// Handle abort signal
		const abortHandler = () => {
			killProcessTree(child.pid);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				// Already aborted, don't even start
				child.kill();
				resolve({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return;
			}
			options.signal.addEventListener("abort", abortHandler, { once: true });
		}

		const handleData = (data: Buffer) => {
			totalBytes += data.length;

			// Sanitize once at the source: strip ANSI, replace binary garbage, normalize newlines
			const text = sanitizeBinaryOutput(stripAnsi(data.toString())).replace(/\r/g, "");

			// Start writing to temp file if exceeds threshold
			if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
				const randomId = crypto.getRandomValues(new Uint8Array(8));
				const id = Array.from(randomId, (b) => b.toString(16).padStart(2, "0")).join("");
				tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
				tempFileStream = createWriteStream(tempFilePath);
				// Write already-buffered chunks to temp file
				for (const chunk of outputChunks) {
					tempFileStream.write(chunk);
				}
			}

			if (tempFileStream) {
				tempFileStream.write(text);
			}

			// Keep rolling buffer of sanitized text
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}

			// Stream to callback if provided
			if (options?.onChunk) {
				options.onChunk(text);
			}
		};

		// Read streams asynchronously
		(async () => {
			try {
				const stdoutReader = child.stdout.getReader();
				const stderrReader = child.stderr.getReader();

				await Promise.all([
					(async () => {
						while (true) {
							const { done, value } = await stdoutReader.read();
							if (done) break;
							handleData(Buffer.from(value));
						}
					})(),
					(async () => {
						while (true) {
							const { done, value } = await stderrReader.read();
							if (done) break;
							handleData(Buffer.from(value));
						}
					})(),
				]);

				const exitCode = await child.exited;

				// Clean up abort listener
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortHandler);
				}

				if (tempFileStream) {
					tempFileStream.end();
				}

				// Combine buffered chunks for truncation (already sanitized)
				const fullOutput = outputChunks.join("");
				const truncationResult = truncateTail(fullOutput);

				// Non-zero exit codes or signal-killed processes are considered cancelled if killed via signal
				const cancelled = exitCode === null || (exitCode !== 0 && options?.signal?.aborted);

				resolve({
					output: truncationResult.truncated ? truncationResult.content : fullOutput,
					exitCode: cancelled ? undefined : exitCode,
					cancelled,
					truncated: truncationResult.truncated,
					fullOutputPath: tempFilePath,
				});
			} catch (err) {
				// Clean up abort listener
				if (options?.signal) {
					options.signal.removeEventListener("abort", abortHandler);
				}

				if (tempFileStream) {
					tempFileStream.end();
				}

				reject(err);
			}
		})();
	});
}
