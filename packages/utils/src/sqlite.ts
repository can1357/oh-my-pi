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

/** True when bun:sqlite rejected a call because the Database was already closed. */
export function isSqliteClosedError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("Database has closed");
}

/**
 * Benign WAL-checkpoint I/O failures from temp-directory teardown races.
 * Real durability failures (`SQLITE_IOERR_WRITE` / `_FSYNC` / `_TRUNCATE`, …)
 * must still propagate.
 */
function isBenignCheckpointIoError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err) || typeof err.code !== "string") {
		return false;
	}
	const code = err.code;
	return (
		code === "SQLITE_IOERR_VNODE" ||
		code === "SQLITE_IOERR_DELETE" ||
		code === "SQLITE_IOERR_DELETE_NOENT"
	);
}

/** Checkpoints committed WAL frames without waiting for concurrent readers. */
export function checkpointWal(db: Database): void {
	try {
		db.run("PRAGMA wal_checkpoint(PASSIVE)");
	} catch (err) {
		// Close races: the handle is already gone, or the temp file was unlinked
		// (SQLITE_IOERR_VNODE / DELETE*) while another test tore down the directory.
		if (isSqliteClosedError(err) || isBenignCheckpointIoError(err)) return;
		throw err;
	}
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
