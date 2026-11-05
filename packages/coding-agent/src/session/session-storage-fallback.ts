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
import * as fsSync from "node:fs";
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
	pending = undefined;
	committed = false;
}

/** Where fallback events are appended: the configured path, else one in the agent directory. */
export function fallbackLedgerPath(settings: Settings, env: NodeJS.ProcessEnv): string {
	const configured =
		env.OMP_SESSION_SQL_FALLBACK_LEDGER?.trim() || cfgSessionSqlFallbackLedger.layered(settings)?.trim();
	return configured || path.join(getAgentDir(), DEFAULT_LEDGER_NAME);
}

/**
 * Width the `session_id` field is padded to, so the line can be written before
 * the session is known and refined in place afterwards without changing its
 * length. A session id is a 36-character UUID; a reader trims the padding.
 */
const SESSION_ID_WIDTH = 36;

/** What a ledger line records until the launch has opened a session. */
export const UNRESOLVED_SESSION = "(unresolved)";

/**
 * This process's placeholder: {@link UNRESOLVED_SESSION} plus a nonce, so that
 * two launches falling back in the same millisecond with the same connection
 * file on the same host do not write byte-identical lines. The refinement
 * finds its line by exact match, and identical lines made it findable only by
 * luck — measured, 24 such launches left 9 lines named and 15 still holding a
 * placeholder, every one of them valid JSON and counted, but attributed to
 * the wrong launch. A reader trims the padding and sees it is unresolved.
 *
 * Per reserve, not per process: two fallbacks in one process would collide
 * just as two processes do.
 */
function unresolvedPlaceholder(): string {
	return `${UNRESOLVED_SESSION} ${Bun.randomUUIDv7().slice(-12)}`;
}

/**
 * `id` as the exact {@link SESSION_ID_WIDTH} **bytes** a ledger line's
 * `session_id` field holds, or `undefined` when it cannot be represented in
 * them. JSON-escaped first: an id carrying a quote would otherwise end the
 * string, a newline would split one line into two, and a multibyte character
 * counts for more bytes than it does characters — the field is overwritten in
 * place, so its byte length is the contract, not its length in code units.
 */
function paddedSessionId(id: string): string | undefined {
	const escaped = JSON.stringify(id).slice(1, -1);
	const width = Buffer.byteLength(escaped, "utf8");
	return width > SESSION_ID_WIDTH ? undefined : escaped + " ".repeat(SESSION_ID_WIDTH - width);
}

/**
 * The event's JSON line, never longer than {@link MAX_LEDGER_LINE_BYTES}
 * including its newline. `session_id` is fixed-width, so only `dsn_path` is
 * trimmed: a truncated path still names which connection file failed, and a
 * line that is present is what an operator counts.
 */
export function ledgerLine(event: SessionStorageFallbackEvent): string {
	let trimmed = {
		...event,
		session_id: paddedSessionId(event.session_id) ?? UNRESOLVED_SESSION.padEnd(SESSION_ID_WIDTH, " "),
	};
	for (let i = 0; i < 64; i++) {
		const line = `${JSON.stringify(trimmed)}\n`;
		const overflow = Buffer.byteLength(line, "utf8") - MAX_LEDGER_LINE_BYTES;
		if (overflow <= 0) return line;
		// One ellipsis costs three bytes, so cut the overflow plus that.
		const kept = Math.max(0, trimmed.dsn_path.length - overflow - 3);
		if (kept === trimmed.dsn_path.length) break;
		trimmed = { ...trimmed, dsn_path: kept === 0 ? "…" : `${trimmed.dsn_path.slice(0, kept)}…` };
	}
	// The path is down to an ellipsis and the line is still too long: only a
	// pathological `reason` or `host` can do that, so report the event's shape.
	return `${JSON.stringify({ ...trimmed, dsn_path: "…", host: "…" })}\n`;
}

/**
 * A fallback whose real ledger line is already on disk, naming no session yet.
 *
 * The line is written at the moment the fallback is decided, because that is
 * the moment the "a fallback that cannot be recorded is not taken" invariant
 * depends on it, and only writing the real thing proves it: appending an empty
 * string proves the path opens, not that a line fits — a ledger at a size
 * limit passes that check and then fails the write it certified. `session_id`
 * is fixed-width padding, overwritten in place once the launch has opened its
 * session. If that refinement never happens, the count still exists, which is
 * what the ledger is for.
 */
