/**
 * Debug report bundle creation.
 *
 * Creates a .tar.gz archive with session data, logs, system info, and optional profiling data.
 */

import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkProfile } from "@oh-my-pi/pi-natives";
import { APP_NAME, getLogPath, getLogsDir, getReportsDir, isEnoent, localDay, logger } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
import { readSessionHeaderId } from "../session/session-loader";
import { defaultSessionStorage, type SessionStorage } from "../session/session-storage";
import { listTranscriptTree } from "../session/session-transcript-tree";
import { collectSubSessions } from "../session/sub-sessions";
import type { CpuProfile, MemoryStats } from "./profiler";
import { collectSystemInfo, sanitizeEnv } from "./system-info";

/** Maximum number of log lines to load into memory at once. */
const MAX_LOG_LINES = 5000;

/** Maximum bytes to read from the tail of a log file (2 MB). */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** The last `n` lines of `text`, dropping its first line when that line is cut. */
function lastLines(text: string, startsMidLine: boolean, n: number): string {
	const lines = text.split("\n");
	if (startsMidLine) lines.shift();
	return lines.slice(-n).join("\n");
}

/** Read last N lines from a file, reading at most `maxBytes` from the tail. */
async function readLastLines(filePath: string, n: number, maxBytes = MAX_LOG_BYTES): Promise<string> {
	try {
		const file = Bun.file(filePath);
		const size = file.size;
		const start = Math.max(0, size - maxBytes);
		const content = start > 0 ? await file.slice(start, size).text() : await file.text();
		return lastLines(content, start > 0, n);
	} catch (err) {
		if (isEnoent(err)) return "";
		throw err;
	}
}

