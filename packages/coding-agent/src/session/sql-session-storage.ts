import * as path from "node:path";
import { SQL } from "bun";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { eexist, enoent } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/** Key prefix of a file under the sessions root: `sessions/` and its root-relative path. */
export const ROOT_KEY_PREFIX = "sessions/";
/** Key prefix of a file outside the sessions root: `abs:` and its absolute path. */
export const ABSOLUTE_KEY_PREFIX = "abs:";

/**
 * The row key of the session file `file`. A file under `sessionsRoot` is keyed
 * `sessions/` followed by its path relative to that root, slash-separated on
 * every platform, so the key names the same session whatever the home
 * directory or machine of the process that reads it: the encoded working
 * directory is part of that relative path. Any other file (`--session <file>`,
 * `--session-dir` outside the root) is keyed `abs:` followed by its absolute
 * path.
 */
export function sessionRowKey(file: string, sessionsRoot: string = getSessionsDir()): string {
	const root = path.resolve(sessionsRoot);
	const resolved = path.resolve(file);
	const relative = path.relative(root, resolved);
	const inside =
		relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	return inside ? ROOT_KEY_PREFIX + relative.split(path.sep).join("/") : ABSOLUTE_KEY_PREFIX + resolved;
}

/**
 * The local path of the row keyed `key` ({@link sessionRowKey} reversed), or
 * `undefined` for a key this process would never write for that path: one
 * written before root-relative keys (an absolute path with no prefix), a
 * `sessions/` key with an empty, `.` or `..` segment, or an `abs:` key naming
 * a file under this root. Mapping only such round-trip keys keeps one row per
 * local path, so a read, a write and the index always agree on the row.
 */
export function sessionRowPath(key: string, sessionsRoot: string = getSessionsDir()): string | undefined {
	let file: string;
	if (key.startsWith(ROOT_KEY_PREFIX)) {
		const segments = key.slice(ROOT_KEY_PREFIX.length).split("/");
		if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return undefined;
		file = path.join(path.resolve(sessionsRoot), ...segments);
	} else if (key.startsWith(ABSOLUTE_KEY_PREFIX)) {
		file = key.slice(ABSOLUTE_KEY_PREFIX.length);
		if (!path.isAbsolute(file)) return undefined;
	} else {
		return undefined;
	}
	return sessionRowKey(file, sessionsRoot) === key ? file : undefined;
}

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / byte-slice syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * SQL executor shared by the pooled client and its transaction-scoped handle.
 * Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
export interface SqlSessionStorageTransaction {
	unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult>;
}

/**
 * Bun.SQL-compatible client. PostgreSQL and MySQL writes run in `transaction()`
 * so a session row and its parts change together; on SQLite the store issues
 * `BEGIN IMMEDIATE` / `COMMIT` through `unsafe()` itself and runs one call at a
 * time per client, because Bun's SQLite adapter has a single connection.
 */
export interface SqlSessionStorageClient extends SqlSessionStorageTransaction {
	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
}

/** Array result returned by `Bun.SQL`, including MySQL mutation metadata. */
export interface SqlSessionStorageResult extends Array<unknown> {
	affectedRows?: number;
}

export interface SqlSessionStorageOptions {
	/** Connected `Bun.SQL` instance (PostgreSQL, MySQL, or SQLite). */
	client: SqlSessionStorageClient;
	/**
	 * Override the auto-detected adapter. Useful when the client is wrapped
	 * (e.g. by a pool) and `client.options.adapter` is unreliable.
	 */
	adapter?: SqlSessionStorageAdapter;
	/**
	 * Session table name. Default: `omp_session_files`; appended parts live in
	 * `<table>_parts`. Must match `[A-Za-z_][A-Za-z0-9_]{0,56}`: at most 57
	 * characters, so `<table>_parts` fits the 63-character identifier limit.
	 * Both names are inlined into prepared statements, so we accept
	 * identifier-safe inputs only (no quoted/dotted names).
	 */
	table?: string;
	/**
	 * If true, create both tables and migrate an older session table during
	 * `create()`. Default: true. With false, `create()` runs no DDL and refuses
	 * to start unless the schema docs/session.md ("SQL session storage")
	 * describes is in place; use it when the tables are owned by an external
	 * migration.
	 */
	createTable?: boolean;
	/**
	 * The sessions root this process keys rows against (see {@link sessionRowKey}):
	 * a file under it is stored as `sessions/<path relative to it>`, any other
	 * file as `abs:<absolute path>`. Default: this process's `getSessionsDir()`.
	 */
	sessionsRoot?: string;
	/**
	 * Rewrite the text of every database error that leaves the store, for
	 * example to remove the connection string: a database error can quote any
	 * text, and the session layer prints the errors of its storage. A driver
	 * error (`SQL.SQLError`) then leaves as a {@link SqlSessionStorageDatabaseError},
	 * and an `AggregateError` with its errors rewritten; every error the store
	 * raises on purpose (a write conflict, `ENOENT`, `EEXIST`, a refusal)
	 * leaves as it is. Default: errors leave as the driver raised them.
	 */
	redactError?: (text: string) => string;
}

/**
 * A database driver error as it leaves a store given `redactError`: the
 * driver's `name`, `code`, `errno`, `sqlState` and `severity` as they were, its
 * message and its `detail`, `hint` and `where` redacted, and no cause.
 */
export class SqlSessionStorageDatabaseError extends Error {
	readonly code: unknown;
	readonly errno: unknown;
	readonly sqlState: unknown;
	readonly severity: unknown;
	readonly detail: string | undefined;
	readonly hint: string | undefined;
	readonly where: string | undefined;

	constructor(source: Error, redact: (text: string) => string) {
		super(redact(source.message));
		this.name = source.name;
		const field = (name: string): unknown => (name in source ? Reflect.get(source, name) : undefined);
		const text = (name: string): string | undefined => {
			const value = field(name);
			return typeof value === "string" ? redact(value) : undefined;
		};
		this.code = field("code");
		this.errno = field("errno");
		this.sqlState = field("sqlState");
		this.severity = field("severity");
		this.detail = text("detail");
		this.hint = text("hint");
		this.where = text("where");
	}
}