interface PendingFallback {
	reason: SessionStorageFallbackReason;
	dsnPath: string;
	ledgerFile: string;
	/** The placeholder bytes the write expects to find at the offset, as a check before it writes. */
	placeholder: string;
	/**
	 * The exact line written, so the refinement can find it again. A byte
	 * offset recorded at write time is wrong the moment another process
	 * appends: `O_APPEND` places the write at whatever the end is then, not at
	 * the size read before it. Appends never move bytes already in the file,
	 * so locating the line when the refinement runs is stable.
	 */
	line: string;
}

let pending: PendingFallback | undefined;
let committed = false;

/**
 * The fallback this process decided, if any, so the launch can tell the user
 * at the terminal. Reading it does not touch the ledger.
 */
export function pendingSessionStorageFallback(): { reason: SessionStorageFallbackReason; dsnPath: string } | undefined {
	return pending ? { reason: pending.reason, dsnPath: pending.dsnPath } : undefined;
}

const SESSION_ID_MARKER = '"session_id":"';

/**
 * Whether the bytes at `offset` are still the placeholder this process wrote.
 * Locating the line is not enough on its own: a truncation in place leaves the
 * same open file, so the scan can succeed against a stale snapshot and the
 * write then lands past a shortened end, filling the gap with NULs. Checking
 * what is actually there immediately before writing is the only step that
 * covers replacement and truncation together.
 */
function placeholderStillThere(
	read: (buffer: Buffer, offset: number) => number,
	placeholder: string,
	offset: number,
): boolean {
	const expected = paddedSessionId(placeholder);
	if (expected === undefined) return false;
	const buffer = Buffer.allocUnsafe(SESSION_ID_WIDTH);
	return read(buffer, offset) === SESSION_ID_WIDTH && buffer.toString("utf8") === expected;
}

/** The whole of an open file, read through the descriptor rather than the path. */
function readAllSync(handle: number): Buffer {
	const size = fsSync.fstatSync(handle).size;
	const buffer = Buffer.allocUnsafe(size);
	let read = 0;
	while (read < size) {
		const n = fsSync.readSync(handle, buffer, read, size - read, read);
		if (n <= 0) break;
		read += n;
	}
	return read === size ? buffer : buffer.subarray(0, read);
}

/**
 * Byte offset of the `session_id` value in the ledger's copy of `line`, found
 * when the refinement runs rather than when the line was written. `O_APPEND`
 * decides a write's position at the kernel, so nothing can record it in
 * advance; appends never move bytes already in the file, so a scan now is
 * stable. The last match wins: an identical earlier line would be another
 * process's, and ours is the most recent.
 */
function locateSessionIdField(contents: Buffer, line: string): number | undefined {
	const needle = Buffer.from(line, "utf8");
	const at = contents.lastIndexOf(needle);
	if (at < 0) return undefined;
	const inLine = Buffer.byteLength(line.slice(0, line.indexOf(SESSION_ID_MARKER)), "utf8");
	return at + inLine + Buffer.byteLength(SESSION_ID_MARKER, "utf8");
}

/**
 * Name the session in the line already on disk: the one the launch **opened**.
 * When the launch later moves off that session file — another process holds
 * its ownership lease, so the first write continues into a fresh session — the
 * recorded id is the opened one, not the one that went on. That is a known
 * limit and deliberate: committing after the move would lose the line entirely
 * when a crash precedes the first write, and a missing line defeats the
 * mechanism where a stale id only makes one investigation harder.
 *
 * Does nothing when no fallback was decided, and never writes twice. A failure
 * is logged, not thrown: the count is already recorded.
 */
export function commitSessionStorageFallbackSync(sessionId: string): void {
	if (!pending || committed) return;
	committed = true;
	const padded = paddedSessionId(sessionId);
	if (padded === undefined) return;
	let handle: number | undefined;
	try {
		// One descriptor for both the scan and the write: a rotation between them
		// replaces the directory entry, not this open file, so the write still
		// lands in the bytes that were scanned instead of at a stale offset in
		// whatever now holds the name.
		handle = fsSync.openSync(pending.ledgerFile, "r+");
		const fd = handle;
		const offset = locateSessionIdField(readAllSync(fd), pending.line);
		if (offset === undefined) return;
		const stillThere = placeholderStillThere(
			(buffer, at) => fsSync.readSync(fd, buffer, 0, buffer.length, at),
			pending.placeholder,
			offset,
		);
		if (!stillThere) return;
		fsSync.writeSync(fd, Buffer.from(padded, "utf8"), 0, SESSION_ID_WIDTH, offset);
	} catch {
		// A signal handler has nowhere to report to; the line is already counted.
	} finally {
		if (handle !== undefined) {
			try {
				fsSync.closeSync(handle);
			} catch {}
		}
	}
}

