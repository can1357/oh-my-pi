import { prompt } from "@oh-my-pi/pi-utils";
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
