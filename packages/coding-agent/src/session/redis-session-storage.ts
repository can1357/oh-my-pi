import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { enoent } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Minimal subset of the `bun:redis` `RedisClient` surface used by
 * {@link RedisSessionStorage}. Keeping the contract narrow (and accepting any
 * client that conforms) lets callers swap in test doubles or shared clients
 * without dragging the entire Bun typings into this module.
 */
export interface RedisSessionStorageClient {
	send(command: string, args: string[]): Promise<unknown>;
	get(key: string): Promise<string | null>;
	getrange(key: string, start: number, end: number): Promise<string>;
	strlen(key: string): Promise<number>;
	set(key: string, value: string): Promise<unknown>;
	append(key: string, value: string): Promise<number>;
	del(...keys: string[]): Promise<number>;
	rename(src: string, dst: string): Promise<unknown>;
	scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
	hset(key: string, field: string, value: string): Promise<unknown>;
	hgetall(key: string): Promise<Record<string, string>>;
	hdel(key: string, ...fields: string[]): Promise<unknown>;
}

export interface RedisSessionStorageOptions {
	/** A connected `bun:redis` RedisClient (or any compatible adapter). */
	client: RedisSessionStorageClient;
	/**
	 * Key prefix applied to every Redis key this storage owns. Default `omp:sessions:`.
	 * Trailing colon is preserved verbatim — set to a project-scoped prefix to share
	 * one Redis instance between multiple agents.
	 */
	prefix?: string;
	/**
	 * Maximum number of keys returned per SCAN batch when warming the metadata index.
	 * Default 500.
	 */
	scanCount?: number;
}

const DEFAULT_PREFIX = "omp:sessions:";
const DEFAULT_SCAN_COUNT = 500;

// Redis keeps a failed script's earlier writes, so the script reads both
// hashes (KEYS[2] the meta hash, KEYS[3] the title hash) before the SET, its
// first write: a hash key that holds another type fails that HGET, and the
// script changes nothing.
const WRITE_FULL_SCRIPT = `-- OMP_WRITE_FULL
local expected = ARGV[6]
if expected ~= "" then
	local actual = -1
	if redis.call("EXISTS", KEYS[1]) == 1 then
		actual = redis.call("STRLEN", KEYS[1])
	end
	if actual ~= tonumber(expected) then
		return {0, actual}
	end
end
redis.call("HGET", KEYS[2], ARGV[2])
redis.call("HGET", KEYS[3], ARGV[2])
redis.call("SET", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
if ARGV[4] == "1" then
	redis.call("HSET", KEYS[3], ARGV[2], ARGV[5])
else
	redis.call("HDEL", KEYS[3], ARGV[2])
end
return {1, string.len(ARGV[1])}`;

// KEYS[1] is the file key, KEYS[2] the meta hash and KEYS[3] the title hash;
// ARGV the line, the session's path and its mtime. An append that creates the
// key first deletes the title metadata the path may still hold for no body (a
// title an older build stored after the session there was removed), so the
// session it starts shows no title it never had. Redis keeps the writes a
// script made before it failed: a meta key that holds another type fails the
// HSET after the APPEND, and the line stays in the body with no time in the
// meta hash. The script reads no hash first, because it runs once for each
// session entry.
const APPEND_SCRIPT = `-- OMP_APPEND
if redis.call("EXISTS", KEYS[1]) == 0 then
	redis.call("HDEL", KEYS[3], ARGV[2])
end
local size = redis.call("APPEND", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
return size`;

// KEYS[1] is the meta hash, KEYS[2] the title hash and KEYS[3] the file key;
// ARGV the session's path, its mtime and its title metadata. Returns 0, and
// writes nothing, when the key is missing: a store whose index still lists a
// session another store removed stores no title for a body that is gone. Redis
// keeps a failed script's earlier writes, so the script reads the title hash
// before its first write: a title key that holds another type fails that HGET,
// and the script changes nothing. The meta hash needs no read: its HSET is the
// first write, so a failure there changes nothing.
const UPDATE_TITLE_SCRIPT = `-- OMP_UPDATE_TITLE
if redis.call("EXISTS", KEYS[3]) == 0 then
	return 0
end
redis.call("HGET", KEYS[2], ARGV[1])
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[2], ARGV[1], ARGV[3])
return 1`;

