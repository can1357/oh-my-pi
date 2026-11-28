/**
 * `entry_patch` records of a session transcript, as every reader of the file
 * applies them.
 *
 * A pass that changes an entry after its line is written (a retry saga's
 * marker, a compaction's dead-end `warning` or corrected `tokensAfter`, a
 * snapcompact archive, an elide pass's placeholders) appends one `custom`
 * entry with `customType` {@link ENTRY_PATCH_CUSTOM_TYPE} that names entries
 * already in the file and the fields to set on them, instead of rewriting the
 * file. The original lines stay, so a reader that shows or derives anything
 * from those fields applies the records first:
 *
 * - over the entries of a whole transcript, {@link applyEntryPatches};
 * - over windows of one transcript read one after another (a tail that grows,
 *   replies of at most a few MiB), an {@link EntryPatchReplay}, which applies a
 *   record to a target from an earlier window and holds a record whose target
 *   has not been read yet until it is;
 * - over results a reader derived and stored earlier (rows of a database),
 *   {@link entryPatchesOf} on each record, then {@link entryAcceptsPatch} (or
 *   {@link patchFitsMessageRole}, holding no entry) and {@link setPatchedFields}
 *   on the stored entry, or the fields themselves.
 *
 * A reader of raw bytes or text finds the records without parsing other lines:
 * {@link entryPatchMarkerAt} and {@link entryPatchRecordsIn}. Of entries that
 * share an id, a record sets fields on the last in the file
 * ({@link entryPatchTargetId} names an entry's id).
 *
 * Records apply in file order, so the newest value of a field wins, and
 * applying them again changes nothing. Entries are read as parsed JSON, so any
 * entry type a reader declares can be patched. The module uses no Node API, so
 * a browser client imports it as `@oh-my-pi/pi-utils/entry-patches`.
 */
import { cloneJsonTree } from "./json-clone";
import { isRecord } from "./type-guards";

/** `customType` of an `entry_patch` record. */
export const ENTRY_PATCH_CUSTOM_TYPE = "entry_patch";

/** A content block as a record holds it. */
export interface EntryPatchContentBlock {
	readonly type: string;
}

/** `content` as a record holds it: a string, or a list of typed blocks. */
export type EntryPatchContent = string | readonly EntryPatchContentBlock[];

/** Top-level entry fields a patch may set. */
export interface EntryFieldsPatch {
	/** `warning` of a `compaction` entry: the dead-end warning on its divider. */
	readonly warning?: string;
	/** `tokensAfter` of a `compaction` entry, projected again after rescue tiers ran. */
	readonly tokensAfter?: number;
	/** `preserveData` of a `compaction` entry (the snapcompact archive without reasoning). */
	readonly preserveData?: object;
	/** `content` of a `custom_message` entry an elide pass shortened. */
	readonly content?: EntryPatchContent;
}

/** Fields of a `message` entry's message a patch may set. */
export interface MessageFieldsPatch {
	/** Assistant `retryRecovery`: how a retry saga settled the attempt. */
	readonly retryRecovery?: object;
	/** Assistant `contextSnapshot`: the usage anchor's record of tokens a history rewrite removed. */
	readonly contextSnapshot?: object;
	/** Assistant `elidedOutputTokens`. */
	readonly elidedOutputTokens?: number;
	/** Tool result `prunedAt`. */
	readonly prunedAt?: number;
	/** `content` of a user, developer, assistant or tool-result message an elide pass shortened. */
	readonly content?: EntryPatchContent;
}

/** Fields to set on one entry. */
export interface EntryPatch {
	/** Id of the entry to change. */
	readonly entryId: string;
	readonly entry?: EntryFieldsPatch;
	readonly message?: MessageFieldsPatch;
}

/** `data` of an `entry_patch` record. */
export interface EntryPatchData {
	readonly patches: readonly EntryPatch[];
}

/** An `entry_patch` record as read from a transcript line. */
export interface EntryPatchRecord {
	readonly type: "custom";
	readonly customType: typeof ENTRY_PATCH_CUSTOM_TYPE;
	readonly id?: string;
	readonly data?: unknown;
}

/** Why a reader left a record, or one patch of it, unapplied. */
export type EntryPatchSkipReason =
	/** The record's `data` is not a list of patches of the fields above. */
	| "malformed"
	/** No entry has the id the patch names. */
	| "missing-target"
	/** The patch names a field its target's kind or role lacks, or `content` of another shape. */
	| "misfit";

