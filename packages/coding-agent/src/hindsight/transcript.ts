/**
 * Pull plain-text user/assistant messages out of a session manager.
 *
 * These `{role, content, timestamp}` records are our internal conversation
 * shape. The Hindsight retain API ultimately receives a serialized transcript
 * string, so we drop tool calls, tool results, bash execution wrappers, custom
 * messages, and anything else that isn't a primary conversation turn. Each
 * surviving message's `TextContent` parts are joined with newlines. The
 * SessionEntry timestamp is preserved on the internal record as the source
 * event time.
 */

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

export interface ReadonlySessionManagerLike {
	getEntries(): SessionEntry[];
	/** Active root→leaf path. Prefer this over getEntries(), which includes abandoned branches. */
	getBranch?: (fromId?: string) => SessionEntry[];
}

/** Latest `/clear` marker on the active branch, if any. */
export function latestResetBoundaryId(sessionManager: ReadonlySessionManagerLike): string | undefined {
	const branch = sessionManager.getBranch?.() ?? sessionManager.getEntries();
	let id: string | undefined;
	for (const entry of branch) {
		if (entry?.type === "reset_boundary") id = entry.id;
	}
	return id;
}

/**
 * Retention document overlay for a live conversation. `/clear` keeps the
 * persisted session id, so post-reset retains use `sessionId:resetId` until
 * a later identity change. Resume reconstructs the same overlay from the
 * persisted reset boundary.
 */
export function hindsightDocumentIdForSession(
	persistedSessionId: string | undefined,
	sessionManager: ReadonlySessionManagerLike,
): string | undefined {
	if (!persistedSessionId) return undefined;
	const resetId = latestResetBoundaryId(sessionManager);
	return resetId ? `${persistedSessionId}:${resetId}` : undefined;
}

/**
 * Walk the active branch (root→leaf) top-to-bottom. `getEntries()` includes
 * abandoned `/tree` suffixes; using `getBranch()` keeps retain transcripts and
 * prefix-cache keys aligned with the conversation the user is actually in.
 *
 * Implementation choices:
 * - Start after the latest `reset_boundary` (`/clear`). Pre-clear history stays
 *   on disk but is not part of the live conversation Hindsight should retain.
 * - Skip entries whose type isn't `"message"` (compaction, branch_summary,
 *   custom_message, tool exec records, ...). Those don't represent a
 *   conversational turn, only the LLM's plain-text utterances do.
 * - Skip messages whose role isn't `"user"` or `"assistant"`. We deliberately
 *   ignore `toolResult`, `bashExecution`, `hookMessage`, etc. — they're noise
 *   for memory purposes.
 * - For assistant messages, only `text` blocks contribute. Thinking and
 *   toolCall blocks are intentionally dropped: the user never saw them, so
 *   retaining them would prime recall on internal monologue.
 */
export function countRetainableUserTurns(sessionManager: ReadonlySessionManagerLike): number {
	return extractMessages(sessionManager).filter(message => message.role === "user").length;
}

export function extractMessages(sessionManager: ReadonlySessionManagerLike): HindsightMessage[] {
	const messages: HindsightMessage[] = [];
	const branch = sessionManager.getBranch?.() ?? sessionManager.getEntries();
	let start = 0;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i]?.type === "reset_boundary") start = i + 1;
	}

	for (let i = start; i < branch.length; i++) {
		const entry = branch[i];
		if (entry === undefined || entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text, timestamp: entry.timestamp });
	}

	return messages;
}

function extractUserText(msg: { content: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: unknown; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts.join("\n");
}

function extractAssistantText(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}
