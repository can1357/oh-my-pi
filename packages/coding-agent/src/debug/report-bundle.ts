/**
 * Debug report bundle creation.
 *
 * Creates a .tar.gz archive with session data, logs, system info, and optional profiling data.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkProfile } from "@oh-my-pi/pi-natives";
import { APP_NAME, getLogPath, getLogsDir, getReportsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import type { CpuProfile, HeapSnapshot } from "./profiler";
import { collectSystemInfo, sanitizeEnv } from "./system-info";

/** Maximum number of log lines to load into memory at once. */
const MAX_LOG_LINES = 5000;

/** Maximum bytes to read from the tail of a log file (2 MB). */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Read last N lines from a file, reading at most `maxBytes` from the tail. */
async function readLastLines(filePath: string, n: number, maxBytes = MAX_LOG_BYTES): Promise<string> {
	try {
		const file = Bun.file(filePath);
		const size = file.size;
		const start = Math.max(0, size - maxBytes);
		const content = start > 0 ? await file.slice(start, size).text() : await file.text();
		const lines = content.split("\n");
		// If we sliced mid-file, drop the first (partial) line
		if (start > 0 && lines.length > 0) {
			lines.shift();
		}
		return lines.slice(-n).join("\n");
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

export interface ReportBundleOptions {
	/** Session file path */
	sessionFile: string | undefined;
	/** Settings to include */
	settings?: Record<string, unknown>;
	/** CPU profile (for performance reports) */
	cpuProfile?: CpuProfile;
	/** Heap snapshot (for memory reports) */
	heapSnapshot?: HeapSnapshot;
	/** Work profile (for work scheduling reports) */
	workProfile?: WorkProfile;
	/** Raw provider SSE diagnostics captured by the session buffer */
	rawSseText?: string;
}

export interface ReportBundleResult {
	path: string;
	files: string[];
}

export interface DebugLogSource {
	getInitialText(): Promise<string>;
	hasOlderLogs(): boolean;
	loadOlderLogs(limitDays?: number): Promise<string>;
}

/**
 * Create a debug report bundle.
 *
 * Bundle contents:
 * - session.jsonl: Current session transcript
 * - artifacts/: Current session's artifacts subtree (recursive), including any
 *   subagent session transcripts nested under it
 * - logs.txt: Recent log entries
 * - system.json: OS, arch, CPU, memory, versions
 * - env.json: Sanitized environment variables
 * - config.json: Resolved settings
 * - profile.cpuprofile: CPU profile (performance report only)
 * - raw-sse.txt: Recent raw provider SSE diagnostics (when captured)
 * - profile.md: Markdown CPU profile (performance report only)
 * - heap.heapsnapshot: Heap snapshot (memory report only)
 * - work.folded: Work profile folded stacks (work report only)
 * - work.md: Work profile summary (work report only)
 * - work.svg: Work profile flamegraph (work report only)
 */
export async function createReportBundle(options: ReportBundleOptions): Promise<ReportBundleResult> {
	const reportsDir = getReportsDir();
	await fs.mkdir(reportsDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputPath = path.join(reportsDir, `omp-report-${timestamp}.tar.gz`);

	const data: Record<string, string> = {};
	const files: string[] = [];

	// Collect system info
	const systemInfo = await collectSystemInfo();
	data["system.json"] = JSON.stringify(systemInfo, null, 2);
	files.push("system.json");

	// Sanitized environment
	data["env.json"] = JSON.stringify(sanitizeEnv(Bun.env as Record<string, string>), null, 2);
	files.push("env.json");

	// Settings/config
	if (options.settings) {
		data["config.json"] = JSON.stringify(options.settings, null, 2);
		files.push("config.json");
	}

	// Recent logs (last 1000 lines) across every same-day process. PID-qualified
	// filenames mean a report generated from a later invocation must still gather
	// the crashed process's log, so read all of today's files, not just our own.
	const logs = await collectSameDayLogs(1000);
	if (logs) {
		data["logs.txt"] = logs;
		files.push("logs.txt");
	}

	// Recent raw provider SSE diagnostics
	if (options.rawSseText && options.rawSseText.trim().length > 0) {
		data["raw-sse.txt"] = options.rawSseText;
		files.push("raw-sse.txt");
	}

	// Session file
	if (options.sessionFile) {
		try {
			const sessionContent = await Bun.file(options.sessionFile).text();
			data["session.jsonl"] = sessionContent;
			files.push("session.jsonl");
		} catch {
			// Session file might not exist yet
		}

		// Artifacts subtree (same path without .jsonl). Recursing captures the
		// current session's nested subagent transcripts and their artifacts while
		// staying inside this session's own directory — unrelated co-located
		// sessions in the sessions root are never touched (#8648).
		const artifactsDir = options.sessionFile.slice(0, -6);
		await addDirectoryToArchive(data, files, artifactsDir, "artifacts");
	}

	// CPU profile
	if (options.cpuProfile) {
		data["profile.cpuprofile"] = options.cpuProfile.data;
		files.push("profile.cpuprofile");
		data["profile.md"] = options.cpuProfile.markdown;
		files.push("profile.md");
	}

	// Heap snapshot
	if (options.heapSnapshot) {
		data["heap.heapsnapshot"] = options.heapSnapshot.data;
		files.push("heap.heapsnapshot");
	}

	// Work profile
	if (options.workProfile) {
		data["work.folded"] = options.workProfile.folded;
		files.push("work.folded");
		data["work.md"] = options.workProfile.summary;
		files.push("work.md");
		if (options.workProfile.svg) {
			data["work.svg"] = options.workProfile.svg;
			files.push("work.svg");
		}
	}

	// Write archive
	await writeArchive(outputPath, "tar.gz", Object.entries(data));

	return { path: outputPath, files };
}

/** Recursively add every file under a directory to the archive. */
async function addDirectoryToArchive(
	data: Record<string, string>,
	files: string[],
	dirPath: string,
	archivePrefix: string,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		// Directory doesn't exist
		return;
	}
	for (const entry of entries) {
		const entryPath = path.join(dirPath, entry.name);
		const archivePath = `${archivePrefix}/${entry.name}`;
		if (entry.isDirectory()) {
			await addDirectoryToArchive(data, files, entryPath, archivePath);
			continue;
		}
		if (!entry.isFile()) continue;
		try {
			data[archivePath] = await Bun.file(entryPath).text();
			files.push(archivePath);
		} catch {
			// Skip files we can't read
		}
	}
}

/** Get recent log entries for display (tail-limited to avoid OOM on large files). */
export async function getLogText(): Promise<string> {
	return readLastLines(getLogPath(), MAX_LOG_LINES);
}

/**
 * Concatenate the tail of every same-day process log so a report generated
 * after a crash still captures the fatal PID's `omp.<date>.<pid>.log`. Files
 * are ordered oldest-first by mtime and separated by a filename header.
 */
async function collectSameDayLogs(linesPerFile: number): Promise<string> {
	const logsDir = getLogsDir();
	const today = new Date().toISOString().slice(0, 10);
	const sameDay: Array<{ name: string; mtimeMs: number }> = [];
	try {
		const entries = await fs.readdir(logsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = LOG_FILE_PATTERN.exec(entry.name);
			if (!match || match[1] !== today) continue;
			try {
				const stat = await fs.stat(path.join(logsDir, entry.name));
				sameDay.push({ name: entry.name, mtimeMs: stat.mtimeMs });
			} catch {
				// File may have rotated away between readdir and stat.
			}
		}
	} catch {
		return "";
	}
	sameDay.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const chunks: string[] = [];
	for (const { name } of sameDay) {
		const text = await readLastLines(path.join(logsDir, name), linesPerFile);
		if (text) chunks.push(`===== ${name} =====\n${text}`);
	}
	return chunks.join("\n\n");
}

const LOG_FILE_PATTERN = new RegExp(`^${APP_NAME}\\.(\\d{4}-\\d{2}-\\d{2})\\.\\d+\\.log(?:\\.\\d+)?$`);

export async function createDebugLogSource(): Promise<DebugLogSource> {
	const logsDir = getLogsDir();
	const todayPath = getLogPath();
	const todayName = path.basename(todayPath);
	let olderFiles: string[] = [];
	try {
		const entries = await fs.readdir(logsDir, { withFileTypes: true });
		const datedFiles = entries
			.filter(entry => entry.isFile())
			.map(entry => {
				const match = LOG_FILE_PATTERN.exec(entry.name);
				return match ? { name: entry.name, date: match[1] } : undefined;
			})
			.filter((entry): entry is { name: string; date: string } => entry !== undefined)
			.filter(entry => entry.name !== todayName)
			.sort((a, b) => b.date.localeCompare(a.date));
		olderFiles = datedFiles.map(entry => entry.name);
	} catch {
		olderFiles = [];
	}

	let cursor = 0;

	const getInitialText = async (): Promise<string> => {
		return readLastLines(todayPath, MAX_LOG_LINES);
	};

	const hasOlderLogs = (): boolean => cursor < olderFiles.length;

	const loadOlderLogs = async (limitDays: number = 1): Promise<string> => {
		if (!hasOlderLogs()) {
			return "";
		}
		const count = Math.max(1, limitDays);
		const slice = olderFiles.slice(cursor, cursor + count);
		cursor += slice.length;
		const chunks: string[] = [];
		for (const filename of slice.reverse()) {
			const filePath = path.join(logsDir, filename);
			try {
				const content = await readLastLines(filePath, MAX_LOG_LINES);
				if (content.length > 0) {
					chunks.push(content);
				}
			} catch (err) {
				if (!isEnoent(err)) {
					throw err;
				}
			}
		}
		return chunks.filter(chunk => chunk.length > 0).join("\n");
	};

	return {
		getInitialText,
		hasOlderLogs,
		loadOlderLogs,
	};
}

/** Calculate total size of artifact cache */
export async function getArtifactCacheStats(
	sessionsDir: string,
): Promise<{ count: number; totalSize: number; oldestDate: Date | null }> {
	let count = 0;
	let totalSize = 0;
	let oldestDate: Date | null = null;

	try {
		const sessions = await fs.readdir(sessionsDir, { withFileTypes: true });

		for (const session of sessions) {
			// Artifact directories don't have .jsonl extension
			if (session.isDirectory()) {
				const dirPath = path.join(sessionsDir, session.name);
				try {
					const stat = await fs.stat(dirPath);
					const files = await fs.readdir(dirPath);
					for (const file of files) {
						const filePath = path.join(dirPath, file);
						const fileStat = await fs.stat(filePath);
						if (fileStat.isFile()) {
							count++;
							totalSize += fileStat.size;
						}
					}
					if (!oldestDate || stat.mtime < oldestDate) {
						oldestDate = stat.mtime;
					}
				} catch {
					// Skip inaccessible directories
				}
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return { count, totalSize, oldestDate };
}

/** Clear artifact cache older than N days */
export async function clearArtifactCache(sessionsDir: string, daysOld: number = 30): Promise<{ removed: number }> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysOld);
	let removed = 0;

	try {
		const sessions = await fs.readdir(sessionsDir, { withFileTypes: true });

		for (const session of sessions) {
			if (session.isDirectory()) {
				const dirPath = path.join(sessionsDir, session.name);
				try {
					const stat = await fs.stat(dirPath);
					if (stat.mtime < cutoff) {
						await fs.rm(dirPath, { recursive: true, force: true });
						removed++;
					}
				} catch {
					// Skip inaccessible directories
				}
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return { removed };
}
