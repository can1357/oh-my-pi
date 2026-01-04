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
import { getShellConfig, killProcessTree, sanitizeBinaryOutput } from "../utils/shell";
import { getOrCreateSnapshot, getSnapshotSourceCommand } from "../utils/shell-snapshot";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate";
import { ScopeSignal } from "./utils";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeout?: number;
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

function createSanitizer(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder();
	return new TransformStream({
		transform(chunk, controller) {
			const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(chunk, { stream: true }))).replace(/\r/g, "");
			controller.enqueue(text);
		},
	});
}

function createOutputSink(
	spillThreshold: number,
	maxBuffer: number,
	onChunk?: (text: string) => void,
): WritableStream<string> & {
	dump: (annotation?: string) => { output: string; truncated: boolean; fullOutputPath?: string };
} {
	const chunks: string[] = [];
	let chunkBytes = 0;
	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputStream: WriteStream | undefined;

	const sink = new WritableStream<string>({
		write(text) {
			totalBytes += text.length;

			// Spill to temp file if needed
			if (totalBytes > spillThreshold && !fullOutputPath) {
				fullOutputPath = join(tmpdir(), `omp-${crypto.randomUUID()}.buffer`);
				const ts = createWriteStream(fullOutputPath);
				chunks.forEach((c) => {
					ts.write(c);
				});
				fullOutputStream = ts;
			}
			fullOutputStream?.write(text);

			// Rolling buffer
			chunks.push(text);
			chunkBytes += text.length;
			while (chunkBytes > maxBuffer && chunks.length > 1) {
				chunkBytes -= chunks.shift()!.length;
			}

			onChunk?.(text);
		},
		close() {
			fullOutputStream?.end();
		},
	});

	return Object.assign(sink, {
		dump(annotation?: string) {
			if (annotation) {
				chunks.push(`\n\n${annotation}`);
			}
			const full = chunks.join("");
			const { content, truncated } = truncateTail(full);
			return { output: truncated ? content : full, truncated, fullOutputPath: fullOutputPath };
		},
	});
}

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
export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const { shell, args, env, prefix } = getShellConfig();

	// Get or create shell snapshot (for aliases, functions, options)
	const snapshotPath = await getOrCreateSnapshot(shell, env);
	const snapshotPrefix = getSnapshotSourceCommand(snapshotPath);

	// Build final command: snapshot + prefix + command
	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	const finalCommand = `${snapshotPrefix}${prefixedCommand}`;

	using signal = new ScopeSignal(options);

	const child: Subprocess = Bun.spawn([shell, ...args, finalCommand], {
		cwd: options?.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});

	signal.catch(() => {
		killProcessTree(child.pid);
	});

	const sink = createOutputSink(DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES * 2, options?.onChunk);

	const writer = sink.getWriter();
	try {
		async function pumpStream(readable: ReadableStream<Uint8Array>) {
			const reader = readable.pipeThrough(createSanitizer()).getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					await writer.write(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		await Promise.all([
			pumpStream(child.stdout as ReadableStream<Uint8Array>),
			pumpStream(child.stderr as ReadableStream<Uint8Array>),
		]);
	} finally {
		await writer.close();
	}

	// Non-zero exit codes or signal-killed processes are considered cancelled if killed via signal
	const exitCode = await child.exited;

	const cancelled = exitCode === null || (exitCode !== 0 && (options?.signal?.aborted ?? false));

	if (signal.timedOut()) {
		const secs = Math.round(options!.timeout! / 1000);
		return {
			exitCode: undefined,
			cancelled: true,
			...sink.dump(`Command timed out after ${secs} seconds`),
		};
	}

	return {
		exitCode: cancelled ? undefined : exitCode,
		cancelled,
		...sink.dump(),
	};
}
