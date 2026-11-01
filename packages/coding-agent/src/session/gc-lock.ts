/**
 * The agent directory's maintenance lock (`<agentDir>/gc.lock`).
 *
 * `omp gc --apply` holds it for a whole run, and anything else that moves a
 * session between the sessions tree and the archive takes it too — a resume
 * that restores an archived session must not land in the middle of the
 * archive phase, which moves the transcript and its artifact tree in two
 * steps. A preview takes nothing: it reads the lock and answers as taking it
 * would — see {@link withoutGcLock}.
 *
 * The lock is an exclusively created file holding the owner's pid, its start
 * time and 32 random bytes the owner generated, one per line, each parsed
 * strictly. A lock whose pid is gone is broken under a sidecar `.break`
 * lock, which carries the same, so two cleaners cannot break it at once.
 *
 * A file at `gc.lock` is removed only when it holds exactly what gc writes,
 * and only the very file read. A name is not proof, and neither is a loose
 * shape: a user's file with a number on its first line is not a lock, and a
 * file without the random value — what earlier versions of gc wrote —
 * cannot be told from one. Neither is ever removed: once it stands in the
 * way, the command stops and names it, to be moved aside. A lock with the
 * value is removed only through the descriptor it was read through, held
 * until it is gone, and only while it holds the bytes read — see
 * {@link removeFileNoOneElseWrites} — so a run releasing its own lock removes only a
 * file that carries the value it wrote. An empty one, which a run killed
 * between creating the lock and writing it leaves, holds nothing to lose
 * and is broken once it is older than the grace.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPidAlive } from "@oh-my-pi/pi-utils/pid";
import {
	type HeldFile,
	newNonce,
	NotARegularFile,
	openRegularFile,
	removeFileNoOneElseWrites,
	writeExclusive,
} from "./regular-file";

const GC_LOCK_BREAKER_SUFFIX = ".break";
const GC_LOCK_STALE_MS = 5 * 60_000;

export function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

export async function statIfPresent(target: string) {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** What this run writes into a lock it takes: pid, start time, and a random value no other writer has seen. */
function lockText(): string {
	return `${process.pid}\n${new Date().toISOString()}\n${newNonce()}\n`;
}

/** A start time the way gc writes one, and only that: a parse that accepts anything is not a parse. */
const ISO_INSTANT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const GC_LOCK = new RegExp(String.raw`^(\d+)\n(${ISO_INSTANT})\n[0-9a-f]{64}\n$`);
const EARLIER_LOCK = new RegExp(String.raw`^(\d+)\r?\n(${ISO_INSTANT})\r?\n$`);

/** What a file at a lock's name is, read through gc's eyes. */
type LockReading =
	| { kind: "empty" }
	| { kind: "gc"; pid: number }
	| { kind: "earlier"; pid: number }
	| { kind: "foreign" };

function readLockText(text: string): LockReading {
	if (text === "") return { kind: "empty" };
	const valid = (pid: string, at: string): boolean =>
		Number.isSafeInteger(Number(pid)) && Number(pid) > 0 && Number.isFinite(Date.parse(at));
	const ours = GC_LOCK.exec(text);
	if (ours && valid(ours[1], ours[2])) return { kind: "gc", pid: Number(ours[1]) };
	const earlier = EARLIER_LOCK.exec(text);
	if (earlier && valid(earlier[1], earlier[2])) return { kind: "earlier", pid: Number(earlier[1]) };
	return { kind: "foreign" };
}

/**
 * What the lock at `lockPath` holds, held: read through a descriptor checked
 * to hold a regular file, and that descriptor kept open, so the caller can
 * remove exactly that file by it — see {@link removeFileNoOneElseWrites}. Null when
 * nothing is there. A FIFO, socket or device at the name — itself or through
 * a link — is not read: reading a FIFO waits for a writer, or takes what was
 * written to it for somebody else. It is refused instead, and the run with
 * it, since whether another gc run holds the lock cannot then be told.
 */
