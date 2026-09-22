/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { sleepLong } from "./async";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Abort waiting for a contended lock. */
	signal?: AbortSignal;
}

/** An exclusive OS-backed lease. Releasing an already released handle is safe. */
export interface FileLockHandle {
	release(): void;
}

const DEFAULT_OPTIONS: Required<Omit<FileLockOptions, "signal">> = {
	retries: 50,
	retryDelayMs: 100,
} as const;

/**
 * Thrown when a contended lock is still unavailable after the retry budget.
 * Callers that map lock contention onto their own domain errors match on
 * this type instead of the message text.
 */
export class LockAcquireError extends Error {
	constructor(
		readonly filePath: string,
		readonly attempts: number,
	) {
		super(`Failed to acquire lock for ${filePath} after ${attempts} attempts`);
		this.name = "LockAcquireError";
	}
}

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function tryAcquireLock(lockPath: string): NativeFileLock | null {
	const lock = NativeFileLock.tryAcquire(lockPath);
	return lock.acquired ? lock : null;
}

/** Acquire an exclusive lease; callers must release it when their operation ends. */
export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const retries = options.retries ?? DEFAULT_OPTIONS.retries;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_OPTIONS.retryDelayMs;
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < retries; attempt++) {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new DOMException("The operation was aborted.", "AbortError");
		}
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		// sleepLong chunks delays past the 32-bit timer ceiling instead of
		// overflowing, and wakes promptly on abort like delay() did.
		if (attempt + 1 < retries) await sleepLong(retryDelayMs, options.signal);
	}

	throw new LockAcquireError(filePath, retries);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): NativeFileLock {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const lock = tryAcquireLock(lockPath);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an OS-backed exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Run synchronous `fn` while holding an OS-backed exclusive lock for `filePath`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
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
