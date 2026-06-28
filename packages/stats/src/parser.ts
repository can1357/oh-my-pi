import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AssistantMessage, getPriorityPremiumRequests, type ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { getSessionsDir, isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import type {
	AgentType,
	MessageStats,
	SessionEntry,
	SessionMessageEntry,
	SessionServiceTierChangeEntry,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics } from "./user-metrics";

/** Basename of an advisor agent's transcript inside a session artifacts dir. */
const ADVISOR_TRANSCRIPT_BASENAME = "__advisor.jsonl";

/**
 * Classify which agent produced a transcript from its path within the sessions
 * directory. Layout: `<sessionsDir>/<project>/<file>.jsonl` is the `main`
 * agent; subagent and advisor transcripts live nested one level deeper inside
 * the session's artifacts dir (`<project>/<session>/<id>.jsonl`,
 * `<project>/<session>/__advisor.jsonl`). Any `__advisor.jsonl` — at any depth,
 * including a subagent's own advisor — counts as `advisor`; every other nested
 * transcript is a task `subagent`.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	if (path.basename(sessionPath) === ADVISOR_TRANSCRIPT_BASENAME) return "advisor";
	const rel = path.relative(getSessionsDir(), sessionPath);
	// `<project>/<file>.jsonl` -> 2 segments. Deeper nesting is a subagent.
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Extract folder name from session filename.
 * Session files are named like: --work--pi--/timestamp_uuid.jsonl
 * The folder part uses -- as path separator.
 */
function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	// Convert --work--pi-- to /work/pi
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

/**
 * Check if an entry is an assistant message.
 */
function isAssistantMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	// Legacy sessions (pre-id tracking) recorded message entries without an `id`.
	// They're not linkable and would violate the messages.entry_id NOT NULL
	// constraint, so skip them at the parser boundary.
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

/**
 * Check if an entry is a user message (non-toolResult).
 */
function isUserMessage(entry: SessionEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

/**
 * Check if an entry is a service-tier change.
 */
function isServiceTierChange(entry: SessionEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty/synthetic content.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
	if (msg.role !== "user" || msg.synthetic) return null;
	const text = extractUserText(msg.content);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
	};
}

/**
 * Extract stats from an assistant message entry.
 */
function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTier | undefined,
	agentType: AgentType,
): MessageStats | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;

	// Backfill: when the session recorded `priority` as the active service tier
	// at this point but the AI usage payload was captured before priority
	// requests were folded into `premiumRequests`, derive the count here so the
	// "Premium Reqs" stat aggregates priority traffic on re-sync. Trust any
	// non-zero value already in `usage.premiumRequests` (Copilot multipliers or
	// the new AI code path) and only synthesise when the field is missing/zero.
	const recorded = msg.usage.premiumRequests ?? 0;
	const derived = recorded > 0 ? recorded : getPriorityPremiumRequests(currentServiceTier, msg.provider);
	const usage = derived === recorded ? msg.usage : { ...msg.usage, premiumRequests: derived };

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: msg.timestamp,
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		stopReason: msg.stopReason,
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
	};
}

const LF = 0x0a;

function parseSessionEntriesLenient(bytes: Uint8Array): { entries: SessionEntry[]; read: number } {
	const entries: SessionEntry[] = [];
	let cursor = 0;

	while (cursor < bytes.length) {
		const { values, error, read, done } = Bun.JSONL.parseChunk(bytes, cursor, bytes.length);
		if (values.length > 0) {
			entries.push(...(values as SessionEntry[]));
		}

		if (error) {
			const nextNewline = bytes.indexOf(LF, Math.max(read, cursor));
			if (nextNewline === -1) break;
			cursor = nextNewline + 1;
			continue;
		}

		if (read <= cursor) break;
		cursor = read;
		if (done) break;
	}

	return { entries, read: cursor };
}

