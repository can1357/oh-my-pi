/**
 * `entry_patch` records: how a session file remembers fields set in place on
 * entries it already holds.
 *
 * Some passes change an entry after its line is written: a retry saga marks
 * the attempts it recovered (`retryRecovery`), compaction stamps its dead-end
 * `warning` and corrects `tokensAfter`, snapcompact stores its archive without
 * reasoning (`preserveData`), and an elide pass replaces heavy content with
 * placeholders. `SessionManager.patchEntries` sets those fields on the live
 * entries and appends one record listing them ({@link toEntryPatchData}), so
 * the write's size follows the patched fields, not the transcript; when a
 * target's line holds 4 MiB or more, which a collab guest cannot fetch, it
 * rewrites the file instead, writing that line with the fields set. The
 * original lines stay in the file, so every reader that shows or derives from
 * a patched field applies the records, with the one implementation in
 * `@oh-my-pi/pi-utils/entry-patches` (this module adds logging and the message
 * cache to it):
 *
 * - Whole-file readers call {@link applyEntryPatches} after migration:
 *   `SessionManager` resume and `forkFrom`, `loadSessionMessagesReadOnly`
 *   (`history://` and `agent://` for parked agents), the HTML sub-session
 *   export, `omp anonymize`, `omp gc --strip` to find the turn it keeps
 *   verbatim, and the title benchmark script. A `SessionManager` that keeps
 *   the entries another writer appended to its file applies the records among
 *   them to the entries it holds. `omp stats` (its session parse, trace, span
 *   and request drawers), the session-stats audit script, the compaction
 *   benchmark's fresh-start rebuild and the native archive scanner
 *   (`archive.messages`, `.transcript`, `.grep`, `.calls`, `.stats`) read the
 *   whole file and apply the records the same way, as does the Python
 *   `scripts/tool_io.py` through `scripts/entry_patches.py`.
 * - Memory extraction reads the rollout's records first, then its messages
 *   with them applied, through one open handle, so both passes read one body
 *   and the extraction model gets an elide pass's placeholders.
 * - Readers of windows apply each window's records to its entries (the RPC
 *   subagent transcript, whose entries keep the records for a client that
 *   holds earlier windows) and to entries of earlier windows: the Agent Hub
 *   transcript viewer, local or over a collab host's replies, and the collab
 *   web agent drawer, through an `EntryPatchReplay`, which holds a record read
 *   before its target until the target arrives, and Agent Activity, which
 *   shows a patched response's placeholder.
 * - Readers that store what they derived apply a later record to the stored
 *   result: a stats tail read, or a `scripts/session-stats/sync.py` run
 *   (through `scripts/entry_patches.py`), that meets a record naming an entry
 *   an earlier read stored, or an entry with an id a record of an earlier read
 *   names, derives the session's rows again; the archive's transcript index
 *   sets the text of the row of the last line with the id, the persisted Agent
 *   Hub metrics and `omp gc`'s stats identities recount the patched response.
 * - A collab host sends each record in an `entry` frame; a TUI or web guest
 *   sets its fields on the entry it holds and never shows the record.
 * - The session picker applies the records its prefix and tail windows hold
 *   to the entries its prefix holds, and its status to the last message of
 *   its tail; a record between the windows is not read, so a long session
 *   whose first prompt an elide pass shortened can still preview it in full.
 *   Its line scan for a prompt the prefix lacks reads on to the end for the
 *   records that name the prompt it found.
 * - `omp gc --strip` strips replay data from a record's patched content as
 *   from the message's own line, and leaves a record the readers skip as
 *   written.
 *
 * The raw loaders (`loadSessionFile`, `loadEntriesFromFile`,
 * `visitEntriesFromFileStream`, `visitEntriesFromFile`) and the stats
 * parser's `parseAllSessionEntries` return the records unapplied, among the
 * entries; their callers apply the records with {@link applyEntryPatches}.
 * RPC `get_entries` and `get_tree` return the manager's live entries, which
 * already carry the patched fields, with the records among them; a client
 * that keeps entries applies to them only the records a later `since` read
 * returns, as the browser-relay side panel does. `history://current/full`
 * renders the live entries and leaves the records out. Readers of other
 * fields (header and title reads, entry ids, usage and cost, line counts)
 * need no record. Binaries older than the record show the fields as first
 * written.
 *
 * A later full rewrite writes every patched field inline and writes each
 * record with no patches ({@link withoutEntryPatches}), so a field that a
 * later rewrite-only change replaced (images a later pass dropped from an
 * elided result) does not come back when the file is loaded.
 */
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ContextSnapshot, Message } from "@oh-my-pi/pi-ai";
import { cloneJsonTree, logger } from "@oh-my-pi/pi-utils";
import {
	applyEntryPatches as applyPatchRecords,
	type EntryPatchHooks,
	type EntryPatchSkip,
	isEntryPatchRecord,
	setPatchedFields as setStoredPatchFields,
	type EntryFieldsPatch as StoredEntryFieldsPatch,
	type EntryPatchTargets as StoredEntryPatchTargets,
	type MessageFieldsPatch as StoredMessageFieldsPatch,
} from "@oh-my-pi/pi-utils/entry-patches";
import type { CustomMessageEntry, FileEntry, SessionEntry } from "./session-entries";

