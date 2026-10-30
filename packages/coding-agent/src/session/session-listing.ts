import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils/stream";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { EVAL_STATE_CONTEXT_TYPE } from "../eval/state";
import { visitEntriesFromFile } from "./session-loader";
import { computeDefaultSessionDir } from "./session-paths";
import { FileSessionStorage, type SessionStorage, type SessionStorageStat } from "./session-storage";
import { lookupSessionTitle, recordSessionTitle } from "./session-index";

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
	/** Id of the session whose conversation this one continues in a new file (header `continuationOf`). */
	continuationOf?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	/** Persisted assistant turns; zero means the agent never replied (0-turn session). */
	assistantTurns?: number;
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
export function sessionDisplayName(info: SessionInfo): string {
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

function countRoleMarkers(content: string, role: "assistant" | "user" | "message"): number {
	const key = role === "message" ? '"type"' : '"role"';
	const want = role === "message" ? "message" : role;
	let count = 0;
	let index = 0;
	while (index < content.length) {
		const keyIndex = content.indexOf(key, index);
		if (keyIndex === -1) break;
		const colonIndex = content.indexOf(":", keyIndex + key.length);
		if (colonIndex === -1) break;
		const value = extractStringProperty(content, role === "message" ? "type" : "role", keyIndex);
		if (value === want) count++;
		index = colonIndex + 1;
	}
	return count;
}

function countMessageMarkers(content: string): number {
	return countRoleMarkers(content, "message");
}

function countAssistantMarkers(content: string): number {
	return countRoleMarkers(content, "assistant");
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
	continuationOf?: string;
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
		continuationOf: typeof record.continuationOf === "string" ? record.continuationOf : undefined,
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
		continuationOf: extractStringProperty(line, "continuationOf"),
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
	knownStat?: SessionStorageStat,
): Promise<SessionInfo | undefined> {
	let stat: SessionStorageStat;
	try {
		stat = knownStat ?? storage.statSync(file);
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
		let assistantTurns = 0;
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
				if (entry.message.role === "assistant") assistantTurns++;

				if (entry.message.role === "user" || entry.message.role === "assistant") {
					const messageText = textContent(entry.message.content, " ");

					if (messageText) {
						allMessages.push(messageText);

						if (!firstMessage && entry.message.role === "user") {
							firstMessage = messageText;
						}
					}
				}
			}
		}

		firstMessage ||= extractFirstDisplayMessageFromPrefix(content) ?? "";
		const messageCount = Math.max(parsedMessageCount, countMessageMarkers(content));
		// Either bounded window may hold the only copy of an assistant record,
		// and neither may: a >prefix record before a >suffix tail leaves the
		// middle unexamined. When both windows miss, ask the backend for a full
		// line-boundary scan rather than trusting the gap.
		assistantTurns = Math.max(assistantTurns, countAssistantMarkers(content), countAssistantMarkers(suffix));
		if (assistantTurns === 0 && storage.hasAssistantTurn) {
			try {
				if (await storage.hasAssistantTurn(file)) assistantTurns = 1;
			} catch {
				// Backend unreadable: keep the bounded-window evidence.
			}
		}
		const info: SessionInfo = {
			path: file,
			id: header.id,
			cwd: header.cwd ?? "",
			title: header.title ?? shortSummary,
			parentSessionPath: header.parentSession,
			continuationOf: header.continuationOf,
			created: new Date(header.timestamp ?? ""),
			modified: mtime,
			messageCount,
			assistantTurns,
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

	sessions.sort(
		(a, b) =>
			b.modified.getTime() - a.modified.getTime() ||
			b.created.getTime() - a.created.getTime() ||
			b.path.localeCompare(a.path),
	);
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
		// The primary is the backup's sibling: strip the suffix from the listed path instead of
		// re-joining `sessionDir`, so the key keeps the storage's own spelling of the directory.
		const primaryPath = backup.slice(0, backup.length - (name.length - primaryName.length));
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
	siblingDirs: readonly string[] = [],
): Promise<SessionInfo[]> {
	try {
		await recoverOrphanedBackups(sessionDir, storage);
		const files = [sessionDir, ...siblingDirs].flatMap(dir => storage.listFilesSync(dir, "*.jsonl"));
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
 * file's lifecycle {@link SessionStatus}. `siblingDirs` merge into the same
 * list; they belong to other working directories (see `worktreeSessionDirs`),
 * so orphaned-backup recovery runs on `sessionDir` only.
 */
export function listSessions(
	sessionDir: string,
	storage: SessionStorage,
	siblingDirs: readonly string[] = [],
): Promise<SessionInfo[]> {
	return scanSessionDir(sessionDir, storage, true, siblingDirs);
}

/**
 * List sessions without repairing orphaned backups or mutating the directory.
 */
export function listSessionsReadOnly(sessionDir: string, storage: SessionStorage): Promise<SessionInfo[]> {
	return scanSessionDirReadOnly(sessionDir, storage, true);
}

/** List all sessions across all project directories (newest first). */
export async function listAllSessions(
	storage: SessionStorage = new FileSessionStorage(),
	sessionsRoot: string = getSessionsDir(),
): Promise<SessionInfo[]> {
	try {
		const files = await dedupeRealPaths(await scanBucketFiles(sessionsRoot, "*.jsonl"));
		return await collectSessionsFromFiles(files, storage, true);
	} catch {
		return [];
	}
}
/**
 * True when a scanned session is a 0-turn stub with no display name: the tail
 * lifecycle shows no assistant activity (pending user-only or unscannable)
 * and neither a title nor a first prompt worth showing. Covers header-only
 * records (`newSession()` boundaries, `ensureOnDisk()` stubs, drafts) and
 * user-only sessions whose prompt text never made the prefix scan. A title or
 * first prompt is user intent worth resuming, so named 0-turn sessions stay
 * discoverable. The tail — not the 4 KB prefix — decides answered-ness, so a
 * transcript whose first assistant record starts past the prefix is never
 * elided. The picker and `--continue` skip these; every other consumer (GC,
 * ACP, `resolveResumableSession`) keeps the unfiltered scan.
 */
export function isEmptySession(session: SessionInfo): boolean {
	if (session.status !== undefined && session.status !== "pending" && session.status !== "unknown") return false;
	if ((session.assistantTurns ?? 1) > 0) return false;
	if (sanitizeSessionName(session.title)) return false;
	if (sanitizeSessionName(session.firstMessage === "(no messages)" ? undefined : session.firstMessage)) return false;
	return true;
}

/** Picker-facing view of a session list: empties dropped, pinned sessions kept. */
export function filterSessionsForPicker(sessions: SessionInfo[], pinnedIds: ReadonlySet<string>): SessionInfo[] {
	return sessions.filter(session => pinnedIds.has(session.id) || !isEmptySession(session));
}

/** Most recent session with resumable content, skipping 0-turn empties. Exported for testing. */
export async function findMostRecentNonEmptySession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	// Status on: answered-ness comes from the tail lifecycle, not the 4 KB
	// prefix, so a transcript whose first assistant record starts past the
	// prefix is never skipped.
	const sessions = await scanSessionDir(sessionDir, storage, true);
	return sessions.find(session => !isEmptySession(session))?.path ?? null;
}

/** Exported for testing */
export async function findMostRecentSession(
	sessionDir: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<string | null> {
	const sessions = await scanSessionDir(sessionDir, storage, false);
	return sessions[0]?.path ?? null;
}

/** Where the conversation of a resumed session file went on (see {@link findSessionContinuation}). */
export interface SessionContinuation {
	/** The copy of the conversation to resume: the one with the newest turn. */
	session: SessionInfo;
	/** The session file that was asked for, or that `--continue` picked. */
	from: string;
	/**
	 * Set when `session` is not a file `from` went on in: an older copy that
	 * `from` continues (`earlier`), or a copy on another branch of the same
	 * conversation (`other`). Only {@link findRecentSessionContinuation} sets it.
	 */
	relation?: "earlier" | "other";
	/**
	 * Copies `from`'s conversation went on in, `from` and `session` included;
	 * a copy left behind by one that went on after it does not count.
	 */
	copies: number;
}

/** First tail window {@link lastActivity} reads; it grows when one large entry fills it. */
const ACTIVITY_TAIL_BYTES = 65_536;

/**
 * Entry types that move the conversation: its turns, and the reset boundary
 * `/clear` leaves, after which a resume rebuilds no earlier turn. Everything
 * else a process appends can land long after the last turn without moving it:
 * the `session_exit` record every exiting process writes, the usage of cache
 * refreshes sent while idle, an idle compaction (it only summarizes entries
 * every copy already holds), settings changes, labels and extension state.
 */
const CONVERSATION_ENTRY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	branch_summary: true,
	reset_boundary: true,
};

/** The newest conversation entry of a session file. */
interface SessionActivity {
	/** Epoch milliseconds of the entry. */
	time: number;
	/** The entry's id; `undefined` when the file holds no such entry. */
	id: string | undefined;
}

/**
 * The newest entry in `session` whose type is in {@link CONVERSATION_ENTRY_TYPES},
 * other than an eval-state snapshot (a `custom_message` at startup, a `message`
 * after a compaction): when the conversation last moved, not when a process
 * last wrote. Falls back to the header's creation time, and to `-Infinity`
 * for an unreadable file.
 */
async function lastActivity(session: SessionInfo, storage: SessionStorage): Promise<SessionActivity> {
	for (let window = ACTIVITY_TAIL_BYTES; ; window *= 4) {
		let suffix: string;
		try {
			[, suffix] = await storage.readTextSlices(session.path, 0, window);
		} catch {
			return { time: Number.NEGATIVE_INFINITY, id: undefined };
		}
		const lines = suffix.split("\n");
		let reachedHeader = false;
		for (let i = lines.length - 1; i >= 0 && !reachedHeader; i--) {
			const line = lines[i];
			// Same cheap rejection as deriveSessionStatus: blank lines and the leading partial fragment.
			if (line.charCodeAt(0) !== 123) continue;
			let entry: {
				type?: unknown;
				timestamp?: unknown;
				id?: unknown;
				customType?: unknown;
				message?: { role?: unknown; customType?: unknown };
			};
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			// The header carries the session id, not an entry id; the creation time below covers it.
			reachedHeader = entry.type === "session";
			if (typeof entry.type !== "string" || !Object.hasOwn(CONVERSATION_ENTRY_TYPES, entry.type)) continue;
			const customType = entry.type === "custom_message" ? entry.customType : entry.message?.customType;
			if (customType === EVAL_STATE_CONTEXT_TYPE) continue;
			const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			if (Number.isFinite(time)) return { time, id: typeof entry.id === "string" ? entry.id : undefined };
		}
		if (reachedHeader || window >= session.size) {
			const created = session.created.getTime();
			return { time: Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY, id: undefined };
		}
	}
}

/** True when the session file at `file` holds an entry with id `id`. */
async function holdsEntry(file: string, id: string, storage: SessionStorage): Promise<boolean> {
	let found = false;
	try {
		await visitEntriesFromFile(
			file,
			entry => {
				// The header's id is the session's, never an entry's.
				if (entry.type === "session" || entry.id !== id) return;
				found = true;
				return false;
			},
			storage,
		);
	} catch {
		return false;
	}
	return found;
}

/**
 * The creation time (epoch milliseconds) and session id a generated
 * `<file-safe timestamp>_<id>.jsonl` name records
 * (`2026-10-26T18-29-27-740Z_…`, the ISO time with `:` and `.` replaced);
 * `undefined` for any other name.
 */
function parseSessionFileName(file: string): { createdAt: number; id: string } | undefined {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/.exec(path.basename(file));
	if (!match) return undefined;
	const createdAt = Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
	return Number.isFinite(createdAt) ? { createdAt, id: match[5] } : undefined;
}

/** Options for {@link findSessionContinuation}. */
export interface FindSessionContinuationOptions {
	/**
	 * The file was asked for by its name's session id (`--resume <id>` that
	 * matched the file name, not the session the file holds): when the file
	 * now holds another session, follow the session its name records.
	 */
	matchedByFileName?: boolean;
}

/**
 * The copy of `sessionPath`'s conversation to resume, when that conversation
 * went on in other files of the same directory; `undefined` when
 * `sessionPath` itself is the copy to resume.
 *
 * A session that cannot keep writing its file (another live omp process
 * holds it, or the file changed under it) continues in a sibling whose
 * header names the old session in `continuationOf`, and that sibling can
 * move on the same way. Resuming the
 * old file again would revive the conversation as it was before the move,
 * so resume follows those links and takes the copy with the newest turn,
 * keeping `sessionPath` on a tie. A link is followed only when the copy holds
 * the newest turn of the copy it continues: when that copy went on after the
 * move (its own process kept writing it), both hold turns the other lacks,
 * so the one it continues stays the one resumed, as `sessionPath` would.
 * Forks never set `continuationOf`, so a deliberate fork is never followed.
 *
 * A file that no longer holds the session its generated name records was
 * replaced under that session, which went on in a sibling and left the file
 * as it found it (`SessionPersistenceNotice` reason `replaced`). The file
 * then holds none of that conversation, so the copies that continue the
 * session its name records are followed instead, and the file itself is
 * never returned. This applies when the file no longer reads as a session at
 * all, and, with `matchedByFileName`, when it holds another session; a file
 * named by path that holds another session resumes as that session. A file
 * without a generated name records no session id, so it is never taken as replaced.
 *
 * A continuation is named `<move time>_<id>.jsonl` and moves only after the
 * session it continues was created, so only files named after that creation
 * time are read: resuming a recent session reads almost nothing.
 */
export async function findSessionContinuation(
	sessionPath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: FindSessionContinuationOptions = {},
): Promise<SessionContinuation | undefined> {
	const target = path.resolve(sessionPath);
	const start = await scanSessionFile(target, storage, false);
	const named = parseSessionFileName(target);
	const replaced =
		named !== undefined &&
		(start ? options.matchedByFileName === true && start.id !== named.id : storage.existsSync(target));
	let rootId: string;
	let since: number;
	if (replaced) {
		rootId = named.id;
		since = named.createdAt;
	} else if (start) {
		rootId = start.id;
		since = start.created.getTime();
	} else {
		return undefined;
	}
	const continuations = await continuationsAfter(target, since, storage);
	const children = continuations.get(rootId);
	if (!children) return undefined;
	const activityOf = activityReader(storage);
	// A replaced file holds no turn of the session its name records, so every
	// copy that continues that session counts; otherwise the file is the first copy.
	const copies = replaced || !start ? [...children] : [start];
	const seen = new Set([target, ...copies.map(copy => copy.path)]);
	for (let i = 0; i < copies.length; i++) {
		const next = continuations.get(copies[i].id);
		if (!next) continue;
		const { id: newestTurn } = await activityOf(copies[i]);
		for (const copy of next) {
			if (seen.has(copy.path)) continue;
			seen.add(copy.path);
			if (newestTurn !== undefined && !(await holdsEntry(copy.path, newestTurn, storage))) continue;
			copies.push(copy);
		}
	}
	let newest = replaced ? undefined : start;
	let newestTime = newest ? (await activityOf(newest)).time : Number.NEGATIVE_INFINITY;
	for (const copy of copies) {
		const { time } = await activityOf(copy);
		if (time <= newestTime) continue;
		newest = copy;
		newestTime = time;
	}
	if (!newest || newest.path === target) return undefined;
	// The replaced file counts as the copy the others went on from, so the notice counts the same way.
	const count = replaced ? copies.length + 1 : copies.length;
	logger.info("Resuming the newest copy of a session that continued in another file", {
		from: target,
		to: newest.path,
		copies: count,
		replaced,
	});
	return { session: newest, from: target, copies: count };
}

/** The session a resume key names, and the copy of its conversation to open (see {@link resolveResumeTarget}). */
export interface ResumeTarget {
	/** The copy to open: `match`, or the copy its conversation went on in. */
	session: SessionInfo;
	/** Set when `session` is not the session the key named; the caller reports it to the user. */
	continuation?: SessionContinuation;
}

/**
 * The session file a resume key (an id or filename prefix) opens:
 * {@link resolveResumableSession}, then the copy of that conversation to
 * resume ({@link findSessionContinuation}). `undefined` when nothing matches.
 *
 * A key that matched only a file's name asks for the session that name
 * records, so a file that now holds another session is followed to the copies
 * that continue the named one. A file that no longer reads as a session is
 * not listed at all; it is found here by its generated name, in the same
 * scopes the listing searched.
 */
export async function resolveResumeTarget(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	options: ResolveResumableSessionOptions = {},
): Promise<ResumeTarget | undefined> {
	const match = await resolveResumableSession(sessionArg, cwd, sessionDir, new FileSessionStorage(), options);
	const continuation = match
		? await findSessionContinuation(match.session.path, undefined, {
				matchedByFileName: !match.session.id.toLowerCase().startsWith(sessionArg.toLowerCase()),
			})
		: await findUnlistedSessionContinuation(sessionArg, cwd, sessionDir, options);
	const session = continuation?.session ?? match?.session;
	return session ? { session, continuation } : undefined;
}

/**
 * For a resume key that matched no listed session: the copy to resume of a
 * session whose file, found by `idPrefix` in its generated name, no longer
 * reads as a session (it was replaced; see {@link findSessionContinuation}).
 * The session listing skips such a file, but the copies that continue it
 * still name its id. Looks in `sessionDir` (else `cwd`'s default session
 * directory) and then, when the global fallback applies, in every project
 * directory, as {@link resolveResumableSession} does.
 */
async function findUnlistedSessionContinuation(
	idPrefix: string,
	cwd: string,
	sessionDir: string | undefined,
	options: ResolveResumableSessionOptions,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionContinuation | undefined> {
	const prefix = idPrefix.toLowerCase();
	if (!/^[\w-]+$/.test(prefix)) return undefined;
	const localDir = sessionDir ?? computeDefaultSessionDir(cwd, storage);
	const globalToo = !sessionDir || options.allowGlobalFallback === true;
	for (const scope of globalToo ? ["local", "global"] : ["local"]) {
		const files =
			scope === "local" ? storage.listFilesSync(localDir, `*_${prefix}*.jsonl`) : await findSessionFiles(prefix);
		for (const file of files) {
			if (!parseSessionFileName(file)?.id.startsWith(prefix)) continue;
			const continuation = await findSessionContinuation(file, storage, { matchedByFileName: true });
			if (continuation) return continuation;
		}
	}
	return undefined;
}

/**
 * The copy of the conversation in `sessionPath` to continue when `--continue`
 * or auto-resume picked `sessionPath` as the most recently written session
 * (or RPC `open_session` did): `undefined` when `sessionPath` itself is that copy.
 *
 * Unlike {@link findSessionContinuation}, nobody chose `sessionPath`, not
 * even through the terminal's record of its last session; it won on file
 * time, and a process writes its exit record or an idle cache refresh long
 * after its last turn, so the pick can be any copy, an older one included.
 * This looks at every copy linked to it by `continuationOf`, in both
 * directions, drops each copy a continuation of it holds entirely (the
 * continuation holds its newest turn), and takes the remaining copy with the
 * newest turn, keeping `sessionPath` on a tie. Two copies that both went on
 * after the move both remain, and the one with the later turn wins.
 */
export async function findRecentSessionContinuation(
	sessionPath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionContinuation | undefined> {
	const target = path.resolve(sessionPath);
	const picked = await scanSessionFile(target, storage, false);
	if (!picked) return undefined;
	// Walk the links up to the first copy.
	let root = picked;
	const ancestors = new Set([root.path]);
	while (root.continuationOf) {
		const parent = await findSessionInDirectory(path.dirname(target), root.continuationOf, storage);
		if (!parent || ancestors.has(parent.path)) break;
		ancestors.add(parent.path);
		root = parent;
	}
	const continuations = await continuationsAfter(root.path, root.created.getTime(), storage);
	if (root === picked && !continuations.has(root.id)) return undefined;
	const activityOf = activityReader(storage);
	const copies = [root];
	const seen = new Set([root.path]);
	const parentOf = new Map<string, SessionInfo>();
	const remaining: SessionInfo[] = [];
	for (let i = 0; i < copies.length; i++) {
		const copy = copies[i];
		const children = (continuations.get(copy.id) ?? []).filter(child => !seen.has(child.path));
		for (const child of children) {
			seen.add(child.path);
			parentOf.set(child.path, copy);
			copies.push(child);
		}
		const { id: newestTurn } = await activityOf(copy);
		let superseded = false;
		for (const child of children) {
			if (newestTurn === undefined || (await holdsEntry(child.path, newestTurn, storage))) {
				superseded = true;
				break;
			}
		}
		if (!superseded) remaining.push(copy);
	}
	let newest = remaining.find(copy => copy.path === picked.path);
	let newestTime = newest ? (await activityOf(newest)).time : Number.NEGATIVE_INFINITY;
	for (const copy of remaining) {
		const { time } = await activityOf(copy);
		if (time <= newestTime) continue;
		newest = copy;
		newestTime = time;
	}
	if (!newest || newest.path === picked.path) return undefined;
	// How the copy taken relates to the pick: a file the pick went on in (the
	// walk up from it reaches the pick), an older copy the pick continues, or a
	// copy on another branch of the family.
	let wentOnIn = 0;
	let step: SessionInfo | undefined = newest;
	while (step && step.path !== picked.path) {
		wentOnIn++;
		step = parentOf.get(step.path);
	}
	const relation = step ? undefined : ancestors.has(newest.path) ? "earlier" : "other";
	logger.info("Continuing the copy of a session with the newest turn", {
		from: picked.path,
		to: newest.path,
		relation: relation ?? "continuation",
	});
	return { session: newest, from: picked.path, copies: relation ? 2 : wentOnIn + 1, relation };
}

/**
 * The session with id `id` in directory `dir`. A session file is named
 * `<time>_<id>.jsonl`, except one a session resumed by path keeps writing
 * (`current.jsonl`), so only files with other names are read when that name misses.
 */
async function findSessionInDirectory(
	dir: string,
	id: string,
	storage: SessionStorage,
): Promise<SessionInfo | undefined> {
	const [namedFile] = storage.listFilesSync(dir, `*_${id}.jsonl`);
	const named = namedFile ? await scanSessionFile(path.resolve(namedFile), storage, false) : undefined;
	if (named?.id === id) return named;
	const otherNames = storage.listFilesSync(dir, "*.jsonl").filter(file => !parseSessionFileName(file));
	return (await collectSessionsFromFiles(otherNames, storage, false)).find(session => session.id === id);
}

/**
 * The sessions in the directory of `sessionFile`, other than it, that continue
 * another session, keyed by the id they continue. A continuation is named
 * `<move time>_<id>.jsonl` and moves only after the session it continues was
 * created (`since`, epoch milliseconds), so only files named after that time are read.
 */
async function continuationsAfter(
	sessionFile: string,
	since: number,
	storage: SessionStorage,
): Promise<Map<string, SessionInfo[]>> {
	const after = Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY;
	const self = path.resolve(sessionFile);
	const later = storage.listFilesSync(path.dirname(self), "*.jsonl").filter(file => {
		const name = parseSessionFileName(file);
		return name !== undefined && name.createdAt >= after && path.resolve(file) !== self;
	});
	const continuations = new Map<string, SessionInfo[]>();
	for (const session of await collectSessionsFromFiles(later, storage, false)) {
		if (!session.continuationOf) continue;
		const siblings = continuations.get(session.continuationOf);
		if (siblings) siblings.push(session);
		else continuations.set(session.continuationOf, [session]);
	}
	return continuations;
}

/** {@link lastActivity}, read once per session file. */
function activityReader(storage: SessionStorage): (copy: SessionInfo) => Promise<SessionActivity> {
	const activities = new Map<string, SessionActivity>();
	return async copy => {
		let activity = activities.get(copy.path);
		if (!activity) {
			activity = await lastActivity(copy, storage);
			activities.set(copy.path, activity);
		}
		return activity;
	};
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
 * The files with each physical file kept once, in first-seen order.
 *
 * A scan that follows symlinks reaches one transcript by more than one name
 * when a symlink and the file it points at both sit inside the sessions root,
 * under one bucket or two: each name is a match, so the session would be
 * counted twice and an id-prefix lookup would report an ambiguous match.
 * `realpath` collapses the aliases onto the transcript, while a second,
 * genuinely distinct copy keeps its own entry. A name that cannot be resolved
 * (removed between the scan and this call) is kept as it is: it was listed a
 * moment ago.
 */
async function dedupeRealPaths(files: readonly string[]): Promise<string[]> {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const file of files) {
		let key: string;
		try {
			key = await fs.promises.realpath(file);
		} catch {
			key = path.resolve(file);
		}
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(file);
	}
	return out;
}

/**
 * Session files matching `pattern` (a leaf pattern such as `*.jsonl`) under
 * every project bucket of `root`.
 *
 * A bucket that is itself a symlink is skipped rather than followed. Following
 * it does two things the fix must not: it lets a scan leave the sessions root
 * through a directory alias (`sessionsRoot/alias -> ../outside` would list
 * `outside/escaped.jsonl`), and it lists every session inside the real bucket
 * twice when one bucket aliases another (#5385). The leaf scan inside a real
 * bucket does follow symlinks, which is what #15878 asks for: a transcript
 * staged in as a symlink is a transcript.
 */
async function scanBucketFiles(root: string, pattern: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		for await (const name of new Bun.Glob(pattern).scan({ cwd: dir, followSymlinks: true })) {
			out.push(path.join(dir, name));
		}
	}
	return out;
}

/** A session file with its stat identity, before any content scan. */
interface StatedSessionFile {
	file: string;
	stat: SessionStorageStat;
}

/**
 * Files matching `pattern` under `root`, newest mtime first. Stat-only: costs
 * one glob plus one stat per file, never a content read. Files that vanish
 * between discovery and stat are dropped.
 */
async function newestSessionFiles(
	root: string,
	pattern: string,
	storage: SessionStorage,
): Promise<StatedSessionFile[]> {
	let files: string[];
	try {
		if (storage instanceof FileSessionStorage) {
			// A pattern that crosses buckets (`*/*.jsonl`) is scanned bucket by
			// bucket, so a symlinked bucket is skipped rather than followed; a
			// pattern within one directory has no bucket level to bound.
			const slash = pattern.lastIndexOf("/");
			files =
				slash >= 0
					? await dedupeRealPaths(await scanBucketFiles(root, pattern.slice(slash + 1)))
					: await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, followSymlinks: true }), name =>
							path.join(root, name),
						);
		} else {
			files = storage.listFilesSync(root, pattern);
		}
	} catch {
		return [];
	}
	const stated: StatedSessionFile[] = [];
	if (storage instanceof FileSessionStorage) {
		const stats = await Promise.all(
			files.map(async file => {
				try {
					return { file, stat: await fs.promises.stat(file) };
				} catch {
					return undefined;
				}
			}),
		);
		for (const entry of stats) {
			if (entry) stated.push(entry);
		}
	} else {
		for (const file of files) {
			try {
				stated.push({ file, stat: storage.statSync(file) });
			} catch {}
		}
	}
	return stated.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

/** Header-level {@link SessionInfo} with status for one session file; undefined when unreadable or not a session. */
export function readSessionInfo(file: string): Promise<SessionInfo | undefined> {
	return scanSessionFile(file, new FileSessionStorage(), true);
}

/** Selects which session files {@link listRecentSessions} considers. */
export interface RecentSessionsQuery {
	/** Maximum sessions returned. */
	limit: number;
	/** One project's session directory; omitted spans every project under `sessionsRoot`. */
	sessionDir?: string;
	/** Root holding one directory per project. Default: {@link getSessionsDir}. */
	sessionsRoot?: string;
}

/**
 * Newest non-empty sessions by mtime, with lifecycle status. Stats every
 * candidate file but content-scans only until `limit` sessions are found, so
 * it stays fast across tens of thousands of sessions where
 * {@link listAllSessions} scans everything.
 */
export async function listRecentSessions(query: RecentSessionsQuery): Promise<SessionInfo[]> {
	const storage = new FileSessionStorage();
	const files = query.sessionDir
		? await newestSessionFiles(query.sessionDir, "*.jsonl", storage)
		: await newestSessionFiles(query.sessionsRoot ?? getSessionsDir(), "*/*.jsonl", storage);
	const sessions: SessionInfo[] = [];
	for (const { file, stat } of files) {
		if (sessions.length >= query.limit) break;
		const info = await scanSessionFile(file, storage, true, stat);
		if (info && !isEmptySession(info)) sessions.push(info);
	}
	return sessions;
}

/** One project directory summarized from its session files. */
export interface ProjectSummary {
	/** Working directory recorded by the project's newest non-empty session. */
	cwd: string;
	/** Session files in the project's directory, 0-turn empties included. */
	sessionCount: number;
	/** Newest non-empty session; its `modified` is the project's last activity. */
	latest: SessionInfo;
}

/**
 * Projects by last activity, newest first. Stats every session file under
 * `sessionsRoot` but content-scans only the files needed to find each listed
 * project's newest non-empty session. Directories holding only empty sessions
 * are skipped; directories resolving to an already-listed cwd are not repeated.
 */
export async function listRecentProjects(
	limit: number,
	sessionsRoot: string = getSessionsDir(),
): Promise<ProjectSummary[]> {
	const storage = new FileSessionStorage();
	// Insertion order follows the newest-first file order, so directories come
	// out ordered by their newest session file.
	const byDir = new Map<string, StatedSessionFile[]>();
	for (const entry of await newestSessionFiles(sessionsRoot, "*/*.jsonl", storage)) {
		const dir = path.dirname(entry.file);
		const files = byDir.get(dir);
		if (files) files.push(entry);
		else byDir.set(dir, [entry]);
	}
	const projects: ProjectSummary[] = [];
	const listed = new Set<string>();
	for (const files of byDir.values()) {
		if (projects.length >= limit) break;
		for (const { file, stat } of files) {
			const info = await scanSessionFile(file, storage, true, stat);
			if (!info || isEmptySession(info)) continue;
			if (info.cwd && !listed.has(info.cwd)) {
				listed.add(info.cwd);
				projects.push({ cwd: info.cwd, sessionCount: files.length, latest: info });
			}
			break;
		}
	}
	// A directory's newest file may be an empty stub; order by the activity actually listed.
	return projects.sort((a, b) => b.latest.modified.getTime() - a.latest.modified.getTime());
}

/**
 * Session files under every project directory whose session id starts with
 * `idPrefix`, located by filename without reading content. Prefixes outside
 * `[A-Za-z0-9_-]` match nothing, so the prefix is never interpreted as a glob.
 */
export async function findSessionFiles(idPrefix: string, sessionsRoot: string = getSessionsDir()): Promise<string[]> {
	if (!/^[\w-]+$/.test(idPrefix)) return [];
	try {
		const files = await dedupeRealPaths(await scanBucketFiles(sessionsRoot, `*_${idPrefix}*.jsonl`));
		// `*_` can also match an underscore inside an id; keep true id-prefix matches only.
		return files.filter(file => sessionIdFromSessionPath(file)?.startsWith(idPrefix));
	} catch {
		return [];
	}
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
	// The index is keyed by real session ids; in-memory test storages must not
	// touch the process-wide history.db.
	const useIndex = storage instanceof FileSessionStorage;
	const recent: RecentSessionInfo[] = [];
	for (const { file, stat } of await newestSessionFiles(sessionDir, "*.jsonl", storage)) {
		if (recent.length >= limit) break;
		const id = useIndex ? sessionIdFromSessionPath(file) : undefined;
		const indexed = id ? lookupSessionTitle(id) : undefined;
		if (indexed) {
			recent.push({ path: file, name: indexed, timeAgo: formatTimeAgo(stat.mtime) });
			continue;
		}
		const info = await scanSessionFile(file, storage, true, stat);
		if (!info || isEmptySession(info)) continue;
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
