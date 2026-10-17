import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	assertSqliteQuickCheck,
	getHistoryDbPath,
	isEnoent,
	isSqliteBusyError,
	isSqliteCorruptionError,
	logger,
	openSqliteDatabaseSync,
	readDamagedSqliteRows,
	resolveEquivalentPath,
	sqliteFileIdentity,
	withSqliteStoreLease,
} from "@oh-my-pi/pi-utils";
import { writeFileAtomicallySync } from "../utils/atomic-file";
import { readSalvagedSessionIndex, restoreSalvagedSessionIndex, type SalvagedSessionIndex } from "./session-index";

/** A unique prompt with provenance from its most recent submission. */
export interface HistoryEntry {
	/** Stable row identifier used by the full-text index. */
	id: number;
	/** Trimmed prompt text, unique across the history database. */
	prompt: string;
	/** Unix timestamp of the most recent submission. */
	created_at: number;
	/** Project working directory of the most recent submission. */
	cwd?: string;
	/** Session ID of the most recent submission, if known. */
	sessionId?: string;
	/** Number of times this prompt has been submitted, including the first. */
	useCount: number;
}

/** Narrows history reads; omitted fields match every prompt. */
export interface HistoryFilter {
	/** Exact project working directory of the prompt's latest submission. */
	cwd?: string;
	/** Exact session id of the prompt's latest submission. */
	sessionId?: string;
}

type HistoryRow = {
	/** Rowid bound as text so values above 2^53 stay exact through dedup and ordering. */
	id: string;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
	use_count: number;
};

type SalvagedHistoryRow = HistoryRow;

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * SQL predicate for a {@link HistoryFilter}, bound as numbered parameters
 * `?first` (cwd) and `?first+1` (session id); binding NULL disables that half.
 * `table` qualifies the columns (`"h."`) when the statement joins.
 */
function historyFilterClause(table: string, first: number): string {
	const session = first + 1;
	return `(?${first} IS NULL OR ${table}cwd = ?${first}) AND (?${session} IS NULL OR ${table}session_id = ?${session})`;
}

/**
 * Admits only rows with the stored shape. A damaged b-tree can surface another
 * table's record through `history` (e.g. an FTS docsize BLOB decoded as
 * `prompt`); TEXT affinity never coerces a BLOB, so without this a
 * non-string `prompt` reaches callers.
 */
function wellFormedRowClause(table: string): string {
	return `typeof(${table}prompt) = 'text' AND typeof(${table}created_at) = 'integer'`;
}

// Escape LIKE wildcards so user input is treated as literal text.
// Matches the `ESCAPE '\\'` clause used by substring-search statements.
function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Canonical stored form of a prompt: CRLF/CR folded to LF, trailing whitespace
 * stripped from every line, outer whitespace trimmed. Terminal copies pad each
 * line with spaces to the screen width, so without this a resubmitted copy of
 * an existing prompt lands as a byte-distinct duplicate row.
 */
function normalizePrompt(prompt: string): string {
	return prompt
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+\n/g, "\n")
		.trim();
}

/**
 * Folds rows onto their normalized prompt: the most recent submission wins
 * (the upsert's "latest provenance" rule) and every collapsed row's use count
 * is summed, since each was a submission.
 */
function collapseByPrompt(rows: Array<HistoryRow | SalvagedHistoryRow>): SalvagedHistoryRow[] {
	const winners = new Map<string, SalvagedHistoryRow>();
	for (const row of rows) {
		const prompt = normalizePrompt(row.prompt);
		if (!prompt) continue;
		const incumbent = winners.get(prompt);
		if (!incumbent) {
			winners.set(prompt, { ...row, id: String(row.id), prompt });
			continue;
		}
		const useCount = incumbent.use_count + row.use_count;
		const rowWins =
			row.created_at > incumbent.created_at ||
			(row.created_at === incumbent.created_at && BigInt(row.id) > BigInt(incumbent.id));
		winners.set(
			prompt,
			rowWins ? { ...row, id: String(row.id), prompt, use_count: useCount } : { ...incumbent, use_count: useCount },
		);
	}
	return [...winners.values()];
}

/** Selects the canonical row columns, defaulting those that predate `session_id` and `use_count`. */
function historyRowSelection(db: Database): { columns: string; predicate: string } {
	const names = new Set(
		(db.query("PRAGMA table_info(history)").all() as Array<{ name: string }>).map(col => col.name),
	);
	const cwd = names.has("cwd") ? "CASE WHEN typeof(cwd) = 'text' THEN cwd END AS cwd" : "NULL AS cwd";
	const sessionId = names.has("session_id")
		? "CASE WHEN typeof(session_id) = 'text' THEN session_id END AS session_id"
		: "NULL AS session_id";
	const useCount = names.has("use_count") ? "use_count" : "1 AS use_count";
	return {
		columns: `CAST(id AS TEXT) AS id, prompt, created_at, ${cwd}, ${sessionId}, ${useCount}`,
		predicate: `${wellFormedRowClause("")} AND typeof(${names.has("use_count") ? "use_count" : "1"}) = 'integer'`,
	};
}

