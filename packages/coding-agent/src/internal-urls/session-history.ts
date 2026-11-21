import * as path from "node:path";
import { fuzzyFilter } from "@oh-my-pi/pi-tui/fuzzy";
import { previewLine, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { getProjectDir, normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import {
	isForeignSession,
	listAllSessions,
	listSessionsReadOnly,
	sessionDisplayName,
	type SessionInfo,
} from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import type { InternalUrl, ResolveContext } from "./types";

const SESSION_HOST = "session";
const BROWSE_PATH = "/browse";
const BROWSE_PREFIX = `${BROWSE_PATH}/`;
/** Completion target for the top-level session index, without the history scheme. */
export const SESSION_HISTORY_TARGET = `${SESSION_HOST}${BROWSE_PATH}`;
const SESSION_INDEX = `history://${SESSION_HISTORY_TARGET}`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_ID_SUGGESTIONS = 5;

/** Parsed request to list or read persisted top-level sessions in the selected scope. */
export type SessionHistoryRequest = { scope: "project" | "all" } & (
	| { kind: "index"; limit: number; offset: number; query: string }
	| { kind: "transcript"; id: string; full: boolean }
);

/** IDs may be encoded, but must be a single non-path segment even after decoding. */
function parseHistoryId(segment: string): string {
	let id: string;
	try {
		id = decodeURIComponent(segment);
	} catch {
		throw new Error(`Invalid history URL encoding; use ${SESSION_INDEX}/<id>`);
	}
	if (!isHistoryId(id)) {
		throw new Error(`Expected a single ID, not a path; use ${SESSION_INDEX}/<id>`);
	}
	return id;
}

function isHistoryId(id: string): boolean {
	return id !== "" && id !== "." && id !== ".." && id.isWellFormed() && !/[/\\:\s\x00-\x1f\x7f-\x9f]/.test(id);
}

function integerParam(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
	const value = params.get(key);
	if (value === null) return fallback;
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
		throw new Error(`Invalid ${key}; expected an integer from ${min} to ${max}`);
	}
	return number;
}

/** Parse the top-level history route, returning undefined for other routes and throwing on invalid parameters. */
export function parseSessionHistory(url: InternalUrl): SessionHistoryRequest | undefined {
	// Like current/full, reserve a subpath, not a name in the agent roster.
	if ((url.rawHost || url.hostname).toLowerCase() !== SESSION_HOST) return undefined;
	const rawPath = url.rawPathname ?? url.pathname;
	if (rawPath !== BROWSE_PATH && !rawPath.startsWith(BROWSE_PREFIX)) return undefined;
	if (url.hash) throw new Error(`${SESSION_INDEX} does not accept fragments`);
	const segment = rawPath.slice(BROWSE_PREFIX.length);
	const isIndex = segment === "";
	const params = url.searchParams;
	const seen = new Set<string>();
	for (const key of params.keys()) {
		if (key !== "scope" && !(isIndex ? key === "limit" || key === "offset" || key === "q" : key === "full")) {
			throw new Error(`Unsupported ${SESSION_INDEX} parameter: ${JSON.stringify(key)}`);
		}
		if (seen.has(key)) throw new Error(`Repeated ${SESSION_INDEX} parameter: ${key}`);
		seen.add(key);
	}
	const scope = params.get("scope") ?? "project";
	if (scope !== "project" && scope !== "all") throw new Error("Expected scope=project or scope=all");
	if (isIndex) {
		return {
			kind: "index",
			scope,
			limit: integerParam(params, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
			offset: integerParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
			query: params.get("q")?.trim() ?? "",
		};
	}
	const full = params.get("full") ?? "0";
	if (full !== "0" && full !== "1") throw new Error("Expected full=0 or full=1");
	return { kind: "transcript", scope, id: parseHistoryId(segment), full: full === "1" };
}

/** Inventory only the on-disk managed session buckets; never repair or resume a journal. */
export async function listHistorySessions(
	scope: SessionHistoryRequest["scope"],
	context?: ResolveContext,
): Promise<SessionInfo[]> {
	const cwd = context?.cwd ?? getProjectDir();
	const sessions =
		scope === "all"
			? await listAllSessions()
			: await listSessionsReadOnly(sessionDirForCwd(cwd), new FileSessionStorage());
	const seenIds = new Set<string>();
	const projectMatches = new Map<string, boolean>();
	let project: string | undefined;
	return sessions.filter(session => {
		if (isForeignSession(session) || seenIds.has(session.id) || !isHistoryId(session.id)) return false;
		// Directory names flatten path separators (e.g. a/b and a-b). Check
		// the header too, without splitting projects reached through aliases.
		if (scope === "project" && session.cwd !== cwd) {
			if (!path.isAbsolute(session.cwd)) return false;
			let matches = projectMatches.get(session.cwd);
			if (matches === undefined) {
				project ??= normalizePathForComparison(cwd);
				matches = normalizePathForComparison(session.cwd) === project;
				projectMatches.set(session.cwd, matches);
			}
			if (!matches) return false;
		}
		// The inventory is newest first. Copies of the same header ID do not
		// create extra rows or make an otherwise unique prefix ambiguous.
		seenIds.add(session.id);
		return true;
	});
}

function metadataLine(value: string): string {
	return previewLine(sanitizeText(value.replaceAll("\r", "\n")), TRUNCATE_LENGTHS.CONTENT).replaceAll(
		/[\\`*_[\]|<>&]/g,
		"\\$&",
	);
}

/** Render the session display name as a single line of escaped Markdown. */
export function historySessionTitle(session: SessionInfo): string {
	return metadataLine(sessionDisplayName(session));
}

function indexUrl(scope: SessionHistoryRequest["scope"]): string {
	return scope === "all" ? `${SESSION_INDEX}?scope=all` : SESSION_INDEX;
}

function sessionHint(session: SessionInfo): string {
	return `${encodeURIComponent(session.id)} — ${historySessionTitle(session)}`;
}

/** Resolve an exact header ID or a unique case-insensitive prefix, throwing on a miss or ambiguity. */
export function findHistorySession(
	sessions: SessionInfo[],
	request: Extract<SessionHistoryRequest, { kind: "transcript" }>,
): SessionInfo;
/** Resolve an ID as above, but return undefined for a miss while still rejecting ambiguity. */
export function findHistorySession(
	sessions: SessionInfo[],
	request: Extract<SessionHistoryRequest, { kind: "transcript" }>,
	allowMissing: true,
): SessionInfo | undefined;
export function findHistorySession(
	sessions: SessionInfo[],
	request: Extract<SessionHistoryRequest, { kind: "transcript" }>,
	allowMissing = false,
): SessionInfo | undefined {
	const prefix = request.id.toLowerCase();
	const matches: SessionInfo[] = [];
	let count = 0;
	for (const session of sessions) {
		if (session.id === request.id) return session;
		if (!session.id.toLowerCase().startsWith(prefix)) continue;
		count++;
		if (matches.length < MAX_ID_SUGGESTIONS) matches.push(session);
	}
	if (count === 1) return matches[0];
	if (count > 1) {
		throw new Error(
			`Ambiguous session ID prefix ${request.id} (${count} matches in ${indexUrl(request.scope)}):\n${matches.map(sessionHint).join("\n")}`,
		);
	}
	if (allowMissing) return undefined;
	const suggestions = fuzzyFilter(sessions, request.id, session => session.id).slice(0, MAX_ID_SUGGESTIONS);
	const hints = [`Unknown session ID: ${request.id}`, `List sessions with ${indexUrl(request.scope)}.`];
	if (suggestions.length > 0) hints.push("Did you mean:", ...suggestions.map(sessionHint));
	if (request.scope === "project") hints.push(`For other projects, use ${indexUrl("all")}.`);
	throw new Error(hints.join("\n"));
}

/** Render one page of matching sessions, with a next-page link when more results remain. */
export function renderHistorySessionIndex(
	sessions: SessionInfo[],
	request: Extract<SessionHistoryRequest, { kind: "index" }>,
	currentSessionId?: string,
): string {
	const { scope, offset, limit, query } = request;
	if (query) {
		const q = query.toLowerCase();
		sessions = sessions.filter(
			session =>
				session.id.toLowerCase().includes(q) ||
				session.title?.toLowerCase().includes(q) ||
				session.firstMessage.toLowerCase().includes(q) ||
				session.cwd.toLowerCase().includes(q),
		);
	}
	const page = sessions.slice(offset, offset + limit);
	const lines = ["# Top-level sessions", ""];
	if (page.length === 0) {
		lines.push(`No sessions on this page (${sessions.length} matching).`);
	} else {
		lines.push(
			`Showing ${offset + 1}–${offset + page.length} of ${sessions.length}.`,
			"",
			"| ID | Title | Updated (UTC) | Project |",
			"|---|---|---|---|",
		);
		for (const session of page) {
			const current = session.id === currentSessionId ? " (current)" : "";
			lines.push(
				`| \`${encodeURIComponent(session.id)}\` | ${historySessionTitle(session)}${current} | ${session.modified.toISOString()} | ${metadataLine(shortenPath(session.cwd)) || "—"} |`,
			);
		}
	}
	if (offset + page.length < sessions.length) {
		const params = new URLSearchParams({ limit: String(limit), offset: String(offset + page.length) });
		if (scope === "all") params.set("scope", scope);
		if (query) params.set("q", query);
		lines.push("", `Next page: \`${SESSION_INDEX}?${params}\`.`);
	}
	const querySuffix = scope === "all" ? "?scope=all" : "";
	lines.push("", `Read a transcript with \`read ${SESSION_INDEX}/<id>${querySuffix}\`.`);
	return `${lines.join("\n")}\n`;
}