function scanLastServiceTier(bytes: Uint8Array): ServiceTier | undefined {
	let cursor = 0;
	let currentServiceTier: ServiceTier | undefined;

	while (cursor < bytes.length) {
		const { values, error, read, done } = Bun.JSONL.parseChunk(bytes, cursor, bytes.length);
		for (const value of values as SessionEntry[]) {
			if (isServiceTierChange(value)) currentServiceTier = value.serviceTier ?? undefined;
		}

		if (error) {
			const nextNewline = bytes.indexOf(LF, Math.max(read, cursor));
			if (nextNewline === -1) break;
			cursor = nextNewline + 1;
			continue;
		}

		if (read <= cursor) break;
		cursor = read;
		if (done) break;
	}

	return currentServiceTier;
}
/**
 * Parse a session file and extract all assistant message stats.
 * Uses incremental reading with offset tracking.
 *
 * Service-tier carry-over: `currentServiceTier` is a session-scoped piece of
 * state derived from `service_tier_change` entries that affects whether
 * subsequent OpenAI assistant replies count as premium requests. Incremental
 * syncs that resume past the most-recent tier change would otherwise lose
 * that state and silently record `premiumRequests = 0` for priority traffic
 * (the coding-agent stopped folding the tier into `usage.premiumRequests`
 * after 13f59162e — the parser is now the sole source of truth). When
 * `fromOffset > 0` we therefore scan the bytes preceding `fromOffset`
 * for the latest service-tier value before parsing the unprocessed tail.
 * The scan only keeps the current tier and does not materialize prefix
 * entries, preserving offset-based memory behavior for large sessions.
 */
export interface ParseSessionResult {
	stats: MessageStats[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	newOffset: number;
}
export async function parseSessionFile(sessionPath: string, fromOffset = 0): Promise<ParseSessionResult> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err)) return { stats: [], userStats: [], userLinks: [], newOffset: fromOffset };
		throw err;
	}

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStats[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const userByEntryId = new Map<string, UserMessageStats>();
	const start = Math.max(0, Math.min(fromOffset, bytes.length));
	const unprocessed = bytes.subarray(start);
	const { entries, read } = parseSessionEntriesLenient(unprocessed);
	let currentServiceTier: ServiceTier | undefined;
	if (start > 0) {
		currentServiceTier = scanLastServiceTier(bytes.subarray(0, start));
	}
	for (const entry of entries) {
		if (isServiceTierChange(entry)) {
			currentServiceTier = entry.serviceTier ?? undefined;
			continue;
		}
		if (isUserMessage(entry)) {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) {
				userStats.push(userMsg);
				userByEntryId.set(entry.id, userMsg);
			}
			continue;
		}
		if (isAssistantMessage(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, currentServiceTier, agentType);
			if (msgStats) stats.push(msgStats);
			// Link assistant's responding model back to the user message it answered.
			const parentId = (entry as SessionMessageEntry).parentId;
			if (parentId) {
				const msg = entry.message as AssistantMessage;
				if (msg.model && msg.provider) {
					// Emit unconditionally. The aggregator's UPDATE is guarded by
					// `model IS NULL` so this is idempotent: a no-op for already
					// linked rows, a fix-up for fresh inserts (which start NULL
					// because the user row is recorded before its reply lands) and
					// for cross-pass orphans whose parent was committed by an
					// earlier incremental sync.
					userLinks.push({
						sessionFile: sessionPath,
						entryId: parentId,
						model: msg.model,
						provider: msg.provider,
					});
				}
			}
		}
	}

	return { stats, userStats, userLinks, newOffset: start + read };
}

/**
 * List all session directories (folders).
 */
export async function listSessionFolders(): Promise<string[]> {
	try {
		const sessionsDir = getSessionsDir();
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files in a folder.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => path.join(e.parentPath, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files across all folders.
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const allFiles: string[] = [];

	for (const folder of folders) {
		const files = await listSessionFiles(folder);
		allFiles.push(...files);
	}

	return allFiles;
}

/**
 * Find a specific entry in a session file.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}

	const { entries } = parseSessionEntriesLenient(bytes);
	for (const entry of entries) {
		if ("id" in entry && entry.id === entryId) {
			return entry;
		}
	}
	return null;
}
