/** Shared SQLite opening, error attribution, and result-code classification for persistent stores. */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { installSqliteLockShim } from "@oh-my-pi/pi-natives/sqlite-locks";
import { getDbBusyTimeoutMs } from "./env";
import { withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import { toError } from "./type-guards";
import * as logger from "./logger";

/**
 * How long an open keeps retrying a store another process holds locked. A start only reads a current
 * schema, so it waits here only while peers create or migrate the store, or run WAL recovery. The
 * worst case measured: 100 `omp -p` starts at once on an empty agent dir, at load average ~410, with
 * another process committing every 2 s; the slowest open waited 22 s before its winning attempt.
 * The budget is about three times that.
 */
const BUSY_RETRY_BUDGET_MS = 60_000;
const BUSY_BASE_DELAY_MS = 100;
const BUSY_MAX_DELAY_MS = 2_000;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];

let sqliteLockShimInstalled: boolean | undefined;

/**
 * Moves this process's SQLite locks onto open-file-description locks (Linux), once.
 *
 * SQLite's POSIX record locks belong to the process, so any close of another
 * descriptor of a database or its `-shm` released them, including Bun's own file
 * APIs and the bash tool's builtins; a peer omp then unlinked the WAL under the live
 * connection (issue #15586). Call before the process opens its first database: a
 * connection opened earlier keeps POSIX locks. Returns whether the shim is active; a
 * Linux build where it cannot be installed (Bun's SQLite layout changed) logs a warning
 * once, and callers with a UI surface it.
 */
export function ensureSqliteLockShim(): boolean {
	if (sqliteLockShimInstalled === undefined) {
		sqliteLockShimInstalled = installSqliteLockShim();
		if (!sqliteLockShimInstalled && process.platform === "linux") {
			logger.warn("SQLite OFD lock shim unavailable; in-process reads of a live store can release its locks", {
				bun: Bun.version,
				issue: "https://github.com/can1357/oh-my-pi/issues/15586",
			});
		}
	}
	return sqliteLockShimInstalled;
}

/**
 * A store's identity as `dev:ino:birthtimeMs`, `null` when the path holds no
 * file, or `undefined` when the stat itself failed and no conclusion is safe.
 */
export type SqliteFileIdentity = string | null | undefined;

/**
 * Corrupt handles held open by in-process openers awaiting recovery, keyed by
 * resolved store path. Windows refuses to unlink a file any handle still holds,
 * so the opener that quarantines the store closes its peers' dead handles too.
 */
const pendingCorruptHandles = new Map<string, Set<Database>>();

