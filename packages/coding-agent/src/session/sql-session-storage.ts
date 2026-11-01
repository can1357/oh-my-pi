import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import { SessionWriteConflictError } from "./session-storage";
import { enoent } from "./session-storage-errors";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / upsert / concat / byte-slice syntax for the underlying engine.
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

/** Bun.SQL-compatible client whose transactions make session renames atomic. */
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
	 * Table name to use. Default: `omp_session_files`. Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,62}` — inlined into prepared statements at
	 * startup, so we accept identifier-safe inputs only (no quoted/dotted
	 * names).
	 */
	table?: string;
	/**
	 * If true, run `CREATE TABLE IF NOT EXISTS` during `create()`.
	 * Default: true. Disable when the table is owned by an external
	 * migration. Externally managed tables may omit `title_indexed_size`;
	 * their existing title metadata remains authoritative across reloads.
	 */
	createTable?: boolean;
}

interface DialectQueries {
	createTable: string;
	/** Add title metadata columns to existing tables created before title fields existed. */
	addTitleColumns: readonly string[];
	/** Insert or replace the full content for `path`. Used for `writeText`/`flags="w"` truncate. */
	upsertReplace: string;
	/** Insert a full body only when `path` does not exist. */
	insertIfMissing: string;
	/** Replace a full body only when its current UTF-8 byte length matches. */
	replaceIfSize: string;
	/** Insert if missing; otherwise append the new chunk to existing content. Used for `writeLine`. */
	upsertAppend: string;
	/** Append content and authoritative title metadata in the same statement. */
	upsertAppendIndexed: string;
	/** Update indexed title metadata without rewriting the JSONL body. */
	updateTitle: string;
	/** Reconcile a legacy title only while the physical body still has the scanned size. */
	indexTitle: string;
	/** Delete a single row by path. */
	delete: string;
	/** Move a row from one path to another. */
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
	title_indexed_size?: number | bigint | string | null;
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

function buildQueries(adapter: SqlSessionStorageAdapter, table: string, hasTitleIndexedSize = true): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";
	const titleColumns = `title, title_source, title_updated_at${hasTitleIndexedSize ? ", title_indexed_size" : ""}`;
	const insertValues =
		`${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}, ${placeholder(4)}, ${placeholder(5)}, ${placeholder(6)}` +
		(hasTitleIndexedSize ? `, ${placeholder(7)}` : "");
	const indexedUpdate = hasTitleIndexedSize ? ", title_indexed_size = excluded.title_indexed_size" : "";

	if (adapter === "mysql") {
		return {
			createTable:
				`CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL PRIMARY KEY, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL, title_indexed_size BIGINT NULL` +
				`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			addTitleColumns: [
				`ALTER TABLE ${table} ADD COLUMN title TEXT NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_source VARCHAR(16) NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_updated_at VARCHAR(64) NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_indexed_size BIGINT NULL`,
			],
			upsertReplace:
				`INSERT INTO ${table} (path, content, mtime_ms, ${titleColumns}) VALUES (${insertValues}) ` +
				`ON DUPLICATE KEY UPDATE content = ?, mtime_ms = ?, title = ?, title_source = ?, title_updated_at = ?${hasTitleIndexedSize ? ", title_indexed_size = ?" : ""}`,
			insertIfMissing: `INSERT IGNORE INTO ${table} (path, content, mtime_ms, ${titleColumns}) VALUES (${insertValues})`,
			replaceIfSize:
				`UPDATE ${table} SET content = ?, mtime_ms = ?, title = ?, title_source = ?, title_updated_at = ?${hasTitleIndexedSize ? ", title_indexed_size = ?" : ""} ` +
				`WHERE path = ? AND length(content) = ?`,
			upsertAppend:
				`INSERT INTO ${table} (path, content, mtime_ms) VALUES (?, ?, ?) ` +
				`ON DUPLICATE KEY UPDATE content = CONCAT(content, ?), mtime_ms = ?`,
			upsertAppendIndexed:
				`INSERT INTO ${table} (path, content, mtime_ms, ${titleColumns}) VALUES (${insertValues}) ` +
				`ON DUPLICATE KEY UPDATE content = CONCAT(content, ?), mtime_ms = ?, title = ?, title_source = ?, title_updated_at = ?${hasTitleIndexedSize ? ", title_indexed_size = ?" : ""}`,
			updateTitle: `UPDATE ${table} SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ?${hasTitleIndexedSize ? ", title_indexed_size = ?" : ""} WHERE path = ?`,
			indexTitle: `UPDATE ${table} SET title = ?, title_source = ?, title_updated_at = ?${hasTitleIndexedSize ? ", title_indexed_size = ?" : ""} WHERE path = ? AND length(content) = ?`,
			delete: `DELETE FROM ${table} WHERE path = ?`,
			rename: `UPDATE ${table} SET path = ?, mtime_ms = ? WHERE path = ?`,
			loadIndex: `SELECT path, mtime_ms, length(content) AS byte_len, ${titleColumns} FROM ${table}`,
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
			`title_updated_at TEXT, title_indexed_size ${mtimeType}` +
			`)`,
		addTitleColumns: [
			`ALTER TABLE ${table} ADD COLUMN title TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_source TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_updated_at TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_indexed_size ${mtimeType}`,
		],
		upsertReplace:
			`INSERT INTO ${table} (path, content, mtime_ms, ${titleColumns}) ` +
			`VALUES (${insertValues}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = excluded.content, mtime_ms = excluded.mtime_ms, title = excluded.title, title_source = excluded.title_source, title_updated_at = excluded.title_updated_at${indexedUpdate}`,
		insertIfMissing:
			`INSERT INTO ${table} (path, content, mtime_ms, ${titleColumns}) ` +
			`VALUES (${insertValues}) ` +
			`ON CONFLICT (path) DO NOTHING RETURNING path`,
		replaceIfSize:
			`UPDATE ${table} SET content = ${placeholder(1)}, mtime_ms = ${placeholder(2)}, title = ${placeholder(3)}, ` +
			`title_source = ${placeholder(4)}, title_updated_at = ${placeholder(5)}${hasTitleIndexedSize ? `, title_indexed_size = ${placeholder(6)}` : ""} ` +
			`WHERE path = ${placeholder(hasTitleIndexedSize ? 7 : 6)} AND ${byteLengthExpr} = ${placeholder(hasTitleIndexedSize ? 8 : 7)} RETURNING path`,
		upsertAppend:
			`INSERT INTO ${table} (path, content, mtime_ms) ` +
			`VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(3)}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = ${tableQualifier} || excluded.content, mtime_ms = excluded.mtime_ms`,
		upsertAppendIndexed:
			`INSERT INTO ${table} (path, content, mtime_ms, ${titleColumns}) ` +
			`VALUES (${insertValues}) ` +
			`ON CONFLICT (path) DO UPDATE SET content = ${tableQualifier} || excluded.content, mtime_ms = excluded.mtime_ms, title = excluded.title, title_source = excluded.title_source, title_updated_at = excluded.title_updated_at${indexedUpdate}`,
		updateTitle: `UPDATE ${table} SET title = ${placeholder(1)}, title_source = ${placeholder(2)}, title_updated_at = ${placeholder(3)}, mtime_ms = ${placeholder(4)}${hasTitleIndexedSize ? `, title_indexed_size = ${placeholder(5)}` : ""} WHERE path = ${placeholder(hasTitleIndexedSize ? 6 : 5)}`,
		indexTitle: `UPDATE ${table} SET title = ${placeholder(1)}, title_source = ${placeholder(2)}, title_updated_at = ${placeholder(3)}${hasTitleIndexedSize ? `, title_indexed_size = ${placeholder(4)}` : ""} WHERE path = ${placeholder(hasTitleIndexedSize ? 5 : 4)} AND ${byteLengthExpr} = ${placeholder(hasTitleIndexedSize ? 6 : 5)} RETURNING path`,
		delete: `DELETE FROM ${table} WHERE path = ${placeholder(1)}`,
		rename: `UPDATE ${table} SET path = ${placeholder(1)}, mtime_ms = ${placeholder(2)} WHERE path = ${placeholder(3)} RETURNING path`,
		loadIndex: `SELECT path, mtime_ms, ${byteLengthExpr} AS byte_len, ${titleColumns} FROM ${table}`,
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

