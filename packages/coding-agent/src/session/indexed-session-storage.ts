import { toError } from "@oh-my-pi/pi-utils";
import type {
	SessionStorage,
	SessionStorageStat,
	SessionStorageWriter,
	WriteTextAtomicOptions,
} from "./session-storage";
import {
	overlayTitleSlotContent,
	overlayTitleSlotPrefix,
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

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
	writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate): Promise<void>;
	append(path: string, line: string, mtimeMs: number): Promise<void>;
	updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void>;
	truncate(path: string, mtimeMs: number): Promise<void>;
	remove(paths: string[]): Promise<void>;
	move(src: string, dst: string, mtimeMs: number): Promise<void>;
}

interface IndexEntry {
	size: number;
	mtimeMs: number;
	title?: string;
	titleSource?: SessionTitleUpdate["source"];
	titleUpdatedAt?: string;
}

interface EnqueueOptions {
	trackDrain: boolean;
}

const RESOLVED = Promise.resolve();

function enoent(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOENT: no such file, '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.errno = -2;
	err.path = p;
	err.syscall = "open";
	return err;
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
	readonly #backend: SessionStorageBackend;
	readonly #index = new Map<string, IndexEntry>();
	readonly #writers = new Set<IndexedSessionStorageWriter>();
	readonly #pathTails = new Map<string, Promise<void>>();
	readonly #pathPending = new Map<string, Promise<void>>();
	readonly #drainPending = new Set<Promise<void>>();
	#nextMtimeMs = 0;
	#firstDrainError: Error | undefined;

	constructor(backend: SessionStorageBackend) {
		this.#backend = backend;
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
		while (this.#drainPending.size > 0 || this.#pathPending.size > 0) {
			await Promise.allSettled([...this.#drainPending, ...this.#pathPending.values()]);
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

	writeTextSync(path: string, content: string): void {
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		this.#enqueuePath(path, () => this.#backend.writeFull(path, content, mtimeMs, title), { trackDrain: true });
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate): Promise<void> {
		await this.#awaitPath(path);
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
		try {
			await this.#enqueuePath(path, () => this.#backend.updateSessionTitle(path, title, mtimeMs), {
				trackDrain: false,
			});
		} catch (err) {
			const current = this.#index.get(path);
			if (
				current?.mtimeMs === next.mtimeMs &&
				current.title === next.title &&
				current.titleSource === next.titleSource &&
				current.titleUpdatedAt === next.titleUpdatedAt
			) {
				this.#index.set(path, previous);
			}
			throw toError(err);
		}
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
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const out: string[] = [];
		for (const path of this.#index.keys()) {
			if (!path.startsWith(prefix)) continue;
			const name = path.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (!matchesGlob(name, pattern)) continue;
			out.push(path);
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

	async writeText(path: string, content: string): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		try {
			await this.#enqueuePath(path, () => this.#backend.writeFull(path, content, mtimeMs, title), {
				trackDrain: false,
			});
		} catch (err) {
			this.#restoreIndex(path, previous);
			throw toError(err);
		}
	}

	async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const commitGuard = options?.commitGuard;
		if (commitGuard && !commitGuard()) return;
		await this.#awaitPath(path);
		// A concurrent flushSync (writeTextSync) may have taken over during the
		// awaitPath yield and bumped the epoch. Re-check before touching the
		// index or enqueueing the backend publish.
		if (commitGuard && !commitGuard()) return;
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		try {
			await this.#enqueuePath(
				path,
				async () => {
					// Final guard immediately before the backend actually publishes.
					// If a concurrent writer has advanced the index past our
					// optimistic entry, leave that newer state alone; otherwise
					// restore the pre-write snapshot so readers do not observe a
					// body we never wrote.
					if (commitGuard && !commitGuard()) {
						const current = this.#index.get(path);
						if (current?.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
						return;
					}
					await this.#backend.writeFull(path, content, mtimeMs, title);
				},
				{ trackDrain: false },
			);
		} catch (err) {
			const error = toError(err);
			try {
				if ((await this.#backend.readFull(path)) === content) return;
			} catch {
				// Preserve the original write failure; verification was unavailable.
			}
			const current = this.#index.get(path);
			if (current?.mtimeMs === mtimeMs) this.#restoreIndex(path, previous);
			throw error;
		}
	}

	async rename(src: string, dst: string): Promise<void> {
		await this.#awaitPath(src);
		await this.#awaitPath(dst);
		const entry = this.#index.get(src);
		if (!entry) throw enoent(src);
		const dstPrevious = this.#index.get(dst);
		this.#index.delete(src);
		this.#index.set(dst, { ...entry });
		try {
			await this.#enqueuePaths([src, dst], () => this.#backend.move(src, dst, entry.mtimeMs), { trackDrain: false });
		} catch (err) {
			this.#index.delete(dst);
			this.#restoreIndex(dst, dstPrevious);
			this.#index.set(src, entry);
			throw toError(err);
		}
	}

	async unlink(path: string): Promise<void> {
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(path);
		this.#index.delete(path);
		try {
			await this.#enqueuePath(path, () => this.#backend.remove([path]), { trackDrain: false });
		} catch (err) {
			this.#index.set(path, previous);
			throw toError(err);
		}
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await this.#awaitPath(sessionPath);
		const sessionEntry = this.#index.get(sessionPath);
		if (!sessionEntry) throw enoent(sessionPath);

		const artifactsDir = sessionPath.slice(0, -6);
		const prefix = artifactsDir.endsWith("/") ? artifactsDir : `${artifactsDir}/`;
		const paths = [sessionPath];
		for (const key of this.#index.keys()) {
			if (key.startsWith(prefix)) paths.push(key);
		}

		for (const path of paths) await this.#awaitPath(path);

		const previous = new Map<string, IndexEntry>();
		for (const path of paths) {
			const entry = this.#index.get(path);
			if (entry) previous.set(path, entry);
			this.#index.delete(path);
		}

		try {
			await this.#enqueuePaths(paths, () => this.#backend.remove(paths), { trackDrain: false });
		} catch (err) {
			for (const [path, entry] of previous) this.#index.set(path, entry);
			throw toError(err);
		}
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
		this.#setIndex(path, 0, mtimeMs, null);
		return mtimeMs;
	}

	_queueTruncate(path: string, mtimeMs: number, getError?: () => Error | undefined): Promise<void> {
		return this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.truncate(path, mtimeMs);
			},
			{ trackDrain: true },
		);
	}

	_appendForWriter(path: string, line: string): number {
		const mtimeMs = this.#allocMtimeMs();
		const existing = this.#index.get(path);
		const size = (existing?.size ?? 0) + byteLength(line);
		this.#setIndex(path, size, mtimeMs);
		return mtimeMs;
	}

	_queueAppend(path: string, line: string, mtimeMs: number, getError?: () => Error | undefined): Promise<void> {
		return this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.append(path, line, mtimeMs);
			},
			{ trackDrain: true },
		);
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

	#enqueuePaths(paths: readonly string[], task: () => Promise<void>, options: EnqueueOptions): Promise<void> {
		const unique = uniquePaths(paths);
		const previous = unique.map(path => this.#pathTails.get(path) ?? RESOLVED);
		const operation = Promise.all(previous).then(task);
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
		return this.#pathPending.get(path) ?? RESOLVED;
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
		const mtimeMs = this.#storage._appendForWriter(this.#path, line);
		void this.#trackPromise(this.#storage._queueAppend(this.#path, line, mtimeMs, () => this.#error));
	}

	async append(line: string): Promise<void> {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const mtimeMs = this.#storage._appendForWriter(this.#path, line);
		await this.#trackPromise(this.#storage._queueAppend(this.#path, line, mtimeMs, () => this.#error));
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
