import {
	type Component,
	Container,
	FuzzyText,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "../index";
import * as path from "node:path";
import { formatBytes, getProjectDir } from "@oh-my-pi/pi-utils";
import type { TspPickerGroup, TspPickerItem, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { compact, kv, md, node, span } from "../native/describe";
import {
	picker,
	pickerAction,
	pickerAge,
	pickerDate,
	type PickerEvent,
	pickerEvent,
	pickerHits,
} from "../native/picker";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { hintsRow, type NativeHint, overlayCard } from "../native/overlay";
import { plainText } from "../native/spans";
import { theme } from "../theme/theme";
import { contentRowWidth } from "../chrome/selector-helpers";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
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
import { shortenPath } from "../render/render-utils";
import { HookSelectorComponent } from "./hook-selector";
import { bottomBorder, OverlayPanel, row, topBorder } from "../chrome/overlay-box";
import { MenuSelection, getMenuWindow } from "../components/menu-selection";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";

/**
 * Themed glyph + colored label for a session's lifecycle status, or `undefined`
 * when there is nothing useful to show (`unknown`/unset) so the metadata line
 * stays uncluttered. The glyph resolves through the active symbol preset
 * (nerdfont / unicode / ascii) via `theme.status.*`.
 */
function formatSessionStatus(status: SessionSelectorStatus | undefined): string | undefined {
	switch (status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} done`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} interrupted`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} aborted`);
		case "error":
			return theme.fg("error", `${theme.status.error} error`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} pending`);
		default:
			return undefined;
	}
}

/** Lifecycle status as one theme-colored span (native picker), mirroring {@link formatSessionStatus}. */
function sessionStatusSpan(status: SessionSelectorStatus | undefined): TspSpan | undefined {
	switch (status) {
		case "complete":
			return span("done", "success");
		case "interrupted":
			return span("interrupted", "warning");
		case "aborted":
			return span("aborted", "muted");
		case "error":
			return span("error", "error");
		case "pending":
			return span("pending", "accent");
		default:
			return undefined;
	}
}

/** Status dot tone of a session row in the native picker; none when the status is unknown. */
function sessionStatusTone(status: SessionSelectorStatus | undefined): TspTone | undefined {
	switch (status) {
		case "complete":
			return "success";
		case "interrupted":
			return "warning";
		case "aborted":
		case "error":
			return "error";
		case "pending":
			return "pending";
		default:
			return undefined;
	}
}

/** The name a session goes by: its title, else its first message on one line, else its id. */
function sessionLabel(session: SessionSelectorEntry): string {
	const title = session.title ? plainText(session.title).trim() : "";
	return title || plainText(session.firstMessage).replace(/\s+/g, " ").trim() || session.id;
}

/** Longest prompt or answer excerpt the native preview shows. */
const PREVIEW_EXCERPT_CHARS = 1200;
/** The preview follows the selection once it rests this long (holding ↓ doesn't flood the wire). */
const PREVIEW_SETTLE_MS = 60;
const DAY_MS = 86_400_000;
const PINNED_GROUP = { id: "pinned", label: "Pinned" };

/** Day group of a session's last modification, relative to local midnight today. */
function sessionDayGroup(modified: Date, startOfToday: number): { id: string; label: string } {
	const at = modified.getTime();
	if (at >= startOfToday) return { id: "today", label: "Today" };
	if (at >= startOfToday - DAY_MS) return { id: "yesterday", label: "Yesterday" };
	if (at >= startOfToday - 6 * DAY_MS) return { id: "week", label: "This week" };
	return { id: "earlier", label: "Earlier" };
}

/** A cwd as dim-prefix / strong-tail path spans. */
function cwdSpans(cwd: string): TspSpan[] {
	const short = shortenPath(cwd);
	const cut = short.lastIndexOf("/") + 1;
	return cut > 0 && cut < short.length
		? [span(short.slice(0, cut), "path dim"), span(short.slice(cut), "path")]
		: [span(short, "path")];
}

/**
 * The native preview of a session: its title, a fact grid, and the
 * conversation's first prompt (user tint) plus the tail of the rest as an
 * excerpt of the latest answer, both clipped to {@link PREVIEW_EXCERPT_CHARS}.
 */
function sessionPreview(session: SessionSelectorEntry, forkedFrom: string | undefined): NativeChild[] {
	const status = sessionStatusSpan(session.status);
	const created = session.created && !Number.isNaN(session.created.getTime()) ? session.created : undefined;
	const first = session.firstMessage.trim();
	const rest = session.allMessagesText.startsWith(session.firstMessage)
		? session.allMessagesText.slice(session.firstMessage.length).trim()
		: "";
	const conversation = compact([
		first.length > 0 &&
			md(first.length > PREVIEW_EXCERPT_CHARS ? `${first.slice(0, PREVIEW_EXCERPT_CHARS)}…` : first, {
				tone: "user",
			}),
		rest.length > 0 && md(rest.length > PREVIEW_EXCERPT_CHARS ? `…${rest.slice(-PREVIEW_EXCERPT_CHARS)}` : rest),
	]);
	return compact([
		node("text", { text: sessionLabel(session), role: "omp.picker.title" }),
		kv([
			["Folder", session.cwd ? cwdSpans(session.cwd) : undefined],
			["Created", created && pickerDate(created)],
			["Modified", pickerDate(session.modified)],
			["Size", formatBytes(session.size)],
			["Status", status && [status]],
			["Forked from", forkedFrom],
		]),
		conversation.length > 0 && node("section", { head: "Conversation" }, conversation),
	]);
}

/** Absolute dates of week-old sessions; `toLocaleDateString` goes through Intl on every call. */
const localeDateCache = new WeakMap<Date, { time: number; text: string }>();

/** Relative age of a session's last modification (`"3 hours ago"`), falling back to the date after a week. */
function formatSessionDate(date: Date): string {
	const time = date.getTime();
	const diffMs = Date.now() - time;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
	if (diffDays === 1) return "1 day ago";
	if (diffDays < 7) return `${diffDays} days ago`;

	const cached = localeDateCache.get(date);
	if (cached?.time === time) return cached.text;
	const text = date.toLocaleDateString();
	localeDateCache.set(date, { time, text });
	return text;
}

/** A cached native session item and the inputs it was built from. */
interface SessionItemMemo {
	node: NativeNode;
	date: string;
	pinned: boolean;
	current: boolean;
	showCwd: boolean;
}

/** Cached native item node on the session entry, rebuilt when its inputs change. */
const kNativeItem = Symbol("session.nativeItem");

interface NativeSessionInfo extends SessionSelectorEntry {
	[kNativeItem]?: SessionItemMemo;
}

/** The session picker's catalogue: one item per session in scope, and the inputs it was built from. */
interface SessionCatalogue {
	version: number;
	showCwd: boolean;
	currentPath: string | undefined;
	pinnedIds: ReadonlySet<string>;
	minute: number;
	items: readonly TspPickerItem[];
	byPath: ReadonlyMap<string, TspPickerItem>;
}