/**
 * Canonical read columns for a store already at {@link HISTORY_TABLE_DDL}
 * shape. `id` comes back as text so rowids above 2^53 survive as Map keys
 * and sort keys, and optional provenance folds non-text values to NULL —
 * {@link wellFormedRowClause} guards `prompt`/`created_at`/`use_count`, but
 * a damaged record can still hold a BLOB in `cwd` or `session_id`.
 */
function liveRowColumns(table: string): string {
	return (
		`CAST(${table}id AS TEXT) AS id, ${table}prompt, ${table}created_at, ` +
		`CASE WHEN typeof(${table}cwd) = 'text' THEN ${table}cwd END AS cwd, ` +
		`CASE WHEN typeof(${table}session_id) = 'text' THEN ${table}session_id END AS session_id, ${table}use_count`
	);
}

/** Compares rowids carried as decimal text without losing bits above 2^53. */
function compareRowIds(a: string, b: string): number {
	const left = BigInt(a);
	const right = BigInt(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** A journaled backup was queued after the pre-lease scan; rescan without holding the lease. */
class HistorySalvageRescan extends Error {}

/** Restart cycles a drain can trigger before deferring freshly queued backups to the next open. */
const MAX_SALVAGE_RESCANS = 4;

/** Backup contents plus the ledger rows it carries; scanned without the store lease. */
interface HistorySalvageScan {
	backupName: string;
	highWater: string | null;
	history: SalvagedHistoryRow[];
	index?: SalvagedSessionIndex;
	carried: string[];
	/**
	 * False when the backup's carried applied-ledger could not be fully read,
	 * so applying this snapshot may hide an older committed backup from the
	 * live ledger. The drain marks such older records deferred so they replay
	 * with a merge instead of an additive restore.
	 */
	ledgerComplete: boolean;
	damagedRegions: number;
	sourceErrors: string[];
}

/** Keep the allocation high-water mark in SQLite's integer domain, including values above 2^53. */
function readHistorySequence(db: Database): string | null {
	if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) return null;
	try {
		const row = db
			.query<{ seq: string }, []>(
				"SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'history' AND typeof(seq)='integer' AND seq >= 0",
			)
			.get();
		return row?.seq ?? null;
	} catch (error) {
		logger.warn("HistoryStorage could not read the history sequence", { error: String(error) });
		return null;
	}
}

/** Predictor checkpoints must remain below newly allocated ids even when the newest rows were deleted. */
function restoreHistorySequence(db: Database, seq: string | null): void {
	if (seq === null) return;
	db.query("UPDATE sqlite_sequence SET seq = max(seq, CAST(? AS INTEGER)) WHERE name = 'history'").run(seq);
	db.query(
		"INSERT INTO sqlite_sequence (name, seq) SELECT 'history', CAST(? AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'history')",
	).run(seq);
}

/**
 * Bumped only when stored rows need the one-time dump-and-rebuild pass on open;
 * see `#rebuildHistory`. Purely additive columns go through `#ensureColumn`
 * instead so existing stores are never rewritten for them.
 * v2: verify integrity first, so stores damaged under v1 are quarantined and
 * salvaged instead of rewritten in place.
 */
const HISTORY_DATA_VERSION = 2;

/** Canonical `history` schema; `#rebuildHistory` recreates the table from this exact DDL. */
const HISTORY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT,
	use_count INTEGER NOT NULL DEFAULT 1
);
`;
// Kept as its own statement: a multi-statement run reports only the last
// error, which would hide a peer lock behind the index's "no such table".
const HISTORY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
`;

/**
 * Names the sidecar that records a quarantined store still needing salvage.
 * A peer can hold the replacement's write lock past the busy timeout, so the
 * salvage insert runs only when this file can be dropped afterwards.
 */
function pendingSalvagePath(dbPath: string): string {
	return `${dbPath}.pending-salvage`;
}

interface PendingSalvage {
	backupName: string;
	sourceIdentity?: string;
	/**
	 * Set when a superseding snapshot's carried ledger was unreadable, leaving
	 * it unknown whether this backup committed before being superseded.
	 * Deferred records replay with a maximum merge instead of an additive one,
	 * so an already-applied snapshot cannot double-count prompts.
	 */
	deferred?: boolean;
}

/** GC must not delete rows that a queued snapshot can restore immediately afterwards. */
export function hasPendingHistorySalvage(dbPath: string): boolean {
	return readPendingSalvage(resolveEquivalentPath(dbPath, { allowMissing: true })).length > 0;
}

