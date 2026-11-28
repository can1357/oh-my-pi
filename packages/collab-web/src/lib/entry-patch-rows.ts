/**
 * Rows a collab guest shows, after the `entry_patch` records it read.
 *
 * A record sets fields, in place, on entries the guest already holds
 * (`EntryPatchReplay` of `@oh-my-pi/pi-utils/entry-patches` applies it). The
 * transcript memoizes its rows by entry identity, so an entry a record changed
 * goes back on screen as a new object. A record itself is never a row.
 */
import { isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import type { EntryPatchEntry, SessionEntry } from "@oh-my-pi/pi-wire";

/** One entry as a host sends it or a transcript file holds it: a row, or a record that patches rows. */
export type TranscriptLine = SessionEntry | EntryPatchEntry;

/** Whether `line` is a row to show, not an `entry_patch` record. */
export function isShownEntry(line: TranscriptLine): line is SessionEntry {
	return !isEntryPatchRecord(line);
}

/**
 * `rows` with each entry of `changed` in place of the row with its id, as a
 * new object with a new `message`, so a row memoized by identity (and a tool
 * result paired by its message) paints the fields a record set.
 */
export function repaintPatchedRows(rows: readonly SessionEntry[], changed: readonly TranscriptLine[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of changed) {
		if (!isShownEntry(entry)) continue;
		byId.set(entry.id, entry.type === "message" ? { ...entry, message: { ...entry.message } } : { ...entry });
	}
	return rows.map(row => byId.get(row.id) ?? row);
}
