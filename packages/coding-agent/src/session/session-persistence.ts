import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { countNewlines, isRecord } from "@oh-my-pi/pi-utils";
import { PRESERVE_KEY as SNAPCOMPACT_PRESERVE_KEY } from "@oh-my-pi/snapcompact";
import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";
/** Parent key under which snapcompact persists its base64 PNG frame archive
 *  (`preserveData.snapcompact.frames[]`). Frame objects are image payloads, so
 *  their base64 must externalize to the blob store rather than fall through to
 *  generic string truncation, which appends {@link TRUNCATION_NOTICE} and
 *  corrupts the base64 the provider decodes on resume. */
const SNAPCOMPACT_FRAMES_KEY = "frames";

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	if (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			truncated = truncated.slice(0, -1);
		}
	}
	return truncated;
}

/** Detect strings damaged by an older persistence pass so loaders can migrate them safely. */
export function isPersistenceTruncatedString(value: unknown): value is string {
	return typeof value === "string" && value.endsWith(TRUNCATION_NOTICE);
}

/**
 * The number of prototype hops a chain walk may take before it answers
 * "unknown". A real prototype chain is a handful of links long; a longer one
 * can only come from a proxy that fabricates its own ancestors — and a walk
 * that keeps following such a chain never ends.
 */
export const MAX_PROTOTYPE_CHAIN_DEPTH = 64;

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null) return false;
	// An own enumerable accessor-backed `type` may yield `"image"`, and the
	// projector cannot know without running it — so the block is treated as
	// image-shaped. The alternative truncates the base64 as a generic string,
	// and the resumed session then carries an undecodable image.
	const type = projectorImageFieldPresence(value, "type");
	if (type === "opaque") {
		const data = projectorImageFieldPresence(value, "data");
		return data === "string" || data === "opaque";
	}
	if (type !== "string" || projectorImageField(value, "type") !== "image") return false;
	// An accessor-backed `data` is still an image payload: the projector reads
	// it once, when it externalizes the base64, exactly where the serializer
	// would have read it. Leaving it inline would truncate the base64 and lose
	// the image on resume.
	const data = projectorImageFieldPresence(value, "data");
	return data === "string" || data === "opaque";
}

/**
 * The `key` field of an image-shaped value as the projector accepts it —
 * through the prototype chain, but only from a string-valued data descriptor.
 * Answered without invoking anything: an accessor anywhere on the chain yields
 * `undefined` rather than running user code, so a stateful getter keeps the
 * value out of the blob store instead of shifting what serialization observes.
 *
 * The descriptor walk itself is guarded: `Object.getOwnPropertyDescriptor` on a
 * proxy runs its trap, which can throw. `JSON.stringify` consults descriptors
 * only for keys `ownKeys` reported, so a proxy whose `ownKeys` stays quiet
 * serializes as `{}` while this direct lookup throws — an escape from
 * `prepareEntryForPersistence` that fails the whole write for a value
 * serialization accepts. A throw anywhere on the walk therefore answers "no
 * classifier here": the payload stays inline instead of externalized, which is
 * a size regression on an exotic shape, not a lost session. The prototype step
 * is guarded for the same reason: `Object.getPrototypeOf` is a trap too, and a
 * proxy can keep its descriptor answers quiet while throwing there.
 */
export function projectorImageField(value: object, key: "data" | "mimeType" | "type"): string | undefined {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return undefined;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, key);
		} catch {
			return undefined;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return undefined;
			return typeof descriptor.value === "string" ? descriptor.value : undefined;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return undefined;
		}
		current = next;
	}
	return undefined;
}

/**
 * Whether an image-shaped value carries `key`, and whether its value is
 * knowable without running user code: `"string"` for a string-valued data
 * descriptor anywhere on the chain, `"opaque"` for an accessor, `"absent"`
 * otherwise.
 *
 * The projector externalizes an image payload by reading it, so an
 * accessor-backed `data` is still an image payload — the getter runs once, at
 * projection time, exactly where the serializer would have read it. The memo
 * cannot read it, so it leaves such graphs uncached instead of stamping a
 * value it never saw (see `hasSerializerHook` in session-manager.ts).
 */
export type ProjectorImageField = "absent" | "string" | "opaque";

