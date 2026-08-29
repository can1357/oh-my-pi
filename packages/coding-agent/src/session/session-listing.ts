import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { getAgentDir as getDefaultAgentDir, logger, parseJsonlLenient, toError } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { computeDefaultSessionDir } from "./session-paths";
import { FileSessionStorage, type SessionStorage, type SessionStorageStat } from "./session-storage";
import { lookupSessionTitle, recordSessionTitle } from "./title-index";

/**
 * Coarse lifecycle status of a session, derived from its last persisted message.
 *
 * - `complete` — the last assistant turn ended with no unanswered tool calls, i.e.
 *   the agent yielded control back to the user.
 * - `interrupted` — work was cut off mid-flight: a trailing assistant turn with
 *   pending tool calls, a trailing tool result the agent never continued from, or
 *   a length-truncated turn.
 * - `aborted` — the last assistant turn was cancelled by the user.
 * - `error` — the last assistant turn ended in an error.
 * - `pending` — a trailing user message with no assistant reply persisted after it.
 * - `unknown` — status could not be determined (empty/header-only session, or the
 *   final message was larger than the tail window that was read).
 */
export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

export interface SessionInfo {
	path: string;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	title?: string;
	/** Path to the parent session (if this session was forked). */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** File size in bytes on disk; used for compact list rendering. */
	size: number;
	firstMessage: string;
	allMessagesText: string;
	/**
	 * Coarse lifecycle status from the session's last persisted message. Optional:
	 * synthesized {@link SessionInfo}s (cross-project stubs, tests) leave it unset.
	 */
	status?: SessionStatus;
}

export interface ResolvedSessionMatch {
	session: SessionInfo;
	scope: "local" | "global";
}

/** Lightweight metadata for a recent session, used in welcome/picker UI. */
export interface RecentSessionInfo {
	path: string;
	name: string;
	timeAgo: string;
}

const SESSION_LIST_PREFIX_BYTES = 4096;
/**
 * Tail window read to derive {@link SessionStatus}. Large enough to capture a
 * typical final assistant turn (thinking + text); when the final message exceeds
 * it the status falls back to `unknown` rather than misreporting.
 */
const SESSION_LIST_SUFFIX_BYTES = 32_768;
const SESSION_LIST_PARALLEL_THRESHOLD = 64;
const SESSION_LIST_MAX_WORKERS = 16;

/**
 * Memoizes {@link scanSessionFile} results keyed by stat identity so listing
 * refreshes (resume picker opens, startup recent-sessions, cross-project
 * scans) skip the open+read+parse for unchanged files. The `statSync` still
 * runs on every scan — it IS the invalidation check: a hit requires both
 * `mtimeMs` and `size` to match. This covers the two mutation paths:
 * - streaming appends grow `size` (and bump `mtimeMs`);
 * - `updateSessionTitle` rewrites the fixed-width title slot in place via
 *   `writeSync`, which leaves `size` unchanged but updates `mtimeMs`.
 * Negative results (unparseable files) are cached too, as `undefined` info.
 * Entries are small header objects, so a generous cap is cheap.
 */
const SESSION_SCAN_CACHE_MAX = 4096;

interface SessionScanCacheEntry {
	mtimeMs: number;
	size: number;
	info: SessionInfo | undefined;
}

type SessionScanCache = LRUCache<string, SessionScanCacheEntry>;

/** All {@link FileSessionStorage} instances view the same real filesystem, so they share one cache. */
const fileSessionScanCache: SessionScanCache = new LRUCache({ max: SESSION_SCAN_CACHE_MAX });
/** Other storages (in-memory test doubles) each carry their own cache to avoid cross-instance path collisions. */
const kScanCache = Symbol("session-listing.scanCache");

interface StorageWithScanCache extends SessionStorage {
	[kScanCache]?: SessionScanCache;
}

function getSessionScanCache(storage: SessionStorage): SessionScanCache {
	if (storage instanceof FileSessionStorage) return fileSessionScanCache;
	const holder = storage as StorageWithScanCache;
	if (!holder[kScanCache]) holder[kScanCache] = new LRUCache({ max: SESSION_SCAN_CACHE_MAX });
	return holder[kScanCache];
}

