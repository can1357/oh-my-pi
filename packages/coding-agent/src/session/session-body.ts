/**
 * The bodies of an indexed store's full writes ({@link FullBodies}): from a
 * string, or, for a backend that takes a streamed write, from lines read once
 * into a private spool file or, where the platform has no account id, into
 * compressed blocks in memory; an atomic rewrite reads them from a copy of
 * the caller's array taken when it is called. When the spool fails, the
 * lines are streamed to the backend from that array.
 */
import * as fs from "node:fs";
import { countNewlines, logger, toError } from "@oh-my-pi/pi-utils";
import { getPrivateTempDir } from "@oh-my-pi/pi-utils/dirs";
import { digestChunksSync, digestStream } from "../utils/file-hash";
import { openPrivateTempFile, openPrivateTempFileSync, type PrivateTempFile } from "../utils/owner-private-dir";
import type { SessionStorageBackend } from "./indexed-session-storage";
import { sessionIdFromContent } from "./session-header-id";
import {
	encodeLineChunks,
	LINE_STREAM_CHUNK,
	SessionWriteConflictError,
	writeLinesToDescriptor,
	writeLinesToDescriptorSync,
} from "./session-storage";
import { parseTitleSlotFromContent, type SessionTitleUpdate, titleUpdateFromSlot } from "./session-title-slot";

/**
 * The prefix of the private temporary directory the spool files live in,
 * `omp-spool-<uid>` ({@link getPrivateTempDir}): the one a spool opens its
 * file in and the one its warning names.
 */
const SPOOL_DIR_PREFIX = "omp-spool";

/** What a refusal of the spool's directory names it. */
const SPOOL_DIR_LABEL = "Session spool directory";

/** zstd level of the blocks of a rewrite's body kept in memory where no spool file can be made ({@link BodySnapshot}). */
const BLOCK_ZSTD_LEVEL = 3;

/** One full write: its size and title slot, its backend publish, and the read-back after a failed publish. */
export interface FullBody {
	byteLength: number;
	title: SessionTitleUpdate | undefined;
	publish(mtimeMs: number, expectedSize: number | null | undefined, mayPublish?: () => boolean): Promise<void>;
	/** Whether the backend holds exactly this body. */
	isStored(): Promise<boolean>;
	/** Free what the body holds, once its publish (and any read-back) has settled. */
	release?: () => void;
}

/**
 * A full-write body read from its lines once, when the write is queued, and
 * kept until its publish (and any read-back) has settled, so the lines a
 * caller hands over are not held a second time while the publish waits in
 * the path queue. A private file ({@link BodySpool}) or compressed blocks in
 * memory ({@link BodySnapshot}).
 */
interface KeptBody {
	readonly byteLength: number;
	readonly title: SessionTitleUpdate | undefined;
	/** The body in chunks of at most {@link LINE_STREAM_CHUNK} bytes, each a buffer of its own. */
	chunks(): AsyncGenerator<Uint8Array>;
	/** Free what the body holds; a later read throws {@link RELEASED_BODY_MESSAGE}. */
	close(): void;
}

/** What a read of a {@link KeptBody} after its {@link KeptBody.close} throws, spooled or kept in memory. */
const RELEASED_BODY_MESSAGE = "A session rewrite's body was read after it was released";

/**
 * A {@link KeptBody} written to a temporary file, unlinked once open, and read
 * back through its descriptor until the body is released.
 */
class BodySpool implements KeptBody {
	readonly #file: PrivateTempFile;

	constructor(
		file: PrivateTempFile,
		readonly byteLength: number,
		readonly title: SessionTitleUpdate | undefined,
	) {
		this.#file = file;
	}

	async *chunks(): AsyncGenerator<Uint8Array> {
		// The descriptor is taken before the first read, so a released body refuses even when it is
		// empty, and again after each chunk, since the body can be released while a consumer holds one.
		for (let position = 0, fd = this.#fd(); position < this.byteLength; fd = this.#fd()) {
			const buffer = Buffer.allocUnsafe(Math.min(LINE_STREAM_CHUNK, this.byteLength - position));
			const read = await readAt(fd, buffer, position);
			if (read === 0) throw new Error(`Session body spool ended at byte ${position} of ${this.byteLength}`);
			position += read;
			yield read === buffer.byteLength ? buffer : buffer.subarray(0, read);
		}
	}

	close(): void {
		this.#file.close();
	}

	/**
	 * The descriptor, until {@link close}: after it the number can belong to
	 * another file. Refused in the body's words, as a released snapshot is;
	 * the file's own refusal stays behind it.
	 */
	#fd(): number {
		if (this.#file.closed) throw new Error(RELEASED_BODY_MESSAGE);
		return this.#file.fd;
	}
}