export async function commitSessionStorageFallback(sessionId: string): Promise<void> {
	if (!pending || committed) return;
	const ledgerFile = pending.ledgerFile;
	const padded = paddedSessionId(sessionId);
	committed = true;
	if (padded === undefined) {
		logger.warn("Session id too long for the fallback ledger line; it keeps its placeholder", {
			ledger: ledgerFile,
			session: sessionId,
		});
		return;
	}
	const line = pending.line;
	const placeholder = pending.placeholder;
	let handle: fs.FileHandle | undefined;
	try {
		// One descriptor for both the scan and the write: see the sync twin.
		handle = await fs.open(ledgerFile, "r+");
		const open = handle;
		const offset = locateSessionIdField(await open.readFile(), line);
		const stillThere =
			offset !== undefined &&
			placeholderStillThere(
				(buffer, at) => fsSync.readSync(open.fd, buffer, 0, buffer.length, at),
				placeholder,
				offset,
			);
		if (offset === undefined || !stillThere) {
			logger.warn("The fallback's ledger line is no longer where it was written; it keeps its placeholder", {
				ledger: ledgerFile,
				session: sessionId,
			});
			return;
		}
		await open.write(Buffer.from(padded, "utf8"), 0, SESSION_ID_WIDTH, offset);
	} catch (err) {
		logger.warn("Could not name the session in the fallback ledger line; the fallback stays counted", {
			ledger: ledgerFile,
			session: sessionId,
			error: toError(err).message,
		});
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** A fallback that could not be recorded, so it is not taken. */
export class SessionStorageFallbackLedgerError extends Error {
	constructor(ledgerFile: string, cause: unknown) {
		super(
			`session.storage is sql and this resume would continue on file storage, but the fallback ` +
				`could not be recorded in ${ledgerFile}: ${toError(cause).message}`,
			{ cause },
		);
		this.name = "SessionStorageFallbackLedgerError";
	}
}

/**
 * Warn and write the fallback's ledger line, naming no session yet.
 *
 * A ledger that cannot take the line throws {@link SessionStorageFallbackLedgerError}
 * and the fallback does not happen. The count is the control: a fallback
 * nobody can count is the silent fleet degradation this exists to prevent, so
 * an unwritable ledger refuses the launch rather than quietly widening the
 * blast radius — and only writing the real line proves the ledger can take it.
 * {@link commitSessionStorageFallback} fills the session in afterwards.
 *
 * The warning carries which connection file failed and why, because "fell back
 * to file storage" alone tells an operator nothing about what to fix.
 */
export async function reserveSessionStorageFallback(
	reason: SessionStorageFallbackReason,
	dsnPath: string,
	ledgerFile: string,
): Promise<void> {
	const placeholder = unresolvedPlaceholder();
	const line = ledgerLine(fallbackEvent(placeholder, reason, dsnPath));
	let handle: fs.FileHandle | undefined;
	try {
		await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
		handle = await fs.open(ledgerFile, "a+");
		// O_APPEND: the write lands whole at the end whatever another process is
		// doing. Where that is cannot be known in advance, so nothing records a
		// position here; the refinement finds the line.
		const written = await handle.write(line, null, "utf8");
		if (written.bytesWritten !== Buffer.byteLength(line, "utf8")) {
			throw new Error(`short write: ${written.bytesWritten} of ${Buffer.byteLength(line, "utf8")} bytes`);
		}
		await handle.sync();
		pending = { reason, dsnPath, ledgerFile, line, placeholder };
	} catch (err) {
		throw new SessionStorageFallbackLedgerError(ledgerFile, err);
	} finally {
		await handle?.close().catch(() => undefined);
	}
	logger.warn(
		`session.storage is sql, but the session database is unusable (${reason}); ` +
			`continuing on file storage for this resumed session`,
		{ dsnPath, reason, ledger: ledgerFile },
	);
}

/** The event for a fallback happening now, on this host. */
export function fallbackEvent(
	sessionId: string,
	reason: SessionStorageFallbackReason,
	dsnPath: string,
): SessionStorageFallbackEvent {
	return { ts: new Date().toISOString(), session_id: sessionId, reason, dsn_path: dsnPath, host: os.hostname() };
}