function readPendingSalvage(dbPath: string): PendingSalvage[] {
	try {
		const records: unknown = JSON.parse(fs.readFileSync(pendingSalvagePath(dbPath), "utf8"));
		if (!Array.isArray(records)) throw new Error("Invalid history salvage journal");
		return records.map((record: unknown) => {
			if (
				!record ||
				typeof record !== "object" ||
				!("backupName" in record) ||
				typeof record.backupName !== "string" ||
				!record.backupName ||
				path.basename(record.backupName) !== record.backupName ||
				record.backupName === "." ||
				record.backupName === ".." ||
				("sourceIdentity" in record && typeof record.sourceIdentity !== "string") ||
				("deferred" in record && typeof record.deferred !== "boolean")
			)
				throw new Error("Invalid history salvage journal");
			return {
				backupName: record.backupName,
				sourceIdentity:
					"sourceIdentity" in record && typeof record.sourceIdentity === "string"
						? record.sourceIdentity
						: undefined,
				deferred: "deferred" in record && record.deferred === true ? true : undefined,
			};
		});
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return [];
	}
}

function recordPendingSalvage(dbPath: string, backupPath: string): void {
	const pending = readPendingSalvage(dbPath);
	const stat = fs.statSync(dbPath, { bigint: true });
	const sourceIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	// A failed unlink leaves a writable original. Supersede its older snapshot
	// rather than replaying both or losing writes committed between retries.
	// A deferred record's successor stays deferred: supersession inherits the
	// unknown-commit state that required the merge replay.
	const deferred = pending.some(record => record.sourceIdentity === sourceIdentity && record.deferred);
	const remaining = pending.filter(record => record.sourceIdentity !== sourceIdentity);
	remaining.push({ backupName: path.basename(backupPath), sourceIdentity, deferred: deferred || undefined });
	writeFileAtomicallySync(pendingSalvagePath(dbPath), JSON.stringify(remaining));
}

/**
 * Marks a journaled record for merge replay. Runs before the superseding
 * apply commits so a crash between them cannot re-queue the record for an
 * additive replay that would double-count prompts already merged forward.
 */
function deferPendingSalvage(dbPath: string, backupName: string): void {
	const pending = readPendingSalvage(dbPath);
	const record = pending.find(entry => entry.backupName === backupName);
	if (!record || record.deferred) return;
	record.deferred = true;
	writeFileAtomicallySync(pendingSalvagePath(dbPath), JSON.stringify(pending));
}

function clearPendingSalvage(dbPath: string, backupPath: string): void {
	const backupName = path.basename(backupPath);
	const pending = readPendingSalvage(dbPath);
	const remaining = pending.filter(record => record.backupName !== backupName);
	if (remaining.length === pending.length) return;
	try {
		if (remaining.length) writeFileAtomicallySync(pendingSalvagePath(dbPath), JSON.stringify(remaining));
		else fs.rmSync(pendingSalvagePath(dbPath), { force: true });
	} catch (error) {
		logger.warn("Pending history salvage marker could not be removed", { error: String(error) });
	}
}

/** Stores searchable prompts with only their latest project and session metadata. */
export class HistoryStorage {
	#db!: Database;
	#dbPath: string;
	static #instance?: HistoryStorage;
	#sessionResolver?: () => string | undefined;
	#addListener?: () => void;
	#errorListener?: (error: unknown) => void;
	#writeFailureReported = false;
	#closed = false;
	// File generation whose integrity this process already proved; `undefined`
	// forces a scan, `null` (missing file) and real identities are checkable.
	#checkedIdentity: string | null | undefined;
	// Prepared statements
	#upsertRowStmt!: Statement;
	#recentStmt!: Statement;
	#searchStmt!: Statement;
	// Cache substring-fallback prepared statements keyed by token count.
	#substringStmts = new Map<number, Statement>();

	private constructor(dbPath: string) {
		this.#dbPath = resolveEquivalentPath(dbPath, { allowMissing: true });
	}

	#initialize(db: Database): void {
		this.#db = db;

		// One-shot statements go through the query cache, which close() finalizes; a
		// stray prepare() would turn close() into a zombie that keeps the files open.
		const hadFts = this.#db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();

