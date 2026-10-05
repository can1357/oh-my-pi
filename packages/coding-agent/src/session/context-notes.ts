import { getMessageFromEntry } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core/tokenizer";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { CustomEntry, SessionEntry } from "./session-entries";
import contextNotesPrompt from "../prompts/system/context-notes.md" with { type: "text" };

export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;

export interface ContextNotesEntry {
	version: 1;
	text: string;
}

export interface ContextNotesRevision {
	text: string;
	entryId: string;
}

function isContextNotesEntry(entry: SessionEntry): entry is CustomEntry<unknown> {
	return entry.type === "custom" && entry.customType === CONTEXT_NOTES_ENTRY_TYPE;
}

function isContextNotesData(data: unknown): data is ContextNotesEntry {
	if (data === null || typeof data !== "object") return false;
	const candidate = data as Record<string, unknown>;
	const keys = Object.keys(candidate);
	return (
		keys.length === 2 &&
		keys.includes("version") &&
		keys.includes("text") &&
		candidate.version === 1 &&
		typeof candidate.text === "string" &&
		Buffer.byteLength(candidate.text, "utf8") <= MAX_CONTEXT_NOTES_BYTES
	);
}

/**
 * Returns the latest valid notebook revision visible after the active context-reset boundary.
 * Invalid historical custom entries are ignored so a malformed journal record cannot mask an
 * earlier valid notebook revision.
 */
export function getContextNotes(entries: readonly SessionEntry[]): ContextNotesRevision | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") return undefined;
		if (!isContextNotesEntry(entry) || !isContextNotesData(entry.data)) continue;
		return { text: entry.data.text, entryId: entry.id };
	}
	return undefined;
}

/**
 * Renders the context injection for the latest visible non-empty notebook revision.
 * An absent or explicitly cleared notebook returns an empty string so callers add no context.
 */
export function renderContextNotes(entries: readonly SessionEntry[]): string {
	const notes = getContextNotes(entries);
	if (!notes || notes.text.length === 0) return "";
	return prompt.render(contextNotesPrompt, { notes: notes.text }).trim();
}

export type ContextRolloverGrowth =
	| { allowed: true }
	| { allowed: false; freshTokens: number; minimumNewTokens: number };

/** Published branch boundaries, rather than a process-local cooldown, survive resume and forks. */
export function checkContextRolloverGrowth(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	minimumNewTokens: number,
): ContextRolloverGrowth {
	let boundary = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "reset_boundary") return { allowed: true };
		if (
			entry.type === "compaction" &&
			isRecord(entry.details) &&
			entry.details.kind === "experimental-context-rollover"
		) {
			boundary = index;
			break;
		}
	}
	if (boundary < 0) return { allowed: true };
	let freshTokens = 0;
	for (let index = boundary + 1; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary") continue;
		let message = getMessageFromEntry(entry);
		if (!message) continue;
		if (message.role === "toolResult" && (message.toolName === "new_context" || message.toolName === "context_notes"))
			continue;
		if (message.role === "assistant") {
			const content = message.content.filter(
				block => block.type !== "toolCall" || (block.name !== "new_context" && block.name !== "context_notes"),
			);
			if (content.length === 0) continue;
			if (content.length !== message.content.length) message = { ...message, content };
		}
		freshTokens += tokenizer.countMessage(message, { excludeEncryptedReasoning: true });
		if (freshTokens >= minimumNewTokens) return { allowed: true };
	}
	return { allowed: false, freshTokens, minimumNewTokens };
}
