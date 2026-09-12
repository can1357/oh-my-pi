import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, peekFileEnds, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { overlayTitleSlotContent, type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
}

export interface SessionStorageWriter {
	/**
	 * Append one newline-terminated line.
	 *
	 * File and memory storage apply the line synchronously before the returned
	 * promise settles, so a software crash after `append` returns (or after a
	 * fire-and-forget call begins) still sees the entry on disk / in body. No
	 * `fsync` — power loss may still drop the last page. Indexed backends update
	 * the local index immediately and queue the remote publish in call order.
	 *
	 * `line` MUST include the trailing newline.
	 */
	append(line: string): Promise<void>;
	/**
	 * Synchronous append when the backend can apply the line before return.
	 * File and memory implement this so {@link SessionManager} can latch the
	 * first write failure before the appending call returns (surfaced by a later
	 * flushSync/close/next append — the turn loop does not throw from append).
	 * Indexed backends update the local index immediately and queue remote I/O.
	 */
	appendSync?(line: string): void;
	/** Resolve once all queued appends complete. No fsync. */
	flush(): Promise<void>;
	/** Drain synchronously flushable queued work when the backend supports it. No fsync. */
	flushSync?(): void;
	/** False once close() has begun/finished. */
	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

/** Optimistic precondition for replacing a session file. */
export interface SessionStorageWriteOptions {
	/** Current UTF-8 byte length, or `null` when the target must not exist. */
	expectedSize?: number | null;
}

/**
 * The session changed after a writer loaded it, so replacing it would discard
 * another writer's durable entries.
 */
export class SessionWriteConflictError extends Error {
	readonly path: string;
	readonly expectedSize: number | null;
	readonly actualSize: number | null;

	constructor(path: string, expectedSize: number | null, actualSize: number | null) {
		const expected = expectedSize === null ? "missing" : `${expectedSize} bytes`;
		const actual = actualSize === null ? "missing" : `${actualSize} bytes`;
		super(`Session file changed before rewrite: ${path} (expected ${expected}, found ${actual}).`);
		this.name = "SessionWriteConflictError";
		this.path = path;
		this.expectedSize = expectedSize;
		this.actualSize = actualSize;
	}
}

/**
 * The file publish lock is held by another live writer, so freshness cannot
 * be established. Fail-closed: the staged rewrite is discarded without
 * publishing.
 */
export class SessionLockError extends Error {
	readonly path: string;

