import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { getAgentDir, toError } from "@pk-nerdsaver-ai/pi-utils";

const LOCK_SCHEMA = `
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS writer_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  guard_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
`;

export interface SessionWriterGuardHandle {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly guardId: string;
	readonly released: boolean;
	release(): Promise<void>;
	releaseSync(): void;
}

export interface AcquireSessionWriterGuardOptions {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly lockRoot?: string;
	readonly busyTimeoutMs?: number;
}

export class SessionAlreadyOwnedError extends Error {
	readonly sessionId: string;
	readonly transcriptPath: string;

	constructor(sessionId: string, transcriptPath: string, cause?: unknown) {
		super(`Session ${sessionId} already has a writable owner`, cause === undefined ? undefined : { cause });
		this.name = "SessionAlreadyOwnedError";
		this.sessionId = sessionId;
		this.transcriptPath = transcriptPath;
	}
}

function validateIdentity(value: string, label: string): void {
	if (value.length === 0 || value.length > 4_096 || value.includes("\0")) throw new Error(`${label} is invalid`);
}

function lockName(sessionId: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(sessionId);
	return `${hasher.digest("hex")}.db`;
}

class SqliteSessionWriterGuard implements SessionWriterGuardHandle {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly guardId: string;
	#db: Database | undefined;

	constructor(db: Database, sessionId: string, transcriptPath: string, guardId: string) {
		this.#db = db;
		this.sessionId = sessionId;
		this.transcriptPath = transcriptPath;
		this.guardId = guardId;
	}

	get released(): boolean {
		return this.#db === undefined;
	}

	async release(): Promise<void> {
		this.releaseSync();
	}

	releaseSync(): void {
		const db = this.#db;
		if (!db) return;
		this.#db = undefined;
		try {
			db.run("ROLLBACK");
		} finally {
			db.close();
		}
	}
}

/**
 * Cross-process exclusion for one writable transcript lifetime.
 *
 * Each session uses a dedicated rollback-journal SQLite database. The returned
 * handle owns a BEGIN IMMEDIATE transaction until release, so process death is
 * fenced by the operating system rather than by a renewable WAL lease.
 */
export class SessionWriterGuard {
	static acquire(options: AcquireSessionWriterGuardOptions): SessionWriterGuardHandle {
		validateIdentity(options.sessionId, "sessionId");
		validateIdentity(options.transcriptPath, "transcriptPath");
		const transcriptPath = path.resolve(options.transcriptPath);
		const lockRoot = path.resolve(options.lockRoot ?? path.join(getAgentDir(), "session-locks"));
		fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
		const dbPath = path.join(lockRoot, lockName(options.sessionId));
		const db = new Database(dbPath, { create: true, strict: true });
		const guardId = Bun.randomUUIDv7();
		try {
			db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.min(options.busyTimeoutMs ?? 0, 60_000))}`);
			db.exec(LOCK_SCHEMA);
			db.run("BEGIN IMMEDIATE");
			db.run("DELETE FROM writer_guard");
			db.query(
				"INSERT INTO writer_guard(singleton, session_id, transcript_path, guard_id, acquired_at) VALUES (1, ?, ?, ?, ?)",
			).run(options.sessionId, transcriptPath, guardId, Date.now());
			return new SqliteSessionWriterGuard(db, options.sessionId, transcriptPath, guardId);
		} catch (error) {
			try {
				db.close();
			} catch {
				// Preserve the lock acquisition error.
			}
			const cause = toError(error);
			if (cause.message.includes("locked") || cause.message.includes("busy")) {
				throw new SessionAlreadyOwnedError(options.sessionId, transcriptPath, cause);
			}
			throw cause;
		}
	}
}

export function isLiveSessionWriterGuard(
	guard: SessionWriterGuardHandle | undefined,
	sessionId: string,
): guard is SessionWriterGuardHandle {
	return guard !== undefined && !guard.released && guard.sessionId === sessionId;
}