// One script, so the value and its title metadata come from one read: no
// client's write lands between them. KEYS[2] is the title hash and ARGV[1] the
// session's path in it. Returns {the value, its title metadata or nil}; nil
// when the key is missing.
const READ_FULL_SCRIPT = `-- OMP_READ_FULL
local text = redis.call("GET", KEYS[1])
if not text then
	return false
end
return {text, redis.call("HGET", KEYS[2], ARGV[1])}`;

// One script, so both windows and the title metadata come from one read.
// KEYS[2] is the title hash and ARGV[1] the session's path in it; ARGV[2] is
// the head's byte count and ARGV[3] the tail's, each 0 for none. Returns
// {head, tail, title metadata or nil}; nil when the key is missing, read as two
// empty windows and no title: title metadata without a body is no session's.
const READ_SLICES_SCRIPT = `-- OMP_READ_SLICES
if redis.call("EXISTS", KEYS[1]) == 0 then
	return false
end
local head = ""
local prefix = tonumber(ARGV[2])
if prefix > 0 then
	head = redis.call("GETRANGE", KEYS[1], 0, prefix - 1)
end
local tail = ""
local suffix = tonumber(ARGV[3])
if suffix > 0 then
	tail = redis.call("GETRANGE", KEYS[1], -suffix, -1)
end
return {head, tail, redis.call("HGET", KEYS[2], ARGV[1])}`;

// One script, so no client's read or write of either path lands between the
// moves of the key, its mtime and its title. KEYS are the source and
// destination file keys, the meta hash and the title hash; ARGV the source and
// destination paths and the destination's mtime. A destination title the
// source has none for is deleted. Redis keeps the writes a script made before
// it failed, so the script reads both hashes before the RENAME, its first
// write: a hash key that holds another type fails its read (an HGET), and a
// missing source fails the RENAME. A script that fails before the RENAME
// changes nothing. A Redis account that may run RENAME but not a later HSET or
// HDEL still fails the script after the RENAME.
const MOVE_SCRIPT = `-- OMP_MOVE
local title = redis.call("HGET", KEYS[4], ARGV[1])
redis.call("HGET", KEYS[3], ARGV[1])
redis.call("RENAME", KEYS[1], KEYS[2])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("HSET", KEYS[3], ARGV[2], ARGV[3])
redis.call("HDEL", KEYS[4], ARGV[1])
if title then
	redis.call("HSET", KEYS[4], ARGV[2], title)
else
	redis.call("HDEL", KEYS[4], ARGV[2])
end
return 1`;

// One script, so each path's key, mtime and title go together: a session
// written at a path right after its removal keeps its metadata. KEYS[1] is the
// meta hash, KEYS[2] the title hash and KEYS[2 + i] the file key of the path
// ARGV[i]. It deletes every key it is given before any metadata. Redis keeps a
// failed script's earlier writes, so the script reads both hashes before its
// first DEL: a hash key that holds another type fails that HGET, and the
// script changes nothing.
const REMOVE_SCRIPT = `-- OMP_REMOVE
redis.call("HGET", KEYS[1], ARGV[1])
redis.call("HGET", KEYS[2], ARGV[1])
for i = 1, #ARGV do
	redis.call("DEL", KEYS[i + 2])
end
for _, path in ipairs(ARGV) do
	redis.call("HDEL", KEYS[1], path)
	redis.call("HDEL", KEYS[2], path)
end
return #ARGV`;

function encodeTitleMeta(title: SessionTitleUpdate): string {
	return JSON.stringify(title);
}

/**
 * The title metadata a value of the title hash holds, as a script returns it (nil as null): none when malformed or
 * without a time. An empty title with a time is a clear.
 */
function decodeTitleMeta(raw: unknown): SessionTitleUpdate | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) return undefined;
		const source = record.source === "auto" || record.source === "user" ? record.source : undefined;
		return {
			title: typeof record.title === "string" ? record.title : undefined,
			source,
			updatedAt: record.updatedAt,
		};
	} catch {
		return undefined;
	}
}

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime, title)
 * tracked in sibling HASHes. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory so synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls remain available without mirroring full content; every
 * read takes the title metadata in the script that reads the bytes.
 */
export class RedisSessionStorage extends IndexedSessionStorage {
	/**
	 * Warm the metadata index with every existing session key under the configured
	 * prefix and return the ready-to-use storage. Must be awaited before passing
	 * the storage into `SessionManager.create()` so synchronous lookups (session
	 * resume, recent sessions, EPERM-backup recovery) see the existing keyspace.
	 */
	static async create(options: RedisSessionStorageOptions): Promise<RedisSessionStorage> {
		const storage = new RedisSessionStorage(new RedisSessionStorageBackend(options));
		await storage.initialize();
		return storage;
	}
}

