import type { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../db";
export const DEFAULT_LOG_DIR = path.join(os.homedir(), ".mnemopi", "data");
export const DEFAULT_LOG_DB = path.join(DEFAULT_LOG_DIR, "cost_log.db");

export interface CostStats {
	total_calls: number;
	total_memories_injected: number;
	total_tokens: number;
	total_estimated_cost_usd: number;
}

type AggregateRow = {
	calls: number | null;
	total_memories: number | null;
	total_tokens: number | null;
	total_cost: number | null;
};

export function getConn(dbPath?: string): Database {
	const path = dbPath ?? DEFAULT_LOG_DB;
	return openDatabase(path, { pragmas: false });
}

export function initCostLog(dbPath?: string): void {
	const conn = getConn(dbPath);
	try {
		conn.run(`
			CREATE TABLE IF NOT EXISTS cost_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT,
				memory_count INTEGER,
				token_count INTEGER,
				estimated_cost_usd REAL,
				model TEXT DEFAULT 'default',
				timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
	} finally {
		conn.close();
	}
}
export function logCost(
	sessionId: string,
	memoryCount: number,
	tokenCount: number,
	estimatedCostUsd: number,
	model = "default",
	dbPath?: string,
): void {
	initCostLog(dbPath);
	const conn = getConn(dbPath);
	try {
		conn
			.query(`
				INSERT INTO cost_entries (session_id, memory_count, token_count, estimated_cost_usd, model, timestamp)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(sessionId, memoryCount, tokenCount, estimatedCostUsd, model, localIsoTimestamp(new Date()));
	} finally {
		conn.close();
	}
}
export function getCostStats(sessionId?: string, dbPath?: string): CostStats {
	initCostLog(dbPath);
	const conn = getConn(dbPath);
	try {
		const row = (
			sessionId
				? conn
						.query(`
						SELECT COUNT(*) as calls, SUM(memory_count) as total_memories,
							SUM(token_count) as total_tokens, SUM(estimated_cost_usd) as total_cost
						FROM cost_entries WHERE session_id = ?
					`)
						.get(sessionId)
				: conn
						.query(`
						SELECT COUNT(*) as calls, SUM(memory_count) as total_memories,
							SUM(token_count) as total_tokens, SUM(estimated_cost_usd) as total_cost
						FROM cost_entries
					`)
						.get()
		) as AggregateRow | null;

		return {
			total_calls: row?.calls ?? 0,
			total_memories_injected: row?.total_memories ?? 0,
			total_tokens: row?.total_tokens ?? 0,
			total_estimated_cost_usd: Math.round((row?.total_cost ?? 0) * 1_000_000) / 1_000_000,
		};
	} finally {
		conn.close();
	}
}
function localIsoTimestamp(date: Date): string {
	const offsetMs = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offsetMs).toISOString().replace("Z", "");
}