function readAt(fd: number, buffer: Uint8Array, position: number): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	fs.read(fd, buffer, 0, buffer.byteLength, position, (err, bytesRead) => {
		if (err) reject(err);
		else resolve(bytesRead);
	});
	return promise;
}

/**
 * A {@link KeptBody} kept in memory where no private spool file can be made
 * (a platform without account ids, Windows): the UTF-8 bytes of its lines,
 * zstd-compressed in blocks of at most {@link LINE_STREAM_CHUNK} bytes, each
 * ending on a character boundary, so no string or buffer as long as the body
 * is held.
 */
class BodySnapshot implements KeptBody {
	#blocks: readonly Uint8Array[] | undefined;

	constructor(
		blocks: readonly Uint8Array[],
		readonly byteLength: number,
		readonly title: SessionTitleUpdate | undefined,
	) {
		this.#blocks = blocks;
	}

	/**
	 * Each block decompressed off the event loop, so a backend that takes the
	 * chunks without waiting on I/O between them still lets it run.
	 */
	async *chunks(): AsyncGenerator<Uint8Array> {
		for (const block of this.#heldBlocks()) yield await Bun.zstdDecompress(block);
	}

	close(): void {
		this.#blocks = undefined;
	}

	/** The blocks, until {@link close}: a read after it would publish an empty body. */
	#heldBlocks(): readonly Uint8Array[] {
		if (!this.#blocks) throw new Error(RELEASED_BODY_MESSAGE);
		return this.#blocks;
	}
}

/**
 * The head of a full write's lines, which its title slot and the header's
 * session id are read from: the lines through the second newline (the title
 * slot is read to the first, the session id at most to the second), at most
 * those that make up the first {@link LINE_STREAM_CHUNK} UTF-16 units, and
 * always the whole first line.
 */
function linesHead(lines: readonly string[]): string {
	let head = "";
	let newlines = 0;
	for (const line of lines) {
		if (newlines >= 2 || head.length >= LINE_STREAM_CHUNK) break;
		head += line;
		newlines += countNewlines(line);
	}
	return head;
}

/** The title slot at the head of `lines` ({@link linesHead}). */
function linesTitle(lines: readonly string[]): SessionTitleUpdate | undefined {
	return titleUpdateFromSlot(parseTitleSlotFromContent(linesHead(lines)));
}

/** Keep `lines` in a {@link BodySnapshot}, compressing each block synchronously. */
function snapshotLinesSync(lines: readonly string[]): BodySnapshot {
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines, true)) {
		blocks.push(Bun.zstdCompressSync(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, linesTitle(lines));
}

/**
 * {@link snapshotLinesSync} with each block compressed off the event loop.
 * Each chunk is a view of one buffer that the next overwrites, so it is
 * compressed before the next is encoded.
 */
async function snapshotLines(lines: readonly string[]): Promise<BodySnapshot> {
	const blocks: Uint8Array[] = [];
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines, true)) {
		blocks.push(await Bun.zstdCompress(chunk, { level: BLOCK_ZSTD_LEVEL }));
		bytes += chunk.byteLength;
	}
	return new BodySnapshot(blocks, bytes, linesTitle(lines));
}

/**
 * Spool `lines` to a new file of account `uid` under `os.tmpdir()/omp-spool-<uid>/`
 * ({@link openPrivateTempFileSync}) through synchronous writes. Throws when the
 * file cannot be made, opened or written, or its directory is refused; a
 * file it opened is closed.
 */
function spoolLinesSync(lines: readonly string[], uid: number): BodySpool {
	const file = openPrivateTempFileSync(SPOOL_DIR_PREFIX, uid, SPOOL_DIR_LABEL);
	try {
		return new BodySpool(file, writeLinesToDescriptorSync(file.fd, lines), linesTitle(lines));
	} catch (err) {
		file.close();
		throw err;
	}
}

/** {@link spoolLinesSync} through asynchronous opens and writes ({@link openPrivateTempFile}). */
async function spoolLines(lines: readonly string[], uid: number): Promise<BodySpool> {
	const file = await openPrivateTempFile(SPOOL_DIR_PREFIX, uid, SPOOL_DIR_LABEL);
	try {
		return new BodySpool(file, await writeLinesToDescriptor(file.fd, lines), linesTitle(lines));
	} catch (err) {
		file.close();
		throw err;
	}
}

/** A full-write body's UTF-8 byte length and SHA-256 (hex), and the title slot and session id read from its head. */
interface MeasuredLines {
	bytes: number;
	hash: string;
	title: SessionTitleUpdate | undefined;
	sessionId: string | undefined;
}

