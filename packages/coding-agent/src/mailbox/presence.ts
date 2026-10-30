/**
 * Session presence: every process that has a session open says so, from the
 * moment it opens the session until it closes it or exits, so a sender can
 * tell "open somewhere" from "closed" without waiting for the
 * first write (the session ownership lease is only taken by writers).
 *
 * One file per (session, process): `<root>/presence/<session>.<pid>.<nonce>.json`,
 * guarded by an OS lock on its own path. The holder takes the lock before the
 * file appears under its final name and removes the file (and the lock
 * sidecar some platforms leave) before releasing the lock. A probe that
 * acquires the lock of a listed file therefore found a holder that died
 * without cleaning up, and removes the leftovers. Names are unique per
 * holder, so removing a dead holder's file can never split a live lease.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type FileLockHandle, isEnoent, logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { safeSessionKey } from "../session/session-storage";
import { presenceDir } from "./paths";

/** What a present process does with mail addressed to the session. */
export interface PresenceRecord {
	v: 1;
	sessionId: string;
	pid: number;
	/** This process is the session's mail consumer and may write the session now. */
	delivers: boolean;
	/** Its turns wait for a client's next prompt (an ACP client that keeps agent-initiated turns off). */
	deferred: boolean;
	/** Process kind, for messages: `interactive`, `rpc`, `print`, `acp`, `sdk`, … */
	host: string;
	since: string;
}

function lockSidecar(file: string): string {
	// Platforms that implement the lock with `flock(2)` lock `${path}.lock`.
	return `${file}.lock`;
}

function unlinkQuiet(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("presence cleanup failed", { file, error: String(err) });
	}
}

function writeAtomic(file: string, record: PresenceRecord): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record));
	fs.renameSync(tmp, file);
}

/** A held presence entry. */
export class SessionPresence {
	readonly sessionId: string;
	readonly #file: string;
	#lock: FileLockHandle | null;
	#record: PresenceRecord;

	constructor(sessionId: string, file: string, lock: FileLockHandle, record: PresenceRecord) {
		this.sessionId = sessionId;
		this.#file = file;
		this.#lock = lock;
		this.#record = record;
	}

	/** Rewrite the entry in place when what this process does with the mail changed. */
	update(change: Partial<Pick<PresenceRecord, "delivers" | "deferred">>): void {
		if (!this.#lock) return;
		const next = { ...this.#record, ...change };
		if (next.delivers === this.#record.delivers && next.deferred === this.#record.deferred) return;
		this.#record = next;
		writeAtomic(this.#file, next);
	}

	/** Withdraw: remove the entry and its lock sidecar, then release the lock. Idempotent. */
	release(): void {
		const lock = this.#lock;
		if (!lock) return;
		this.#lock = null;
		unlinkQuiet(this.#file);
		unlinkQuiet(lockSidecar(this.#file));
		lock.release();
	}
}

/** Announce that this process has `sessionId` open, until the returned entry is released. */
export function claimSessionPresence(
	sessionId: string,
	options: { host: string; delivers?: boolean },
): SessionPresence {
	const dir = presenceDir();
	const file = path.join(dir, `${safeSessionKey(sessionId)}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.json`);
	fs.mkdirSync(dir, { recursive: true });
	const lock = tryAcquireFileLock(file);
	if (!lock) throw new Error(`presence lock ${file} is unexpectedly held`);
	const record: PresenceRecord = {
		v: 1,
		sessionId,
		pid: process.pid,
		delivers: options.delivers ?? false,
		deferred: false,
		host: options.host,
		since: new Date().toISOString(),
	};
	try {
		writeAtomic(file, record);
	} catch (err) {
		lock.release();
		unlinkQuiet(lockSidecar(file));
		throw err;
	}
	return new SessionPresence(sessionId, file, lock, record);
}

/**
 * Live presence entries for `sessionId` (other processes and this one).
 * Entries left by processes that died are removed on the way.
 */
export function listSessionPresence(sessionId: string): PresenceRecord[] {
	const dir = presenceDir();
	const prefix = `${safeSessionKey(sessionId)}.`;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const live: PresenceRecord[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		const probe = tryAcquireFileLock(file);
		if (probe) {
			// Nobody holds it: the holder died without cleaning up.
			unlinkQuiet(file);
			unlinkQuiet(lockSidecar(file));
			probe.release();
			continue;
		}
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf8")) as PresenceRecord;
			if (record.sessionId === sessionId) live.push(record);
		} catch (err) {
			// Removed by its holder between the probe and the read.
			if (!isEnoent(err)) logger.debug("unreadable presence entry", { file, error: String(err) });
		}
	}
	return live;
}
