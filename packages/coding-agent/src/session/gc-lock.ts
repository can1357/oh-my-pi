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
import * as path from "node:path";
import * as fs from "./gc-fs";
import { sleep } from "./gc-fs";
import {
	type HeldFile,
	newNonce,
	NotARegularFile,
	openRegularFile,
	removeFileNoOneElseWrites,
	unlinkFileNoOneElseWrites,
	writeExclusive,
} from "./regular-file";

const GC_LOCK_BREAKER_SUFFIX = ".break";
const GC_LOCK_STALE_MS = 5 * 60_000;

export function codeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	let gone = reading.kind === "empty" && Date.now() - found.mtimeMs > GC_LOCK_STALE_MS;
	if (reading.kind !== "empty") {
		try {
			process.kill(reading.pid, 0);
		} catch (error) {
			if (codeOf(error) !== "ESRCH") throw error;
			gone = true;
		}
	}
	if (reading.kind === "empty" && !gone) {
		throw new Error(
			`${lockPath} is empty and still within the write grace, so whether a gc run holds it is not known; nothing was done`,
		);
	}
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

/**
 * What became of a lock found at a name this run could not create: still
 * held by a live run; gone — removed here, or already gone, or replaced, so
 * taking it again is the next step; or left, because removing it failed,
 * with why. A removal that fails is not a running gc: a review failed one
 * lookup with `EIO`, or made the lock's directory read-only, and every
 * command said "GC already running" with its holder dead.
 */
type StaleLock = { kind: "held" } | { kind: "gone" } | { kind: "left"; why: string };

/** Remove a lock whose holder is gone, when it holds exactly what gc writes — see {@link judgeLock}. */
async function removeStaleGcLock(lockPath: string): Promise<StaleLock> {
	const found = await readHeldLock(lockPath);
	if (!found) return { kind: "gone" };
	try {
		// A lock gc would not break throws here, naming it, as before.
		if (judgeLock(lockPath, found) === "held") return { kind: "held" };
		// Removed only while it is still the very file read above — the
		// descriptor is held, and the bytes must match. Another file at the
		// name is a lock taken since, which the next attempt judges.
		try {
			if ((await unlinkFileNoOneElseWrites(lockPath, [found.held])) === "kept") {
				return {
					kind: "left",
					why: `what stands at ${lockPath} is not the regular lock file and bytes this run read, so it was left as it is`,
				};
			}
		} catch (error) {
			return { kind: "left", why: errorText(error) };
		}
		return { kind: "gone" };
	} finally {
		await found.held.handle.close().catch(() => undefined);
	}
}