/** `err` with its database errors' text rewritten by `redact` (see {@link SqlSessionStorageOptions.redactError}). */
function redactDatabaseError(err: unknown, redact: (text: string) => string): unknown {
	if (err instanceof AggregateError) {
		return new AggregateError(
			err.errors.map(inner => redactDatabaseError(inner, redact)),
			redact(err.message),
		);
	}
	return err instanceof SQL.SQLError ? new SqlSessionStorageDatabaseError(err, redact) : err;
}

/** A dialect-rendered statement and the names of the values it binds, in binding order. */
interface Statement {
	readonly sql: string;
	readonly params: readonly string[];
}

type StatementValues = Readonly<Record<string, string | number | null>>;

interface DialectQueries {
	createTable: string;
	createPartsTable: string;
	/** Columns added to session tables created before they existed, each run only when the column is missing. */
	addColumns: ReadonlyArray<{ column: string; ddl: string }>;
	/** Any row written before `byte_len` existed; read without locking. */
	findUnmeasured: string;
	/** Measure rows written before `byte_len` existed. */
	backfillByteLen: string;
	/** One row key written before root-relative keys (neither `sessions/…` nor `abs:…`); read without locking. */
	findLegacyKey: string;
	/** Column names of the table named `@table`; none when it does not exist. */
	columns: Statement;
	/** Warm the synchronous index from session rows only, never content. */
	loadIndex: string;
	/**
	 * One append: grow the session row's `byte_len` (taking its row lock), then
	 * insert the line as a part at the old length. PostgreSQL does both in one
	 * statement; the other dialects run these in one transaction.
	 */
	append: readonly Statement[];
	/** The session's `byte_len`, row-locked for the rest of the transaction where the dialect can. */
	lockSize: Statement;
	/** Insert or replace the session row of a full write. */
	upsertRow: Statement;
	/** Insert the session row of a full write only when `path` has none. */
	insertRowIfMissing: Statement;
	deleteRow: Statement;
	/** Whether `path` has any parts, read without locking. */
	hasParts: Statement;
	deleteParts: Statement;
	/**
	 * Delete every session row whose path starts with `@dir` (its first `@len`
	 * characters equal it; a character comparison, not `LIKE`, so `%` and `_`
	 * stay literal and SQLite's ASCII-insensitive `LIKE` cannot match another
	 * case) and exactly those rows' parts. PostgreSQL and MySQL do both in one
	 * statement, so the parts deleted are those of the rows deleted: a row
	 * another client commits between two statements would otherwise keep its
	 * row and lose its parts under READ COMMITTED. SQLite runs the two
	 * statements inside `BEGIN IMMEDIATE`, where no other writer runs.
	 */
	deleteUnder: Statement[];
	insertPart: Statement;
	renameRow: Statement;
	renameParts: Statement;
	exists: Statement;
	/** Update indexed title metadata without touching the content. */
	updateTitle: Statement;
	/** The session row's content and every part, in one statement so they come from one snapshot. */
	readFull: Statement;
	/** Bounded head and tail bytes from the session row and the parts covering each window. */
	readSlices: Statement;
	/** The session's size and its bytes from an offset: the session row's and those of the parts covering the window. */
	readFrom: Statement;
}

