/**
 * What the MCP host knows about servers without asking them: each server's
 * era and the cacheable results it returned.
 *
 * One sqlite database (WAL) holds both, so the knowledge outlives units and
 * the daemon, and an in-process host beside a daemon reads the same rows. A
 * known server therefore needs no process to list its tools.
 *
 * Keys are the hashed identities of `contract.ts`; no configuration, header or
 * environment value is stored.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { McpEra } from "./contract";

const SCHEMA_VERSION = 1;
const DB_FILE = "cache.db";
/** Entries unread for this long are dropped: no session configures the server any more. */
const UNUSED_ENTRY_MS = 30 * 24 * 60 * 60 * 1_000;
/** `used_at` is rewritten at most this often per entry, so reads stay reads. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** How long another process may hold the write lock before a statement fails. */
const BUSY_TIMEOUT_MS = 2_000;

/**
 * A handshake-era verdict is probed again after this long, so a server that
 * was upgraded to the modern revision starts being shared.
 */
export const MCP_ERA_RECHECK_MS = 7 * 24 * 60 * 60 * 1_000;

/** Freshness window the host gives results of a handshake-era server, which declares none. */
export const MCP_LEGACY_TTL_MS = UNUSED_ENTRY_MS;

/** A server's era as last probed. */
export interface McpEraRecord {
	era: McpEra;
	probedAt: number;
}

/** A stored result and the caching hints it arrived with. */
export interface McpCacheEntry {
	result: Record<string, unknown>;
	/** Local time the result was received. */
	receivedAt: number;
	ttlMs: number;
}

interface EraRow {
	era: string;
	probed_at: number;
}

interface ResultRow {
	result: string;
	received_at: number;
	ttl_ms: number;
	used_at: number;
}

/** Whether `entry` is still inside the freshness window its server declared. */
export function isFresh(entry: McpCacheEntry, now = Date.now()): boolean {
	return now < entry.receivedAt + entry.ttlMs;
}

/**
 * Cache key part for a request's parameters: everything that affects the
 * result (`uri`, `cursor`), in stable order. `_meta` is per-caller and never
 * part of it.
 */
export function cacheParamsKey(params: Record<string, unknown> | undefined): string {
	if (!params) return "{}";
	const { _meta: _, ...rest } = params;
	return stableStringifyJson(rest);
}

