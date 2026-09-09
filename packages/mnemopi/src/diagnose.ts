import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { dataDir as configuredDataDir, dbPath as configuredDbPath } from "./config";
import { initBeam } from "./core/beam";
import { closeQuietly, openDatabase } from "./db";

export interface DiagnosticEntry {
	readonly ts: string;
	readonly category: string;
	readonly check: string;
	readonly status: string;
	readonly detail?: string;
}

export interface DiagnosticSummary {
	readonly checks_total: number;
	readonly checks_passed: number;
	readonly checks_failed: number;
	readonly key_findings: string[];
	readonly entries: DiagnosticEntry[];
	readonly database: string;
}

export interface DiagnosticOptions {
	readonly db?: Database;
	readonly dbPath?: string;
	readonly dataDir?: string;
	readonly initialize?: boolean;
}

type CountRow = { count: number };
type IntegrityRow = { integrity_check: string };
type TableRow = { name: string };
type ColumnRow = { name: string };

const REQUIRED_TABLES = [
	"working_memory",
	"episodic_memory",
	"scratchpad",
	"fts_working",
	"fts_episodes",
	"memoria_facts",
	"memoria_timelines",
	"memoria_kg",
	"memoria_instructions",
	"memoria_preferences",
	"consolidation_log",
	"annotations",
	"triples",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	working_memory: ["id", "content", "source", "timestamp", "session_id", "importance"],
	episodic_memory: ["id", "content", "source", "timestamp", "session_id", "importance"],
	scratchpad: ["id", "content", "session_id"],
	triples: ["id", "subject", "predicate", "object"],
	annotations: ["id", "memory_id", "kind", "value"],
};

function nowIso(): string {
	return new Date().toISOString();
}

function hasTable(db: Database, table: string): boolean {
	return (
		(db
			.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
			.get(table) as TableRow | null) !== null
	);
}

function tableColumns(db: Database, table: string): Set<string> {
	return new Set((db.query(`PRAGMA table_info(${table})`).all() as ColumnRow[]).map(row => row.name));
}

function safeCount(db: Database, table: string): number | null {
	if (!hasTable(db, table)) return null;
	return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow).count;
}

function safeEnv(name: string): string {
	return process.env[name] ? "set" : "unset";
}

function passStatus(status: string): boolean {
	return status === "OK" || status === "YES" || status === "set" || status === "0";
}

function failStatus(status: string): boolean {
	return status === "MISSING" || status === "NO" || status === "ERROR" || status === "FAIL";
}

export function inspectDatabase(options: DiagnosticOptions = {}): DiagnosticSummary {
	const path = options.dbPath ?? configuredDbPath();
	const entries: DiagnosticEntry[] = [];
	const log = (category: string, check: string, status: string, detail = ""): void => {
		entries.push({ ts: nowIso(), category, check, status, detail });
	};

	log("env", "bun_version", Bun.version);
	log("env", "platform", `${process.platform}-${process.arch}`);
	log("env", "MNEMOPI_DATA_DIR", safeEnv("MNEMOPI_DATA_DIR"));
	log("env", "MNEMOPI_VEC_TYPE", safeEnv("MNEMOPI_VEC_TYPE"));
	log("db", "db_path", "OK", path);
	log("db", "data_dir", "OK", options.dataDir ?? configuredDataDir());
	log("db", "data_dir_parent", existsSync(dirname(path)) ? "OK" : "MISSING", dirname(path));

	let db = options.db;
	let owned = false;
	try {
		if (!db) {
			db = openDatabase(path);
			owned = true;
		}
		if (options.initialize !== false) initBeam(db);

		const integrity = db.query("PRAGMA integrity_check").get() as IntegrityRow;
		log("db", "integrity_check", integrity.integrity_check === "ok" ? "OK" : "FAIL", integrity.integrity_check);

		for (const table of REQUIRED_TABLES) {
			log("schema", `table:${table}`, hasTable(db, table) ? "OK" : "MISSING");
		}
		for (const table in REQUIRED_COLUMNS) {
			if (!hasTable(db, table)) continue;
			const columns = REQUIRED_COLUMNS[table];
			if (!columns) continue;
			const present = tableColumns(db, table);
			const missing = columns.filter(column => !present.has(column));
			log(
				"schema",
				`columns:${table}`,
				missing.length === 0 ? "OK" : "MISSING",
				missing.length === 0 ? `${present.size} columns` : `missing=${missing.join(",")}`,
			);
		}

		for (const table of ["working_memory", "episodic_memory", "scratchpad", "triples", "annotations"] as const) {
			const count = safeCount(db, table);
			log("db", `${table}_count`, count === null ? "MISSING" : String(count));
		}
	} catch (error) {
		log("db", "open_or_inspect", "ERROR", error instanceof Error ? error.message : String(error));
	} finally {
		if (owned) closeQuietly(db);
	}

	const keyFindings: string[] = [];
	for (const entry of entries) {
		if (entry.status === "MISSING") keyFindings.push(`${entry.check} missing`);
		else if (entry.status === "FAIL" || entry.status === "ERROR") {
			keyFindings.push(`${entry.check}: ${entry.detail ?? entry.status}`);
		}
	}

	return {
		checks_total: entries.length,
		checks_passed: entries.filter(entry => passStatus(entry.status) || /^\d+$/.test(entry.status)).length,
		checks_failed: entries.filter(entry => failStatus(entry.status)).length,
		key_findings: keyFindings,
		entries,
		database: path,
	};
}

export function runDiagnostics(options: DiagnosticOptions = {}): DiagnosticSummary {
	return inspectDatabase(options);
}
if (import.meta.main) {
	const summary = runDiagnostics();
	console.log(JSON.stringify(summary, null, 2));
	process.exit(summary.checks_failed === 0 ? 0 : 1);
}
