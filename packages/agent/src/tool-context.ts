import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "./types";

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
 * Join passive context values in order, dropping blanks. Returns undefined
 * when nothing remains.
 */
export function joinAdditionalContext(values: Iterable<string | undefined>): string | undefined {
	const kept: string[] = [];
	for (const value of values) {
		if (isNonBlankContext(value)) kept.push(value);
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}

/** Developer message emitted specifically for passive tool context. */
export type PassiveToolContextMessage = Extract<AgentMessage, { role: "developer" }> & {
	passiveToolContext: true;
};

/** Narrow an agent message to passive tool context without inspecting its text. */
export function isPassiveToolContextMessage(message: AgentMessage): message is PassiveToolContextMessage {
	return message.role === "developer" && message.passiveToolContext === true;
}

/**
 * Build the developer message that carries passive tool context to the next
 * provider request. Emitted after the tool results it belongs to.
 */
export function createAdditionalContextMessage(text: string): PassiveToolContextMessage {
	return {
		role: "developer",
		content: [{ type: "text", text }],
		attribution: "agent",
		passiveToolContext: true,
		timestamp: Date.now(),
	};
}