class RedisSessionStorageBackend implements SessionStorageBackend {
	readonly #client: RedisSessionStorageClient;
	readonly #prefix: string;
	readonly #scanCount: number;

	constructor(options: RedisSessionStorageOptions) {
		this.#client = options.client;
		this.#prefix = options.prefix ?? DEFAULT_PREFIX;
		this.#scanCount = options.scanCount ?? DEFAULT_SCAN_COUNT;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const filePrefix = this.#fileKey("");
		const metaRaw = await this.#client.hgetall(this.#metaKey());
		const meta: Record<string, string> = metaRaw ?? {};
		const seen = new Set<string>();
		let cursor = "0";
		do {
			const [next, batch] = await this.#client.scan(
				cursor,
				"MATCH",
				`${filePrefix}*`,
				"COUNT",
				String(this.#scanCount),
			);
			cursor = next;
			for (const key of batch) seen.add(key);
		} while (cursor !== "0");

		const fallbackMtimeMs = Date.now();
		return Promise.all(
			Array.from(seen, async key => {
				const path = key.slice(filePrefix.length);
				const size = await this.#client.strlen(key);
				const rawMtime = meta[path];
				const parsedMtime = rawMtime === undefined ? Number.NaN : Number(rawMtime);
				return { path, size, mtimeMs: Number.isFinite(parsedMtime) ? parsedMtime : fallbackMtimeMs };
			}),
		);
	}

	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		const reply = await this.#client.send("EVAL", [
			READ_FULL_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#titleMetaKey(),
			path,
		]);
		if (!Array.isArray(reply)) return null;
		return { text: String(reply[0]), title: decodeTitleMeta(reply[1]) };
	}

	async readSlices(
		path: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[prefix: string, suffix: string, title: SessionStorageReadTitle]> {
		const reply = await this.#client.send("EVAL", [
			READ_SLICES_SCRIPT,
			"2",
			this.#fileKey(path),
			this.#titleMetaKey(),
			path,
			String(prefixBytes),
			String(suffixBytes),
		]);
		if (!Array.isArray(reply)) return ["", "", undefined];
		return [String(reply[0] ?? ""), String(reply[1] ?? ""), decodeTitleMeta(reply[2])];
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const result = await this.#client.send("EVAL", [
			WRITE_FULL_SCRIPT,
			"3",
			this.#fileKey(path),
			this.#metaKey(),
			this.#titleMetaKey(),
			content,
			path,
			String(mtimeMs),
			title ? "1" : "0",
			title ? encodeTitleMeta(title) : "",
			expectedSize === undefined ? "" : String(expectedSize ?? -1),
		]);
		if (expectedSize === undefined) return;
		const written = Array.isArray(result) && Number(result[0]) === 1;
		if (written) return;
		const encodedActual = Array.isArray(result) ? Number(result[1]) : Number.NaN;
		const actualSize = encodedActual === -1 ? null : Number.isFinite(encodedActual) ? encodedActual : null;
		throw new SessionWriteConflictError(path, expectedSize, actualSize);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			APPEND_SCRIPT,
			"3",
			this.#fileKey(path),
			this.#metaKey(),
			this.#titleMetaKey(),
			line,
			path,
			String(mtimeMs),
		]);
	}

	/** Rejects with `ENOENT`, storing nothing, when the store holds no session at `path`. */
	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const updated = await this.#client.send("EVAL", [
			UPDATE_TITLE_SCRIPT,
			"3",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#fileKey(path),
			path,
			String(mtimeMs),
			encodeTitleMeta(title),
		]);
		if (Number(updated) !== 1) throw enoent(path);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.#client.send("EVAL", [
			REMOVE_SCRIPT,
			String(paths.length + 2),
			this.#metaKey(),
			this.#titleMetaKey(),
			...paths.map(path => this.#fileKey(path)),
			...paths,
		]);
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			MOVE_SCRIPT,
			"4",
			this.#fileKey(src),
			this.#fileKey(dst),
			this.#metaKey(),
			this.#titleMetaKey(),
			src,
			dst,
			String(mtimeMs),
		]);
	}

	#fileKey(path: string): string {
		return `${this.#prefix}file:${path}`;
	}

	#metaKey(): string {
		return `${this.#prefix}meta`;
	}

	#titleMetaKey(): string {
		return `${this.#prefix}title`;
	}
}
