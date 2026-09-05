/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function tryAcquireLock(lockPath: string): NativeFileLock | null {
	const lock = NativeFileLock.tryAcquire(lockPath);
	return lock.acquired ? lock : null;
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<NativeFileLock> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an OS-backed exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Outcome of a non-destructive check for an existing advisory-lock holder. */
export interface FileLockProbe {
	/** A process owns the advisory lock for `filePath` right now. */
	held: boolean;
	/** Set when the probe itself could not run, so callers can report a degraded check. */
	error?: string;
}

/**
 * Ask whether `filePath` is locked, without waiting for it and without becoming
 * its writer: winning the lock proves nobody held it, so ownership is handed
 * straight back.
 *
 * On platforms whose lock is a real file (`flock(2)` on `${filePath}.lock`;
 * Linux uses an abstract socket and creates nothing) the probe can leave an
 * empty lock file behind. That file is deliberately never unlinked: dropping it
 * while holding the lock lets the next acquirer `flock` a fresh inode and
 * believe it owns a lock this process also owns — two writers, which is exactly
 * what a destructive caller must never be talked into. An empty `.lock` file
 * costs nothing by comparison.
 */
export function probeFileLock(filePath: string): FileLockProbe {
	try {
		const lock = tryAcquireLock(getLockPath(filePath));
		if (!lock) return { held: true };
		lock.release();
		return { held: false };
	} catch (error) {
		return { held: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Test-only acquisition handle for forcing ownership handoffs. This is not
 * part of the supported package API.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	getLockPath,
};
