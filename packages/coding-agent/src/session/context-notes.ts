import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomEntry, SessionEntry } from "./session-entries";
import contextNotesPrompt from "../prompts/system/context-notes.md" with { type: "text" };

export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
/** Journal marker fixing the injected notebook at its pre-write revision for this context window. */
export const CONTEXT_NOTES_WINDOW_ENTRY_TYPE = "experimental_context_notes_window";
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
 * Returns the latest valid notebook revision before `end`, after the active reset boundary.
 * Invalid historical entries cannot mask an earlier valid notebook revision.
 */
export function getContextNotes(
	entries: readonly SessionEntry[],
	end = entries.length,
): ContextNotesRevision | undefined {
	for (let index = end - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") return undefined;
		if (!isContextNotesEntry(entry) || !isContextNotesData(entry.data)) continue;
		return { text: entry.data.text, entryId: entry.id };
	}
	return undefined;
}

/** Finds the first-write snapshot in the active context window, or -1 before any write. */
export function contextNotesWindowSnapshotIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "compaction" || entry.type === "reset_boundary") break;
		if (entry.type === "custom" && entry.customType === CONTEXT_NOTES_WINDOW_ENTRY_TYPE) return index;
	}
	return -1;
}

/** Resolves the notebook revision injected when this window was built, not later tool writes. */
export function getWindowContextNotes(entries: readonly SessionEntry[]): ContextNotesRevision | undefined {
	const snapshotIndex = contextNotesWindowSnapshotIndex(entries);
	return getContextNotes(entries, snapshotIndex < 0 ? entries.length : snapshotIndex);
}

/** Renders the window's non-empty notebook revision for model context. */
export function renderContextNotes(notes: ContextNotesRevision | undefined): string {
	if (!notes || notes.text.length === 0) return "";
	return prompt.render(contextNotesPrompt, { notes: notes.text }).trim();
}