function isMissingTitleIndexedSizeError(error: unknown, adapter: SqlSessionStorageAdapter): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message;
	if (adapter === "postgres") return /^column "title_indexed_size" does not exist(?:\n|$)/i.test(message);
	if (adapter === "mysql") {
		return /^unknown column 'title_indexed_size' in 'field list'$/i.test(message);
	}
	return /^no such column:\s*title_indexed_size$/i.test(message);
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
	#q: DialectQueries;
	readonly #createTable: boolean;
	#hasTitleIndexedSize = true;
	#titleIndexedSizeProbed = false;

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
		let rows: IndexRow[];
		const canProbe = !this.#createTable && !this.#titleIndexedSizeProbed;
		this.#titleIndexedSizeProbed = true;
		try {
			rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		} catch (error) {
			if (!canProbe || !isMissingTitleIndexedSizeError(error, this.#adapter)) throw error;
			// The shipped externally managed schema has six columns. Never run
			// DDL here, and never retry unrelated SQL failures as schema probes.
			this.#hasTitleIndexedSize = false;
			this.#q = buildQueries(this.#adapter, this.#table, false);
			rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		}
		return rows.map(row => ({
			path: row.path,
			size: rowNumber(row.byte_len),
			mtimeMs: rowNumber(row.mtime_ms),
			title: row.title ?? undefined,
			titleSource: rowTitleSource(row.title_source),
			titleUpdatedAt: row.title_updated_at ?? undefined,
			titleIndexedSize: row.title_indexed_size == null ? undefined : rowNumber(row.title_indexed_size),
			// Six-column SQL has always persisted journal titles atomically.
			// Retain direct metadata updates (including clears) without guessing
			// timestamp order; all-null rows still require lazy reconciliation.
			titleMetadataAuthoritative:
				!this.#hasTitleIndexedSize &&
				(row.title != null || row.title_source != null || row.title_updated_at != null),
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

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		const titleValues: unknown[] = [title?.title ?? null, title?.source ?? null, title?.updatedAt ?? null];
		if (this.#hasTitleIndexedSize) titleValues.push(Buffer.byteLength(content, "utf8"));
		if (expectedSize === undefined) {
			const values = [path, content, mtimeMs, ...titleValues];
			if (this.#adapter === "mysql") values.push(content, mtimeMs, ...titleValues);
			await this.#client.unsafe(this.#q.upsertReplace, values);
			return;
		}

		const result =
			expectedSize === null
				? await this.#client.unsafe(this.#q.insertIfMissing, [path, content, mtimeMs, ...titleValues])
				: await this.#client.unsafe(this.#q.replaceIfSize, [content, mtimeMs, ...titleValues, path, expectedSize]);
		const written = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
		if (written) return;

		const current = await this.readFull(path);
		const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
		// MySQL reports `affectedRows: 0` for a matched-but-unchanged row, so a
		// byte-identical replace looks unwritten. A size match means the size
		// precondition holds and there is nothing to conflict about; only a real
		// size divergence throws. (Same granularity as the size-token contract
		// everywhere else: same-length different content is not detectable here
		// on any dialect. Actual MySQL driver/flag behavior is unverified in
		// this environment; this re-check is exact regardless of it.)
		if (actualSize === expectedSize) return;
		throw new SessionWriteConflictError(path, expectedSize, actualSize);
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number, size?: number): Promise<void> {
		const values: unknown[] = [title.title ?? null, title.source ?? null, title.updatedAt, mtimeMs];
		if (this.#hasTitleIndexedSize) values.push(size ?? null);
		values.push(path);
		await this.#client.unsafe(this.#q.updateTitle, values);
	}

	async append(
		path: string,
		line: string,
		mtimeMs: number,
		title?: SessionTitleUpdate,
		titleIndexedSize?: number,
	): Promise<void> {
		if (titleIndexedSize !== undefined) {
			const titleValues: unknown[] = [title?.title ?? null, title?.source ?? null, title?.updatedAt ?? null];
			if (this.#hasTitleIndexedSize) titleValues.push(titleIndexedSize);
			const values = [path, line, mtimeMs, ...titleValues];
			if (this.#adapter === "mysql") values.push(line, mtimeMs, ...titleValues);
			await this.#client.unsafe(this.#q.upsertAppendIndexed, values);
		} else {
			const values = this.#adapter === "mysql" ? [path, line, mtimeMs, line, mtimeMs] : [path, line, mtimeMs];
			await this.#client.unsafe(this.#q.upsertAppend, values);
		}
	}

	async indexTitle(path: string, title: SessionTitleUpdate | undefined, size: number): Promise<boolean> {
		const values: unknown[] = [title?.title ?? null, title?.source ?? null, title?.updatedAt ?? null];
		if (this.#hasTitleIndexedSize) values.push(size);
		values.push(path, size);
		const result = await this.#client.unsafe(this.#q.indexTitle, values);
		return this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
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
		if (src === dst) {
			if ((await this.readFull(src)) === null) throw enoent(src);
			return;
		}
		await this.#client.transaction(async transaction => {
			await transaction.unsafe(this.#q.delete, [dst]);
			const result = await transaction.unsafe(this.#q.rename, [dst, mtimeMs, src]);
			const moved = this.#adapter === "mysql" ? result.affectedRows === 1 : result.length === 1;
			if (!moved) throw enoent(src);
		});
	}
}