export function projectorImageFieldPresence(value: object, key: "data" | "mimeType" | "type"): ProjectorImageField {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return "absent";
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, key);
		} catch {
			return "absent";
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
				// An own enumerable accessor is part of the serialized graph —
				// `JSON.stringify` reads it — so the projector may read it too.
				// An inherited or non-enumerable one is not: reading it would run
				// user code for a value no serialization observes.
				return current === value && descriptor.enumerable ? "opaque" : "absent";
			}
			return typeof descriptor.value === "string" ? "string" : "absent";
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return "absent";
		}
		current = next;
	}
	return "absent";
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	if (typeof value !== "object" || value === null) return false;
	const data = projectorImageFieldPresence(value, "data");
	if (data !== "string" && data !== "opaque") return false;
	if (isImageBlock(value)) return true;
	const mimeType = projectorImageFieldPresence(value, "mimeType");
	if (mimeType === "opaque") return true;
	if (mimeType !== "string") return false;
	// The presence is not the value: a payload whose `mimeType` is an image
	// type is an image payload even when it carries no `type` marker of its
	// own — the snapcompact frames are exactly that shape, and their base64
	// must externalize to the blob store instead of falling through to the
	// generic string truncation, which corrupts the base64 the provider
	// decodes on resume. The value is read through the descriptor, so an
	// accessor is never run.
	const mimeTypeValue = projectorImageField(value, "mimeType");
	return mimeTypeValue !== undefined && isImageMimeType(mimeTypeValue);
}

/**
 * True when an image payload sits in a persistence position whose base64 is
 * externalized to the blob store instead of truncated as a generic string: a
 * `content` image block, an `images[]` entry, or a snapcompact frame under
 * `frames[]`. The eager load path uses the same position check but deliberately
 * leaves snapcompact frames as references for lazy context rebuilding.
 */
export function isExternalizableImagePosition(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images" || key === SNAPCOMPACT_FRAMES_KEY;
}

function shouldExternalizeImagePayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isExternalizableImagePosition(value, key)) return false;
	// Read the payload once: an accessor-backed `data` is read by the getter,
	// and a stateful one would hand the length check and the externalization
	// two different values.
	const data = value.data;
	if (isBlobRef(data) || data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return true;
}

/** True for a non-empty string — marks signature/encrypted fields whose block must persist verbatim. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

interface ExternalizedImage {
	readonly data: string;
	readonly mimeType: string | undefined;
	readonly ref: string;
}

/**
 * Blob refs already minted for live image payload objects, per blob store.
 * The persisted copy of an entry is structurally shared while the in-memory
 * entry keeps its base64, so without this every full rewrite would decode,
 * hash, and stat every image in the session again. A hit requires the
 * payload's current data and mime type, so a payload mutated in place is
 * externalized afresh; keying by store keeps a ref minted into one blob dir
 * from being reused for another.
 */
const externalizedImageRefs = new WeakMap<BlobStore, WeakMap<object, ExternalizedImage>>();

function externalizeImagePayloadSync(
	blobStore: BlobStore,
	payload: object,
	data: string,
	mimeType: string | undefined,
): string {
	let refs = externalizedImageRefs.get(blobStore);
	const cached = refs?.get(payload);
	if (cached && cached.data === data && cached.mimeType === mimeType) return cached.ref;
	const ref = externalizeImageDataSync(blobStore, data, mimeType);
	if (!refs) {
		refs = new WeakMap();
		externalizedImageRefs.set(blobStore, refs);
	}
	refs.set(payload, { data, mimeType, ref });
	return ref;
}

/**
 * Drop every image ref remembered for `blobStore`, so the next persist checks
 * each blob on disk again. Call when a session write failed: a ref whose line
 * never reached a session file is unreferenced, so `omp gc` may collect its blob.
 */
export function forgetExternalizedImages(blobStore: BlobStore): void {
	externalizedImageRefs.delete(blobStore);
}

/** True for the snapcompact archive slot, `preserveData[PRESERVE_KEY]`. */
export function isSnapcompactArchiveSlot(
	key: string | undefined,
	childKey: string,
	value: unknown,
): value is Record<string, unknown> {
	return key === "preserveData" && childKey === SNAPCOMPACT_PRESERVE_KEY && isRecord(value);
}

/**
 * One field of the archive, as the own-key stamp can see it: whether the
 * field is stampable at all, and the value the stamp would record.
 */
interface ArchiveField {
	readonly stampable: boolean;
	readonly value: unknown;
}

const ARCHIVE_FIELD_ABSENT: ArchiveField = { stampable: true, value: undefined };
const ARCHIVE_FIELD_HIDDEN: ArchiveField = { stampable: false, value: undefined };

/**
 * The archive field as the own-key stamp sees it: absent, or an own
 * enumerable data property. A field that rides an inherited link, an own
 * non-enumerable descriptor, or an accessor is read by the archive rebuild
 * but never recorded by the stamp — so a change behind it would leave the
 * stamp equal and the rewrite would reuse a line the next rebuild would not
 * produce.
 *
 * Answered through descriptors, never by reading the key: a proxy's traps can
 * throw, and a throw must not escape the probe into the persistence path.
 */
