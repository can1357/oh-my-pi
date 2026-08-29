import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { isEnoent, logger } from "@pk-nerdsaver-ai/pi-utils";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
	staleWhileOwnerAlive?: boolean;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
	staleWhileOwnerAlive: true,
};
const WINDOWS_REMOVE_RETRIES = 40;
const WINDOWS_REMOVE_RETRY_DELAY_MS = 50;
const WINDOWS_RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const WINDOWS_INFO_READ_RETRIES = 40;
const WINDOWS_INFO_READ_RETRY_DELAY_MS = 5;

interface LockInfo {
	pid: number;
	timestamp: number;
	token: string;
}

function isLockInfo(value: unknown): value is LockInfo {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { pid?: unknown; timestamp?: unknown; token?: unknown };
	return (
		typeof candidate.pid === "number" &&
		Number.isSafeInteger(candidate.pid) &&
		candidate.pid > 0 &&
		typeof candidate.timestamp === "number" &&
		Number.isFinite(candidate.timestamp) &&
		typeof candidate.token === "string" &&
		candidate.token.length > 0
	);
}

interface LockStatSnapshot {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function getBreakerPath(lockPath: string): string {
	return `${lockPath}.break`;
}

function getReaperPath(lockPath: string, staleToken: string): string {
	const safeToken = staleToken.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
	return `${lockPath}.reap.${safeToken}`;
}

async function writeLockInfo(lockPath: string, token: string): Promise<void> {
	const info: LockInfo = { pid: process.pid, timestamp: Date.now(), token };
	await Bun.write(`${lockPath}/info`, JSON.stringify(info));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const content = await fs.readFile(`${lockPath}/info`, "utf-8");
			const parsed: unknown = JSON.parse(content);
			return isLockInfo(parsed) ? parsed : null;
		} catch (error) {
			if (isEnoent(error) || error instanceof SyntaxError) return null;
			if (
				process.platform !== "win32" ||
				(error as NodeJS.ErrnoException).code !== "EPERM" ||
				attempt >= WINDOWS_INFO_READ_RETRIES
			) {
				throw error;
			}
			await Bun.sleep(WINDOWS_INFO_READ_RETRY_DELAY_MS);
		}
	}
}

