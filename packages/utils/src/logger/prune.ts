/** Cross-process retention for rotating logger files and legacy winston logs/audits. */
import * as fs from "node:fs";
import * as path from "node:path";
import { localDay } from "../dirs";
import type * as FileLockModule from "../file-lock";
import type { FileLockHandle } from "../file-lock";
import { isPidAlive } from "../pid";

const PROCESS_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log(?:\.(\d+))?$/;
/** Per-process audit files written by earlier releases; current sinks track rotations in memory. */
const PROCESS_AUDIT_PATTERN = /^\.omp\.(\d+)-audit\.json$/;
/** Shared daily logs (plain, size-rolled, or gzipped) written by the winston-era logger. */
const LEGACY_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?(?:\.gz)?$/;
/** Hash-named audit files written by winston-daily-rotate-file. */
const LEGACY_AUDIT_PATTERN = /^\.[0-9a-f]{8,}-audit\.json$/;
const PRUNE_STAMP_FILENAME = ".prune-stamp";
const PRUNE_LOCK_FILENAME = `${PRUNE_STAMP_FILENAME}.lock`;
const RETAINED_STALE_LOGS_PER_PROCESS_DAY = 1;
const RETAINED_STALE_LOG_DAYS = 5;
const MAX_RETAINED_STALE_PROCESS_LOGS = 64;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface StaleProcessLogCandidate {
	readonly path: string;
	readonly name: string;
	readonly day: string;
	readonly pid: number;
	readonly rollover: number;
	mtimeMs?: number;
}

function compareDescStrings(a: string, b: string): number {
	return a < b ? 1 : a > b ? -1 : 0;
}

function compareSameDayStaleLogs(
	a: StaleProcessLogCandidate & { readonly mtimeMs: number },
	b: StaleProcessLogCandidate & { readonly mtimeMs: number },
): number {
	return b.mtimeMs - a.mtimeMs || b.rollover - a.rollover || b.pid - a.pid || compareDescStrings(a.name, b.name);
}