function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Format a time difference as a human-readable string */
function formatTimeAgo(date: Date): string {
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

/**
 * Friendly display name for a session: explicit title, then first user prompt,
 * then a timestamp-based label. The raw UUID `id` is intentionally never used —
 * it is unfriendly and indistinguishable from neighboring sessions in the UI.
 */
function sessionDisplayName(info: SessionInfo): string {
	const title = sanitizeSessionName(info.title);
	if (title) return title;
	const first =
		info.firstMessage && info.firstMessage !== "(no messages)" ? sanitizeSessionName(info.firstMessage) : undefined;
	if (first) return first;
	const created = info.created.getTime();
	const ts = Number.isFinite(created) ? created : info.modified.getTime();
	const date = new Date(ts);
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `Untitled · ${time}`;
}

function extractTextFromContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const text: string[] = [];
	for (const block of content) {
		if (block.type === "text") text.push(block.text);
	}
	return text.join(" ");
}

/**
 * Derive a {@link SessionStatus} from a tail window of a session file. Entries are
 * newline-terminated on write, so within the window only the first line can be a
 * partial fragment — it simply fails to parse and is skipped. We walk backwards to
 * the last `message` entry and classify by its role / stop reason.
 */
function deriveSessionStatus(suffix: string): SessionStatus {
	if (!suffix) return "unknown";
	const lines = suffix.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		// Every persisted entry is `JSON.stringify(obj)` → starts with `{`. This
		// cheaply rejects blank lines and the leading partial fragment without
		// attempting to parse a multi-KB tail of a truncated line.
		if (line.charCodeAt(0) !== 123) continue;
		let entry: { type?: string; message?: TailMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "message" && entry.message) {
			return statusFromTailMessage(entry.message);
		}
	}
	return "unknown";
}

interface TailMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

function isToolCallBlock(block: unknown): boolean {
	return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall";
}

function statusFromTailMessage(message: TailMessage): SessionStatus {
	switch (message.role) {
		case "assistant": {
			switch (message.stopReason) {
				case "error":
					return "error";
				case "aborted":
					return "aborted";
				case "length":
					return "interrupted";
			}
			// A turn that ends without unanswered tool calls means the agent yielded
			// control back to the user — complete. Trailing tool calls (no tool
			// results after) mean the loop was cut off before running them.
			const content = message.content;
			if (Array.isArray(content) && content.some(isToolCallBlock)) return "interrupted";
			return "complete";
		}
		case "toolResult":
			// Tools ran but the agent never produced the following assistant turn.
			return "interrupted";
		case "user":
			// User message with no assistant reply persisted after it.
			return "pending";
		default:
			return "unknown";
	}
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

function extractStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) {
			return decodeJsonStringFragment(source.slice(valueStart, i));
		}
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

function countMessageMarkers(content: string): number {
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const typeIndex = content.indexOf('"type"', index);
		if (typeIndex === -1) break;
		const colonIndex = content.indexOf(":", typeIndex + 6);
		if (colonIndex === -1) break;
		const type = extractStringProperty(content, "type", typeIndex);
		if (type === "message") count++;
		index = colonIndex + 1;
	}
	return count;
}

function extractFirstDisplayMessageFromPrefix(content: string): string | undefined {
	let fallback: string | undefined;
	let index = content.indexOf('"role"');

	while (index !== -1) {
		const role = extractStringProperty(content, "role", index);
		const text = extractStringProperty(content, "content", index) ?? extractStringProperty(content, "text", index);
		if (text) {
			if (role === "user") return text;
			if (!fallback && (role === "developer" || role === "assistant")) fallback = text;
		}
		index = content.indexOf('"role"', index + 6);
	}

	return fallback;
}

interface SessionListHeader {
	type: "session";
	id: string;
	cwd?: string;
	title?: string;
	parentSession?: string;
	timestamp?: string;
}

function normalizeTitleOverride(title: string | undefined): string | null | undefined {
	if (title === undefined) return undefined;
	return title.trim() ? title : null;
}

function sessionListHeaderFromRecord(
	record: Record<string, unknown> | undefined,
	titleOverride?: string | null,
): SessionListHeader | undefined {
	if (record?.type !== "session" || typeof record.id !== "string") return undefined;
	return {
		type: "session",
		id: record.id,
		cwd: typeof record.cwd === "string" ? record.cwd : undefined,
		title:
			titleOverride === null
				? undefined
				: (titleOverride ?? (typeof record.title === "string" ? record.title : undefined)),
		parentSession: typeof record.parentSession === "string" ? record.parentSession : undefined,
		timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
	};
}

