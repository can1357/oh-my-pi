/**
 * Cross-process session presence: one owner-only JSON file per published
 * top-level session under {@link getSessionPresenceDir}, so another omp
 * process can tell that a session file is live here (Telegram mirrors,
 * second-writer refusal, `/sessions`).
 *
 * Storage is deliberately dumb — a directory scan, no index, no locking — and
 * every writer failure is logged, never surfaced: presence is a hint, and the
 * owning process must never fail a session over it. Readers treat a record as
 * live only while its pid is alive AND its boot-stable start token still
 * matches (a recycled pid is a different process); stale files are pruned
 * best-effort.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionPresenceDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { processStartToken } from "../utils/process-start-token";

/**
 * Who publishes presence: the interactive TUI and the Telegram bridge (which
 * hosts topic sessions). Publishing is opt-in — a session created without a
 * kind writes nothing — so every kind here has a live publisher.
 */
export type SessionPresenceKind = "interactive" | "telegram";

/** One live session of one omp process, as readers see it. */
export interface SessionPresence {
	pid: number;
	kind: SessionPresenceKind;
	sessionId: string;
	/** Absolute path of the session JSONL. */
	sessionFile: string;
	cwd: string;
	sessionName: string | null;
	startedAt: number;
	updatedAt: number;
}

const SESSION_PRESENCE_VERSION = 1;
const PRESENCE_FILE_SUFFIX = ".json";
const PRESENCE_KINDS = {
	interactive: true,
	telegram: true,
} satisfies Record<SessionPresenceKind, true>;

interface SessionPresenceRecord extends SessionPresence {
	version: number;
	/** Boot-stable token of {@link SessionPresence.pid} at write time; null when the OS cannot report one. */
	startToken: string | null;
}

/** Identity a {@link SessionPresencePublisher} writes and rewrites. */
export interface SessionPresencePublication {
	kind: SessionPresenceKind;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	sessionName: string | null;
}

function presenceFileName(state: SessionPresencePublication): string {
	return `${process.pid}-${state.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}${PRESENCE_FILE_SUFFIX}`;
}

async function unlinkBestEffort(file: string): Promise<void> {
	try {
		await fs.unlink(file);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("session presence: prune failed", { file, error: String(err) });
	}
}

function parsePresenceRecord(raw: unknown): SessionPresenceRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	if (record.version !== SESSION_PRESENCE_VERSION) return null;
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return null;
	if (typeof record.kind !== "string" || PRESENCE_KINDS[record.kind as SessionPresenceKind] !== true) return null;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
	if (typeof record.sessionFile !== "string" || record.sessionFile.length === 0) return null;
	if (typeof record.cwd !== "string") return null;
	if (record.sessionName !== null && typeof record.sessionName !== "string") return null;
	if (typeof record.startedAt !== "number" || typeof record.updatedAt !== "number") return null;
	if (record.startToken !== null && typeof record.startToken !== "string") return null;
	return {
		version: SESSION_PRESENCE_VERSION,
		pid: record.pid,
		startToken: record.startToken,
		kind: record.kind as SessionPresenceKind,
		sessionId: record.sessionId,
		sessionFile: path.resolve(record.sessionFile),
		cwd: record.cwd,
		sessionName: record.sessionName,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
	};
}

async function isRecordLive(record: SessionPresenceRecord): Promise<boolean> {
	try {
		process.kill(record.pid, 0);
	} catch (err) {
		// `EPERM` still means the pid exists; only an explicit `ESRCH` is death.
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
	}
	if (record.startToken === null) return true;
	const current = await processStartToken(record.pid);
	return current === null || current === record.startToken;
}

async function readPresenceDir(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (err) {
		// A registry that was never written is empty; an unreadable one is an
		// error (callers must treat it as "liveness unknown", not "none live").
		if (isEnoent(err)) return [];
		throw err;
	}
}

/**
 * Every live session published by any omp process (filesystem order).
 *
 * Rejects when the directory exists but cannot be read; a missing directory is
 * an empty list. Stale records (dead pid, recycled pid, malformed file) are
 * pruned best-effort as they are encountered.
 */
export async function listLiveSessionPresence(options?: { dir?: string }): Promise<SessionPresence[]> {
	const dir = options?.dir ?? getSessionPresenceDir();
	const names = await readPresenceDir(dir);
	const live: SessionPresence[] = [];
	for (const name of names) {
		if (!name.endsWith(PRESENCE_FILE_SUFFIX) || name.startsWith(".")) continue;
		const file = path.join(dir, name);
		let raw: unknown;
		try {
			raw = await Bun.file(file).json();
		} catch {
			raw = null;
		}
		const record = parsePresenceRecord(raw);
		if (record === null || !(await isRecordLive(record))) {
			await unlinkBestEffort(file);
			continue;
		}
		live.push({
			pid: record.pid,
			kind: record.kind,
			sessionId: record.sessionId,
			sessionFile: record.sessionFile,
			cwd: record.cwd,
			sessionName: record.sessionName,
			startedAt: record.startedAt,
			updatedAt: record.updatedAt,
		});
	}
	return live;
}

