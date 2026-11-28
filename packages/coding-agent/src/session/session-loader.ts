import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ConcatSink,
	getBlobsDir,
	isEisdir,
	isEnoent,
	isEnotdir,
	parseJsonlLenient,
	peekFile,
} from "@oh-my-pi/pi-utils";
import { isWhitespace } from "@oh-my-pi/pi-utils/json-lexer";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Semaphore } from "../task/parallel";
import {
	BlobStore,
	isBlobRef,
	lazyImageDataSync,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
	resolveImageDataUrlSync,
} from "./blob-store";
import { buildSessionContext } from "./session-context";
import type { FileEntry, RawFileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isExternalizableImagePosition, isPersistenceTruncatedString } from "./session-persistence";
import { FileSessionStorage, retryRacedRead, SessionReadConflictError, type SessionStorage } from "./session-storage";
import { enotdir } from "./session-storage-errors";
import { SESSION_HEADER_READ_LIMIT, sessionHeaderIdFromPrefix } from "./session-header-id";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const LF = new Uint8Array([0x0a]);

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
/** Initial parse window after a malformed record; see the recovery note in visitEntriesFromFileStream. */
const RECOVERY_PARSE_WINDOW = 64 * 1024;
const BLOB_READ_CONCURRENCY = 8;

/**
 * Complete optional accounting fields from persisted/imported assistant turns.
 * Complete provider usage is left untouched; missing prices never discard reported tokens.
 */
export function normalizeAssistantUsage(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
	const usage = message.usage;
	if (
		usage &&
		usage.input !== undefined &&
		usage.output !== undefined &&
		usage.cacheRead !== undefined &&
		usage.cacheWrite !== undefined &&
		usage.totalTokens !== undefined &&
		usage.cost?.input !== undefined &&
		usage.cost.output !== undefined &&
		usage.cost.cacheRead !== undefined &&
		usage.cost.cacheWrite !== undefined &&
		usage.cost.total !== undefined
	) {
		return false;
	}
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cost = usage?.cost;
	message.usage = {
		...usage,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens:
			usage?.totalTokens ??
			input +
				output +
				cacheRead +
				cacheWrite +
				(usage?.orchestration?.input ?? 0) +
				(usage?.orchestration?.cacheRead ?? 0) +
				(usage?.orchestration?.output ?? 0),
		cost: {
			...cost,
			input: cost?.input ?? 0,
			output: cost?.output ?? 0,
			cacheRead: cost?.cacheRead ?? 0,
			cacheWrite: cost?.cacheWrite ?? 0,
			total:
				cost?.total ?? (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0),
		},
	};
	return true;
}

export interface VisitEntriesFromFileStreamOptions {
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
	/** Rethrow missing source instead of visiting nothing (fork backstop). */
	throwIfMissing?: boolean;
	/**
	 * Called with each stream chunk's byte length as it is consumed. Lets
	 * callers derive the exact snapshot size without re-stating the file.
	 */
	onBytesConsumed?: (bytes: number) => void;
	/**
	 * Storage holding the transcript, read through {@link transcriptByteChunks}:
	 * its own chunks where it has `readChunks`, else its whole text. Without it
	 * the file at `filePath` is streamed.
	 */
	storage?: SessionStorage;
}

