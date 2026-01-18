/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import type { Subprocess } from "bun";
import { getShellConfig, killProcessTree } from "../utils/shell";
import { getOrCreateSnapshot, getSnapshotSourceCommand } from "../utils/shell-snapshot";
import { createOutputSink, pumpStream } from "./streaming-output";
import type { BashOperations } from "./tools/bash";
import { DEFAULT_MAX_BYTES } from "./tools/truncate";
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
	const { shell, args, env, prefix } = await getShellConfig();

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
		await Promise.all([
			pumpStream(child.stdout as ReadableStream<Uint8Array>, writer),
			pumpStream(child.stderr as ReadableStream<Uint8Array>, writer),
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

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const sink = createOutputSink(DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES * 2, options?.onChunk);
	const writer = sink.getWriter();

	// Create a ReadableStream from the callback-based operations.exec
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	const dataStream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	const onData = (data: Buffer) => {
		streamController.enqueue(new Uint8Array(data));
	};

	// Start pumping the stream (will complete when stream closes)
	const pumpPromise = pumpStream(dataStream, writer);

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
			timeout: options?.timeout,
		});

		streamController!.close();
		await pumpPromise;
		await writer.close();

		const cancelled = options?.signal?.aborted ?? false;

		return {
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			...sink.dump(),
		};
	} catch (err) {
		streamController!.close();
		await pumpPromise;
		await writer.close();

		if (options?.signal?.aborted) {
			return {
				exitCode: undefined,
				cancelled: true,
				...sink.dump(),
			};
		}

		throw err;
	}
}
