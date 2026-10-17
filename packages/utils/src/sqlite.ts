/** Shared SQLite opening, error attribution, and result-code classification for persistent stores. */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathForComparison, resolveEquivalentPath } from "./dirs";
import { getDbBusyTimeoutMs } from "./env";
import { withFileLockSync } from "./file-lock";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

const sqliteStoreLeaseDepth = new Map<string, number>();

/**
 * Runs a synchronous store operation under the same cross-process lock used
 * for corruption recovery. Reentrancy is limited to this process and thread;
 * callbacks must not be async. The callback must close every database and
 * finalize every statement before returning; no SQLite handle may outlive the lease.
 */
export function withSqliteStoreLease<T>(dbPath: string, operation: () => T): T {
	const key = corruptHandleKey(dbPath);
	const depth = sqliteStoreLeaseDepth.get(key) ?? 0;
	if (depth > 0) {
		sqliteStoreLeaseDepth.set(key, depth + 1);
		try {
			return operation();
		} finally {
			sqliteStoreLeaseDepth.set(key, depth);
		}
	}

	return withFileLockSync(`${key}.recovery`, () => {
		sqliteStoreLeaseDepth.set(key, 1);
		try {
			return operation();
		} finally {
			sqliteStoreLeaseDepth.delete(key);
		}
	});
}

const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BASE_DELAY_MS = 100;
const SQLITE_STORE_SUFFIXES = ["-wal", "-shm", "-journal", ""];

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
	return normalizePathForComparison(dbPath, { allowMissing: true });
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

/** Release callbacks of long-lived connections, keyed like {@link pendingCorruptHandles}. */
const quarantineHooks = new Map<string, Set<() => void>>();

/**
 * Registers `release` to run in-process when the store at `dbPath` is
 * quarantined, after its evidence is copied and before its files are
 * unlinked. Connections opened outside {@link openSqliteDatabase} use it to
 * close their handle: Windows refuses to unlink a held file, and elsewhere the
 * handle would keep writing to the quarantined file. Returns an unregister
 * function.
 */
export function onSqliteStoreQuarantine(dbPath: string, release: () => void): () => void {
	const key = corruptHandleKey(dbPath);
	let hooks = quarantineHooks.get(key);
	if (!hooks) {
		hooks = new Set();
		quarantineHooks.set(key, hooks);
	}
	hooks.add(release);
	return () => {
		const current = quarantineHooks.get(key);
		if (!current) return;
		current.delete(release);
		if (current.size === 0) quarantineHooks.delete(key);
	};
}