function touchPruneStamp(stampPath: string, now: Date): void {
	try {
		const fd = fs.openSync(stampPath, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600);
		try {
			fs.futimesSync(fd, now, now);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Stamp updates are best-effort; read-only or removed dirs still finish cleanly.
	}
}

type NativesLockProbe = { readonly FileLock?: { readonly tryAcquire?: unknown } };

let cachedTryAcquireFileLock: typeof FileLockModule.tryAcquireFileLock | null | undefined;
let nativesLoaderForTesting: (() => NativesLockProbe) | undefined;

function loadTryAcquireFileLock(): typeof FileLockModule.tryAcquireFileLock | null {
	if (cachedTryAcquireFileLock !== undefined) return cachedTryAcquireFileLock;
	try {
		const natives = nativesLoaderForTesting
			? nativesLoaderForTesting()
			: (require("@oh-my-pi/pi-natives") as NativesLockProbe);
		if (typeof natives.FileLock?.tryAcquire !== "function") {
			cachedTryAcquireFileLock = null;
			return null;
		}
		const fileLock: typeof FileLockModule = require("../file-lock");
		cachedTryAcquireFileLock = fileLock.tryAcquireFileLock;
	} catch {
		// Native addon unavailable, disabled (`bun --no-addons`), or predates `FileLock`: prune unlocked.
		cachedTryAcquireFileLock = null;
	}
	return cachedTryAcquireFileLock;
}

/**
 * Test-only capability seam for simulating missing or stale native `FileLock`
 * bindings without process-wide module mocks.
 */
export const __internalsForTesting = {
	setNativesLoader(loader: (() => NativesLockProbe) | undefined): void {
		nativesLoaderForTesting = loader;
		cachedTryAcquireFileLock = undefined;
	},
};

function isStampFresh(stampPath: string, nowMs: number): boolean {
	try {
		const stampStat = fs.statSync(stampPath);
		if (!stampStat.isFile()) return false;
		const elapsedMs = nowMs - Math.round(stampStat.mtimeMs);
		return elapsedMs >= -1_000 && elapsedMs < PRUNE_INTERVAL_MS;
	} catch {
		return false;
	}
}

function removeBestEffort(filePath: string): void {
	try {
		fs.rmSync(filePath, { force: true });
	} catch {
		// Retention is best-effort; another process may have pruned the same file.
	}
}

/**
 * Retain up to 64 newest completed-process logs (at most one per process/day)
 * within the current and previous four local calendar days, remove
 * completed-process audit files left by earlier releases, and age out legacy
 * shared daily logs and their hash-named audits past the same window.
 *
 * Current and live PID namespaces are never touched across any date so
 * long-lived sessions holding an open log or redirected stderr fd never lose
 * their file; out-of-window dead-PID logs (`day < cutoffDate` or
 * `day > currentDate`) are removed immediately without consuming retained
 * slots. Startup scans throttle on `.prune-stamp` for 5 minutes and claim the
 * scan non-blockingly via `tryAcquireFileLock` unless `options.force` is set.
 */
export function pruneStaleProcessLogs(dir: string, options?: { readonly now?: Date; readonly force?: boolean }): void {
	const current = options?.now ? new Date(options.now.getTime()) : new Date();
	const currentMs = current.getTime();
	const stampPath = path.join(dir, PRUNE_STAMP_FILENAME);
	let lock: FileLockHandle | null = null;
	if (!options?.force) {
		if (isStampFresh(stampPath, currentMs)) return;
		const tryAcquire = loadTryAcquireFileLock();
		if (tryAcquire) {
			let acquired: FileLockHandle | null | undefined;
			try {
				acquired = tryAcquire(stampPath);
			} catch {
				// Unavailable lock backend or unwritable sidecar path: fall through to best-effort unlocked scan.
				acquired = undefined;
			}
			if (acquired === null) return;
			lock = acquired ?? null;
		}
	}

	let sawOtherEntries = false;
	try {
		if (lock && isStampFresh(stampPath, currentMs)) {
			return;
		}

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		const currentDate = localDay(current);
		const cutoff = new Date(currentMs);
		cutoff.setDate(cutoff.getDate() - (RETAINED_STALE_LOG_DAYS - 1));
		const cutoffDate = localDay(cutoff);
		cutoff.setHours(0, 0, 0, 0);
		const cutoffMs = cutoff.getTime();
		const currentPid = process.pid;

		const pidAliveCache = new Map<number, boolean>();
		const checkPidAlive = (pid: number): boolean => {
			const cached = pidAliveCache.get(pid);
			if (cached !== undefined) return cached;
			const alive = isPidAlive(pid);
			pidAliveCache.set(pid, alive);
			return alive;
		};

		const staleLogsByProcessDay = new Map<string, StaleProcessLogCandidate[]>();
		for (const entry of entries) {
			if (!entry.isFile() || entry.name === PRUNE_STAMP_FILENAME || entry.name === PRUNE_LOCK_FILENAME) continue;
			const entryPath = path.join(dir, entry.name);
			const legacyMatch = LEGACY_LOG_PATTERN.exec(entry.name);
			if (legacyMatch?.[1]) {
				sawOtherEntries = true;
				if (legacyMatch[1] < cutoffDate) removeBestEffort(entryPath);
				continue;
			}
			if (LEGACY_AUDIT_PATTERN.test(entry.name)) {
				sawOtherEntries = true;
				try {
					if (fs.statSync(entryPath).mtimeMs < cutoffMs) removeBestEffort(entryPath);
				} catch {
					// Another process may have pruned the same legacy audit.
				}
				continue;
			}
			const logMatch = PROCESS_LOG_PATTERN.exec(entry.name);
			if (logMatch) {
				const [, logDate, pidText, rolloverText] = logMatch;
				if (!logDate || !pidText) continue;
				const pid = Number(pidText);
				if (pid === currentPid) continue;
				sawOtherEntries = true;
				if (checkPidAlive(pid)) continue;
				if (logDate < cutoffDate || logDate > currentDate) {
					removeBestEffort(entryPath);
					continue;
				}

				const key = `${pidText}:${logDate}`;
				const candidate: StaleProcessLogCandidate = {
					path: entryPath,
					name: entry.name,
					day: logDate,
					pid,
					rollover: Number(rolloverText ?? 0),
				};
				const staleLogs = staleLogsByProcessDay.get(key);
				if (staleLogs) staleLogs.push(candidate);
				else staleLogsByProcessDay.set(key, [candidate]);
				continue;
			}
			const auditMatch = PROCESS_AUDIT_PATTERN.exec(entry.name);
			if (auditMatch?.[1]) {
				const pid = Number(auditMatch[1]);
				if (pid === currentPid) continue;
				sawOtherEntries = true;
				if (checkPidAlive(pid)) continue;
				removeBestEffort(entryPath);
			}
		}

		if (sawOtherEntries) {
			touchPruneStamp(stampPath, current);
		}

		const survivors: StaleProcessLogCandidate[] = [];
		for (const staleLogs of staleLogsByProcessDay.values()) {
			if (staleLogs.length <= RETAINED_STALE_LOGS_PER_PROCESS_DAY) {
				for (const stale of staleLogs) survivors.push(stale);
				continue;
			}
			const ranked: Array<StaleProcessLogCandidate & { mtimeMs: number }> = [];
			for (const stale of staleLogs) {
				try {
					ranked.push({ ...stale, mtimeMs: fs.statSync(stale.path).mtimeMs });
				} catch {
					// Another process may have pruned the same stale namespace.
				}
			}
			ranked.sort(compareSameDayStaleLogs);
			for (const kept of ranked.slice(0, RETAINED_STALE_LOGS_PER_PROCESS_DAY)) survivors.push(kept);
			for (const stale of ranked.slice(RETAINED_STALE_LOGS_PER_PROCESS_DAY)) removeBestEffort(stale.path);
		}

		if (survivors.length <= MAX_RETAINED_STALE_PROCESS_LOGS) return;

		const survivorsByDay = new Map<string, StaleProcessLogCandidate[]>();
		for (const survivor of survivors) {
			const bucket = survivorsByDay.get(survivor.day);
			if (bucket) bucket.push(survivor);
			else survivorsByDay.set(survivor.day, [survivor]);
		}

		const daysNewestFirst = [...survivorsByDay.keys()].sort(compareDescStrings);
		let remaining = MAX_RETAINED_STALE_PROCESS_LOGS;
		for (const day of daysNewestFirst) {
			const bucket = survivorsByDay.get(day);
			if (!bucket) continue;
			if (remaining === 0) {
				for (const stale of bucket) removeBestEffort(stale.path);
				continue;
			}
			const present: Array<StaleProcessLogCandidate & { mtimeMs: number }> = [];
			for (const stale of bucket) {
				try {
					present.push({ ...stale, mtimeMs: stale.mtimeMs ?? fs.statSync(stale.path).mtimeMs });
				} catch {
					// Another process may have pruned the same stale namespace.
				}
			}
			if (present.length <= remaining) {
				remaining -= present.length;
				continue;
			}
			present.sort(compareSameDayStaleLogs);
			for (const stale of present.slice(remaining)) removeBestEffort(stale.path);
			remaining = 0;
		}
	} finally {
		lock?.release();
	}
}