/** The refusal for a lock whose holder is gone and that could not be removed. */
function staleLockLeft(lockPath: string, why: string): Error {
	return new Error(
		`${lockPath} was left by a gc run that is no longer running, and it could not be removed (${why}), so ` +
			`nothing was done; remove it once it can be, or fix what stops it, and run gc again`,
	);
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
 * and only while it holds the bytes this run wrote. Returns undefined once
 * nothing of this run's is left at the name, or why it is still there: a
 * lock left behind holds this run's pid, and while this process lives every
 * later run reads it as held, so the caller reports it.
 */
async function releaseGcLockFile(lockPath: string, held: HeldFile): Promise<string | undefined> {
	const note = await removeFileNoOneElseWrites(lockPath, [held], "the lock this run took");
	await held.handle.close().catch(() => undefined);
	return note;
}

/** Another live process holds the lock: the one failure that waiting can end. */
export class GcLockHeld extends Error {
	constructor(lockPath: string) {
		super(`GC already running: ${lockPath}`);
	}
}

async function openGcBreakerLock(lockPath: string): Promise<{ path: string; held: HeldFile }> {
	const breakerPath = `${lockPath}${GC_LOCK_BREAKER_SUFFIX}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const held = await openNewGcLock(breakerPath);
		if (held) return { path: breakerPath, held };
		const stale = await removeStaleGcLock(breakerPath);
		if (stale.kind === "held") throw new GcLockHeld(lockPath);
		if (stale.kind === "left") throw staleLockLeft(breakerPath, stale.why);
	}
	throw new Error(`${breakerPath} could not be acquired after its name was taken repeatedly; nothing was done`);
}

/** The lock, taken, and what this run could not remove of the breaker lock it took to take it. */
interface TakenGcLock {
	held: HeldFile;
	notes: string[];
}

async function openGcLock(lockPath: string): Promise<TakenGcLock> {
	const direct = await openNewGcLock(lockPath);
	if (direct) return { held: direct, notes: [] };

	const breaker = await openGcBreakerLock(lockPath);
	let taken: HeldFile | undefined;
	let breakerNote: string | undefined;
	let outcome: TakenGcLock | { error: unknown };
	try {
		taken = (await openNewGcLock(lockPath)) ?? undefined;
		if (!taken) {
			const stale = await removeStaleGcLock(lockPath);
			if (stale.kind === "held") throw new GcLockHeld(lockPath);
			if (stale.kind === "left") throw staleLockLeft(lockPath, stale.why);
			taken = (await openNewGcLock(lockPath)) ?? undefined;
			if (!taken)
				throw new Error(`${lockPath} could not be acquired after its name was taken again; nothing was done`);
		}
		outcome = { held: taken, notes: [] };
	} catch (error) {
		outcome = { error };
	} finally {
		// The breaker is this run's own; while this process lives, a breaker
		// left behind reads as held, so a failure to remove it is reported.
		breakerNote = await releaseGcLockFile(breaker.path, breaker.held);
	}
	if ("error" in outcome) {
		throw breakerNote
			? new Error(`${errorText(outcome.error)}; ${breakerNote}`, { cause: outcome.error })
			: outcome.error;
	}
	if (breakerNote) outcome.notes.push(breakerNote);
	return outcome;
}

/**
 * Take the lock, retrying for up to `waitMs` while another process holds it.
 * A caller who did not ask for maintenance — someone resuming a session that
 * has to come out of the archive — queues instead of failing, since the
 * phases it waits behind take milliseconds per session. Only a lock another
 * live process holds is waited for: anything else that stops the lock being
 * taken — a file at its name gc did not write, a FIFO, a lock left by a run
 * no longer running that cannot be removed, an error — waiting cannot
 * change, so it is reported at once.
 */
async function openGcLockWaiting(lockPath: string, waitMs: number): Promise<TakenGcLock> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			return await openGcLock(lockPath);
		} catch (error) {
			if (!(error instanceof GcLockHeld) || Date.now() >= deadline) throw error;
			await sleep(50);
		}
	}
}

/**
 * Run `fn` holding `<agentDir>/gc.lock`, releasing it however `fn` ends.
 * What this run could not remove of its own locks — the lock, or the breaker
 * lock it took to break a stale one — goes to `onReleaseFailure`: left
 * behind, a lock names this process, and every later run while it lives
 * reads it as held, so the command has to say so. A review saw a completed
 * archive report no errors and leave its lock, and the next command refused
 * with "GC already running".
 */
export async function withGcLock<T>(
	agentDir: string,
	fn: (lockPath: string) => Promise<T>,
	options: { waitMs?: number; onReleaseFailure?: (note: string) => void } = {},
): Promise<T> {
	const lockPath = path.join(agentDir, "gc.lock");
	await fs.mkdir(agentDir, { recursive: true });
	const { held, notes } = await openGcLockWaiting(lockPath, options.waitMs ?? 0);
	let outcome: { value: T } | { error: unknown };
	let note: string | undefined;
	try {
		outcome = { value: await fn(lockPath) };
	} catch (error) {
		outcome = { error };
	} finally {
		// A lock broken as stale while this ran has a new owner, and removing
		// it would hand a third caller the lock while that owner is inside:
		// only this run's own lock goes — see {@link releaseGcLockFile}.
		note = await releaseGcLockFile(lockPath, held);
	}
	const left = [...notes, ...(note ? [note] : [])];
	if ("error" in outcome) {
		throw left.length > 0
			? new Error(`${errorText(outcome.error)}; ${left.join("; ")}`, { cause: outcome.error })
			: outcome.error;
	}
	if (options.onReleaseFailure) {
		for (const entry of left) options.onReleaseFailure(entry);
	} else if (left.length > 0) {
		throw new Error(left.join("; "));
	}
	return outcome.value;
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