function runQuarantineHooks(dbPath: string): void {
	const hooks = quarantineHooks.get(corruptHandleKey(dbPath));
	if (!hooks) return;
	// Deleting the current element mid-iteration is safe for a Set; a release typically unregisters itself.
	for (const release of hooks) {
		try {
			release();
		} catch (error) {
			logger.warn("Failed to release a SQLite handle before quarantine", { path: dbPath, error: String(error) });
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
		const stat = fs.statSync(dbPath, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	} catch (error) {
		return isEnoent(error) ? null : undefined;
	}
}

function closeFailedDatabase(db: Database | undefined, error: unknown, identity: SqliteFileIdentity): void {
	try {
		db?.close();
	} catch (closeError) {
		const original = error instanceof Error ? error : new Error(String(error));
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
	/** Runs after preservation and before the original store is unlinked, while holding its recovery lease. */
	onCorruptionPreserved?: (backupPath: string, error: unknown) => void;
}

/**
 * Throws a `SQLITE_CORRUPT`-coded error when `PRAGMA quick_check` reports
 * damage. A probe that itself fails propagates unchanged, so callers still see
 * corrupt-page errors with their original SQLite codes.
 */
export function assertSqliteQuickCheck(db: Database): void {
	const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").all();
	if (rows[0]?.quick_check === "ok") return;
	throw Object.assign(new Error(`database disk image is malformed (${rows[0]?.quick_check})`), {
		code: "SQLITE_CORRUPT",
		errno: 11,
	});
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
	try {
		assertSqliteQuickCheck(db);
		return error;
	} catch (probeError) {
		if (!isSqliteCorruptionError(probeError)) return error;
		const detail = probeError instanceof Error ? probeError.message : String(probeError);
		const { code, errno } = probeError as { code: unknown; errno?: unknown };
		const original = error instanceof Error ? error.message : String(error);
		return Object.assign(new Error(`${detail}; initialization failed: ${original}`, { cause: error }), {
			code,
			errno,
		});
	}
}

async function openWithBusyRetries<T>(
	dbPath: string,
	initialize: (db: Database) => T | Promise<T>,
	options: SqliteOpenOptions,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let db: Database | undefined;
		const identity = sqliteFileIdentity(dbPath);
		try {
			db = new Database(dbPath);
			// WAL recovery can bypass the busy handler; both it and retries are needed (#2421).
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			return await initialize(db);
		} catch (caught) {
			const error = options.recoverCorruption ? revealHiddenCorruption(db, caught) : caught;
			if (options.recoverCorruption && isSqliteCorruptionError(error)) {
				registerCorruptHandle(dbPath, db);
				throw new SqliteAttemptFailure(error, identity, { db });
			}
			closeFailedDatabase(db, error, identity);
			if (!isSqliteBusyError(error) || attempt + 1 >= BUSY_MAX_ATTEMPTS) {
				throw new SqliteAttemptFailure(error, identity);
			}
			await Bun.sleep(BUSY_BASE_DELAY_MS * 2 ** attempt);
		}
	}
}

function openOnce<T>(dbPath: string, initialize: (db: Database) => T, options: SqliteOpenOptions): T {
	let db: Database | undefined;
	const identity = sqliteFileIdentity(dbPath);
	try {
		db = new Database(dbPath);
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		return initialize(db);
	} catch (caught) {
		const error = options.recoverCorruption ? revealHiddenCorruption(db, caught) : caught;
		if (options.recoverCorruption && isSqliteCorruptionError(error)) {
			registerCorruptHandle(dbPath, db);
			throw new SqliteAttemptFailure(error, identity, { db });
		}
		closeFailedDatabase(db, error, identity);
		throw new SqliteAttemptFailure(error, identity);
	}
}

function quarantineCorruptSqliteStore(
	dbPath: string,
	db: Database | undefined,
	options: SqliteOpenOptions,
	error: unknown,
): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
	const preserved: string[] = [];
	// Closing a failed WAL connection can truncate its WAL. Copy evidence
	// before closing, and remove originals only after every copy succeeds.
	for (const suffix of SQLITE_STORE_SUFFIXES) {
		try {
			fs.chmodSync(`${dbPath}${suffix}`, 0o600);
			fs.copyFileSync(`${dbPath}${suffix}`, `${backupPath}${suffix}`, fs.constants.COPYFILE_EXCL);
			const fd = fs.openSync(`${backupPath}${suffix}`, "r+");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			preserved.push(suffix);
		} catch (error) {
			if (isEnoent(error) && suffix !== "") continue;
			throw error;
		}
	}
	if (process.platform !== "win32") {
		const directory = fs.openSync(path.dirname(backupPath), "r");
		try {
			fs.fsyncSync(directory);
		} finally {
			fs.closeSync(directory);
		}
	}
	db?.close();
	// History participants close under this lease; other stores may still own
	// in-process handles registered with the quarantine hook.
	if (process.platform === "win32") closePeerCorruptHandles(dbPath, db);
	runQuarantineHooks(dbPath);
	options.onCorruptionPreserved?.(backupPath, error);

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
			backupPath = withSqliteStoreLease(dbPath, () => {
				const currentIdentity = sqliteFileIdentity(dbPath);
				if (failure.identity === undefined || currentIdentity === undefined) {
					throw new Error("could not verify the corrupt database file identity");
				}
				if (currentIdentity !== failure.identity) return null;
				return quarantineCorruptSqliteStore(dbPath, failure.db, options, failure.original);
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
}

/**
 * Opens and initializes a store, retrying BUSY failures up to four total attempts.
 * Installs the busy handler before initialization and closes failed connections.
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
	dbPath = resolveEquivalentPath(dbPath, { allowMissing: true });
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
 * Synchronous counterpart to {@link openSqliteDatabase}. It performs no BUSY
 * retry loop; corruption recovery, when enabled, is bounded to one replacement.
 */
export function openSqliteDatabaseSync<T>(
	dbPath: string,
	initialize: (db: Database) => T,
	options: SqliteOpenOptions = {},
): T {
	dbPath = resolveEquivalentPath(dbPath, { allowMissing: true });
	try {
		return openOnce(dbPath, initialize, options);
	} catch (error) {
		recoverCorruptDatabase(dbPath, error, options);
	}

	try {
		return openOnce(dbPath, initialize, {});
	} catch (error) {
		throw annotateSqliteError(error instanceof SqliteAttemptFailure ? error.original : error, dbPath);
	}
}

/** Adds the failing store's path to an error without losing SQLite result codes or its original stack. */
export function annotateSqliteError(error: unknown, dbPath: string): Error {
	const annotated = error instanceof Error ? error : new Error(String(error));
	annotated.message = `Database "${dbPath}": ${annotated.message}`;
	return annotated;
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	db.run("PRAGMA wal_checkpoint(PASSIVE)");
}

type SalvageSeek = { rowid: bigint; ok: boolean; row: Record<string, unknown> } | "end" | "damaged";

/** SQLite's signed 64-bit rowid domain; `number` would lose precision there. */
const MIN_SQLITE_ROWID = -(1n << 63n);
const MAX_SQLITE_ROWID = (1n << 63n) - 1n;

/** Step values are counts, not database keys, so `bigint` stays exact and safe. */
function probeAt(origin: bigint, delta: bigint, boundary: bigint): bigint {
	const shifted = origin + delta;
	return delta > 0n ? (shifted > boundary ? boundary : shifted) : shifted < boundary ? boundary : shifted;
}

/** Bind rowid boundaries as decimal text; SQLite's CAST preserves all signed int64 bits. */
function bindRowid(origin: bigint): string {
	return origin.toString();
}

/**
 * Reads every readable row of a possibly damaged rowid table. Rows are
 * visited by rowid seeks (`rowid > ?`, or `rowid < ?`/`rowid <= ?` for the
 * negative space), so work grows with the rows actually stored, never with a
 * (possibly corrupt or sparse) max rowid. Damage is not monotonic — a
 * readable leaf can sit between two damaged ones — so when a seek fails, the
 * scan probes forward with a doubling step and pushes each skipped interval
 * onto a worklist — but only when the probe found a live row strictly inside
 * a strict sub-interval, so a queued interval can never requeue itself and a
 * dead tail cannot explode the worklist. Every probe also tries `rowid = ?`:
 * a row whose predecessor lives on a damaged page is unreachable by `rowid >`
 * and is only found by an exact seek. Negative rowids sit left of every probe
 * the forward anchor can reach, so a damage episode that starts negative
 * queues that span for a descending sweep from 0. Rows on a damaged page are
 * lost, and a row ringed by damage on both sides may be missed. `predicate`
 * filters rows (e.g. by `typeof`) before they are returned.
 * `damagedRegions` — a bound on the damage, since probes may hit one region
 * repeatedly; any other error propagates.
 */
export function readDamagedSqliteRows<T>(
	db: Database,
	table: string,
	columns: string,
	predicate = "1",
): { rows: T[]; damagedRegions: number } {
	const selection = `CAST(rowid AS TEXT) AS __salvage_rowid, (${predicate}) AS __salvage_ok, ${columns}`;
	const nextStmt = db.query<Record<string, unknown>, [string]>(
		`SELECT ${selection} FROM ${table} WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT 1`,
	);
	const exactStmt = db.query<Record<string, unknown>, [string]>(
		`SELECT ${selection} FROM ${table} WHERE rowid = CAST(? AS INTEGER)`,
	);
	const topStmt = db.query<Record<string, unknown>, [string]>(
		`SELECT ${selection} FROM ${table} WHERE rowid <= CAST(? AS INTEGER) ORDER BY rowid DESC LIMIT 1`,
	);
	const prevStmt = db.query<Record<string, unknown>, [string]>(
		`SELECT ${selection} FROM ${table} WHERE rowid < CAST(? AS INTEGER) ORDER BY rowid DESC LIMIT 1`,
	);
	let damagedRegions = 0;
	const read = (stmt: Statement<Record<string, unknown>, [string]>, origin: bigint): SalvageSeek => {
		let hit: Record<string, unknown> | null;
		try {
			hit = stmt.get(bindRowid(origin));
		} catch (error) {
			if (!isSqliteCorruptionError(error)) throw error;
			damagedRegions++;
			return "damaged";
		}
		if (!hit) return "end";
		const { __salvage_rowid: rowid, __salvage_ok: ok, ...row } = hit;
		if (typeof rowid !== "string") return "damaged";
		const parsedRowid = BigInt(rowid);
		// A cross-linked page can surface rowids out of order; treat that as damage so the scan always advances.
		if (
			(stmt === nextStmt && parsedRowid <= origin) ||
			(stmt === topStmt && parsedRowid > origin) ||
			(stmt === prevStmt && parsedRowid >= origin)
		)
			return "damaged";
		return { rowid: parsedRowid, ok: ok === 1, row };
	};

	const kept: { rowid: bigint; row: Record<string, unknown> }[] = [];
	const seen = new Set<bigint>();
	const keep = (seek: SalvageSeek): void => {
		if (typeof seek !== "object" || seen.has(seek.rowid)) return;
		seen.add(seek.rowid);
		if (seek.ok) kept.push({ rowid: seek.rowid, row: seek.row });
	};

	// The initial half-open interval cannot visit its own lower endpoint.
	keep(read(exactStmt, MIN_SQLITE_ROWID));

	// Half-open intervals (lo, hi] of unexplored seek origins, each swept in one
	// direction: 1 ascends from `lo` with `rowid >` seeks, -1 descends from `hi`
	// with `rowid <=`/`rowid <` seeks. `deadBoundary` marks an interval whose
	// entry boundary is a dead probe origin; the sweep skips its entry seek and
	// starts probing.
	const pending: Array<[lo: bigint, hi: bigint, deadBoundary: boolean, dir: 1 | -1]> = [
		[MIN_SQLITE_ROWID, MAX_SQLITE_ROWID, false, 1],
	];
	while (pending.length > 0) {
		const [lo, hi, deadBoundary, dir] = pending.pop()!;
		if (dir > 0) {
			let origin = lo;
			let seek: SalvageSeek = deadBoundary ? "damaged" : read(nextStmt, origin);
			for (;;) {
				if (seek === "end") break;
				if (seek !== "damaged") {
					keep(seek);
					if (seek.rowid > hi) break;
					origin = seek.rowid;
					seek = read(nextStmt, origin);
					continue;
				}
				// The successor of `origin` is unreadable. Negative rowids sit left
				// of every probe the forward anchor below can reach, so that span
				// goes to a descending sweep before probing; it self-terminates when
				// the table holds no negatives.
				if (origin < 0n && (hi > 0n ? 0n : hi) > origin) {
					pending.push([origin, hi > 0n ? 0n : hi, false, -1]);
				}
				// Probe forward; a skipped interval goes on the worklist only when
				// the probe found a live row inside it.
				let skipped = origin;
				let resumed = false;
				for (let step = 1n; ; step *= 2n) {
					const probe = probeAt(skipped < 0n ? 0n : skipped, step, hi);
					// A row at `probe` itself can sit on a readable leaf while every
					// `rowid >` path to it routes through damage.
					const exact = read(exactStmt, probe);
					keep(exact);
					const hit = read(nextStmt, probe);
					const liveInRange =
						(typeof exact === "object" && exact.rowid > skipped && exact.rowid <= hi) ||
						(typeof hit === "object" && hit.rowid > skipped && hit.rowid <= hi);
					// A width-1 gap holds only the dead probe's own origin, and an
					// entry that is not a strict sub-interval would requeue itself.
					if (probe > skipped + 1n && (skipped > lo || probe < hi) && liveInRange) {
						pending.push([skipped, probe - 1n, true, 1]);
					}
					if (hit === "damaged") {
						if (probe === hi) break;
						skipped = probe;
						continue;
					}
					if (hit === "end") break;
					keep(hit);
					if (hit.rowid > hi) break;
					origin = hit.rowid;
					seek = read(nextStmt, origin);
					resumed = true;
					break;
				}
				if (!resumed) break;
			}
			continue;
		}
		// Descending mirror of the forward sweep for negative rowids.
		let ceiling = hi;
		let seek: SalvageSeek = deadBoundary ? "damaged" : read(topStmt, ceiling);
		for (;;) {
			if (seek === "end") break;
			if (seek !== "damaged") {
				keep(seek);
				if (seek.rowid <= lo) break;
				ceiling = seek.rowid;
				seek = read(prevStmt, ceiling);
				continue;
			}
			// The predecessor of `ceiling` is unreadable. Probe downward with the
			// same doubling, exact-seek, and strict-sub-interval rules.
			let floor = ceiling;
			let resumed = false;
			for (let step = 1n; ; step *= 2n) {
				const probe = probeAt(floor, -step, lo);
				const exact = read(exactStmt, probe);
				keep(exact);
				const hit = read(prevStmt, probe);
				const liveInRange =
					(typeof exact === "object" && exact.rowid > lo && exact.rowid < floor) ||
					(typeof hit === "object" && hit.rowid > lo && hit.rowid < floor);
				if (probe < floor - 1n && (floor < hi || probe > lo) && liveInRange) {
					pending.push([probe + 1n, floor, true, -1]);
				}
				if (hit === "damaged") {
					if (probe === lo) break;
					floor = probe;
					continue;
				}
				if (hit === "end") break;
				keep(hit);
				if (hit.rowid <= lo) break;
				ceiling = hit.rowid;
				seek = read(prevStmt, ceiling);
				resumed = true;
				break;
			}
			if (!resumed) break;
		}
	}
	kept.sort((a, b) => (a.rowid < b.rowid ? -1 : a.rowid > b.rowid ? 1 : 0));
	return { rows: kept.map(entry => entry.row as T), damagedRegions };
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