/** A record, or one patch of it, a reader left unapplied. */
export interface EntryPatchSkip {
	readonly reason: EntryPatchSkipReason;
	/** Id of the record. */
	readonly recordId: string | undefined;
	/** Id of the entry the patch names; absent for a malformed record. */
	readonly entryId?: string;
}

/** What a reader learns as records apply. */
export interface EntryPatchHooks<E extends object> {
	/** A record, or one patch of it, was not applied. */
	readonly onSkip?: (skip: EntryPatchSkip) => void;
	/**
	 * A patch replaced the `content` of the message of `entry`, a `message`
	 * entry, so a value cached on that message object is stale.
	 */
	readonly onMessageContentSet?: (entry: E) => void;
}

/** A transcript's entries by id: where a patch finds the entry it names. */
export interface EntryPatchTargets<E extends object> {
	get(entryId: string): E | undefined;
}

/** Options of {@link applyEntryPatches}. */
export interface ApplyEntryPatchesOptions<E extends object> extends EntryPatchHooks<E> {
	/** Where a patch finds the entry it names; by default, the entry with that id among the entries given. */
	readonly targets?: EntryPatchTargets<E>;
}

/**
 * One field a patch sets, by where it lives: `entry.<field>` on the entry,
 * `message.<field>` on a `message` entry's message.
 */
type PatchField = `entry.${keyof EntryFieldsPatch}` | `message.${keyof MessageFieldsPatch}`;

/**
 * Message roles whose `content` an elide pass shortens, each with whether that
 * `content` may be a string; assistant and tool-result `content` is always a
 * list of blocks.
 */
const CONTENT_TAKES_STRING: Readonly<Record<string, boolean>> = {
	user: true,
	developer: true,
	assistant: false,
	toolResult: false,
};

/** Whether `value` is a finite number, as every count a patch sets is. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Whether `value` is absent or a finite number. */
function isCount(value: unknown): value is number | undefined {
	return value === undefined || isFiniteNumber(value);
}

/**
 * Whether `block` is a content block a message can hold: a string `type`, and
 * for each known type the payload the model-context builder and the providers
 * read from it, so a request built from the block never meets a missing or
 * mistyped field. A block of another type passes on its `type` alone.
 */
function isContentBlock(block: unknown): block is EntryPatchContentBlock {
	if (!isRecord(block) || typeof block.type !== "string") return false;
	switch (block.type) {
		case "text":
			return typeof block.text === "string";
		case "thinking":
			return (
				typeof block.thinking === "string" &&
				(block.thinkingSignature === undefined || typeof block.thinkingSignature === "string")
			);
		case "redactedThinking":
			return typeof block.data === "string";
		case "image":
			return typeof block.data === "string" && typeof block.mimeType === "string";
		case "toolCall":
			return typeof block.id === "string" && typeof block.name === "string" && isRecord(block.arguments);
		case "fallback":
			return (
				isRecord(block.from) &&
				typeof block.from.model === "string" &&
				isRecord(block.to) &&
				typeof block.to.model === "string"
			);
		case "anthropicServerTool":
			return isRecord(block.block);
		default:
			return true;
	}
}

function isContent(value: unknown): value is EntryPatchContent {
	return typeof value === "string" || (Array.isArray(value) && value.every(isContentBlock));
}

/**
 * Whether `value` is an assistant's `contextSnapshot`: its prompt and
 * non-message token counts finite numbers, and each optional count absent or
 * one, as context usage sums them.
 */
function isContextSnapshot(value: unknown): boolean {
	return (
		isRecord(value) &&
		isFiniteNumber(value.promptTokens) &&
		isFiniteNumber(value.nonMessageTokens) &&
		isCount(value.toolSchemaTokens) &&
		isCount(value.historyRewriteTokensRemoved) &&
		isCount(value.compactionEpoch) &&
		isCount(value.lastMessageTimestamp)
	);
}

function isEntryFields(value: unknown): value is EntryFieldsPatch {
	return (
		isRecord(value) &&
		(value.warning === undefined || typeof value.warning === "string") &&
		isCount(value.tokensAfter) &&
		(value.preserveData === undefined || isRecord(value.preserveData)) &&
		(value.content === undefined || isContent(value.content))
	);
}