function parseSessionListHeaderLine(line: string, titleOverride?: string | null): SessionListHeader | undefined {
	if (extractStringProperty(line, "type") !== "session") return undefined;
	const id = extractStringProperty(line, "id");
	if (!id) return undefined;
	return {
		type: "session",
		id,
		cwd: extractStringProperty(line, "cwd"),
		title: titleOverride === null ? undefined : (titleOverride ?? extractStringProperty(line, "title")),
		parentSession: extractStringProperty(line, "parentSession"),
		timestamp: extractStringProperty(line, "timestamp"),
	};
}

function parseSessionListHeader(
	content: string,
	entries: Array<Record<string, unknown>>,
): SessionListHeader | undefined {
	const firstEntry = entries[0];
	const parsedSlotTitle = normalizeTitleOverride(
		firstEntry?.type === "title" && typeof firstEntry.title === "string" ? firstEntry.title : undefined,
	);
	const parsedHeader = sessionListHeaderFromRecord(entries[firstEntry?.type === "title" ? 1 : 0], parsedSlotTitle);
	if (parsedHeader) return parsedHeader;

	let slotTitle: string | null | undefined;
	let firstNonEmpty = true;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (firstNonEmpty && extractStringProperty(line, "type") === "title") {
			slotTitle = normalizeTitleOverride(extractStringProperty(line, "title"));
			firstNonEmpty = false;
			continue;
		}
		return parseSessionListHeaderLine(line, slotTitle);
	}
	return undefined;
}

function getSessionListWorkerCount(fileCount: number): number {
	if (fileCount <= SESSION_LIST_PARALLEL_THRESHOLD) return 1;
	return Math.min(
		SESSION_LIST_MAX_WORKERS,
		os.availableParallelism(),
		Math.ceil(fileCount / SESSION_LIST_PARALLEL_THRESHOLD),
	);
}

/**
 * Scan a single session file into a {@link SessionInfo}. Always reads the 4 KB
 * header/first-message prefix; only reads the 32 KB tail window (and derives
 * {@link SessionStatus}) when `withStatus` is set — the recent/most-recent
 * lookups skip it.
 */
async function scanSessionFile(
	file: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo | undefined> {
	let stat: SessionStorageStat;
	try {
		stat = storage.statSync(file);
	} catch {
		// Missing/unstatable file: no stat identity to cache under.
		return undefined;
	}
	const cache = getSessionScanCache(storage);
	// `withStatus` changes what a scan reads (tail window) and returns, so the
	// two variants are cached under distinct keys.
	const cacheKey = withStatus ? `s\0${file}` : `h\0${file}`;
	const cached = cache.get(cacheKey);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.info ? { ...cached.info } : undefined;
	}
	try {
		const [content, suffix] = await storage.readTextSlices(
			file,
			SESSION_LIST_PREFIX_BYTES,
			withStatus ? SESSION_LIST_SUFFIX_BYTES : 0,
		);
		const { size, mtime } = stat;
		const entries = parseJsonlLenient<Record<string, unknown>>(content);
		const header = parseSessionListHeader(content, entries);
		if (!header) {
			// Cache the negative result too: an unparseable file stays unparseable
			// until its stat identity changes.
			cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, info: undefined });
			return undefined;
		}

		let parsedMessageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let shortSummary: string | undefined;

		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as { type?: string; message?: Message; shortSummary?: string };

			if (entry.type === "compaction" && typeof entry.shortSummary === "string") {
				shortSummary = entry.shortSummary;
			}

			if (entry.type === "message" && entry.message) {
				parsedMessageCount++;

				if (entry.message.role === "user" || entry.message.role === "assistant") {
					const textContent = extractTextFromContent(entry.message.content);

					if (textContent) {
						allMessages.push(textContent);

						if (!firstMessage && entry.message.role === "user") {
							firstMessage = textContent;
						}
					}
				}
			}
		}

		firstMessage ||= extractFirstDisplayMessageFromPrefix(content) ?? "";
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
		const info: SessionInfo = {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			parentSessionPath: header.parentSession,
			created: new Date(header.timestamp ?? ""),
			modified: mtime,
			messageCount,
			size,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.length > 0 ? allMessages.join(" ") : firstMessage,
			status: withStatus ? deriveSessionStatus(suffix) : undefined,
		};
		// The cache keeps its own shallow copy; hits also hand out copies, so
		// callers can never mutate the shared cached object.
		cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, info: { ...info } });
		return info;
	} catch {
		return undefined;
	}
}

