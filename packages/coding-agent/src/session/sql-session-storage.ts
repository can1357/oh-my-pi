import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / concat / byte-slice syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * Minimal subset of the `Bun.SQL` instance surface used by
 * {@link SqlSessionStorage}. Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
export interface SqlSessionStorageClient {
	unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
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
	 * Table name to use. Default: `omp_session_files`. Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,62}` — inlined into prepared statements at
	 * startup, so we accept identifier-safe inputs only (no quoted/dotted
	 * names).
	 */
	table?: string;
	/**
	 * If true, run `CREATE TABLE IF NOT EXISTS` during `create()`.
	 * Default: true. Disable when the table is owned by an external
	 * migration.
	 */
	createTable?: boolean;
}

interface DialectQueries {
	createTable: string;
	/** Add title metadata columns to existing tables created before title fields existed. */
	addTitleColumns: readonly string[];
	/** Insert or replace the full content for `path`. Used for `writeText`/`flags="w"` truncate. */
	upsertReplace: string;
	/** Insert if missing; otherwise append the new chunk to existing content. Used for `writeLine`. */
	upsertAppend: string;
	/** Update indexed title metadata without rewriting the JSONL body. */
	updateTitle: string;
	/** Delete a single row by path. */
	delete: string;
	/** Move a row from one path to another (caller deletes any conflicting destination first). */
	rename: string;
	/** Warm the synchronous index without transferring full content. */
	loadIndex: string;
	/** Read the full content for the async `readText` surface. */
	readFull: string;
	/** Read bounded byte windows from the head and tail of the content. */
	readSlices: string;
}

interface IndexRow {
	path: string;
	byte_len: number | bigint | string;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface ContentRow {
	content: string;
}

interface SliceRow {
	head: unknown;
	tail: unknown;
}

const DEFAULT_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const utf8Decoder = new TextDecoder("utf-8");

function enoent(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOENT: no such file, '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.errno = -2;
	err.path = p;
	err.syscall = "open";
	return err;
}

function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";

	if (adapter === "mysql") {
		return {
			createTable:
				`CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL` +
				`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			addTitleColumns: [
				`ALTER TABLE ${table} ADD COLUMN title TEXT NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_source VARCHAR(16) NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_updated_at VARCHAR(64) NULL`,
			],
			upsertReplace:
				`INSERT INTO ${table} (path, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = VALUES(content), mtime_ms = VALUES(mtime_ms), title = VALUES(title), title_source = VALUES(title_source), title_updated_at = VALUES(title_updated_at)`,
			upsertAppend:
				`INSERT INTO ${table} (path, content, mtime_ms) VALUES (?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = CONCAT(content, VALUES(content)), mtime_ms = VALUES(mtime_ms)`,
			updateTitle: `UPDATE ${table} SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ? WHERE path = ?`,
			delete: `DELETE FROM ${table} WHERE path = ?`,
			rename: `UPDATE ${table} SET path = ?, mtime_ms = ? WHERE path = ?`,
			loadIndex: `SELECT path, mtime_ms, length(content) AS byte_len, title, title_source, title_updated_at FROM ${table}`,
			readFull: `SELECT content AS content FROM ${table} WHERE path = ?`,
			readSlices:
				`SELECT substring(cast(content AS binary), 1, ?) AS head, ` +
				`CASE WHEN ? <= 0 THEN cast('' AS binary) ` +
				`ELSE substring(cast(content AS binary), greatest(1, length(content) - ? + 1)) END AS tail ` +
				`FROM ${table} WHERE path = ?`,
		};
	}

	const mtimeType = adapter === "postgres" ? "BIGINT" : "INTEGER";
	const tableQualifier = `${table}.content`;
	const byteLengthExpr = adapter === "postgres" ? "octet_length(content)" : "length(cast(content AS blob))";
	const readSlices =
		adapter === "postgres"
			? `SELECT substring(convert_to(content, 'UTF8') from 1 for ${placeholder(1)}) AS head, ` +
				`CASE WHEN ${placeholder(2)} <= 0 THEN ''::bytea ` +
				`ELSE substring(convert_to(content, 'UTF8') from greatest(1, octet_length(content) - ${placeholder(2)} + 1)) END AS tail ` +
				`FROM ${table} WHERE path = ${placeholder(3)}`
			: `SELECT substr(cast(content AS blob), 1, ?) AS head, ` +
				`CASE WHEN ? <= 0 THEN x'' ELSE substr(cast(content AS blob), -?) END AS tail ` +
				`FROM ${table} WHERE path = ?`;

	return {
		createTable:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`path TEXT PRIMARY KEY, ` +
			`content TEXT NOT NULL, ` +
			`mtime_ms ${mtimeType} NOT NULL, ` +
			`title TEXT, ` +
			`title_source TEXT, ` +
			`title_updated_at TEXT` +
			`)`,
		addTitleColumns: [
			`ALTER TABLE ${table} ADD COLUMN title TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_source TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_updated_at TEXT`,
		],
		upsertReplace:
			`INSERT INTO ${table} (path, content, mtime_ms, title, title_source, title_updated_at) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}, ${placeholder(4)}, ${placeholder(5)}, ${placeholder(6)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, title = excluded.title, title_source = excluded.title_source, title_updated_at = excluded.title_updated_at`,
		upsertAppend:
			`INSERT INTO ${table} (path, content, mtime_ms) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = ${tableQualifier} || excluded.content, mtime_ms = excluded.mtime_ms`,
		updateTitle: `UPDATE ${table} SET title = ${placeholder(1)}, title_source = ${placeholder(2)}, title_updated_at = ${placeholder(3)}, mtime_ms = ${placeholder(4)} WHERE path = ${placeholder(5)}`,
		delete: `DELETE FROM ${table} WHERE path = ${placeholder(1)}`,
		rename: `UPDATE ${table} SET path = ${placeholder(1)}, mtime_ms = ${placeholder(2)} WHERE path = ${placeholder(3)}`,
		loadIndex: `SELECT path, mtime_ms, ${byteLengthExpr} AS byte_len, title, title_source, title_updated_at FROM ${table}`,
		readFull: `SELECT content AS content FROM ${table} WHERE path = ${placeholder(1)}`,
		readSlices,
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

function decodeSqlBytes(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return utf8Decoder.decode(value);
	if (value instanceof ArrayBuffer) return utf8Decoder.decode(new Uint8Array(value));
	return String(value);
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file maps to a row keyed by `path`; one table stores the file
 * contents while this process keeps only a metadata index (`size`, `mtimeMs`) in
 * memory for synchronous `existsSync` / `statSync` / `listFilesSync` calls.
 *
 * Works against PostgreSQL, MySQL/MariaDB, and SQLite by selecting the
 * dialect-correct DDL, upsert, string-concat, byte-length, and byte-slice syntax
 * at construction.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;

	constructor(backend: SessionStorageBackend, adapter: SqlSessionStorageAdapter, table: string) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
	}

	/**
	 * Apply the dialect-correct DDL (unless `createTable: false` is set) and warm
	 * the metadata index with every existing row. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(backend, backend.adapter, backend.table);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(`SqlSessionStorage: table name must match ${IDENT_RE.source} (got ${JSON.stringify(table)})`);
		}
		this.#table = table;
		this.#q = buildQueries(this.#adapter, table);
		this.#createTable = options.createTable !== false;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	async init(): Promise<void> {
		if (this.#createTable) {
			await this.#client.unsafe(this.#q.createTable);
			for (const query of this.#q.addTitleColumns) {
				try {
					await this.#client.unsafe(query);
				} catch (err) {
					if (!isDuplicateColumnError(err)) throw err;
				}
			}
		}
	}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		const rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		return rows.map(row => ({
			path: row.path,
			size: rowNumber(row.byte_len),
			mtimeMs: rowNumber(row.mtime_ms),
			title: row.title ?? undefined,
			titleSource: rowTitleSource(row.title_source),
			titleUpdatedAt: row.title_updated_at ?? undefined,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		const rows = (await this.#client.unsafe(this.#q.readFull, [path])) as ContentRow[];
		const row = rows[0];
		return row ? row.content : null;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const values =
			this.#adapter === "postgres"
				? [prefixBytes, suffixBytes, path]
				: [prefixBytes, suffixBytes, suffixBytes, path];
		const rows = (await this.#client.unsafe(this.#q.readSlices, values)) as SliceRow[];
		const row = rows[0];
		if (!row) throw enoent(path);
		return [decodeSqlBytes(row.head), decodeSqlBytes(row.tail)];
	}

	async writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate): Promise<void> {
		await this.#client.unsafe(this.#q.upsertReplace, [
			path,
			content,
			mtimeMs,
			title?.title ?? null,
			title?.source ?? null,
			title?.updatedAt ?? null,
		]);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.updateTitle, [
			title.title ?? null,
			title.source ?? null,
			title.updatedAt,
			mtimeMs,
			path,
		]);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.upsertAppend, [path, line, mtimeMs]);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) {
			await this.#client.unsafe(this.#q.delete, [path]);
		}
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.delete, [dst]);
		await this.#client.unsafe(this.#q.rename, [dst, mtimeMs, src]);
	}
}