function isMessageFields(value: unknown): value is MessageFieldsPatch {
	return (
		isRecord(value) &&
		(value.retryRecovery === undefined || isRecord(value.retryRecovery)) &&
		(value.contextSnapshot === undefined || isContextSnapshot(value.contextSnapshot)) &&
		isCount(value.elidedOutputTokens) &&
		isCount(value.prunedAt) &&
		(value.content === undefined || isContent(value.content))
	);
}

function isEntryPatch(value: unknown): value is EntryPatch {
	return (
		isRecord(value) &&
		typeof value.entryId === "string" &&
		(value.entry === undefined || isEntryFields(value.entry)) &&
		(value.message === undefined || isMessageFields(value.message))
	);
}

/** Whether `value` is the `data` of a well-formed `entry_patch` record. */
export function isEntryPatchData(value: unknown): value is EntryPatchData {
	return isRecord(value) && Array.isArray(value.patches) && value.patches.every(isEntryPatch);
}

/** Whether `entry` is an `entry_patch` record. */
export function isEntryPatchRecord<E extends object>(entry: E): entry is E & EntryPatchRecord {
	return isRecord(entry) && entry.type === "custom" && entry.customType === ENTRY_PATCH_CUSTOM_TYPE;
}

/** The patches of `record`, or `undefined` when its `data` is malformed. */
export function entryPatchesOf(record: EntryPatchRecord): readonly EntryPatch[] | undefined {
	const data = record.data;
	return isEntryPatchData(data) ? data.patches : undefined;
}

/**
 * UTF-8 bytes of the `customType` of an `entry_patch` record as JSON writes it:
 * the line of every record holds them, so a reader of raw bytes parses only
 * the lines that do ({@link entryPatchMarkerAt}).
 */
export const ENTRY_PATCH_MARKER: Uint8Array = new TextEncoder().encode(JSON.stringify(ENTRY_PATCH_CUSTOM_TYPE));
/** Where {@link ENTRY_PATCH_MARKER} holds its `_`, the byte a search looks for first: transcripts hold far fewer than quotes. */
const MARKER_ANCHOR = ENTRY_PATCH_MARKER.indexOf(0x5f);

/** Index of the first {@link ENTRY_PATCH_MARKER} in `bytes` at or after `from`, or -1. */
export function entryPatchMarkerAt(bytes: Uint8Array, from = 0): number {
	const anchor = ENTRY_PATCH_MARKER[MARKER_ANCHOR]!;
	const lastStart = bytes.length - ENTRY_PATCH_MARKER.length;
	for (let at = bytes.indexOf(anchor, from + MARKER_ANCHOR); at !== -1; at = bytes.indexOf(anchor, at + 1)) {
		const start = at - MARKER_ANCHOR;
		if (start > lastStart) return -1;
		let matched = 0;
		while (matched < ENTRY_PATCH_MARKER.length && bytes[start + matched] === ENTRY_PATCH_MARKER[matched]) matched++;
		if (matched === ENTRY_PATCH_MARKER.length) return start;
	}
	return -1;
}

/**
 * The `entry_patch` records among the lines of `text`, a window of a session
 * file, in file order. Only lines that name the record's type are parsed, and
 * a line that is not one JSON value is skipped.
 */
export function entryPatchRecordsIn(text: string): EntryPatchRecord[] {
	const records: EntryPatchRecord[] = [];
	if (!text.includes(ENTRY_PATCH_CUSTOM_TYPE)) return records;
	for (const line of text.split("\n")) {
		if (!line.includes(ENTRY_PATCH_CUSTOM_TYPE)) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(value) && isEntryPatchRecord(value)) records.push(value);
	}
	return records;
}

/** Id of `record`, for a skip report. */
function recordIdOf(record: EntryPatchRecord): string | undefined {
	return typeof record.id === "string" ? record.id : undefined;
}

