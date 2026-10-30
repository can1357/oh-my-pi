import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "./types";

const executingToolCall = new AsyncLocalStorage<string>();

/**
 * Run a tool call's execution with its id on the async context, so work the tool starts — however
 * deep, and across awaits — can be attributed to the call it belongs to without the tool passing
 * the id down by hand. Work started outside any `execute` (a host's own background handler, a
 * dialog raised by the surface) sees nothing.
 */
export function runInToolCall<T>(toolCallId: string, run: () => T): T {
	return executingToolCall.run(toolCallId, run);
}

/** The tool call whose execution the current async context belongs to, or undefined outside one. */
export function executingToolCallId(): string | undefined {
	return executingToolCall.getStore();
}

/**
 * Symbol-keyed carrier for passive context reported by a tool executed outside
 * the agent loop (Cursor exec-channel dispatch). The executor attaches the
 * joined context to the {@link ToolResultMessage} it returns; `Agent` reads it
 * when the provider hands the result back and injects it after the buffered
 * results. Symbol keys never serialize, so the context cannot leak into the
 * persisted tool result.
 */
export const TOOL_RESULT_ADDITIONAL_CONTEXT = Symbol("tool-result-additional-context");

/** A tool result optionally carrying {@link TOOL_RESULT_ADDITIONAL_CONTEXT}. */
export type ToolResultWithAdditionalContext = ToolResultMessage & { [TOOL_RESULT_ADDITIONAL_CONTEXT]?: string };

/**
 * True for a passive-context value worth delivering: a string with at least
 * one non-whitespace character. Shared by every producer and aggregation site
 * so blank values never produce a developer message.
 */
export function isNonBlankContext(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Join passive context values in order, dropping blanks and repeats of an
 * earlier value (compared without surrounding whitespace; the first original
 * is kept). Returns undefined when nothing remains.
 */
export function joinAdditionalContext(values: Iterable<string | undefined>): string | undefined {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const value of values) {
		if (!isNonBlankContext(value)) continue;
		const key = value.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(value);
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}

/**
 * Build the developer message that carries passive tool context to the next
 * provider request. Emitted after the tool results it belongs to.
 */
export function createAdditionalContextMessage(text: string): AgentMessage {
	return {
		role: "developer",
		content: [{ type: "text", text }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}
