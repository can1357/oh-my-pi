/**
 * The agent directory's maintenance lock (`<agentDir>/gc.lock`).
 *
 * `omp gc` holds it for a whole run, and anything else that moves a session
 * between the sessions tree and the archive takes it too — a resume that
 * restores an archived session must not land in the middle of the archive
 * phase, which moves the transcript and its artifact tree in two steps.
 *
 * The lock is an exclusively created file holding the owner's pid and start
 * time. A lock whose pid is gone, or whose start time is older than the write
 * grace, is broken under a sidecar `.break` lock so two cleaners cannot break
 * it at once.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const GC_LOCK_BREAKER_SUFFIX = ".break";
const GC_LOCK_STALE_MS = 5 * 60_000;

interface GcLockSnapshot {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	text: string;
}

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

function gcLockPid(lockText: string): number | undefined {
	const pid = Number.parseInt(lockText.split(/\r?\n/, 1)[0] ?? "", 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = codeOf(error);
		if (code === "ESRCH" || code === "EINVAL") return false;
		return true;
	}
}

function gcLockStatSnapshot(stat: {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}): Omit<GcLockSnapshot, "text"> {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
	};
}

function sameGcLockStat(left: Omit<GcLockSnapshot, "text">, right: Omit<GcLockSnapshot, "text">): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

async function readGcLockSnapshot(lockPath: string): Promise<GcLockSnapshot | null> {
	const stat = await statIfPresent(lockPath);
	if (!stat) return null;

	let lockText = "";
	try {
		lockText = await Bun.file(lockPath).text();
	} catch (error) {
		if (codeOf(error) === "ENOENT") return null;
		throw error;
	}

	const afterStat = await statIfPresent(lockPath);
	if (!afterStat) return null;
	const before = gcLockStatSnapshot(stat);
	const after = gcLockStatSnapshot(afterStat);
	if (!sameGcLockStat(before, after)) return null;
	return { ...after, text: lockText };
}

async function gcLockSnapshotStillCurrent(lockPath: string, snapshot: GcLockSnapshot): Promise<boolean> {
	const stat = await statIfPresent(lockPath);
	return stat ? sameGcLockStat(snapshot, gcLockStatSnapshot(stat)) : false;
}

/**
 * Break a lock only when its owner is gone. A live pid is never overridden on
 * age: a long run is still a run, and a clock step or a suspended laptop
 * would otherwise let a second process into the middle of a session move.
 * A lock whose pid was reused by an unrelated process therefore blocks until
 * someone removes the file, which is what the waiter's message says to do.
 */
function shouldBreakGcLock(snapshot: GcLockSnapshot): boolean {
	const pid = gcLockPid(snapshot.text);
	if (pid) return !processExists(pid);
	const createdAtMs = Date.parse(snapshot.text.split(/\r?\n/, 2)[1] ?? "");
	const ageFromMs = Number.isFinite(createdAtMs) ? createdAtMs : snapshot.mtimeMs;
	return Date.now() - ageFromMs > GC_LOCK_STALE_MS;
}

async function removeStaleGcLock(lockPath: string): Promise<boolean> {
	const snapshot = await readGcLockSnapshot(lockPath);
	if (!snapshot) return false;
	if (!shouldBreakGcLock(snapshot)) return false;
	if (!(await gcLockSnapshotStillCurrent(lockPath, snapshot))) return false;
	try {
		await fs.unlink(lockPath);
		return true;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return false;
		throw error;
	}
}

async function openNewGcLock(lockPath: string): Promise<fs.FileHandle | null> {
	try {
		return await fs.open(lockPath, "wx");
	} catch (error) {
		if (codeOf(error) === "EEXIST") return null;
		throw error;
	}
}

async function releaseGcLockFile(lockPath: string, handle: fs.FileHandle): Promise<void> {
	try {
		await handle.close();
	} catch {
		// Best effort: stale sidecar locks are recoverable by PID/timestamp.
	}
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return;
	}
}

async function openGcBreakerLock(lockPath: string): Promise<{ path: string; handle: fs.FileHandle }> {
	const breakerPath = `${lockPath}${GC_LOCK_BREAKER_SUFFIX}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const handle = await openNewGcLock(breakerPath);
		if (handle) {
			try {
				await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
				return { path: breakerPath, handle };
			} catch (error) {
				await releaseGcLockFile(breakerPath, handle);
				throw error;
			}
		}
		if (!(await removeStaleGcLock(breakerPath))) throw new Error(`GC already running: ${lockPath}`);
	}
	throw new Error(`GC already running: ${lockPath}`);
}

async function openGcLock(lockPath: string): Promise<fs.FileHandle> {
	const direct = await openNewGcLock(lockPath);
	if (direct) return direct;

	const breaker = await openGcBreakerLock(lockPath);
	try {
		const raced = await openNewGcLock(lockPath);
		if (raced) return raced;
		if (!(await removeStaleGcLock(lockPath))) throw new Error(`GC already running: ${lockPath}`);
		const takeover = await openNewGcLock(lockPath);
		if (takeover) return takeover;
		throw new Error(`GC already running: ${lockPath}`);
	} finally {
		await releaseGcLockFile(breaker.path, breaker.handle);
	}
}

/**
 * Take the lock, retrying for up to `waitMs` while another process holds it.
 * A caller who did not ask for maintenance — someone resuming a session that
 * has to come out of the archive — queues instead of failing, since the
 * phases it waits behind take milliseconds per session.
 */
async function openGcLockWaiting(lockPath: string, waitMs: number): Promise<fs.FileHandle> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			return await openGcLock(lockPath);
		} catch (error) {
			if (Date.now() >= deadline) throw error;
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
	const handle = await openGcLockWaiting(lockPath, options.waitMs ?? 0);
	let result: T | undefined;
	let runError: unknown;
	try {
		await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
		result = await fn(lockPath);
	} catch (error) {
		runError = error;
	}
	// Identify the file we hold before closing: a lock broken as stale while we
	// ran has a new owner, and unlinking the path would hand a third caller
	// the lock while that owner is still inside.
	const ours = await handle.stat().catch(() => undefined);
	let closeError: unknown;
	try {
		await handle.close();
	} catch (error) {
		closeError = error;
	}
	let unlinkError: unknown;
	try {
		const onDisk = await statIfPresent(lockPath);
		if (onDisk && ours && onDisk.dev === ours.dev && onDisk.ino === ours.ino) await fs.unlink(lockPath);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") unlinkError = error;
	}
	if (runError) throw runError;
	if (closeError) throw closeError;
	if (unlinkError) throw unlinkError;
	return result as T;
}
