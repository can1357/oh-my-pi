import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

export function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	return toolCalls;
}

/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

const ARTIFACT_INTERNAL_URL_PREFIX = "artifact://";

/** Recovery reads of session artifacts — eliding one only mints another artifact and can repeat indefinitely. */
export function isArtifactRecoveryToolResult(context: ProtectedToolContext): boolean {
	if (getReadToolPath(context)?.startsWith(ARTIFACT_INTERNAL_URL_PREFIX)) return true;
	const meta = (context.toolResult.details as { meta?: { source?: { type?: string; value?: string } } } | undefined)
		?.meta;
	return meta?.source?.type === "internal" && (meta.source.value?.startsWith(ARTIFACT_INTERNAL_URL_PREFIX) ?? false);
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
