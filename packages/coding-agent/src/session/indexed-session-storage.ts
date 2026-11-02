import * as fs from "node:fs/promises";
import * as path from "node:path";
import { toError } from "@oh-my-pi/pi-utils";
import {
	childDirNames,
	childKeyName,
	SessionWriteConflictError,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriter,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "./session-storage";
import { isAssistantMessageLine, SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { eexist, enoent } from "./session-storage-errors";
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

/**
 * The part of the index one refresh reloads, by local path: every key
 * (`all`); every key below directory `dir`, at any depth (`dir`); every key
 * whose path starts with the string `prefix` (`prefix`: session directories
 * whose names begin alike, as the managed worktree buckets of one repository
 * do); or the rows of one session (`session`): its file `<stem>.jsonl`, the
 * markers `<stem>.continuation`, `<stem>.exported` and
 * `<stem>.jsonl.tombstone`, and every key below its artifacts directory
 * `<stem>/`.
 */
export type SessionIndexScope =
	| { kind: "all" }
	| { kind: "dir"; dir: string }
	| { kind: "prefix"; prefix: string }
	| { kind: "session"; file: string };

/** The local paths a scope holds: each of `exact`, and every path that starts with one of `prefixes`. */
export interface SessionIndexScopeKeys {
	exact: string[];
	prefixes: string[];
}

/**
 * A refresh of a scope within this many milliseconds of the start of the last
 * successful refresh of a scope holding it returns at once.
 */
export const SESSION_INDEX_REFRESH_COALESCE_MS = 2000;

/** The paths `scope` holds, as exact paths and path prefixes (`all` is the one empty prefix). */
export function sessionIndexScopeKeys(scope: SessionIndexScope): SessionIndexScopeKeys {
	switch (scope.kind) {
		case "all":
			return { exact: [], prefixes: [""] };
		case "dir":
			return { exact: [], prefixes: [scope.dir.endsWith(path.sep) ? scope.dir : `${scope.dir}${path.sep}`] };
		case "prefix":
			return { exact: [], prefixes: [scope.prefix] };
		case "session": {
			const { file } = scope;
			const stem = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
			return {
				exact: [file, `${stem}.continuation`, `${stem}.exported`, `${file}.tombstone`],
				prefixes: [`${stem}${path.sep}`],
			};
		}
	}
}

export interface SessionStorageBackend {
	/**
	 * The one spelling of `path` this backend stores it under, when several
	 * spellings name one stored file: a backend keyed by the resolved path
	 * returns `path.resolve(path)`, so `/s/p/../a.jsonl`, `/s//a.jsonl` and a
	 * relative path take one index entry and one write queue, as they take one
	 * row. {@link IndexedSessionStorage} passes every path through it before
	 * indexing, queueing or calling the backend; without it, each spelling is
	 * its own path.
	 */
	normalizePath?(path: string): string;
	init(): Promise<void>;
	/**
	 * Snapshot of the session and marker entries in `scope`, metadata only.
	 * It may hold entries outside the scope too; the storage keeps only those
	 * inside it.
	 */
	loadIndex(scope: SessionIndexScope): Promise<Iterable<SessionStorageIndexEntry>>;
	readFull(path: string): Promise<string | null>;
	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	/**
	 * The UTF-8 text from byte `offset` to the end, or at most `maxBytes` of
	 * it, and the session's size in bytes, both from one read of the backing
	 * store; `null` when `path` holds no session. A capped read may end inside
	 * a character. Optional: without it the storage reads the whole session
	 * and cuts it.
	 */
	readFrom?(path: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null>;
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
	append(path: string, line: string, mtimeMs: number): Promise<void>;
	updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void>;
	truncate(path: string, mtimeMs: number): Promise<void>;
	/**
	 * Remove `paths`, and with `dir` (a directory ending in `/`) every row
	 * under it that the shared store holds when the removal runs, including
	 * ones another client committed after this store last refreshed.
	 */
	remove(paths: string[], dir?: string): Promise<void>;
	/**
	 * Move `src` to `dst`, replacing `dst`. With `noReplace` a `dst` the shared
	 * store holds, including one another client commits while the move runs,
	 * makes it reject with `EEXIST` naming `dst` and change neither path.
	 */
	move(src: string, dst: string, mtimeMs: number, noReplace?: boolean): Promise<void>;
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
	 * Chain on the uncaught per-path pending op so an op queued behind a
	 * failed one fail-fasts instead of running. Only positional publishes
	 * with no backend CAS token (backend.append) opt in: absolute publishes
	 * carry their own backend validation and run to converge (e.g. a
	 * superseding title update over a failed one).
	 */
	abortOnPredecessorFailure?: boolean;
}

/** Optimistic index entry a queued append installed, kept for failure rollback. */
interface IndexAppend {
	mtimeMs: number;
	previous: IndexEntry | undefined;
	/** Set when the queued op removes the path (unlink, delete, rename source). */
	removal?: true;
}

const RESOLVED = Promise.resolve();
const ALL_SCOPE: SessionIndexScope = { kind: "all" };

/** Whether resolved `key` is one of `keys`' exact paths or starts with one of its prefixes. */
function holdsKey(keys: SessionIndexScopeKeys, key: string): boolean {
	return keys.exact.includes(key) || keys.prefixes.some(prefix => key.startsWith(prefix));
}

/** Whether every key of resolved scope `inner` belongs to resolved scope `outer` too. */
function scopeContains(outer: SessionIndexScope, inner: SessionIndexScope): boolean {
	const held = sessionIndexScopeKeys(outer);
	const wanted = sessionIndexScopeKeys(inner);
	return (
		wanted.prefixes.every(prefix => held.prefixes.some(outerPrefix => prefix.startsWith(outerPrefix))) &&
		wanted.exact.every(key => holdsKey(held, key))
	);
}

/** The session file whose markers include resolved `file`, or `undefined` when it is no marker. */
function markerOwner(file: string): string | undefined {
	if (file.endsWith(".jsonl.tombstone")) return file.slice(0, -".tombstone".length);
	if (file.endsWith(".continuation")) return `${file.slice(0, -".continuation".length)}.jsonl`;
	if (file.endsWith(".exported")) return `${file.slice(0, -".exported".length)}.jsonl`;
	return undefined;
}

/** An index read in progress, which a refresh of a scope it holds joins. */
interface RefreshFlight {
	scope: SessionIndexScope;
	done: Promise<void>;
}

function matchesGlobSegment(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

/**
 * Match a slash-joined index key remainder against a pattern of the same
 * shape (`"*.jsonl"`, or a wildcard project directory followed by
 * `"*.jsonl"` for the one-level cross-project case). Segment counts must
 * agree, so a direct child never matches a two-segment pattern and a
 * nested key never matches a one-segment one.
 */
function matchesGlob(name: string, pattern: string): boolean {
	const nameParts = name.split("/");
	const patternParts = pattern.split("/");
	if (nameParts.length !== patternParts.length) return false;
	return nameParts.every((part, i) => matchesGlobSegment(part, patternParts[i]));
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

/**
 * A key-indexed session store: a local metadata index over a shared backend,
 * with each path's remote writes published in order. It loads no metadata at
 * start; callers refresh the scope they read. A path no loaded scope covers is
 * unknown, so an async read of it loads its session scope first.
 */
export class IndexedSessionStorage implements SessionStorage {
	/**
	 * Sync writes only update {@link #index} and queue the remote publish, so a
	 * caller tracking a durable byte size must wait for {@link drain}.
	 */
	readonly defersSyncPublish = true;
	readonly #backend: SessionStorageBackend;
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
	/** Scoped index reads currently in flight; contained scopes join their snapshot. */
	readonly #refreshes = new Set<RefreshFlight>();
	/** Successful snapshots whose two-second coalescing window remains open. */
	#fresh: Array<{ scope: SessionIndexScope; startedAt: number }> = [];
	/** Every local index mutation during a snapshot read records its path here. */
	readonly #touchWindows = new Set<Set<string>>();
	/** The paths of every completed scope: absence there is known rather than merely not yet loaded. */
	readonly #loaded: SessionIndexScopeKeys = { exact: [], prefixes: [] };
	#nextMtimeMs = 0;
	#firstDrainError: Error | undefined;
	/** Refuse a write to `path` (spelled `file` by the caller) whose index size is not `expectedSize`. */
	#assertExpectedSize(file: string, path: string, expectedSize: number | null | undefined): void {
		if (expectedSize === undefined) return;
		const actualSize = this.#index.get(path)?.size ?? null;
		if (actualSize !== expectedSize) {
			throw new SessionWriteConflictError(file, expectedSize, actualSize);
		}
	}

	/**
	 * The path this storage indexes, queues and hands the backend for the
	 * caller's `file` ({@link SessionStorageBackend.normalizePath}). Errors this
	 * class raises name `file` as the caller spelled it.
	 */
	#normalize(file: string): string {
		return this.#backend.normalizePath?.(file) ?? file;
	}

	constructor(backend: SessionStorageBackend) {
		this.#backend = backend;
	}

	/** Initialize the backend; session metadata scopes load only on demand. */
	async initialize(): Promise<void> {
		await this.#backend.init();
	}

	/**
	 * Replace the local index of `scope` with a backend snapshot of it, keeping
	 * the local state of every path written, removed or queued while it is read.
	 * A call joins a running refresh of a scope holding `scope`, and returns at
	 * once within {@link SESSION_INDEX_REFRESH_COALESCE_MS} of the start of the
	 * last successful refresh of such a scope.
	 */
	refresh(scope: SessionIndexScope = ALL_SCOPE): Promise<void> {
		const resolved = this.#resolveScope(scope);
		const now = performance.now();
		for (const flight of this.#refreshes) {
			if (scopeContains(flight.scope, resolved)) return flight.done;
		}
		this.#fresh = this.#fresh.filter(entry => now - entry.startedAt < SESSION_INDEX_REFRESH_COALESCE_MS);
		if (this.#fresh.some(entry => scopeContains(entry.scope, resolved))) return RESOLVED;

		// Register the flight before #runRefresh begins its backend read. A
		// simultaneous contained refresh then joins this full snapshot.
		const flight: RefreshFlight = { scope: resolved, done: RESOLVED };
		this.#refreshes.add(flight);
		flight.done = this.#runRefresh(resolved, now).finally(() => this.#refreshes.delete(flight));
		return flight.done;
	}

	/** `scope` with its path normalized and resolved: scopes and index keys compare as resolved paths. */
	#resolveScope(scope: SessionIndexScope): SessionIndexScope {
		switch (scope.kind) {
			case "all":
				return scope;
			case "dir":
				return { kind: "dir", dir: path.resolve(this.#normalize(scope.dir)) };
			case "session":
				return { kind: "session", file: path.resolve(this.#normalize(scope.file)) };
			case "prefix": {
				// Resolving drops a trailing separator, which ends a prefix at a directory boundary.
				const resolved = path.resolve(this.#normalize(scope.prefix));
				const boundary = scope.prefix.endsWith(path.sep) && !resolved.endsWith(path.sep);
				return { kind: "prefix", prefix: boundary ? `${resolved}${path.sep}` : resolved };
			}
		}
	}

	async #runRefresh(scope: SessionIndexScope, startedAt: number): Promise<void> {
		// A write already queued when the SELECT begins can commit after it
		// answers, so it must retain its local state during the merge too.
		const touched = new Set([...this.#pendingFrames.keys(), ...this.#pathPending.keys()]);
		this.#touchWindows.add(touched);
		try {
			const rows = await this.#backend.loadIndex(scope);
			this.#mergeIndex(scope, rows, touched);
		} finally {
			this.#touchWindows.delete(touched);
		}
		this.#fresh.push({ scope, startedAt });
		const keys = sessionIndexScopeKeys(scope);
		for (const prefix of keys.prefixes) if (!holdsKey(this.#loaded, prefix)) this.#loaded.prefixes.push(prefix);
		for (const key of keys.exact) if (!holdsKey(this.#loaded, key)) this.#loaded.exact.push(key);
	}

	/** Merge one complete scope snapshot without changing paths it does not cover. */
	#mergeIndex(scope: SessionIndexScope, rows: Iterable<SessionStorageIndexEntry>, touched: ReadonlySet<string>): void {
		const keys = sessionIndexScopeKeys(scope);
		const listed = new Set<string>();
		for (const row of rows) {
			const key = this.#normalize(row.path);
			const resolved = path.resolve(key);
			if (!holdsKey(keys, resolved)) continue;
			listed.add(resolved);
			if (this.#keepsLocal(key, touched)) continue;
			this.#index.set(key, {
				size: row.size,
				mtimeMs: row.mtimeMs,
				...(row.titleUpdatedAt
					? {
							title: row.title,
							titleSource: row.titleSource,
							titleUpdatedAt: row.titleUpdatedAt,
						}
					: {}),
			});
			if (row.mtimeMs > this.#nextMtimeMs) this.#nextMtimeMs = row.mtimeMs;
		}
		// Deleting the current key while iterating a Map is safe.
		for (const key of this.#index.keys()) {
			if (this.#keepsLocal(key, touched)) continue;
			const resolved = path.resolve(key);
			if (!holdsKey(keys, resolved) || listed.has(resolved)) continue;
			this.#index.delete(key);
		}
	}

	#keepsLocal(file: string, touched: ReadonlySet<string>): boolean {
		return touched.has(file) || this.#pendingFrames.has(file) || this.#pathPending.has(file);
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

	existsSync(file: string): boolean {
		return this.#index.has(this.#normalize(file));
	}

	/** Load the session scope of normalized `file` unless it is indexed or a completed scope holds it. */
	async #ensureIndexed(file: string): Promise<void> {
		if (this.#index.has(file)) return;
		const resolved = path.resolve(file);
		// Absence within a completed scope is known; outside every one it is not.
		if (holdsKey(this.#loaded, resolved)) return;
		const owner = markerOwner(resolved);
		await this.refresh({
			kind: "session",
			file: resolved.endsWith(".jsonl") ? resolved : (owner ?? `${path.dirname(resolved)}.jsonl`),
		});
	}

	existsConfirmedSync(file: string): boolean {
		const path = this.#normalize(file);
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
	confirmWrites(file: string): Promise<void> {
		return this.#awaitPath(this.#normalize(file));
	}

	writeTextSync(file: string, content: string, options?: SessionStorageWriteOptions): void {
		const path = this.#normalize(file);
		this.#assertExpectedSize(file, path, options?.expectedSize);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		this.#pushFrame(path, { mtimeMs, previous });
		const write = this.#enqueuePath(
			path,
			() => this.#backend.writeFull(path, content, mtimeMs, title, options?.expectedSize),
			{ trackDrain: true },
		);
		this.#trackFrame(path, mtimeMs, write);
	}

	async updateSessionTitle(file: string, title: SessionTitleUpdate): Promise<void> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(file);
		const mtimeMs = this.#allocMtimeMs();
		const next = {
			...previous,
			title: title.title,
			titleSource: title.source,
			titleUpdatedAt: title.updatedAt,
			mtimeMs,
		};
		this.#indexSet(path, next);
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
	}

	statSync(file: string): SessionStorageStat {
		const entry = this.#index.get(this.#normalize(file));
		if (!entry) throw enoent(file);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		const resolvedDir = path.resolve(dir);
		const out: string[] = [];
		const segments = pattern.split("/").length;
		for (const key of this.#index.keys()) {
			const name = childKeyName(resolvedDir, key, segments);
			if (name === undefined || !matchesGlob(name, pattern)) continue;
			out.push(key);
		}
		return out;
	}

	listDirsSync(dir: string): string[] {
		return childDirNames(path.resolve(dir), this.#index.keys());
	}

	/** Every indexed path: callers refresh the `all` scope first. */
	listAllSync(): string[] {
		return [...this.#index.keys()];
	}

	async exists(file: string): Promise<boolean> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		return this.#index.has(path);
	}

	async readText(file: string): Promise<string> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		const entry = this.#index.get(path);
		if (!entry) throw enoent(file);
		await this.#awaitPath(path);
		const content = await this.#backend.readFull(path);
		if (content === null) throw enoent(file);
		const title = titleUpdateForIndex(entry);
		return title ? overlayTitleSlotContent(content, title) : content;
	}

	async readTextSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		const entry = this.#index.get(path);
		if (!entry) throw enoent(file);
		const prefixLimit = normalizeByteLimit(prefixBytes);
		const suffixLimit = normalizeByteLimit(suffixBytes);
		if (prefixLimit === 0 && suffixLimit === 0) return ["", ""];
		await this.#awaitPath(path);
		const [prefix, suffix] = await this.#backend.readSlices(path, prefixLimit, suffixLimit);
		const title = titleUpdateForIndex(entry);
		return [title ? overlayTitleSlotPrefix(prefix, prefixLimit, title) : prefix, suffix];
	}

	/**
	 * The text from byte `offset`, at most `maxBytes` of it, and the size the
	 * read saw. Both come from the backend's read, not this storage's index, so
	 * an append another process made since the index loaded is read too. The
	 * title slot is synthesized over the stored head, so a read that starts
	 * inside it reads from the start and overlays the slot.
	 */
	async readTextFrom(file: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number }> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		const entry = this.#index.get(path);
		if (!entry) throw enoent(file);
		await this.#awaitPath(path);
		const title = offset < SESSION_TITLE_SLOT_BYTES ? titleUpdateForIndex(entry) : undefined;
		const start = title ? 0 : offset;
		const limit = maxBytes === undefined ? undefined : offset - start + Math.max(0, maxBytes);
		const read = await this.#readBackendFrom(path, start, limit);
		if (!read) throw enoent(file);
		if (!title) return read;
		const head = overlayTitleSlotPrefix(read.text, byteLength(read.text), title);
		return { text: Buffer.from(head, "utf-8").subarray(offset).toString("utf-8"), size: read.size };
	}

	async #readBackendFrom(
		path: string,
		offset: number,
		maxBytes: number | undefined,
	): Promise<{ text: string; size: number } | null> {
		if (this.#backend.readFrom) return this.#backend.readFrom(path, offset, maxBytes);
		const content = await this.#backend.readFull(path);
		if (content === null) return null;
		const bytes = Buffer.from(content, "utf-8");
		if (offset >= bytes.length) return { text: "", size: bytes.length };
		const end = maxBytes === undefined ? undefined : offset + maxBytes;
		return { text: bytes.subarray(offset, end).toString("utf-8"), size: bytes.length };
	}

	async hasAssistantTurn(path: string): Promise<boolean> {
		for (const line of (await this.readText(path)).split("\n")) {
			if (isAssistantMessageLine(line)) return true;
		}
		return false;
	}

	async writeText(file: string, content: string): Promise<void> {
		const path = this.#normalize(file);
		await this.#awaitPath(path);
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
	}

	async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const path = this.#normalize(file);
		const commitGuard = options?.commitGuard;
		if (commitGuard && !commitGuard()) return;
		await this.#awaitPath(path);
		// A concurrent flushSync (writeTextSync) may have taken over during the
		// awaitPath yield and bumped the epoch. Re-check before touching the
		// index or enqueueing the backend publish.
		if (commitGuard && !commitGuard()) return;
		this.#assertExpectedSize(file, path, options?.expectedSize);
		const previous = this.#index.get(path);
		const mtimeMs = this.#allocMtimeMs();
		const title = titleUpdateFromSlot(parseTitleSlotFromContent(content));
		this.#setIndex(path, byteLength(content), mtimeMs, title ?? null);
		this.#pushFrame(path, { mtimeMs, previous });
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
						this.#abandonFrame(path, mtimeMs);
						return;
					}
					await this.#backend.writeFull(path, content, mtimeMs, title, options?.expectedSize);
				},
				{ trackDrain: false },
			);
			this.#dropFrame(path, mtimeMs);
		} catch (err) {
			const error = toError(err);
			try {
				if ((await this.#backend.readFull(path)) === content) {
					this.#dropFrame(path, mtimeMs);
					return;
				}
			} catch {
				// Preserve the original write failure; verification was unavailable.
			}
			this.#failFrame(path, mtimeMs);
			throw error;
		}
	}

	rename(srcFile: string, dstFile: string): Promise<void> {
		return this.#rename(srcFile, dstFile, false);
	}

	/**
	 * {@link rename} that never replaces: a `dst` in this store's view, or one
	 * another client committed to the shared store, makes it reject with
	 * `EEXIST` naming `dst`, and neither path changes.
	 */
	renameNoReplace(srcFile: string, dstFile: string): Promise<void> {
		return this.#rename(srcFile, dstFile, true);
	}

	async #rename(srcFile: string, dstFile: string, noReplace: boolean): Promise<void> {
		const src = this.#normalize(srcFile);
		const dst = this.#normalize(dstFile);
		await this.#ensureIndexed(src);
		await this.#awaitPath(src);
		await this.#awaitPath(dst);
		const entry = this.#index.get(src);
		if (!entry) throw enoent(srcFile);
		if (src === dst) {
			await this.#enqueuePath(src, () => this.#backend.move(src, dst, entry.mtimeMs), { trackDrain: false });
			return;
		}
		const dstPrevious = this.#index.get(dst);
		if (noReplace && dstPrevious) throw eexist(dstFile);
		this.#indexDelete(src);
		this.#indexSet(dst, { ...entry });
		this.#pushFrame(src, { mtimeMs: entry.mtimeMs, previous: entry, removal: true });
		this.#pushFrame(dst, { mtimeMs: entry.mtimeMs, previous: dstPrevious });
		try {
			await this.#enqueuePaths([src, dst], () => this.#backend.move(src, dst, entry.mtimeMs, noReplace), {
				trackDrain: false,
			});
			this.#dropFrame(src, entry.mtimeMs);
			this.#dropFrame(dst, entry.mtimeMs);
		} catch (err) {
			this.#failFrame(src, entry.mtimeMs);
			this.#failFrame(dst, entry.mtimeMs);
			throw toError(err);
		}
	}

	async unlink(file: string): Promise<void> {
		const path = this.#normalize(file);
		await this.#ensureIndexed(path);
		await this.#awaitPath(path);
		const previous = this.#index.get(path);
		if (!previous) throw enoent(file);
		this.#indexDelete(path);
		this.#pushFrame(path, { mtimeMs: previous.mtimeMs, previous, removal: true });
		try {
			await this.#enqueuePath(path, () => this.#backend.remove([path]), { trackDrain: false });
			this.#dropFrame(path, previous.mtimeMs);
		} catch (err) {
			this.#failFrame(path, previous.mtimeMs);
			throw toError(err);
		}
	}

	async deleteSessionWithArtifacts(sessionFile: string): Promise<void> {
		const sessionPath = this.#normalize(sessionFile);
		// Rows another client committed under the artifacts directory (a
		// subagent transcript, a draft) go too: the session-scope refresh brings
		// the ones committed so far into this view, and the backend removes
		// every key under the directory it holds when the removal runs, so one
		// committed after the refresh goes as well.
		await this.refresh({ kind: "session", file: sessionPath });
		await this.#awaitPath(sessionPath);
		const sessionEntry = this.#index.get(sessionPath);
		if (!sessionEntry) throw enoent(sessionFile);

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
			this.#indexDelete(path);
		}
		for (const [path, entry] of previous) {
			this.#pushFrame(path, { mtimeMs: sessionEntry.mtimeMs, previous: entry, removal: true });
		}

		try {
			await this.#enqueuePaths(paths, () => this.#backend.remove(paths, prefix), { trackDrain: false });
			for (const [path] of previous) this.#dropFrame(path, sessionEntry.mtimeMs);
		} catch (err) {
			for (const [path] of previous) this.#failFrame(path, sessionEntry.mtimeMs);
			throw toError(err);
		}
		// Tool artifacts and sidecars stay on local disk whatever holds the
		// transcripts, so removing the session removes them as the file
		// backend's delete does.
		try {
			await fs.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(`Session deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`, {
				cause: error,
			});
		}
	}

	openWriter(file: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const writer = new IndexedSessionStorageWriter(this, this.#normalize(file), options);
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

	_appendForWriter(path: string, line: string): IndexAppend {
		const mtimeMs = this.#allocMtimeMs();
		const previous = this.#index.get(path);
		const size = (previous?.size ?? 0) + byteLength(line);
		this.#setIndex(path, size, mtimeMs);
		return { mtimeMs, previous };
	}

	_queueAppend(path: string, line: string, append: IndexAppend, getError?: () => Error | undefined): Promise<void> {
		const { mtimeMs } = append;
		this.#pushFrame(path, append);
		const tracked = this.#enqueuePath(
			path,
			async () => {
				const error = getError?.();
				if (error) throw error;
				await this.#backend.append(path, line, mtimeMs);
			},
			{ trackDrain: true, abortOnPredecessorFailure: true },
		);
		this.#trackFrame(path, mtimeMs, tracked);
		return tracked;
	}

	/** Record a local index change in every refresh whose backend read is in flight. */
	#touch(file: string): void {
		for (const touched of this.#touchWindows) touched.add(file);
	}

	#indexSet(file: string, entry: IndexEntry): void {
		this.#touch(file);
		this.#index.set(file, entry);
	}

	#indexDelete(file: string): void {
		this.#touch(file);
		this.#index.delete(file);
	}

	#restoreIndex(path: string, entry: IndexEntry | undefined): void {
		if (entry) this.#indexSet(path, entry);
		else this.#indexDelete(path);
	}

	#setIndex(
		path: string,
		size: number,
		mtimeMs: number,
		title: SessionTitleUpdate | null | undefined = undefined,
	): void {
		const current = title === undefined ? this.#index.get(path) : undefined;
		this.#indexSet(path, {
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
		// Predecessor choice (rJDg): a positional publish with no backend CAS
		// token (backend.append) chains on the uncaught pending op so it
		// fail-fasts behind a failed op instead of landing on a body the
		// backend never accepted. Absolute publishes carry their own backend
		// validation and chain on the caught tail, so a superseding publish
		// still runs to converge (e.g. a newer title update over a failed one).
		const previous = unique.map(
			path =>
				(options.abortOnPredecessorFailure ? this.#pathPending.get(path) : this.#pathTails.get(path)) ?? RESOLVED,
		);
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
