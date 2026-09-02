import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { stringProperty } from "@oh-my-pi/pi-utils";
import { stripXdUrlPrefix } from "../internal-urls/xd-protocol";
import type { CompletedRewindState } from "../tools/checkpoint";
import { writeDeviceDispatch } from "../tools/resolve";
import type { SessionEntry } from "./session-entries";

/** Extracts text from custom message content. */
export function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/** Extracts the report body from persisted rewind-report content. */
export function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

/** Checkpoint-domain tool names normalized from native and xdev calls. */
export type SemanticCheckpointToolName = "checkpoint" | "rewind";

/** Normalized checkpoint-domain tool result. */
export interface SemanticToolResult {
	toolName: SemanticCheckpointToolName;
	details?: unknown;
}

/** Normalizes checkpoint and rewind results across native calls and xdev dispatches. */
export function semanticToolResult(toolName: string | undefined, result: unknown): SemanticToolResult | undefined {
	const canonicalName = toolName === undefined ? undefined : stripXdUrlPrefix(toolName);
	if (canonicalName === "checkpoint" || canonicalName === "rewind") {
		const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
		return { toolName: canonicalName, details };
	}
	const dispatch = writeDeviceDispatch(toolName ?? "", result);
	if (dispatch?.mode !== "execute" || (dispatch.tool !== "checkpoint" && dispatch.tool !== "rewind")) {
		return undefined;
	}
	return { toolName: dispatch.tool, details: dispatch.inner };
}

/** Restores completed rewind state from a persisted session entry. */
export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

/** Whether an entry is a successful checkpoint tool result. */
export function isSuccessfulCheckpointEntry(
	entry: SessionEntry,
): entry is SessionEntry & { type: "message"; message: Extract<AgentMessage, { role: "toolResult" }> } {
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError === true) {
		return false;
	}
	return semanticToolResult(entry.message.toolName, entry.message)?.toolName === "checkpoint";
}

/** Returns the checkpoint start timestamp represented by an entry. */
export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = semanticToolResult(entry.message.toolName, entry.message)?.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}
