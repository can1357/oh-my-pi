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
 * `/home/zbornheimer=/Users/zbornheimer`: a machine mirroring the canonical
 * machine's directory layout under a different home prefix reads and writes
 * the same SQL session rows. Only read when `SESSIONS_DB_URL` is set.
 */
const SESSION_PATH_PREFIX_ALIAS_ENV = "OMP_SESSION_PATH_PREFIX_ALIAS";

let sqlStorage: Promise<SqlSessionStorage> | undefined;

/**
 * The process-wide session storage: the shared `SqlSessionStorage` when
 * `SESSIONS_DB_URL` is set, otherwise a fresh `FileSessionStorage`.
 *
 * The SQL instance and its client are created once per process — two storages
 * over the same rows would race through separate pools — and a failed `create()`
 * stays cached so every caller surfaces the same error instead of silently
 * splitting sessions between SQL and local files.
 */
export function resolveSessionStorage(): Promise<SessionStorage> {
	const url = process.env[SESSIONS_DB_URL_ENV]?.trim();
	if (!url) return Promise.resolve(new FileSessionStorage());
	sqlStorage ??= (async () => {
		const table = process.env[SESSIONS_DB_TABLE_ENV]?.trim();
		// Parsed before the client exists so a malformed alias fails every caller
		// with the same error instead of keying rows under the wrong prefix.
		const pathAlias = parseSessionPathPrefixAlias(process.env[SESSION_PATH_PREFIX_ALIAS_ENV]);
		return SqlSessionStorage.create({ client: new SQL(url), table: table || undefined, pathAlias });
	})();
	return sqlStorage;
}