		// The schema pass is idempotent, so a peer's write lock only defers it:
		// the operation can still prepare against an already-initialized store.
		let schemaDeferred = false;
		try {
			// One statement per run: bun:sqlite reports only the last error of a
			// multi-statement exec, which would hide a peer's lock behind the
			// follow-on CREATE INDEX's "no such table".
			this.#db.run("PRAGMA journal_mode=WAL");
			this.#db.run("PRAGMA synchronous=NORMAL");
			this.#db.run(HISTORY_TABLE_DDL);

			// Additive column on stores created before the counter existed; runs before
			// the rebuild so the dump below always sees it.
			this.#ensureColumn("use_count", "INTEGER NOT NULL DEFAULT 1");
			const rebuilt = this.#rebuildHistory();

			// After the rebuild, which drops the index along with the table.
			this.#db.run(HISTORY_INDEX_DDL);
			this.#db.run(
				"CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id')",
			);
			this.#db.run(`
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
		`);

			if (rebuilt || !hadFts) {
				try {
					this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
				} catch (error) {
					if (isSqliteCorruptionError(error)) throw error;
					logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
				}
			}
		} catch (error) {
			if (!isSqliteBusyError(error)) throw error;
			schemaDeferred = true;
		}
		try {
			this.#prepareStatements();
		} catch (error) {
			// A peer-created empty file has no schema to prepare against either;
			// while its lock lasts the operation must defer, not prepare garbage.
			if (!schemaDeferred) throw error;
		}
	}

	#prepareStatements(): void {
		this.#recentStmt = this.#db.query(
			`SELECT ${liveRowColumns("")} FROM history WHERE ${wellFormedRowClause("")} AND ${historyFilterClause("", 1)} ORDER BY created_at DESC, id DESC LIMIT ?3`,
		);
		this.#searchStmt = this.#db.query(
			`SELECT ${liveRowColumns("h.")} FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ?1 AND ${wellFormedRowClause("h.")} AND ${historyFilterClause("h.", 2)} ORDER BY h.created_at DESC, h.id DESC LIMIT ?4`,
		);
		this.#upsertRowStmt = this.#db.query(`
INSERT INTO history (prompt, created_at, cwd, session_id)
VALUES (?, ${SQLITE_NOW_EPOCH}, ?, ?)
ON CONFLICT(prompt) DO UPDATE SET
	created_at = excluded.created_at,
	cwd = excluded.cwd,
	session_id = excluded.session_id,
	use_count = history.use_count + 1
		`);
	}

	/**
	 * Opens the process-wide prompt history database. A corrupt store is
	 * quarantined once, and its readable prompts are salvaged into the
	 * replacement.
	 */
	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		const existing = HistoryStorage.#instance;
		if (existing) return existing;

		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const instance = new HistoryStorage(dbPath);
		instance.#withStore(() => {});
		HistoryStorage.#instance = instance;
		return instance;
	}

	/** Releases the process-wide facade; connections are scoped to each operation. */
	static close(): void {
		if (HistoryStorage.#instance) HistoryStorage.#instance.#closed = true;
		HistoryStorage.#instance = undefined;
	}

	#withStore<T>(operation: () => T): T {
		if (this.#closed) throw new Error("HistoryStorage is closed");
		// Backup scans never hold the lease or a live handle: they only read
		// immutable quarantined files, and on Windows an open handle would
		// defeat a peer's unlink of the corrupt store. The drain re-reads the
		// journal under the lease; a record a peer queued after our scan throws
		// out to an unlocked rescan instead of walking a backup under the lease.
		const scanned = new Map<string, HistorySalvageScan | undefined>();
		for (let attempt = 0, rescans = 0; ; attempt++) {
			try {
				this.#scanPendingSalvage(scanned);
				return withSqliteStoreLease(this.#dbPath, () => {
					const db = openSqliteDatabaseSync(
						this.#dbPath,
						database => {
							this.#initialize(database);
							return database;
						},
						{
							recoverCorruption: true,
							onCorruptionPreserved: backupPath => recordPendingSalvage(this.#dbPath, backupPath),
						},
					);
					try {
						// The journal and the live identity are both read under the
						// lease: a peer cannot publish a replacement whose entry a
						// stale clear would erase, and a failed unlink's own snapshot
						// is skipped as redundant.
						const pending = readPendingSalvage(this.#dbPath);
						if (pending.length > 0) {
							const live = sqliteFileIdentity(this.#dbPath);
							if (typeof live !== "string") throw new Error("Could not identify the history recovery target");
							for (let i = pending.length - 1; i >= 0; i--) {
								const record = pending[i];
								if (record.sourceIdentity === live) {
									clearPendingSalvage(this.#dbPath, record.backupName);
									continue;
								}
								const scan = scanned.get(record.backupName);
								if (!scan) {
									// Never scanned, or a prior scan deferred. Peers queuing
									// faster than we rescan get a bounded retry, then the
									// operation runs with the entries still journaled.
									if (rescans >= MAX_SALVAGE_RESCANS) continue;
									throw new HistorySalvageRescan();
								}
								// A snapshot whose carried ledger is incomplete cannot
								// prove whether an older committed backup already reached
								// it. Mark those records deferred before committing the
								// apply, so their replay merges instead of counting
								// forward-carried prompts a second time.
								if (!scan.ledgerComplete) {
									for (let older = i - 1; older >= 0; older--) {
										deferPendingSalvage(this.#dbPath, pending[older].backupName);
										pending[older].deferred = true;
									}
								}
								try {
									this.#applySalvageScan(scan, { mergeOnly: record.deferred === true });
								} catch (error) {
									// A peer holding the write lock defers the insert, same as a
									// failed scan: the journal entry stays for the next open.
									if (!isSqliteBusyError(error)) throw error;
									logger.error("HistoryStorage salvage deferred", {
										backupPath: scan.backupName,
										error: String(error),
									});
									break;
								}
							}
						}
						return operation();
					} finally {
						this.#substringStmts.clear();
						db.close();
					}
				});
			} catch (error) {
				if (error instanceof HistorySalvageRescan) {
					rescans++;
					continue;
				}
				// The open-time check is generation-gated, so damage done after
				// that scan first surfaces as an operation error. Invalidate the
				// generation proof and retry once: the re-scan recovers a corrupt
				// store through the same path an open-time failure does.
				if (attempt > 0 || !isSqliteCorruptionError(error)) throw error;
				this.#checkedIdentity = undefined;
			}
		}
	}

	/**
	 * Fills `scans` with snapshots of every recoverable journaled backup,
	 * newest first, stopping at the first deferral; good scans from earlier
	 * cycles are kept. Runs without the lease and without a live handle:
	 * scans hold only read handles on immutable quarantined files, so a large
	 * damaged backup cannot serialize the store's other participants, and no
	 * connection of ours can block a peer's quarantine unlink on Windows.
	 * `undefined` map entries mark backups that were read and deferred.
	 */
	#scanPendingSalvage(scans: Map<string, HistorySalvageScan | undefined>): void {
		const pending = readPendingSalvage(this.#dbPath);
		// A newer snapshot carries the ledger of older committed backups.
		// Do not replay older entries until that ledger has been restored.
		for (let i = pending.length - 1; i >= 0; i--) {
			const name = pending[i].backupName;
			if (scans.get(name)) continue;
			const scan = this.#scanBackup(path.join(path.dirname(this.#dbPath), name));
			scans.set(name, scan);
			if (!scan) break;
		}
	}

	#insertBatch(rows: Array<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>): void {
		this.#withStore(() => {
			this.#db.transaction(() => {
				for (const row of rows) {
					this.#upsertRowStmt.run(row.prompt, row.cwd ?? null, row.sessionId ?? null);
				}
			})();
		});
	}

	/**
	 * Register a resolver that supplies the current session ID for prompts added
	 * without an explicit `sessionId`. Evaluated synchronously at `add()` time so
	 * each write captures the session active when the prompt was submitted.
	 */
	setSessionResolver(resolver: () => string | undefined): void {
		this.#sessionResolver = resolver;
	}

	/** Register a callback run after each successful {@link add}, once the row is durable. */
	setAddListener(listener: () => void): void {
		this.#addListener = listener;
	}

	/** Register a callback for the first failed write in each outage, reset by a successful write. */
	setErrorListener(listener: (error: unknown) => void): void {
		this.#errorListener = listener;
	}

	/**
	 * Stores a prompt, replaces its provenance with the latest submission, and
	 * bumps its use count on resubmission.
	 * The write is synchronous: prompt submission is human-paced, not a hot
	 * path. On success the row is durable the moment `add()` returns and cannot
	 * be lost to an exit racing a deferred flush. Failures are logged, not thrown;
	 * the error listener is notified once per outage until a write succeeds.
	 */
	add(prompt: string, cwd?: string, sessionId?: string): Promise<void> {
		const trimmed = normalizePrompt(prompt);
		if (!trimmed) return Promise.resolve();
		const session = sessionId ?? this.#sessionResolver?.();
		try {
			this.#insertBatch([{ prompt: trimmed, cwd: cwd ?? undefined, sessionId: session || undefined }]);
		} catch (error) {
			logger.error("HistoryStorage add failed", { error: String(error) });
			if (!this.#writeFailureReported) {
				this.#writeFailureReported = true;
				this.#errorListener?.(error);
			}
			return Promise.resolve();
		}
		this.#writeFailureReported = false;
		this.#addListener?.();
		return Promise.resolve();
	}

	/** Returns unique prompts ordered by their most recent submission. */
	getRecent(limit: number, filter: HistoryFilter = {}): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			return this.#withStore(() => {
				const rows = this.#recentStmt.all(filter.cwd ?? null, filter.sessionId ?? null, safeLimit) as HistoryRow[];
				return rows.map(row => this.#toEntry(row));
			});
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	/** Finds unique prompts matching every query token, newest first. */
	search(query: string, limit: number, filter: HistoryFilter = {}): HistoryEntry[] {
		try {
			return this.#withStore(() => this.#search(query, limit, filter));
		} catch (error) {
			logger.error("HistoryStorage search failed", { error: String(error) });
			return [];
		}
	}

	#search(query: string, limit: number, filter: HistoryFilter): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0) return [];

		// 1. FTS5 prefix match (token AND, prefix-wildcard per token).
		//    Handles punctuation by tokenizing query the same way unicode61 tokenizer
		//    indexed the stored text, so "git-commit" -> "git"* "commit"*.
		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: HistoryRow[] = [];
		try {
			ftsRows = this.#searchStmt.all(
				ftsQuery,
				filter.cwd ?? null,
				filter.sessionId ?? null,
				safeLimit,
			) as HistoryRow[];
		} catch (error) {
			if (isSqliteCorruptionError(error)) throw error;
			// Malformed FTS expression - fall through to substring path.
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		// 2. Substring fallback (token-AND LIKE). Catches infix matches FTS5's
		//    prefix-only wildcard cannot reach (e.g. "mit" -> "commit"). Bounded
		//    by safeLimit, ordered by recency - no full-table load into JS.
		let subRows: HistoryRow[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit, filter);
		} catch (error) {
			if (isSqliteCorruptionError(error)) throw error;
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return subRows.map(row => this.#toEntry(row));
		}

		const rowsById = new Map<string, HistoryRow>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		return [...rowsById.values()]
			.sort((a, b) => b.created_at - a.created_at || compareRowIds(b.id, a.id))
			.slice(0, safeLimit)
			.map(row => this.#toEntry(row));
	}

	/**
	 * IDs of the sessions whose stored prompts match `query`, ordered by prompt
	 * recency and de-duplicated. Used to augment session ranking in the resume
	 * picker with prompts that the 4KB session-list prefix never sees.
	 */
	matchingSessionIds(query: string, limit = 500): string[] {
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of this.search(query, limit)) {
			const id = entry.sessionId;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	}

	#historySchemaHasColumn(column: string): boolean {
		const columns = this.#db.query("PRAGMA table_info(history)").all() as Array<{ name: string }>;
		return columns.some(col => col.name === column);
	}

	/** Adds `column` to `history` when absent; `definition` must carry a default so existing rows stay valid. */
	#ensureColumn(column: string, definition: string): void {
		if (this.#historySchemaHasColumn(column)) return;
		this.#db.run(`ALTER TABLE history ADD COLUMN ${column} ${definition}`);
	}

	/**
	 * Runs the open-time integrity check, then performs the one-time
	 * dump-and-rebuild pass when `PRAGMA user_version` (owned by this pass —
	 * nothing else versions history.db) is behind. A current store is checked
	 * in a plain read snapshot: taking the write lock first would queue a
	 * healthy open behind a peer's long write transaction and fail with
	 * `SQLITE_BUSY` at the busy timeout instead of opening concurrently under
	 * WAL. When a rebuild is needed, the whole pass runs under a single
	 * IMMEDIATE write lock — rechecking the version inside it — so the dump
	 * snapshots the same table the DROP replaces. A failed check throws
	 * `SQLITE_CORRUPT` and `open` quarantines and salvages the store instead —
	 * dropping tables on a damaged store would free pages other b-trees still
	 * reference. Dumps every well-formed row, folds the prompts through
	 * {@link collapseByPrompt}, and recreates the table from
	 * {@link HISTORY_TABLE_DDL}. Subsumes every legacy shape at once — unixepoch
	 * defaults, missing session_id, non-unique prompt, per-line trailing
	 * padding — without per-shape SQL migrations. Returns whether it ran so the
	 * caller can rebuild the FTS index.
	 */
	#rebuildHistory(): boolean {
		const readVersion = () => this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
		if (readVersion() >= HISTORY_DATA_VERSION) {
			// A full-store scan is O(pages); gate it to file generations this
			// process hasn't proven — the generation changes exactly when a peer
			// or this process replaces the file.
			const identity = sqliteFileIdentity(this.#dbPath);
			if (identity !== undefined && identity === this.#checkedIdentity) return false;
			assertSqliteQuickCheck(this.#db);
			if (identity !== undefined) this.#checkedIdentity = identity;
			return false;
		}
		let rebuilt = false;
		this.#db
			.transaction(() => {
				if (readVersion() >= HISTORY_DATA_VERSION) return;
				assertSqliteQuickCheck(this.#db);
				const highWater = readHistorySequence(this.#db);
				let rows: SalvagedHistoryRow[];
				try {
					const { columns, predicate } = historyRowSelection(this.#db);
					rows = this.#db.query(`SELECT ${columns} FROM history WHERE ${predicate}`).all() as SalvagedHistoryRow[];
				} catch (error) {
					if (isSqliteCorruptionError(error)) throw error;
					logger.error("HistoryStorage rebuild dump failed", { error: String(error) });
					return;
				}
				const winners = collapseByPrompt(rows);
				this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
				this.#db.run("DROP TRIGGER IF EXISTS history_ai");
				this.#db.run("DROP TABLE IF EXISTS history_fts");
				this.#db.run("DROP TABLE history");
				this.#db.run(HISTORY_TABLE_DDL);
				this.#insertRows(winners);
				restoreHistorySequence(this.#db, highWater);
				this.#db.run(`PRAGMA user_version = ${HISTORY_DATA_VERSION}`);
				rebuilt = true;
				if (winners.length < rows.length) {
					logger.debug("HistoryStorage collapsed rows during rebuild", {
						before: rows.length,
						after: winners.length,
					});
				}
			})
			.immediate();
		if (rebuilt) {
			const identity = sqliteFileIdentity(this.#dbPath);
			if (identity !== undefined) this.#checkedIdentity = identity;
		}
		return rebuilt;
	}

	/**
	 * Inserts rows, keeping each original id unless it is taken, and merges a
	 * prompt that already exists like {@link collapseByPrompt}. A rebuild
	 * inserts into an empty table; a salvage can race a peer process that
	 * already wrote to the replacement store, and neither side's prompts may be
	 * dropped. `mergeOnly` replays a backup whose commit state was unknown:
	 * its prompts may already be present via a superseding snapshot, so the
	 * counter merges with max() rather than summing a second time.
	 */
	#insertRows(rows: SalvagedHistoryRow[], mergeOnly = false): void {
		const useCountMerge = mergeOnly
			? "max(history.use_count, excluded.use_count)"
			: "history.use_count + excluded.use_count";
		const insert = this.#db.query(`
INSERT INTO history (id, prompt, created_at, cwd, session_id, use_count)
VALUES (
	CASE WHEN EXISTS (SELECT 1 FROM history WHERE id = ?1)
		THEN (SELECT candidate FROM (
			SELECT h.id + 1 AS candidate FROM history h
			WHERE h.id > 0 AND h.id < 9223372036854775807
				AND NOT EXISTS (SELECT 1 FROM history h2 WHERE h2.id = h.id + 1)
			UNION ALL
			SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM history WHERE id = 1)
		) ORDER BY candidate LIMIT 1)
		ELSE ?1 END,
	?2, ?3, ?4, ?5, ?6)