async function readHeldLock(lockPath: string): Promise<{ text: string; mtimeMs: number; held: HeldFile } | null> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFile(lockPath);
	} catch (error) {
		if (error instanceof NotARegularFile) {
			throw new Error(
				`${error.message}. Whether another gc run holds the lock cannot be told from it, so nothing was done; ` +
					`move ${lockPath} aside and run gc again`,
				{ cause: error },
			);
		}
		throw error;
	}
	if (!handle) return null;
	try {
		const stat = await handle.stat();
		const bytes = await handle.readFile();
		return {
			text: bytes.toString("utf8"),
			mtimeMs: stat.mtimeMs,
			held: { handle, dev: stat.dev, ino: stat.ino, bytes },
		};
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

/**
 * What the lock read at `lockPath` means for a run that wants the lock: a
 * holder still there, or one that is gone, whose lock gc breaks. A live pid
 * is never overridden on age: a long run is still a run, and a clock step or
 * a suspended laptop would otherwise let a second process into the middle of
 * a session move. A lock whose pid was reused by an unrelated process
 * therefore blocks until someone removes the file, which is what the
 * waiter's message says to do. Anything else at the name gc never breaks:
 * once it stands in the way, this throws, naming it.
 */
function judgeLock(lockPath: string, found: { text: string; mtimeMs: number }): "held" | "stale" {
	const reading = readLockText(found.text);
	if (reading.kind === "foreign") {
		throw new Error(
			`${lockPath} holds something gc does not write, so it was not taken for a gc lock left by a run that is ` +
				`gone, and nothing was done; look at it and move it aside, then run gc again`,
		);
	}
	const gone = reading.kind === "empty" ? Date.now() - found.mtimeMs > GC_LOCK_STALE_MS : !isPidAlive(reading.pid);
	if (!gone) return "held";
	if (reading.kind === "earlier") {
		throw new Error(
			`${lockPath} looks like a lock an earlier version of gc took, and the process it names is gone, but it ` +
				`carries no random value, so it cannot be told from a file somebody else wrote; it was not removed and ` +
				`nothing was done; look at it, move it aside, then run gc again`,
		);
	}
	return "stale";
}

/** Remove a lock whose holder is gone, when it holds exactly what gc writes — see {@link judgeLock}. */
async function removeStaleGcLock(lockPath: string): Promise<boolean> {
	const found = await readHeldLock(lockPath);
	if (!found) return false;
	try {
		if (judgeLock(lockPath, found) === "held") return false;
		// Removed only while it is still the very file read above — the
		// descriptor is held, and the bytes must match.
		return (await removeFileNoOneElseWrites(lockPath, [found.held], "the stale lock this run read")) === undefined;
	} finally {
		await found.held.handle.close().catch(() => undefined);
	}
}

/** What stands at `lockPath`, read and judged as {@link removeStaleGcLock} judges it, and nothing removed. */
async function lookAtGcLock(lockPath: string): Promise<"none" | "held" | "stale"> {
	const found = await readHeldLock(lockPath);
	if (!found) return "none";
	try {
		return judgeLock(lockPath, found);
	} finally {
		await found.held.handle.close().catch(() => undefined);
	}
}

/** Take a lock file afresh, with this run's random value in it, held; null when the name is taken. */
async function openNewGcLock(lockPath: string): Promise<HeldFile | null> {
	try {
		return await writeExclusive(lockPath, lockText(), 0o666);
	} catch (error) {
		if (codeOf(error) === "EEXIST") return null;
		throw error;
	}
}

/**
 * Remove a lock this run took and close it — removed while its descriptor is
 * still held, so no file put at the name since can carry its inode number,
 * and only while it holds the bytes this run wrote. Best effort: a lock left
 * behind holds what gc writes and this run's pid, so the next run can break it.
 */
async function releaseGcLockFile(lockPath: string, held: HeldFile): Promise<void> {
	await removeFileNoOneElseWrites(lockPath, [held], "the lock this run took");
	await held.handle.close().catch(() => undefined);
}

/** Another live process holds the lock: the one failure that waiting can end. */
class GcLockHeld extends Error {
	constructor(lockPath: string) {
		super(`GC already running: ${lockPath}`);
	}
}

async function openGcBreakerLock(lockPath: string): Promise<{ path: string; held: HeldFile }> {
	const breakerPath = `${lockPath}${GC_LOCK_BREAKER_SUFFIX}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const held = await openNewGcLock(breakerPath);
		if (held) return { path: breakerPath, held };
		if (!(await removeStaleGcLock(breakerPath))) throw new GcLockHeld(lockPath);
	}
	throw new GcLockHeld(lockPath);
}

async function openGcLock(lockPath: string): Promise<HeldFile> {
	const direct = await openNewGcLock(lockPath);
	if (direct) return direct;

	const breaker = await openGcBreakerLock(lockPath);
	try {
		const raced = await openNewGcLock(lockPath);
		if (raced) return raced;
		if (!(await removeStaleGcLock(lockPath))) throw new GcLockHeld(lockPath);
		const takeover = await openNewGcLock(lockPath);
		if (takeover) return takeover;
		throw new GcLockHeld(lockPath);
	} finally {
		await releaseGcLockFile(breaker.path, breaker.held);
	}
}

/**
 * Take the lock, retrying for up to `waitMs` while another process holds it.
 * A caller who did not ask for maintenance — someone resuming a session that
 * has to come out of the archive — queues instead of failing, since the
 * phases it waits behind take milliseconds per session. Only a lock another
 * live process holds is waited for: anything else that stops the lock being
 * taken — a file at its name gc did not write, a FIFO, an error — waiting
 * cannot change, so it is reported at once.
 */
async function openGcLockWaiting(lockPath: string, waitMs: number): Promise<HeldFile> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			return await openGcLock(lockPath);
		} catch (error) {
			if (!(error instanceof GcLockHeld) || Date.now() >= deadline) throw error;
			await Bun.sleep(50);
		}
	}
}

/** Run `fn` holding `<agentDir>/gc.lock`, releasing it however `fn` ends. */
export async function withGcLock<T>(
	agentDir: string,
	fn: (lockPath: string) => Promise<T>,
	options: { waitMs?: number } = {},
): Promise<T> {
	const lockPath = path.join(agentDir, "gc.lock");
	await fs.mkdir(agentDir, { recursive: true });
	const held = await openGcLockWaiting(lockPath, options.waitMs ?? 0);
	try {
		return await fn(lockPath);
	} finally {
		// A lock broken as stale while this ran has a new owner, and removing
		// it would hand a third caller the lock while that owner is inside:
		// only this run's own lock goes — see {@link releaseGcLockFile}.
		await releaseGcLockFile(lockPath, held);
	}
}

/**
 * Run `fn` the way a preview must: holding no lock, and having written
 * nothing to find out whether it could take one. Taking the lock creates
 * `gc.lock` and removes it again — and breaks a stale one — and a preview
 * writes, links, unlinks and renames nothing. So the lock is read, the way
 * a run that cannot create it reads it, and the same answer comes back:
 * "GC already running" while a live process holds it or the breaker lock,
 * and the same refusal, naming the file, for anything gc would not break.
 * A lock whose holder is gone is one applying would break; the preview goes
 * on and breaks nothing.
 *
 * Holding no lock, a preview can be reading while a gc run that started
 * after this look moves a session; what it reports may then be out of date.
 * Nothing is written either way.
 */
export async function withoutGcLock<T>(agentDir: string, fn: (lockPath: string) => Promise<T>): Promise<T> {
	const lockPath = path.join(agentDir, "gc.lock");
	const found = await readHeldLock(lockPath);
	if (found) {
		try {
			// In the order applying meets them: the breaker lock first, which
			// it takes before it judges a lock it could not create.
			if ((await lookAtGcLock(`${lockPath}${GC_LOCK_BREAKER_SUFFIX}`)) === "held") throw new GcLockHeld(lockPath);
			if (judgeLock(lockPath, found) === "held") throw new GcLockHeld(lockPath);
		} finally {
			await found.held.handle.close().catch(() => undefined);
		}
	}
	return await fn(lockPath);
}
