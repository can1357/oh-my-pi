/**
 * Read-only views over the user's local history, backing the `archive` eval
 * prelude: recent projects, their sessions with idle recaps, prompt history,
 * and session search over titles, recaps, and transcripts.
 *
 * Sources: sessions through the configured session storage (the JSONL files
 * under the sessions root, or the rows of a `session.storage: sql` table),
 * stat-ordered; only the listed sessions are read: a bounded header and tail,
 * a line scan (a SQL row in read windows) when those lack the first prompt or
 * a reply, and a windowed count where the index has none; history.db (prompt
 * history, the title index, and the recap journal), and the transcript index
 * (transcripts.db, or one per SQL store).
 * Each view returns plain records and a compact text rendering the prelude
 * prints. Records carry every declared key: an absent value is `null`, never
 * a missing key, so Python callers can index them directly.
 *
 * Scopes are resolved by the caller: a project is an absolute working
 * directory, and `undefined` spans every project.
 */
import * as path from "node:path";
import { previewLine, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatAge, formatCount, logger } from "@oh-my-pi/pi-utils";
import { type HistoryEntry, HistoryStorage } from "../session/history-storage";
import { type WordQuery, wordQuery } from "../session/search-query";
import { listSessionRecaps, listSessionTitles, type SessionRecap } from "../session/session-index";
import {
	findSessionFiles,
	listRecentProjects,
	listRecentSessions,
	readSessionInfo,
	type SessionInfo,
	type SessionStatus,
	sessionDisplayName,
} from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import {
	defaultSessionStorage,
	FileSessionStorage,
	readSessionLineWindows,
	type SessionStorage,
} from "../session/session-storage";
import { syncTranscripts } from "../daemon/modules/transcripts";
import {
	indexedMessageCounts,
	indexedSessionFiles,
	isTranscriptIndexFresh,
	transcriptMatches,
	transcriptSessionIds,
} from "../session/transcript-index";

/** A listed session. Times are ISO-8601. */
export interface ArchiveSession {
	id: string;
	/** Session JSONL file. */
	file: string;
	/** Working directory the session ran in. */
	project: string;
	/** Title, else first prompt, else a timestamp label. */
	title: string;
	created: string;
	modified: string;
	messages: number;
	status: SessionStatus | null;
	/** Newest journaled idle recap. */
	recap: string | null;
}

/** A project with its newest session. */
export interface ArchiveProject {
	/** Working directory; pass it as `project` to scope other views. */
	path: string;
	/** Session files in the project, empty ones included. */
	sessions: number;
	lastActive: string;
	latest: ArchiveSession;
}

/** A unique prompt from prompt history, with its latest submission's provenance. */
export interface ArchivePrompt {
	text: string;
	/** Latest submission time. */
	at: string;
	project: string | null;
	session: string | null;
	/** Submissions of this exact prompt. */
	uses: number;
}

/** A journaled idle recap. */
export interface ArchiveRecap {
	text: string;
	at: string;
	session: string;
	project: string;
}

/** Text in a session that answered a search. */
export interface ArchiveMatch {
	/** The title, an idle recap, or a user or assistant message of the transcript. */
	source: "title" | "recap" | "user" | "assistant";
	/** The whole title or recap; a message is cut to a snippet around the hit. */
	text: string;
	/** When the recap was journaled or the message sent; `null` for titles. */
	at: string | null;
}

/** A session whose title, recaps, or transcript answered a search. */
export interface ArchiveSearchHit extends ArchiveSession {
	/** The matching title, then matching recaps, then the newest matching messages, each newest first. */
	matches: ArchiveMatch[];
}

/** One session with its full recap journal and prompt history. */
export interface ArchiveSessionDetail extends ArchiveSession {
	/** Session file this one was forked from. */
	parent: string | null;
	/** Every journaled recap, oldest first. */
	recaps: ArchiveRecap[];
	/** Newest prompts submitted in this session, oldest first. */
	prompts: ArchivePrompt[];
}

/** Records plus the text rendering the prelude prints for them. */
export interface ArchiveView<T> {
	text: string;
	records: T;
}

