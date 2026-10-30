/**
 * Coordinates HistoryStorage and session-index connections to each history.db.
 * On POSIX file replacement, every old connection must close before any reopens:
 * otherwise SQLite can reuse their shared, orphaned SHM. Set PERSIST_WAL on all
 * old handles before finalizing or closing any so they preserve live sidecars.
 *
 * When the main inode is unchanged, inspect pending WAL frames with NOOP only
 * after confirming SQLite >= 3.51; older versions treat unknown modes as PASSIVE.
 * Unsafe recovery disables writes and retains the path and its handles for the
 * process lifetime, even on close, to avoid stale checkpoints. Reads may continue.
 * Bun still checkpoints native handles at VM exit; suppressing that needs runtime support.
 */

import { constants, type Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointWal, logger } from "@oh-my-pi/pi-utils";

/** Connection and lifecycle callbacks supplied by HistoryStorage or the session index after initialization. */
export interface HistoryDatabaseClient {
	db: Database;
	finalize: () => void;
	reopen: () => void;
}

/** Write and close guards used by HistoryStorage and session-index callers. */
export interface HistoryDatabaseRegistration {
	/** Returns false when this path is disabled or this registration is no longer active; callers must not write. */
	beforeWrite(): boolean;
	/** Closes a safe connection, optionally checkpointing first; disabled paths retain their handles. */
	close(options?: { checkpoint?: boolean }): void;
}

interface DatabaseIdentity {
	main: fs.Stats | undefined;
	wal: fs.Stats | undefined;
}

interface RegisteredDatabase {
	client: HistoryDatabaseClient;
	dbPath: string;
	walPath: string;
	identity: DatabaseIdentity | undefined;
	active: boolean;
}

interface DatabasePath {
	dbPath: string;
	clients: Set<RegisteredDatabase>;
	disabled: boolean;
	reopening: boolean;
}

// Retain disabled paths and their clients for the process lifetime: even a
// shutdown close could checkpoint stale WAL frames into the live database.
// Bun still forces checkpoints at VM exit; suppressing those needs runtime support.
const databases = new Map<string, DatabasePath>();
const isWindows = process.platform === "win32";
const statOptions = { throwIfNoEntry: false } as const;