/** Whether every field `patch` names exists on `entry`'s kind, with a `content` of the shape its role holds. */
export function entryAcceptsPatch(entry: object, patch: EntryPatch): boolean {
	if (!isRecord(entry)) return false;
	const fields = patch.entry;
	if (fields) {
		const compactionFields =
			fields.warning !== undefined || fields.tokensAfter !== undefined || fields.preserveData !== undefined;
		if (compactionFields && entry.type !== "compaction") return false;
		if (fields.content !== undefined && entry.type !== "custom_message") return false;
	}
	const message = patch.message;
	if (!message) return true;
	if (entry.type !== "message" || !isRecord(entry.message)) return false;
	const role = entry.message.role;
	const assistantFields =
		message.retryRecovery !== undefined ||
		message.contextSnapshot !== undefined ||
		message.elidedOutputTokens !== undefined;
	if (assistantFields && role !== "assistant") return false;
	if (message.prunedAt !== undefined && role !== "toolResult") return false;
	if (message.content === undefined) return true;
	return (
		typeof role === "string" &&
		Object.hasOwn(CONTENT_TAKES_STRING, role) &&
		(CONTENT_TAKES_STRING[role] === true || typeof message.content !== "string")
	);
}

/**
 * Whether `patch` fits a `message` entry whose message has `role`, as
 * {@link entryAcceptsPatch} decides: for a reader that stored what it derived
 * from such messages and holds no entry to ask.
 */
export function patchFitsMessageRole(patch: EntryPatch, role: string): boolean {
	return entryAcceptsPatch({ type: "message", message: { role } }, patch);
}

/**
 * `value` for `holder[key]`: `value` itself when `holder` already holds it
 * there, else a copy. Reads `key`'s own data descriptor, so no accessor runs
 * to answer the identity check.
 */
function ownCopy<T>(holder: object, key: string, value: T): T {
	return Object.getOwnPropertyDescriptor(holder, key)?.value === value ? value : cloneJsonTree(value);
}

const TAKE_EVERY_FIELD = (): boolean => true;

/**
 * {@link setPatchedFields}, setting only the fields `take` claims; `take` is
 * asked once for each field the patch sets on `entry`. Returns whether any
 * field was claimed.
 */
function writeFields<E extends object>(
	entry: E,
	patch: EntryPatch,
	hooks: EntryPatchHooks<E> | undefined,
	take: (field: PatchField) => boolean,
): boolean {
	if (!isRecord(entry)) return false;
	const target: Record<string, unknown> = entry;
	let claimed = false;
	const fields = patch.entry;
	if (fields && target.type === "compaction") {
		if (fields.warning !== undefined && take("entry.warning")) {
			target.warning = fields.warning;
			claimed = true;
		}
		if (fields.tokensAfter !== undefined && take("entry.tokensAfter")) {
			target.tokensAfter = fields.tokensAfter;
			claimed = true;
		}
		if (fields.preserveData !== undefined && take("entry.preserveData")) {
			target.preserveData = ownCopy(target, "preserveData", fields.preserveData);
			claimed = true;
		}
	}
	if (fields?.content !== undefined && target.type === "custom_message" && take("entry.content")) {
		target.content = ownCopy(target, "content", fields.content);
		claimed = true;
	}
	const patched = patch.message;
	if (!patched || target.type !== "message") return claimed;
	const message = target.message;
	if (!isRecord(message)) return claimed;
	if (message.role === "assistant") {
		if (patched.retryRecovery !== undefined && take("message.retryRecovery")) {
			message.retryRecovery = ownCopy(message, "retryRecovery", patched.retryRecovery);
			claimed = true;
		}
		if (patched.contextSnapshot !== undefined && take("message.contextSnapshot")) {
			message.contextSnapshot = ownCopy(message, "contextSnapshot", patched.contextSnapshot);
			claimed = true;
		}
		if (patched.elidedOutputTokens !== undefined && take("message.elidedOutputTokens")) {
			message.elidedOutputTokens = patched.elidedOutputTokens;
			claimed = true;
		}
	}
	if (patched.prunedAt !== undefined && message.role === "toolResult" && take("message.prunedAt")) {
		message.prunedAt = patched.prunedAt;
		claimed = true;
	}
	if (patched.content !== undefined && "content" in message && take("message.content")) {
		claimed = true;
		if (Object.getOwnPropertyDescriptor(message, "content")?.value !== patched.content) {
			message.content = cloneJsonTree(patched.content);
			// The message keeps its identity across context rebuilds; a value cached on it is stale.
			hooks?.onMessageContentSet?.(entry);
		}
	}
	return claimed;
}

