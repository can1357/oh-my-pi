/** Canonical process log ownership shared by structured and external writers. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogsDir, localDay } from "../dirs";
import { RotatingFileSink } from "./rotating-file";

const PROCESS_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log(?:\.(\d+))?$/;
/** Per-process audit files written by earlier releases; current sinks track rotations in memory. */
const PROCESS_AUDIT_PATTERN = /^\.omp\.(\d+)-audit\.json$/;
/** Shared daily logs (plain, size-rolled, or gzipped) written by the winston-era logger. */
const LEGACY_LOG_PATTERN = /^omp\.(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?(?:\.gz)?$/;
/** Hash-named audit files written by winston-daily-rotate-file. */
const LEGACY_AUDIT_PATTERN = /^\.[0-9a-f]{8,}-audit\.json$/;
const RETAINED_STALE_LOGS_PER_PROCESS_DAY = 1;
const RETAINED_STALE_LOG_DAYS = 5;

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EINVAL"));
	}
}

/**
 * Retain one newest completed-process log per process/day within the current
 * and previous four local calendar days, remove completed-process audit files
 * left by earlier releases, and age out legacy shared daily logs and their
 * hash-named audits past the same window. Live PID namespaces are never
 * touched. The calendar-day boundary preserves daily diagnostic coverage while
 * bounding completed-process storage and scans.
 */
function pruneStaleProcessLogs(dir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const current = new Date();
	const currentDate = localDay(current);
	const cutoff = new Date(current);
	cutoff.setDate(cutoff.getDate() - (RETAINED_STALE_LOG_DAYS - 1));
	const cutoffDate = localDay(cutoff);
	cutoff.setHours(0, 0, 0, 0);
	const cutoffMs = cutoff.getTime();

	const staleLogsByProcessDay = new Map<string, Array<{ path: string; rollover: number }>>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const entryPath = path.join(dir, entry.name);
		const legacyMatch = LEGACY_LOG_PATTERN.exec(entry.name);
		if (legacyMatch?.[1]) {
			if (legacyMatch[1] < cutoffDate) removeBestEffort(entryPath);
			continue;
		}
		if (LEGACY_AUDIT_PATTERN.test(entry.name)) {
			try {
				if (fs.statSync(entryPath).mtimeMs < cutoffMs) removeBestEffort(entryPath);
			} catch {
				// Another process may have pruned the same legacy audit.
			}
			continue;
		}
		const logMatch = PROCESS_LOG_PATTERN.exec(entry.name);
		const auditMatch = PROCESS_AUDIT_PATTERN.exec(entry.name);
		const pidText = logMatch?.[2] ?? auditMatch?.[1];
		if (!pidText || processIsRunning(Number(pidText))) continue;

		if (auditMatch) {
			removeBestEffort(entryPath);
			continue;
		}
		if (!logMatch?.[1]) continue;
		if (logMatch[1] < cutoffDate || logMatch[1] > currentDate) {
			removeBestEffort(entryPath);
			continue;
		}

		const key = `${pidText}:${logMatch[1]}`;
		const staleLogs = staleLogsByProcessDay.get(key) ?? [];
		staleLogs.push({
			path: entryPath,
			rollover: Number(logMatch[3] ?? 0),
		});
		staleLogsByProcessDay.set(key, staleLogs);
	}

	for (const staleLogs of staleLogsByProcessDay.values()) {
		if (staleLogs.length <= RETAINED_STALE_LOGS_PER_PROCESS_DAY) continue;
		const ranked: Array<{ path: string; mtimeMs: number; rollover: number }> = [];
		for (const stale of staleLogs) {
			try {
				ranked.push({ ...stale, mtimeMs: fs.statSync(stale.path).mtimeMs });
			} catch {
				// Another process may have pruned the same stale namespace.
			}
		}
		ranked.sort(
			(a, b) => b.mtimeMs - a.mtimeMs || b.rollover - a.rollover || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
		for (const stale of ranked.slice(RETAINED_STALE_LOGS_PER_PROCESS_DAY)) removeBestEffort(stale.path);
	}
}

function removeBestEffort(filePath: string): void {
	try {
		fs.rmSync(filePath, { force: true });
	} catch {
		// Retention is best-effort; another process may have pruned the same file.
	}
}

const scheduledPruneDirs = new Set<string>();

/** Run shared retention only after logger construction has returned to the event loop. */
function schedulePruneStaleProcessLogs(dir: string): void {
	if (scheduledPruneDirs.has(dir)) return;
	scheduledPruneDirs.add(dir);
	const immediate = setImmediate(() => {
		scheduledPruneDirs.delete(dir);
		pruneStaleProcessLogs(dir);
	});
	immediate.unref();
}