interface IndexRow {
	path: string;
	byte_len: number | bigint | string | null;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface ColumnRow {
	column_name: string;
}

interface SizeRow {
	byte_len: number | bigint | string;
}

interface BusyTimeoutRow {
	timeout: number | bigint | string;
}

/** `readFull` row: kind 0 is the session row's own content, kind 1 a part. */
interface ContentRow {
	kind: number | string;
	start_offset: number | bigint | string;
	content: string;
}

/** `readSlices` row: kind 0 is the session row, kind 1 a part in the head window, kind 2 a part in the tail window. */
interface SliceRow {
	kind: number | string;
	start_offset: number | bigint | string;
	head: Uint8Array | null;
	tail: Uint8Array | null;
}

/** `readFrom` row: kind 0 is the session row (with its size), kind 1 a part covering the window. */
interface ReadFromRow {
	kind: number | string;
	start_offset: number | bigint | string;
	byte_len: number | bigint | string | null;
	bytes: Uint8Array | null;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,56}$/;

/**
 * The session table `table` names (default `omp_session_files`), refused
 * unless it is identifier-safe: both it and `<table>_parts` are inlined into
 * statements.
 */
export function sessionTableName(table: string = DEFAULT_TABLE): string {
	if (IDENT_RE.test(table)) return table;
	throw new Error(
		`SqlSessionStorage: table name must match ${IDENT_RE.source}, at most 57 characters so ` +
			`${JSON.stringify(`${table}_parts`)} stays a valid identifier (got ${JSON.stringify(table)})`,
	);
}
/** Largest part a full write stores; an append stores its line as one part. */
const PART_BYTES = 1024 * 1024;
const SCHEMA_DOCS = 'docs/session.md ("SQL session storage")';
const KEY_MIGRATION_COMMAND = 'omp session migrate-keys (docs/session.md, "Row keys")';
/** How long a SQLite connection waits for another process's write lock, when the client sets no wait itself. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;
/** Attempts per write when PostgreSQL or MySQL picks it as a deadlock victim. */
const WRITE_ATTEMPTS = 5;
const utf8Decoder = new TextDecoder("utf-8");
/**
 * Most bytes one `readFrom` piece asks for: PostgreSQL's substr takes integer
 * lengths, and no stored value reaches it (a value is at most 1 GB there).
 */
const MAX_PIECE_BYTES = 0x7fff_ffff;

/** Tail of one SQLite database's call queue; see {@link sqliteQueue}. */
interface SqliteQueue {
	tail: Promise<void>;
}

const sqliteFileQueues = new Map<string, SqliteQueue>();
const sqliteClientQueues = new WeakMap<SqlSessionStorageClient, SqliteQueue>();

/**
 * The call queue every store in this process shares for `client`'s database.
 * Bun's SQLite adapter runs each client's statements on one connection, so a
 * statement issued while another call's transaction is open would join that
 * transaction. And SQLite's busy wait blocks the thread: a client of a file
 * waiting for a lock that another client in this process holds freezes the
 * process for the whole busy timeout, then fails. So calls queue per file
 * (from `options.filename`, which `Bun.SQL` sets) and the busy wait only ever
 * waits on other processes. In-memory databases, and wrappers that hide
 * `options.filename`, queue per client object.
 */
function sqliteQueue(client: SqlSessionStorageClient): SqliteQueue {
	const filename = client.options.filename;
	if (typeof filename !== "string" || filename === "" || filename === ":memory:") {
		let queue = sqliteClientQueues.get(client);
		if (!queue) {
			queue = { tail: Promise.resolve() };
			sqliteClientQueues.set(client, queue);
		}
		return queue;
	}
	const file = path.resolve(filename);
	let queue = sqliteFileQueues.get(file);
	if (!queue) {
		queue = { tail: Promise.resolve() };
		sqliteFileQueues.set(file, queue);
	}
	return queue;
}

/** Run `task` after every task queued before it on `queue`; with no queue, at once. */
function runExclusive<T>(queue: SqliteQueue | undefined, task: () => Promise<T>): Promise<T> {
	if (!queue) return task();
	const result = queue.tail.then(task);
	// The queue only orders tasks; each caller receives its own task's failure.
	queue.tail = result.then(
		() => {},
		() => {},
	);
	return result;
}

/**
 * Give a SQLite connection with no busy timeout one of
 * {@link SQLITE_BUSY_TIMEOUT_MS}, so another process's write lock makes it
 * wait instead of failing at once.
 */
export async function ensureSqliteBusyTimeout(client: SqlSessionStorageTransaction): Promise<void> {
	const [setting] = (await client.unsafe("PRAGMA busy_timeout")) as BusyTimeoutRow[];
	if (setting && rowNumber(setting.timeout) === 0) {
		await client.unsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	}
}

/**
 * Run `work` in one SQLite transaction opened with `BEGIN IMMEDIATE`, which
 * takes the write lock up front: a writer in another process makes it wait
 * (busy timeout) or fail before anything ran. Any failure rolls it back.
 */
async function sqliteTransaction(
	client: SqlSessionStorageClient,
	work: (transaction: SqlSessionStorageTransaction) => Promise<void>,
): Promise<void> {
	await client.unsafe("BEGIN IMMEDIATE");
	try {
		await work(client);
		await client.unsafe("COMMIT");
	} catch (err) {
		// A failed COMMIT (a reader in another process held the file past
		// the busy timeout) leaves the transaction open, so roll back here.
		// SQLite refuses the ROLLBACK when the error already rolled the
		// transaction back (SQLITE_FULL, SQLITE_IOERR, ...); `err` is then
		// the whole story. Any other ROLLBACK failure leaves the connection
		// inside a transaction, so it is reported beside `err`.
		try {
			await client.unsafe("ROLLBACK");
		} catch (rollbackErr) {
			if (!isNoActiveTransactionError(rollbackErr)) {
				throw new AggregateError(
					[err, rollbackErr],
					"SqlSessionStorage: a SQLite transaction failed and its ROLLBACK failed too",
				);
			}
		}
		throw err;
	}
}

/**
 * Run `work` in one transaction on `client`, the way the store runs its
 * writes: `client.transaction()` on PostgreSQL and MySQL, which rolls back
 * when `work` throws; on SQLite `BEGIN IMMEDIATE` … `COMMIT` in the call
 * queue every store in this process shares for that database (see
 * {@link sqliteQueue}), rolled back on any failure.
 */
export function runSqlTransaction(
	client: SqlSessionStorageClient,
	adapter: SqlSessionStorageAdapter,
	work: (transaction: SqlSessionStorageTransaction) => Promise<void>,
): Promise<void> {
	if (adapter !== "sqlite") return client.transaction(work);
	return runExclusive(sqliteQueue(client), () => sqliteTransaction(client, work));
}

export function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

/**
 * Render `@name` markers as the dialect's placeholders: numbered and reused
 * on PostgreSQL (`$1`) and SQLite (`?1`), one positional `?` per use on MySQL.
 */
function statement(adapter: SqlSessionStorageAdapter, template: string): Statement {
	const params: string[] = [];
	const sql = template.replace(/@(\w+)/g, (_marker, name: string) => {
		if (adapter === "mysql") {
			params.push(name);
			return "?";
		}
		let index = params.indexOf(name);
		if (index < 0) index = params.push(name) - 1;
		return adapter === "postgres" ? `$${index + 1}` : `?${index + 1}`;
	});
	return { sql, params };
}

function run(
	executor: SqlSessionStorageTransaction,
	query: Statement,
	values: StatementValues,
): Promise<SqlSessionStorageResult> {
	return executor.unsafe(
		query.sql,
		query.params.map(name => {
			const value = values[name];
			if (value === undefined) throw new Error(`SqlSessionStorage: no value bound for @${name}`);
			return value;
		}),
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const parts = `${table}_parts`;
	const sql = (template: string): Statement => statement(adapter, template);
	const mysql = adapter === "mysql";
	const integer = adapter === "sqlite" ? "INTEGER" : "BIGINT";
	const mysqlTable = ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
	const contentBytes = {
		postgres: "convert_to(content, 'UTF8')",
		mysql: "cast(content AS binary)",
		sqlite: "cast(content AS blob)",
	}[adapter];
	const contentByteLength = {
		postgres: "octet_length(content)",
		mysql: "length(content)",
		sqlite: "length(cast(content AS blob))",
	}[adapter];
	const emptyBytes = { postgres: "''::bytea", mysql: "cast('' AS binary)", sqlite: "x''" }[adapter];
	const greatest = adapter === "sqlite" ? "max" : "greatest";
	// PostgreSQL's substr takes integer positions; offsets within one value always fit.
	const position = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS integer)` : expr);
	// PostgreSQL types a bare parameter from its first use; offsets past 2^31 need bigint.
	const bigint = (expr: string): string => (adapter === "postgres" ? `CAST(${expr} AS bigint)` : expr);
	const rowColumns = "path, content, mtime_ms, title, title_source, title_updated_at, byte_len";
	const rowValues = "@path, '', @mtime, @title, @title_source, @title_updated_at, @len";
	const appendRow = `INSERT INTO ${table} (path, content, mtime_ms, byte_len) VALUES (@path, '', @mtime, @len) `;
	// Scalar subqueries rather than a CTE, so MySQL 5.7 runs this too.
	const tailStart = `(SELECT byte_len FROM ${table} WHERE path = @path) - @suffix`;

	return {
		createTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL, ` +
				`byte_len BIGINT NULL` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${table} (` +
				`path TEXT PRIMARY KEY, ` +
				`content TEXT NOT NULL, ` +
				`mtime_ms ${integer} NOT NULL, ` +
				`title TEXT, ` +
				`title_source TEXT, ` +
				`title_updated_at TEXT, ` +
				`byte_len ${integer}` +
				`)`,
		createPartsTable: mysql
			? `CREATE TABLE IF NOT EXISTS ${parts} (` +
				`path VARCHAR(512) NOT NULL, ` +
				`start_offset BIGINT NOT NULL, ` +
				`content LONGTEXT NOT NULL, ` +
				`PRIMARY KEY (path, start_offset)` +
				mysqlTable
			: `CREATE TABLE IF NOT EXISTS ${parts} (` +
				`path TEXT NOT NULL, ` +
				`start_offset ${integer} NOT NULL, ` +
				`content TEXT NOT NULL, ` +
				`PRIMARY KEY (path, start_offset)` +
				`)`,
		addColumns: [
			{ column: "title", ddl: `ALTER TABLE ${table} ADD COLUMN title TEXT${mysql ? " NULL" : ""}` },
			{
				column: "title_source",
				ddl: `ALTER TABLE ${table} ADD COLUMN title_source ${mysql ? "VARCHAR(16) NULL" : "TEXT"}`,
			},
			{
				column: "title_updated_at",
				ddl: `ALTER TABLE ${table} ADD COLUMN title_updated_at ${mysql ? "VARCHAR(64) NULL" : "TEXT"}`,
			},
			{ column: "byte_len", ddl: `ALTER TABLE ${table} ADD COLUMN byte_len ${integer}${mysql ? " NULL" : ""}` },
		],
		findUnmeasured: `SELECT 1 AS unmeasured FROM ${table} WHERE byte_len IS NULL LIMIT 1`,
		backfillByteLen: `UPDATE ${table} SET byte_len = ${contentByteLength} WHERE byte_len IS NULL`,
		// `substr` comparisons, not LIKE: SQLite's LIKE ignores ASCII case.
		findLegacyKey:
			`SELECT path FROM ${table} WHERE substr(path, 1, ${ROOT_KEY_PREFIX.length}) <> '${ROOT_KEY_PREFIX}' ` +
			`AND substr(path, 1, ${ABSOLUTE_KEY_PREFIX.length}) <> '${ABSOLUTE_KEY_PREFIX}' LIMIT 1`,
		columns: sql(
			{
				postgres:
					"SELECT attname AS column_name FROM pg_attribute " +
					"WHERE attrelid = to_regclass(@table) AND attnum > 0 AND NOT attisdropped",
				mysql:
					"SELECT column_name AS column_name FROM information_schema.columns " +
					"WHERE table_schema = DATABASE() AND table_name = @table",
				sqlite: "SELECT name AS column_name FROM pragma_table_info(@table)",
			}[adapter],
		),
		loadIndex: `SELECT path, mtime_ms, byte_len, title, title_source, title_updated_at FROM ${table}`,
		append:
			adapter === "postgres"
				? [
						sql(
							`WITH s AS (${appendRow}` +
								`ON CONFLICT (path) DO UPDATE SET byte_len = ${table}.byte_len + excluded.byte_len, ` +
								`mtime_ms = excluded.mtime_ms RETURNING byte_len) ` +
								`INSERT INTO ${parts} (path, start_offset, content) ` +
								`SELECT @path, s.byte_len - @len, @content FROM s WHERE @len > 0`,
						),
					]
				: [
						sql(
							appendRow +
								(mysql
									? "ON DUPLICATE KEY UPDATE byte_len = byte_len + @len, mtime_ms = @mtime"
									: `ON CONFLICT (path) DO UPDATE SET byte_len = ${table}.byte_len + excluded.byte_len, ` +
										"mtime_ms = excluded.mtime_ms"),
						),
						sql(
							`INSERT INTO ${parts} (path, start_offset, content) ` +
								`SELECT path, byte_len - @len, @content FROM ${table} WHERE path = @path AND @len > 0`,
						),
					],
		lockSize: sql(`SELECT byte_len FROM ${table} WHERE path = @path${adapter === "sqlite" ? "" : " FOR UPDATE"}`),
		upsertRow: sql(
			`INSERT INTO ${table} (${rowColumns}) VALUES (${rowValues}) ` +
				(mysql
					? "ON DUPLICATE KEY UPDATE content = '', mtime_ms = @mtime, title = @title, " +
						"title_source = @title_source, title_updated_at = @title_updated_at, byte_len = @len"
					: "ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, " +
						"title = excluded.title, title_source = excluded.title_source, " +
						"title_updated_at = excluded.title_updated_at, byte_len = excluded.byte_len"),
		),
		insertRowIfMissing: sql(
			mysql
				? `INSERT IGNORE INTO ${table} (${rowColumns}) VALUES (${rowValues})`
				: `INSERT INTO ${table} (${rowColumns}) VALUES (${rowValues}) ON CONFLICT (path) DO NOTHING RETURNING path`,
		),
		deleteRow: sql(`DELETE FROM ${table} WHERE path = @path`),
		hasParts: sql(`SELECT 1 AS found FROM ${parts} WHERE path = @path LIMIT 1`),
		deleteParts: sql(`DELETE FROM ${parts} WHERE path = @path`),
		deleteUnder: {
			postgres: [
				sql(
					`WITH gone AS (DELETE FROM ${table} WHERE substr(path, 1, @len) = @dir RETURNING path) ` +
						`DELETE FROM ${parts} WHERE path IN (SELECT path FROM gone)`,
				),
			],
			mysql: [
				sql(
					`DELETE r, p FROM ${table} AS r LEFT JOIN ${parts} AS p ON p.path = r.path ` +
						`WHERE substr(r.path, 1, @len) = @dir`,
				),
			],
			sqlite: [
				sql(`DELETE FROM ${parts} WHERE substr(path, 1, @len) = @dir`),
				sql(`DELETE FROM ${table} WHERE substr(path, 1, @len) = @dir`),
			],
		}[adapter],
		insertPart: sql(`INSERT INTO ${parts} (path, start_offset, content) VALUES (@path, @offset, @content)`),
		renameRow: sql(
			`UPDATE ${table} SET path = @dst, mtime_ms = @mtime WHERE path = @src${mysql ? "" : " RETURNING path"}`,
		),
		renameParts: sql(`UPDATE ${parts} SET path = @dst WHERE path = @src`),
		exists: sql(`SELECT path FROM ${table} WHERE path = @path`),
		updateTitle: sql(
			`UPDATE ${table} SET title = @title, title_source = @title_source, title_updated_at = @title_updated_at, ` +
				"mtime_ms = @mtime WHERE path = @path",
		),
		readFull: sql(
			`SELECT 0 AS kind, 0 AS start_offset, content FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, content FROM ${parts} WHERE path = @path`,
		),
		// The session row holds bytes [0, length(content)), its parts the rest.
		// A head part starts before `@prefix`; the tail starts in the last part
		// starting at or before `byte_len - @suffix` (every part when none
		// does, i.e. the tail reaches into the row's own content).
		readSlices: sql(
			`SELECT 0 AS kind, 0 AS start_offset, ` +
				`CASE WHEN @prefix > 0 THEN substr(${contentBytes}, 1, @prefix) ELSE ${emptyBytes} END AS head, ` +
				`CASE WHEN @suffix > 0 AND byte_len - @suffix < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position(`${greatest}(0, byte_len - @suffix) + 1`)}) ` +
				`ELSE ${emptyBytes} END AS tail FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, substr(${contentBytes}, 1, ${position("@prefix - start_offset")}), NULL ` +
				`FROM ${parts} WHERE path = @path AND start_offset < @prefix ` +
				`UNION ALL SELECT 2, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${tailStart} - start_offset) + 1`)}) ` +
				`FROM ${parts} WHERE @suffix > 0 AND path = @path AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path AND start_offset <= ${tailStart})`,
		),
		// The session row holds bytes [0, length(content)), its parts the rest. The
		// parts read are those that end after `@offset` and start before `@end`,
		// from the last one starting at or before `@offset` (every part when none
		// does, i.e. the window starts in the row's own content). Each piece is
		// at most `@take` bytes from where the window enters it; `@row_from` is
		// the 1-based row position `@offset + 1`, clamped where the row cannot reach.
		readFrom: sql(
			`SELECT 0 AS kind, 0 AS start_offset, byte_len, ` +
				`CASE WHEN ${bigint("@offset")} < ${contentByteLength} ` +
				`THEN substr(${contentBytes}, ${position("@row_from")}, ${position("@take")}) ` +
				`ELSE ${emptyBytes} END AS bytes FROM ${table} WHERE path = @path ` +
				`UNION ALL SELECT 1, start_offset, NULL, ` +
				`substr(${contentBytes}, ${position(`${greatest}(0, ${bigint("@offset")} - start_offset) + 1`)}, ` +
				`${position("@take")}) ` +
				`FROM ${parts} WHERE path = @path AND start_offset < ${bigint("@end")} ` +
				`AND start_offset + ${contentByteLength} > ${bigint("@offset")} AND start_offset >= (` +
				`SELECT coalesce(max(start_offset), -1) FROM ${parts} WHERE path = @path ` +
				`AND start_offset <= ${bigint("@offset")})`,
		),
	};
}