/**
 * Set `patch`'s fields on `entry`, which {@link entryAcceptsPatch} accepted.
 * Each object value is copied ({@link cloneJsonTree}, which shares the
 * immutable strings) unless `entry` already holds that very value, so `entry`
 * never shares an object with a record: a later in-place write to `entry`,
 * such as an elide or prune pass writing into `content`, leaves the record as
 * written and succeeds when the record's data was read back frozen.
 */
export function setPatchedFields<E extends object>(entry: E, patch: EntryPatch, hooks?: EntryPatchHooks<E>): void {
	writeFields(entry, patch, hooks, TAKE_EVERY_FIELD);
}

/** Id under which `entry` is a patch target: every entry but the session header has one. */
export function entryPatchTargetId(entry: object): string | undefined {
	if (!isRecord(entry) || entry.type === "session") return undefined;
	return typeof entry.id === "string" ? entry.id : undefined;
}

function entriesById<E extends object>(entries: readonly E[]): Map<string, E> {
	const byId = new Map<string, E>();
	for (const entry of entries) {
		const id = entryPatchTargetId(entry);
		if (id !== undefined) byId.set(id, entry);
	}
	return byId;
}

/**
 * Set, in place, every field an `entry_patch` record in `entries` names, so
 * entries read from a transcript read as the live session's entries did.
 * `options.targets` finds the entry a patch names; by default it is one of
 * `entries`. Records apply in file order, so the newest value of a field wins,
 * and applying them again changes nothing. A record may precede its target. A
 * malformed record, or a patch whose target is missing, lacks a field it
 * names, or holds `content` of another shape, is skipped and reported to
 * `options.onSkip`. The records stay among `entries`. Returns whether any
 * field was set.
 */
export function applyEntryPatches<E extends object>(
	entries: readonly E[],
	options: ApplyEntryPatchesOptions<E> = {},
): boolean {
	let lookup = options.targets;
	let changed = false;
	for (const entry of entries) {
		if (!isEntryPatchRecord(entry)) continue;
		const patches = entryPatchesOf(entry);
		if (!patches) {
			options.onSkip?.({ reason: "malformed", recordId: recordIdOf(entry) });
			continue;
		}
		if (patches.length === 0) continue;
		lookup ??= entriesById(entries);
		for (const patch of patches) {
			const target = lookup.get(patch.entryId);
			if (!target) {
				options.onSkip?.({ reason: "missing-target", recordId: recordIdOf(entry), entryId: patch.entryId });
				continue;
			}
			if (!entryAcceptsPatch(target, patch)) {
				options.onSkip?.({ reason: "misfit", recordId: recordIdOf(entry), entryId: patch.entryId });
				continue;
			}
			setPatchedFields(target, patch, options);
			changed = true;
		}
	}
	return changed;
}

/** Where a line lies in its transcript: the window it was read in, then its place in that window. */
interface LineOrder {
	readonly window: number;
	readonly index: number;
}

/** Where a patch lies in its transcript: its record's line, then the patch's place in the record. */
interface PatchOrder extends LineOrder {
	readonly patch: number;
}

/** Whether line `a` lies at or after line `b` in the transcript. */
function isLineAtOrAfter(a: LineOrder, b: LineOrder): boolean {
	return a.window !== b.window ? a.window > b.window : a.index >= b.index;
}

/** Whether `a` lies at or after `b` in the transcript. */
function isAtOrAfter(a: PatchOrder, b: PatchOrder): boolean {
	if (a.window !== b.window || a.index !== b.index) return isLineAtOrAfter(a, b);
	return a.patch >= b.patch;
}

/** One patch of a record, with where it lies and its record's id. */
interface HeldPatch {
	readonly patch: EntryPatch;
	readonly order: PatchOrder;
	readonly recordId: string | undefined;
}

/** Stands in for a field an entry did not hold before a record set it. */
const ABSENT: unique symbol = Symbol("absent");

/** The entry records set fields on for one id: of the entries read with that id, the last in the file. */
interface HeldTarget<E extends object> {
	readonly entry: E;
	readonly at: LineOrder;
	/** Where the patch lies that set each field the entry holds from a record. */
	readonly setBy: Map<PatchField, PatchOrder>;
	/** The value each field held before a record first set it, {@link ABSENT} for a field it lacked. */
	readonly original: Map<PatchField, unknown>;
	/** The JSON of each other line read with the id: lines before the held one, which no record reaches. */
	readonly seen: Set<string>;
}

