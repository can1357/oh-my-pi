import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import {
	ContainerPath,
	countNewlines,
	DEEP_JSON_LEVELS,
	isNonNullObject,
	isRecord,
	type NestedWalk,
	runNested,
	stringifyDeepJson,
} from "@oh-my-pi/pi-utils";
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
/** Key of a provider image's URL (OpenAI `input_image`, computer-use screenshot); a data URL there is one blob. */
const IMAGE_URL_KEY = "image_url";

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

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
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

/** Whether `image`, base64, is no blob reference yet and long enough to externalize (a smaller image stays inline). */
function isExternalizableBase64(image: string): boolean {
	return !isBlobRef(image) && image.length >= BLOB_EXTERNALIZE_THRESHOLD;
}

/**
 * Where a node of a session entry holds an image a persisted line externalizes:
 * `data` or `result`, the field of an object node that holds the image's base64,
 * or `url`, a string node that is itself a data URL under `image_url`, stored whole.
 */
type ImageSite = "data" | "result" | "url";

/**
 * The {@link ImageSite} of `value`, a node under `key` of its holder (an array
 * element under its array's key, at any depth), whose image a persisted line
 * externalizes: a data URL under `image_url`, the `result` of a generated image
 * (`type: "image_generation_call"`), or the `data` of an image payload at an
 * image position ({@link isExternalizableImagePosition}).
 */
function externalizedImageSite(value: unknown, key: string | undefined): ImageSite | undefined {
	if (typeof value === "string") return key === IMAGE_URL_KEY && isImageDataUrl(value) ? "url" : undefined;
	if (typeof value !== "object" || value === null) return undefined;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isExternalizableBase64(value.result)
	) {
		return "result";
	}
	return isExternalizableImagePosition(value, key) && isExternalizableBase64(value.data) ? "data" : undefined;
}

/**
 * The node a persisted line holds for `value` when it externalizes the image
 * `value` holds ({@link externalizedImageSite}), with the image replaced by its
 * blob reference; undefined for any other value.
 */
