/**
 * Process-wide session storage selection for the CLI.
 *
 * `SESSIONS_DB_URL` opts every session-bearing call site into
 * {@link SqlSessionStorage} on one shared `Bun.SQL` client (dialect
 * auto-detected from the URL), so every `SessionManager` in this process
 * resolves against a single warmed index and publish queue. Unset, callers get
 * exactly the pre-existing per-call `FileSessionStorage` behavior.
 */
import { SQL } from "bun";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import { SqlSessionStorage } from "./sql-session-storage";

/** Connection URL of a SQL-backed session storage; unset keeps sessions on local files. */
const SESSIONS_DB_URL_ENV = "SESSIONS_DB_URL";
/** Overrides the SQL session table name (default: `omp_session_files`). */
const SESSIONS_DB_TABLE_ENV = "SESSIONS_DB_TABLE";

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
		return SqlSessionStorage.create({ client: new SQL(url), table: table || undefined });
	})();
	return sqlStorage;
}