/** The object that holds `field` of `entry`, and its key there; `undefined` for a message field of an entry without a message. */
function fieldPlace(entry: object, field: PatchField): { holder: Record<string, unknown>; key: string } | undefined {
	if (!isRecord(entry)) return undefined;
	const dot = field.indexOf(".");
	const key = field.slice(dot + 1);
	if (field.startsWith("entry.")) return { holder: entry, key };
	return isRecord(entry.message) ? { holder: entry.message, key } : undefined;
}

/** The JSON of `held`'s entry as its line holds it: each field a record set, with the value it held before. */
function lineOf<E extends object>(held: HeldTarget<E>): string {
	const originals = new Map<object, Map<string, unknown>>();
	for (const [field, value] of held.original) {
		const place = fieldPlace(held.entry, field);
		if (!place) continue;
		const keys = originals.get(place.holder) ?? new Map<string, unknown>();
		keys.set(place.key, value);
		originals.set(place.holder, keys);
	}
	return JSON.stringify(held.entry, function (this: object, key: string, value: unknown) {
		const keys = originals.get(this);
		if (!keys?.has(key)) return value;
		const original = keys.get(key);
		return original === ABSENT ? undefined : original;
	});
}

/**
 * The records of one transcript that a reader reads in windows: complete lines
 * of byte ranges, a tail that grows, replies of a host that serves a few MiB at
 * a time. {@link add} takes each window's parsed entries, holds them by id, and
 * applies every record read so far to them: a record to a target from an
 * earlier window, which {@link add} returns so the reader can show it again,
 * and a record read before its target (a window read out of file order) as
 * soon as the target arrives. Of two patches that set one field, the later in
 * the file wins, in whatever order their windows arrive; within one record,
 * the later in its list, as {@link applyEntryPatches} decides. Of entries that
 * share an id, the records set fields on the last in the file only: when a
 * later one arrives, the earlier one gets back the values it held before the
 * records, and {@link add} returns it. A line read again is told apart from
 * another line with its id by its JSON: read again, the held line's new object
 * becomes the target in its place, and an earlier line's carries no record.
 *
 * It holds every entry it was given, and every patch it read, until
 * {@link forget} or {@link clear}, so an entry read again carries the records
 * read before it; a reader that drops an entry it shows calls {@link forget},
 * and one that starts over from the transcript's start (a rewrite, a
 * truncation) calls {@link clear} first.
 */
export class EntryPatchReplay<E extends object> {
	readonly #hooks: EntryPatchHooks<E>;
	readonly #held = new Map<string, HeldTarget<E>>();
	/** Every patch read, by the id of the entry it names, in the order read. */
	readonly #patches = new Map<string, HeldPatch[]>();
	#lastWindow = -1;

	/** `hooks.onSkip` hears of malformed records and of patches that do not fit their target; a patch whose target has not been read is not skipped. */
	constructor(hooks: EntryPatchHooks<E> = {}) {
		this.#hooks = hooks;
	}

	/** The held entry with id `entryId`: of the entries read with it, the last in the file. */
	get(entryId: string): E | undefined {
		return this.#held.get(entryId)?.entry;
	}

