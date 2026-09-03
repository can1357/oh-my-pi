import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { closeQuietly, type DatabasePath, openDatabase } from "../../db";

export const ANNOTATION_KINDS = ["mentions", "fact", "occurred_on", "has_source"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export interface MigrationOptions {
	readonly dbPath: DatabasePath;
	readonly dryRun?: boolean;
	readonly backup?: boolean;
	readonly logFn?: (line: string) => void;
}

export interface PendingConnection {
	query<T = unknown>(sql: string): { get(...params: unknown[]): T | null };
}
type SerializableDatabase = Database & { serialize(): Uint8Array };

interface TripleCandidateRow {
	id: number;
	subject: string;
	predicate: AnnotationKind;
	object: string;
	source: string | null;
	confidence: number | null;
	created_at: string | null;
}

interface Classification {
	rows: TripleCandidateRow[];
	total: number;
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(",");
}

function hasTable(db: Database, name: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
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

function initAnnotations(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS annotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			source TEXT,
			confidence REAL DEFAULT 1.0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_annot_memory_kind ON annotations(memory_id, kind)");
	db.run("CREATE INDEX IF NOT EXISTS idx_annot_kind_value ON annotations(kind, value)");
	db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_annot_unique ON annotations(memory_id, kind, value)");
}

export function hasPendingMigration(db: Database): boolean {
	if (!hasTable(db, "triples")) return false;
	const marks = placeholders(ANNOTATION_KINDS.length);
	if (!hasTable(db, "annotations")) {
		return db.query(`SELECT 1 FROM triples WHERE predicate IN (${marks}) LIMIT 1`).get(...ANNOTATION_KINDS) !== null;
	}
	return (
		db
			.query(`
				SELECT 1
				FROM triples t
				WHERE t.predicate IN (${marks})
				  AND NOT EXISTS (
					  SELECT 1 FROM annotations a
					  WHERE a.memory_id = t.subject
						AND a.kind = t.predicate
						AND a.value = t.object
				  )
				LIMIT 1
			`)
			.get(...ANNOTATION_KINDS) !== null
	);
}
function classifyRows(db: Database): Classification {
	if (!hasTable(db, "triples")) return { rows: [], total: 0 };
	const totalRow = db.query("SELECT COUNT(*) AS count FROM triples").get() as { count: number };
	const marks = placeholders(ANNOTATION_KINDS.length);
	const candidates = db
		.query(`
			SELECT id, subject, predicate, object, source, confidence, created_at
			FROM triples
			WHERE predicate IN (${marks})
			ORDER BY id ASC
		`)
		.all(...ANNOTATION_KINDS) as TripleCandidateRow[];
	if (!hasTable(db, "annotations")) return { rows: candidates, total: totalRow.count };
	const rows = candidates.filter(row => {
		return (
			db
				.query("SELECT 1 FROM annotations WHERE memory_id = ? AND kind = ? AND value = ? LIMIT 1")
				.get(row.subject, row.predicate, row.object) === null
		);
	});
	return { rows, total: totalRow.count };
}

function kindCounts(rows: readonly TripleCandidateRow[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.predicate] = (counts[row.predicate] ?? 0) + 1;
	return counts;
}

function migrateRows(db: Database, rows: readonly TripleCandidateRow[]): number {
	if (rows.length === 0) return 0;
	using insert = db.prepare(`
		INSERT OR IGNORE INTO annotations (memory_id, kind, value, source, confidence, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	let written = 0;
	for (const row of rows) {
		const result = insert.run(
			row.subject,
			row.predicate,
			row.object,
			row.source,
			row.confidence ?? 1.0,
			row.created_at,
		) as {
			readonly changes: number;
		};
		written += result.changes;
	}
	return written;
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
	let classified: Classification;
	try {
		classified = classifyRows(db);
	} finally {
		closeQuietly(db);
	}

	effectiveLog(`Database: ${dbPath}`);
	effectiveLog(`  triples rows (total):        ${classified.total}`);
	effectiveLog(`  rows-to-migrate (this run):  ${classified.rows.length}`);
	if (classified.rows.length > 0) {
		const counts = kindCounts(classified.rows);
		for (const kind of Object.keys(counts).sort()) effectiveLog(`    ${kind.padEnd(14, " ")} ${counts[kind]}`);
	}
	if (classified.rows.length === 0) {
		effectiveLog("Nothing to migrate. Schema is already split or no annotation rows exist.");
		return 0;
	}
	if (effectiveDryRun) {
		effectiveLog("Dry run: no changes written.");
		return classified.rows.length;
	}
	if (effectiveBackup) {
		const backupPath = `${dbPath}.pre_e6_backup`;
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
			initAnnotations(db);
			const lockedClassification = classifyRows(db);
			const written = migrateRows(db, lockedClassification.rows);
			db.run("COMMIT");
			effectiveLog(`Migration complete: ${written} rows moved to annotations table.`);
			return written;
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	} finally {
		closeQuietly(db);
	}
}