export interface ReportBundleOptions {
	/** Session file path */
	sessionFile: string | undefined;
	/**
	 * Storage {@link sessionFile} and its subagent transcripts live in: the
	 * session's. Omitted: the default session storage.
	 */
	storage?: SessionStorage;
	/** Settings to include */
	settings?: Record<string, unknown>;
	/** CPU profile (for performance reports) */
	cpuProfile?: CpuProfile;
	/** Numeric memory statistics, never raw heap contents */
	memoryStats?: MemoryStats;
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
 * - session-logs.txt: Today's log records of this session and its subagents
 * - system.json: OS, arch, CPU, memory, versions
 * - env.json: Sanitized environment variables
 * - config.json: Resolved settings
 * - profile.cpuprofile: CPU profile (performance report only)
 * - raw-sse.txt: Recent raw provider SSE diagnostics (when captured)
 * - profile.md: Markdown CPU profile (performance report only)
 * - memory.json: Numeric process and heap statistics (memory report only)
 * - work.folded: Work profile folded stacks (work report only)
 * - work.md: Work profile summary (work report only)
 * - work.svg: Work profile flamegraph (work report only)
 */
export async function createReportBundle(options: ReportBundleOptions): Promise<ReportBundleResult> {
	const reportsDir = getReportsDir();
	await fs.mkdir(reportsDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputPath = path.join(reportsDir, `omp-report-${timestamp}.tar.gz`);

	const data: Record<string, string | Uint8Array> = {};
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

	// Recent raw provider SSE diagnostics
	if (options.rawSseText && options.rawSseText.trim().length > 0) {
		data["raw-sse.txt"] = options.rawSseText;
		files.push("raw-sse.txt");
	}

	// Session file and its artifacts subtree (same path without .jsonl). The
	// transcripts (this session's and its nested subagents') are read through
	// the session's storage, which the session and its task executor write
	// them to: files under `session.storage: file`, rows under
	// `session.storage: sql`. The tool artifacts beside them are local files.
	// Staying inside this session's own subtree keeps unrelated co-located
	// sessions in the sessions root out of the bundle (#8648).
	if (options.sessionFile) {
		const storage = options.storage ?? defaultSessionStorage();
		await storage.refresh?.();
		const sessionContent = await readTranscript(storage, options.sessionFile);
		if (sessionContent !== undefined) {
			data["session.jsonl"] = sessionContent;
			files.push("session.jsonl");
		}

		const artifactsDir = options.sessionFile.slice(0, -6);
		for (const transcript of listTranscriptTree(storage, artifactsDir)) {
			const content = await readTranscript(storage, transcript);
			if (content === undefined) continue;
			const archivePath = `artifacts/${path.relative(artifactsDir, transcript).split(path.sep).join("/")}`;
			data[archivePath] = content;
			files.push(archivePath);
		}
		await addDirectoryToArchive(data, files, artifactsDir, "artifacts");
	}

	// Recent logs (last 1000 lines) across every same-day process. PID-qualified
	// filenames mean a report generated from a later invocation must still gather
	// the crashed process's log, so read all of today's files, not just our own.
	// Every record those files hold for this session or its subagents goes to
	// session-logs.txt, however far back in the file it sits.
	const { tails, sessionLines } = await collectSameDayLogs(
		1000,
		await collectSessionIds(options.sessionFile, options.storage ?? defaultSessionStorage()),
	);
	if (tails) {
		data["logs.txt"] = tails;
		files.push("logs.txt");
	}
	if (sessionLines) {
		data["session-logs.txt"] = sessionLines;
		files.push("session-logs.txt");
	}

	// CPU profile
	if (options.cpuProfile) {
		data["profile.cpuprofile"] = options.cpuProfile.data;
		files.push("profile.cpuprofile");
		data["profile.md"] = options.cpuProfile.markdown;
		files.push("profile.md");
	}

	// Memory statistics exclude heap contents, which can contain credentials.
	if (options.memoryStats) {
		data["memory.json"] = JSON.stringify(options.memoryStats, null, 2);
		files.push("memory.json");
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

/** A transcript's text, or `undefined` when it does not exist (yet) or cannot be read. */
async function readTranscript(storage: SessionStorage, transcript: string): Promise<string | undefined> {
	try {
		return await storage.readText(transcript);
	} catch {
		return undefined;
	}
}

/** Recursively add every local file under a directory not already in the archive. */
async function addDirectoryToArchive(
	data: Record<string, string | Uint8Array>,
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
		// A transcript the storage listing already added.
		if (!entry.isFile() || archivePath in data) continue;
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
	// The file transport batches writes; include this process's latest records.
	logger.flush();
	return readLastLines(getLogPath(), MAX_LOG_LINES);
}

/**
 * Ids of the session and its subagents, found the way `/export` finds subagent
 * transcripts, so other JSONL artifacts never pull in an unrelated session.
 */
async function collectSessionIds(sessionFile: string | undefined, storage: SessionStorage): Promise<Set<string>> {
	const ids = new Set<string>();
	if (!sessionFile) return ids;
	const ownId = await readSessionHeaderId(sessionFile, storage).catch(() => undefined);
	if (ownId) ids.add(ownId);
	const subSessions = await collectSubSessions(sessionFile, { storage }).catch(() => ({}));
	for (const sub of Object.values(subSessions)) if (sub.header) ids.add(sub.header.id);
	return ids;
}

/**
 * Concatenate the tail of every same-day process log so a report generated
 * after a crash still captures the fatal PID's `omp.<date>.<pid>.log`. Files
 * are ordered oldest-first by mtime and separated by a filename header.
 * `sessionLines` holds every record of those files whose `sessionId` is in
 * `sessionIds`, in the same file order, capped at the last {@link MAX_LOG_LINES}.
 */
async function collectSameDayLogs(
	linesPerFile: number,
	sessionIds: ReadonlySet<string>,
): Promise<{ tails: string; sessionLines: string }> {
	logger.flush();
	const logsDir = getLogsDir();
	// Log files are named with the local day (see localDay / RotatingFileSink),
	// so match them with the local day too — the UTC key misses the live log
	// between local midnight and UTC midnight.
	const today = localDay(new Date());
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
		return { tails: "", sessionLines: "" };
	}
	sameDay.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const chunks: string[] = [];
	const sessionLines: string[] = [];
	for (const { name } of sameDay) {
		const filePath = path.join(logsDir, name);
		if (sessionIds.size === 0) {
			const text = await readLastLines(filePath, linesPerFile);
			if (text) chunks.push(`===== ${name} =====\n${text}`);
			continue;
		}
		// One read serves both files, so the tail and the session lines agree;
		// the tail keeps the same byte cap as a tail read.
		let bytes: Uint8Array;
		try {
			bytes = await Bun.file(filePath).bytes();
		} catch (err) {
			if (isEnoent(err)) continue; // Rotated away since the listing.
			throw err;
		}
		const tailStart = Math.max(0, bytes.length - MAX_LOG_BYTES);
		const decoder = new TextDecoder();
		const text = lastLines(decoder.decode(bytes.subarray(tailStart)), tailStart > 0, linesPerFile);
		if (text) chunks.push(`===== ${name} =====\n${text}`);
		const lines = decoder.decode(bytes).split("\n");
		for (const line of lines) {
			if (!line.includes('"sessionId":')) continue;
			try {
				const { sessionId } = JSON.parse(line) as { sessionId?: unknown };
				if (typeof sessionId === "string" && sessionIds.has(sessionId)) sessionLines.push(line);
			} catch {
				// A torn last line of a live file.
			}
		}
		// Keep only what can reach the archive, file by file.
		if (sessionLines.length > MAX_LOG_LINES) sessionLines.splice(0, sessionLines.length - MAX_LOG_LINES);
	}
	return { tails: chunks.join("\n\n"), sessionLines: sessionLines.join("\n") };
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
		logger.flush();
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

/** A tool artifact file old enough for {@link clearArtifactCache} to remove. */
interface ExpiredArtifact {
	path: string;
	size: number;
	mtime: Date;
	/** Identity the walk saw, so a removal can refuse a file replaced since. */
	dev: number;
	ino: number;
}

/**
 * A tool artifact's file name: `<id>.<tool>.log`, as `ArtifactManager`
 * allocates it (the tool segment is sanitized to `[A-Za-z0-9_-]`). Nothing
 * else in a session's artifacts tree is a cache: transcripts and their
 * sidecars, `/btw` conversations, the unsent prompt draft and annotation
 * drafts are user data.
 */
const TOOL_ARTIFACT_NAME = /^\d+\.[A-Za-z0-9_-]+\.log$/;

/** Entries of `dir`, or none when it is missing or unreadable. */
async function readEntries(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * A real directory (not a symlink, not replaced by one) that resolves to the
 * place the walk expects: `expected` is the real sessions root joined with the
 * path below it, so a directory swapped for a symlink after the walk read it
 * resolves elsewhere and is refused.
 */
async function isExpectedDirectory(dir: string, expected: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(dir);
		return stat.isDirectory() && (await fs.realpath(dir)) === expected;
	} catch {
		return false;
	}
}

/**
 * Visit every tool artifact ({@link TOOL_ARTIFACT_NAME}) under the sessions
 * root last modified before `cutoff`: a regular file inside a session's
 * artifacts tree (`<sessions>/<project>/<session>/…`, at any depth), reached
 * without following a symlink. Never a file directly in the sessions root or
 * in a project directory: under `session.storage: file` the project
 * directories hold the session transcripts themselves.
 */
async function visitExpiredArtifacts(
	sessionsDir: string,
	cutoff: Date,
	visit: (artifact: ExpiredArtifact, expectedDir: string) => Promise<void> | void,
): Promise<void> {
	let realRoot: string;
	try {
		realRoot = await fs.realpath(sessionsDir);
	} catch {
		return;
	}
	const expectedOf = (dir: string): string => path.join(realRoot, path.relative(sessionsDir, dir));
	const walk = async (dir: string): Promise<void> => {
		if (!(await isExpectedDirectory(dir, expectedOf(dir)))) return;
		for (const entry of await readEntries(dir)) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (!entry.isFile() || !TOOL_ARTIFACT_NAME.test(entry.name)) continue;
			let stat: Stats;
			try {
				stat = await fs.lstat(entryPath);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.mtime >= cutoff) continue;
			await visit(
				{ path: entryPath, size: stat.size, mtime: stat.mtime, dev: stat.dev, ino: stat.ino },
				expectedOf(dir),
			);
		}
	};
	for (const project of await readEntries(sessionsDir)) {
		if (!project.isDirectory()) continue;
		const projectDir = path.join(sessionsDir, project.name);
		if (!(await isExpectedDirectory(projectDir, expectedOf(projectDir)))) continue;
		for (const session of await readEntries(projectDir)) {
			if (session.isDirectory()) await walk(path.join(projectDir, session.name));
		}
	}
}

/** Count and size of the tool artifacts {@link clearArtifactCache} would remove for the same `daysOld`. */
export async function getArtifactCacheStats(
	sessionsDir: string,
	daysOld: number,
): Promise<{ count: number; totalSize: number; oldestDate: Date | null }> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysOld);
	let count = 0;
	let totalSize = 0;
	let oldestDate: Date | null = null;
	await visitExpiredArtifacts(sessionsDir, cutoff, artifact => {
		count++;
		totalSize += artifact.size;
		if (!oldestDate || artifact.mtime < oldestDate) oldestDate = artifact.mtime;
	});
	return { count, totalSize, oldestDate };
}

/**
 * Remove the tool artifacts last modified more than `daysOld` days ago (see
 * {@link visitExpiredArtifacts}), then the directories inside a session's
 * artifacts tree that the removal left empty. Nothing but `<id>.<tool>.log`
 * files is removed, and never a session or project directory, whatever
 * `session.storage` holds the transcripts.
 *
 * Right before each removal the file's directory must still resolve to where
 * the walk found it and the file must still be the one it saw (same device,
 * inode and mtime, still older than the cutoff), so a directory swapped for a
 * symlink or a file replaced since the walk is left alone. Node offers no
 * `unlinkat`, so the check and the removal remain two calls; the window
 * between them is what is left. Returns the number of files removed.
 */
export async function clearArtifactCache(sessionsDir: string, daysOld: number): Promise<{ removed: number }> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - daysOld);
	let removed = 0;
	const emptied = new Map<string, string>();
	await visitExpiredArtifacts(sessionsDir, cutoff, async (artifact, expectedDir) => {
		const dir = path.dirname(artifact.path);
		try {
			if (!(await isExpectedDirectory(dir, expectedDir))) return;
			const now = await fs.lstat(artifact.path);
			const same = now.isFile() && now.dev === artifact.dev && now.ino === artifact.ino;
			if (!same || now.mtime.getTime() !== artifact.mtime.getTime() || now.mtime >= cutoff) return;
			await fs.unlink(artifact.path);
		} catch {
			return; // Removed or replaced since the walk listed it.
		}
		removed++;
		// Ancestors below the session's own artifacts directory, which a live
		// session keeps writing into: `<sessions>/<project>/<session>/<dir>…`.
		let ancestor = dir;
		let expected = expectedDir;
		while (path.relative(sessionsDir, ancestor).split(path.sep).length > 2) {
			emptied.set(ancestor, expected);
			ancestor = path.dirname(ancestor);
			expected = path.dirname(expected);
		}
	});
	// Deepest first, so a parent is tried after its emptied children.
	for (const [dir, expected] of [...emptied].sort(([a], [b]) => b.length - a.length)) {
		try {
			if (await isExpectedDirectory(dir, expected)) await fs.rmdir(dir);
		} catch {
			// Not empty (it holds a transcript or a newer artifact), or already gone.
		}
	}
	return { removed };
}