/** Display width of a prompt preview in listings; records keep the full text. */
const PROMPT_PREVIEW_WIDTH = 160;
/** Display width of a prompt inside a session detail view. */
const PROMPT_DETAIL_WIDTH = 600;
/** Matching recaps and messages printed under a search hit; records keep them all. */
const SEARCH_MATCH_LINES = 3;
/** Newest matching messages a search hit carries. */
const SEARCH_MESSAGE_MATCHES = 5;
/** How long a search waits for the index to catch up before answering from what it holds. */
const TRANSCRIPT_SYNC_WAIT_MS = 1000;
/** A sync completed this recently, in any process, spares a search its catch-up. */
const TRANSCRIPT_FRESH_MS = 30_000;
/**
 * Listed id length. 13 characters cover the 48-bit millisecond timestamp of a
 * UUIDv7 id (and 48 random bits of a UUIDv4), so listed prefixes stay unique
 * in practice while every view accepts any unique prefix.
 */
const SHORT_ID_LENGTH = 13;

/** Recent projects, newest activity first. */
export async function archiveProjects(limit: number): Promise<ArchiveView<ArchiveProject[]>> {
	const projects = await listRecentProjects(limit);
	const latest = await withExactMessageCounts(projects.map(project => project.latest));
	const recaps = latestRecaps(projects.map(project => project.latest.id));
	const records = projects.map((project, index) => ({
		path: project.cwd,
		sessions: project.sessionCount,
		lastActive: project.latest.modified.toISOString(),
		latest: toArchiveSession(latest[index], recaps.get(project.latest.id)),
	}));
	if (records.length === 0) return { text: "No projects with sessions yet.", records };
	const lines = ["Recent projects, newest first:"];
	for (const project of records) {
		lines.push(
			`- ${shortenPath(project.path)} · ${formatCount("session", project.sessions)} · active ${ago(project.lastActive)}`,
			`  latest ${shortId(project.latest.id)} · ${project.latest.title}`,
		);
		if (project.latest.recap) lines.push(`  recap: ${previewLine(project.latest.recap, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

/** Newest non-empty sessions of one project (`cwd`) or of every project. */
export async function archiveSessions(cwd: string | undefined, limit: number): Promise<ArchiveView<ArchiveSession[]>> {
	const sessions = await withExactMessageCounts(
		await listRecentSessions({ limit, sessionDir: cwd ? sessionDirForCwd(cwd) : undefined }),
	);
	const recaps = latestRecaps(sessions.map(session => session.id));
	const records = sessions.map(session => toArchiveSession(session, recaps.get(session.id)));
	if (records.length === 0) return { text: `No sessions ${scopeLabel(cwd)}.`, records };
	const lines = [`Sessions ${scopeLabel(cwd)}, newest first:`];
	for (const session of records) {
		lines.push(sessionLine(session, cwd));
		if (session.recap) lines.push(`  recap: ${previewLine(session.recap, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

/**
 * Sessions of one project (`cwd`) or every project whose indexed title, a
 * journaled recap, or a user or assistant message holds every `query` term as
 * words ({@link WordQuery}), newest activity first. Brings the transcript index
 * up to date first, answering from what it holds when that takes longer than
 * {@link TRANSCRIPT_SYNC_WAIT_MS}; the listing then says so.
 */
export async function archiveSearch(
	query: string,
	cwd: string | undefined,
	limit: number,
): Promise<ArchiveView<ArchiveSearchHit[]>> {
	const words = wordQuery(query);
	const caughtUp = words ? await transcriptsCaughtUp() : true;
	const records = words ? await searchSessions(words, cwd, limit) : [];
	const subject = `${scopeLabel(cwd)} matching ${JSON.stringify(query)}`;
	const lines = records.length === 0 ? [`No sessions ${subject}.`] : [`Sessions ${subject}, newest first:`];
	for (const hit of records) {
		lines.push(sessionLine(hit, cwd));
		// The session line already shows the title.
		const shown = hit.matches.filter(match => match.source !== "title");
		for (const match of shown.slice(0, SEARCH_MATCH_LINES)) {
			const width = match.source === "recap" ? TRUNCATE_LENGTHS.RECAP : PROMPT_PREVIEW_WIDTH;
			lines.push(`  ${match.source}: ${previewLine(match.text, width)}`);
		}
		if (shown.length > SEARCH_MATCH_LINES) lines.push(`  … ${shown.length - SEARCH_MATCH_LINES} more`);
	}
	if (!caughtUp) {
		lines.push(
			"Transcript index is still catching up: messages of recent or not yet indexed sessions may be missing.",
		);
	}
	return { text: lines.join("\n"), records };
}

/** The newest `limit` sessions matching `words`, each with its matches. */
async function searchSessions(words: WordQuery, cwd: string | undefined, limit: number): Promise<ArchiveSearchHit[]> {
	const matches = new Map<string, ArchiveMatch[]>();
	const add = (session: string, match: ArchiveMatch) => {
		const found = matches.get(session);
		if (found) found.push(match);
		else matches.set(session, [match]);
	};
	for (const [session, title] of listSessionTitles()) {
		if (words.test(title)) add(session, { source: "title", text: title, at: null });
	}
	for (const recap of listSessionRecaps({ cwd }).map(toArchiveRecap)) {
		if (words.test(recap.text)) add(recap.session, { source: "recap", text: recap.text, at: recap.at });
	}
	const ids = transcriptSessionIds(words, cwd);
	for (const session of matches.keys()) ids.add(session);
	// The index knows every synced session's file; a directory scan would cost more than the search.
	const files = indexedSessionFiles(ids, cwd);
	if (files.length === 0) return [];
	const sessions = await withExactMessageCounts(await listRecentSessions({ limit, files }));
	const listed = sessions.map(session => session.id);
	for (const match of transcriptMatches(words, listed, SEARCH_MESSAGE_MATCHES)) {
		add(match.sessionId, { source: match.role, text: match.snippet, at: new Date(match.at).toISOString() });
	}
	const recaps = latestRecaps(listed);
	return sessions.map(session => ({
		...toArchiveSession(session, recaps.get(session.id)),
		matches: matches.get(session.id) ?? [],
	}));
}

/**
 * Brings the transcript index up to date, off this thread, unless a sync
 * completed within {@link TRANSCRIPT_FRESH_MS}; waits up to
 * {@link TRANSCRIPT_SYNC_WAIT_MS}. False while the sync still runs (here or in
 * another process), after it failed, or when it could not read a session
 * through; true when there is no index to sync.
 */
async function transcriptsCaughtUp(): Promise<boolean> {
	if (isTranscriptIndexFresh(TRANSCRIPT_FRESH_MS)) return true;
	const wait = AbortSignal.timeout(TRANSCRIPT_SYNC_WAIT_MS);
	try {
		const { outcome } = await syncTranscripts(wait);
		return outcome === "synced" || outcome === "unavailable";
	} catch (error) {
		if (!wait.aborted) logger.warn("Transcript index sync failed", { error: String(error) });
		return false;
	}
}

/**
 * One session by id prefix or absolute file path, with every recap and its
 * newest `limit` prompts.
 *
 * @throws {ToolError} when no session or several sessions match, or the file is not a session.
 */
export async function archiveSession(idOrFile: string, limit: number): Promise<ArchiveView<ArchiveSessionDetail>> {
	const file = path.isAbsolute(idOrFile) ? idOrFile : await resolveSessionFile(idOrFile);
	const read = await readSessionInfo(file);
	if (!read) throw new ToolError(`Not a readable session file: ${shortenPath(file)}`);
	const [info] = await withExactMessageCounts([read]);
	const recaps = listSessionRecaps({ sessionIds: [info.id] })
		.map(toArchiveRecap)
		.reverse();
	const prompts = HistoryStorage.open().getRecent(limit, { sessionId: info.id }).map(toArchivePrompt).reverse();
	const record: ArchiveSessionDetail = {
		...toArchiveSession(info, recaps.at(-1)?.text),
		parent: info.parentSessionPath ?? null,
		recaps,
		prompts,
	};

	const facts = [`project ${shortenPath(record.project)}`, `created ${ago(record.created)}`];
	facts.push(`active ${ago(record.modified)}`, formatCount("msg", record.messages));
	if (record.status) facts.push(record.status);
	const lines = [`Session ${record.id} · ${record.title}`, facts.join(" · "), `file ${shortenPath(record.file)}`];
	if (record.parent) lines.push(`forked from ${shortenPath(record.parent)}`);
	lines.push("");
	if (recaps.length === 0) lines.push("No recaps journaled.");
	else {
		lines.push("Recaps, oldest first:");
		for (const recap of recaps) lines.push(`- ${ago(recap.at)}: ${previewLine(recap.text, TRUNCATE_LENGTHS.RECAP)}`);
	}
	if (prompts.length === 0) lines.push("No prompts in prompt history.");
	else {
		const more = prompts.length === limit ? `latest ${limit}, ` : "";
		lines.push(`Prompts, ${more}oldest first:`);
		for (const prompt of prompts) lines.push(`- ${ago(prompt.at)}: ${previewLine(prompt.text, PROMPT_DETAIL_WIDTH)}`);
	}
	return { text: lines.join("\n"), records: record };
}

/** Prompt history of one project (`cwd`) or every project, newest first; `query` keeps prompts holding every term at the start of a word. */
export function archivePrompts(
	query: string | undefined,
	cwd: string | undefined,
	limit: number,
): ArchiveView<ArchivePrompt[]> {
	const history = HistoryStorage.open();
	const filter = { cwd };
	let entries: HistoryEntry[] = [];
	if (query === undefined) entries = history.getRecent(limit, filter);
	else {
		const words = wordQuery(query);
		if (words) entries = history.searchWords(words, limit, filter);
	}
	const records = entries.map(toArchivePrompt);
	const subject = query ? `${scopeLabel(cwd)} matching ${JSON.stringify(query)}` : scopeLabel(cwd);
	if (records.length === 0) return { text: `No prompts ${subject}.`, records };
	const lines = [`Prompts ${subject}, newest first:`];
	for (const prompt of records) {
		const facts = [ago(prompt.at)];
		if (!cwd && prompt.project) facts.push(shortenPath(prompt.project));
		if (prompt.session) facts.push(shortId(prompt.session));
		if (prompt.uses > 1) facts.push(`used ${prompt.uses}×`);
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(prompt.text, PROMPT_PREVIEW_WIDTH)}`);
	}
	return { text: lines.join("\n"), records };
}

/** Journaled idle recaps of one project (`cwd`) or every project, newest first. */
export function archiveRecaps(cwd: string | undefined, limit: number): ArchiveView<ArchiveRecap[]> {
	const records = listSessionRecaps({ cwd, limit }).map(toArchiveRecap);
	if (records.length === 0) return { text: `No recaps ${scopeLabel(cwd)}.`, records };
	const lines = [`Recaps ${scopeLabel(cwd)}, newest first:`];
	for (const recap of records) {
		const facts = [ago(recap.at)];
		if (!cwd) facts.push(shortenPath(recap.project));
		facts.push(shortId(recap.session));
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(recap.text, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

async function resolveSessionFile(idPrefix: string): Promise<string> {
	const files = await findSessionFiles(idPrefix);
	if (files.length === 1) return files[0];
	if (files.length === 0) throw new ToolError(`No session id starts with "${idPrefix}".`);
	const ids = files.slice(0, 5).map(file => {
		const name = path.basename(file, ".jsonl");
		return name.slice(name.lastIndexOf("_") + 1);
	});
	throw new ToolError(`"${idPrefix}" matches ${files.length} sessions (${ids.join(", ")}); use a longer prefix.`);
}

/** A message record starts its line; the file's first line counts through a synthetic leading newline. */
const MESSAGE_RECORD_LINE = Buffer.from('\n{"type":"message"');
const messageCountCache = new Map<string, { size: number; mtimeMs: number; count: number }>();

/** Message records in a whole session transcript; listings only parse a bounded prefix. Cached by size and mtime. */
async function countSessionMessages(
	file: string,
	size: number,
	mtimeMs: number,
	storage: SessionStorage,
): Promise<number> {
	const cached = messageCountCache.get(file);
	if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.count;
	let count = 0;
	// The previous chunk's last bytes, so a record line split across chunks still matches once.
	let carry: Buffer = Buffer.from("\n");
	const chunks =
		storage instanceof FileSessionStorage ? Bun.file(file).stream() : readSessionLineWindows(storage, file);
	for await (const chunk of chunks) {
		const window = Buffer.concat([carry, chunk]);
		for (let at = window.indexOf(MESSAGE_RECORD_LINE); at !== -1; at = window.indexOf(MESSAGE_RECORD_LINE, at + 1)) {
			count++;
		}
		carry = window.subarray(Math.max(0, window.length - (MESSAGE_RECORD_LINE.length - 1)));
	}
	messageCountCache.set(file, { size, mtimeMs, count });
	return count;
}

/**
 * `sessions` with whole-transcript message counts: the transcript index's where
 * it is current, else a read of the transcript. Session files are counted
 * together; a key-indexed store's transcripts one after another, so one window
 * of one transcript is in memory at a time.
 */
async function withExactMessageCounts(sessions: SessionInfo[]): Promise<SessionInfo[]> {
	const storage = defaultSessionStorage();
	const indexed = indexedMessageCounts(sessions.map(session => ({ path: session.path, size: session.size })));
	const withCount = async (session: SessionInfo): Promise<SessionInfo> => {
		try {
			const messageCount =
				indexed.get(session.path) ??
				(await countSessionMessages(session.path, session.size, session.modified.getTime(), storage));
			return { ...session, messageCount };
		} catch {
			return session;
		}
	};
	if (storage instanceof FileSessionStorage) return await Promise.all(sessions.map(withCount));
	const counted: SessionInfo[] = [];
	for (const session of sessions) counted.push(await withCount(session));
	return counted;
}

/** One listing line: `id · age · [project ·] msgs · [status ·] title`; the project shows only across projects. */
function sessionLine(session: ArchiveSession, cwd: string | undefined): string {
	const facts = [shortId(session.id), ago(session.modified)];
	if (!cwd && session.project) facts.push(shortenPath(session.project));
	facts.push(formatCount("msg", session.messages));
	if (session.status && session.status !== "complete" && session.status !== "unknown") facts.push(session.status);
	facts.push(session.title);
	return `- ${facts.join(" · ")}`;
}

/** Newest recap per session id. */
function latestRecaps(sessionIds: string[]): Map<string, string> {
	const latest = new Map<string, string>();
	for (const row of listSessionRecaps({ sessionIds })) {
		if (!latest.has(row.sessionId)) latest.set(row.sessionId, row.recap);
	}
	return latest;
}

function toArchiveSession(info: SessionInfo, recap: string | undefined): ArchiveSession {
	// Headers without a timestamp parse to an Invalid Date, whose toISOString throws.
	const created = Number.isNaN(info.created.getTime()) ? info.modified : info.created;
	return {
		id: info.id,
		file: info.path,
		project: info.cwd,
		title: sessionDisplayName(info),
		created: created.toISOString(),
		modified: info.modified.toISOString(),
		messages: info.messageCount,
		status: info.status ?? null,
		recap: recap ?? null,
	};
}

function toArchivePrompt(entry: HistoryEntry): ArchivePrompt {
	return {
		text: entry.prompt,
		at: new Date(entry.created_at * 1000).toISOString(),
		project: entry.cwd ?? null,
		session: entry.sessionId ?? null,
		uses: entry.useCount,
	};
}

function toArchiveRecap(row: SessionRecap): ArchiveRecap {
	return {
		text: row.recap,
		at: new Date(row.createdAt * 1000).toISOString(),
		session: row.sessionId,
		project: row.cwd,
	};
}

/** `in ~/project` or `across all projects`, for view headers. */
function scopeLabel(cwd: string | undefined): string {
	return cwd ? `in ${shortenPath(cwd)}` : "across all projects";
}

/** Relative age of an ISO timestamp (`5m ago`); sub-minute ages read `just now`. */
function ago(iso: string): string {
	return formatAge(Math.max(1, (Date.now() - Date.parse(iso)) / 1000));
}

function shortId(id: string): string {
	return id.slice(0, SHORT_ID_LENGTH);
}