/**
 * Measure `lines` for a full write streamed from them ({@link streamLines}):
 * the size and SHA-256 of their UTF-8 bytes, and the title slot and the
 * header's session id read from their head ({@link linesHead}).
 */
function measureLines(lines: readonly string[]): MeasuredLines {
	return measuredLines(lines, digestChunksSync(encodeLineChunks(lines, true)));
}

/**
 * {@link measureLines} that lets the event loop run between chunks, for a
 * body prepared off it: the whole transcript is never read in one turn.
 */
async function measureLinesAsync(lines: readonly string[]): Promise<MeasuredLines> {
	return measuredLines(lines, await digestStream(yieldingChunks(lines)));
}

/**
 * The UTF-8 bytes of `lines` ({@link encodeLineChunks}), letting the event
 * loop run before each chunk after the first. Each chunk is a view of one
 * buffer that the next overwrites; the generator, and so the buffer, waits
 * while the event loop runs.
 */
async function* yieldingChunks(lines: readonly string[]): AsyncGenerator<Uint8Array> {
	let first = true;
	for (const chunk of encodeLineChunks(lines, true)) {
		if (!first) await Bun.sleep(0);
		first = false;
		yield chunk;
	}
}

/** The {@link MeasuredLines} of `lines`, whose UTF-8 bytes `digest` counts and hashes. */
function measuredLines(lines: readonly string[], digest: { hash: string; bytes: number }): MeasuredLines {
	const head = linesHead(lines);
	return {
		bytes: digest.bytes,
		hash: digest.hash,
		title: titleUpdateFromSlot(parseTitleSlotFromContent(head)),
		sessionId: sessionIdFromContent(head),
	};
}

/**
 * The UTF-8 bytes of `lines` ({@link encodeLineChunks}) for a backend's streamed
 * write, read from the lines again, letting the event loop run before each
 * chunk after the first, so a backend that takes them without waiting on I/O
 * between them still lets it run. Each chunk is a buffer of its own, so a
 * backend may keep it. The stream fails at its end, so the backend replaces
 * nothing, when they are not the bytes `measured` holds: the array changed
 * after it was measured, as the caller's array of a synchronous rewrite,
 * which is streamed from, can.
 */
async function* streamLines(lines: readonly string[], measured: MeasuredLines): AsyncGenerator<Uint8Array> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of encodeLineChunks(lines)) {
		if (bytes > 0) await Bun.sleep(0);
		hasher.update(chunk);
		bytes += chunk.byteLength;
		yield chunk;
	}
	if (bytes !== measured.bytes || hasher.digest("hex") !== measured.hash) {
		throw new Error(`The lines of a session rewrite changed after they were measured (${measured.bytes} bytes)`);
	}
}

/** A backend's streamed full write. */
type WriteFullStream = NonNullable<SessionStorageBackend["writeFullStream"]>;

/**
 * The bodies of the full writes of one store over `backend`, which a failed
 * publish compares with what `storedChunks` reads back.
 */
export class FullBodies {
	readonly #backend: SessionStorageBackend;
	readonly #storedChunks: (path: string, maxBytes: number) => AsyncIterable<Uint8Array>;
	/** Set once this store warned that a full rewrite could not use the spool. */
	#spoolFailureLogged = false;

	constructor(
		backend: SessionStorageBackend,
		storedChunks: (path: string, maxBytes: number) => AsyncIterable<Uint8Array>,
	) {
		this.#backend = backend;
		this.#storedChunks = storedChunks;
	}

	text(path: string, content: string): FullBody {
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		return {
			byteLength: Buffer.byteLength(content, "utf-8"),
			title,
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
				await this.#backend.writeFull(path, content, mtimeMs, title, expectedSize);
			},
			isStored: async () => (await this.#backend.readFull(path)) === content,
		};
	}

