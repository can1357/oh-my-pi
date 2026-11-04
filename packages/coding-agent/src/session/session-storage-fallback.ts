/**
 * The one rule that makes `session.storage: sql` safe to switch on for a fleet
 * whose boxes may not all hold a connection file yet:
 *
 * > A session may fall back from `sql` to the file store **only before its
 * > first SQL write** — loudly, and recorded. Once this run has written an
 * > entry to the database, an unreadable connection file or an unreachable
 * > database halts the session instead of forking its transcript into a file.
 *
 * Forking after a write is the damage this guards against: half the turn in a
 * database row, half in a JSONL file, and no single place that holds the
 * conversation. Before the first write there is nothing to tear — a resume
 * whose transcript is already a file on disk goes on reading and writing that
 * file and loses nothing.
 *
 * Three launches, three outcomes:
 *
 * | Launch | `sql` selected, connection unusable |
 * | --- | --- |
 * | resume of a session whose transcript is a file on disk | continues on the file store, warns, appends a ledger line |
 * | this run already wrote to the database | halts (no fallback, no file transcript) |
 * | a new session | refuses to start |
 *
 * A warning alone is not a control: a fleet degrades silently when a log line
 * is the only trace. Every fallback also appends one line to a ledger an
 * operator reads, so a persistent connection problem shows as a rising count
 * rather than as scattered warnings. The ledger path comes from
 * `session.sql.fallbackLedger` / `OMP_SESSION_SQL_FALLBACK_LEDGER`; it defaults
 * to `<agentDir>/session-sql-fallbacks.jsonl`, and a deployment whose health
 * reading lives elsewhere (a directory mounted into every container, say)
 * points the setting at that file.
 */
import { getAgentDir, logger, toError } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import { cfgSessionSqlFallbackLedger } from "./storage-settings";

/** Why a `sql` session fell back to the file store. */
export type SessionStorageFallbackReason = "dsn-missing" | "dsn-unreadable" | "db-unreachable";

/** One appended ledger line. Field names are the ledger's wire format; an operator's reader parses them. */
export interface SessionStorageFallbackEvent {
	ts: string;
	session_id: string;
	reason: SessionStorageFallbackReason;
	dsn_path: string;
	host: string;
}

/**
 * One line must stay inside a page so concurrent `O_APPEND` writes from
 * different processes cannot interleave. Only `dsn_path` and `session_id` are
 * caller-sized, so those are what gets trimmed.
 */
const MAX_LEDGER_LINE_BYTES = 4096;

const DEFAULT_LEDGER_NAME = "session-sql-fallbacks.jsonl";

/**
 * Set once this process has committed a write to the SQL session store. From
 * then on the store is the only place the transcript lives, so nothing may
 * route a later write to a file.
 */
let sqlWriteCommitted = false;

/** Called by {@link SqlSessionStorage} after a write the database accepted. */
export function noteSqlWriteCommitted(): void {
	sqlWriteCommitted = true;
}

/** Whether this run has already written to the SQL session store. */
export function sqlStoreHasWritten(): boolean {
	return sqlWriteCommitted;
}

/** Test seam: forget this process's SQL writes so the latch can be driven both ways. */
export function resetSqlWriteLatchForTest(): void {
	sqlWriteCommitted = false;
}

/** Where fallback events are appended: the configured path, else one in the agent directory. */
export function fallbackLedgerPath(settings: Settings, env: NodeJS.ProcessEnv): string {
	const configured =
		env.OMP_SESSION_SQL_FALLBACK_LEDGER?.trim() || cfgSessionSqlFallbackLedger.layered(settings)?.trim();
	return configured || path.join(getAgentDir(), DEFAULT_LEDGER_NAME);
}

/** The event's JSON line, trimmed to {@link MAX_LEDGER_LINE_BYTES} including its newline. */
export function ledgerLine(event: SessionStorageFallbackEvent): string {
	let line = `${JSON.stringify(event)}\n`;
	if (Buffer.byteLength(line, "utf8") <= MAX_LEDGER_LINE_BYTES) return line;
	// Trim the only unbounded field rather than drop the event: a truncated path
	// still names which connection file failed.
	const overflow = Buffer.byteLength(line, "utf8") - MAX_LEDGER_LINE_BYTES;
	const trimmed = {
		...event,
		dsn_path: `${event.dsn_path.slice(0, Math.max(0, event.dsn_path.length - overflow - 1))}…`,
	};
	line = `${JSON.stringify(trimmed)}\n`;
	return Buffer.byteLength(line, "utf8") <= MAX_LEDGER_LINE_BYTES
		? line
		: `${JSON.stringify({ ...trimmed, dsn_path: "…" })}\n`;
}

/**
 * Warn and append one ledger line for a fallback that has been decided. The
 * warning and the line carry the same three facts — which session, which
 * connection file, and why it could not be used — because "fell back to file
 * storage" alone tells an operator nothing about what to fix.
 *
 * A ledger that cannot be written warns and does not stop the session: the
 * fallback itself is what keeps the box working.
 */
export async function recordSessionStorageFallback(
	event: SessionStorageFallbackEvent,
	ledgerFile: string,
): Promise<void> {
	logger.warn(
		`session.storage is sql, but the session database is unusable (${event.reason}); ` +
			`continuing on file storage for this resumed session`,
		{ session: event.session_id, dsnPath: event.dsn_path, reason: event.reason, ledger: ledgerFile },
	);
	try {
		await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
		await fs.appendFile(ledgerFile, ledgerLine(event), "utf8");
	} catch (err) {
		logger.warn("Could not append to the session-storage fallback ledger", {
			ledger: ledgerFile,
			error: toError(err).message,
		});
	}
}

/** The event for a fallback happening now, on this host. */
export function fallbackEvent(
	sessionId: string,
	reason: SessionStorageFallbackReason,
	dsnPath: string,
): SessionStorageFallbackEvent {
	return { ts: new Date().toISOString(), session_id: sessionId, reason, dsn_path: dsnPath, host: os.hostname() };
}
