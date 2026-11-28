import * as path from "node:path";
import { ConcatSink, logger, toError } from "@oh-my-pi/pi-utils";
import { type FullBody, FullBodies } from "./session-body";
import {
	directChildKeyName,
	encodeLineChunks,
	SessionWriteConflictError,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "./session-storage";
import { enoent } from "./session-storage-errors";
import {
	overlayTitleSlotChunks,
	overlayTitleSlotContent,
	overlayTitleSlotPrefix,
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";
import { purgeDeletedSessionRows } from "./session-db-purge";

export interface SessionStorageIndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	title?: string;
	titleSource?: SessionTitleUpdate["source"];
	titleUpdatedAt?: string;
}

export interface SessionStorageBackend {
	init(): Promise<void>;
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>>;
	readFull(path: string): Promise<string | null>;
	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	/**
	 * The stored bytes from byte `fromByte` to the end, as chunks in order:
	 * what {@link readFull} returns from that offset, without holding it whole.
	 * Iterating rejects with ENOENT when `path` holds no session. Optional:
	 * without it the storage reads the whole session and cuts it.
	 */
	readChunks?(path: string, fromByte: number): AsyncIterable<Uint8Array>;
	/**
	 * Replace content, atomically rejecting when the shared backend's current
	 * UTF-8 byte length differs from `expectedSize`.
	 */
	writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void>;
	/**
	 * {@link writeFull} of the UTF-8 bytes `chunks` yields, `byteLength` in all,
	 * without holding them whole; the same size check, and the content replaced
	 * all at once. Consume the stream through its normal end before committing.
	 * A stream that fails or yields a different byte count replaces nothing.
	 * Optional: without it the storage passes one string to {@link writeFull}
	 * and keeps no spool for a rewrite.
	 */
	writeFullStream?(
		path: string,
		chunks: AsyncIterable<Uint8Array>,
		byteLength: number,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void>;
	append(path: string, line: string, mtimeMs: number): Promise<void>;
	/**
	 * Append `lines`, in order, as one write that stores all of them or none;
	 * `mtimeMs` is the last line's. Throw {@link SessionAppendBatchRolledBackError} only when
	 * the write is known to have stored none of them (its transaction rolled
	 * back before COMMIT): the storage then appends them again, one
	 * {@link append} each, each line taking its own outcome. Any other error
	 * fails every line, and none is appended again. Optional: without it the
	 * storage appends a path's queued lines one {@link append} each.
	 */
	appendBatch?(path: string, lines: readonly string[], mtimeMs: number): Promise<void>;
	updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void>;
	truncate(path: string, mtimeMs: number): Promise<void>;
	remove(paths: string[]): Promise<void>;
	move(src: string, dst: string, mtimeMs: number): Promise<void>;
}

/**
 * {@link SessionStorageBackend.appendBatch} stored none of its lines: its
 * transaction rolled back before COMMIT (a statement failed, such as the size
 * check, whose error is `cause`). The storage appends the lines again one at
 * a time, so each takes the outcome it would have had alone. Never leaves the
 * storage.
 */
export class SessionAppendBatchRolledBackError extends Error {
	readonly path: string;

	constructor(path: string, cause: unknown) {
		super(`Session append batch to ${path} rolled back before its commit: ${toError(cause).message}`, { cause });
		this.name = "SessionAppendBatchRolledBackError";
		this.path = path;
	}
}

interface IndexEntry {
	size: number;
	mtimeMs: number;
	title?: string;
	titleSource?: SessionTitleUpdate["source"];
	titleUpdatedAt?: string;
	/**
	 * Set on an entry restored after a failed removal: the backend may have
	 * deleted part of the path (Redis deletes the file key before the
	 * metadata), so only a later full write confirms it again.
	 */
	unconfirmed?: true;
}

interface EnqueueOptions {
	trackDrain: boolean;
	/**
	 * Use the uncaught per-path predecessor and call this instead of running the
	 * task if the predecessor fails. Appends opt in because they have no backend
	 * size check. Absolute writes can still run to converge after a failure.
	 */
	onPredecessorFailure?: (error: unknown) => void;
}

/** An asynchronous write's places in its paths' write order ({@link IndexedSessionStorage}'s `#reserveAsyncWrite`). */
interface AsyncWriteReservation {
	/** Resolves once the write's turn comes; rejects when a backend operation it waits for failed. */
	readonly turn: Promise<void>;
	/** Called once the write has settled or given up: the writes behind it may go once those ahead of it have. */
	readonly release: () => void;
}

/** Optimistic index entry a queued append installed, kept for failure rollback. */
interface IndexAppend {
	mtimeMs: number;
	previous: IndexEntry | undefined;
	/** Set when the queued op removes the path (unlink, delete, rename source). */
	removal?: true;
}

/**
 * A line queued on a path's append batch: its optimistic index frame, the
 * error of the writer that queued it, and its own outcome, which settles its
 * frame and its bytes of its store's queued appends ({@link AppendAdmission}).
 */
interface QueuedLine {
	readonly line: string;
	/** The line's UTF-8 byte length. */
	readonly bytes: number;
	readonly frame: IndexAppend;
	readonly getError: (() => Error | undefined) | undefined;
	readonly settled: PromiseWithResolvers<void>;
}

/**
 * Whether a batch's `lines` can go to the backend in one write with the
 * outcome each would have alone: no line's writer has failed, and each
 * line's frame starts at the size the line before it leaves, as lines
 * queued one after another do. A failed frame ahead of them can rebase one
 * line's frame; then each line goes alone.
 */
function appendsChain(lines: readonly QueuedLine[]): boolean {
	let size: number | undefined;
	for (const queued of lines) {
		if (queued.getError?.()) return false;
		const expected = queued.frame.previous?.size ?? 0;
		if (size !== undefined && expected !== size) return false;
		size = expected + queued.bytes;
	}
	return true;
}

const RESOLVED = Promise.resolve();

/**
 * UTF-8 bytes of appended lines that one {@link IndexedSessionStorage} holds
 * queued and unsettled, on all of its paths together, past which its
 * {@link IndexedSessionStorage.waitForAppendAdmission} waits. Not a hard
 * bound: a writer queues its line whatever the queue holds, so the queue
 * passes it by what they add while turns wait.
 */
const APPEND_ADMISSION_BYTES = 64 * 1024 * 1024;

/**
 * How long an admission waits before it logs a warning, once: queued lines
 * that take this long to settle (a backend whose connection hangs) hold every
 * turn on the store before each model request and each tool result.
 */
const APPEND_ADMISSION_WARN_MS = 10_000;

/**
 * One store's queued appends: the UTF-8 bytes of the lines every path of the
 * store queued, each counted from when it queues until its backend write
 * settles, either way; and the admissions waiting for them to fall to
 * {@link APPEND_ADMISSION_BYTES}.
 */
class AppendAdmission {
	#queuedBytes = 0;
	readonly #waiters = new Set<() => void>();

	/** Whether the queued bytes are at or under {@link APPEND_ADMISSION_BYTES}. */
	get admits(): boolean {
		return this.#queuedBytes <= APPEND_ADMISSION_BYTES;
	}

	queue(bytes: number): void {
		this.#queuedBytes += bytes;
	}

	settle(bytes: number): void {
		this.#queuedBytes -= bytes;
		if (!this.admits) return;
		for (const admit of this.#waiters) admit();
		this.#waiters.clear();
	}

	/**
	 * `undefined` at once, with nothing to await, while the queued bytes are at
	 * or under {@link APPEND_ADMISSION_BYTES} or `signal` has fired; else a
	 * promise that resolves once either holds.
	 */
	wait(signal: AbortSignal | undefined): Promise<void> | undefined {
		if (this.admits || signal?.aborted) return undefined;
		return this.#waitFor(signal);
	}

	async #waitFor(signal: AbortSignal | undefined): Promise<void> {
		const queuedBytes = this.#queuedBytes;
		const started = performance.now();
		const { promise, resolve } = Promise.withResolvers<void>();
		const admit = (): void => resolve();
		this.#waiters.add(admit);
		signal?.addEventListener("abort", admit, { once: true });
		const slow = setTimeout(() => {
			logger.warn("Session append admission still waiting", {
				queuedBytes: this.#queuedBytes,
				admissionBytes: APPEND_ADMISSION_BYTES,
				waitMs: Math.round(performance.now() - started),
			});
		}, APPEND_ADMISSION_WARN_MS);
		// The warning alone keeps no process alive.
		slow.unref();
		try {
			await promise;
		} finally {
			clearTimeout(slow);
			this.#waiters.delete(admit);
			signal?.removeEventListener("abort", admit);
		}
		logger.debug("Session append admission waited", { queuedBytes, waitMs: Math.round(performance.now() - started) });
	}
}

function matchesGlob(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function normalizeByteLimit(maxBytes: number): number {
	if (!(maxBytes > 0)) return 0;
	return Math.trunc(maxBytes);
}

function uniquePaths(paths: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}
function titleUpdateForIndex(entry: IndexEntry): SessionTitleUpdate | undefined {
	if (!entry.titleUpdatedAt) return undefined;
	return { title: entry.title, source: entry.titleSource, updatedAt: entry.titleUpdatedAt };
}

export class IndexedSessionStorage implements SessionStorage {
	/**
	 * Sync writes only update {@link #index} and queue the remote publish, so a
	 * caller tracking a durable byte size must wait for {@link drain}.
	 */
	readonly defersSyncPublish = true;
	readonly #backend: SessionStorageBackend;
	/** The bodies of this store's full writes. */
	readonly #bodies: FullBodies;
	readonly #index = new Map<string, IndexEntry>();
	readonly #writers = new Set<IndexedSessionStorageWriter>();
	readonly #pathTails = new Map<string, Promise<void>>();
	readonly #pathPending = new Map<string, Promise<void>>();
	readonly #drainPending = new Set<Promise<void>>();
	/**
	 * Live optimistic index frames per path, oldest first. Every synchronous
	 * index update whose backend op is still queued pushes a frame; settlement
	 * drops it (success) or drops it and every frame queued behind it and
	 * restores the earliest dropped frame's entry (failure). Rolling back to
	 * the last durable entry instead of the immediately previous one keeps a
	 * failed op in a chain from stranding later recovery rewrites on an
	 * unreachable CAS token (rJDg).
	 */
	readonly #pendingFrames = new Map<string, IndexAppend[]>();
	/**
	 * The append batch of each path that is still gathering lines: the last
	 * operation queued on the path, not started yet. A line queued for the
	 * path joins it; any other operation queued on the path, and the batch's
	 * own start, closes it, so later lines start the next batch.
	 */
	readonly #gathering = new Map<string, QueuedLine[]>();
	/** This store's queued appends, which its turns wait on ({@link waitForAppendAdmission}). */
	readonly #appendAdmission = new AppendAdmission();
	/**
	 * The last asynchronous write called on each path (`writeText`, the atomic
	 * writes, a title update, a rename, an unlink, a delete), as a promise that
	 * resolves, never rejects, once that write and every one called before it
	 * on its paths have settled. A write takes its place here when it is
	 * called ({@link #reserveAsyncWrite}), so the writes of a path go to the
	 * backend in call order, whatever each waits for first.
	 */
	readonly #asyncWriteTail = new Map<string, Promise<void>>();
	#nextMtimeMs = 0;
	#firstDrainError: Error | undefined;
	#assertExpectedSize(path: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		const actualSize = this.#index.get(path)?.size ?? null;
		if (actualSize !== expectedSize) {
			throw new SessionWriteConflictError(path, expectedSize, actualSize);
		}
	}

	constructor(backend: SessionStorageBackend) {
		this.#backend = backend;
		this.#bodies = new FullBodies(backend, (path, maxBytes) => this.#storedChunks(path, maxBytes));
	}

	async initialize(): Promise<void> {
		await this.#backend.init();
		await this.refresh();
	}

	async refresh(): Promise<void> {
		await this.drain();
		const rows = await this.#backend.loadIndex();
		this.#index.clear();
		for (const row of rows) {
			const title = row.titleUpdatedAt
				? { title: row.title, source: row.titleSource, updatedAt: row.titleUpdatedAt }
				: null;
			this.#setIndex(row.path, row.size, row.mtimeMs, title);
		}
	}

	async drain(): Promise<void> {
		// Quiesce EVERY pending backend operation, not just the drain-tracked
		// fire-and-forget publishes: an atomic write whose commit guard passed
		// just before a terminal seal is still on the wire with
		// `trackDrain: false`, and a graceful shutdown (SessionManager.close)
		// must not return while it can still publish under a reopened path.
		// An asynchronous write still waiting for its turn, or preparing its
		// body, has queued nothing yet, so its place in the write order counts too.
		while (this.#drainPending.size > 0 || this.#pathPending.size > 0 || this.#asyncWriteTail.size > 0) {
			await Promise.allSettled([
				...this.#drainPending,
				...this.#pathPending.values(),
				...this.#asyncWriteTail.values(),
			]);
		}
		const error = this.#firstDrainError;
		this.#firstDrainError = undefined;
		if (error) throw error;
	}

	ensureDirSync(_dir: string): void {
		// Indexed backends are flat: directories are derived from key prefixes.
	}

	existsSync(path: string): boolean {
		return this.#index.has(path);
	}

	existsConfirmedSync(path: string): boolean {
		const frames = this.#pendingFrames.get(path);
		if (!frames) {
			const entry = this.#index.get(path);
			return entry !== undefined && !entry.unconfirmed;
		}
		// A removal in flight can delete the content before its op settles (Redis deletes the
		// file key before the metadata), so the path is unconfirmed until the removal settles.
		if (frames.some(frame => frame.removal)) return false;
		// The oldest live frame's previous entry is the last state the backend confirmed.
		const confirmed = frames[0]?.previous;
		return confirmed !== undefined && !confirmed.unconfirmed;
	}

	/**
	 * Resolve once the publishes queued for `path` have settled, rejecting when
	 * one failed. The path tail is installed synchronously by `#enqueuePaths`,
	 * so a caller confirming immediately after `writeTextSync` observes its own
	 * write rather than a later one.
	 */
	confirmWrites(path: string): Promise<void> {
		return this.#awaitPath(path);
	}

	/**
	 * {@link SessionStorage.waitForAppendAdmission}. A wait lasts while the
	 * lines that every path of this store has queued to append hold more than
	 * 64 MiB, each counted from when it queues until its backend write
	 * settles, either way; another store's queue never holds it. That is where
	 * turns start to wait, not a hard bound: a writer's appends never wait. A
	 * wait that lasts 10 s logs a warning once, with the bytes queued then
	 * (`Session append admission still waiting`); a wait that waited logs the
	 * bytes queued when it began and how long it took (`Session append
	 * admission waited`).
	 */
	waitForAppendAdmission(signal?: AbortSignal): Promise<void> | undefined {
		return this.#appendAdmission.wait(signal);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#bodies.text(path, content), options?.expectedSize);
	}

	/**
	 * Streaming {@link writeTextSync}: for a backend with a streamed write,
	 * reads `lines` into a temporary file or, without an account id, into
	 * compressed blocks in memory, and publishes the body in chunks; for one
	 * without, publishes the joined lines (see {@link FullBodies.linesSync}).
	 */
	writeLinesSync(path: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.#assertExpectedSize(path, options?.expectedSize);
		this.#queueFullWrite(path, this.#bodies.linesSync(path, lines), options?.expectedSize);
	}

	/** Install `body` in the index and queue its publish, tracked by {@link drain}. */
	#queueFullWrite(path: string, body: FullBody, expectedSize: number | null | undefined): void {
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		this.#setIndex(path, body.byteLength, mtimeMs, body.title ?? null);
		this.#pushFrame(path, { mtimeMs, previous });
		const write = this.#enqueuePath(path, () => body.publish(mtimeMs, expectedSize), { trackDrain: true });
		this.#trackFrame(path, mtimeMs, write);
		if (body.release) void write.then(body.release, body.release);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate): Promise<void> {
		await this.#inAsyncWriteOrder([path], async () => {
			const previous = this.#index.get(path);
			if (!previous) throw enoent(path);
			const mtimeMs = this.#allocMtimeMs();
			const next = {
				...previous,
				title: title.title,
				titleSource: title.source,
				titleUpdatedAt: title.updatedAt,
				mtimeMs,
			};
			this.#index.set(path, next);
			this.#pushFrame(path, { mtimeMs, previous });
			const pending = this.#enqueuePath(path, () => this.#backend.updateSessionTitle(path, title, mtimeMs), {
				trackDrain: false,
			});
			this.#trackFrame(path, mtimeMs, pending);
			try {
				await pending;
			} catch (err) {
				throw toError(err);
			}
		});
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const resolvedDir = path.resolve(dir);
		const out: string[] = [];
		for (const key of this.#index.keys()) {
			const name = directChildKeyName(resolvedDir, key);
			if (name === undefined || !matchesGlob(name, pattern)) continue;
			out.push(key);
		}
		return out;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	async readText(path: string): Promise<string> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		await this.#awaitPath(path);
		const content = await this.#backend.readFull(path);
		if (content === null) throw enoent(path);
		const title = titleUpdateForIndex(entry);
		return title ? overlayTitleSlotContent(content, title) : content;
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		const prefixLimit = normalizeByteLimit(prefixBytes);
		const suffixLimit = normalizeByteLimit(suffixBytes);
		if (prefixLimit === 0 && suffixLimit === 0) return ["", ""];
		await this.#awaitPath(path);
		const [prefix, suffix] = await this.#backend.readSlices(path, prefixLimit, suffixLimit);
		const title = titleUpdateForIndex(entry);
		return [title ? overlayTitleSlotPrefix(prefix, prefixLimit, title) : prefix, suffix];
	}

	/** The stored bytes from a backend that advertised chunked reads in the constructor. */
	#backendChunks(path: string, fromByte: number): AsyncIterable<Uint8Array> {
		return this.#backend.readChunks!(path, fromByte);
	}

	/**
	 * Bytes for read-back verification, chunked by the backend or encoded from
	 * a whole read. Neither is read past the first chunk that exceeds the
	 * intended size: the stored body differs from it once it does.
	 */
	async *#storedChunks(path: string, maxBytes: number): AsyncGenerator<Uint8Array> {
		let chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
		if (this.#backend.readChunks) {
			chunks = this.#backendChunks(path, 0);
		} else {
			const content = await this.#backend.readFull(path);
			if (content === null) throw enoent(path);
			chunks = encodeLineChunks([content], true);
		}
		let bytes = 0;
		for await (const chunk of chunks) {
			bytes += chunk.byteLength;
			yield chunk;
			if (bytes > maxBytes) return;
		}
	}

	async *#scanChunks(path: string): AsyncGenerator<Uint8Array> {
		const entry = this.#index.get(path);
		if (!entry) throw enoent(path);
		await this.#awaitPath(path);
		const title = titleUpdateForIndex(entry);
		const chunks = this.#backendChunks(path, 0);
		yield* title ? overlayTitleSlotChunks(chunks, title, 0) : chunks;
	}

	async scanLines(path: string, visit: (line: string) => boolean): Promise<void> {
		if (!this.#backend.readChunks) {
			for (const line of (await this.readText(path)).split("\n")) {
				if (visit(line)) return;
			}
			return;
		}
		// Preserve a byte order mark in any line, matching readText().split("\n").
		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const lines = new ConcatSink();
		for await (const chunk of this.#scanChunks(path)) {
			for (const line of lines.appendAndFlushLines(chunk)) {
				if (visit(decoder.decode(line))) return;
			}
		}
		// The text after the last newline, "" when the file ends with one, as `split("\n")` yields it.
		visit(decoder.decode(lines.flush()));
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.#inAsyncWriteOrder([path], async () => {
			const previous = this.#index.get(path);
			const mtimeMs = this.#allocMtimeMs();
			const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
			this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
			this.#pushFrame(path, { mtimeMs, previous });
			const pending = this.#enqueuePath(path, () => this.#backend.writeFull(path, content, mtimeMs, title), {
				trackDrain: false,
			});
			this.#trackFrame(path, mtimeMs, pending);
			await pending;
		});
	}

	async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		await this.#publishAtomic(path, options, () => this.#bodies.text(path, content));
	}

	/**
	 * Streaming {@link writeTextAtomic}: for a backend with a streamed write,
	 * spools `lines` to a temporary file through asynchronous writes and
	 * publishes it from there, and after a failed publish compares the stored
	 * bytes with the spool by size and SHA-256; for one without, publishes the
	 * joined lines (see {@link FullBodies.lines}).
	 */
	async writeLinesAtomic(path: string, lines: readonly string[], options?: WriteTextAtomicOptions): Promise<void> {
		await this.#publishAtomic(path, options, () => this.#bodies.lines(path, lines));
	}

	/**
	 * Publish the body `prepare` makes once the guards pass, then settle the
	 * optimistic index frame: a failed publish whose body the backend holds
	 * anyway counts as landed. The write takes its place among the path's
	 * asynchronous writes when it is called ({@link #reserveAsyncWrite}) and
	 * prepares its body at once, while the writes called before it settle; a
	 * write called after it waits until it has settled (its publish and any
	 * read-back, or its failed preparation) and so have the writes called
	 * before it. A synchronous write (`writeTextSync`, a writer's append)
	 * still queues at once, ahead of the publish, since it sets the index at
	 * once. A body prepared at once adds no turn before the index takes it, as
	 * one prepared off the event loop must.
	 */
	async #publishAtomic(
		path: string,
		options: WriteTextAtomicOptions | undefined,
		prepare: () => FullBody | Promise<FullBody>,
	): Promise<void> {
		const commitGuard = options?.commitGuard;
		if (commitGuard && !commitGuard()) return;
		const reservation = this.#reserveAsyncWrite([path]);
		// Awaited once the body is prepared. A preparation that fails leaves it unawaited, and a failure of what
		// it waits for belongs to that operation's caller, not to an unhandled rejection here.
		reservation.turn.catch(() => {});
		let body: FullBody | undefined;
		try {
			const prepared = prepare();
			const ready = prepared instanceof Promise ? await prepared : prepared;
			body = ready;
			await reservation.turn;
			// A concurrent flushSync (writeTextSync) may have taken over while the
			// body was prepared or the earlier writes settled, and bumped the epoch.
			// Re-check before touching the index or enqueueing the backend publish.
			if (commitGuard && !commitGuard()) return;
			this.#assertExpectedSize(path, options?.expectedSize);
			const previous = this.#index.get(path);
			const mtimeMs = this.#allocMtimeMs();
			this.#setIndex(path, ready.byteLength, mtimeMs, ready.title ?? null);
			this.#pushFrame(path, { mtimeMs, previous });
			const mayPublish =
				commitGuard &&
				(() => {
					if (commitGuard()) return true;
					// Do not restore over a newer optimistic entry.
					const current = this.#index.get(path);
					if (current?.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
					this.#abandonFrame(path, mtimeMs);
					return false;
				});
			try {
				await this.#enqueuePath(path, () => ready.publish(mtimeMs, options?.expectedSize, mayPublish), {
					trackDrain: false,
				});
				this.#dropFrame(path, mtimeMs);
			} catch (err) {
				const error = toError(err);
				try {
					if (await ready.isStored()) {
						this.#dropFrame(path, mtimeMs);
						return;
					}
				} catch {
					// Preserve the original write failure; verification was unavailable.
				}
				this.#failFrame(path, mtimeMs);
				throw error;
			}
		} finally {
			reservation.release();
			body?.release?.();
		}
	}

	async rename(src: string, dst: string): Promise<void> {
		// Both paths take their places at once: a write to either called after the rename lands after it.
		await this.#inAsyncWriteOrder([src, dst], async () => {
			const entry = this.#index.get(src);
			if (!entry) throw enoent(src);
			if (src === dst) {
				await this.#enqueuePath(src, () => this.#backend.move(src, dst, entry.mtimeMs), { trackDrain: false });
				return;
			}
			const dstPrevious = this.#index.get(dst);
			this.#index.delete(src);
			this.#index.set(dst, { ...entry });
			this.#pushFrame(src, { mtimeMs: entry.mtimeMs, previous: entry, removal: true });
			this.#pushFrame(dst, { mtimeMs: entry.mtimeMs, previous: dstPrevious });
			try {
				await this.#enqueuePaths([src, dst], () => this.#backend.move(src, dst, entry.mtimeMs), {
					trackDrain: false,
				});
				this.#dropFrame(src, entry.mtimeMs);
				this.#dropFrame(dst, entry.mtimeMs);
			} catch (err) {
				this.#failFrame(src, entry.mtimeMs);
				this.#failFrame(dst, entry.mtimeMs);
				throw toError(err);
			}
		});
	}

	async unlink(path: string): Promise<void> {
		await this.#inAsyncWriteOrder([path], async () => {
			const previous = this.#index.get(path);
			if (!previous) throw enoent(path);
			this.#index.delete(path);
			this.#pushFrame(path, { mtimeMs: previous.mtimeMs, previous, removal: true });
			try {
				await this.#enqueuePath(path, () => this.#backend.remove([path]), { trackDrain: false });
				this.#dropFrame(path, previous.mtimeMs);
			} catch (err) {
				this.#failFrame(path, previous.mtimeMs);
				throw toError(err);
			}
		});
	}

	async deleteSessionWithArtifacts(
		sessionPath: string,
		options?: { historyDbPath?: string; statsDbPath?: string },
	): Promise<void> {
		const artifactsDir = sessionPath.slice(0, -6);
		const prefix = artifactsDir.endsWith("/") ? artifactsDir : `${artifactsDir}/`;
		const sessionPaths = (): string[] => [
			sessionPath,
			...[...this.#index.keys()].filter(key => key.startsWith(prefix)),
		];
		// The session and the artifacts indexed now take their places at once.
		await this.#inAsyncWriteOrder(sessionPaths(), async () => {
			const sessionEntry = this.#index.get(sessionPath);
			if (!sessionEntry) throw enoent(sessionPath);
			// Capture the transcript before removal. History/stats are purged only
			// after the backend remove succeeds, so a failed delete does not drop
			// rows for a session that is still listed. An unreadable transcript
			// still deletes; its id cannot be resolved.
			let content: string | undefined;
			try {
				content = await this.readText(sessionPath);
			} catch {}

			// An artifact indexed since the call is removed too, once what is queued on it settles.
			const paths = sessionPaths();
			for (const path of paths) await this.#awaitPath(path);

			const previous = new Map<string, IndexEntry>();
			for (const path of paths) {
				const entry = this.#index.get(path);
				if (entry) previous.set(path, entry);
				this.#index.delete(path);
			}
			for (const [path, entry] of previous) {
				this.#pushFrame(path, { mtimeMs: sessionEntry.mtimeMs, previous: entry, removal: true });
			}

			try {
				await this.#enqueuePaths(paths, () => this.#backend.remove(paths), { trackDrain: false });
				for (const [path] of previous) this.#dropFrame(path, sessionEntry.mtimeMs);
			} catch (err) {
				for (const [path] of previous) this.#failFrame(path, sessionEntry.mtimeMs);
				throw toError(err);
			}

			// Best-effort: a busy dashboard store never fails the delete itself.
			try {
				purgeDeletedSessionRows(sessionPath, {
					content,
					historyDbPath: options?.historyDbPath,
					statsDbPath: options?.statsDbPath,
				});
			} catch {}
		});
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = new IndexedSessionStorageWriter(this, path, options);
		this.#writers.add(writer);
		return writer;
	}

	_writerClosed(writer: IndexedSessionStorageWriter): void {
		this.#writers.delete(writer);
	}

	_truncateForWriter(path: string): number {
		const mtimeMs = this.#allocMtimeMs();
		this.#pushFrame(path, { mtimeMs, previous: this.#index.get(path) });
		this.#setIndex(path, 0, mtimeMs, null);
		return mtimeMs;
	}

	_queueTruncate(path: string, mtimeMs: number, getError?: () => Error | undefined): Promise<void> {
		const tracked = this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.truncate(path, mtimeMs);
			},
			{ trackDrain: true },
		);
		this.#trackFrame(path, mtimeMs, tracked);
		return tracked;
	}

	_appendForWriter(path: string, line: string): IndexAppend & { bytes: number } {
		const mtimeMs = this.#allocMtimeMs();
		const previous = this.#index.get(path);
		const bytes = byteLength(line);
		this.#setIndex(path, (previous?.size ?? 0) + bytes, mtimeMs);
		return { mtimeMs, previous, bytes };
	}

	/**
	 * Queue the publish of `line` on `path`: it joins the path's batch still
	 * gathering lines ({@link #gathering}), or starts one, which goes to the
	 * backend once the path's earlier operations settle. The promise is the
	 * line's own outcome; its index frame and its bytes of this store's
	 * queued appends ({@link #appendAdmission}) settle with it.
	 */
	_queueAppend(
		path: string,
		line: string,
		append: IndexAppend & { bytes: number },
		getError?: () => Error | undefined,
	): Promise<void> {
		const { mtimeMs, bytes } = append;
		this.#pushFrame(path, append);
		const queued: QueuedLine = { line, bytes, frame: append, getError, settled: Promise.withResolvers() };
		const gathering = this.#gathering.get(path);
		if (gathering) gathering.push(queued);
		else this.#queueBatch(path, [queued]);
		this.#appendAdmission.queue(bytes);
		const settled = queued.settled.promise;
		void settled.then(
			() => {
				this.#appendAdmission.settle(bytes);
				this.#dropFrame(path, mtimeMs);
			},
			() => {
				this.#appendAdmission.settle(bytes);
				this.#failFrame(path, mtimeMs);
			},
		);
		return settled;
	}

	/**
	 * Queue an append batch of `lines` on `path`, which gathers lines until it
	 * starts. Each line settles before the batch's operation does, so its
	 * frame has settled when anything awaiting the path resumes: on success as
	 * its write lands; on failure, every line not settled yet, with the
	 * batch's error, also when a failed predecessor skips the batch.
	 */
	#queueBatch(path: string, lines: QueuedLine[]): void {
		const fail = (err: unknown): void => {
			if (this.#gathering.get(path) === lines) this.#gathering.delete(path);
			const error = toError(err);
			// The serial path clears each settled slot. forEach skips those slots.
			lines.forEach(queued => queued.settled.reject(error));
		};
		this.#enqueuePath(
			path,
			async () => {
				if (this.#gathering.get(path) === lines) this.#gathering.delete(path);
				try {
					await this.#appendLines(path, lines);
				} catch (err) {
					fail(err);
					throw err;
				}
			},
			{ trackDrain: true, onPredecessorFailure: fail },
		);
		this.#gathering.set(path, lines);
	}

	/**
	 * Publish a batch's lines, in order: in one backend `appendBatch` when the
	 * backend has one and the lines chain ({@link appendsChain}), each line
	 * settling with it; else, and again after a batch the backend rolled back,
	 * one `append` each, each line settling with its own write and the first
	 * failure failing the rest, as a path's queue fails the operations behind
	 * a failed one. A batch that fails otherwise fails every line: whether it
	 * stored them is unknown, so none is appended again.
	 */
	async #appendLines(path: string, lines: QueuedLine[]): Promise<void> {
		if (this.#backend.appendBatch && lines.length > 1 && appendsChain(lines)) {
			try {
				await this.#backend.appendBatch(
					path,
					lines.map(queued => queued.line),
					lines[lines.length - 1].frame.mtimeMs,
				);
				for (const queued of lines) queued.settled.resolve();
				return;
			} catch (err) {
				if (!(err instanceof SessionAppendBatchRolledBackError)) throw err;
			}
		}
		for (let i = 0; i < lines.length; i++) {
			const queued = lines[i];
			const error = queued.getError?.();
			if (error) throw error;
			await this.#backend.append(path, queued.line, queued.frame.mtimeMs);
			delete lines[i];
			queued.settled.resolve();
		}
	}

	#restoreIndex(path: string, entry: IndexEntry | undefined): void {
		if (entry) {
			this.#index.set(path, entry);
		} else {
			this.#index.delete(path);
		}
	}

	#setIndex(
		path: string,
		size: number,
		mtimeMs: number,
		title: SessionTitleUpdate | null | undefined = undefined,
	): void {
		const current = title === undefined ? this.#index.get(path) : undefined;
		this.#index.set(path, {
			size,
			mtimeMs,
			title: title === undefined ? current?.title : (title?.title ?? undefined),
			titleSource: title === undefined ? current?.titleSource : (title?.source ?? undefined),
			titleUpdatedAt: title === undefined ? current?.titleUpdatedAt : (title?.updatedAt ?? undefined),
			// An append extends the current content, so it does not restore what a failed removal deleted.
			...(current?.unconfirmed ? { unconfirmed: true } : {}),
		});
		if (mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = mtimeMs;
	}

	#allocMtimeMs(): number {
		const now = Date.now();
		const next = now > this.#nextMtimeMs ? now : this.#nextMtimeMs + 1;
		this.#nextMtimeMs = next;
		return next;
	}

	#enqueuePath(path: string, task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
		return this.#enqueuePaths([path], task, options);
	}

	#pushFrame(path: string, frame: IndexAppend): void {
		const frames = this.#pendingFrames.get(path);
		if (frames) frames.push(frame);
		else this.#pendingFrames.set(path, [frame]);
	}

	#dropFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index >= 0) frames.splice(index, 1);
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Drop the frame of an op that never published. A newer frame was queued
	 * on top of this op's unpublished entry, so it inherits this frame's
	 * previous entry, keeping the oldest live frame's previous durable state.
	 */
	#abandonFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index < 0) return;
		const [abandoned] = frames.splice(index, 1);
		const next = frames[index];
		if (abandoned && next) next.previous = abandoned.previous;
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Settle a failed optimistic frame. The frame drops; when newer frames
	 * are still live their publishes will converge the backend past this
	 * failure, so the next frame rebases onto this frame's previous instead
	 * of restoring it. When no newer frame lives, restore this frame's
	 * previous unless a newer mutation committed meanwhile: a failure that
	 * settles outside the queue (the atomic write's gated readback) can
	 * land after a newer write committed and dropped its frame, and
	 * restoring then would clobber newer durable state (F1). Index mtimes
	 * are unique per mutation, so a live entry carrying a different mtime
	 * proves a newer commit won; an absent entry (unlink/rename-src
	 * bookkeeping) or our own optimistic entry still restores. Rebased
	 * chains stay exact: the oldest live frame's previous is always
	 * durable state. A failed removal may have deleted part of the path
	 * before it failed, so the entry it hands on is marked unconfirmed.
	 */
	#failFrame(path: string, mtimeMs: number): void {
		const frames = this.#pendingFrames.get(path);
		if (!frames) return;
		const index = frames.findIndex(frame => frame.mtimeMs === mtimeMs);
		if (index < 0) return;
		const [failed] = frames.splice(index, 1);
		if (failed === undefined) return;
		const next = frames[index];
		const previous =
			failed.removal && failed.previous ? { ...failed.previous, unconfirmed: true as const } : failed.previous;
		if (next === undefined) {
			const current = this.#index.get(path);
			if (current === undefined || current.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
		} else next.previous = previous;
		if (frames.length === 0) this.#pendingFrames.delete(path);
	}

	/**
	 * Settle an optimistic frame when its queued backend op settles: success
	 * drops the frame (its entry is durable), failure folds it via #failFrame.
	 */
	#trackFrame(path: string, mtimeMs: number, tracked: Promise<void>): void {
		void tracked.then(
			() => this.#dropFrame(path, mtimeMs),
			() => this.#failFrame(path, mtimeMs),
		);
	}

	#enqueuePaths(paths: readonly string[], task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
		const unique = uniquePaths(paths);
		// A line queued after this operation must not join a batch ahead of it.
		for (const path of unique) this.#gathering.delete(path);
		// Predecessor choice (rJDg): a positional publish with no backend CAS
		// token (backend.append) chains on the uncaught pending op so it
		// fail-fasts behind a failed op instead of landing on a body the
		// backend never accepted. Absolute publishes carry their own backend
		// validation and chain on the caught tail, so a superseding publish
		// still runs to converge (e.g. a newer title update over a failed one).
		const { onPredecessorFailure } = options;
		const previous = unique.map(
			path => (onPredecessorFailure ? this.#pathPending.get(path) : this.#pathTails.get(path)) ?? RESOLVED,
		);
		const operation = Promise.all(previous).then(
			task,
			onPredecessorFailure &&
				(err => {
					onPredecessorFailure(err);
					throw err;
				}),
		);
		const tracked = operation.catch(err => {
			const error = toError(err);
			if (options.trackDrain && !this.#firstDrainError) this.#firstDrainError = error;
			throw error;
		});
		const tail = tracked.catch(() => {});
		for (const path of unique) {
			this.#pathTails.set(path, tail);
			this.#pathPending.set(path, tracked);
		}
		tail.finally(() => {
			for (const path of unique) {
				if (this.#pathTails.get(path) === tail) this.#pathTails.delete(path);
			}
		});
		tracked
			.finally(() => {
				for (const path of unique) {
					if (this.#pathPending.get(path) === tracked) this.#pathPending.delete(path);
				}
			})
			.catch(() => {});
		tracked.catch(() => {});
		if (options.trackDrain) {
			this.#drainPending.add(tracked);
			tracked
				.finally(() => {
					this.#drainPending.delete(tracked);
				})
				.catch(() => {});
		}
		return tracked;
	}

	#awaitPath(path: string): Promise<void> {
		// The caller waits for what is queued now: a line queued after this goes in a batch of its own.
		this.#gathering.delete(path);
		return this.#pathPending.get(path) ?? RESOLVED;
	}

	/**
	 * Take the places of an asynchronous write on `paths` in their write order
	 * ({@link #asyncWriteTail}), all at once, before the write's first await.
	 * `turn` resolves once every asynchronous write called before it on any of
	 * `paths` has settled, whatever its outcome, and then once the backend
	 * operations queued on `paths` at that moment (the synchronous writes'; with
	 * no write ahead, those queued now) have settled, rejecting when one of
	 * those failed. `release`, called once the write has settled or given up,
	 * lets the writes behind it go, but never before the writes ahead of it: a
	 * write that fails early rejects only its own caller, and lets no later
	 * write past those ahead of it.
	 */
	#reserveAsyncWrite(paths: readonly string[]): AsyncWriteReservation {
		const unique = uniquePaths(paths);
		const ahead: Promise<void>[] = [];
		for (const path of unique) {
			const tail = this.#asyncWriteTail.get(path);
			if (tail) ahead.push(tail);
		}
		const settled = Promise.withResolvers<void>();
		const tail = ahead.length === 0 ? settled.promise : Promise.all([...ahead, settled.promise]).then(() => {});
		for (const path of unique) this.#asyncWriteTail.set(path, tail);
		void tail.then(() => {
			for (const path of unique) {
				if (this.#asyncWriteTail.get(path) === tail) this.#asyncWriteTail.delete(path);
			}
		});
		const queued = (): Promise<void> =>
			unique.length === 1
				? this.#awaitPath(unique[0])
				: Promise.all(unique.map(path => this.#awaitPath(path))).then(() => {});
		return {
			turn: ahead.length === 0 ? queued() : Promise.all(ahead).then(queued),
			release: () => settled.resolve(),
		};
	}

	/** Run `write` in the asynchronous write order of `paths` ({@link #reserveAsyncWrite}) once its turn comes. */
	async #inAsyncWriteOrder(paths: readonly string[], write: () => Promise<void>): Promise<void> {
		const reservation = this.#reserveAsyncWrite(paths);
		try {
			await reservation.turn;
			await write();
		} finally {
			reservation.release();
		}
	}
}

class IndexedSessionStorageWriter implements SessionStorageWriter {
	#storage: IndexedSessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;
	#pendingChain: Promise<void> = Promise.resolve();

	constructor(
		storage: IndexedSessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			const mtimeMs = storage._truncateForWriter(path);
			this.#trackPromise(storage._queueTruncate(path, mtimeMs, () => this.#error));
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	#trackPromise(promise: Promise<void>): Promise<void> {
		const next = this.#pendingChain.then(async () => {
			if (this.#error) throw this.#error;
			try {
				await promise;
			} catch (err) {
				throw this.#recordError(err);
			}
		});
		this.#pendingChain = next.catch(() => {});
		return next;
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		// Local index is updated immediately; remote publish stays ordered on the
		// path queue. Callers that need remote durability still await append()/flush().
		const append = this.#storage._appendForWriter(this.#path, line);
		void this.#trackPromise(this.#storage._queueAppend(this.#path, line, append, () => this.#error));
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const append = this.#storage._appendForWriter(this.#path, line);
		await this.#trackPromise(this.#storage._queueAppend(this.#path, line, append, () => this.#error));
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
		await this.#pendingChain;
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.flush();
		} finally {
			this.#storage._writerClosed(this);
		}
	}

	getError(): Error | undefined {
		return this.#error;
	}
}