	/**
	 * The body of a full rewrite of `lines`, read from them now. A backend
	 * without a streamed write takes them joined into one string
	 * ({@link text}), returned at once: keeping them anywhere else first would
	 * only add a copy. For one with a streamed write they are spooled to a
	 * private temporary file, or, where the platform has no account id
	 * (Windows), kept compressed in memory, since there is no owner to check a
	 * spool directory against and a file takes its directory's access list.
	 * They are read from a copy of the array taken before the first await, so
	 * a caller that changes its array while the body is prepared changes no
	 * line of it and not its title. When the spool cannot be made, opened or
	 * written (`os.tmpdir()` read-only or full, or its spool directory not
	 * private to this account), the copy is measured, and streamed again when
	 * the body publishes ({@link #streamedBody}), and the store warns once.
	 * The spool's opens and writes, the compression, and that measure run off
	 * the event loop or between its turns, so it keeps running while a large
	 * body is prepared; {@link linesSync} does the same synchronously.
	 */
	lines(path: string, lines: readonly string[]): FullBody | Promise<FullBody> {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, lines.join(""));
		return this.#keptLines(path, lines, writeFullStream);
	}

	/** The body {@link lines} keeps for a backend with a streamed write, prepared off the event loop. */
	async #keptLines(path: string, lines: readonly string[], writeFullStream: WriteFullStream): Promise<FullBody> {
		// Taken before the first await: everything below reads the lines as they were handed over.
		const copy = lines.slice();
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, await snapshotLines(copy), writeFullStream);
		try {
			return this.#keptBody(path, await spoolLines(copy, uid), writeFullStream);
		} catch (err) {
			const spoolError = this.#spoolFailed(uid, err);
			return this.#streamedBody(path, copy, await measureLinesAsync(copy), spoolError, writeFullStream);
		}
	}

	/** {@link lines} through synchronous writes and compression, for a caller that cannot wait. */
	linesSync(path: string, lines: readonly string[]): FullBody {
		const writeFullStream = this.#backend.writeFullStream;
		if (!writeFullStream) return this.text(path, lines.join(""));
		const uid = process.getuid?.();
		if (uid === undefined) return this.#keptBody(path, snapshotLinesSync(lines), writeFullStream);
		try {
			return this.#keptBody(path, spoolLinesSync(lines, uid), writeFullStream);
		} catch (err) {
			const spoolError = this.#spoolFailed(uid, err);
			return this.#streamedBody(path, lines, measureLines(lines), spoolError, writeFullStream);
		}
	}

	/** The body `kept` holds, streamed from it, and compared with it after a failed publish. */
	#keptBody(path: string, kept: KeptBody, writeFullStream: WriteFullStream): FullBody {
		return {
			byteLength: kept.byteLength,
			title: kept.title,
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
				await writeFullStream.call(
					this.#backend,
					path,
					kept.chunks(),
					kept.byteLength,
					mtimeMs,
					kept.title,
					expectedSize,
				);
			},
			// Compared by size and SHA-256, chunk by chunk: only a backend without
			// `readChunks` reads the stored side whole.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path, kept.byteLength));
				if (stored.bytes !== kept.byteLength) return false;
				return stored.hash === (await digestStream(kept.chunks())).hash;
			},
			release: () => kept.close(),
		};
	}

	/** Warn, once for this store, that the spool of account `uid` failed with `err`; the failure's message. */
	#spoolFailed(uid: number, err: unknown): string {
		const spoolError = toError(err).message;
		if (!this.#spoolFailureLogged) {
			this.#spoolFailureLogged = true;
			logger.warn("Session rewrites stream straight to the store: their spool file cannot be used", {
				dir: getPrivateTempDir(SPOOL_DIR_PREFIX, uid),
				error: spoolError,
			});
		}
		return spoolError;
	}

	/**
	 * The body of a full rewrite of `lines` whose spool cannot be used:
	 * `measured` from them ({@link measureLines}, {@link measureLinesAsync}),
	 * and read from the lines again when it publishes through the backend's
	 * streamed write ({@link streamLines}). A publish that fails replaces
	 * nothing. The store logs the session, path and cause (and `spoolError`,
	 * why the spool failed) unless the backend reports a size conflict.
	 */
	#streamedBody(
		path: string,
		lines: readonly string[],
		measured: MeasuredLines,
		spoolError: string,
		writeFullStream: WriteFullStream,
	): FullBody {
		return {
			byteLength: measured.bytes,
			title: measured.title,
			publish: async (mtimeMs, expectedSize, mayPublish) => {
				if (mayPublish?.() === false) return;
				try {
					await writeFullStream.call(
						this.#backend,
						path,
						streamLines(lines, measured),
						measured.bytes,
						mtimeMs,
						measured.title,
						expectedSize,
					);
				} catch (err) {
					if (!(err instanceof SessionWriteConflictError)) {
						logger.error("Session rewrite not stored: its spool cannot be used, and streaming it failed", {
							session: measured.sessionId,
							path,
							error: toError(err).message,
							spoolError,
						});
					}
					throw err;
				}
			},
			// Compare by size and SHA-256, chunk by chunk, with what the lines measured.
			isStored: async () => {
				const stored = await digestStream(this.#storedChunks(path, measured.bytes));
				return stored.bytes === measured.bytes && stored.hash === measured.hash;
			},
		};
	}
}
