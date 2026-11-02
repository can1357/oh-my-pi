import {
	IndexedSessionStorage,
	type SessionIndexScope,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
	sessionIndexScopeKeys,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { eexist } from "./session-storage-errors";
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
	scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
	hgetall(key: string): Promise<Record<string, string>>;
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
	 * Maximum number of keys returned per SCAN batch during an index refresh.
	 * Default 500.
	 */
	scanCount?: number;
}

const DEFAULT_PREFIX = "omp:sessions:";
const DEFAULT_SCAN_COUNT = 500;

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
redis.call("SET", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
if ARGV[4] == "1" then
	redis.call("HSET", KEYS[3], ARGV[2], ARGV[5])
else
	redis.call("HDEL", KEYS[3], ARGV[2])
end
return {1, string.len(ARGV[1])}`;

const APPEND_SCRIPT = `-- OMP_APPEND
local size = redis.call("APPEND", KEYS[1], ARGV[1])
redis.call("HSET", KEYS[2], ARGV[2], ARGV[3])
return size`;

const UPDATE_TITLE_SCRIPT = `-- OMP_UPDATE_TITLE
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[2], ARGV[1], ARGV[3])
return 1`;

// One script, so the key, its mtime and its title move together: no client's
// write to either path can land between them. With ARGV[4] == "1" a taken
// destination leaves everything as it was (returns 0).
const MOVE_SCRIPT = `-- OMP_MOVE
if ARGV[4] == "1" and redis.call("EXISTS", KEYS[2]) == 1 then
	return 0
end
redis.call("RENAME", KEYS[1], KEYS[2])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("HSET", KEYS[3], ARGV[2], ARGV[3])
local title = redis.call("HGET", KEYS[4], ARGV[1])
redis.call("HDEL", KEYS[4], ARGV[1])
if title then
	redis.call("HSET", KEYS[4], ARGV[2], title)
else
	redis.call("HDEL", KEYS[4], ARGV[2])
