import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { closeQuietly, type DatabasePath, openDatabase } from "../../db";

/**
 * E7: add the missing `scope` column to the `facts` table.
 *
 * Beam recall has supported fact scoping on the read side for a while —
 * `factsHaveScopeColumn()` probes for the column at query time and
 * `factVisibilityWhere()` applies `(session_id = ? OR scope = 'global')`
 * whenever it exists (see `core/beam/recall.ts`). The schema never shipped
 * the column, so the probe always failed and extracted facts were
 * permanently same-session-only on every bank.
 *
 * Policy:
 * - The column is added as `TEXT DEFAULT 'session'`. Pre-existing rows keep
 *   the default, i.e. they are NOT retroactively widened to 'global' — that
 *   widening is deliberately left to fresh extraction writes.
 * - No FTS-side action is needed: `fts_facts` is an FTS5 external-content
 *   table over (subject, predicate, object) and its triggers reference only
 *   those columns, exactly like the many column adds on `episodic_memory`
 *   that never touched `fts_episodes`.
 * - Idempotent: the probe is `PRAGMA table_info(facts)`, so re-running (or
 *   opening the bank through `initBeam`, which also adds the column) is a
 *   no-op.
 */
export const FACTS_SCOPE_COLUMN = "scope";
export const FACTS_SCOPE_DEFAULT = "session";
export const FACTS_SCOPE_GLOBAL = "global";

export interface MigrationOptions {
	readonly dbPath: DatabasePath;
	readonly dryRun?: boolean;
	readonly backup?: boolean;
	readonly logFn?: (line: string) => void;
}

type SerializableDatabase = Database & { serialize(): Uint8Array };

interface ColumnInfoRow {
	name: string;
}

function hasTable(db: Database, name: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function factColumns(db: Database): string[] {
	const rows = db.query("PRAGMA table_info(facts)").all() as ColumnInfoRow[];
	return rows.map(row => row.name);
}

export function hasPendingMigration(db: Database): boolean {
	if (!hasTable(db, "facts")) return false;
	return !factColumns(db).includes(FACTS_SCOPE_COLUMN);
}

function copyDatabase(source: DatabasePath, destination: string): void {
	let db: Database | null = null;
	try {
		db = openDatabase(source, { create: false, readwrite: false, pragmas: false });
		writeFileSync(destination, (db as SerializableDatabase).serialize());
	} finally {
		closeQuietly(db);
	}
}

export function migrate(
	dbPathOrOptions: DatabasePath | MigrationOptions,
	dryRun = false,
	backup = true,
	logFn: (line: string) => void = console.log,
): number {
	const options =
		typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions, dryRun, backup, logFn } : dbPathOrOptions;
	const dbPath = options.dbPath;
	const effectiveDryRun = options.dryRun ?? false;
	const effectiveBackup = options.backup ?? true;
	const effectiveLog = options.logFn ?? console.log;
	if (dbPath === ":memory:" || !existsSync(dbPath)) {
		effectiveLog(`ERROR: database not found: ${dbPath}`);
		throw new Error(`database not found: ${dbPath}`);
	}

	let db = openDatabase(dbPath);
	let pending = false;
	let columns: string[] = [];
	try {
		pending = hasPendingMigration(db);
		columns = hasTable(db, "facts") ? factColumns(db) : [];
	} finally {
		closeQuietly(db);
	}

	effectiveLog(`Database: ${dbPath}`);
	if (!pending) {
		effectiveLog("Nothing to migrate. facts.scope already exists (or the facts table is absent).");
		return 0;
	}
	effectiveLog(`  facts columns (before):    ${columns.join(", ")}`);
	if (effectiveDryRun) {
		effectiveLog("Dry run: no changes written.");
		return 1;
	}
	if (effectiveBackup) {
		const backupPath = `${dbPath}.pre_e7_backup`;
		if (existsSync(backupPath)) effectiveLog(`Backup already exists at ${backupPath}; leaving as-is.`);
		else {
			copyDatabase(dbPath, backupPath);
			effectiveLog(`Backup written to ${backupPath}`);
		}
	}

	db = openDatabase(dbPath);
	try {
		db.run("BEGIN IMMEDIATE");
		try {
			if (!hasPendingMigration(db)) {
				db.run("ROLLBACK");
				effectiveLog("Nothing to migrate (facts.scope appeared between probe and lock).");
				return 0;
			}
			db.run(`ALTER TABLE facts ADD COLUMN ${FACTS_SCOPE_COLUMN} TEXT DEFAULT '${FACTS_SCOPE_DEFAULT}'`);
			db.run("COMMIT");
			effectiveLog("Migration complete: facts.scope added (pre-existing rows keep the 'session' default).");
			return 1;
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	} finally {
		closeQuietly(db);
	}
}