async function collectSessionsFromFileStride(
	files: string[],
	storage: SessionStorage,
	startIndex: number,
	stride: number,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];

	for (let i = startIndex; i < files.length; i += stride) {
		const session = await scanSessionFile(files[i], storage, withStatus);
		if (session) sessions.push(session);
	}

	return sessions;
}

async function collectSessionsFromFiles(
	files: string[],
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	const workerCount = getSessionListWorkerCount(files.length);
	const sessions =
		workerCount === 1
			? await collectSessionsFromFileStride(files, storage, 0, 1, withStatus)
			: (
					await Promise.all(
						Array.from({ length: workerCount }, (_, workerIndex) =>
							collectSessionsFromFileStride(files, storage, workerIndex, workerCount, withStatus),
						),
					)
				).flat();

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/**
 * Promote orphaned `<basename>.jsonl.<snowflake>.bak` backups created by the
 * EPERM-rewrite path back to their primary path when the primary is missing.
 * This runs once per session-dir scan, before the main `*.jsonl` glob, so a
 * crash between the two renames in the EPERM-rewrite path does not leave the
 * user's last good state stranded outside the loader's view.
 *
 * Exported for testing.
 */
export async function recoverOrphanedBackups(sessionDir: string, storage: SessionStorage): Promise<void> {
	let backups: string[];
	try {
		backups = storage.listFilesSync(sessionDir, "*.bak");
	} catch {
		return;
	}
	if (backups.length === 0) return;
	// For each primary path, pick the newest backup (highest mtime) as the recovery source.
	const candidates = new Map<string, { backup: string; mtimeMs: number }>();
	for (const backup of backups) {
		const name = path.basename(backup);
		// Expect "<primary>.<snowflake>.bak" where <primary> ends in ".jsonl".
		if (!name.endsWith(".bak")) continue;
		const trimmed = name.slice(0, -".bak".length);
		const dotIdx = trimmed.lastIndexOf(".");
		if (dotIdx <= 0) continue;
		const primaryName = trimmed.slice(0, dotIdx);
		if (!primaryName.endsWith(".jsonl")) continue;
		const primaryPath = path.join(sessionDir, primaryName);
		let mtimeMs = 0;
		try {
			mtimeMs = storage.statSync(backup).mtimeMs;
		} catch {
			continue;
		}
		const existing = candidates.get(primaryPath);
		if (!existing || mtimeMs > existing.mtimeMs) {
			candidates.set(primaryPath, { backup, mtimeMs });
		}
	}
	for (const [primaryPath, { backup }] of candidates) {
		if (storage.existsSync(primaryPath)) continue;
		try {
			await storage.rename(backup, primaryPath);
			logger.warn("Recovered orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
			});
		} catch (err) {
			logger.warn("Failed to recover orphaned session backup", {
				sessionFile: primaryPath,
				backupPath: backup,
				error: toError(err).message,
			});
		}
	}
}

async function scanSessionDir(
	sessionDir: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	try {
		await recoverOrphanedBackups(sessionDir, storage);
		const files = storage.listFilesSync(sessionDir, "*.jsonl");
		return await collectSessionsFromFiles(files, storage, withStatus);
	} catch {
		return [];
	}
}

async function scanSessionDirReadOnly(
	sessionDir: string,
	storage: SessionStorage,
	withStatus: boolean,
): Promise<SessionInfo[]> {
	try {
		const files = storage.listFilesSync(sessionDir, "*.jsonl");
		return await collectSessionsFromFiles(files, storage, withStatus);
	} catch {
		return [];
	}
}

/**
 * List sessions in a resolved session directory (newest first), reading each
 * file's lifecycle {@link SessionStatus}.
 */
export function listSessions(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDir(sessionDir, storage, true);
}

/**
 * List sessions without repairing orphaned backups or mutating the directory.
 */
export function listSessionsReadOnly(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDirReadOnly(sessionDir, storage, true);
}

/** List all sessions across all project directories (newest first). */
export async function listAllSessions(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
	const sessionsRoot = path.join(getDefaultAgentDir(), "sessions");
	try {
		const files = await Array.fromAsync(new Bun.Glob("*/*.jsonl").scan(sessionsRoot), name =>
			path.join(sessionsRoot, name),
		);
		return await collectSessionsFromFiles(files, storage, true);
	} catch {
		return [];
	}
}

