/**
 * Standardized error types for tool execution.
 *
 * Tools should throw these instead of returning error text.
 * The agent loop catches and renders them appropriately.
 */

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Error thrown when a tool operation is aborted (e.g., via AbortSignal).
 */
export class ToolAbortError extends Error {
	static readonly MESSAGE = "Operation aborted";

	constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolAbortError";
	}
}

/**
 * Throw ToolAbortError if the signal is aborted.
 * Use this instead of signal?.throwIfAborted() to get consistent error types.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : undefined;
		throw reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: signal.reason });
	}
}

/**
 * Render an error for LLM consumption.
 * Handles ToolError.render() and falls back to message/string.
 */
export function renderError(e: unknown): string {
	if (e instanceof ToolError) {
		return e.render();
	}
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}

/** Clone-safe error metadata a tool worker sends back across the worker boundary. */
export interface WorkerErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
}

/** Serialize a thrown value into {@link WorkerErrorPayload} for a worker `tool-reply`. */
export function toWorkerErrorPayload(error: unknown): WorkerErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}