end
return 1`;

// One script, so finding the keys under a directory, deleting them and
// deleting their mtime and title run with no other client's command between:
// a child set after the scan cannot survive, and a replacement written after
// the delete keeps its metadata. ARGV[1] is the file-key prefix, ARGV[2] a
// SCAN pattern for the directory ("" for none), ARGV[3..] explicit paths.
const REMOVE_SCRIPT = `-- OMP_REMOVE
local prefix = ARGV[1]
local paths = {}
for i = 3, #ARGV do
	paths[#paths + 1] = ARGV[i]
end
if ARGV[2] ~= "" then
	local cursor = "0"
	repeat
		local reply = redis.call("SCAN", cursor, "MATCH", ARGV[2], "COUNT", 1000)
		cursor = reply[1]
		for _, key in ipairs(reply[2]) do
			paths[#paths + 1] = string.sub(key, #prefix + 1)
		end
	until cursor == "0"
end
for _, path in ipairs(paths) do
	redis.call("DEL", prefix .. path)
	redis.call("HDEL", KEYS[1], path)
	redis.call("HDEL", KEYS[2], path)
end
return #paths`;

/**
 * For each path in ARGV whose file key (KEYS[i + 2]) exists: the path, its
 * byte length, its mtime field and its title field ("" when absent), flat.
 */
const STAT_KEYS_SCRIPT = `-- OMP_STAT_KEYS
local out = {}
for i = 1, #ARGV do
	local key = KEYS[i + 2]
	if redis.call("EXISTS", key) == 1 then
		out[#out + 1] = ARGV[i]
		out[#out + 1] = redis.call("STRLEN", key)
		out[#out + 1] = redis.call("HGET", KEYS[1], ARGV[i]) or ""
		out[#out + 1] = redis.call("HGET", KEYS[2], ARGV[i]) or ""
	end
end
return out`;

/** A `SCAN MATCH` glob for the keys starting with `prefix`, its glob characters escaped. */
function keysStartingWith(prefix: string): string {
	return `${prefix.replace(/[*?[\]\\]/g, "\\$&")}*`;
}

function encodeTitleMeta(title: SessionTitleUpdate): string {
	return JSON.stringify(title);
}

function decodeTitleMeta(raw: string | undefined): SessionTitleUpdate | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.updatedAt !== "string") return undefined;
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

/** An index entry from a key's size and its raw metadata fields ("" when absent). */
function entryOf(path: string, size: number, rawMtime: string, rawTitle: string): SessionStorageIndexEntry {
	const mtimeMs = rawMtime === "" ? Number.NaN : Number(rawMtime);
	const title = decodeTitleMeta(rawTitle);
	return {
		path,
		size,
		// A key written without metadata (a peer that crashed mid-write) still lists.
		mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
		title: title?.title,
		titleSource: title?.source,
		titleUpdatedAt: title?.updatedAt,
	};
}

/**
 * Redis-backed implementation of {@link SessionStorage}. Each session JSONL
 * file maps to a Redis STRING key, with per-key metadata (mtime) tracked in a
 * single sibling HASH. This process keeps only a metadata index (`size`,
 * `mtimeMs`) in memory so synchronous `existsSync` / `statSync` /
 * `listFilesSync` calls remain available without mirroring full content.
 */
export class RedisSessionStorage extends IndexedSessionStorage {
	/**
	 * Initialize the Redis backend without loading keys. Each index scope
	 * loads on demand, and Redis returns only that scope's keys.
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

	/**
	 * The entries in `scope`. A scoped load asks Redis only for its keys: the
	 * exact paths, and a `SCAN … MATCH` per path prefix, so only matching keys
	 * and their metadata cross the wire. `all` reads both metadata hashes whole.
	 */
	async loadIndex(scope: SessionIndexScope): Promise<SessionStorageIndexEntry[]> {
		if (scope.kind === "all") return this.#loadAll();
		const { exact, prefixes } = sessionIndexScopeKeys(scope);
		const paths = new Set(exact);
		const filePrefix = this.#fileKey("");
		for (const prefix of prefixes) {
			for (const key of await this.#scanFileKeys(filePrefix + prefix)) paths.add(key.slice(filePrefix.length));
		}
		const entries: SessionStorageIndexEntry[] = [];
		const all = [...paths];
		for (let start = 0; start < all.length; start += this.#scanCount) {
			const batch = all.slice(start, start + this.#scanCount);
			const stats = await this.#client.send("EVAL", [
				STAT_KEYS_SCRIPT,
				String(batch.length + 2),
				this.#metaKey(),
				this.#titleMetaKey(),
				...batch.map(path => this.#fileKey(path)),
				...batch,
			]);
			const flat = Array.isArray(stats) ? stats : [];
			for (let i = 0; i + 3 < flat.length; i += 4) {
				entries.push(entryOf(String(flat[i]), Number(flat[i + 1]), String(flat[i + 2]), String(flat[i + 3])));
			}
		}
		return entries;
	}

	async #loadAll(): Promise<SessionStorageIndexEntry[]> {
		const filePrefix = this.#fileKey("");
		const meta: Record<string, string> = (await this.#client.hgetall(this.#metaKey())) ?? {};
		const titles: Record<string, string> = (await this.#client.hgetall(this.#titleMetaKey())) ?? {};
		const keys = await this.#scanFileKeys(filePrefix);
		return Promise.all(
			keys.map(async key => {
				const path = key.slice(filePrefix.length);
				return entryOf(path, await this.#client.strlen(key), meta[path] ?? "", titles[path] ?? "");
			}),
		);
	}

	readFull(path: string): Promise<string | null> {
		return this.#client.get(this.#fileKey(path));
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const key = this.#fileKey(path);
		const head = prefixBytes > 0 ? this.#client.getrange(key, 0, prefixBytes - 1) : Promise.resolve("");
		const tail = suffixBytes > 0 ? this.#client.getrange(key, -suffixBytes, -1) : Promise.resolve("");
		return Promise.all([head, tail]);
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
			"2",
			this.#fileKey(path),
			this.#metaKey(),
			line,
			path,
			String(mtimeMs),
		]);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.send("EVAL", [
			UPDATE_TITLE_SCRIPT,
			"2",
			this.#metaKey(),
			this.#titleMetaKey(),
			path,
			String(mtimeMs),
			encodeTitleMeta(title),
		]);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[], dir?: string): Promise<void> {
		if (paths.length === 0 && dir === undefined) return;
		await this.#client.send("EVAL", [
			REMOVE_SCRIPT,
			"2",
			this.#metaKey(),
			this.#titleMetaKey(),
			this.#fileKey(""),
			dir === undefined ? "" : keysStartingWith(this.#fileKey(dir)),
			...paths,
		]);
	}

	async move(src: string, dst: string, mtimeMs: number, noReplace = false): Promise<void> {
		const moved = await this.#client.send("EVAL", [
			MOVE_SCRIPT,
			"4",
			this.#fileKey(src),
			this.#fileKey(dst),
			this.#metaKey(),
			this.#titleMetaKey(),
			src,
			dst,
			String(mtimeMs),
			noReplace ? "1" : "0",
		]);
		if (Number(moved) !== 1) throw eexist(dst);
	}

	/** Every file key starting with `keyPrefix`, filtered by Redis. */
	async #scanFileKeys(keyPrefix: string): Promise<string[]> {
		const pattern = keysStartingWith(keyPrefix);
		const keys = new Set<string>();
		let cursor = "0";
		do {
			const [next, batch] = await this.#client.scan(cursor, "MATCH", pattern, "COUNT", String(this.#scanCount));
			cursor = next;
			for (const key of batch) keys.add(key);
		} while (cursor !== "0");
		return [...keys];
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