function archiveField(archive: Record<string, unknown>, key: string): ArchiveField {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(archive, key);
	} catch {
		return ARCHIVE_FIELD_HIDDEN;
	}
	if (descriptor === undefined) {
		// An inherited field is read by the rebuild (`archive.frames` follows
		// the prototype chain) and never recorded by the own-key stamp.
		let inherited: boolean;
		try {
			inherited = key in archive;
		} catch {
			return ARCHIVE_FIELD_HIDDEN;
		}
		return inherited ? ARCHIVE_FIELD_HIDDEN : ARCHIVE_FIELD_ABSENT;
	}
	if (!descriptor.enumerable) return ARCHIVE_FIELD_HIDDEN;
	if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return ARCHIVE_FIELD_HIDDEN;
	return { stampable: true, value: descriptor.value };
}

/**
 * Whether the own-key stamp can describe the snapcompact archive.
 *
 * `persistSnapcompactArchive` keeps every field but the frames verbatim — so
 * a transient key inside the archive reaches the line, and the stamp has to
 * record it whole rather than by presence — and it reads the frames and the
 * `withoutThinking` view by key, recursing into the nested archive the view
 * carries. Every field that read has to be one the own-key stamp sees, at
 * every level of the archive; a field it cannot see leaves the archive
 * uncached, so the line is always re-projected from the live archive.
 */
export function snapcompactArchiveStampable(archive: Record<string, unknown>): boolean {
	const frames = archiveField(archive, "frames");
	if (!frames.stampable) return false;
	const view = archiveField(archive, "withoutThinking");
	if (!view.stampable) return false;
	if (!isRecord(view.value)) return true;
	const nested = archiveField(view.value, "archive");
	if (!nested.stampable) return false;
	if (!isRecord(nested.value)) return true;
	return snapcompactArchiveStampable(nested.value);
}

/**
 * The snapcompact archive under `preserveData[PRESERVE_KEY]`: its frames
 * externalize to the blob store, and every other field persists verbatim. The
 * next compaction re-renders the archive from `text`, so a cut would drop the
 * newest history uncounted and render {@link TRUNCATION_NOTICE} into the frames.
 */
function persistSnapcompactArchive(archive: Record<string, unknown>, blobStore: BlobStore): Record<string, unknown> {
	const frames = truncateForPersistence(archive.frames, blobStore, SNAPCOMPACT_FRAMES_KEY);
	const persisted = frames === archive.frames ? archive : { ...archive, frames };
	const view = archive.withoutThinking;
	if (!isRecord(view) || !isRecord(view.archive)) return persisted;
	const viewArchive = persistSnapcompactArchive(view.archive, blobStore);
	return viewArchive === view.archive
		? persisted
		: { ...persisted, withoutThinking: { ...view, archive: viewArchive } };
}

function snapcompactArchiveNeedsRewrite(archive: Record<string, unknown>): boolean {
	if (persistenceNodeNeedsRewrite(archive.frames, SNAPCOMPACT_FRAMES_KEY)) return true;
	const view = archive.withoutThinking;
	return isRecord(view) && isRecord(view.archive) && snapcompactArchiveNeedsRewrite(view.archive);
}

/**
 * Keys `truncateForPersistence` strips from the projected graph at every
 * depth: transient data that must never reach a persisted line — `jsonlEvents`
 * are raw subprocess streaming events, already saved to artifact files.
 *
 * The entry-line memo's stamp walks exactly the projected graph (the graph
 * `stringifyJson` serializes), so it skips these keys too — see
 * `messageValueStamp` in session-manager.ts. Sharing the list is what keeps the
 * stamp from walking a field persistence drops: a streaming-shaped cycle under
 * `jsonlEvents` is persistable today, and walking it would never terminate.
 */
export const TRANSIENT_PERSISTENCE_KEYS: readonly string[] = ["jsonlEvents"];

/**
 * Recursively truncate large strings in an object for session persistence.
 * - Truncates oversized string fields (key-agnostic), except signed/encrypted
 *   blocks and signature keys, which persist verbatim
 * - Externalizes oversized image payloads to blob refs
 * - Updates lineCount when content is truncated
 * - Returns original object if no changes needed (structural sharing)
 *
 * Runs in one synchronous tick so an OOM/SIGKILL landing right after a persist
 * call returns cannot lose the entry. Image externalization happens via the
 * synchronous blob-store path (`fs.writeFileSync`), so blob bytes are in the
 * kernel page cache before the JSONL line referencing them is written.
 */