/** The session list's part of the picker props, plus the memo keys it was built from. */
interface SessionPickerView {
	items: readonly TspPickerItem[];
	itemsAdd?: readonly TspPickerItem[];
	version: number;
	query: string;
	/** Search caret (UTF-16 offset into `query`). */
	cursor: number;
	order: readonly (string | TspPickerGroup)[];
	hits?: Readonly<Record<string, readonly (readonly [number, number])[]>>;
	selected: string | null;
	current: readonly string[];
	total: number;
}

/** An open delete confirmation: the session and the dialog's two answers. */
interface DeleteChoice<T extends SessionSelectorEntry> {
	session: T;
	confirm(): void;
	cancel(): void;
}

/** Transient status line above the list: scope loading or an error. */
interface SessionPickerMessage {
	kind: "loading" | "error";
	text: string;
}

const SCOPE_TABS: readonly { id: "folder" | "all"; label: string }[] = [
	{ id: "folder", label: "Current folder" },
	{ id: "all", label: "All projects" },
];

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
 * Lowercased per-session search haystack, built once and cached on the
 * {@link SessionSelectorEntry} itself (so it dies with the listing that produced it).
 * Rebuilding it per keystroke — a ~4KB string join plus `toLowerCase` per
 * session — was one of the costs that made resume search visibly lag.
 *
 * Only the string is cached. A prebuilt fuzzy index (~60KB per 4KB session)
 * would cost hundreds of MB on multi-thousand-session listings, so fuzzy
 * indexes are built transiently per scan visit instead (see
 * {@link scoreFuzzySession} callers).
 */
const kSearchTextLower = Symbol("session.searchTextLower");

interface SearchableSessionInfo extends SessionSelectorEntry {
	[kSearchTextLower]?: string;
}

