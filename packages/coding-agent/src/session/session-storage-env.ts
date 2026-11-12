/**
 * Process-wide session storage selection for the CLI.
 *
 * `SESSIONS_DB_URL` opts every session-bearing call site into
 * {@link SqlSessionStorage} on one shared `Bun.SQL` client (dialect
 * auto-detected from the URL), so every `SessionManager` in this process
 * resolves against a single warmed index and publish queue. Unset, callers get
 * exactly the pre-existing per-call `FileSessionStorage` behavior.
 * `OMP_SESSION_PATH_PREFIX_ALIAS` rewrites that storage's row keys between
 * this machine's home prefix and the canonical one, so a machine mirroring
 * the same layout under a different absolute root shares rows; unset (or
 * `SESSIONS_DB_URL` unset) changes nothing.
 */
import { SQL } from "bun";
import { parseSessionPathPrefixAlias } from "./session-path-alias";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";

/** Connection URL of a SQL-backed session storage; unset keeps sessions on local files. */
const SESSIONS_DB_URL_ENV = "SESSIONS_DB_URL";
/** Overrides the SQL session table name (default: `omp_session_files`). */
const SESSIONS_DB_TABLE_ENV = "SESSIONS_DB_TABLE";
/**
 * `"<localPrefix>=<storagePrefix>"` (first `=` separates the sides), e.g.
 * `/home/alice=/Users/alice`: a machine mirroring the canonical
 * machine's directory layout under a different home prefix reads and writes
 * the same SQL session rows. Only read when `SESSIONS_DB_URL` is set.
 */
const SESSION_PATH_PREFIX_ALIAS_ENV = "OMP_SESSION_PATH_PREFIX_ALIAS";

/**
 * Waits between connection attempts of one {@link resolveSessionStorage} call.
 * Covers a serverless database compute waking from scale-to-zero and a pooler that briefly
 * rejects new connections; a database still unreachable after the last wait
 * fails the caller. Bounded so a dead database costs a caller ~1.3 s, not a hang.
 */
const SQL_CONNECT_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/**
 * Server-database pool bounds. One omp process needs a couple of connections at
 * most, and a pool that keeps `idleTimeout: 0` holds every one of them open for
 * the process lifetime — with a dozen concurrent omp processes that exhausts a
 * pooler's connection budget. Idle connections close after 5 s and reopen on
 * demand; a connect attempt gives up after 15 s.
 */
const SQL_POOL_OPTIONS: { max: number; idleTimeout: number; connectionTimeout: number } = {
	max: 2,
	idleTimeout: 5,
	connectionTimeout: 15,
};
const SERVER_SQL_SCHEMES: ReadonlySet<string> = new Set(["postgres:", "postgresql:", "mysql:", "mariadb:"]);

/** Pool bounds for server databases; an embedded SQLite file has no connection pool to bound. */
export function sqlPoolOptions(url: string): Partial<typeof SQL_POOL_OPTIONS> {
	try {
		return SERVER_SQL_SCHEMES.has(new URL(url).protocol.toLowerCase()) ? SQL_POOL_OPTIONS : {};
	} catch {
		return {};
	}
}

let sqlStorage: Promise<SqlSessionStorage> | undefined;
let sleep: (ms: number) => Promise<void> = ms => Bun.sleep(ms);

/**
 * The process-wide session storage: the shared `SqlSessionStorage` when
 * `SESSIONS_DB_URL` is set, otherwise a fresh `FileSessionStorage`.
 *
 * The SQL instance and its client are created once per process — two storages
 * over the same rows would race through separate pools — and concurrent
 * callers share one in-flight creation. A creation that still fails after the
 * bounded retries rejects every caller sharing it (none silently falls back to
 * local files) and is then forgotten, so the next caller connects afresh
 * instead of inheriting a stale connection or credential failure for the rest
 * of the process.
 */
export function resolveSessionStorage(): Promise<SessionStorage> {
	const url = process.env[SESSIONS_DB_URL_ENV]?.trim();
	if (!url) return Promise.resolve(new FileSessionStorage());
	if (sqlStorage) return sqlStorage;
	const creation = createSqlSessionStorage(url);
	sqlStorage = creation;
	creation.catch(() => {
		if (sqlStorage === creation) sqlStorage = undefined;
	});
	return creation;
}

async function createSqlSessionStorage(url: string): Promise<SqlSessionStorage> {
	const table = process.env[SESSIONS_DB_TABLE_ENV]?.trim() || undefined;
	// Parsed before the client exists so a malformed alias fails every caller
	// with the same error instead of keying rows under the wrong prefix.
	const pathAlias = parseSessionPathPrefixAlias(process.env[SESSION_PATH_PREFIX_ALIAS_ENV]);
	for (let attempt = 0; ; attempt++) {
		const client = new SQL(url, sqlPoolOptions(url));
		try {
			return await SqlSessionStorage.create({ client, table, pathAlias });
		} catch (error) {
			// A failed client never serves a caller; release its pool.
			await client.close().catch(() => undefined);
			const delay = SQL_CONNECT_RETRY_DELAYS_MS[attempt];
			if (delay === undefined) throw error;
			await sleep(delay);
		}
	}
}

/** Reset cached process-wide storage for tests; `sleep` replaces the real backoff wait. */
export function resetSessionStorageForTesting(options?: { sleep?: (ms: number) => Promise<void> }): void {
	sqlStorage = undefined;
	sleep = options?.sleep ?? (ms => Bun.sleep(ms));
}
