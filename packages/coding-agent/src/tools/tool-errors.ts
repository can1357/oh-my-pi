/**
 * Standardized error types for tool execution.
 *
 * Tools should throw these instead of returning error text.
 * The agent loop catches and renders them appropriately.
 */

/**
 * Base error for tool execution failures.
 * Override render() for custom LLM-facing formatting.
 */
export class ToolError extends Error {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
	) {
		super(message);
		this.name = "ToolError";
	}

	/** Render error for LLM consumption. Override for custom formatting. */
	render(): string {
		return this.message;
	}
}

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
