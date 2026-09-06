/**
 * Shared classifiers for `bun:sqlite` error result codes.
 *
 * Every omp SQLite store (`agent.db` credential/usage store, `models.db` model
 * cache, `history.db`) needs the same two distinctions: a transient BUSY that
 * clears by retrying, and an unrecoverable corruption that never does. Keeping
 * one implementation here prevents the classifiers from drifting between the
 * credential store and the model cache.
 */
import type { Database } from "bun:sqlite";

/**
 * Checkpoints committed WAL frames without waiting for concurrent readers.
 *
 * A closed handle is a no-op, not an error: SQLite checkpoints on close, so
 * there is nothing left to flush. `bun:sqlite` ≥ 1.4 throws
 * `Database has closed` here where earlier versions tolerated it, and every
 * caller runs this from a `close()` path — one that throws leaves the caller's
 * own teardown half-done.
 */
export function checkpointWal(db: Database): void {
	try {
		db.run("PRAGMA wal_checkpoint(PASSIVE)");
	} catch (err) {
		if (!isClosedDatabaseError(err)) throw err;
	}
}

/**
 * `bun:sqlite`'s "already closed" guard. It carries no result code — the handle
 * never reached SQLite — so this matches the message rather than a `code`.
 */
export function isClosedDatabaseError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Database has closed");
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
