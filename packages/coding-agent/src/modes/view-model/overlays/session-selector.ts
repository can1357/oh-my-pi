import { FuzzyText } from "../../../utils/fuzzy";

/** Session lifecycle status presented by the picker. */
export type SessionSelectorStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

/** Session listing fields consumed by the picker. */
export interface SessionSelectorEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	modified: Date;
	created?: Date;
	size: number;
	firstMessage: string;
	allMessagesText: string;
	status?: SessionSelectorStatus;
	/** Path to the parent session when this one was forked. */
	parentSessionPath?: string;
}

/**
 * One picker scope's rows, possibly in two passes: `sessions` show at once
 * (e.g. rows built from a title index), and `complete` settles with the full
 * listing that replaces them, keeping the query, the selected session, and
 * deletes/renames made meanwhile.
 */
export interface SessionListing<T extends SessionSelectorEntry = SessionSelectorEntry> {
	sessions: T[];
	complete?: Promise<T[]>;
}

/** Returns the IDs of sessions whose recorded prompts match a query, best first. */
export type SessionHistoryMatcher = (query: string) => string[];

function sessionSearchText(session: SessionSelectorEntry): string {
	const parts = [
		session.id,
		session.title ?? "",
		session.cwd ?? "",
		session.firstMessage ?? "",
		session.allMessagesText,
		session.path,
	];
	return parts.filter(Boolean).join(" ");
}

/**
 * Lowercased search haystack, cached by row identity. A renamed row is a
 * copy with a new title and must not inherit the original row's haystack.
 * Rebuilding it per keystroke — a ~4KB string join plus `toLowerCase` per
 * session — was one of the costs that made resume search visibly lag.
 *
 * Only the string is cached. A prebuilt fuzzy index (~60KB per 4KB session)
 * would cost hundreds of MB on multi-thousand-session listings, so fuzzy
 * indexes are built transiently per scan visit instead (see
 * {@link scoreFuzzySession} callers).
 */
const searchTextCache = new WeakMap<SessionSelectorEntry, string>();

function sessionTextLower(session: SessionSelectorEntry): string {
	let textLower = searchTextCache.get(session);
	if (textLower === undefined) {
		textLower = sessionSearchText(session).toLowerCase();
		searchTextCache.set(session, textLower);
	}
	return textLower;
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionSelectorEntry, b: SessionSelectorEntry): number {
	return b.modified.getTime() - a.modified.getTime();
}

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

/** One ranked search hit; `index` is the session's position in the unfiltered list (recency order). */
interface RankedSessionMatch<T extends SessionSelectorEntry = SessionSelectorEntry> {
	session: T;
	score: number;
	index: number;
}

/**
 * True when every query token appears verbatim in the haystack. Literal
 * matches rank purely by recency, so they skip fuzzy scoring entirely — a pure
 * fast path, not a semantic change: a contiguous substring of the lowercased
 * text always lies within one normalized word per query sub-token, so every
 * literal token also fuzzy-matches.
 */
function isLiteralMatch(textLower: string, tokens: string[]): boolean {
	for (const token of tokens) {
		if (!textLower.includes(token)) return false;
	}
	return true;
}

/**
 * Fuzzy-score one non-literal session against every query token. Returns
 * undefined when a token fails to match or the weakest token is pure-fuzzy
 * noise. The caller builds `fuzzy` once per session visit so multi-token
 * queries share a single index.
 */
function scoreFuzzySession<T extends SessionSelectorEntry>(
	session: T,
	index: number,
	tokens: string[],
	fuzzy: FuzzyText,
): RankedSessionMatch<T> | undefined {
	let score = 0;
	let worstTokenScore = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		worstTokenScore = Math.max(worstTokenScore, match.score);
	}
	if (worstTokenScore >= MIN_PURE_FUZZY_TOKEN_SCORE) return undefined;
	return { session, score, index };
}

function compareLiteralRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return compareSessionRecency(a.session, b.session) || a.index - b.index;
}

function compareFuzzyRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
}

/** Exact titles lead partial titles; other matches retain their existing order. */
function prioritizeTitleMatches<T extends SessionSelectorEntry>(
	sessions: T[],
	tokens: string[],
	literal: RankedSessionMatch<T>[],
): T[] {
	const query = tokens.join(" ");
	const exact: T[] = [];
	const partial: T[] = [];
	const titleMatches = new Set<T>();
	// Title hits are literal matches, already ranked by recency and source index.
	for (const { session } of literal) {
		const title = session.title?.trim().toLowerCase().replace(/\s+/g, " ");
		if (title === query) exact.push(session);
		else if (title && isLiteralMatch(title, tokens)) partial.push(session);
		else continue;
		titleMatches.add(session);
	}
	if (titleMatches.size === 0) return sessions;
	return [...exact, ...partial, ...sessions.filter(session => !titleMatches.has(session))];
}