function corruptHandleKey(dbPath: string): string {
	const resolved = path.resolve(dbPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function registerCorruptHandle(dbPath: string, db: Database | undefined): void {
	if (!db) return;
	const key = corruptHandleKey(dbPath);
	let handles = pendingCorruptHandles.get(key);
	if (!handles) {
		handles = new Set();
		pendingCorruptHandles.set(key, handles);
	}
	handles.add(db);
}

function unregisterCorruptHandle(dbPath: string, db: Database | undefined): void {
	if (!db) return;
	const key = corruptHandleKey(dbPath);
	const handles = pendingCorruptHandles.get(key);
	if (!handles) return;
	handles.delete(db);
	if (handles.size === 0) pendingCorruptHandles.delete(key);
}

/** Closes peers' failed handles on the store; each peer still closes (idempotently) and adopts on its own path. */
function closePeerCorruptHandles(dbPath: string, own: Database | undefined): void {
	const handles = pendingCorruptHandles.get(corruptHandleKey(dbPath));
	if (!handles) return;
	for (const peer of handles) {
		if (peer === own) continue;
		try {
			peer.close();
		} catch (error) {
			logger.warn("Failed to close a peer's corrupt SQLite handle before quarantine", {
				path: dbPath,
				error: String(error),
			});
		}
	}
}

class SqliteAttemptFailure extends Error {
	readonly original: unknown;
	readonly identity: SqliteFileIdentity;
	readonly canRecover: boolean;
	readonly db?: Database;

	constructor(original: unknown, identity: SqliteFileIdentity, options: { canRecover?: boolean; db?: Database } = {}) {
		super(original instanceof Error ? original.message : String(original));
		this.original = original;
		this.identity = identity;
		this.canRecover = options.canRecover ?? true;
		this.db = options.db;
	}
}

/**
 * Identity of the file currently at `dbPath`. Quarantine moves a corrupt store
 * aside and recreates one at the same path, so a connection cached on the path
 * alone keeps writing to the unlinked inode: callers that hold a long-lived
 * handle compare this before reusing it.
 */
export function sqliteFileIdentity(dbPath: string): SqliteFileIdentity {
	try {
		const stat = fs.statSync(dbPath);
		return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
	} catch (error) {
		return isEnoent(error) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		db?.close();
	} catch (closeError) {
		const original = toError(error);
		const detail = closeError instanceof Error ? closeError.message : String(closeError);
		original.message += `; failed to close the SQLite handle: ${detail}`;
		throw new SqliteAttemptFailure(original, identity, { canRecover: false });
	}
}

/** Controls opt-in replacement of an unrecoverably corrupt SQLite store. */
export interface SqliteOpenOptions {
	/**
	 * Preserve a corrupt store and its sidecars, recreate it, and run the
	 * initializer once more. Disabled by default.
	 */
	recoverCorruption?: boolean;
	/** Runs after preservation and before the replacement is initialized. */
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

/**
 * Bun's multi-statement `db.run()` reports only the final statement's step
 * error (oven-sh/bun#37415), so a corrupt page hit mid-script can resurface as
 * an unrelated failure such as "no such table". When an initializer fails for
 * any other reason, a `quick_check` on the still-open handle decides whether
 * the store itself is damaged. Runs only on the failure path.
 */
function revealHiddenCorruption(db: Database | undefined, error: unknown): unknown {
	if (!db || isSqliteCorruptionError(error) || isSqliteBusyError(error)) return error;
	let detail: string;
	let code: unknown = "SQLITE_CORRUPT";
	let errno: unknown = 11;
	try {
		const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").all();
		if (rows[0]?.quick_check === "ok") return error;
		detail = `database disk image is malformed (${rows[0]?.quick_check})`;
	} catch (probeError) {
		if (!isSqliteCorruptionError(probeError)) return error;
		detail = probeError instanceof Error ? probeError.message : String(probeError);
		({ code, errno } = probeError as { code: unknown; errno?: unknown });
	}
	const original = error instanceof Error ? error.message : String(error);
	return Object.assign(new Error(`${detail}; initialization failed: ${original}`, { cause: error }), { code, errno });
}

/**
 * Backoff for an open that keeps finding the store locked: doubling, jittered delays capped at
 * {@link BUSY_MAX_DELAY_MS}, until {@link BUSY_RETRY_BUDGET_MS} has passed since the first attempt.
 */
class BusyRetries {
	readonly #startedAt = performance.now();
	#attempts = 0;

	/** Milliseconds to wait before retrying, or `undefined` once the budget is spent. */
	nextDelay(): number | undefined {
		const ceiling = Math.min(BUSY_BASE_DELAY_MS * 2 ** this.#attempts, BUSY_MAX_DELAY_MS);
		this.#attempts++;
		// Jitter keeps processes that failed together from retrying in lockstep.
		const delay = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
		return performance.now() - this.#startedAt + delay > BUSY_RETRY_BUDGET_MS ? undefined : delay;
	}

	/** The final BUSY error, saying how long the open waited. Keeps the SQLite code. */
	exhausted(error: unknown): Error {
		const final = toError(error);
		const seconds = Math.round((performance.now() - this.#startedAt) / 1000);
		final.message += `; still locked after ${seconds} s and ${this.#attempts} attempts: another process holds the database's write lock`;
		return final;
	}
}

/** Closes a failed attempt's connection and wraps its error; corrupt handles stay open for recovery. */
function failedAttempt(
	dbPath: string,
	db: Database | undefined,
	caught: unknown,
	identity: SqliteFileIdentity,
	options: SqliteOpenOptions,
): SqliteAttemptFailure {
	const error = options.recoverCorruption ? revealHiddenCorruption(db, caught) : caught;
	if (options.recoverCorruption && isSqliteCorruptionError(error)) {
		registerCorruptHandle(dbPath, db);
		return new SqliteAttemptFailure(error, identity, { db });
	}
	closeFailedDatabase(db, error, identity);
	return new SqliteAttemptFailure(error, identity);
}

function openConnection(dbPath: string): Database {
	ensureSqliteLockShim();
	const db = new Database(dbPath);
	// WAL recovery can bypass the busy handler; both it and retries are needed (#2421).
	db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
	return db;
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
): Promise<T> {
	const retries = new BusyRetries();
	for (;;) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = openConnection(dbPath);
			return await initialize(db);
		} catch (caught) {
			const failure = failedAttempt(dbPath, db, caught, identity, options);
			if (!isSqliteBusyError(failure.original) || failure.db) throw failure;
			const delay = retries.nextDelay();
			if (delay === undefined) throw new SqliteAttemptFailure(retries.exhausted(failure.original), identity);
			await Bun.sleep(delay);
		}
	}
}

/** Synchronous {@link openWithBusyRetries}: the same budget, blocking the thread between attempts. */
function openWithBusyRetriesSync<T>(dbPath: string, initialize: (db: Database) => T, options: SqliteOpenOptions): T {
	const retries = new BusyRetries();
	for (;;) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = openConnection(dbPath);
			return initialize(db);
		} catch (caught) {
			const failure = failedAttempt(dbPath, db, caught, identity, options);
			if (!isSqliteBusyError(failure.original) || failure.db) throw failure;
			const delay = retries.nextDelay();
			if (delay === undefined) throw new SqliteAttemptFailure(retries.exhausted(failure.original), identity);
			Bun.sleepSync(delay);
		}
	}
}

function quarantineCorruptSqliteStore(dbPath: string, db: Database | undefined): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	const preserved: string[] = [];
	// Closing a failed WAL connection can truncate its WAL. Copy evidence
	// before closing, and remove originals only after every copy succeeds.
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			fs.chmodSync(`${dbPath}${suffix}`, 0o600);
			fs.copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			preserved.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	db?.close();
	// Only Windows refuses to unlink a file another handle still holds. Elsewhere
	// each peer must keep its own handle until it closes it after adopting the
	// replacement; closing it here races the peer's recovery on POSIX.
	if (process.platform === "win32") closePeerCorruptHandles(dbPath, db);

	const removed: string[] = [];
	try {
		// Remove the main file last so a failed sidecar removal cannot leave
		// a path at which another startup creates an empty database.
		for (const suffix of preserved) {
			try {
				fs.unlinkSync(`${dbPath}${suffix}`);
				removed.push(suffix);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} catch (error) {
		for (const suffix of removed) {
			try {
				fs.copyFileSync(`${backupPath}${suffix}`, `${dbPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			} catch (rollbackError) {
				logger.error("SQLite quarantine rollback failed; original preserved at backup path", {
					path: `${dbPath}${suffix}`,
					backupPath: `${backupPath}${suffix}`,
					error: String(rollbackError),
				});
			}
		}
		throw error;
	}
	return backupPath;
}

function corruptionPreservationError(corruption: unknown, dbPath: string, preservationError: unknown): Error {
	const annotated = annotateSqliteError(corruption, dbPath);
	const detail = preservationError instanceof Error ? preservationError.message : String(preservationError);
	annotated.message += `; failed to preserve the corrupt database: ${detail}`;
	return annotated;
}

function recoverCorruptDatabase(dbPath: string, error: unknown, options: SqliteOpenOptions): void {
	if (!(error instanceof SqliteAttemptFailure)) throw annotateSqliteError(error, dbPath);
	const failure = error;
	if (!options.recoverCorruption || !failure.canRecover || !isSqliteCorruptionError(failure.original)) {
		throw annotateSqliteError(failure.original, dbPath);
	}

	let backupPath: string | null;
	try {
		try {
			backupPath = withFileLockSync(`${dbPath}.recovery`, () => {
				const currentIdentity = sqliteFileIdentity(dbPath);
				if (failure.identity === undefined || currentIdentity === undefined) {
					throw new Error("could not verify the corrupt database file identity");
				}
				if (currentIdentity !== failure.identity) return null;
				return quarantineCorruptSqliteStore(dbPath, failure.db);
			});
		} finally {
			unregisterCorruptHandle(dbPath, failure.db);
			closeFailedDatabase(failure.db, failure.original, failure.identity);
		}
	} catch (preservationError) {
		throw corruptionPreservationError(failure.original, dbPath, preservationError);
	}

	if (backupPath === null) return;
	logger.warn("SQLite database corrupt; preserved damaged store before recreating it", {
		path: dbPath,
		backupPath,
		warning: "Stored credentials from this database may require re-login.",
	});
	options.onCorruptionPreserved?.(backupPath, failure.original);
}

/**
 * Opens and initializes a store, retrying BUSY failures with jittered exponential backoff for up to
 * {@link BUSY_RETRY_BUDGET_MS}; the final error says how long it waited. Installs the busy handler
 * before initialization and closes failed connections.
 * The initializer may run again on a fresh connection; on success it owns the handle.
 *
 * With corruption recovery enabled, recovery is serialized across processes.
 * The identity observed by the failed handle is checked under that lock, so a
 * waiter adopts a replacement made by a peer instead of quarantining it.
 * Final failures retain their SQLite codes and include the database path.
 */
export async function openSqliteDatabase<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions = {},
): Promise<T> {
	try {
		return await openWithBusyRetries(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return await openWithBusyRetries(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/**
 * Synchronous counterpart to {@link openSqliteDatabase}, with the same BUSY budget; it blocks the
 * thread between attempts, which a store whose schema is current only reaches during a peer's
 * migration or WAL recovery. Corruption recovery, when enabled, is bounded to one replacement.
 */
export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	try {
		return openWithBusyRetriesSync(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return openWithBusyRetriesSync(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = toError(error);
	annotated.message = `Database "${dbPath}": ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * Brings a store's schema up to date, writing nothing when it already is.
 *
 * `apply` must be idempotent (`CREATE ... IF NOT EXISTS`, a read before each `ALTER`, `INSERT` or
 * `UPDATE`) and must let SQLite errors propagate. It first runs in a read transaction under
 * `PRAGMA query_only`: on a current schema every statement is a no-op, so the start never takes the
 * write lock and never waits on another process's writer. A statement that needs to write fails with
 * `SQLITE_READONLY` instead; `apply` then runs again under `BEGIN IMMEDIATE`, which waits for the
 * write lock through the busy handler (a BUSY result reaches the caller's open retries) and lets
 * one process migrate at a time. Inside a caller's transaction, `apply` runs in it directly. Set the
 * journal mode before the call (it cannot change inside a transaction), and create `TEMP` objects
 * after it (`query_only` refuses them too).
 */
export function initializeSqliteSchema(db: Database, apply: () => void): void {
	if (db.inTransaction) {
		apply();
		return;
	}
	db.run("PRAGMA query_only = ON");
	try {
		runInTransaction(db, "BEGIN", apply);
		return;
	} catch (error) {
		if (!isSqliteReadOnlyError(error)) throw error;
	} finally {
		db.run("PRAGMA query_only = OFF");
	}
	runInTransaction(db, "BEGIN IMMEDIATE", apply);
}

function runInTransaction(db: Database, begin: string, body: () => void): void {
	db.run(begin);
	try {
		body();
		db.run("COMMIT");
	} catch (error) {
		// Some errors (SQLITE_FULL, SQLITE_IOERR, ...) already rolled the transaction back.
		if (db.inTransaction) db.run("ROLLBACK");
		throw error;
	}
}

/** Damaged regions one {@link readSalvageableRows} scan skips before abandoning the rest of the table. */
const SALVAGE_MAX_DAMAGED_REGIONS = 1000;

/**
 * Reads every row of a rowid table that SQLite can still decode, to salvage a
 * damaged store. A full scan aborts at the first unreadable page, so this walks
 * rowids with indexed seeks instead: when a seek hits damage it doubles its
 * stride past it, then bisects back to the first rowid from which seeking
 * works again, losing only rows on the damaged pages. Cross-linked pages can
 * still decode rows with foreign column types, so callers validate types;
 * rows returned out of rowid order count as damage. Only corruption errors are
 * treated as damage; anything else is thrown.
 */
export function readSalvageableRows<T extends object>(db: Database, table: string, columns: string): T[] {
	type Row = T & { salvage_rowid: number };
	using seek = db.prepare<Row, [number]>(
		`SELECT rowid AS salvage_rowid, ${columns} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 1`,
	);
	using exact = db.prepare<Row, [number]>(`SELECT rowid AS salvage_rowid, ${columns} FROM ${table} WHERE rowid = ?`);
	// The row found, null when there is none, or undefined when the read hit damage.
	const probe = (after: number, at?: number): Row | null | undefined => {
		try {
			const row = at === undefined ? seek.get(after) : exact.get(at);
			if (!row) return null;
			const valid = Number.isSafeInteger(row.salvage_rowid) && row.salvage_rowid === (at ?? row.salvage_rowid);
			return valid && row.salvage_rowid > after ? row : undefined;
		} catch (error) {
			if (isSqliteCorruptionError(error)) return undefined;
			throw error;
		}
	};

	const rows: T[] = [];
	const keep = (row: Row): void => {
		const { salvage_rowid: _, ...values } = row;
		rows.push(values as unknown as T);
	};
	let after = Number.MIN_SAFE_INTEGER;
	let damaged = 0;
	while (after < Number.MAX_SAFE_INTEGER) {
		const row = probe(after);
		if (row === null) break;
		if (row) {
			keep(row);
			after = row.salvage_rowid;
			continue;
		}
		if (++damaged > SALVAGE_MAX_DAMAGED_REGIONS) break;
		// An end-of-table result counts as clear: the gap below it may still hold readable rows.
		let bad = after;
		let clear = Number.MAX_SAFE_INTEGER;
		for (let step = 1; after + step < clear; step *= 2) {
			if (probe(after + step) !== undefined) clear = after + step;
			else bad = after + step;
		}
		while (clear - bad > 1) {
			const mid = bad + Math.floor((clear - bad) / 2);
			if (probe(mid) === undefined) bad = mid;
			else clear = mid;
		}
		// An interior key bounds its left subtree inclusively, so seeking past the last
		// damaged rowid descends into the damage again and `clear` itself is skipped.
		const boundary = probe(bad, clear);
		if (boundary) keep(boundary);
		after = clear;
	}
	return rows;
}

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus the extended
 * variants `SQLITE_BUSY_RECOVERY` (concurrent WAL recovery), `SQLITE_BUSY_SNAPSHOT`,
 * and `SQLITE_BUSY_TIMEOUT`. All warrant the same backoff-and-retry treatment.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** The base `SQLITE_READONLY` that `PRAGMA query_only` gives a statement that would write. */
function isSqliteReadOnlyError(err: unknown): boolean {
	return err !== null && typeof err === "object" && "code" in err && err.code === "SQLITE_READONLY";
}

/**
 * SQLite's unrecoverable-corruption result codes — the `SQLITE_CORRUPT` family
 * (base plus extended variants like `SQLITE_CORRUPT_VTAB` / `SQLITE_CORRUPT_INDEX`)
 * and `SQLITE_NOTADB` (the file header is not a database). Unlike
 * {@link isSqliteBusyError}, these never clear by retrying: the store must be
 * repaired or replaced, so callers latch, quarantine, or recreate the file.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