function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (
		typeof obj === "object" &&
		"type" in obj &&
		obj.type === "image_generation_call" &&
		"result" in obj &&
		typeof obj.result === "string" &&
		!isBlobRef(obj.result) &&
		obj.result.length >= BLOB_EXTERNALIZE_THRESHOLD
	) {
		return { ...obj, result: externalizeImagePayloadSync(blobStore, obj, obj.result, undefined) };
	}
	if (shouldExternalizeImagePayload(obj, key)) {
		return { ...obj, data: externalizeImagePayloadSync(blobStore, obj, obj.data, obj.mimeType) };
	}
	// Signed content is bound to its exact bytes: a truncated `thinking`/`text`/
	// `arguments` no longer matches its signature and a truncated
	// `redacted_thinking` blob is undecryptable, so the provider 400s the replay.
	// Persist signed blocks verbatim — never truncate, externalize, or descend.
	// Unsigned blocks (e.g. an interrupted stream) have no such binding and stay
	// truncatable for size control.
	// Anthropic validates native web-search and tool-search history byte-for-byte
	// on replay. Keep the complete typed block atomic, including opaque content.
	if (typeof obj === "object" && "type" in obj && obj.type === "anthropicServerTool" && "block" in obj) {
		const block = obj.block;
		if (typeof block === "object" && block !== null && "type" in block && typeof block.type === "string") {
			const validationView = {
				type: block.type,
				...("name" in block ? { name: block.name } : {}),
				...("id" in block ? { id: block.id } : {}),
				...("tool_use_id" in block ? { tool_use_id: block.tool_use_id } : {}),
				...("content" in block ? { content: block.content } : {}),
			};
			if (isAnthropicServerToolHistoryBlock(validationView)) return obj;
		}
	}
	// Anthropic server-side compaction replay state: `encrypted_content` is
	// opaque provider state the API validates byte-for-byte on replay, so the
	// carrier persists atomically with its summary and metadata — both as a
	// message `providerPayload` (`type: "anthropicCompaction"`) and under the
	// preserveData slot, whose object carries no `type` marker of its own.
	// Cursor server records are addressed by the SHA-256 of their bytes and carry
	// signed reasoning, so they persist atomically too.
	if (
		typeof obj === "object" &&
		obj !== null &&
		(("type" in obj && (obj.type === "anthropicCompaction" || obj.type === "cursorHistory")) ||
			(key === "anthropicCompaction" && "content" in obj && typeof obj.content === "string"))
	) {
		return obj;
	}
	if (typeof obj === "object" && "type" in obj) {
		const signed =
			(obj.type === "thinking" && "thinkingSignature" in obj && isNonEmptyString(obj.thinkingSignature)) ||
			(obj.type === "text" && "textSignature" in obj && isNonEmptyString(obj.textSignature)) ||
			(obj.type === "toolCall" && "thoughtSignature" in obj && isNonEmptyString(obj.thoughtSignature));
		const redacted = obj.type === "redactedThinking" && "data" in obj && isNonEmptyString(obj.data);
		// OpenAI Responses reasoning items (providerPayload.items) carry
		// `encrypted_content`, server-validated on replay — atomic like signed blocks.
		const encryptedReasoning =
			obj.type === "reasoning" && "encrypted_content" in obj && isNonEmptyString(obj.encrypted_content);
		if (signed || redacted || encryptedReasoning) return obj;
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_PERSIST_CHARS) {
			// Defensive: signature keys normally sit on blocks the guard above returns
			// verbatim, but if one is reached here (unknown carrier shape), preserve it —
			// truncation produces an invalid signature the API rejects, and clearing
			// drops reasoning context the provider needs on replay.
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return obj;
			}
			const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
			return `${truncateString(obj, limit)}${TRUNCATION_NOTICE}`;
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = truncateForPersistence(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		// Two-phase: first a no-allocation scan for the only things that can
		// change (jsonlEvents presence, oversized/image/signature strings).
		// The common persisted entry is already clean and returns here with
		// zero array/tuple allocation; only a dirty node pays for the rebuild.
		//
		// The scan gets the key the rebuild hands this node: the snapcompact
		// archive is only recognized by the key it sits under, so a scan
		// without it walked into the archive generically — and an archive
		// whose frames ride a hidden field then looked clean, so the rebuild
		// never ran and the frames were dropped from the line.
		if (!persistenceNodeNeedsRewrite(obj, key)) return obj;
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		// Own enumerable keys, enumerated directly instead of through
		// `for..in`: the inherited keys `for..in` yields were dropped by the
		// own-key filter this replaces, while the prototype walk itself is a
		// step a proxy's `getPrototypeOf` trap can fail on — and
		// `JSON.stringify`, which reads own keys only, stays quiet on the
		// same value. A write the serializer completes must not fail here.
		for (const childKey of Object.keys(obj)) {
			// Strip transient/redundant properties that shouldn't be persisted.
			// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
			// The key is tested before the value is read: the field never reaches
			// the line, so reading it would run a getter the persisted bytes do
			// not depend on — and a stateful one would shift the sibling fields
			// the line does record.
			if (TRANSIENT_PERSISTENCE_KEYS.includes(childKey)) {
				changed = true;
				continue;
			}
			const value = (obj as Record<string, unknown>)[childKey];
			const newValue = isSnapcompactArchiveSlot(key, childKey, value)
				? persistSnapcompactArchive(value, blobStore)
				: truncateForPersistence(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			// Same count as `content.split("\n").length` without the array.
			const lineCount = countNewlines(contentEntry[1]) + 1;
			const updatedEntries = entries.map(([childKey, value]) =>
				childKey === "lineCount" ? ([childKey, lineCount] as const) : ([childKey, value] as const),
			);
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

/**
 * Whether this node can possibly change under `truncateForPersistence`:
 * carries `jsonlEvents`, an oversized or image-position string, or (for
 * objects) any child that can. Mirrors the change conditions of the rebuild
 * pass exactly — a false negative silently keeps oversized content, so when
 * in doubt this must return true.
 *
 * The walk is an explicit worklist, not recursion: `details` is the tool
 * result's opaque slot and can hold a graph nested arbitrarily deep, and one
 * JS frame per level overflowed the stack on such input (~20k levels) — a
 * persistence failure on a graph serialization handles fine.
 *
 * The children are read one at a time, in the order the rebuild pass reads
 * them, and the scan stops at the first dirty child — the semantics the
 * former recursive scan had. Reading them eagerly instead (every sibling
 * before any child is tested) runs a later sibling's own enumerable getter
 * even when an earlier child already decided the answer, so the getter runs
 * once more than the single rebuild serialization it belongs to, and the
 * persisted details advance twice. So the order the worklist visits nodes in
 * IS observable, and the walk keeps the rebuild's order.
 *
 * A back-reference that the projection does NOT strip (`jsonlEvents` and the
 * spilled `structuredContent` are stripped before this walk, so their cycles
 * are never visited) makes the live graph circular. `JSON.stringify` rejects
 * such a graph with a `TypeError`, which the caller surfaces as a persistence
 * failure; this scan must not instead re-enqueue the same object forever, so a
 * node already on the walk's path is skipped. Skipping is sound: the node's
 * subtree was already scanned for the same change conditions when it was
 * first pushed, and the scan answers only "can this change".
 */
function persistenceNodeNeedsRewrite(obj: unknown, key?: string): boolean {
	// Iterative, not recursive — one JS stack frame per level overflowed on a
	// graph `details` can hold (see above).
	type ScanFrame =
		| { readonly kind: "value"; readonly value: unknown; readonly key: string | undefined }
		/**
		 * A container's own children, walked one at a time. The child is read
		 * when the frame reaches it, not when the siblings are queued: the
		 * value read is a getter run, and a getter that only the rebuild
		 * serialization should run must not run here as well.
		 */
		| {
				readonly kind: "children";
				readonly container: object;
				readonly keys: readonly string[];
				index: number;
				readonly key: string | undefined;
		  }
		/** An array's indexed slots, walked one at a time, in index order. */
		| {
				readonly kind: "slots";
				readonly container: readonly unknown[];
				readonly length: number;
				index: number;
				readonly key: string | undefined;
		  }
		/** Ends a container's visit and takes it off the active path. */
		| { readonly kind: "exit"; readonly value: object };
	const pending: ScanFrame[] = [{ kind: "value", value: obj, key }];
	// The objects currently on the walk path. A cycle re-encountering one of
	// them is skipped rather than queued again (see above). A set answers that
	// question in constant time; walking the ancestor chain instead made a
	// deep acyclic graph quadratic.
	const activePath = new Set<object>();
	for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		if (frame.kind === "exit") {
			activePath.delete(frame.value);
			continue;
		}
		if (frame.kind === "children") {
			if (frame.index >= frame.keys.length) {
				// The container's visit is over: take it off the active path.
				pending.push({ kind: "exit", value: frame.container });
				continue;
			}
			const childKey = frame.keys[frame.index++];
			// The value is read HERE — when this child is about to be tested —
			// not when the siblings were queued. A sibling after a dirty child
			// is never read at all, so its own enumerable getter does not run
			// before the rebuild serialization that owns it.
			const childValue = (frame.container as Record<string, unknown>)[childKey];
			// The snapcompact archive is rebuilt by `persistSnapcompactArchive`,
			// not the generic path, so only its frames decide a rewrite.
			if (isSnapcompactArchiveSlot(frame.key, childKey, childValue)) {
				if (snapcompactArchiveNeedsRewrite(childValue)) return true;
				continue;
			}
			// The container's remaining children wait below this child's own
			// subtree, so the walk stays in key order.
			pending.push(frame);
			pending.push({ kind: "value", value: childValue, key: childKey });
			continue;
		}
		if (frame.kind === "slots") {
			if (frame.index >= frame.length) {
				pending.push({ kind: "exit", value: frame.container as object });
				continue;
			}
			const index = frame.index++;
			const slotValue = frame.container[index];
			pending.push(frame);
			pending.push({ kind: "value", value: slotValue, key: frame.key });
			continue;
		}
		const { value, key } = frame;
		if (value === null || value === undefined) continue;
		if (typeof value === "string") {
			if (
				value.length > MAX_PERSIST_CHARS &&
				key !== "thinkingSignature" &&
				key !== "thoughtSignature" &&
				key !== "textSignature"
			)
				return true;
			if (key === "image_url" && isImageDataUrl(value)) return true;
			continue;
		}
		// A node already on this path closes a cycle. Its subtree was scanned when
		// it was first pushed, so re-walking it would only repeat work — and a
		// self-reference would repeat it forever. Only objects can close a cycle,
		// so only they join the path.
		if (typeof value === "object") {
			if (activePath.has(value)) continue;
			activePath.add(value);
		}
		if (Array.isArray(value)) {
			// Indexed slots with a snapshotted length, the way `JSON.stringify` and
			// the rebuild above read them — never the iterator protocol, which an
			// overridden `Symbol.iterator` can hide slots from. The slots are read
			// one at a time, in index order, so a slot after a dirty one is never
			// read by this scan.
			const length = value.length;
			pending.push({ kind: "slots", container: value, length, index: 0, key });
			continue;
		}
		if (typeof value === "object") {
			// Transient keys are always stripped by the rebuild pass, so their
			// presence alone forces the walk that drops them.
			for (const transientKey of TRANSIENT_PERSISTENCE_KEYS) {
				if (transientKey in value) return true;
			}
			// Externalize shapes rewrite (not verbatim): check before the
			// atomic/verbatim classification below.
			if ("type" in value) {
				const typed = value as Record<string, unknown>;
				if (
					typed.type === "image_generation_call" &&
					"result" in typed &&
					typeof typed.result === "string" &&
					!isBlobRef(typed.result) &&
					typed.result.length >= BLOB_EXTERNALIZE_THRESHOLD
				) {
					return true;
				}
			}
			if (shouldExternalizeImagePayload(value, key)) return true;
			if (isAtomicPersistenceNode(value, key)) {
				// The node persists verbatim: it is not descended into, so it
				// leaves the active path again straight away.
				activePath.delete(value);
				continue;
			}
			// Own enumerable keys, enumerated directly — see the rebuild loop
			// in `truncateForPersistence` for why `for..in`'s prototype walk
			// is a step a thrown `getPrototypeOf` trap fails. The keys are
			// listed here, but each value is read when its frame reaches it.
			pending.push({ kind: "children", container: value, keys: Object.keys(value), index: 0, key });
		}
	}
	return false;
}

/**
 * True for nodes `truncateForPersistence` returns verbatim without
 * descending past the image/blob guards: anthropic server-tool/compaction
 * carriers and signed/encrypted blocks. The entry-line memo's stamp mirrors
 * this boundary — transient keys are stripped only on the recursion side —
 * so it must stay in sync with the early-return guards above the recursion.
 */
export function isAtomicPersistenceNode(obj: object, key?: string): boolean {
	return classifyAtomicPersistenceNode(obj, key, PROJECTOR_ATOMIC_FIELDS);
}

/**
 * The atomic verdict as the entry-line memo reproduces it: own enumerable
 * data fields only, so the probe never invokes user code.
 *
 * The projector reads its carriers by key — following the prototype chain and
 * running an accessor — so the memo's answer only agrees with the projector's
 * where the carrier is an own enumerable data field (or a field no link on
 * the chain carries at all). The memo proves that with its visibility gate
 * before it stamps a graph, and leaves the graph uncached when it cannot, so
 * the two answers never disagree where the verdict decides the projected
 * bytes. A memo answer of "not atomic" against a projector's "atomic" is the
 * safe direction: the stamp then records leaves the projector keeps verbatim,
 * which costs a re-projection, never a stale line.
 */
export function isAtomicPersistenceNodeOwnFields(obj: object, key?: string): boolean {
	return classifyAtomicPersistenceNode(obj, key, OWN_ATOMIC_FIELDS);
}

/**
 * The fields the atomic classification consults for a node whose own `type`
 * marker is `type`, and — for the typeless `anthropicCompaction` carrier —
 * its `content`.
 *
 * The list is brand-specific on purpose: the classification decides whether
 * the node persists verbatim, so every carrier it reads decides whether a
 * long string inside it is preserved or truncated. A carrier the own-key
 * stamp cannot see — inherited, own non-enumerable, or an accessor — flips
 * the verdict without moving a stamped leaf, so the memo's visibility gate
 * has to name exactly the carriers this brand reads and no others.
 */
export function atomicPersistenceCarrierKeys(type: unknown, key: string | undefined): readonly string[] {
	const carriers: string[] = [];
	// The typeless `anthropicCompaction` carrier is signed by its `content`,
	// and that check is independent of the node's own `type` marker.
	if (key === "anthropicCompaction") carriers.push("content");
	switch (type) {
		case "thinking":
			carriers.push("thinkingSignature");
			break;
		case "text":
			carriers.push("textSignature");
			break;
		case "toolCall":
			carriers.push("thoughtSignature");
			break;
		case "redactedThinking":
			carriers.push("data");
			break;
		case "reasoning":
			carriers.push("encrypted_content");
			break;
		case "anthropicServerTool":
			carriers.push("block");
			break;
		default:
			break;
	}
	return carriers;
}

/**
 * The fields the `anthropicServerTool` classification reads on the nested
 * block. The verdict depends on the block's own `type` marker and on the
 * presence and value of its optional fields, so each of them decides the
 * atomic verdict exactly like the node's own carriers do.
 */
export const ANTHROPIC_SERVER_TOOL_BLOCK_FIELDS = ["type", "name", "id", "tool_use_id", "content"] as const;

/**
 * A field the atomic classification could not read: absent, or present behind
 * a descriptor the reader refuses to invoke.
 */
const ATOMIC_FIELD_ABSENT = Symbol("atomic.field.absent");

/**
 * How the atomic classification reads a field. The projector reads by key —
 * following the prototype chain and running an accessor — because that is
 * what its own guards do. The memo reads own enumerable data fields only, so
 * its probe never invokes user code.
 */
type AtomicFieldReader = (obj: object, key: string) => unknown;

/** The projector's own field access: by key, chain-following, accessor-running. */
const PROJECTOR_ATOMIC_FIELDS: AtomicFieldReader = (obj, key) =>
	key in obj ? (obj as Record<string, unknown>)[key] : ATOMIC_FIELD_ABSENT;

/**
 * The memo's field access: own enumerable data fields only. A field the
 * reader cannot see answers "absent" — the memo's visibility gate leaves the
 * whole graph uncached in that case, so the two readers never disagree where
 * the classification depends on the answer. The descriptor call is guarded:
 * it runs a proxy's trap, which can throw.
 */
const OWN_ATOMIC_FIELDS: AtomicFieldReader = (obj, key) => {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(obj, key);
	} catch {
		return ATOMIC_FIELD_ABSENT;
	}
	if (descriptor === undefined) return ATOMIC_FIELD_ABSENT;
	if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return ATOMIC_FIELD_ABSENT;
	return descriptor.value;
};

/** Whether the field the reader returned is a non-empty string. */
function isNonEmptyAtomicField(field: unknown): boolean {
	return field !== ATOMIC_FIELD_ABSENT && typeof field === "string" && field.length > 0;
}

/** The optional block field, spread into the validation view when present. */
function optionalAtomicField(
	block: Record<string, unknown>,
	key: string,
	read: AtomicFieldReader,
): Record<string, unknown> {
	const value = read(block, key);
	return value === ATOMIC_FIELD_ABSENT ? {} : { [key]: value };
}

/**
 * The shared atomic classification, read through `read`.
 *
 * The projector and the memo answer the same question — does this node
 * persist verbatim? — and must agree: a node the memo calls atomic while the
 * projector calls it a generic container hides the truncation the projector
 * applies to the strings inside it, and the memo would then reuse a line the
 * projector no longer produces.
 */
function classifyAtomicPersistenceNode(obj: object, key: string | undefined, read: AtomicFieldReader): boolean {
	// NOTE: image_generation_call results and externalizable image payloads
	// are NOT atomic — truncateForPersistence rewrites them via the blob
	// store. They are checked explicitly in the predicate and must never be
	// classified here.
	// The preserveData compaction carrier has no `type` marker of its own, so
	// its key-based case sits outside the type guard below — mirroring the
	// projection's early return, which checks the key without requiring one.
	const untyped = obj as Record<string, unknown>;
	if (key === "anthropicCompaction") {
		const content = read(untyped, "content");
		if (content !== ATOMIC_FIELD_ABSENT && typeof content === "string") return true;
	}
	const type = read(untyped, "type");
	if (type === ATOMIC_FIELD_ABSENT) return false;
	// Mirror the truncate guard exactly: only a block that passes
	// isAnthropicServerToolHistoryBlock is atomic. An interrupted,
	// corrupt, or forward-version block that FAILS validation falls
	// through here (and in the main function) into the generic
	// recursion, so oversized strings and jsonlEvents inside it are
	// still truncated/stripped instead of bypassing size controls.
	if (type === "anthropicServerTool") {
		const block = read(untyped, "block");
		if (block === ATOMIC_FIELD_ABSENT) return false;
		if (typeof block !== "object" || block === null) return false;
		const blockType = read(block, "type");
		if (blockType === ATOMIC_FIELD_ABSENT || typeof blockType !== "string") return false;
		const asBlock = block as Record<string, unknown>;
		const validationView = {
			type: blockType,
			...optionalAtomicField(asBlock, "name", read),
			...optionalAtomicField(asBlock, "id", read),
			...optionalAtomicField(asBlock, "tool_use_id", read),
			...optionalAtomicField(asBlock, "content", read),
		};
		return isAnthropicServerToolHistoryBlock(validationView);
	}
	if (type === "anthropicCompaction" || type === "cursorHistory") return true;
	const signed =
		(type === "thinking" && isNonEmptyAtomicField(read(untyped, "thinkingSignature"))) ||
		(type === "text" && isNonEmptyAtomicField(read(untyped, "textSignature"))) ||
		(type === "toolCall" && isNonEmptyAtomicField(read(untyped, "thoughtSignature")));
	const redacted = type === "redactedThinking" && isNonEmptyAtomicField(read(untyped, "data"));
	const encryptedReasoning = type === "reasoning" && isNonEmptyAtomicField(read(untyped, "encrypted_content"));
	return signed || redacted || encryptedReasoning;
}

/**
 * Read the duplication-relevant fields of an OpenAI Responses reasoning item.
 * Returns `undefined` for anything that is not a `type: "reasoning"` object, so
 * non-reasoning payload entries and corrupt signatures are never matched.
 */
function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

/**
 * True when a `thinkingSignature` (a JSON-encoded reasoning item) is already
 * carried by a reasoning item in the message's provider payload — matched on
 * `encrypted_content` (the load-bearing blob) when present, else on item `id`.
 * A signature the payload does not cover is never reported as recoverable, so it
 * is always kept.
 */
function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/**
 * Drop `thinkingSignature` from assistant thinking blocks whose reasoning item is
 * already carried, verbatim, in the message's OpenAI Responses `providerPayload`.
 *
 * Responses/Codex turns mint each reasoning item once and store it twice:
 * `providerPayload.items` (the authoritative native-history copy that replay and
 * remote compaction read) and `content[].thinkingSignature`, which is literally
 * `JSON.stringify(reasoningItem)` — including the large `encrypted_content` blob.
 * Replay only ever reads the payload; the signature is a no-payload fallback that
 * same-provider turns never reach and cross-model turns strip as untrustworthy.
 * Persisting both stores the encrypted reasoning twice for zero token or replay
 * benefit, so the on-disk copy drops the duplicate signature whenever its
 * reasoning item is recoverable from the payload. The in-memory entry is left
 * untouched; only the serialized line is slimmed.
 */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

/**
 * Spilled MCP text already includes the rendered structured payload in its
 * artifact. Keep the live object for eval, but omit the duplicate from the
 * serialized top-level tool result. Never mutate the in-memory message.
 */
function stripSpilledMcpStructuredContent(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
	const details = entry.message.details;
	if (
		!isRecord(details) ||
		typeof details.serverName !== "string" ||
		typeof details.mcpToolName !== "string" ||
		!Object.hasOwn(details, "structuredContent") ||
		!isRecord(details.meta) ||
		!isRecord(details.meta.truncation) ||
		typeof details.meta.truncation.artifactId !== "string" ||
		details.meta.truncation.artifactId.length === 0
	) {
		return entry;
	}
	const persistedDetails = { ...details };
	delete persistedDetails.structuredContent;
	return { ...entry, message: { ...entry.message, details: persistedDetails } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	const projected = stripSpilledMcpStructuredContent(stripReplayedReasoningSignatures(entry));
	return truncateForPersistence(projected, blobStore) as FileEntry;
}
