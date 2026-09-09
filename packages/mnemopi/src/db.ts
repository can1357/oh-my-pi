import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config";

export type SqlitePageSize = number | "os";

const MIN_SQLITE_PAGE_SIZE = 512;
const MAX_SQLITE_PAGE_SIZE = 65536;
let detectedSystemPageSize: number | null | undefined;

function isValidPageSize(size: number): boolean {
	return (
		Number.isInteger(size) &&
		size >= MIN_SQLITE_PAGE_SIZE &&
		size <= MAX_SQLITE_PAGE_SIZE &&
		(size & (size - 1)) === 0
	);
}

function detectSystemPageSize(): number | undefined {
	if (detectedSystemPageSize !== undefined) return detectedSystemPageSize ?? undefined;
	try {
		const proc = Bun.spawnSync(["getconf", "PAGE_SIZE"], { stdout: "pipe" });
		if (proc.exitCode === 0) {
			const size = Number(proc.stdout.toString().trim());
			if (isValidPageSize(size)) {
				detectedSystemPageSize = size;
				return size;
			}
		}
	} catch {
		/* fall through */
	}
	detectedSystemPageSize = null;
	return undefined;
}

function configuredPageSize(): SqlitePageSize | undefined {
	const raw = process.env.MNEMOPI_DB_PAGE_SIZE?.trim();
	if (!raw) return undefined;
	if (raw.toLowerCase() === "os") return "os";
	const size = Number(raw);
	return isValidPageSize(size) ? size : undefined;
}

function resolvePageSize(requested?: SqlitePageSize): number | undefined {
	const pageSize = requested ?? configuredPageSize();
	if (pageSize === "os") return detectSystemPageSize();
	return pageSize !== undefined && isValidPageSize(pageSize) ? pageSize : undefined;
}

function applyPageSize(db: Database, path: DatabasePath, requested?: SqlitePageSize): void {
	if (path === ":memory:") return;
	const pageSize = resolvePageSize(requested);
	if (pageSize !== undefined) db.exec(`PRAGMA page_size=${pageSize}`);
}

export type DatabasePath = string | ":memory:";

export interface OpenDatabaseOptions {
	readonly create?: boolean;
	readonly readwrite?: boolean;
	readonly strict?: boolean;
	readonly loadExtension?: string | readonly string[];
	readonly pragmas?: boolean;
	readonly pageSize?: SqlitePageSize;
}

interface TxState {
	depth: number;
}

const TX_STATE = Symbol("mnemopi.txState");

type TxDatabase = Database & { [TX_STATE]?: TxState };
type ExtensionDatabase = Database & { loadExtension(path: string): void };

export function openDatabase(path: DatabasePath = dbPath(), options: OpenDatabaseOptions = {}): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, {
		create: options.create ?? true,
		readwrite: options.readwrite ?? true,
		strict: options.strict ?? true,
	});
	if (options.pragmas !== false) enablePragmas(db, path, options.pageSize);
	else if (options.readwrite !== false) applyPageSize(db, path, options.pageSize);
	if (options.loadExtension !== undefined) loadExtensions(db, options.loadExtension);
	return db;
}

export function enablePragmas(db: Database, path?: DatabasePath, pageSize?: SqlitePageSize): void {
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	if (path !== ":memory:") {
		applyPageSize(db, path ?? dbPath(), pageSize);
		db.exec("PRAGMA journal_mode=WAL");
	}
}

export function loadExtensions(db: Database, extensions: string | readonly string[]): void {
	if (typeof extensions === "string") {
		if (extensions) (db as ExtensionDatabase).loadExtension(extensions);
		return;
	}
	for (const extension of extensions) {
		if (extension) (db as ExtensionDatabase).loadExtension(extension);
	}
}

export function transaction<T>(db: Database, fn: () => T): T {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export const deferredTransaction = transaction;

export async function transactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return await fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = await fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export function closeQuietly(db: Database | undefined | null): void {
	if (db === undefined || db === null) return;
	try {
		db.close();
	} catch {
		// Best-effort cleanup.
	}
}
