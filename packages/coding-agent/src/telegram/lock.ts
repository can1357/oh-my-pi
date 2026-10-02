/**
 * One bridge host per bot token.
 *
 * The lock is an OS-held {@link FileLock} on `<stateDir>/host`, so a crashed
 * process can never wedge a bot behind a stale lease: the kernel releases it
 * when the process dies. `host.json` sits beside it as human-readable metadata
 * (`{ pid }`) for `omp telegram status` and refusal messages; it is written
 * after the lock is won and removed on release. Two pollers cannot share a
 * `getUpdates` offset, so a second host must refuse and name the holder pid.
 *
 * Pattern: `launch/broker.ts` `acquireBrokerLease`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getTelegramDir } from "@oh-my-pi/pi-utils/dirs";

/** Live ownership of one bot's host lock. */
export interface TelegramHostLease {
	readonly botId: string;
	/** `<getTelegramDir()>/<botId>`. */
	readonly dir: string;
	readonly lockPath: string;
	readonly pidPath: string;
	release(): Promise<void>;
}

export type TelegramLockResult = { ok: true; lease: TelegramHostLease } | { ok: false; holderPid: number | null };

/** State directory of one bot: registry, inbox and the host lock live here. */
export function telegramHostDir(botId: string, baseDir: string = getTelegramDir()): string {
	return path.join(baseDir, botId);
}

/**
 * Pid of the live lock holder, or null when the lock is free. `host.json`
 * outlives a killed host (the kernel frees the lock, nothing removes the
 * file), so the lock itself decides whether anyone is running.
 *
 * A bot that was never hosted has no state directory at all: there is no lock
 * to probe. Probing anyway is not harmless — on platforms whose lock opens
 * `<dir>/host` with `create(true)` (flock sidecars), a missing directory is
 * an ENOENT that throws, so `omp telegram status` would crash instead of
 * reporting the bot as not running.
 */
export async function readTelegramLockHolder(botId: string, baseDir?: string): Promise<number | null> {
	const dir = telegramHostDir(botId, baseDir);
	if (!(await directoryExists(dir))) return null;
	const probe = FileLock.tryAcquire(path.join(dir, "host"));
	if (probe.acquired) {
		probe.release();
		return null;
	}
	return readHolderPid(dir);
}

/** Whether `dir` exists; an unreadable path still throws (liveness unknown). */
async function directoryExists(dir: string): Promise<boolean> {
	try {
		await fs.stat(dir);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readHolderPid(dir: string): Promise<number | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(path.join(dir, "host.json"), "utf8"));
		if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") return raw.pid;
		return null;
	} catch {
		return null;
	}
}

/**
 * Claim the host lock for `botId`. A failure returns the holder pid when the
 * metadata is readable, so the caller can say who is polling.
 */
export async function acquireTelegramHostLock(botId: string, baseDir?: string): Promise<TelegramLockResult> {
	const dir = telegramHostDir(botId, baseDir);
	await fs.mkdir(dir, { recursive: true });
	const lockPath = path.join(dir, "host");
	const pidPath = path.join(dir, "host.json");
	const lock = FileLock.tryAcquire(lockPath);
	if (!lock.acquired) return { ok: false, holderPid: await readHolderPid(dir) };
	try {
		await fs.writeFile(pidPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
	} catch (error) {
		lock.release();
		throw error;
	}
	let released = false;
	return {
		ok: true,
		lease: {
			botId,
			dir,
			lockPath,
			pidPath,
			async release() {
				if (released) return;
				released = true;
				try {
					await fs.rm(pidPath, { force: true });
				} finally {
					lock.release();
				}
			},
		},
	};
}