/** Ensure a logs directory exists; return the resolved path. */
function ensureDir(dir: string): string {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}
/** Longest a buffered file record waits before it is written. */
const FILE_FLUSH_INTERVAL_MS = 1_000;
/** Buffered bytes at which the file batch is written immediately. */
const FILE_FLUSH_BYTES = 64 * 1024;

export interface ProcessLogTargetLease {
	readonly path: string;
	readonly release: () => void;
}

let configuredFile: boolean | string | undefined = true;
let activeSink: RotatingFileSink | undefined;
let activeDirectory: string | undefined;
/** Last successfully opened target, retained when selecting a successor fails. */
let activeTargetPath: string | undefined;
let externalOwners = 0;
const targetListeners = new Set<(filePath: string) => void>();

function notifyTargetChanged(filePath: string): void {
	const previousPath = activeTargetPath;
	try {
		for (const listener of targetListeners) listener(filePath);
	} catch (error) {
		// A later participant can fail after earlier guards moved. Roll every
		// guard back before the sink closes the rejected successor.
		if (previousPath) {
			for (const listener of targetListeners) {
				try {
					listener(previousPath);
				} catch {
					// Keep the original failure; a later rotation will retry.
				}
			}
		}
		throw error;
	}
	activeTargetPath = filePath;
}

/** Join canonical handoffs; throwing rejects a replacement and rolls back participants. */
export function onProcessLogTargetChanged(listener: (filePath: string) => void): void {
	targetListeners.add(listener);
}

function effectiveDirectory(file: boolean | string | undefined): string {
	return path.resolve(typeof file === "string" && file ? file : getLogsDir());
}

/** Build a lazy sink; shared retention runs after construction returns. */
function makeFileTransport(directory: string): RotatingFileSink {
	const logsDir = ensureDir(directory);
	schedulePruneStaleProcessLogs(logsDir);
	const sink = new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "omp",
		filenameSuffix: String(process.pid),
		maxBytes: 10 * 1024 * 1024,
		maxFiles: 5,
		batch: { intervalMs: FILE_FLUSH_INTERVAL_MS, maxBytes: FILE_FLUSH_BYTES },
		onRotate: filePath => {
			// Only the committed owner may publish, including during final flushes.
			if (activeSink === sink) notifyTargetChanged(filePath);
		},
	});
	return sink;
}

/** Structured logging selects its process-owned sink only when needed. */
export function getProcessLogSink(): RotatingFileSink {
	if (!activeSink) {
		const directory = effectiveDirectory(configuredFile);
		activeSink = makeFileTransport(directory);
		activeDirectory = directory;
	}
	return activeSink;
}

/**
 * Prepare an externally visible replacement before retiring the old target.
 * Disabled structured output retains a default diagnostic sink only for leases.
 */
export function configureProcessLog(file: boolean | string | undefined): void {
	const directory = effectiveDirectory(file);
	if (activeSink && activeDirectory === directory) {
		if (!file) {
			try {
				activeSink.flush();
			} catch {
				// Disabling a broken sink must still release its transport and descriptor.
			}
			if (externalOwners === 0) activeSink.stopWatchingExternalWrites(true);
		}
		configuredFile = file;
		return;
	}
	const previous = activeSink;
	let replacement: RotatingFileSink | undefined;
	let replacementPath: string | undefined;
	if (externalOwners > 0 || (previous && file)) {
		replacement = makeFileTransport(directory);
		try {
			if (externalOwners > 0) {
				replacementPath = replacement.openForExternalWrites();
				notifyTargetChanged(replacementPath);
			}
		} catch (error) {
			// The handoff has already restored participants to the previous target.
			replacement.close();
			throw error;
		}
	}
	configuredFile = file;
	activeSink = replacement;
	activeDirectory = replacement ? directory : undefined;
	activeTargetPath = replacementPath;
	previous?.close();
}

/** Open and watch the shared target synchronously before handing it to a guard. */
export function acquireProcessLogTarget(): ProcessLogTargetLease {
	const sink = getProcessLogSink();
	const filePath = sink.openForExternalWrites();
	externalOwners++;
	let released = false;
	return {
		path: filePath,
		release: () => {
			if (released) return;
			released = true;
			if (--externalOwners !== 0) return;
			// Keep selection/retention history across disabled TUI stop/restart.
			activeSink?.stopWatchingExternalWrites(!configuredFile);
		},
	};
}

/** Flush without initializing a sink, including diagnostic-only leases. */
export function flushProcessLog(): void {
	activeSink?.flush();
}