/** Exported for testing */
export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await scanSessionDir(sessionDir, storage, false);
	return sessions[0]?.path ?? null;
}

/** Session id embedded in a `<file-safe-timestamp>_<id>.jsonl` filename, if present. */
function sessionIdFromSessionPath(file: string): string | undefined {
	const base = path.basename(file);
	if (!base.endsWith(".jsonl")) return undefined;
	const sep = base.lastIndexOf("_");
	if (sep <= 0) return undefined;
	return base.slice(sep + 1, -".jsonl".length) || undefined;
}

/**
 * Get recent sessions for display in the welcome screen.
 *
 * Deliberately avoids {@link scanSessionDir}'s full-directory content scan
 * (multi-hundred-ms with thousands of sessions): lists files, sorts by mtime,
 * and resolves names for the newest `limit` files from the history.db title
 * index. Files without an indexed title (legacy sessions, branch/fork copies)
 * fall back to a per-file header scan whose title — when present — is
 * backfilled into the index so the next launch skips the read.
 */
export async function getRecentSessions(
	sessionDir: string,
	limit = 4,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<RecentSessionInfo[]> {
	let files: string[];
	try {
		files = storage.listFilesSync(sessionDir, "*.jsonl");
	} catch {
		return [];
	}
	const byMtime: Array<{ file: string; stat: SessionStorageStat }> = [];
	for (const file of files) {
		try {
			byMtime.push({ file, stat: storage.statSync(file) });
		} catch {
			// Vanished between glob and stat; skip.
		}
	}
	byMtime.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

	// The index is keyed by real session ids; in-memory test storages must not
	// touch the process-wide history.db.
	const useIndex = storage instanceof FileSessionStorage;
	const recent: RecentSessionInfo[] = [];
	for (const { file, stat } of byMtime) {
		if (recent.length >= limit) break;
		const id = useIndex ? sessionIdFromSessionPath(file) : undefined;
		const indexed = id ? lookupSessionTitle(id) : undefined;
		if (indexed) {
			recent.push({ path: file, name: indexed, timeAgo: formatTimeAgo(stat.mtime) });
			continue;
		}
		const info = await scanSessionFile(file, storage, false);
		if (!info) continue;
		const title = sanitizeSessionName(info.title);
		if (useIndex && title && info.id) recordSessionTitle(info.id, title);
		recent.push({ path: file, name: sessionDisplayName(info), timeAgo: formatTimeAgo(info.modified) });
	}
	return recent;
}

function sessionMatchesResumeArg(session: SessionInfo, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	const normalizedId = session.id.toLowerCase();
	if (normalizedId.startsWith(normalizedArg)) {
		return true;
	}

	const fileName = path.basename(session.path, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) {
		return true;
	}

	const separator = fileName.lastIndexOf("_");
	if (separator < 0) {
		return false;
	}

	const fileSessionId = fileName.slice(separator + 1);
	return fileSessionId.startsWith(normalizedArg);
}

/** Controls cross-directory fallback for resumable session lookup. */
export interface ResolveResumableSessionOptions {
	/** Search default global session buckets after the active/custom session directory misses. */
	allowGlobalFallback?: boolean;
}

function isSessionStorage(value: SessionStorage | ResolveResumableSessionOptions): value is SessionStorage {
	return "listFilesSync" in value;
}

export async function resolveResumableSession(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	storageOrOptions: SessionStorage | ResolveResumableSessionOptions = new FileSessionStorage(),
	options: ResolveResumableSessionOptions = {},
): Promise<ResolvedSessionMatch | undefined> {
	const storage = isSessionStorage(storageOrOptions) ? storageOrOptions : new FileSessionStorage();
	const resolvedOptions = isSessionStorage(storageOrOptions) ? options : storageOrOptions;
	const localSessionDir = sessionDir ?? computeDefaultSessionDir(cwd, storage);
	const localSessions = await listSessions(localSessionDir, storage);
	const localMatch = localSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (localMatch) {
		return { session: localMatch, scope: "local" };
	}

	if (sessionDir && resolvedOptions.allowGlobalFallback !== true) {
		return undefined;
	}

	const globalSessions = await listAllSessions(storage);
	const globalMatch = globalSessions.find(session => sessionMatchesResumeArg(session, sessionArg));
	if (!globalMatch) {
		return undefined;
	}

	return { session: globalMatch, scope: "global" };
}
