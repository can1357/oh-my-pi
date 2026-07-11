/**
 * Memory-operation audit log (governance floor).
 *
 * Every facade-level memory operation — remember, recall, get, forget,
 * update, sleep, scratchpad writes — appends one row here, giving erasure
 * requests and poisoning investigations a complete, queryable trail of who
 * touched which memory when. Writes are best-effort: an audit failure must
 * never fail the operation it describes.
 */

import type { Database } from "bun:sqlite";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { toUtcIso } from "../util/datetime";

export type MemoryAuditOp =
	| "remember"
	| "recall"
	| "recall_enhanced"
	| "get"
	| "forget"
	| "update"
	| "sleep"
	| "scratchpad_write";

export interface MemoryAuditEntry {
	op: MemoryAuditOp;
	bank: string;
	sessionId: string;
	authorId?: string | null;
	/** Target memory id for point operations (get/forget/update/remember). */
	memoryId?: string | null;
	/** Query text for retrieval operations. */
	query?: string | null;
	/** Small JSON-serializable operation detail (result count, source, …). */
	detail?: Record<string, unknown>;
}

const initializedDbs = new WeakSet<Database>();

function ensureTable(db: Database): void {
	if (initializedDbs.has(db)) return;
	db.run(`
		CREATE TABLE IF NOT EXISTS memory_audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TEXT NOT NULL,
			op TEXT NOT NULL,
			bank TEXT NOT NULL,
			session_id TEXT NOT NULL,
			author_id TEXT,
			memory_id TEXT,
			query TEXT,
			detail TEXT
		)
	`);
	db.run("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON memory_audit_log(timestamp)");
	db.run("CREATE INDEX IF NOT EXISTS idx_audit_memory ON memory_audit_log(memory_id)");
	initializedDbs.add(db);
}

/** Append one audit row. Never throws. */
export function recordMemoryAudit(db: Database, entry: MemoryAuditEntry): void {
	try {
		ensureTable(db);
		db.prepare(
			`INSERT INTO memory_audit_log (timestamp, op, bank, session_id, author_id, memory_id, query, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			toUtcIso(),
			entry.op,
			entry.bank,
			entry.sessionId,
			entry.authorId ?? null,
			entry.memoryId ?? null,
			entry.query ?? null,
			entry.detail ? JSON.stringify(entry.detail) : null,
		);
	} catch (error) {
		logger.warn("mnemopi: audit-log write failed", {
			op: entry.op,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface MemoryAuditRow {
	id: number;
	timestamp: string;
	op: MemoryAuditOp;
	bank: string;
	session_id: string;
	author_id: string | null;
	memory_id: string | null;
	query: string | null;
	detail: string | null;
}

/** Read recent audit rows, newest first. */
export function readMemoryAudit(
	db: Database,
	options: { limit?: number; op?: MemoryAuditOp; memoryId?: string } = {},
): MemoryAuditRow[] {
	ensureTable(db);
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	if (options.op) {
		clauses.push("op = ?");
		params.push(options.op);
	}
	if (options.memoryId) {
		clauses.push("memory_id = ?");
		params.push(options.memoryId);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	params.push(options.limit ?? 100);
	return db
		.prepare(`SELECT * FROM memory_audit_log ${where} ORDER BY id DESC LIMIT ?`)
		.all(...params) as MemoryAuditRow[];
}