ON CONFLICT(prompt) DO UPDATE SET
	use_count = ${useCountMerge},
	created_at = max(history.created_at, excluded.created_at),
	cwd = CASE WHEN excluded.created_at > history.created_at THEN excluded.cwd ELSE history.cwd END,
	session_id = CASE WHEN excluded.created_at > history.created_at THEN excluded.session_id ELSE history.session_id END
		`);
		for (const row of rows) {
			insert.run(row.id, row.prompt, row.created_at, row.cwd, row.session_id, row.use_count);
		}
	}

	/**
	 * Snapshots one immutable quarantined backup. Holds only a read handle on
	 * the backup itself — never the store lease — so the scan can outlast a
	 * damaged b-tree walk without serializing other participants. Returns
	 * `undefined` when the backup cannot be read at all (it stays journaled).
	 */
	#scanBackup(backupPath: string): HistorySalvageScan | undefined {
		let source: Database | undefined;
		try {
			const sourceErrors: string[] = [];
			const readSource = <T>(read: () => T, fallback: T): T => {
				try {
					return read();
				} catch (error) {
					if (
						!isSqliteCorruptionError(error) &&
						!isEnoent(error) &&
						!(
							error instanceof Error &&
							(("code" in error && error.code === "SQLITE_ERROR") || ("errno" in error && error.errno === 1))
						)
					)
						throw error;
					sourceErrors.push(String(error));
					return fallback;
				}
			};
			source = readSource(() => {
				fs.statSync(backupPath);
				return new Database(backupPath, { readonly: true });
			}, undefined);
			if (!source)
				return {
					backupName: path.basename(backupPath),
					highWater: null,
					history: [],
					carried: [],
					// No snapshot was taken, so nothing could have been carried;
					// older records replay against the live ledger as usual.
					ledgerComplete: true,
					damagedRegions: 0,
					sourceErrors,
				};
			const backup = source;
			const carried = readSource(
				() => {
					if (!backup.query("SELECT 1 FROM sqlite_master WHERE name='history_salvage_applied'").get())
						return { rows: [], damagedRegions: 0 };
					return readDamagedSqliteRows<{ backup_path: string }>(backup, "history_salvage_applied", "backup_path");
				},
				{ rows: [] as Array<{ backup_path: string }>, damagedRegions: 1 },
			);
			const highWater = readSource(() => readHistorySequence(backup), null);
			const history = readSource(
				() => {
					const { columns, predicate } = historyRowSelection(backup);
					return readDamagedSqliteRows<SalvagedHistoryRow>(backup, "history", columns, predicate);
				},
				{ rows: [], damagedRegions: 0 },
			);
			const index = readSource(() => readSalvagedSessionIndex(backup), undefined);
			source.close();
			source = undefined;
			// Only plain basenames are valid carried marks; anything else means
			// the ledger row was damaged and the carried state is unknown.
			const carriedNames = carried.rows
				.filter(
					(row): row is { backup_path: string } =>
						typeof row.backup_path === "string" &&
						row.backup_path.length > 0 &&
						path.basename(row.backup_path) === row.backup_path,
				)
				.map(row => row.backup_path);
			return {
				backupName: path.basename(backupPath),
				highWater,
				history: collapseByPrompt(history.rows),
				index,
				// A failed or partial ledger read leaves carried marks unknown, so
				// older journaled backups cannot be proven committed in this
				// snapshot; the drain defers them to a merge replay.
				carried: carriedNames,
				ledgerComplete: carried.damagedRegions === 0 && carriedNames.length === carried.rows.length,
				damagedRegions: history.damagedRegions + carried.damagedRegions + (index?.damagedRegions ?? 0),
				sourceErrors,
			};
		} catch (error) {
			logger.error("HistoryStorage salvage deferred", { backupPath, error: String(error) });
			return undefined;
		} finally {
			source?.close();
		}
	}

	/**
	 * Applies one scanned backup. Rows, provenance index rows, and the
	 * applied-backup identity commit together; the durable journal entry is
	 * cleared afterwards. The ledger makes a replay after COMMIT a no-op.
	 * `mergeOnly` records were deferred past an incomplete carried ledger:
	 * they may already have committed into a superseding snapshot, so their
	 * prompt counters merge with max() instead of summing.
	 */
	#applySalvageScan(scan: HistorySalvageScan, options?: { mergeOnly?: boolean }): void {
		this.#db.run("PRAGMA synchronous=FULL");
		this.#db.run("CREATE TABLE IF NOT EXISTS history_salvage_applied (backup_path TEXT PRIMARY KEY)");
		const applied = this.#db.query("SELECT 1 FROM history_salvage_applied WHERE backup_path = ?");
		if (applied.get(scan.backupName)) {
			clearPendingSalvage(this.#dbPath, scan.backupName);
			return;
		}
		this.#db
			.transaction(() => {
				if (applied.get(scan.backupName)) return;
				this.#insertRows(scan.history, options?.mergeOnly === true);
				if (scan.index) restoreSalvagedSessionIndex(scan.index, this.#db);
				// Sequence last: a collision remap above picks a free id below the
				// water mark, which an earlier restore would skip past and send
				// the AUTOINCREMENT fallback into SQLITE_FULL at INT64_MAX.
				restoreHistorySequence(this.#db, scan.highWater);
				const mark = this.#db.query("INSERT OR IGNORE INTO history_salvage_applied (backup_path) VALUES (?)");
				for (const name of scan.carried) mark.run(name);
				mark.run(scan.backupName);
			})
			.immediate();
		clearPendingSalvage(this.#dbPath, scan.backupName);
		logger.warn("HistoryStorage salvaged a corrupt store", {
			backupPath: path.join(path.dirname(this.#dbPath), scan.backupName),
			salvaged: scan.history.length,
			damagedRegions: scan.damagedRegions,
			sourceErrors: scan.sourceErrors,
		});
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how stored prompts were indexed. Lowercases for
	 * stable substring matching.
	 */
	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number, filter: HistoryFilter): HistoryRow[] {
		const stmt = this.#getSubstringStmt(tokens.length);
		const params: SQLQueryBindings[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		params.push(filter.cwd ?? null, filter.sessionId ?? null, limit);
		return stmt.all(...params) as HistoryRow[];
	}

	#getSubstringStmt(tokenCount: number): Statement {
		let stmt = this.#substringStmts.get(tokenCount);
		if (stmt) return stmt;
		const tokenClauses = Array.from(
			{ length: tokenCount },
			(_, index) => `prompt LIKE ?${index + 1} ESCAPE '\\' COLLATE NOCASE`,
		);
		const whereClause = [...tokenClauses, wellFormedRowClause(""), historyFilterClause("", tokenCount + 1)].join(
			" AND ",
		);
		stmt = this.#db.query(
			`SELECT ${liveRowColumns("")} FROM history WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?${tokenCount + 3}`,
		);
		this.#substringStmts.set(tokenCount, stmt);
		return stmt;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: Number(row.id),
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
			sessionId: row.session_id ?? undefined,
			useCount: row.use_count,
		};
	}
}