/**
 * The live session holding `sessionFile`, if any (excluding `exceptPid`, which
 * the caller passes as its own pid to ask "is someone else writing this?").
 * Rejects exactly like {@link listLiveSessionPresence}.
 */
export async function findSessionHolder(
	sessionFile: string,
	options?: { exceptPid?: number; dir?: string },
): Promise<SessionPresence | null> {
	const target = path.resolve(sessionFile);
	const exceptPid = options?.exceptPid;
	const live = await listLiveSessionPresence(options);
	return live.find(entry => entry.sessionFile === target && entry.pid !== exceptPid) ?? null;
}

/**
 * Publishes one process's current session to the presence registry.
 *
 * Every mutation is queued and fire-and-forget: session creation never waits
 * on presence I/O, and a failure is logged, not thrown. `update` rewrites the
 * record (and moves the file when the session id changes, e.g. after a
 * switch); `remove` deletes it.
 */
export class SessionPresencePublisher {
	#dir: string;
	#file: string;
	#state: SessionPresencePublication;
	#startedAt: number;
	#queue: Promise<void> = Promise.resolve();
	#removed = false;
	#dirReady: Promise<void> | undefined;
	#startToken: Promise<string | null> | undefined;

	constructor(state: SessionPresencePublication, options?: { dir?: string }) {
		this.#dir = options?.dir ?? getSessionPresenceDir();
		this.#state = { ...state, sessionFile: path.resolve(state.sessionFile) };
		this.#file = this.#resolveFile();
		this.#startedAt = Date.now();
	}

	/** Absolute path of the record currently published. */
	get file(): string {
		return this.#file;
	}

	/** Publish (or refresh) the current identity; queued, never awaited. */
	publish(): void {
		this.#enqueue(async () => {
			await this.#writeRecord(this.#file);
		});
	}

	/** Change one or more identity fields; the record file moves if the id does. */
	update(patch: Partial<SessionPresencePublication>): void {
		const previousFile = this.#file;
		this.#state = {
			...this.#state,
			...patch,
			sessionFile: path.resolve(patch.sessionFile ?? this.#state.sessionFile),
		};
		this.#file = this.#resolveFile();
		this.#enqueue(async () => {
			if (previousFile !== this.#file) await unlinkBestEffort(previousFile);
			await this.#writeRecord(this.#file);
		});
	}

	/** Stop publishing (deletes the record; later writes are ignored). */
	remove(): void {
		this.#removed = true;
		const file = this.#file;
		this.#enqueue(() => unlinkBestEffort(file));
	}

	/** Resolves once every queued mutation has settled (tests, teardown). */
	settled(): Promise<void> {
		return this.#queue;
	}

	#resolveFile(): string {
		return path.join(this.#dir, presenceFileName(this.#state));
	}

	#enqueue(operation: () => Promise<void>): void {
		this.#queue = this.#queue.then(operation).catch(err => {
			logger.warn("session presence write failed", { file: this.#file, error: String(err) });
		});
	}

	#ensureDir(): Promise<void> {
		this.#dirReady ??= (async () => {
			await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
			// `mkdir` honors the umask; presence files name live sessions, so keep
			// the directory owner-only regardless.
			await fs.chmod(this.#dir, 0o700);
		})().catch(err => {
			this.#dirReady = undefined;
			throw err;
		});
		return this.#dirReady;
	}

	#processStartToken(): Promise<string | null> {
		return (this.#startToken ??= processStartToken(process.pid).catch(err => {
			this.#startToken = undefined;
			throw err;
		}));
	}

	async #writeRecord(file: string): Promise<void> {
		if (this.#removed) return;
		await this.#ensureDir();
		const record: SessionPresenceRecord = {
			version: SESSION_PRESENCE_VERSION,
			pid: process.pid,
			startToken: await this.#processStartToken(),
			kind: this.#state.kind,
			sessionId: this.#state.sessionId,
			sessionFile: this.#state.sessionFile,
			cwd: this.#state.cwd,
			sessionName: this.#state.sessionName,
			startedAt: this.#startedAt,
			updatedAt: Date.now(),
		};
		// Write-then-rename keeps readers from ever parsing a torn record. The
		// temp file is created owner-only, not tightened afterwards, so a reader
		// can never observe the record with looser permissions.
		const temp = `${file}.${crypto.randomUUID()}.tmp`;
		await Bun.write(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		await fs.rename(temp, file);
	}
}