function externalizeImageNode(value: unknown, blobStore: BlobStore, key: string | undefined): unknown {
	const site = externalizedImageSite(value, key);
	if (site === undefined) return undefined;
	if (site === "url") return externalizeImageDataUrlSync(blobStore, value as string);
	if (site === "result") {
		const generated = value as { result: string };
		return {
			...generated,
			result: externalizeImagePayloadSync(blobStore, generated, generated.result, undefined),
		};
	}
	const payload = value as { data: string; mimeType?: string };
	return { ...payload, data: externalizeImagePayloadSync(blobStore, payload, payload.data, payload.mimeType) };
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
function isSnapcompactArchiveSlot(
	key: string | undefined,
	childKey: string,
	value: unknown,
): value is Record<string, unknown> {
	return key === "preserveData" && childKey === SNAPCOMPACT_PRESERVE_KEY && isRecord(value);
}

/**
 * One walk of a value for persistence, a rebuild ({@link truncateNode}) or an
 * image externalization ({@link externalizedImagesNode}): its blob store, the
 * containers it is inside (a cycle fails), and the deepest level it reached,
 * which says whether the value nests past {@link DEEP_JSON_LEVELS}.
 */
interface PersistenceWalk {
	readonly blobStore: BlobStore;
	readonly path: ContainerPath;
	deepest: number;
}

/** What a rebuild learned of a value's shape: whether it nests past {@link DEEP_JSON_LEVELS}. */
interface PersistedShape {
	deep: boolean;
}

/**
 * What {@link persistenceScan} found of a value: nothing a persisted line
 * changes (`clean`), something it changes (`dirty`), or a level past
 * {@link PERSISTENCE_SCAN_DEPTH} that it did not scan (`deep`).
 */
type PersistenceScan = "clean" | "dirty" | "deep";

/**
 * Levels {@link persistenceScan} scans before it answers `deep` instead: far
 * deeper than an entry a session writes, far shallower than the call stack
 * allows, a worker thread's included.
 */
const PERSISTENCE_SCAN_DEPTH = 1_000;

/** A session line holds a bigint (an extension hook can put one in an entry) as its decimal string. */
const BIGINT_AS_STRING = { bigintAsString: true } as const;
/** {@link BIGINT_AS_STRING} for an entry the walk found nested past {@link DEEP_JSON_LEVELS} levels. */
const DEEP_BIGINT_AS_STRING = { bigintAsString: true, deep: true } as const;

/**
 * The snapcompact archive under `preserveData[PRESERVE_KEY]`: its frames
 * externalize to the blob store, and every other field persists verbatim. The
 * next compaction re-renders the archive from `text`, so a cut would drop the
 * newest history uncounted and render {@link TRUNCATION_NOTICE} into the frames.
 */
function* persistSnapcompactArchive(
	archive: Record<string, unknown>,
	walk: PersistenceWalk,
	depth: number,
	scan: boolean,
): NestedWalk<Record<string, unknown>> {
	walk.path.enter(archive);
	const source = archive.frames;
	let frames: unknown;
	if (!isNonNullObject(source)) frames = truncateLeaf(source, SNAPCOMPACT_FRAMES_KEY, walk.blobStore);
	else {
		const step = containerStep(source, SNAPCOMPACT_FRAMES_KEY, walk, depth + 1, scan);
		frames = step === undefined ? source : yield step;
	}
	let persisted = frames === source ? archive : { ...archive, frames };
	const view = archive.withoutThinking;
	if (isRecord(view) && isRecord(view.archive)) {
		const viewArchive = yield persistSnapcompactArchive(view.archive, walk, depth + 1, scan);
		if (viewArchive !== view.archive)
			persisted = { ...persisted, withoutThinking: { ...view, archive: viewArchive } };
	}
	walk.path.leave(archive);
	return persisted;
}

function snapcompactArchiveScan(archive: Record<string, unknown>, depth: number): PersistenceScan {
	if (depth >= PERSISTENCE_SCAN_DEPTH) return "deep";
	const frames = persistenceScan(archive.frames, SNAPCOMPACT_FRAMES_KEY, depth + 1);
	if (frames !== "clean") return frames;
	const view = archive.withoutThinking;
	return isRecord(view) && isRecord(view.archive) ? snapcompactArchiveScan(view.archive, depth + 1) : "clean";
}

/**
 * Truncate large strings in an object for session persistence.
 * - Truncates oversized string fields (key-agnostic), except signed/encrypted
 *   blocks and signature keys, which persist verbatim
 * - Externalizes oversized image payloads to blob refs
 * - Updates lineCount when content is truncated
 * - Returns original object if no changes needed (structural sharing)
 *
 * A scan that allocates nothing first finds the common entry clean
 * ({@link persistenceScan}); only a value it finds dirty, or deeper than it
 * scans, is rebuilt ({@link truncateNode}), on an explicit stack, so a value
 * of any depth `JSON.parse` reads is persisted. A subtree the scan finds
 * deeper than it scans is rebuilt without a scan of any node in it, so it
 * costs one pass, not a scan per level. With `shape`, a rebuild past
 * {@link DEEP_JSON_LEVELS} levels sets `shape.deep`.
 *
 * Runs in one synchronous tick so an OOM/SIGKILL landing right after a persist
 * call returns cannot lose the entry. Image externalization happens via the
 * synchronous blob-store path (`fs.writeFileSync`), so blob bytes are in the
 * kernel page cache before the JSONL line referencing them is written.
 */
function truncateForPersistence(value: unknown, blobStore: BlobStore, shape?: PersistedShape): unknown {
	if (!isNonNullObject(value)) return truncateLeaf(value, undefined, blobStore);
	const found = Array.isArray(value) ? "dirty" : persistenceScan(value);
	if (found === "clean") return value;
	const walk: PersistenceWalk = { blobStore, path: new ContainerPath(), deepest: 0 };
	const persisted = runNested(truncateNode(value, undefined, walk, 0, found === "dirty"));
	if (shape && walk.deepest > DEEP_JSON_LEVELS) shape.deep = true;
	return persisted;
}

/** {@link truncateNode} of `value`, no object, under `key` of its holder. */
function truncateLeaf(value: unknown, key: string | undefined, blobStore: BlobStore): unknown {
	if (typeof value !== "string") return value;
	const image = externalizeImageNode(value, blobStore, key);
	if (image !== undefined) return image;
	if (value.length <= MAX_PERSIST_CHARS) return value;
	// Defensive: signature keys normally sit on blocks the guard in truncateNode returns
	// verbatim, but if one is reached here (unknown carrier shape), preserve it —
	// truncation produces an invalid signature the API rejects, and clearing
	// drops reasoning context the provider needs on replay.
	if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
		return value;
	}
	const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
	return `${truncateString(value, limit)}${TRUNCATION_NOTICE}`;
}