/** Controls how a missing session file is handled. */
export interface LoadSessionOptions {
	/** Propagate ENOENT instead of treating the path as a new empty session. */
	throwIfMissing?: boolean;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Byte length of the snapshot actually parsed, or `null` when the path did not exist. */
	sourceSize?: number | null;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		sourceSize: Buffer.byteLength(content, "utf8"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** First read; holds the title slot and any real header, so the full limit is read only for outliers. */
const SESSION_HEADER_FIRST_READ = 16 * 1024;

/** {@link sessionHeaderIdFromPrefix} result when the window ends inside the first record. */
const HEADER_INCOMPLETE = Symbol("header-incomplete");

/**
 * The session id in `filePath`'s header, or `undefined` when there is no file
 * there or it does not start with a valid session header. Reads
 * {@link SESSION_HEADER_FIRST_READ} bytes, and up to
 * {@link SESSION_HEADER_READ_LIMIT} only when the first record runs past them.
 */
export async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	try {
		const id = await peekFile(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			prefix.length < SESSION_HEADER_FIRST_READ
				? sessionHeaderIdFromPrefix(prefix)
				: (sessionHeaderIdFromPrefix(prefix) ?? HEADER_INCOMPLETE),
		);
		if (id !== HEADER_INCOMPLETE) return id;
		const full = await peekFile(filePath, SESSION_HEADER_READ_LIMIT, prefix => sessionHeaderIdFromPrefix(prefix));
		return full ?? undefined;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/**
 * The transcript's bytes, as chunks: the storage's own chunks where it has
 * `readChunks` (as file storage does), and otherwise its whole text as one
 * chunk. A missing transcript raises ENOENT from either source, which the
 * caller tolerates.
 */
async function* transcriptByteChunks(filePath: string, storage: SessionStorage): AsyncGenerator<Uint8Array> {
	if (storage.readChunks) {
		yield* storage.readChunks(filePath);
		return;
	}
	yield new TextEncoder().encode(await storage.readText(filePath));
}

function hasPayload(bytes: Uint8Array, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		if (!isWhitespace(bytes[index]!)) return true;
	}
	return false;
}

/**
 * The lenient JSONL parse of a transcript's bytes behind
 * {@link visitEntriesFromFileStream}. Bytes, not text: a multibyte UTF-8
 * sequence straddling a chunk boundary stays intact, and Bun.JSONL.parseChunk
 * takes typed arrays directly. Only the pending record and current chunk are buffered.
 */
class TranscriptRecordParser {
	titleSlot: SessionTitleUpdate | undefined;
	/** Valid and malformed records consumed; the visitor counts the valid ones it accepts. */
	recordsSeen = 0;
	/** Set to stop the parse: the visitor declined an entry, or the record cap was reached. */
	stopped = false;
	readonly #maxRecords: number;
	readonly #onMalformedRecord: (() => void) | undefined;
	readonly #sink = new ConcatSink();
	readonly #decoder = new TextDecoder();
	#sawFirstLine = false;
	#sawFirstEntry = false;

	constructor(maxRecords: number, onMalformedRecord: (() => void) | undefined) {
		this.#maxRecords = maxRecords;
		this.#onMalformedRecord = onMalformedRecord;
	}

	append(chunk: Uint8Array): void {
		this.#sink.append(chunk);
	}

	/**
	 * Peel the optional fixed-width title slot before parsing entries. It is
	 * JSON metadata, not the session header. The first line ends at a '\n'
	 * byte, so it is a complete UTF-8 sequence and safe to decode. Leave the
	 * first line for the parser if it is blank or does not hold a title slot.
	 */
	peelTitleSlot(): void {
		if (this.#sawFirstLine) return;
		const buffered = this.#sink.flush()!;
		const newline = buffered.indexOf(0x0a);
		if (newline === -1) return;
		this.#sawFirstLine = true;
		const firstLine = this.#decoder.decode(buffered.subarray(0, newline)).trim();
		if (!firstLine) return;
		const slot = parseTitleSlotLine(firstLine);
		if (!slot) return;
		this.titleSlot = titleUpdateFromSlot(slot);
		this.#sink.consume(newline + 1);
	}

	/**
	 * Yield each entry the held newline-terminated bytes complete, the parse
	 * waiting at each until the visitor took it (or set {@link stopped}).
	 * parseChunk can leave a value unfinished even after a newline; the
	 * remainder stays held for the next chunk, unless `endOfInput`, when it is
	 * a truncated record.
	 */
	*drain(endOfInput = false): Generator<FileEntry> {
		const view = this.#sink.flush();
		if (!view) return;
		// Only newline-terminated bytes may reach the parser: a trailing fragment
		// in the same call turns an end-of-input `done` into a syntax error at the
		// preceding newline, which would then be miscounted as a malformed record.
		const lastNewline = view.lastIndexOf(0x0a);
		if (lastNewline === -1) return;
		let buffer: Uint8Array = view.subarray(0, lastNewline + 1);
		let consumed = 0;
		const advance = (count: number): void => {
			consumed += count;
			buffer = buffer.subarray(count);
		};
		// parseChunk costs time proportional to its whole input even when it stops at
		// the first bad line, so recovering line by line over the full buffer is
		// quadratic. After a malformed record, parse a newline-cut window that grows
		// while the input keeps parsing and resets on the next error.
		let window = Number.POSITIVE_INFINITY;
		try {
			while (buffer.length > 0 && !this.stopped) {
				if (this.recordsSeen >= this.#maxRecords) {
					this.stopped = true;
					break;
				}
				let input = buffer;
				if (window < buffer.length) {
					const cut = buffer.indexOf(0x0a, window - 1);
					if (cut !== -1) input = buffer.subarray(0, cut + 1);
				}
				const partial = input.length < buffer.length;
				const { values, error, read, done } = Bun.JSONL.parseChunk(input);
				for (const value of values) {
					if (this.recordsSeen >= this.#maxRecords) {
						this.stopped = true;
						break;
					}
					const entry = value as FileEntry;
					if (!this.#sawFirstEntry) {
						this.#sawFirstEntry = true;
						applyTitleSlot(entry, this.titleSlot);
					}
					yield entry;
				}
				if (this.stopped) break;
				if (error) {
					// Malformed record: skip past the next newline and continue.
					const nextNewline = buffer.indexOf(0x0a, read);
					if (nextNewline === -1) break; // rest of the bad line not yet received
					if (hasPayload(buffer, read, nextNewline)) this.#onMalformedRecord?.();
					this.recordsSeen++;
					advance(nextNewline + 1);
					window = RECOVERY_PARSE_WINDOW;
					if (this.recordsSeen >= this.#maxRecords) {
						this.stopped = true;
						break;
					}
					continue;
				}
				if (read === 0) {
					if (partial) {
						// The record runs past the window, not past the buffered input.
						window *= 2;
						continue;
					}
					// Incomplete value awaiting more bytes. Once the input has ended nothing more
					// is coming, so it is a truncated record (parseJsonlLenient counts it too).
					if (endOfInput) {
						if (hasPayload(buffer, 0, buffer.length)) this.#onMalformedRecord?.();
						this.recordsSeen++;
						advance(buffer.length);
					}
					break;
				}
				advance(read);
				if (done) {
					// The parser reached the end of its input; whatever trails the last value is whitespace.
					advance(input.length - read);
					if (!partial) break;
				}
				if (partial) window *= 2;
			}
		} finally {
			this.#sink.consume(consumed);
		}
	}

	/**
	 * A trailing record without a final newline: terminate it so the parser
	 * can complete it (readline yielded it; parseChunk needs the delimiter).
	 */
	*finish(): Generator<FileEntry> {
		if (this.stopped || this.#sink.isEmpty) return;
		this.#sink.append(LF);
		yield* this.drain(true);
	}
}

/** Parse session JSONL and visit each entry without retaining prior entries. */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	const parser = new TranscriptRecordParser(maxRecords, options.onMalformedRecord);

	const yieldToMacrotask = async (): Promise<void> => {
		if (yieldEveryBytes === 0 && yieldEveryEntries === 0) return;
		const bytesReady = yieldEveryBytes === 0 || bytesSinceYield < yieldEveryBytes;
		const entriesReady = yieldEveryEntries === 0 || entriesSinceYield < yieldEveryEntries;
		if (bytesReady && entriesReady) {
			return;
		}
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const visitParsed = async (entries: Iterable<FileEntry>): Promise<void> => {
		for (const entry of entries) {
			if (options.shouldContinue && !options.shouldContinue()) {
				parser.stopped = true;
				break;
			}
			try {
				if (visit(entry) === false) {
					parser.stopped = true;
					break;
				}
				parser.recordsSeen++;
				entriesSinceYield++;
				if (parser.recordsSeen >= maxRecords) {
					parser.stopped = true;
					break;
				}
			} catch (err) {
				visitorThrew = true;
				throw err;
			}
			await yieldToMacrotask();
		}
	};

	try {
		// Capped by hand, not with `file.slice(0, maxBytes)`: on Bun 1.3.14 a slice's
		// stream over a file that continues past the slice either stays pending after
		// delivering its bytes (macOS) or ignores the bound and streams the whole
		// file (Windows).
		let unread = maxBytes;
		const chunks = options.storage ? transcriptByteChunks(filePath, options.storage) : Bun.file(filePath).stream();
		for await (const streamed of chunks) {
			const chunk = streamed.byteLength > unread ? streamed.subarray(0, unread) : streamed;
			unread -= chunk.byteLength;
			bytesSinceYield += chunk.byteLength;
			options.onBytesConsumed?.(chunk.byteLength);
			// Parsing before the chunk closes a line re-scans the unfinished record
			// on every chunk, which is quadratic for large records.
			if (chunk.lastIndexOf(0x0a) === -1) {
				// Skipping the parse also skips the only enforcement of the record cap,
				// so re-check it here: a delimiter-free file would otherwise be read
				// and buffered in full despite an exhausted budget.
				if (parser.recordsSeen >= maxRecords) {
					parser.stopped = true;
					break;
				}
				parser.append(chunk);
				await yieldToMacrotask();
				if (unread === 0) break;
				continue;
			}
			parser.append(chunk);
			parser.peelTitleSlot();
			await visitParsed(parser.drain());
			// Stop before the loop pulls another chunk: a stopped visitor reads no further.
			if (parser.stopped) break;
			await yieldToMacrotask();
			if (unread === 0) break;
		}
		await visitParsed(parser.finish());
	} catch (err) {
		if (visitorThrew) throw err;
		if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	return parser.titleSlot;
}
/**
 * The ≥8MiB streaming load (works on any size), of `filePath` or of `options.storage`.
 * ENOENT after bytes were read raises `SessionReadConflictError` (see
 * {@link throwIfReadCutShort}), which {@link loadSessionFile} answers by
 * reading again from the start, never returning the prefix read.
 */
export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<VisitEntriesFromFileStreamOptions, "throwIfMissing" | "storage">,
): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let bytesConsumed = 0;
	let titleSlot: SessionTitleUpdate | undefined;
	try {
		titleSlot = await visitEntriesFromFileStream(
			filePath,
			entry => {
				entries.push(entry);
			},
			{
				onMalformedRecord: () => {
					malformedRecords++;
				},
				throwIfMissing: true,
				onBytesConsumed: bytes => {
					bytesConsumed += bytes;
				},
				storage: options?.storage,
			},
		);
	} catch (err) {
		throwIfReadCutShort(err, filePath, bytesConsumed);
		if (options?.throwIfMissing || !isEnoent(err)) throw err;
	}
	return {
		entries,
		titleSlot,
		malformedRecords,
		sourceSize: bytesConsumed,
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}
/**
 * ENOENT from a streamed read that had already read `bytesRead` bytes means a
 * delete or replacement cut it short: throw `SessionReadConflictError`, so the
 * caller reads again from the start instead of keeping the prefix or reading
 * the path as missing.
 */
function throwIfReadCutShort(err: unknown, filePath: string, bytesRead: number): void {
	if (bytesRead > 0 && isEnoent(err)) throw new SessionReadConflictError(filePath);
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}
/** A transcript of {@link STREAM_LOAD_THRESHOLD_BYTES} or more is streamed from any storage that can stream it. */
function shouldStreamEntries(storage: SessionStorage, size: number): boolean {
	return storage.readChunks !== undefined && size >= STREAM_LOAD_THRESHOLD_BYTES;
}

async function loadWithKnownSize(
	filePath: string,
	storage: SessionStorage,
	size: number,
): Promise<{ loaded: SessionLoadResult; sourceSize: number }> {
	if (shouldStreamEntries(storage, size)) {
		// A full rewrite or delete raced the stream (another process, or this one's queued writes, which
		// reads do not wait for): stream it again from its start, never as one whole-text read. A path an
		// attempt finds missing throws ENOENT, so loadSessionFile applies the caller's missing-file policy.
		const loaded = await retryRacedRead(() => loadEntriesFromFileStream(filePath, { throwIfMissing: true, storage }));
		const sourceSize = loaded.sourceSize ?? 0;
		return { loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded, sourceSize };
	}
	const content = await storage.readText(filePath);
	const loaded = parseSessionContent(content);
	return {
		loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded,
		sourceSize: Buffer.byteLength(content, "utf8"),
	};
}

/**
 * Windows reports ENOENT when a path component is a regular file, where POSIX
 * yields ENOTDIR. Inspecting the leaf itself and then climbing to the first
 * existing ancestor distinguishes that path error from a genuinely missing
 * file.
 */
export async function hasFileAsPathComponent(filePath: string): Promise<boolean> {
	let current = path.resolve(filePath);
	for (;;) {
		try {
			return !(await fs.stat(current)).isDirectory();
		} catch {
			// Missing component: climb to the first existing ancestor.
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/** Load and validate a session while retaining malformed-record diagnostics. */
export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult> {
	try {
		const statSize = storage.statSync(filePath).size;
		const { loaded, sourceSize } = await loadWithKnownSize(filePath, storage, statSize);
		return { ...loaded, sourceSize };
	} catch (caught) {
		return { entries: [], ...(await missingSessionVisit(caught, filePath, storage, options)) };
	}
}

/**
 * Windows reports ENOENT where POSIX reports ENOTDIR for a path running
 * through a regular file; restore ENOTDIR so that path error is never masked
 * as a missing session.
 */
async function restorePathComponentError(caught: unknown, filePath: string, storage: SessionStorage): Promise<unknown> {
	return isEnoent(caught) &&
		process.platform === "win32" &&
		storage instanceof FileSessionStorage &&
		(await hasFileAsPathComponent(filePath))
		? enotdir(filePath)
		: caught;
}

/** What {@link visitSessionFile} read besides the entries it visited. */
export interface SessionFileVisit {
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Bytes read, or `null` when the path did not exist. */
	sourceSize: number | null;
	/** Non-empty session data without a valid leading session header: nothing was visited. */
	invalidHeader: boolean;
}

/**
 * The visit of a session whose path could not be read, for
 * {@link loadSessionFile} and {@link visitSessionFile}: none for a missing
 * path, unless `throwIfMissing` asks for its error; any other error is thrown.
 */
async function missingSessionVisit(
	caught: unknown,
	filePath: string,
	storage: SessionStorage,
	options: LoadSessionOptions,
): Promise<SessionFileVisit> {
	const err = await restorePathComponentError(caught, filePath, storage);
	if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) throw err;
	if (isEnoent(err)) return { titleSlot: undefined, malformedRecords: 0, sourceSize: null, invalidHeader: false };
	throw err;
}

/** Visit the entries of a session read whole, as {@link visitSessionFile} visits a streamed one. */
export function visitLoadedSession(
	loaded: SessionLoadResult,
	visit: (entry: FileEntry) => void | boolean,
): SessionFileVisit {
	for (const entry of loaded.invalidHeader ? [] : loaded.entries) {
		if (visit(entry) === false) break;
	}
	return {
		titleSlot: loaded.titleSlot,
		malformedRecords: loaded.malformedRecords,
		sourceSize: loaded.sourceSize ?? null,
		invalidHeader: loaded.invalidHeader,
	};
}

/**
 * Visit a session's entries in file order, the header first, from any
 * storage. A transcript of 8 MiB or more streams from file storage or a
 * storage with `readChunks`, so it is never held whole; a smaller one is read
 * whole, as {@link loadSessionFile} reads it. Missing files and headers follow
 * {@link loadSessionFile}: a missing path visits nothing (or throws with
 * `throwIfMissing`), and a file whose first record is not a valid header
 * visits nothing. `visit` returning `false` stops the visit.
 */
export async function visitSessionFile(
	filePath: string,
	storage: SessionStorage,
	visit: (entry: FileEntry) => void | boolean,
	options: LoadSessionOptions = {},
): Promise<SessionFileVisit> {
	let size: number;
	try {
		size = storage.statSync(filePath).size;
	} catch (caught) {
		return missingSessionVisit(caught, filePath, storage, options);
	}
	if (!shouldStreamEntries(storage, size))
		return visitLoadedSession(await loadSessionFile(filePath, storage, options), visit);

	let malformedRecords = 0;
	let sourceSize = 0;
	let sawEntry = false;
	let invalidHeader = false;
	let visitorError: { error: unknown } | undefined;
	try {
		const titleSlot = await visitEntriesFromFileStream(
			filePath,
			entry => {
				if (!sawEntry) {
					sawEntry = true;
					if (!isValidSessionHeader(entry)) {
						invalidHeader = true;
						return false;
					}
				}
				try {
					return visit(entry);
				} catch (error) {
					visitorError = { error };
					throw error;
				}
			},
			{
				storage,
				throwIfMissing: true,
				onMalformedRecord: () => {
					malformedRecords++;
				},
				onBytesConsumed: bytes => {
					sourceSize += bytes;
				},
			},
		);
		return {
			titleSlot,
			malformedRecords,
			sourceSize,
			invalidHeader: invalidHeader || (!sawEntry && malformedRecords > 0),
		};
	} catch (caught) {
		if (visitorError) throw visitorError.error;
		throwIfReadCutShort(caught, filePath, sourceSize);
		return missingSessionVisit(caught, filePath, storage, options);
	}
}

/**
 * The header of the session at `filePath`, read the cheapest way: a
 * transcript {@link visitSessionFile} would read whole is loaded and returned
 * too, so a caller need not read it twice; a streamed one yields its header
 * alone, read again from its start when a full rewrite or delete raced it
 * (`SessionReadConflictError`). Missing files follow {@link loadSessionFile}.
 */
export async function probeSessionFile(
	filePath: string,
	storage: SessionStorage,
	options: LoadSessionOptions = {},
): Promise<{ header: SessionHeader | undefined; loaded: SessionLoadResult | undefined }> {
	let streamed = false;
	try {
		streamed = shouldStreamEntries(storage, storage.statSync(filePath).size);
	} catch {
		// A missing or unreadable path: the read below applies loadSessionFile's rules.
	}
	if (!streamed) {
		const loaded = await loadSessionFile(filePath, storage, options);
		const first = loaded.entries[0];
		return { header: isValidSessionHeader(first) ? first : undefined, loaded };
	}
	// A full rewrite or delete can race the stream between its chunks.
	return retryRacedRead(async () => {
		const probe: { header?: SessionHeader } = {};
		await visitSessionFile(
			filePath,
			storage,
			entry => {
				probe.header = entry as SessionHeader;
				return false;
			},
			options,
		);
		return { header: probe.header, loaded: undefined };
	});
}

/**
 * Load the valid entries from a session file, skipping malformed records.
 * Each call returns freshly parsed entries owned by the caller.
 */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options?: { throwIfMissing?: boolean },
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage, options)).entries;
}

/**
 * Visit session entries, streaming large journals from any storage that has
 * `readChunks`: a {@link visitSessionFile} whose missing path throws.
 */
export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<void> {
	await visitSessionFile(filePath, storage, visit, { throwIfMissing: true });
}

function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

/** A persisted blob reference and the field that holds it. */
interface BlobRefSite {
	holder: Record<string, unknown>;
	key: string;
	ref: string;
	/** Provider image URLs persist the whole data URL; image payloads persist bare base64. */
	asDataUrl: boolean;
}

/**
 * Collect the blob references in session image blocks and provider image URLs.
 * Snapcompact frames stay as references until context rebuilding selects them.
 */
function collectBlobRefSites(value: unknown, sites: BlobRefSite[], key?: string): void {
	if (key !== "frames" && isExternalizableImagePosition(value, key) && isBlobRef(value.data)) {
		sites.push({ holder: value, key: "data", ref: value.data, asDataUrl: false });
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) collectBlobRefSites(item, sites, key);
		return;
	}

	if (typeof value !== "object" || value === null) return;
	const holder = value as Record<string, unknown>;
	if (holder.type === "image_generation_call" && typeof holder.result === "string" && isBlobRef(holder.result)) {
		sites.push({ holder, key: "result", ref: holder.result, asDataUrl: false });
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		sites.push({ holder, key: "image_url", ref: value.image_url, asDataUrl: true });
	}

	for (const childKey in holder) collectBlobRefSites(holder[childKey], sites, childKey);
}

/**
 * Cheap synchronous precheck: does this value's tree contain any `blob:sha256:` string?
 * Early-exits on the first hit, so blob-free entries skip the
 * {@link collectBlobRefSites} descent entirely. Conservative — a blob ref in a
 * non-resolved position still returns true, which only costs an extra (no-op) walk.
 */
function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value) {
		if (containsBlobRef((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}

/**
 * Older persistence versions truncated oversized frame base64 in place. Recover
 * those archives from their retained source text so an already-wedged session
 * resumes as text instead of sending malformed image data to the provider.
 */
function repairTruncatedSnapcompactFrames(entry: FileEntry): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive?.frames.some(frame => isPersistenceTruncatedString(frame.data))) return;
	const slot = entry.preserveData?.[snapcompact.PRESERVE_KEY];
	if (typeof slot !== "object" || slot === null) return;

	if (archive.text) {
		Object.assign(slot, { frames: [], textHead: archive.text, textTail: "" });
		return;
	}
	Object.assign(slot, {
		frames: archive.frames.filter(frame => !isPersistenceTruncatedString(frame.data)),
	});
}

function blobRefSites(values: readonly unknown[]): BlobRefSite[] {
	const sites: BlobRefSite[] = [];
	for (const value of values) {
		if (containsBlobRef(value)) collectBlobRefSites(value, sites);
	}
	return sites;
}

function blobSiteKey(site: BlobRefSite): string {
	return `${site.asDataUrl ? "url" : "base64"}:${site.ref}`;
}

async function resolveBlobRefs(values: readonly unknown[], blobStore: BlobStore): Promise<void> {
	const semaphore = new Semaphore(BLOB_READ_CONCURRENCY);
	const resolved = new Map<string, Promise<string>>();
	await Promise.all(
		blobRefSites(values).map(async site => {
			const key = blobSiteKey(site);
			let data = resolved.get(key);
			if (!data) {
				data = (async () => {
					await semaphore.acquire();
					try {
						return await (site.asDataUrl
							? resolveImageDataUrl(blobStore, site.ref)
							: resolveImageData(blobStore, site.ref));
					} finally {
						semaphore.release();
					}
				})();
				resolved.set(key, data);
			}
			site.holder[site.key] = await data;
		}),
	);
}

/** The non-header entries, with legacy truncated snapcompact frames repaired before their blobs resolve. */
function entriesForBlobResolution(entries: FileEntry[]): FileEntry[] {
	const sessionEntries = entries.filter(entry => entry.type !== "session");
	for (const entry of sessionEntries) repairTruncatedSnapcompactFrames(entry);
	return sessionEntries;
}

/** Restore the image data that persistence externalized to the blob store, in place. */
export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await resolveBlobRefs(entriesForBlobResolution(entries), blobStore);
}

/** Synchronous {@link resolveBlobRefsInEntries}. */
export function resolveBlobRefsInEntriesSync(entries: FileEntry[], blobStore: BlobStore): void {
	const resolved = new Map<string, string>();
	for (const site of blobRefSites(entriesForBlobResolution(entries))) {
		const key = blobSiteKey(site);
		let data = resolved.get(key);
		if (data === undefined) {
			data = site.asDataUrl
				? resolveImageDataUrlSync(blobStore, site.ref)
				: resolveImageDataSync(blobStore, site.ref);
			resolved.set(key, data);
		}
		site.holder[site.key] = data;
	}
}

/**
 * Read-only transcript view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the display transcript along
 * the persisted leaf path (last entry). Uses transcript mode (collapsed to the
 * latest compaction) so failed/aborted tail turns stay visible, unlike the
 * provider-context builder which drops them. Does NOT create a writer or take
 * the session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	for (const entry of entries) repairTruncatedSnapcompactFrames(entry);
	const blobs = new BlobStore(getBlobsDir());
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	const { messages } = buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
		resolveFrameData: data => lazyImageDataSync(blobs, data),
	});
	// A collapsed summary carries the remote-compaction replacement history for
	// provider replay only; this transcript is never replayed, and the renderer
	// reads just the summary. Dropping it keeps hydration off every image blob
	// buried in that hidden history.
	const displayMessages = messages.map(message =>
		message.role === "compactionSummary" && message.providerPayload !== undefined
			? { ...message, providerPayload: undefined }
			: message,
	);
	await resolveBlobRefs(displayMessages, blobs);
	return displayMessages;
}