// The record's own vocabulary lives in `@oh-my-pi/pi-utils/entry-patches`, with the
// apply logic every package shares; the SDK publishes it from here.
export { ENTRY_PATCH_CUSTOM_TYPE, entryAcceptsPatch, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";

/** Top-level entry fields a patch may set, typed as the session's entries hold them. */
export interface EntryFieldsPatch extends StoredEntryFieldsPatch {
	readonly preserveData?: Record<string, unknown>;
	readonly content?: CustomMessageEntry["content"];
}

/** Fields of a `message` entry's message a patch may set, typed as the session's messages hold them. */
export interface MessageFieldsPatch extends StoredMessageFieldsPatch {
	readonly retryRecovery?: AssistantRetryRecovery;
	readonly contextSnapshot?: ContextSnapshot;
	readonly content?: Message["content"];
}

/** Fields to set on one entry. */
export interface EntryPatch {
	/** Id of the entry to change. */
	readonly entryId: string;
	readonly entry?: EntryFieldsPatch;
	readonly message?: MessageFieldsPatch;
}

/** `data` of an `entry_patch` custom entry. */
export interface EntryPatchData {
	readonly patches: readonly EntryPatch[];
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function toEntryFields({ warning, tokensAfter, preserveData, content }: EntryFieldsPatch): EntryFieldsPatch {
	const fields: Writable<EntryFieldsPatch> = {};
	if (warning !== undefined) fields.warning = warning;
	if (tokensAfter !== undefined) fields.tokensAfter = tokensAfter;
	if (preserveData !== undefined) fields.preserveData = cloneJsonTree(preserveData);
	if (content !== undefined) fields.content = cloneJsonTree(content);
	return fields;
}

function toMessageFields({
	retryRecovery,
	contextSnapshot,
	elidedOutputTokens,
	prunedAt,
	content,
}: MessageFieldsPatch): MessageFieldsPatch {
	const fields: Writable<MessageFieldsPatch> = {};
	if (retryRecovery !== undefined) fields.retryRecovery = cloneJsonTree(retryRecovery);
	if (contextSnapshot !== undefined) fields.contextSnapshot = cloneJsonTree(contextSnapshot);
	if (elidedOutputTokens !== undefined) fields.elidedOutputTokens = elidedOutputTokens;
	if (prunedAt !== undefined) fields.prunedAt = prunedAt;
	if (content !== undefined) fields.content = cloneJsonTree(content);
	return fields;
}

/**
 * The `data` to persist for one set of patches. Copies each field explicitly,
 * so a field a caller adds to a patch object does not silently become part of
 * the on-disk record, and copies each object value ({@link cloneJsonTree}), so
 * the record shares no object with the entries the caller patches.
 */
export function toEntryPatchData(patches: readonly EntryPatch[]): EntryPatchData {
	return {
		patches: patches.map(({ entryId, entry, message }) => {
			const patch: Writable<EntryPatch> = { entryId };
			if (entry) patch.entry = toEntryFields(entry);
			if (message) patch.message = toMessageFields(message);
			return patch;
		}),
	};
}

/** A session's entries by id: where a patch record finds the entry it names. */
export type EntryPatchTargets = StoredEntryPatchTargets<SessionEntry>;

function warnSkipped(skip: EntryPatchSkip): void {
	switch (skip.reason) {
		case "malformed":
			logger.warn("Skipping malformed entry patch record", { id: skip.recordId });
			return;
		case "missing-target":
			logger.warn("Entry patch record targets no matching entry", { id: skip.recordId, target: skip.entryId });
			return;
		case "misfit":
			logger.warn("Skipping entry patch that does not fit its target", { id: skip.recordId, target: skip.entryId });
			return;
	}
}

/**
 * How a session's own readers apply records: each skipped record is logged,
 * and a message whose `content` a patch replaced drops its cached estimate.
 */
export const SESSION_ENTRY_PATCH_HOOKS: EntryPatchHooks<FileEntry> = {
	onSkip: warnSkipped,
	onMessageContentSet: entry => {
		if (entry.type === "message") invalidateMessageCache(entry.message);
	},
};

/** {@link SESSION_ENTRY_PATCH_HOOKS} for a window of a transcript, where a target before the window is not missing. */
export const WINDOW_ENTRY_PATCH_HOOKS: EntryPatchHooks<FileEntry> = {
	onSkip: skip => {
		if (skip.reason !== "missing-target") warnSkipped(skip);
	},
	onMessageContentSet: SESSION_ENTRY_PATCH_HOOKS.onMessageContentSet,
};

/**
 * Set `patch`'s fields on `entry`, as `@oh-my-pi/pi-utils/entry-patches`'
 * `setPatchedFields` does, dropping the cached estimate of a message whose
 * `content` it replaced.
 */
export function setPatchedFields(entry: SessionEntry, patch: EntryPatch): void {
	setStoredPatchFields<FileEntry>(entry, patch, SESSION_ENTRY_PATCH_HOOKS);
}

/**
 * Set, in place, every field an `entry_patch` record in `entries` names, so
 * freshly loaded entries read as the live session's entries did
 * (`applyEntryPatches` of `@oh-my-pi/pi-utils/entry-patches`). `targets`
 * finds the entry a patch names; by default it is one of `entries`. Records
 * apply in file order, so the newest value of a field wins, and applying them
 * again changes nothing. A record may precede its target. A malformed record,
 * or a patch whose target is missing, lacks a field it names, or holds
 * `content` of another shape, is skipped with a warning. The records stay
 * among `entries`. Returns whether any field was set.
 */
export function applyEntryPatches(entries: readonly FileEntry[], targets?: EntryPatchTargets): boolean {
	return applyPatchRecords(entries, { ...SESSION_ENTRY_PATCH_HOOKS, targets });
}

/** `data` of an `entry_patch` record that sets no field. */
export const NO_PATCHES: EntryPatchData = { patches: [] };

/**
 * `entry` as a full rewrite writes it: an `entry_patch` record loses its
 * patches, because the rewrite writes every patched field inline. Replaying
 * the old values would undo a change made after the record that only a full
 * rewrite persists.
 */
export function withoutEntryPatches(entry: FileEntry): FileEntry {
	return isEntryPatchRecord(entry) ? { ...entry, data: NO_PATCHES } : entry;
}

/**
 * Empty, in place, the patches of each `entry_patch` record among `entries`
 * once {@link applyEntryPatches} set their fields on their targets: the
 * fields live on the targets from then on, as {@link withoutEntryPatches}
 * leaves them for a rewrite.
 */
export function clearEntryPatchPayloads(entries: readonly FileEntry[]): void {
	for (const entry of entries) {
		if (isEntryPatchRecord(entry)) entry.data = NO_PATCHES;
	}
}