/**
 * `obj`, under `key` of its holder at `depth` levels, as a persisted line holds
 * it, or `obj` itself when nothing in it changes. Each child that is an object
 * is a nested step ({@link runNested}) unless {@link containerStep} keeps it;
 * `scan` false (a scan found `obj` deeper than it scans) rebuilds every child
 * without scanning it.
 */
function* truncateNode(
	obj: object,
	key: string | undefined,
	walk: PersistenceWalk,
	depth: number,
	scan: boolean,
): NestedWalk {
	if (depth > walk.deepest) walk.deepest = depth;
	const image = externalizeImageNode(obj, walk.blobStore, key);
	if (image !== undefined) return image;
	// Signed content is bound to its exact bytes: a truncated `thinking`/`text`/
	// `arguments` no longer matches its signature and a truncated
	// `redacted_thinking` blob is undecryptable, so the provider 400s the replay.
	// Persist signed blocks verbatim — never truncate, externalize, or descend.
	// Unsigned blocks (e.g. an interrupted stream) have no such binding and stay
	// truncatable for size control.
	// Anthropic validates native web-search and tool-search history byte-for-byte
	// on replay. Keep the complete typed block atomic, including opaque content.
	if ("type" in obj && obj.type === "anthropicServerTool" && "block" in obj) {
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
	// signed reasoning, and Gemini native content replays its signed parts
	// byte-for-byte, so both persist atomically too.
	if (
		("type" in obj &&
			(obj.type === "anthropicCompaction" || obj.type === "cursorHistory" || obj.type === "geminiNativeContent")) ||
		(key === "anthropicCompaction" && "content" in obj && typeof obj.content === "string")
	) {
		return obj;
	}
	if ("type" in obj) {
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

	walk.path.enter(obj);
	// Each field and element is read once and kept as read: a getter read again for the rebuilt copy could
	// answer differently from the value the walk checked.
	if (Array.isArray(obj)) {
		const result: unknown[] = [];
		let changed = false;
		for (let i = 0; i < obj.length; i++) {
			const item: unknown = obj[i];
			let next: unknown;
			if (!isNonNullObject(item)) next = truncateLeaf(item, key, walk.blobStore);
			else {
				const step = containerStep(item, key, walk, depth + 1, scan);
				next = step === undefined ? item : yield step;
			}
			if (next !== item) changed = true;
			result.push(next);
		}
		walk.path.leave(obj);
		return changed ? result : obj;
	}

	const holder = obj as Record<string, unknown>;
	const entries: Array<readonly [string, unknown]> = [];
	let changed = false;
	for (const childKey in holder) {
		if (!Object.hasOwn(holder, childKey)) continue;
		const value = holder[childKey];
		// Strip transient/redundant properties that shouldn't be persisted.
		// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
		if (childKey === "jsonlEvents") {
			changed = true;
			continue;
		}
		let next: unknown;
		if (isSnapcompactArchiveSlot(key, childKey, value))
			next = yield persistSnapcompactArchive(value, walk, depth + 1, scan);
		else if (!isNonNullObject(value)) next = truncateLeaf(value, childKey, walk.blobStore);
		else {
			const step = containerStep(value, childKey, walk, depth + 1, scan);
			next = step === undefined ? value : yield step;
		}
		if (next !== value) changed = true;
		entries.push([childKey, next]);
	}
	walk.path.leave(obj);
	if (!changed) return obj;

	const contentEntry = entries.find(([childKey]) => childKey === "content");
	const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
	if (contentEntry && typeof contentEntry[1] === "string" && lineCountEntry && typeof lineCountEntry[1] === "number") {
		// Same count as `content.split("\n").length` without the array.
		const lineCount = countNewlines(contentEntry[1]) + 1;
		const updatedEntries = entries.map(([childKey, value]) =>
			childKey === "lineCount" ? ([childKey, lineCount] as const) : ([childKey, value] as const),
		);
		return Object.fromEntries(updatedEntries);
	}
	return Object.fromEntries(entries);
}

/**
 * The step that persists `value`, an object under `key` of its holder at `depth` levels, or
 * `undefined` when it stays as it is: with `scan`, above {@link PERSISTENCE_SCAN_DEPTH} levels,
 * a subtree {@link persistenceScan} finds clean is kept without a step, as recursion kept it, and
 * one it finds deeper than it scans is rebuilt without a scan of any node in it. Without `scan`
 * (an ancestor was found that deep), or past those levels, no node scans, so a value deeper
 * than the scan costs one pass, not a scan per level.
 */
function containerStep(
	value: object,
	key: string | undefined,
	walk: PersistenceWalk,
	depth: number,
	scan: boolean,
): NestedWalk | undefined {
	if (!scan || depth >= PERSISTENCE_SCAN_DEPTH) return truncateNode(value, key, walk, depth, false);
	const found = persistenceScan(value, key);
	return found === "clean" ? undefined : truncateNode(value, key, walk, depth, found === "dirty");
}

/**
 * Whether this node can possibly change under `truncateForPersistence`:
 * `dirty` when it carries `jsonlEvents`, an oversized or image-position
 * string, or (for objects) a child that can. Mirrors the change conditions of
 * the rebuild pass exactly — a false negative silently keeps oversized
 * content, so when in doubt this must not answer `clean`. It recurses, so a
 * node past {@link PERSISTENCE_SCAN_DEPTH} levels it answers `deep` for
 * unscanned: the rebuild, which keeps its own stack, then returns the node
 * unchanged when nothing in it changes, and fails on a cycle, where this scan
 * stops too. The first child that is not clean decides the answer.
 */
function persistenceScan(obj: unknown, key?: string, depth = 0): PersistenceScan {
	if (obj === null || obj === undefined) return "clean";
	if (typeof obj === "string") {
		if (
			obj.length > MAX_PERSIST_CHARS &&
			key !== "thinkingSignature" &&
			key !== "thoughtSignature" &&
			key !== "textSignature"
		)
			return "dirty";
		return externalizedImageSite(obj, key) !== undefined ? "dirty" : "clean";
	}
	if (typeof obj !== "object") return "clean";
	if (depth >= PERSISTENCE_SCAN_DEPTH) return "deep";
	if (Array.isArray(obj)) {
		for (const item of obj) {
			const found = persistenceScan(item, key, depth + 1);
			if (found !== "clean") return found;
		}
		return "clean";
	}
	if ("jsonlEvents" in obj) return "dirty";
	// Externalize shapes rewrite (not verbatim): check before the
	// atomic/verbatim classification below.
	if (externalizedImageSite(obj, key) !== undefined) return "dirty";
	if (isAtomicPersistenceNode(obj, key)) return "clean";
	for (const childKey in obj) {
		if (!Object.hasOwn(obj, childKey)) continue;
		const value = (obj as Record<string, unknown>)[childKey];
		const found = isSnapcompactArchiveSlot(key, childKey, value)
			? snapcompactArchiveScan(value, depth + 1)
			: persistenceScan(value, childKey, depth + 1);
		if (found !== "clean") return found;
	}
	return "clean";
}

/**
 * True for nodes `truncateForPersistence` returns verbatim without
 * descending: image-generation results, externalizable image payloads,
 * anthropic server-tool/compaction carriers, and signed/encrypted blocks.
 * Must stay in sync with the early-return guards above the recursion.
 */
function isAtomicPersistenceNode(obj: object, key?: string): boolean {
	// NOTE: image_generation_call results and externalizable image payloads
	// are NOT atomic — truncateForPersistence rewrites them via the blob
	// store. They are checked explicitly in the predicate and must never be
	// classified here.
	if (typeof obj === "object" && "type" in obj) {
		const typed = obj as Record<string, unknown>;
		// Mirror the truncate guard exactly: only a block that passes
		// isAnthropicServerToolHistoryBlock is atomic. An interrupted,
		// corrupt, or forward-version block that FAILS validation falls
		// through here (and in the main function) into the generic
		// recursion, so oversized strings and jsonlEvents inside it are
		// still truncated/stripped instead of bypassing size controls.
		if (typed.type === "anthropicServerTool" && "block" in typed) {
			const block = typed.block;
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				typeof (block as { type?: unknown }).type === "string"
			) {
				const asBlock = block as Record<string, unknown>;
				const validationView = {
					type: asBlock.type as string,
					...("name" in asBlock ? { name: asBlock.name } : {}),
					...("id" in asBlock ? { id: asBlock.id } : {}),
					...("tool_use_id" in asBlock ? { tool_use_id: asBlock.tool_use_id } : {}),
					...("content" in asBlock ? { content: asBlock.content } : {}),
				};
				if (isAnthropicServerToolHistoryBlock(validationView)) return true;
			}
			return false;
		}
		if (
			typed.type === "anthropicCompaction" ||
			typed.type === "cursorHistory" ||
			typed.type === "geminiNativeContent" ||
			(key === "anthropicCompaction" && "content" in typed && typeof typed.content === "string")
		)
			return true;
		const signed =
			(typed.type === "thinking" && "thinkingSignature" in typed && isNonEmptyString(typed.thinkingSignature)) ||
			(typed.type === "text" && "textSignature" in typed && isNonEmptyString(typed.textSignature)) ||
			(typed.type === "toolCall" && "thoughtSignature" in typed && isNonEmptyString(typed.thoughtSignature));
		const redacted = typed.type === "redactedThinking" && "data" in typed && isNonEmptyString(typed.data);
		const encryptedReasoning =
			typed.type === "reasoning" && "encrypted_content" in typed && isNonEmptyString(typed.encrypted_content);
		if (signed || redacted || encryptedReasoning) return true;
	}
	return false;
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
	return preparedEntry(entry, blobStore, undefined);
}

/**
 * The JSON text of the line a session file holds for `entry`:
 * {@link prepareEntryForPersistence}'s result as `stringifyJson` writes it. An
 * entry nested past {@link DEEP_JSON_LEVELS} levels is written by
 * `stringifyJsonIteratively`, the same bytes in milliseconds where
 * `JSON.stringify` takes seconds or runs out of stack.
 */
export function persistedEntryText(entry: FileEntry, blobStore: BlobStore): string {
	const shape: PersistedShape = { deep: false };
	return persistedJson(preparedEntry(entry, blobStore, shape), shape);
}

/**
 * The JSON text of `value` as a session line holds it: by `stringifyJsonIteratively`
 * where `shape` says it nests past {@link DEEP_JSON_LEVELS} levels, else by
 * `JSON.stringify`; a bigint as its decimal string either way.
 */
function persistedJson(value: unknown, shape: PersistedShape): string {
	return stringifyDeepJson(value, shape.deep ? DEEP_BIGINT_AS_STRING : BIGINT_AS_STRING) ?? "null";
}

/** {@link prepareEntryForPersistence}, setting `shape.deep` for an entry nested past {@link DEEP_JSON_LEVELS} levels. */
function preparedEntry(entry: FileEntry, blobStore: BlobStore, shape: PersistedShape | undefined): FileEntry {
	const projected = stripSpilledMcpStructuredContent(stripReplayedReasoningSignatures(entry));
	try {
		return truncateForPersistence(projected, blobStore, shape) as FileEntry;
	} catch (error) {
		// The walk probes fields such as `data` and `type` with `in` and plain
		// reads, so it also reaches non-enumerable and inherited accessors that
		// the JSONL line never holds. Tool `details` can keep a library object
		// whose getter throws (firecrawl-js `SearchData.data`). Left unhandled,
		// that latches a disk failure, and every later rewrite of the session
		// meets the same entry, so nothing persists for the rest of the process.
		// Retry once on the plain JSON of the entry: it holds the fields the
		// line would serialize, and no accessors.
		let json: string | undefined;
		try {
			json = stringifyDeepJson(projected, BIGINT_AS_STRING);
		} catch {
			throw error;
		}
		if (json === undefined) throw error;
		try {
			return truncateForPersistence(JSON.parse(json), blobStore, shape) as FileEntry;
		} catch {
			// A cause the clone does not remove (blob I/O) fails again: keep the
			// first error so the logged cause stays stable.
			throw error;
		}
	}
}