function rowNumber(value: number | bigint | string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
function rowTitleSource(value: string | null | undefined): SessionTitleUpdate["source"] | undefined {
	return value === "auto" || value === "user" ? value : undefined;
}
function isDuplicateColumnError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("duplicate column") || message.includes("already exists");
}
/** SQLite's refusal of a ROLLBACK after an error that already rolled the transaction back. */
function isNoActiveTransactionError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("no transaction is active");
}
/** MySQL `ER_LOCK_DEADLOCK` (errno 1213, SQLSTATE 40001) or PostgreSQL `deadlock_detected` / `serialization_failure`. */
function isDeadlockError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const errno = "errno" in error ? error.errno : undefined;
	const sqlState = "sqlState" in error ? error.sqlState : undefined;
	return errno === 1213 || errno === "40P01" || errno === "40001" || sqlState === "40001";
}
/**
 * A primary-key collision, as each dialect reports it: PostgreSQL
 * `unique_violation` (SQLSTATE 23505), MySQL `ER_DUP_ENTRY` (errno 1062,
 * SQLSTATE 23000), SQLite `SQLITE_CONSTRAINT_PRIMARYKEY` (extended code 1555).
 */
function isPrimaryKeyViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const errno = "errno" in error ? error.errno : undefined;
	const code = "code" in error ? error.code : undefined;
	return errno === "23505" || errno === 1062 || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/** Concatenate a window's pieces in byte-offset order; the session row's own bytes come first. */