	/**
	 * Take the parsed entries of one window, in file order, and apply the
	 * records read so far. `start` is where the window starts in the
	 * transcript (its byte offset), so windows read out of file order apply
	 * their records in file order; a window without one follows every window
	 * added before it. An entry with the id of a held one that lies after it,
	 * or that is the held line read again, replaces it and carries every
	 * record read so far that names it; the replaced entry, when it is another
	 * object, gets back the values it held before the records. An entry that
	 * lies before the held one with its id, or that is such a line read again,
	 * carries no record. Returns the entries held from an earlier call that a
	 * record in this window changed or that this window replaced; an entry of
	 * this window carries its records when this returns.
	 */
	add(entries: readonly E[], start?: number): E[] {
		const window = start ?? this.#lastWindow + 1;
		if (window > this.#lastWindow) this.#lastWindow = window;
		const arrived = new Set<E>();
		const changed = new Set<E>();
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			const id = entryPatchTargetId(entry);
			if (id === undefined) continue;
			const target = this.#arrive(entry, { window, index }, this.#held.get(id), changed);
			if (!target) continue;
			this.#held.set(id, target);
			arrived.add(entry);
		}
		for (const entry of arrived) {
			const id = entryPatchTargetId(entry)!;
			const held = this.#held.get(id);
			// Of two entries of this window with one id, the later is held.
			if (held?.entry !== entry) continue;
			for (const patch of this.#patches.get(id) ?? []) this.#apply(held, id, patch, changed);
		}
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index]!;
			if (!isEntryPatchRecord(entry)) continue;
			const recordId = recordIdOf(entry);
			const patches = entryPatchesOf(entry);
			if (!patches) {
				this.#hooks.onSkip?.({ reason: "malformed", recordId });
				continue;
			}
			for (let at = 0; at < patches.length; at++) {
				const patch = patches[at]!;
				const held: HeldPatch = { patch, order: { window, index, patch: at }, recordId };
				const read = this.#patches.get(patch.entryId);
				if (read) read.push(held);
				else this.#patches.set(patch.entryId, [held]);
				const target = this.#held.get(patch.entryId);
				if (target) this.#apply(target, patch.entryId, held, changed);
			}
		}
		const earlier: E[] = [];
		for (const entry of changed) if (!arrived.has(entry)) earlier.push(entry);
		return earlier;
	}

	/** Stop holding the entry with id `entryId`, and the patches that name it. */
	forget(entryId: string): void {
		this.#held.delete(entryId);
		this.#patches.delete(entryId);
	}

	/** Stop holding every entry and patch, as before the first {@link add}. */
	clear(): void {
		this.#held.clear();
		this.#patches.clear();
		this.#lastWindow = -1;
	}

	/**
	 * The target of `entry`'s id once `entry`, read at `at`, arrives where `held` is the target so far, or
	 * `undefined` when `entry` is no target: a line before the held one, or such a line read again. A held
	 * entry this replaces gets back its values, and goes into `changed`.
	 */
	#arrive(entry: E, at: LineOrder, held: HeldTarget<E> | undefined, changed: Set<E>): HeldTarget<E> | undefined {
		if (!held) return { entry, at, setBy: new Map(), original: new Map(), seen: new Set() };
		// The same object read again keeps the values it held before any record.
		if (held.entry === entry) return isLineAtOrAfter(at, held.at) ? { ...held, at, setBy: new Map() } : undefined;
		const line = JSON.stringify(entry);
		const heldLine = lineOf(held);
		const reread = line === heldLine;
		if (!reread) {
			if (held.seen.has(line)) return undefined;
			if (!isLineAtOrAfter(at, held.at)) {
				held.seen.add(line);
				return undefined;
			}
			held.seen.add(heldLine);
		}
		if (this.#restore(held)) changed.add(held.entry);
		// The held line read again stays where it lies; a later line becomes the last with the id.
		return { entry, at: reread ? held.at : at, setBy: new Map(), original: new Map(), seen: held.seen };
	}

	#apply(held: HeldTarget<E>, id: string, { patch, order, recordId }: HeldPatch, changed: Set<E>): void {
		const { entry: target, setBy, original } = held;
		if (!entryAcceptsPatch(target, patch)) {
			this.#hooks.onSkip?.({ reason: "misfit", recordId, entryId: id });
			return;
		}
		const take = (field: PatchField): boolean => {
			const prior = setBy.get(field);
			// A field a patch later in the file set keeps that patch's value.
			if (prior && isAtOrAfter(prior, order)) return false;
			if (!original.has(field)) {
				const place = fieldPlace(target, field);
				const own = place && Object.getOwnPropertyDescriptor(place.holder, place.key);
				original.set(field, own ? own.value : ABSENT);
			}
			setBy.set(field, order);
			return true;
		};
		if (writeFields(target, patch, this.#hooks, take)) changed.add(target);
	}

	/** Set back on `held`'s entry each field a record set to the value it held before; whether any was set back. */
	#restore(held: HeldTarget<E>): boolean {
		for (const [field, value] of held.original) {
			const place = fieldPlace(held.entry, field);
			if (!place) continue;
			if (value === ABSENT) delete place.holder[place.key];
			else place.holder[place.key] = value;
			if (field === "message.content") this.#hooks.onMessageContentSet?.(held.entry);
		}
		return held.original.size > 0;
	}
}