async function readLockStatSnapshot(lockPath: string): Promise<LockStatSnapshot | null> {
	try {
		const stat = await fs.stat(lockPath);
		return {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
		};
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function sameLockStat(left: LockStatSnapshot, right: LockStatSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function lockStatGeneration(snapshot: LockStatSnapshot): string {
	return `${snapshot.dev}-${snapshot.ino}-${snapshot.size}-${snapshot.mtimeMs}-${snapshot.ctimeMs}`;
}

type SignalProcess = (pid: number) => void;

function signalProcess(pid: number): void {
	process.kill(pid, 0);
}

function isProcessAlive(pid: number, signal: SignalProcess = signalProcess): boolean {
	try {
		signal(pid);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function isLockStale(lockPath: string, staleMs: number, staleWhileOwnerAlive = true): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return staleWhileOwnerAlive && Date.now() - info.timestamp > staleMs;
	}

	// No info file. Either the lock holder is between mkdir and writeLockInfo
	// (fresh dir, do not reap) or the dir was already removed (also do not
	// reap — there is nothing to clean up, and an unguarded fs.rm here would
	// race with another contender's successful mkdir and wipe their dir).
	try {
		const stat = await fs.stat(lockPath);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.stat(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function isLockContention(error: unknown, lockPath: string, breakerPath?: string): Promise<boolean> {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EEXIST") return true;
	if (process.platform !== "win32" || code !== "EPERM") return false;
	return (await lockExists(lockPath)) || (breakerPath !== undefined && (await lockExists(breakerPath)));
}

async function createLockDirectory(lockPath: string, breakerPath?: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await fs.mkdir(lockPath);
			return true;
		} catch (error) {
			if (await isLockContention(error, lockPath, breakerPath)) return false;
			if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || attempt === 2) {
				throw error;
			}
			await Bun.sleep(5);
		}
	}
	return false;
}

async function tryAcquireLock(lockPath: string, breakerPath?: string): Promise<string | null> {
	if (breakerPath && (await lockExists(breakerPath))) return null;
	if (!(await createLockDirectory(lockPath, breakerPath))) return null;

	const token = randomUUID();
	try {
		await writeLockInfo(lockPath, token);
		if (breakerPath && (await lockExists(breakerPath))) {
			await releaseLock(lockPath, token);
			return null;
		}
		return token;
	} catch (error) {
		// mkdir succeeded, so this process owns the incomplete directory.
		await releaseLock(lockPath);
		throw error;
	}
}

async function releaseLock(lockPath: string, expectedToken?: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			if (expectedToken !== undefined) {
				const info = await readLockInfo(lockPath);
				if (!info || info.token !== expectedToken) {
					// We are not the owner. The lock either expired and was reaped
					// or another process has reclaimed it. Do nothing — releasing
					// here would wipe the rightful owner's lock.
					logger.debug("file-lock: skipping release for non-owned lock", {
						lockPath,
						expectedToken,
						actualToken: info?.token,
					});
					return;
				}
			}
			await fs.rm(lockPath, { force: true, recursive: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				process.platform !== "win32" ||
				!code ||
				!WINDOWS_RETRYABLE_REMOVE_CODES.has(code) ||
				attempt >= WINDOWS_REMOVE_RETRIES
			) {
				// Release remains best-effort; stale-lock recovery handles leftovers.
				return;
			}
			await Bun.sleep(WINDOWS_REMOVE_RETRY_DELAY_MS);
		}
	}
}

async function reapEmptyBreaker(breakerPath: string, staleMs: number): Promise<boolean> {
	if (await lockExists(`${breakerPath}/info`)) return false;
	const staleStat = await readLockStatSnapshot(breakerPath);
	if (!staleStat || Date.now() - staleStat.mtimeMs <= staleMs) return false;

	const reaperPath = getReaperPath(breakerPath, lockStatGeneration(staleStat));
	const reaperToken = await tryAcquireLock(reaperPath);
	if (reaperToken === null) return false;
	try {
		if (await lockExists(`${breakerPath}/info`)) return false;
		const currentStat = await readLockStatSnapshot(breakerPath);
		if (!currentStat || !sameLockStat(staleStat, currentStat) || Date.now() - currentStat.mtimeMs <= staleMs) {
			return false;
		}
		await releaseLock(breakerPath);
		return !(await lockExists(breakerPath));
	} finally {
		await releaseLock(reaperPath, reaperToken);
	}
}

async function acquireBreaker(lockPath: string, staleMs: number): Promise<{ path: string; token: string } | null> {
	const breakerPath = getBreakerPath(lockPath);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = await tryAcquireLock(breakerPath);
		if (token !== null) return { path: breakerPath, token };
		const staleInfo = await readLockInfo(breakerPath);
		if (!staleInfo) {
			if (!(await reapEmptyBreaker(breakerPath, staleMs))) return null;
			continue;
		}
		if (isProcessAlive(staleInfo.pid)) return null;

		// Fence stale-breaker cleanup by the observed breaker generation. Only
		// one contender can reap that token, and a crashed reaper blocks that
		// dead generation rather than deleting a newer breaker's directory.
		const reaperPath = getReaperPath(breakerPath, staleInfo.token);
		const reaperToken = await tryAcquireLock(reaperPath);
		if (reaperToken === null) return null;
		try {
			const current = await readLockInfo(breakerPath);
			if (!current || current.token !== staleInfo.token || isProcessAlive(current.pid)) return null;
			await releaseLock(breakerPath, current.token);
		} finally {
			await releaseLock(reaperPath, reaperToken);
		}
	}
	return null;
}

async function tryAcquireStaleLock(lockPath: string, options: Required<FileLockOptions>): Promise<string | null> {
	const breaker = await acquireBreaker(lockPath, options.staleMs);
	if (!breaker) return null;
	try {
		const direct = await tryAcquireLock(lockPath);
		if (direct !== null) return direct;
		if (!(await isLockStale(lockPath, options.staleMs, options.staleWhileOwnerAlive))) return null;
		await releaseLock(lockPath);
		return await tryAcquireLock(lockPath);
	} finally {
		await releaseLock(breaker.path, breaker.token);
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);
	const breakerPath = getBreakerPath(lockPath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const token = await tryAcquireLock(lockPath, breakerPath);
		if (token !== null) {
			return () => releaseLock(lockPath, token);
		}

		const staleLock =
			(await lockExists(lockPath)) && (await isLockStale(lockPath, opts.staleMs, opts.staleWhileOwnerAlive));
		const staleBreaker =
			!staleLock && (await lockExists(breakerPath)) && (await isLockStale(breakerPath, opts.staleMs, false));
		if (staleLock || staleBreaker) {
			const takeoverToken = await tryAcquireStaleLock(lockPath, opts);
			if (takeoverToken !== null) return () => releaseLock(lockPath, takeoverToken);
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * Test-only handles for the internal lock primitives. These are NOT part of
 * the public API — they exist so the contract tests can validate token-keyed
 * release semantics and the mkdir-race window without re-implementing them.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	isLockStale,
	isProcessAlive,
	getLockPath,
};