function joinSliceBytes(first: Uint8Array | null, pieces: Array<{ offset: number; bytes: Uint8Array | null }>): Buffer {
	pieces.sort((a, b) => a.offset - b.offset);
	const chunks: Uint8Array[] = [];
	for (const bytes of [first, ...pieces.map(piece => piece.bytes)]) {
		if (bytes) chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file is a row of the session table keyed by `path`, holding
 * its metadata (`byte_len`, `mtime_ms`, title fields), plus rows of
 * `<table>_parts` keyed by (`path`, `start_offset`): an append inserts one
 * part, a full write replaces them with parts of at most 1 MiB. A session's
 * content is the row's `content` (non-empty only for rows an older version
 * wrote) followed by its parts in offset order. This process keeps only a
 * metadata index (`size`, `mtimeMs`) in memory for synchronous `existsSync` /
 * `statSync` / `listFilesSync` calls.
 *
 * Callers (`SessionManager`, the listing code) work with local paths; the
 * store maps each to its row key at the backend boundary with
 * {@link keyFor} and back with {@link pathFor}, so a session written from one
 * home directory or machine resolves from another.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, upsert, row-lock, byte-length, and byte-slice syntax
 * at construction.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #sessionsRoot: string;

	constructor(
		backend: SessionStorageBackend,
		adapter: SqlSessionStorageAdapter,
		table: string,
		sessionsRoot: string = getSessionsDir(),
	) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
		this.#sessionsRoot = path.resolve(sessionsRoot);
	}

	/**
	 * Apply the dialect-correct DDL and migration (unless `createTable: false`
	 * is set, which instead verifies the schema is in place) and warm the
	 * metadata index with every existing row. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(backend, backend.adapter, backend.table, backend.sessionsRoot);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	/** The row key this store reads and writes for the local path `file` ({@link sessionRowKey}). */
	keyFor(file: string): string {
		return sessionRowKey(file, this.#sessionsRoot);
	}

	/** The local path of the row keyed `key`, or `undefined` when this store never maps to that key ({@link sessionRowPath}). */
	pathFor(key: string): string | undefined {
		return sessionRowPath(key, this.#sessionsRoot);
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;
	/** The shared call queue for this client's SQLite database; unset on other dialects. */
	readonly #sqliteQueue: SqliteQueue | undefined;
	readonly #sessionsRoot: string;
	readonly #redactError: ((text: string) => string) | undefined;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		this.#table = sessionTableName(options.table);
		this.#q = buildQueries(this.#adapter, this.#table);
		this.#createTable = options.createTable !== false;
		this.#sqliteQueue = this.#adapter === "sqlite" ? sqliteQueue(options.client) : undefined;
		this.#sessionsRoot = path.resolve(options.sessionsRoot ?? getSessionsDir());
		this.#redactError = options.redactError;
	}

	/**
	 * `err` as it leaves this store. Every driver call runs inside
	 * {@link #exclusive} or {@link #retryDeadlocks}, and each passes the error
	 * it throws through here, so no method lets an unredacted one out.
	 */
	#outward(err: unknown): unknown {
		return this.#redactError ? redactDatabaseError(err, this.#redactError) : err;
	}

	get sessionsRoot(): string {
		return this.#sessionsRoot;
	}

	/** The row key of the local path `file`. */
	#key(file: string): string {
		return sessionRowKey(file, this.#sessionsRoot);
	}

	/**
	 * Every spelling of a path that {@link sessionRowKey} maps to one row (`..`,
	 * repeated separators, a relative path) is one path to the index above.
	 */
	normalizePath(file: string): string {
		return path.resolve(file);
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	init(): Promise<void> {
		return this.#exclusive(async () => {
			if (this.#adapter === "sqlite") await ensureSqliteBusyTimeout(this.#client);
			if (this.#createTable) await this.#applySchema();
			else await this.#assertSchema();
			await this.#assertRowKeys();
		});
	}

	async #applySchema(): Promise<void> {
		await this.#client.unsafe(this.#q.createTable);
		// Probe before altering: PostgreSQL's ALTER TABLE waits for every open
		// transaction on the table even when the column exists.
		const columns = await this.#columns(this.#table);
		for (const { column, ddl } of this.#q.addColumns) {
			if (columns.has(column)) continue;
			try {
				await this.#client.unsafe(ddl);
			} catch (err) {
				// Another process starting at the same moment added it first.
				if (!isDuplicateColumnError(err)) throw err;
			}
		}
		// MySQL's UPDATE locks every row it scans, so a no-op backfill would
		// still wait for, and block, every write in flight.
		if ((await this.#client.unsafe(this.#q.findUnmeasured)).length > 0) {
			await this.#client.unsafe(this.#q.backfillByteLen);
		}
		await this.#client.unsafe(this.#q.createPartsTable);
	}

	/**
	 * Refuse to start against rows keyed by absolute path, as Oh My Pi wrote
	 * them before root-relative keys: this store would neither list nor read
	 * them, and its own writes would start a second row for the same session.
	 */
	async #assertRowKeys(): Promise<void> {
		const [legacy] = (await this.#client.unsafe(this.#q.findLegacyKey)) as Array<{ path: string }>;
		if (!legacy) return;
		throw new Error(
			`SqlSessionStorage: ${this.#table} holds the row key ${JSON.stringify(legacy.path)}, which is neither ` +
				`"${ROOT_KEY_PREFIX}…" nor "${ABSOLUTE_KEY_PREFIX}…". Stop every older Oh My Pi process that writes ` +
				`the table, then migrate its keys with ${KEY_MIGRATION_COMMAND}.`,
		);
	}

	/**
	 * Run `task` alone on its SQLite database: every backend call of every
	 * store in this process on that database goes through one queue (see
	 * {@link sqliteQueue}). Other dialects run statements on pooled
	 * connections and need no queue.
	 */
	#exclusive<T>(task: () => Promise<T>): Promise<T> {
		return runExclusive(this.#sqliteQueue, task).catch((err: unknown) => {
			throw this.#outward(err);
		});
	}

	/**
	 * Run `work` in one transaction. On SQLite it opens with `BEGIN IMMEDIATE`,
	 * taking the write lock up front, so a writer in another process makes it
	 * wait (busy timeout) or fail before anything ran. On PostgreSQL and MySQL
	 * a transaction the database aborts as a deadlock victim runs again; each
	 * one recomputes everything under its own locks.
	 */
	#transaction(work: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		if (this.#adapter !== "sqlite") return this.#retryDeadlocks(() => this.#client.transaction(work));
		return this.#exclusive(() => sqliteTransaction(this.#client, work));
	}

	async #retryDeadlocks(write: () => Promise<unknown>): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await write();
				return;
			} catch (err) {
				if (attempt >= WRITE_ATTEMPTS || !isDeadlockError(err)) throw this.#outward(err);
				await Bun.sleep(Math.random() * 20 * attempt);
			}
		}
	}

	/**
	 * Delete `path`'s parts inside a write transaction. On MySQL, a DELETE that
	 * matches nothing still takes a gap lock, and two transactions inserting
	 * into the gaps each other locked deadlock; so look first, without locking.
	 * Every writer of a path's parts first locks that path's session row. The
	 * look is a consistent read, and under REPEATABLE READ the transaction's
	 * first consistent read fixes its snapshot: a caller must lock the row of
	 * every path it will look at before the first look, or a part a peer
	 * commits in between is invisible to the look and is left orphaned.
	 */
	async #deleteParts(transaction: SqlSessionStorageTransaction, path: string): Promise<void> {
		if (this.#adapter === "mysql" && (await run(transaction, this.#q.hasParts, { path })).length === 0) return;
		await run(transaction, this.#q.deleteParts, { path });
	}

	/** Refuse to start against a schema an external migration has not brought up to date. */
	async #assertSchema(): Promise<void> {
		const partsTable = `${this.#table}_parts`;
		const missing: string[] = [];
		const sessionColumns = await this.#columns(this.#table);
		if (sessionColumns.size === 0) missing.push(`table ${this.#table}`);
		else if (!sessionColumns.has("byte_len")) missing.push(`column ${this.#table}.byte_len`);
		if ((await this.#columns(partsTable)).size === 0) missing.push(`table ${partsTable}`);
		if (missing.length === 0) return;
		throw new Error(
			`SqlSessionStorage: createTable is false, but the database has no ${missing.join(" and no ")}. ` +
				`Apply the schema in ${SCHEMA_DOCS}, or let create() apply it.`,
		);
	}

	async #columns(table: string): Promise<Set<string>> {
		const rows = (await run(this.#client, this.#q.columns, { table })) as ColumnRow[];
		return new Set(rows.map(row => row.column_name.toLowerCase()));
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#exclusive(() => this.#client.unsafe(this.#q.loadIndex))) as IndexRow[];
		const entries: SessionStorageIndexEntry[] = [];
		const unmapped: string[] = [];
		for (const row of rows) {
			const file = sessionRowPath(row.path, this.#sessionsRoot);
			// A key this store would not write back for any local path (an older
			// omp's absolute key, written after start-up): listing it would show a
			// session whose reads and writes go to another row.
			if (file === undefined) {
				unmapped.push(row.path);
				continue;
			}
			if (row.byte_len === null) {
				throw new Error(
					`SqlSessionStorage: ${this.#table} row ${JSON.stringify(row.path)} has no byte_len; ` +
						`run the byte_len backfill in ${SCHEMA_DOCS}.`,
				);
			}
			entries.push({
				path: file,
				size: rowNumber(row.byte_len),
				mtimeMs: rowNumber(row.mtime_ms),
				title: row.title ?? undefined,
				titleSource: rowTitleSource(row.title_source),
				titleUpdatedAt: row.title_updated_at ?? undefined,
			});
		}
		if (unmapped.length > 0) {
			logger.warn("SqlSessionStorage skipped rows whose key it does not write", {
				table: this.#table,
				count: unmapped.length,
				example: unmapped[0],
				docs: KEY_MIGRATION_COMMAND,
			});
		}
		return entries;
	}

	async readFull(file: string): Promise<string | null> {
		const path = this.#key(file);
		const rows = (await this.#exclusive(() => run(this.#client, this.#q.readFull, { path }))) as ContentRow[];
		let head: string | undefined;
		const parts: Array<{ offset: number; content: string }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) === 0) head = row.content;
			else parts.push({ offset: rowNumber(row.start_offset), content: row.content });
		}
		if (head === undefined) return null;
		parts.sort((a, b) => a.offset - b.offset);
		return head + parts.map(part => part.content).join("");
	}

	async readSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const path = this.#key(file);
		const rows = (await this.#exclusive(() =>
			run(this.#client, this.#q.readSlices, { path, prefix: prefixBytes, suffix: suffixBytes }),
		)) as SliceRow[];
		let session: SliceRow | undefined;
		const headParts: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		const tailParts: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		for (const row of rows) {
			const kind = rowNumber(row.kind);
			if (kind === 0) session = row;
			else if (kind === 1) headParts.push({ offset: rowNumber(row.start_offset), bytes: row.head });
			else tailParts.push({ offset: rowNumber(row.start_offset), bytes: row.tail });
		}
		if (!session) throw enoent(file);
		return [
			utf8Decoder.decode(joinSliceBytes(session.head, headParts)),
			utf8Decoder.decode(joinSliceBytes(session.tail, tailParts)),
		];
	}

	async readFrom(file: string, offset: number, maxBytes?: number): Promise<{ text: string; size: number } | null> {
		const path = this.#key(file);
		const take = Math.min(
			maxBytes === undefined ? MAX_PIECE_BYTES : Math.max(0, Math.trunc(maxBytes)),
			MAX_PIECE_BYTES,
		);
		const rows = (await this.#exclusive(() =>
			run(this.#client, this.#q.readFrom, {
				path,
				offset,
				end: maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.min(offset + take, Number.MAX_SAFE_INTEGER),
				take,
				row_from: Math.min(offset, MAX_PIECE_BYTES - 1) + 1,
			}),
		)) as ReadFromRow[];
		let size: number | undefined;
		let head: Uint8Array | null = null;
		const pieces: Array<{ offset: number; bytes: Uint8Array | null }> = [];
		for (const row of rows) {
			if (rowNumber(row.kind) !== 0) {
				pieces.push({ offset: rowNumber(row.start_offset), bytes: row.bytes });
				continue;
			}
			if (row.byte_len === null) {
				throw new Error(
					`SqlSessionStorage: ${this.#table} row ${JSON.stringify(file)} has no byte_len; ` +
						`run the byte_len backfill in ${SCHEMA_DOCS}.`,
				);
			}
			size = rowNumber(row.byte_len);
			head = row.bytes;
		}
		if (size === undefined) return null;
		const bytes = joinSliceBytes(head, pieces);
		// Each piece is capped on its own; the window is capped as a whole.
		return { text: utf8Decoder.decode(maxBytes === undefined ? bytes : bytes.subarray(0, take)), size };
	}

	async writeFull(
		file: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const path = this.#key(file);
		const bytes = Buffer.from(content, "utf8");
		const row = {
			path,
			mtime: mtimeMs,
			title: title?.title ?? null,
			title_source: title?.source ?? null,
			title_updated_at: title?.updatedAt ?? null,
			len: bytes.byteLength,
		};
		await this.#transaction(async transaction => {
			if (expectedSize === null) {
				const result = await run(transaction, this.#q.insertRowIfMissing, row);
				const inserted = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
				if (!inserted) throw new SessionWriteConflictError(file, null, await this.#lockSize(transaction, path));
			} else {
				// The size check reads `byte_len` under the row lock rather than
				// trusting a conditional UPDATE's row count, which MySQL reports
				// as 0 for a matched row whose values did not change.
				if (expectedSize !== undefined) {
					const actualSize = await this.#lockSize(transaction, path);
					if (actualSize !== expectedSize) throw new SessionWriteConflictError(file, expectedSize, actualSize);
				}
				await run(transaction, this.#q.upsertRow, row);
			}
			// A created session also drops parts orphaned under its key.
			await this.#deleteParts(transaction, path);
			await this.#insertParts(transaction, path, bytes);
		});
	}

	async #lockSize(transaction: SqlSessionStorageTransaction, path: string): Promise<number | null> {
		const rows = (await run(transaction, this.#q.lockSize, { path })) as SizeRow[];
		const row = rows[0];
		return row ? rowNumber(row.byte_len) : null;
	}

	/** Store `bytes` as parts of at most {@link PART_BYTES}, each ending on a UTF-8 character boundary. */
	async #insertParts(transaction: SqlSessionStorageTransaction, path: string, bytes: Buffer): Promise<void> {
		for (let start = 0; start < bytes.byteLength;) {
			let end = Math.min(start + PART_BYTES, bytes.byteLength);
			// Back off continuation bytes (0b10xxxxxx) so no character straddles two parts.
			while (end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
			await run(transaction, this.#q.insertPart, {
				path,
				offset: start,
				content: bytes.toString("utf8", start, end),
			});
			start = end;
		}
	}

	async updateSessionTitle(file: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		const path = this.#key(file);
		await this.#exclusive(() =>
			run(this.#client, this.#q.updateTitle, {
				path,
				title: title.title ?? null,
				title_source: title.source ?? null,
				title_updated_at: title.updatedAt,
				mtime: mtimeMs,
			}),
		);
	}

	async append(file: string, line: string, mtimeMs: number): Promise<void> {
		const values = { path: this.#key(file), content: line, mtime: mtimeMs, len: Buffer.byteLength(line, "utf8") };
		const [single, ...rest] = this.#q.append;
		if (rest.length === 0) {
			await this.#retryDeadlocks(() => run(this.#client, single, values));
			return;
		}
		await this.#transaction(async transaction => {
			for (const query of this.#q.append) await run(transaction, query, values);
		});
	}

	async truncate(file: string, mtimeMs: number): Promise<void> {
		await this.writeFull(file, "", mtimeMs);
	}

	async remove(files: string[], dirFile?: string): Promise<void> {
		const paths = files.map(file => this.#key(file));
		// The rows under the local directory `dirFile` are keyed under its key:
		// `sessions/<dir under the root>/` or `abs:<dir>/`.
		const dir = dirFile === undefined ? undefined : `${this.#key(dirFile)}/`;
		const under = dir === undefined ? undefined : { dir, len: [...dir].length };
		await this.#transaction(async transaction => {
			// Every row first: their locks must all be held before the first parts look (see #deleteParts).
			for (const path of paths) await run(transaction, this.#q.deleteRow, { path });
			if (under) for (const query of this.#q.deleteUnder) await run(transaction, query, under);
			for (const path of paths) await this.#deleteParts(transaction, path);
		});
	}

	async move(srcFile: string, dstFile: string, mtimeMs: number, noReplace = false): Promise<void> {
		const src = this.#key(srcFile);
		const dst = this.#key(dstFile);
		if (src === dst) {
			const rows = await this.#exclusive(() => run(this.#client, this.#q.exists, { path: src }));
			if (rows.length === 0) throw enoent(srcFile);
			return;
		}
		await this.#transaction(async transaction => {
			if (!noReplace) await run(transaction, this.#q.deleteRow, { path: dst });
			// One statement renames the row, so the primary key refuses a `dst`
			// row that exists, or that another client inserts concurrently (the
			// UPDATE waits on its uncommitted key); the thrown error rolls the
			// transaction back with both paths untouched.
			let result: SqlSessionStorageResult;
			try {
				result = await run(transaction, this.#q.renameRow, { src, dst, mtime: mtimeMs });
			} catch (err) {
				if (noReplace && isPrimaryKeyViolation(err)) throw eexist(dstFile);
				throw err;
			}
			const moved = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!moved) throw enoent(srcFile);
			// Both rows are locked now, before the parts look (see #deleteParts):
			// parts orphaned under `dst` go, then `src`'s follow its row.
			await this.#deleteParts(transaction, dst);
			await run(transaction, this.#q.renameParts, { src, dst });
		});
	}
}