function resolveDatabasePath(dbPath: string): string {
	const resolved = path.resolve(dbPath);
	if (isWindows) return resolved;
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function readIdentity(dbPath: string, walPath: string): DatabaseIdentity {
	return { main: fs.statSync(dbPath, statOptions), wal: fs.statSync(walPath, statOptions) };
}

function sameFile(left: fs.Stats | undefined, right: fs.Stats | undefined): boolean {
	if (!left || !right) return left === right;
	return left.dev === right.dev && left.ino === right.ino;
}

function identitiesCurrent(database: DatabasePath, current: DatabaseIdentity): boolean {
	for (const { identity } of database.clients) {
		if (!identity || !sameFile(identity.main, current.main) || !sameFile(identity.wal, current.wal)) return false;
	}
	return true;
}

function disableDatabase(database: DatabasePath, error: unknown): false {
	if (!database.disabled) {
		database.disabled = true;
		logger.warn("History database writes disabled", { dbPath: database.dbPath, error: String(error) });
	}
	return false;
}

function forgetEmptyDatabase(database: DatabasePath): void {
	if (!database.disabled && !database.reopening && database.clients.size === 0) databases.delete(database.dbPath);
}

function recoverDatabase(database: DatabasePath, current: DatabaseIdentity, closing?: RegisteredDatabase): boolean {
	if (database.disabled) return false;
	if (database.reopening) return disableDatabase(database, new Error("History database changed while reopening"));
	const clients = [...database.clients];
	try {
		for (const registration of clients) {
			const live = readIdentity(registration.dbPath, registration.walPath);
			if (!sameFile(live.main, current.main) || !sameFile(live.wal, current.wal)) {
				throw new Error("History database aliases no longer refer to the same files");
			}
		}
		for (const { client, identity } of clients) {
			if (!identity) throw new Error("History database file identity is unavailable");
			// SQLite's databaseIsUnmoved prevents a checkpoint into a replaced main
			// inode. A lost WAL on the same main inode needs a read-only inspection.
			if (!sameFile(identity.main, current.main)) continue;
			const version = client.db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get();
			const parts = version?.version.match(/^(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
			if (!parts || Number(parts[1]) < 3 || (Number(parts[1]) === 3 && Number(parts[2]) < 51)) {
				// Older SQLite treats an unknown checkpoint mode as PASSIVE, so NOOP
				// must never be issued before confirming support.
				throw new Error("Safe history WAL inspection requires SQLite 3.51 or newer");
			}
			const checkpoint = client.db
				.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(NOOP)")
				.get();
			if (
				checkpoint?.busy !== 0 ||
				typeof checkpoint.log !== "number" ||
				checkpoint.log < 0 ||
				checkpoint.log !== checkpoint.checkpointed
			) {
				throw new Error("History WAL has frames that cannot be safely checkpointed");
			}
		}
		// All old handles must preserve the live WAL/SHM names, including handles
		// attached to a replaced main inode. Do this before finalizing anything.
		for (const { client } of clients) {
			if (client.db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1) !== 0) {
				throw new Error("Could not preserve history WAL files while closing stale connections");
			}
		}
		for (const { client } of clients) client.finalize();
		for (const { client } of clients) client.db.close(true);
	} catch (error) {
		return disableDatabase(database, error);
	}

	for (const client of clients) client.active = false;
	database.clients.clear();
	// Connections for one main inode share unixShmNode. Opening even one
	// replacement before every old connection is gone can reuse orphaned SHM.
	database.reopening = true;
	try {
		for (const registration of clients) {
			if (registration === closing) continue;
			registration.client.reopen();
			if (database.disabled) return false;
		}
	} catch (error) {
		disableDatabase(database, error);
		throw error;
	} finally {
		database.reopening = false;
		forgetEmptyDatabase(database);
	}
	return !database.disabled;
}

/** Registers an initialized HistoryStorage or session-index connection for coordinated recovery and write guarding. */
export function registerHistoryDatabase(client: HistoryDatabaseClient): HistoryDatabaseRegistration {
	const dbPath = resolveDatabasePath(client.db.filename);
	let database = databases.get(dbPath);
	if (!database) {
		database = { dbPath, clients: new Set(), disabled: false, reopening: false };
		databases.set(dbPath, database);
	}
	const registered: RegisteredDatabase = {
		client,
		dbPath: client.db.filename,
		walPath: `${client.db.filename}-wal`,
		identity: undefined,
		active: true,
	};
	database.clients.add(registered);
	if (!isWindows && !database.disabled) {
		try {
			const identity = readIdentity(registered.dbPath, registered.walPath);
			if (!identity.main || !identity.wal) {
				throw new Error("History database file identity is unavailable after initialization");
			}
			registered.identity = identity;
		} catch (error) {
			disableDatabase(database, error);
		}
	}

	return {
		beforeWrite(): boolean {
			if (database.disabled || !registered.active) return false;
			if (isWindows) return true;
			let current: DatabaseIdentity;
			try {
				current = readIdentity(registered.dbPath, registered.walPath);
			} catch (error) {
				return disableDatabase(database, error);
			}
			return identitiesCurrent(database, current) || recoverDatabase(database, current);
		},
		close({ checkpoint = true } = {}): void {
			if (database.disabled || !registered.active) return;
			if (!isWindows) {
				let current: DatabaseIdentity;
				try {
					current = readIdentity(registered.dbPath, registered.walPath);
				} catch (error) {
					disableDatabase(database, error);
					return;
				}
				if (!identitiesCurrent(database, current)) {
					recoverDatabase(database, current, registered);
					return;
				}
			}
			if (checkpoint) checkpointWal(client.db);
			client.finalize();
			client.db.close();
			registered.active = false;
			database.clients.delete(registered);
			forgetEmptyDatabase(database);
		},
	};
}

/** Guards cold initialization/DDL; false permits only read-only opening without schema changes or recovery. */
export function prepareHistoryDatabaseOpen(dbPath: string): boolean {
	const database = databases.get(resolveDatabasePath(dbPath));
	if (!database) return true;
	if (database.disabled) return false;
	if (isWindows || database.reopening || database.clients.size === 0) return true;
	let current: DatabaseIdentity;
	try {
		current = readIdentity(dbPath, `${dbPath}-wal`);
	} catch (error) {
		return disableDatabase(database, error);
	}
	return identitiesCurrent(database, current) || recoverDatabase(database, current);
}
