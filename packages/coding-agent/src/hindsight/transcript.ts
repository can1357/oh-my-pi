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

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type SessionEntry, type SessionHeader, TAN_FORK_BOUNDARY_CUSTOM_TYPE } from "../session/session-entries";
import { type HindsightMessage, hasSubstantiveContent } from "./content";

/** Finds the first retainable entry, skipping the transcript copied into this `/tan` fork. */
export function retentionStart(entries: readonly SessionEntry[], header?: SessionHeader | null): number {
	if (!header?.parentSession) return 0;
	return (
		entries.findLastIndex(
			entry =>
				entry.type === "custom" && entry.customType === TAN_FORK_BOUNDARY_CUSTOM_TYPE && entry.data === header.id,
		) + 1
	);
}

/**
 * Walk session entries top-to-bottom, returning a flat user/assistant list.
 *
 * Implementation choices:
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
export function extractMessages(entries: readonly SessionEntry[], start = 0): HindsightMessage[] {
	const messages: HindsightMessage[] = [];

	for (let i = start; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const msg = entry.message;
		const role = msg.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = role === "user" ? extractUserText(msg) : extractAssistantText(msg as AssistantMessage);
		if (!hasSubstantiveContent(text)) continue;
		messages.push({ role, content: text, timestamp: entry.timestamp });
	}

	return messages;
}

/**
 * Count user turns exactly as `extractMessages(entries, start).filter(m => m.role === "user").length`,
 * without extracting assistant text or allocating the message list. Not memoized: messages may be
 * rewritten in place (e.g. image stripping), so each call re-inspects current content.
 */
export function countUserTurns(entries: readonly SessionEntry[], start = 0): number {
	let count = 0;
	for (let i = start; i < entries.length; i++) {
		if (isUserTurn(entries[i]!)) count++;
	}
	return count;
}

/** Entry ids of the user turns {@link countUserTurns} counts, in order. */
export function userTurnEntryIds(entries: readonly SessionEntry[], start = 0): string[] {
	return entries.slice(start).flatMap(entry => (isUserTurn(entry) ? [entry.id] : []));
}

function isUserTurn(entry: SessionEntry): boolean {
	return (
		entry.type === "message" && entry.message.role === "user" && hasSubstantiveContent(extractUserText(entry.message))
	);
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

/** Reduce arbitrary AgentMessages (e.g. the messages a compaction summarizes) into the flat-text shape. */
export function flattenMessagesForRecall(messages: AgentMessage[]): HindsightMessage[] {
	const out: HindsightMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content = msg.content;
			if (typeof content === "string") {
				if (hasSubstantiveContent(content)) out.push({ role: "user", content });
				continue;
			}
			if (Array.isArray(content)) {
				const text = content
					.filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: unknown }).type === "text")
					.map(b => b.text)
					.join("\n");
				if (hasSubstantiveContent(text)) out.push({ role: "user", content: text });
			}
			continue;
		}
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map(b => b.text)
				.join("\n");
			if (hasSubstantiveContent(text)) out.push({ role: "assistant", content: text });
		}
	}
	return out;
}