	constructor(path: string, detail: string) {
		super(
			`Session publish lock unavailable for ${path}: ${detail}. ` +
				`The staged rewrite was discarded without publishing.`,
		);
		this.name = "SessionLockError";
		this.path = path;
	}
}

/**
 * Optional guards applied by {@link SessionStorage.writeTextAtomic}. The
 * backend MUST check `expectedSize` and call `commitGuard()` synchronously
 * immediately before it makes the staged content visible at `path`. Failed
 * preconditions leave the target untouched. Backends MUST NOT yield between
 * the checks and publishing the write.
 */
export interface WriteTextAtomicOptions extends SessionStorageWriteOptions {
	commitGuard?: () => boolean;
}

export interface SessionStorage {
	/**
	 * `true` when synchronous writes ({@link writeTextSync} and a writer's
	 * {@link SessionStorageWriter.appendSync}) have reached the backing store by
	 * the time they return. File and memory backends apply them in-body and
	 * leave this unset. Indexed backends only update the local index and queue
	 * the remote publish, so a caller that tracks a durable byte size (such as
	 * `SessionManager`) must wait for {@link drain} to confirm before it
	 * advances that size.
	 */
	readonly defersSyncPublish?: boolean;
	/**
	 * Resolve once every write this storage queued for `path` has been confirmed
	 * by, or rejected by, the backing store. In-body backends never queue, so
	 * they omit this; {@link defersSyncPublish} marks the backends that provide
	 * it.
	 */
	confirmWrites?(path: string): Promise<void>;
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void;
	/**
	 * Update the current session title through the storage backend.
	 *
	 * File-like backends rewrite the fixed-width JSONL title slot; indexed
	 * backends can store the semantic title fields and synthesize the slot when
	 * reading.
	 */
	updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void>;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	/** Read the requested UTF-8 byte windows from the head and tail of the file. */
	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
	rename(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
	/**
	 * Wait for every backing write scheduled by this storage to become durably
	 * visible. Sync backends (file, memory) return immediately because their
	 * writes complete in-body; async backends (Redis/SQL via
	 * {@link IndexedSessionStorage}) await their per-path queues so a caller
	 * driving a graceful shutdown does not exit while a fire-and-forget
	 * `writeTextSync` publish is still on the wire.
	 */
	drain(): Promise<void>;
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

class FileSessionStorageWriter implements SessionStorageWriter {
	#fd: number;
	#fpath: string;
	#publishLock: ((task: () => void) => void) | undefined;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		fpath: string,
		options?: {
			flags?: "a" | "w";
			onError?: (err: Error) => void;
			publishLock?: (task: () => void) => void;
		},
	) {
		this.#fpath = fpath;
		this.#publishLock = options?.publishLock;
		this.#onError = options?.onError;
		const flags = options?.flags ?? "a";
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime
		this.#fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}

	/**
	 * A publish that renamed a fresh file over the session path leaves this
	 * writer's descriptor on the orphaned previous inode, where the append would
	 * be silently lost. Under the publish lock no cooperating replacement can
	 * interleave, so re-open the live path when its identity changed.
	 */
	#reopenIfReplaced(): void {
		let live: fs.Stats;
		try {
			live = fs.statSync(this.#fpath);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		if (live.ino === fs.fstatSync(this.#fd).ino) return;
		const nextFd = fs.openSync(this.#fpath, "a");
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Replacing the descriptor abandoned the old one; nothing else to do.
		}
		this.#fd = nextFd;
		writerRegistry.register(this, nextFd, this);
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	#writeNow(line: string): void {
		const originalSize = fs.fstatSync(this.#fd).size;
		const buf = Buffer.from(line, "utf-8");
		let offset = 0;
		try {
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (writeError) {
			try {
				fs.ftruncateSync(this.#fd, originalSize);
			} catch (rollbackError) {
				throw new AggregateError(
					[toError(writeError), toError(rollbackError)],
					"Session append failed and its partial bytes could not be rolled back",
				);
			}
			throw writeError;
		}
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		// Write in-body so software crash after the call still sees the entry.
		// Microtask batching used to leave completed transcript lines only in
		// memory until the next event-loop turn; process crash then lost every
		// post-checkpoint event. flush/flushSync remain no-op drains (no fsync).
		// The publish lock serializes the append against a concurrent rewrite's
		// check-then-rename, which would otherwise erase the appended turn.
		try {
			if (this.#publishLock) {
				this.#publishLock(() => {
					this.#reopenIfReplaced();
					this.#writeNow(line);
				});
			} else {
				this.#writeNow(line);
			}
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// Unregister from finalization - we're closing properly
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Ignore close errors
		}
		if (this.#error) throw this.#error;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

/**
 * Cross-process publish serialization for the file backend. The guard-then-
 * rename sequence in `writeTextSync`/`writeTextAtomic` is synchronous (no
 * in-process interleave is possible), but a second terminal runs in another
 * process: without a shared lock its append can land between our freshness
 * check and our rename, and the rename then erases it. Every cooperating
 * writer holds this lockfile across check-then-publish, so the window only
 * remains for non-cooperating writers (plain editors), against which the
 * size check still fails closed whenever the skew is detectable.
 *
 * The lock is held for microseconds (a stat plus one or two renames) and the
 * region never yields, so in-process contention is impossible; cross-process
 * contention fails closed after a short bounded wait instead of blocking the
 * turn loop. A lock whose holder pid is dead is stolen; any other lock is
 * never touched (stealing a live holder would reopen the race). Malformed
 * lock content is treated as live: fail closed, never steal garbage.
 */
const SESSION_PUBLISH_LOCK_WAIT_MS = 500;
const SESSION_PUBLISH_LOCK_POLL_MS = 2;

const publishLockSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms: number): void {
	if ("sleepSync" in Bun && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	Atomics.wait(publishLockSleepBuffer, 0, 0, ms);
}

function publishLockPid(content: string): number | undefined {
	const match = /^(\d+):(\d+)\s*$/.exec(content);
	if (!match) return undefined;
	const pid = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no such process (dead). EPERM: alive without signal
		// permission. Anything else: assume alive (fail closed).
		return hasFsCode(err, "EPERM") || !hasFsCode(err, "ESRCH");
	}
}

export class FileSessionStorage implements SessionStorage {
	#assertExpectedSize(fpath: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		let actualSize: number | null;
		try {
			actualSize = fs.statSync(fpath).size;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			actualSize = null;
		}
		if (actualSize !== expectedSize) {
			throw new SessionWriteConflictError(fpath, expectedSize, actualSize);
		}
	}

	#publishLockPath(fpath: string): string {
		return path.join(path.dirname(fpath), `.${path.basename(fpath)}.lock`);
	}

	/**
	 * Run `task` (the freshness check through the final rename) while holding
	 * the cross-process publish lock for `fpath`. The region is fully
	 * synchronous, so a held lock can only belong to another process.
	 */
	#withPublishLock(fpath: string, task: () => void): void {
		const lockPath = this.#publishLockPath(fpath);
		// The lock lives beside the session file: the directory may not exist
		// yet when the first publish creates it (writeTextSync creates it for
		// the temp file, but the lock claim runs first). Match that behavior
		// so a first publish to a new directory does not fail with ENOENT.
		this.ensureDirSync(path.dirname(lockPath));
		this.#acquirePublishLock(fpath, lockPath);
		try {
			task();
		} finally {
			try {
				fs.unlinkSync(lockPath);
			} catch (err) {
				if (!isEnoent(err)) {
					logger.warn("Failed to remove session publish lock", { sessionFile: fpath, lockPath });
				}
			}
		}
	}

	#acquirePublishLock(fpath: string, lockPath: string): void {
		const deadline = Date.now() + SESSION_PUBLISH_LOCK_WAIT_MS;
		for (;;) {
			if (this.#createPublishLock(lockPath)) return;
			if (Date.now() >= deadline) {
				throw new SessionLockError(fpath, "another writer holds the publish lock");
			}
			sleepSyncMs(SESSION_PUBLISH_LOCK_POLL_MS);
		}
	}

	#createPublishLock(lockPath: string): boolean {
		if (this.#tryCreatePublishLock(lockPath)) return true;
		if (!this.#stealStalePublishLock(lockPath)) return false;
		return this.#tryCreatePublishLock(lockPath);
	}

	/**
	 * Claim the lock name and record its holder. Returns false when another
	 * holder already owns the name. A failure to record the holder removes the
	 * file it just created, so no caller meets a contentless lock it can
	 * neither attribute to a live pid nor safely steal.
	 */
	#tryCreatePublishLock(lockPath: string): boolean {
		let fd: number;
		try {
			fd = fs.openSync(lockPath, "wx", 0o600);
		} catch (err) {
			if (!hasFsCode(err, "EEXIST")) throw toError(err);
			return false;
		}
		try {
			fs.writeFileSync(fd, `${process.pid}:${Date.now()}\n`);
		} catch (err) {
			try {
				fs.closeSync(fd);
			} catch {
				// Descriptor unusable after the failed write; the unlink matters.
			}
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// A concurrent steal already removed it.
			}
			throw toError(err);
		}
		try {
			fs.closeSync(fd);
		} catch {
			// Ignore close errors; the lock content is already written.
		}
		return true;
	}

	/**
	 * Remove the lock only when its holder is verifiably dead. Returns whether
	 * the caller should retry acquisition: true when the lock vanished (ours
	 * to take) or was stolen, false when a live holder owns it.
	 */
	#stealStalePublishLock(lockPath: string): boolean {
		let content: string;
		try {
			content = fs.readFileSync(lockPath, "utf8");
		} catch (err) {
			return !!isEnoent(err);
		}
		const pid = publishLockPid(content);
		if (pid === undefined || isPidAlive(pid)) return false;
		try {
			fs.unlinkSync(lockPath);
			return true;
		} catch (err) {
			return !!isEnoent(err);
		}
	}

	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	writeTextSync(fpath: string, content: string, options?: SessionStorageWriteOptions): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			fs.writeFileSync(tempPath, content);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		// The freshness check through the final rename runs under the
		// cross-process publish lock: no cooperating writer can slip an
		// append between the size check and the rename.
		try {
			this.#withPublishLock(fpath, () => {
				this.#assertExpectedSize(fpath, options?.expectedSize);
				try {
					this.renameSync(tempPath, fpath);
				} catch (err) {
					if (!hasFsCode(err, "EPERM")) throw toError(err);
					this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err);
				}
			});
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
	}

	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		const fd = fs.openSync(fpath, "r+");
		try {
			const buf = Buffer.from(serializeTitleSlot(update), "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(fd, buf, offset, buf.length - offset, offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw toError(err);
		} finally {
			fs.closeSync(fd);
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return { size: stats.size, mtimeMs: stats.mtimeMs, mtime: stats.mtime };
	}

	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch {
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			await fs.promises.writeFile(tempPath, content);
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
		// Guard-check + rename MUST NOT be separated by an await. A concurrent
		// synchronous rewrite (flushSync -> #rewriteSynchronously) can otherwise
		// publish a fresh body between the check and the rename, and this stale
		// staged body would overwrite it. Sync rename closes that window.
		if (options?.commitGuard && !options.commitGuard()) {
			this.#discardTemp(tempPath, fpath);
			return;
		}
		try {
			// The publish lock spans the freshness check through the rename (and
			// its EPERM fallback): a cooperating appender or rewrite cannot
			// interleave, and appenders re-open a replaced path before writing.
			this.#withPublishLock(fpath, () => {
				this.#assertExpectedSize(fpath, options?.expectedSize);
				try {
					this.renameSync(tempPath, fpath);
					return;
				} catch (err) {
					if (!hasFsCode(err, "EPERM")) throw toError(err);
					this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err, options?.commitGuard);
				}
			});
		} catch (err) {
			this.#discardTemp(tempPath, fpath);
			throw toError(err);
		}
	}

	/**
	 * Sync rename hook. Split from `rename` so `writeTextAtomic` can perform its
	 * guard-then-publish step without a yield, and so tests can inject
	 * Windows-style EPERM at the sync layer used by the atomic path.
	 */
	renameSync(source: string, target: string): void {
		fs.renameSync(source, target);
	}

	#discardTemp(tempPath: string, targetPath: string): void {
		try {
			fs.unlinkSync(tempPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite temp file", {
					sessionFile: targetPath,
					tempPath,
					error: toError(err).message,
				});
			}
		}
	}

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
		commitGuard?: () => boolean,
	): void {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, `${path.basename(targetPath)}.${Snowflake.next()}.bak`);
		try {
			this.renameSync(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				if (commitGuard && !commitGuard()) {
					this.#discardTemp(tempPath, targetPath);
					return;
				}
				this.renameSync(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		if (commitGuard && !commitGuard()) {
			// A concurrent synchronous rewrite published a fresh body between the
			// move-aside and this point. Restore the moved-aside file so we do
			// not overwrite it with our staged (stale) body, and drop the temp
			// so `writeTextAtomic`'s "discard on abandon" contract holds.
			try {
				this.renameSync(backupPath, targetPath);
			} catch (restoreErr) {
				logger.warn("Failed to restore backup after commitGuard rejection", {
					sessionFile: targetPath,
					backupPath,
					error: toError(restoreErr).message,
				});
			}
			this.#discardTemp(tempPath, targetPath);
			return;
		}
		try {
			this.renameSync(tempPath, targetPath);
		} catch (replaceError) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			fs.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	drain(): Promise<void> {
		// File writes complete synchronously in-body via fs.writeFileSync /
		// fs.renameSync, so there is no queued work to await.
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, {
			...options,
			publishLock: task => this.#withPublishLock(path, task),
		});
	}

	/**
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionPath.slice(0, -6);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
}

function matchesPattern(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		return name.endsWith(pattern.slice(1));
	}
	return name === pattern;
}

class MemorySessionStorageWriter implements SessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;
	#closed = false;
	#error: Error | undefined;
	#onError: ((err: Error) => void) | undefined;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		this.#storage = storage;
		this.#path = path;
		this.#onError = options?.onError;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	#recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	appendSync(line: string): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		try {
			// O(1) append — push onto the path's indexed in-memory entry.
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.#recordError(err);
		}
	}

	async append(line: string): Promise<void> {
		this.appendSync(line);
	}

	async flush(): Promise<void> {
		if (this.#error) throw this.#error;
	}

	flushSync(): void {
		if (this.#error) throw this.#error;
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
	}

	getError(): Error | undefined {
		return this.#error;
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

export class MemorySessionStorage implements SessionStorage {
	// Each path keeps appended string chunks plus cumulative UTF-8 byte offsets.
	// Full reads materialize the chunks into one string chunk, so repeated reads
	// do not re-join stale history. Later appends still stay O(1) by pushing
	// after that materialized chunk. Prefix/suffix reads binary-search byte
	// offsets and join only the requested window.
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry;
	}

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		const actualSize = this.#files.get(path)?.size ?? null;
		if (options?.expectedSize !== undefined && actualSize !== options.expectedSize) {
			throw new SessionWriteConflictError(path, options.expectedSize, actualSize);
		}
		this.#files.set(path, createMemoryFileEntry(content, Date.now()));
	}

	async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		const entry = this.#requireEntry(path);
		this.#files.set(
			path,
			createMemoryFileEntry(overlayTitleSlotContent(materializeMemoryEntry(entry), update), Date.now()),
		);
	}

	/**
	 * Internal O(1) append used by {@link MemorySessionStorageWriter}. Lazily
	 * creates the entry. External callers should go through `openWriter()`
	 * rather than touching the mirror directly.
	 */
	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const files: string[] = [];
		for (const path of this.#files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesPattern(name, pattern)) continue;
			files.push(path);
		}
		return files;
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return Promise.resolve();
		this.writeTextSync(path, content, { expectedSize: options?.expectedSize });
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}
	deleteSessionWithArtifacts(_sessionPath: string): Promise<void> {
		return Promise.resolve();
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