/**
 * Filter and rank session picker search results.
 *
 * Exact and partial title matches lead. Other literal matches rank by recency
 * rather than a slightly better fuzzy position match. Pure fuzzy/acronym
 * matches still sort by fuzzy score after literal matches, but weak pure
 * fuzzy tokens are dropped as noise. `historyIds` (prompt-history matches)
 * merge in after the title matches, ahead of the other metadata matches.
 */
export function rankSessionSearchMatches<T extends SessionSelectorEntry>(
	allSessions: T[],
	query: string,
	historyIds: string[] = [],
): T[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const literal: RankedSessionMatch<T>[] = [];
	const fuzzyMatches: RankedSessionMatch<T>[] = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const textLower = sessionTextLower(session);
		if (isLiteralMatch(textLower, tokens)) {
			literal.push({ session, score: 0, index });
			continue;
		}
		const match = scoreFuzzySession(session, index, tokens, new FuzzyText(textLower));
		if (match) fuzzyMatches.push(match);
	}

	literal.sort(compareLiteralRank);
	fuzzyMatches.sort(compareFuzzyRank);
	const out: T[] = [];
	for (const match of literal) out.push(match.session);
	for (const match of fuzzyMatches) out.push(match.session);
	return prioritizeTitleMatches(mergeSessionRanking(allSessions, out, historyIds), tokens, literal);
}

/**
 * Combine metadata matches with prompt-history matches for ranking, using both
 * signals rather than replacing one with the other.
 *
 * - `fuzzy` is the ordered metadata/session-text result.
 * - `historyIds` are session IDs whose recorded prompts matched the query,
 *   ordered by prompt-history rank (typically newest matching prompt first); duplicates are tolerated.
 *
 * Ranking: prompt-history matches lead in history order, then remaining
 * metadata matches keep their existing order. A metadata match is never dropped,
 * and history matches not present in `allSessions` (e.g. deleted or out-of-scope
 * sessions) are ignored since they cannot be resumed from here.
 */
export function mergeSessionRanking<T extends SessionSelectorEntry>(
	allSessions: T[],
	fuzzy: T[],
	historyIds: string[],
): T[] {
	if (historyIds.length === 0) return fuzzy;

	const sessionsById = new Map<string, T>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: T[] = [];
	const historyPaths = new Set<string>();
	for (const id of historyIds) {
		const session = sessionsById.get(id);
		if (!session || historyPaths.has(session.path)) continue;
		historyMatches.push(session);
		historyPaths.add(session.path);
	}
	if (historyMatches.length === 0) return fuzzy;

	const metadataOnly = fuzzy.filter(session => !historyPaths.has(session.path));
	return [...historyMatches, ...metadataOnly];
}

export interface SessionSelectorOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	onDelete?: (session: T) => Promise<boolean>;
	/**
	 * Rename the selected session to a user-supplied title; resolve with the
	 * title as stored (the session canonicalizes it) or null when the rename
	 * did not happen.
	 */
	onRename?: (session: T, title: string) => Promise<string | null>;
	/** Persist the selected session's pin state (pin keys / the picker's Pin action). */
	onSetPinned?: (session: T, pinned: boolean) => Promise<void>;
	historyMatcher?: SessionHistoryMatcher;
	/**
	 * Complete folder listing when the constructor's `sessions` are a
	 * preliminary subset; replaces them once it settles (see {@link SessionListing}).
	 */
	completeSessions?: Promise<T[]>;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<SessionListing<T>>;
	/** Preloaded all-projects listing; cached so the first Tab toggle is instant. */
	allSessions?: SessionListing<T>;
	/** Picker heading; defaults to "Resume Session". */
	title?: string;
	/** Fixed scope label, or false to omit the scope suffix. */
	scopeLabel?: string | false;
	/**
	 * Show each session's working directory in the list. Defaults to on when
	 * the session files live in more than one directory (e.g. the folder scope
	 * merging a repository's worktrees).
	 */
	showCwd?: boolean;
	/**
	 * Reads the live terminal height so the visible window fits the viewport.
	 * Omitted only in tests; defaults to a conservative 24 rows.
	 */
	getTerminalRows?: () => number;
	/**
	 * Fill the whole viewport and pin the footer (hint + bottom border) to the
	 * last rows, so the footer stops drifting as the list window changes height.
	 * Set by the standalone `--resume` picker (fullscreen alternate screen); the
	 * in-editor selector leaves it off and renders compactly.
	 */
	fillHeight?: boolean;
	/** Set of pinned session ids to display with a pin indicator. */
	pinnedIds?: ReadonlySet<string>;
	/** Path of the live session, or a getter so detach/newSession stays accurate. */
	currentSessionPath?: string | (() => string | undefined);
	/**
	 * The picker is the whole program (`omp --resume`): the native picker
	 * fills the screen surface (`size:"screen"`) instead of floating as a
	 * sheet over the transcript.
	 */
	standalone?: boolean;
}