function sessionTextLower(session: SessionSelectorEntry): string {
	const tagged = session as SearchableSessionInfo;
	let textLower = tagged[kSearchTextLower];
	if (textLower === undefined) {
		textLower = sessionSearchText(session).toLowerCase();
		tagged[kSearchTextLower] = textLower;
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
 * fuzzy tokens are dropped as noise.
 *
 * This is the synchronous reference implementation; {@link SessionList} runs
 * the same primitives incrementally so huge listings never block a keystroke.
 */
export function rankSessionSearchMatches<T extends SessionSelectorEntry>(allSessions: T[], query: string): T[] {
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
	return prioritizeTitleMatches(out, tokens, literal);
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

/**
 * Delay before the prompt-history DB is consulted for the current query.
 * History matching hits SQLite synchronously (an FTS lookup plus a LIKE scan
 * over every stored prompt — tens to hundreds of ms on a year-old database),
 * so it must never run per keystroke: fuzzy results render immediately and
 * the history merge lands once typing pauses.
 */
const HISTORY_MERGE_DEBOUNCE_MS = 150;
/**
 * Minimum query length for history augmentation. A single character matches
 * essentially every stored prompt — the most expensive FTS prefix to expand —
 * and only reorders the recency-ranked list by noise.
 */
const HISTORY_MERGE_MIN_QUERY = 2;

/**
 * Sessions fuzzy-scored synchronously inside the keystroke itself. Small
 * listings finish within it, keeping the complete-in-one-frame behavior;
 * anything left spills into async chunks. A fuzzy visit costs ~100µs (index
 * build over the ≤4KB per-session corpus dominates), so 100 visits ≈ 10ms —
 * about one frame. Counts rather than a deadline keep chunk boundaries
 * deterministic (and testable under fake timers).
 */
const FUZZY_SCAN_INLINE_COUNT = 100;
/**
 * Sessions fuzzy-scored per async chunk (~15ms). Each chunk yields back to
 * the event loop so the next keystroke is never blocked behind a long scan; a
 * new query bumps the scan generation and orphans pending chunks.
 */
const FUZZY_SCAN_CHUNK_COUNT = 150;

/**
 * Custom session list component with multi-line items and search
 */
class SessionList<T extends SessionSelectorEntry> implements Component {
	#menu: MenuSelection<T>;
	// Maps a 0-based line within this list's own render to a filtered-session
	// index, or undefined for chrome rows (search line, blanks, scrollbar gap).
	// Rebuilt every render so the picker's mouse hit-testing tracks the live
	// scroll window. Only consulted while the picker holds the alternate screen
	// (where the overlay enables mouse tracking and paints from screen row 0).
	#hitRows: (number | undefined)[] = [];
	readonly #searchInput: Input;
	onSelect?: (session: T) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	// Snapshot of the live terminal-row getter; the visible window is derived
	// from it per render so the picker fits the viewport (and adapts to resize).
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: T) => void;

	#allSessions: T[];
	#showCwd: boolean;
	#pinnedIds: ReadonlySet<string>;
	readonly #getCurrentSessionPath: () => string | undefined;
	readonly #historyMatcher?: SessionHistoryMatcher;
	#historyMergeTimer: NodeJS.Timeout | undefined;
	/** Re-render hook for async list updates (fuzzy scan chunks, history merge). */
	onRequestRender?: () => void;

	// ── Incremental search state ──────────────────────────────────────────
	// The menu's visible list is always composed from these three inputs (see
	// #composeFiltered), so late-arriving fuzzy chunks and the debounced
	// history merge can land in any order without clobbering each other.
	/** Recency-ranked sessions whose text contains every query token verbatim. */
	#literalRanked: RankedSessionMatch<T>[] = [];
	/** Score-ranked fuzzy-only matches, appended by scan chunks. */
	#fuzzyRanked: RankedSessionMatch<T>[] = [];
	/** Prompt-history session IDs for the current query, once the merge landed. */
	#historyIds: string[] = [];
	/** Invalidates in-flight scan chunks when the query or dataset changes. */
	#scanGeneration = 0;
	#scanTimer: NodeJS.Timeout | undefined;
	/**
	 * True once the user moved the selection for the current query; blocks the
	 * history merge from reordering the list under their cursor. (Fuzzy chunks
	 * only append below the literal group, which never shifts existing rows.)
	 */
	#selectionMoved = false;
	/** True after a nonempty query; empty refilter restores current only then. */
	#hadFilterQuery = false;
	/** Last query passed to {@link #filterSessions}; same-query refilter keeps the index. */
	#lastFilterQuery = "";
	/** Bumped whenever the visible session set may have changed (native memo key). */
	#itemsVersion = 0;
	/** Per-row line heights of the visible list for the ANSI window, reused until the set changes. */
	#rowHeights: { items: readonly T[]; length: number; version: number; heights: readonly number[] } | undefined;
	#itemsNative:
		| { version: number; showCwd: boolean; currentPath: string | undefined; items: NativeNode[] }
		| undefined;
	#listNative:
		| { items: readonly NativeNode[]; selected: string | undefined; query: string; node: NativeNode }
		| undefined;
	/** Bumped when the session set itself changes (scope switch, delete): the picker catalogue's memo key. */
	#datasetVersion = 0;
	/** The picker catalogue (every session in scope), rebuilt only when the set, markers or minute change. */
	#pickerCatalogue: SessionCatalogue | undefined;
	/** Paths upserted through `itemsAdd` (history badges) since the catalogue was last sent. */
	#pickerPatched = new Set<string>();
	#pickerPatch: { catalogue: readonly TspPickerItem[]; flagged: string; add: readonly TspPickerItem[] } | undefined;
	#pickerView: SessionPickerView | undefined;

	constructor(
		sessions: T[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
		pinnedIds: ReadonlySet<string> = new Set(),
		currentSessionPath?: string | (() => string | undefined),
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#pinnedIds = pinnedIds;
		this.#getCurrentSessionPath =
			typeof currentSessionPath === "function" ? currentSessionPath : () => currentSessionPath;
		this.#historyMatcher = historyMatcher;
		this.#menu = new MenuSelection<T>(sessions, {
			getKey: session => session.path,
			getSearchText: sessionSearchText,
		});
		this.#selectCurrentSession();
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			const selected = this.#menu.selectedItem;
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	/**
	 * Session-row line budget for one render, sized so the whole picker fits
	 * the current viewport instead of pushing its header/search off the top.
	 *
	 * Chrome (7) is the panel's top border, one spacer, the list's search line
	 * and its blank, and the pinned footer minus its leading blank (hint,
	 * blank, bottom border) — the last visible session's separator blank is
	 * never rendered, so the footer's own blank stands in for it. The reserve
	 * covers below-editor hook widgets / cursor. The floor of 8 always admits
	 * two titled sessions (the tallest item at 4 lines: title + preview +
	 * metadata + separator).
	 */
	#lineBudget(): number {
		const CHROME = 7;
		const RESERVE = 1;
		return Math.max(8, this.#getTerminalRows() - CHROME - RESERVE);
	}

	/** PageUp/PageDown jump, approximated from the worst-case session height. */
	#pageSize(): number {
		return Math.max(2, Math.floor(this.#lineBudget() / 4));
	}

	/** Focus the live session when it is in the visible list. */
	#selectCurrentSession(): void {
		const currentPath = this.#getCurrentSessionPath();
		if (!currentPath) return;
		const index = this.#menu.visibleItems.findIndex(s => s.path === currentPath);
		if (index >= 0) this.#menu.setSelectedIndex(index);
	}

	/** Replace the visible dataset, e.g. when toggling folder/all-projects scope. */
	setSessions(sessions: T[], showCwd: boolean, pinnedIds?: ReadonlySet<string>): void {
		this.#datasetVersion++;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		if (pinnedIds !== undefined) this.#pinnedIds = pinnedIds;
		this.#menu.setSelectedIndex(0);
		this.#filterSessions(this.#searchInput.getValue());
		this.#selectCurrentSession();
	}

	#filterSessions(query: string): void {
		this.#scanGeneration++;
		this.#itemsVersion++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		this.#selectionMoved = false;
		this.#historyIds = [];
		this.#literalRanked = [];
		this.#fuzzyRanked = [];

		const tokens = tokenizeSessionQuery(query);
		const hadQuery = this.#hadFilterQuery;
		const queryChanged = query !== this.#lastFilterQuery;
		this.#hadFilterQuery = tokens.length > 0;
		this.#lastFilterQuery = query;
		if (tokens.length === 0) {
			const keepIndex = Math.min(this.#menu.selectedIndex, Math.max(0, this.#allSessions.length - 1));
			this.#menu.setItems(this.#allSessions, keepIndex >= 0 ? this.#allSessions[keepIndex]?.path : undefined);
			if (hadQuery) this.#selectCurrentSession();
			this.#scheduleHistoryMerge(query);
			return;
		}

		// Literal pass: one substring scan per token per session, synchronous so
		// every keystroke gets immediate recency-ranked feedback regardless of
		// listing size.
		const literal: RankedSessionMatch<T>[] = [];
		const rest: number[] = [];
		const all = this.#allSessions;
		for (let index = 0; index < all.length; index++) {
			if (isLiteralMatch(sessionTextLower(all[index]!), tokens)) {
				literal.push({ session: all[index]!, score: 0, index });
			} else {
				rest.push(index);
			}
		}
		literal.sort(compareLiteralRank);
		this.#literalRanked = literal;

		// Fuzzy pass: building a fuzzy index per session is too expensive to run
		// across a huge listing inside one keystroke, so scan a bounded slice now
		// and spill the remainder into async chunks.
		this.#scanFuzzySlice(this.#scanGeneration, tokens, rest, 0, FUZZY_SCAN_INLINE_COUNT);
		this.#composeFiltered();
		// New query rebuilds ranking from scratch. Same-query refilter (delete)
		// and async compose (fuzzy chunks / history merge) only clamp so an
		// arrow selection survives. A live-session index > 0 would otherwise
		// land on a lower-ranked match after the first keystroke.
		if (queryChanged) this.#menu.setSelectedIndex(0);
		this.#scheduleHistoryMerge(query);
	}

	/**
	 * Score up to `budget` sessions from `rest[start..]` (indexes into the
	 * unfiltered list), then schedule the remainder on a macrotask so pending
	 * input events run first. Chunks that added matches recompose the visible
	 * list and request a render; a stale generation aborts silently.
	 */
	#scanFuzzySlice(generation: number, tokens: string[], rest: number[], start: number, budget: number): void {
		const all = this.#allSessions;
		const end = Math.min(rest.length, start + budget);
		for (let i = start; i < end; i++) {
			const index = rest[i]!;
			const session = all[index]!;
			const match = scoreFuzzySession(session, index, tokens, new FuzzyText(sessionTextLower(session)));
			if (match) this.#fuzzyRanked.push(match);
		}
		if (end >= rest.length) return;
		this.#scanTimer = setTimeout(() => {
			this.#scanTimer = undefined;
			if (generation !== this.#scanGeneration) return;
			const before = this.#fuzzyRanked.length;
			this.#scanFuzzySlice(generation, tokens, rest, end, FUZZY_SCAN_CHUNK_COUNT);
			if (this.#fuzzyRanked.length > before) {
				this.#composeFiltered();
				this.onRequestRender?.();
			}
		}, 0);
	}

	/**
	 * Rebuild the menu's visible list with title matches first, then other
	 * prompt-history hits, literal matches (recency), and fuzzy-only hits (score).
	 */
	#composeFiltered(): void {
		this.#itemsVersion++;
		this.#fuzzyRanked.sort(compareFuzzyRank);
		const base: T[] = [];
		for (const match of this.#literalRanked) base.push(match.session);
		for (const match of this.#fuzzyRanked) base.push(match.session);
		const composed = prioritizeTitleMatches(
			this.#historyIds.length > 0 ? mergeSessionRanking(this.#allSessions, base, this.#historyIds) : base,
			tokenizeSessionQuery(this.#searchInput.getValue()),
			this.#literalRanked,
		);
		// Async chunks and the history merge only clamp the cursor so an arrow
		// selection survives recomposition; the query path resets explicitly.
		const keepIndex = Math.min(this.#menu.selectedIndex, Math.max(0, composed.length - 1));
		this.#menu.setItems(composed, keepIndex >= 0 ? composed[keepIndex]?.path : undefined);
	}

	/**
	 * Augment ranked results with prompt-history matches without replacing them.
	 * The session-list corpus only sees the first 4KB of each session, so a prompt
	 * typed deep into a long session is invisible to text search; `historyMatcher`
	 * recovers those via `history.db`. The lookup hits SQLite synchronously, so it
	 * is debounced off the keystroke path ({@link HISTORY_MERGE_DEBOUNCE_MS}) and
	 * composed in when it lands, discarded if the query changed meanwhile.
	 */
	#scheduleHistoryMerge(query: string): void {
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
		const matcher = this.#historyMatcher;
		const trimmed = query.trim();
		if (!matcher || trimmed.length < HISTORY_MERGE_MIN_QUERY) return;
		this.#historyMergeTimer = setTimeout(() => {
			this.#historyMergeTimer = undefined;
			if (this.#searchInput.getValue() !== query) return;
			if (this.#selectionMoved) return;
			const historyIds = matcher(trimmed);
			if (historyIds.length === 0) return;
			this.#historyIds = historyIds;
			this.#composeFiltered();
			this.onRequestRender?.();
		}, HISTORY_MERGE_DEBOUNCE_MS);
	}

	/** Cancel pending async search work; idempotent, called on every picker exit path. */
	dispose(): void {
		this.#scanGeneration++;
		if (this.#scanTimer !== undefined) {
			clearTimeout(this.#scanTimer);
			this.#scanTimer = undefined;
		}
		if (this.#historyMergeTimer !== undefined) {
			clearTimeout(this.#historyMergeTimer);
			this.#historyMergeTimer = undefined;
		}
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#datasetVersion++;
		this.#allSessions.splice(index, 1);
		// Re-filter to update the composed result set
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selection if we deleted the last item or beyond
		if (this.#menu.selectedIndex >= this.#menu.visibleItems.length) {
			this.#menu.setSelectedIndex(Math.max(0, this.#menu.visibleItems.length - 1));
		}
	}

	/** Resolve a list-local rendered-line index to a filtered-session index. */
	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Wheel notch: move the selection one step (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#menu.visibleItems.length === 0) return;
		this.#selectionMoved = true;
		this.#menu.move(delta, false);
	}

	/** Mouse click: select the session under the pointer and resume it. */
	selectAndConfirm(index: number): void {
		const session = this.#menu.visibleItems[index];
		if (!session) return;
		this.#menu.setSelectedIndex(index);
		this.onSelect?.(session);
	}

	/** Native click on a session item: the same outcome as a mouse click (select + resume). */
	confirmSession(path: string): void {
		const index = this.#menu.visibleItems.findIndex(s => s.path === path);
		if (index >= 0) this.selectAndConfirm(index);
	}

	/** Native row click: move the selection there, as the arrow keys would. */
	selectSession(path: string): void {
		if (this.#menu.setSelectedKey(path)) this.#selectionMoved = true;
	}

	/** Enter: resume the selected session. */
	resumeSelected(): void {
		const selected = this.#menu.selectedItem;
		if (selected) this.onSelect?.(selected);
	}

	/** Delete / Backspace on an empty query: ask the parent to confirm deleting the selected session. */
	requestDelete(): void {
		const selected = this.#menu.selectedItem;
		if (selected) this.onDeleteRequest?.(selected);
	}

	/** Empty the search query (the empty state's "Clear search"). */
	clearSearch(): void {
		this.#searchInput.setValue("");
		this.#filterSessions("");
	}

	get selectedSession(): T | undefined {
		return this.#menu.selectedItem;
	}

	/** Label of the session at `sessionPath` in this listing, else its file name. */
	parentLabel(sessionPath: string): string {
		const parent = this.#allSessions.find(s => s.path === sessionPath);
		return parent ? sessionLabel(parent) : path.basename(sessionPath, ".jsonl");
	}

	/**
	 * The session list's picker data. `items` is the whole scope and keeps its
	 * identity while typing (rebuilt when the set, pins, the live session or
	 * the minute change); a query changes only `order`, `hits` and
	 * `selected`, plus `itemsAdd` upserts for prompt-history badges. Without
	 * a query `order` groups pinned sessions, then by day (Today, Yesterday,
	 * This week, Earlier); with one it is the flat ranking.
	 */
	pickerView(): SessionPickerView {
		const catalogue = this.#catalogue();
		const query = this.#searchInput.getValue();
		const cursor = this.#searchInput.getCursor();
		const selected = this.#menu.selectedKey ?? null;
		const flagged = this.#historyFlagged();
		const itemsAdd = this.#historyPatch(catalogue.items, catalogue.byPath, flagged);
		const view = this.#pickerView;
		if (
			view?.items === catalogue.items &&
			view.version === this.#itemsVersion &&
			view.query === query &&
			view.cursor === cursor &&
			view.selected === selected &&
			view.itemsAdd === itemsAdd
		) {
			return view;
		}
		const visible = this.#menu.visibleItems;
		const tokens = tokenizeSessionQuery(query);
		const order: (string | TspPickerGroup)[] = [];
		let hits: Record<string, (readonly [number, number])[]> | undefined;
		if (tokens.length === 0) {
			const now = new Date();
			const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			// Pins lead the listing (`sortPinnedFirst`), so they get their own group ahead of the days.
			const groups = visible.map(session =>
				this.#pinnedIds.has(session.id) ? PINNED_GROUP : sessionDayGroup(session.modified, startOfToday),
			);
			for (let i = 0; i < visible.length; i++) {
				const group = groups[i]!;
				if (i === 0 || groups[i - 1]!.id !== group.id) {
					let count = 1;
					while (i + count < visible.length && groups[i + count]!.id === group.id) count++;
					order.push({ group: `${group.id}-${i}`, label: group.label, count });
				}
				order.push(visible[i]!.path);
			}
		} else {
			for (const session of visible) {
				order.push(session.path);
				const label = catalogue.byPath.get(session.path)?.label;
				if (typeof label !== "string") continue;
				const ranges = pickerHits(label, tokens);
				if (ranges.length > 0) (hits ??= {})[session.path] = ranges;
			}
		}
		const next: SessionPickerView = {
			items: catalogue.items,
			...(itemsAdd.length > 0 ? { itemsAdd } : {}),
			version: this.#itemsVersion,
			query,
			cursor,
			order,
			...(hits ? { hits } : {}),
			selected,
			current: catalogue.currentPath !== undefined ? [catalogue.currentPath] : [],
			total: this.#allSessions.length,
		};
		this.#pickerView = next;
		return next;
	}

	#catalogue(): SessionCatalogue {
		const currentPath = this.#getCurrentSessionPath();
		const minute = Math.floor(Date.now() / 60_000);
		const cached = this.#pickerCatalogue;
		if (
			cached?.version === this.#datasetVersion &&
			cached.showCwd === this.#showCwd &&
			cached.currentPath === currentPath &&
			cached.pinnedIds === this.#pinnedIds &&
			cached.minute === minute
		) {
			return cached;
		}
		const now = Date.now();
		const byPath = new Map<string, TspPickerItem>();
		const items = this.#allSessions.map(session => {
			const item = this.#pickerItem(session, currentPath, now);
			byPath.set(session.path, item);
			return item;
		});
		this.#pickerPatched.clear();
		const catalogue: SessionCatalogue = {
			version: this.#datasetVersion,
			showCwd: this.#showCwd,
			currentPath,
			pinnedIds: this.#pinnedIds,
			minute,
			items,
			byPath,
		};
		this.#pickerCatalogue = catalogue;
		return catalogue;
	}

	#pickerItem(session: T, currentPath: string | undefined, now: number): TspPickerItem {
		const message = plainText(session.firstMessage).replace(/\s+/g, " ").trim();
		const title = session.title ? plainText(session.title).trim() : "";
		const badges: { text: string; tone?: TspTone; title?: string }[] = [];
		if (session.parentSessionPath) {
			badges.push({ text: "fork", title: `Forked from “${this.parentLabel(session.parentSessionPath)}”` });
		}
		if (session.path === currentPath) badges.push({ text: "current", tone: "accent" });
		const when = pickerDate(session.modified);
		const detail = this.#showCwd ? (session.cwd ? cwdSpans(session.cwd) : undefined) : title ? message : undefined;
		const dot = sessionStatusTone(session.status);
		return {
			id: session.path,
			label: title || message || session.id,
			...(detail ? { detail } : {}),
			facts: { when: pickerAge(session.modified, now), size: formatBytes(session.size) },
			...(dot ? { dot } : {}),
			...(this.#pinnedIds.has(session.id) ? { icon: "pin" } : {}),
			...(badges.length > 0 ? { badges } : {}),
			title: this.#showCwd && message ? `${message}\n${when}` : when,
		};
	}

	/** Paths of the visible sessions the prompt-history merge surfaced for the current query. */
	#historyFlagged(): string {
		if (this.#historyIds.length === 0 || tokenizeSessionQuery(this.#searchInput.getValue()).length === 0) return "";
		const ids = new Set(this.#historyIds);
		const paths: string[] = [];
		for (const session of this.#menu.visibleItems) if (ids.has(session.id)) paths.push(session.path);
		return paths.join("\n");
	}

	/**
	 * `itemsAdd` for the history badges: every session flagged now gets the
	 * badge, and every one flagged since the catalogue was sent but not now
	 * gets its plain item back (upserts stick until `items` is replaced).
	 */
	#historyPatch(
		catalogue: readonly TspPickerItem[],
		byPath: ReadonlyMap<string, TspPickerItem>,
		flagged: string,
	): readonly TspPickerItem[] {
		const memo = this.#pickerPatch;
		if (memo?.catalogue === catalogue && memo.flagged === flagged) return memo.add;
		const now = new Set(flagged ? flagged.split("\n") : []);
		for (const key of now) this.#pickerPatched.add(key);
		const add: TspPickerItem[] = [];
		for (const key of this.#pickerPatched) {
			const base = byPath.get(key);
			if (!base) continue;
			add.push(
				now.has(key)
					? { ...base, badges: [...(base.badges ?? []), { text: "history", title: "Matched in prompt history" }] }
					: base,
			);
		}
		this.#pickerPatch = { catalogue, flagged, add };
		return add;
	}

	get searchInput(): Input {
		return this.#searchInput;
	}

	/**
	 * The session list as a native `list` keyed `"list"`, items keyed by
	 * session path. The terminal owns scrolling and virtualization; item nodes
	 * are cached per session and the list node while nothing visible changed.
	 */
	describeList(): NativeNode {
		const currentPath = this.#getCurrentSessionPath();
		let items = this.#itemsNative;
		if (
			items?.version !== this.#itemsVersion ||
			items.showCwd !== this.#showCwd ||
			items.currentPath !== currentPath
		) {
			items = {
				version: this.#itemsVersion,
				showCwd: this.#showCwd,
				currentPath,
				items: this.#menu.visibleItems.map(session => this.#describeSession(session, currentPath)),
			};
			this.#itemsNative = items;
		}
		const selected = this.#menu.selectedKey;
		const query = this.#searchInput.getValue();
		const memo = this.#listNative;
		if (memo?.items === items.items && memo.selected === selected && memo.query === query) return memo.node;
		const empty: TspText = this.#showCwd
			? [span("No sessions found", "muted")]
			: [span("No sessions in current folder. Press ", "muted"), span("tab", "key"), span(" to view all.", "muted")];
		const list = node(
			"list",
			{ selected: selected ?? null, filter: query.trim() || undefined, empty, virtual: true },
			items.items,
			"list",
		);
		this.#listNative = { items: items.items, selected, query, node: list };
		return list;
	}

	#describeSession(session: T, currentPath: string | undefined): NativeNode {
		const date = formatSessionDate(session.modified);
		const pinned = this.#pinnedIds.has(session.id);
		const current = currentPath !== undefined && session.path === currentPath;
		const tagged = session as NativeSessionInfo;
		const cached = tagged[kNativeItem];
		if (
			cached?.date === date &&
			cached.pinned === pinned &&
			cached.current === current &&
			cached.showCwd === this.#showCwd
		) {
			return cached.node;
		}
		const message = plainText(session.firstMessage).replace(/\s+/g, " ").trim();
		const detail: TspSpan[] = [];
		const push = (part: TspSpan): void => {
			if (detail.length > 0) detail.push(span(` ${theme.sep.dot} `, "dim"));
			detail.push(part);
		};
		if (session.title && message) push(span(message, "dim"));
		if (current) push(span("current", "accent"));
		const status = sessionStatusSpan(session.status);
		if (status) push(status);
		if (session.parentSessionPath) push(span("fork", "dim"));
		if (this.#showCwd && session.cwd) push(span(shortenPath(session.cwd), "path"));
		const item = node(
			"item",
			{
				label: (session.title && plainText(session.title)) || message || session.id,
				detail: detail.length > 0 ? detail : undefined,
				value: [span(`${date} ${theme.sep.dot} ${formatBytes(session.size)}`, "dim")],
				icon: pinned ? "pin" : undefined,
			},
			undefined,
			session.path,
		);
		tagged[kNativeItem] = { node: item, date, pinned, current, showCwd: this.#showCwd };
		return item;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#menu.visibleItems.length === 0) {
			if (this.#showCwd) {
				lines.push(truncateToWidth(theme.fg("muted", "No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(
						theme.fg("muted", `No sessions in current folder. Press ${formatKeyHint("tab")} to view all.`),
						width,
					),
				);
			}
			return lines;
		}

		// Window the list around the selection by actual line height (3 lines
		// per session, 4 when a title adds a preview line) until the viewport
		// budget is spent, so short sessions never strand blank rows a
		// worst-case count-based window would leave (then padded by
		// fill-height).
		const filtered = this.#menu.visibleItems;
		const budget = this.#lineBudget();
		const {
			startIndex,
			endIndex,
			rowOffset: offsetRows,
			totalRows: rawTotalRows,
		} = getMenuWindow(this.#visibleRowHeights(filtered), this.#menu.selectedIndex, budget);

		// Each session block is built into sessionLines, then wrapped by ScrollView
		// so the right-edge scrollbar is proportional at the physical-line level.
		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const rowWidth = contentRowWidth(width, rawTotalRows, budget);
		const currentPath = this.#getCurrentSessionPath();
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const session = filtered[i];
			if (!session) continue;
			const isSelected = i === this.#menu.selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + optional pin icon + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			const isPinned = this.#pinnedIds.has(session.id);
			const pinPrefix = isPinned ? `${theme.fg("accent", theme.icon.pin)} ` : "";
			const pinPrefixWidth = isPinned ? visibleWidth(`${theme.icon.pin} `) : 0;
			const maxTextWidth = Math.max(0, maxWidth - pinPrefixWidth);

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxTextWidth);
				const titleLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedTitle) : truncatedTitle}`;
				sessionLines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxTextWidth);
				const messageLine = `${cursor}${pinPrefix}${isSelected ? theme.bold(truncatedMsg) : truncatedMsg}`;
				sessionLines.push(messageLine);
			}

			// Metadata line: date + file size + current marker + lifecycle status
			// (+ project dir in all-projects scope). The status segment carries
			// its own color, so each segment is dimmed individually rather than
			// wrapping the whole line.
			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatSessionDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			if (currentPath !== undefined && session.path === currentPath) {
				metadata += ` ${dot} ${theme.fg("accent", "current")}`;
			}
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (session.parentSessionPath) {
				metadata += ` ${dot} ${dim(`${theme.icon.branch} fork`)}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);
			// Blank separator between sessions; the last block ends flush against
			// the footer, whose leading blank provides the same gap.
			if (i < endIndex - 1) sessionLines.push("");
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		// Wrap the rendered window in a ScrollView for a proportional right-edge
		// bar, with exact physical-line totals from the per-session heights.
		// The last session's separator blank is never rendered (see the block
		// loop above), so exclude it or a fully visible list would still show a
		// scrollbar.
		const totalRows = rawTotalRows - 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(offsetRows);
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		lines.push(...svLines);

		return lines;
	}

	/** Line height per visible session (3, or 4 when a title adds a preview line), memoized per visible set. */
	#visibleRowHeights(items: readonly T[]): readonly number[] {
		const cached = this.#rowHeights;
		if (cached?.items === items && cached.length === items.length && cached.version === this.#itemsVersion) {
			return cached.heights;
		}
		const heights = items.map(session => (session.title ? 4 : 3));
		this.#rowHeights = { items, length: items.length, version: this.#itemsVersion, heights };
		return heights;
	}

	handleInput(keyData: string): void {
		// Delete key — or Backspace on an empty search query — request delete
		// confirmation from the parent. macOS laptops have no dedicated Forward
		// Delete key: Fn+Backspace is the only way to send \e[3~, and many macOS
		// terminals (Terminal.app, some iTerm2 profiles) deliver \x7f for that
		// combo instead. Regular Backspace on an empty query means "delete
		// session"; with a typed query it stays bound to the search Input so users
		// can still edit their filter text.
		if (
			matchesKey(keyData, "delete") ||
			(matchesKey(keyData, "backspace") && this.#searchInput.getValue().length === 0)
		) {
			this.requestDelete();
			return;
		}
		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#selectionMoved = true;
			this.#menu.move(-1, false);
			return;
		}
		// Down arrow
		if (matchesSelectDown(keyData)) {
			this.#selectionMoved = true;
			this.#menu.move(1, false);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectionMoved = true;
			this.#menu.move(-this.#pageSize(), false);
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectionMoved = true;
			this.#menu.move(this.#pageSize(), false);
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.resumeSelected();
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Tab - toggle folder / all-projects scope
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions<T extends SessionSelectorEntry = SessionSelectorEntry> {
	onDelete?: (session: T) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<T[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: T[];
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

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent<T extends SessionSelectorEntry = SessionSelectorEntry> extends OverlayPanel {
	#sessionList: SessionList<T>;
	#confirmationDialog: HookSelectorComponent | null = null;
	// Hosts whichever of `#sessionList` / `#confirmationDialog` is live this
	// frame. The delete dialog REPLACES the list in this slot rather than being
	// appended below the picker chrome, so the picker is always
	// `chrome + max(list, dialog) + chrome` and never overflows the viewport
	// (issue #3283: an overflowing dialog frame committed the header into
	// scrollback, stranding it above the viewport once the dialog closed).
	#contentSlot: Container;
	#messageContainer: Container;
	#onDelete?: (session: T) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<T[]>;
	#folderSessions: T[];
	readonly #folderShowCwd: boolean;
	#globalSessions: T[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
	#inputLocked = false;
	// 0-based line where the session list begins within this component's own
	// render, captured each frame. The fullscreen picker overlay paints from
	// screen row 0, so a mouse row maps to `row - #listLineOffset` inside the
	// list. Only meaningful while the picker holds the alternate screen.
	#listLineOffset = 0;
	// 0-based line where the pinned footer begins; clicks at or below it never
	// hit-test the list, so a footer click on a cramped (trimmed) frame can't
	// resume a session scrolled off-screen.
	#footerStart = 0;
	readonly #getTerminalRows: () => number;
	readonly #fillHeight: boolean;
	readonly #title: string;
	readonly #scopeLabel: string | false | undefined;
	/** What `#messageContainer` shows, for the native description. */
	#message: SessionPickerMessage | undefined;
	/** The native picker shows `#message`'s error until the next key or pointer event. */
	#pickerErrorOpen = false;
	readonly #standalone: boolean;
	/** A caller's heading for the picker head; the default `/resume` picker has none (the search names it). */
	readonly #pickerTitle: string | undefined;
	/** The open delete confirmation's two answers, for the picker's confirm strip. */
	#deleteChoice: DeleteChoice<T> | null = null;
	/** The preview pane's content and the session it shows; follows the selection once it settles. */
	#preview: { session: T | undefined; nodes: readonly NativeChild[] } | undefined;
	#previewPending: T | undefined;
	#previewSettled: T | undefined;
	#previewTimer: NodeJS.Timeout | undefined;
	#pickerMemo:
		| {
				view: SessionPickerView;
				preview: readonly NativeChild[];
				scope: "folder" | "all";
				message: SessionPickerMessage | undefined;
				errorOpen: boolean;
				choice: DeleteChoice<T> | null;
				node: NativeNode;
		  }
		| undefined;
	#nativeMemo:
		| {
				title: string;
				scope: "folder" | "all";
				message: SessionPickerMessage | undefined;
				dialog: HookSelectorComponent | null;
				list: NativeNode;
				node: NativeNode;
		  }
		| undefined;

	constructor(
		sessions: T[],
		onSelect: (session: T) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions<T> = {},
	) {
		super(options.title ?? "Resume Session");

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		// Storage directory, not recorded cwd: one folder's sessions may record
		// symlink aliases of the same path, which must not turn the column on.
		this.#folderShowCwd = options.showCwd ?? new Set(sessions.map(session => path.dirname(session.path))).size > 1;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		this.#title = options.title ?? "Resume Session";
		this.#pickerTitle = options.title;
		this.#standalone = options.standalone ?? false;
		this.#scopeLabel = options.scopeLabel;
		this.title = this.#headerLabel();
		// One spacer of breathing room; OverlayPanel supplies the two outer
		// border rows and the horizontal inset.
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list in folder scope; the empty-state hint invites the
		// user to Tab into all-projects rather than silently surfacing other
		// projects' history (issue #3099).
		this.#sessionList = new SessionList(
			sessions,
			this.#folderShowCwd,
			options.historyMatcher,
			options.getTerminalRows,
			options.pinnedIds,
			options.currentSessionPath,
		);
		// Every exit path cancels the list's pending history merge, so a stale
		// debounce timer can never run its SQLite lookup after the picker closed.
		this.#sessionList.onSelect = session => {
			this.#sessionList.dispose();
			onSelect(session);
		};
		this.#sessionList.onCancel = () => {
			this.#sessionList.dispose();
			onCancel();
		};
		this.#sessionList.onExit = () => {
			this.#sessionList.dispose();
			onExit();
		};
		this.#sessionList.onRequestRender = () => this.#onRequestRender?.();
		this.#sessionList.onDeleteRequest = (session: T) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.#contentSlot = new Container();
		this.#contentSlot.addChild(this.#sessionList);
		this.addChild(this.#contentSlot);
	}

	#headerLabel(): string {
		if (this.#scopeLabel === false) return this.#title;
		const scopeLabel = this.#scopeLabel ?? (this.#scope === "all" ? "all projects" : "current folder");
		return `${this.#title} (${scopeLabel})`;
	}

	/**
	 * Toggle between current-folder and all-projects scope. The global list is
	 * loaded lazily on first switch and cached, so the common folder-scope path
	 * never pays for the cross-project scan.
	 */
	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "Loading all projects…"), 0, 0));
				this.#message = { kind: "loading", text: "Loading all projects…" };
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#message = undefined;
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, this.#folderShowCwd);
		}
		this.title = this.#headerLabel();
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}
	/** Ignore input after selection while the host resumes the session. */
	lockInput(): void {
		this.#inputLocked = true;
	}
	/** Re-enable input after a failed resume so the user can pick again. */
	unlockInput(): void {
		this.#inputLocked = false;
	}

	/**
	 * Dispose the session list explicitly: while the delete-confirmation dialog
	 * is mounted the list is detached from the child tree, so Container's
	 * child-walking dispose would miss its pending history-merge timer.
	 */
	override dispose(): void {
		this.#sessionList.dispose();
		clearTimeout(this.#previewTimer);
		super.dispose();
	}

	#clearError(): void {
		this.#messageContainer.clear();
		this.#message = undefined;
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#message = { kind: "error", text: `Error: ${plainText(message)}` };
		this.#pickerErrorOpen = true;
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 0, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: T): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;
			this.#deleteChoice = null;
			// Restore the SessionList into the content slot so the picker is back
			// to its normal layout on the very next render — the same frame the
			// dialog disappears.
			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		const answer = async (option: string) => {
			if (option === "Yes" && this.#onDelete) {
				this.#clearError();
				try {
					const deleted = await this.#onDelete(session);
					if (deleted) {
						this.#sessionList.removeSession(session.path);
						this.#folderSessions = this.#folderSessions.filter(s => s.path !== session.path);
						if (this.#globalSessions) {
							this.#globalSessions = this.#globalSessions.filter(s => s.path !== session.path);
						}
					}
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
				}
			}
			closeDialog();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			answer,
			closeDialog,
		);
		this.#deleteChoice = {
			session,
			confirm: () => {
				// The strip goes at once; the dialog stays until the delete settles, as after Enter on "Yes".
				this.#deleteChoice = null;
				void answer("Yes");
			},
			cancel: closeDialog,
		};
		// Swap the SessionList out of the content slot and mount the dialog in its
		// place: the dialog competes only with the SessionList's rendered budget,
		// never the SessionList AND the picker chrome, so the picker frame stays
		// inside the terminal viewport and the TUI never commits the header into
		// scrollback (issue #3283).
		this.#contentSlot.clear();
		this.#contentSlot.addChild(this.#confirmationDialog);
		this.#onRequestRender?.();
	}

	/**
	 * Render the panel directly so fill-height mode can keep its footer pinned
	 * while sharing OverlayPanel's exact rounded-box chrome. Children receive
	 * the panel's inner width before their rows are wrapped.
	 */
	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [topBorder(width, this.title)];
		for (const child of this.children) {
			const childLines = child.render(innerWidth);
			if (child === this.#contentSlot) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(row(line, width));
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push(row("", width));
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	/** Blank · keybinding hint · bottom border. Rendered by {@link render}. */
	#footerLines(width: number): string[] {
		const scopeHint = this.#scope === "all" ? "current folder" : "all projects";
		// Keys mirror SessionList#handleInput; cancel is `app.interrupt` (raw Escape when unbound).
		const cancel = interruptKey();
		const hint = theme.fg(
			"muted",
			`[${formatKeyHints(["delete", "backspace"])} delete · ${formatKeyHint("enter")} select · ${formatKeyHint("tab")} ${scopeHint} · ${cancel} cancel]`,
		);
		return [row("", width), row(hint, width), row("", width), bottomBorder(width)];
	}

	/** Scope tabs replace the "(current folder)" title suffix when the scope can toggle. */
	#hasScopeTabs(): boolean {
		return this.#scopeLabel === undefined && this.#sessionList.onToggleScope !== undefined;
	}

	/** Over the transcript the picker is its own sheet (`layer`); the standalone app fills the screen surface. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker") && !this.#standalone;
	}

	/**
	 * With the `picker` kind: the data-first session picker (§4.7). Otherwise
	 * scope `tabs`, loading/error message, then the search `input` and session
	 * `list` — or the delete-confirmation dialog in their place, as on the ANSI
	 * path — and the key-hint footer.
	 */
	override describe(cx: DescribeContext): NativeNode {
		if (cx.supports("picker")) return this.#describePicker();
		const list = this.#sessionList.describeList();
		const memo = this.#nativeMemo;
		if (
			memo?.title === this.title &&
			memo.scope === this.#scope &&
			memo.message === this.#message &&
			memo.dialog === this.#confirmationDialog &&
			memo.list === list
		) {
			return memo.node;
		}
		const tabs = this.#hasScopeTabs();
		const children: NativeChild[] = [];
		if (tabs) children.push(node("tabs", { items: SCOPE_TABS, active: this.#scope }, undefined, "scope"));
		const message = this.#message;
		if (message?.kind === "loading") {
			children.push(node("spinner", { label: [span(message.text, "muted")] }, undefined, "message"));
		} else if (message) {
			children.push(node("text", { spans: [span(message.text, "error")] }, undefined, "message"));
		}
		if (this.#confirmationDialog) {
			children.push(this.#confirmationDialog);
		} else {
			children.push(this.#sessionList.searchInput, list);
		}
		const hints: (NativeHint | undefined)[] = [
			{ keys: ["delete", "backspace"], label: "delete" },
			{ keys: ["enter"], label: "select" },
		];
		if (this.#sessionList.onToggleScope) {
			hints.push({ keys: ["tab"], label: this.#scope === "all" ? "current folder" : "all projects" });
		}
		hints.push({ keys: [boundKeys("app.interrupt", ["escape"])[0] ?? "escape"], label: "cancel" });
		const result = overlayCard("omp.overlay.sessions", tabs ? this.#title : this.title, [
			...children,
			hintsRow(hints),
		]);
		this.#nativeMemo = {
			title: this.title,
			scope: this.#scope,
			message,
			dialog: this.#confirmationDialog,
			list,
			node: result,
		};
		return result;
	}

	/**
	 * `lg` cards sheet (`screen` for the standalone app): sessions grouped by
	 * day (ranked flat while searching), the selected session's preview, the
	 * delete confirm strip, and the actions of the keys Enter, Delete/Backspace,
	 * Tab (the scope toggle, labelled with the scope it switches to) and Esc.
	 * Untitled unless the caller named it; the placeholder says the scope.
	 */
	#describePicker(): NativeNode {
		const list = this.#sessionList;
		const view = list.pickerView();
		const preview = this.#previewFor(list.selectedSession);
		const message = this.#message;
		const errorOpen = this.#pickerErrorOpen && message?.kind === "error";
		const choice = this.#deleteChoice;
		const memo = this.#pickerMemo;
		if (
			memo?.view === view &&
			memo.preview === preview &&
			memo.scope === this.#scope &&
			memo.message === message &&
			memo.errorOpen === errorOpen &&
			memo.choice === choice
		) {
			return memo.node;
		}
		const loading = message?.kind === "loading";
		const toggle = list.onToggleScope !== undefined;
		const actions = [pickerAction("resume", "Resume", "enter", { primary: true })];
		if (this.#onDelete) actions.push(pickerAction("delete", "Delete", "backspace"));
		if (toggle) {
			actions.push(pickerAction("scope", this.#scope === "all" ? "This folder" : "All projects", "tab"));
		}
		actions.push(
			pickerAction("close", "Close", boundKeys("app.interrupt", ["escape"])[0] ?? "escape", { end: true }),
		);
		const folder = this.#scopeLabel === false ? undefined : (this.#scopeLabel ?? path.basename(getProjectDir()));
		const title = this.#pickerTitle;
		const placeholder =
			loading || this.#scope === "all"
				? "Search all sessions…"
				: folder && !title
					? `Search sessions in ${folder}…`
					: "Search sessions…";
		const result = picker(
			{
				...(title ? { title, ...(folder ? { subtitle: folder } : {}) } : {}),
				icon: "history",
				noun: "sessions",
				size: this.#standalone ? "screen" : "lg",
				layout: "cards",
				preview: "side",
				query: view.query,
				cursor: view.cursor,
				placeholder,
				columns: [
					{ id: "when", format: "time" },
					{ id: "size", format: "dim" },
				],
				items: view.items,
				...(view.itemsAdd ? { itemsAdd: view.itemsAdd } : {}),
				order: view.order,
				...(view.hits ? { hits: view.hits } : {}),
				selected: view.selected,
				current: view.current,
				total: view.total,
				actions,
				state: loading ? "loading" : errorOpen ? "error" : "ready",
				...(loading || errorOpen ? { message: message!.text } : {}),
				empty: this.#scope === "all" || !toggle ? "No sessions yet" : "No sessions in this folder yet",
				confirm: choice
					? {
							text: `Delete “${sessionLabel(choice.session)}”? This removes the session file.`,
							act: "delete-confirm",
							label: "Delete",
						}
					: null,
			},
			preview,
		);
		this.#pickerMemo = { view, preview, scope: this.#scope, message, errorOpen, choice, node: result };
		return result;
	}

	/**
	 * The preview children for `target`: built at once for the first
	 * selection, then only after the selection has rested
	 * {@link PREVIEW_SETTLE_MS} (the old preview stays meanwhile).
	 */
	#previewFor(target: T | undefined): readonly NativeChild[] {
		const shown = this.#preview;
		if (shown && shown.session === target) return shown.nodes;
		if (shown && target !== this.#previewSettled) {
			if (this.#previewPending !== target || this.#previewTimer === undefined) {
				clearTimeout(this.#previewTimer);
				this.#previewPending = target;
				this.#previewTimer = setTimeout(() => {
					this.#previewTimer = undefined;
					this.#previewSettled = this.#previewPending;
					this.#onRequestRender?.();
				}, PREVIEW_SETTLE_MS);
			}
			return shown.nodes;
		}
		const nodes = target
			? sessionPreview(
					target,
					target.parentSessionPath ? this.#sessionList.parentLabel(target.parentSessionPath) : undefined,
				)
			: [];
		this.#preview = { session: target, nodes };
		return nodes;
	}

	/**
	 * Picker pointer events run the keys' paths: a row click selects (arrows),
	 * a second click or `Resume` resumes (Enter), `Delete` asks (Delete), the
	 * tab or `All projects` toggles scope (Tab), `Close` cancels (Esc), and
	 * the confirm strip answers the delete dialog (Yes / Esc).
	 */
	#handlePickerEvent(ev: PickerEvent): void {
		const list = this.#sessionList;
		const choice = this.#deleteChoice;
		if (ev.kind !== "action") {
			if (choice) return;
			if (ev.kind === "select") list.selectSession(ev.item);
			else list.confirmSession(ev.item);
			return;
		}
		if (ev.act === "delete-confirm") choice?.confirm();
		else if (ev.act === "cancel") choice?.cancel();
		else if (ev.act === "close") {
			if (choice) choice.cancel();
			else list.onCancel?.();
		} else if (choice) return;
		else if (ev.act === "resume") list.resumeSelected();
		else if (ev.act === "delete") list.requestDelete();
		else if (ev.act === "scope") {
			list.onToggleScope?.();
		} else if (ev.act === "clear") list.clearSearch();
	}

	/** Picker events (root keypath); fallback: scope tab → toggle scope, click on a session → resume it, exactly like a mouse click. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#inputLocked) return;
		const ev = pickerEvent(event);
		if (ev) {
			this.#pickerErrorOpen = false;
			this.#handlePickerEvent(ev);
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.key === "scope") {
			if (event.type === "select" && event.item !== this.#scope) void this.#toggleScope();
			return;
		}
		if (event.key === "list" && !this.#confirmationDialog) this.#sessionList.confirmSession(event.item);
	}

	handleInput(keyData: string): void {
		if (this.#inputLocked) return;
		this.#pickerErrorOpen = false;
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	/**
	 * SGR mouse reports, delivered only while the picker holds the alternate
	 * screen (the fullscreen overlay enables tracking and paints from screen row
	 * 0). Wheel scrolls the list; a left click resumes the session under the
	 * pointer. Mouse is inert while the delete-confirmation dialog is open.
	 */
	#handleMouse(data: string): void {
		if (this.#confirmationDialog) return;
		routeSgrMouseInput(data, event => {
			if (event.wheel !== null) {
				this.#sessionList.handleWheel(event.wheel);
				return true;
			}
			if (!event.leftClick || event.row >= this.#footerStart) return true;
			const index = this.#sessionList.hitTestSession(event.row - this.#listLineOffset);
			if (index !== undefined) this.#sessionList.selectAndConfirm(index);
			return true;
		});
	}

	getSessionList(): SessionList<T> {
		return this.#sessionList;
	}
}