function migrate(db: Database): void {
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	if (version >= SCHEMA_VERSION) return;
	db.transaction(() => {
		db.run(`CREATE TABLE IF NOT EXISTS eras (
			key TEXT PRIMARY KEY,
			era TEXT NOT NULL,
			probed_at INTEGER NOT NULL
		)`);
		db.run(`CREATE TABLE IF NOT EXISTS results (
			key TEXT NOT NULL,
			method TEXT NOT NULL,
			params TEXT NOT NULL,
			result TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			ttl_ms INTEGER NOT NULL,
			used_at INTEGER NOT NULL,
			PRIMARY KEY (key, method, params)
		)`);
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}

function openDatabase(file: string): Database {
	const db = new Database(file, { create: true });
	try {
		db.run("PRAGMA journal_mode = WAL");
		db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
		migrate(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/** SQLite's wording for a file that is not a usable database (SQLITE_CORRUPT, SQLITE_NOTADB). */
const CORRUPT_DATABASE = /malformed|not a database|corrupt/i;

/**
 * Open `file`, creating it. A corrupt file is a cache that can be rebuilt, so
 * it is deleted and recreated. Any other failure (another process holding the
 * lock, an unwritable directory) leaves the file alone: the daemon and an
 * in-process host share it, and unlinking a database a peer has open would
 * split them onto different files. The store then lives in memory.
 */
function openStoreDatabase(file: string): Database {
	if (file === MEMORY_FILE) return openDatabase(file);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		return openDatabase(file);
	} catch (error) {
		if (!CORRUPT_DATABASE.test(String(error))) {
			logger.warn("MCP store unavailable; caching in memory", { file, error: String(error) });
			return openDatabase(MEMORY_FILE);
		}
		logger.warn("MCP store corrupt; rebuilding", { file, error: String(error) });
	}
	try {
		for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
		return openDatabase(file);
	} catch (error) {
		logger.warn("MCP store unavailable; caching in memory", { file, error: String(error) });
		return openDatabase(MEMORY_FILE);
	}
}

const MEMORY_FILE = ":memory:";

/**
 * Era records and cached results of every server the host has reached.
 *
 * The handle opens its database on first use and again after {@link close},
 * so units that outlive a host teardown (a daemon re-exec that fails and is
 * rolled back) keep a working store.
 */
export class McpStore {
	readonly #file: string;
	#opened: Database | undefined;

	private constructor(file: string) {
		this.#file = file;
	}

	/** The store at `<dir>/cache.db`. */
	static open(dir: string): McpStore {
		return new McpStore(path.join(dir, DB_FILE));
	}

	/** A store that dies with the process. */
	static memory(): McpStore {
		return new McpStore(MEMORY_FILE);
	}

	get #db(): Database {
		if (!this.#opened) {
			this.#opened = openStoreDatabase(this.#file);
			this.#opened.run("DELETE FROM results WHERE used_at < ?", [Date.now() - UNUSED_ENTRY_MS]);
		}
		return this.#opened;
	}

	era(key: string): McpEraRecord | undefined {
		const row = this.#db.query<EraRow, [string]>("SELECT era, probed_at FROM eras WHERE key = ?").get(key);
		if (!row || (row.era !== "modern" && row.era !== "legacy")) return undefined;
		return { era: row.era, probedAt: row.probed_at };
	}

	setEra(key: string, era: McpEra): void {
		this.#db.run("INSERT OR REPLACE INTO eras (key, era, probed_at) VALUES (?, ?, ?)", [key, era, Date.now()]);
	}

	/** Forget a verdict that turned out wrong; the next resolve probes again. */
	clearEra(key: string): void {
		this.#db.run("DELETE FROM eras WHERE key = ?", [key]);
	}

	/** The stored result of `method` with `params` (a {@link cacheParamsKey}), fresh or not. */
	get(key: string, method: string, params: string): McpCacheEntry | undefined {
		const row = this.#db
			.query<ResultRow, [string, string, string]>(
				"SELECT result, received_at, ttl_ms, used_at FROM results WHERE key = ? AND method = ? AND params = ?",
			)
			.get(key, method, params);
		if (!row) return undefined;
		let result: unknown;
		try {
			result = JSON.parse(row.result);
		} catch {
			return undefined;
		}
		if (!isRecord(result)) return undefined;
		const now = Date.now();
		if (now - row.used_at > TOUCH_INTERVAL_MS) {
			this.#db.run("UPDATE results SET used_at = ? WHERE key = ? AND method = ? AND params = ?", [
				now,
				key,
				method,
				params,
			]);
		}
		return { result, receivedAt: row.received_at, ttlMs: row.ttl_ms };
	}

	put(key: string, method: string, params: string, result: Record<string, unknown>, ttlMs: number): void {
		const now = Date.now();
		this.#db.run(
			"INSERT OR REPLACE INTO results (key, method, params, result, received_at, ttl_ms, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[key, method, params, JSON.stringify(result), now, Math.max(0, ttlMs), now],
		);
	}

	/**
	 * Drop the stored results of `methods` for `key`: every one of them, or
	 * with `params` (a {@link cacheParamsKey}) only the one for those parameters.
	 */
	invalidate(key: string, methods: readonly string[], params?: string): void {
		for (const method of methods) {
			if (params === undefined) this.#db.run("DELETE FROM results WHERE key = ? AND method = ?", [key, method]);
			else this.#db.run("DELETE FROM results WHERE key = ? AND method = ? AND params = ?", [key, method, params]);
		}
	}

	/** Release the database; the next use opens it again. */
	close(): void {
		this.#opened?.close();
		this.#opened = undefined;
	}
}
