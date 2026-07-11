import {
	type Component,
	Container,
	fuzzyMatch,
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
} from "@pk-nerdsaver-ai/pi-tui";
import { formatBytes } from "@pk-nerdsaver-ai/pi-utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo, SessionStatus } from "../../session/session-listing";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

/**
 * Themed glyph + colored label for a session's lifecycle status, or `undefined`
 * when there is nothing useful to show (`unknown`/unset) so the metadata line
 * stays uncluttered. The glyph resolves through the active symbol preset
 * (nerdfont / unicode / ascii) via `theme.status.*`.
 */
function formatSessionStatus(status: SessionStatus | undefined): string | undefined {
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

/** Returns the IDs of sessions whose recorded prompts match a query, best first. */
export type SessionHistoryMatcher = (query: string) => string[];

function sessionSearchText(session: SessionInfo): string {
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

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

/**
 * Filter and rank session picker search results.
 *
 * Resume search narrows a recency-sorted list: once every query token appears
 * as a literal substring, newer sessions should beat a slightly better fuzzy
 * position match. Pure fuzzy/acronym matches still sort by fuzzy score after
 * literal matches, but weak pure fuzzy tokens are dropped as noise.
 */
export function rankSessionSearchMatches(allSessions: SessionInfo[], query: string): SessionInfo[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const results: Array<{ session: SessionInfo; score: number; literal: boolean; index: number }> = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const text = sessionSearchText(session);
		const textLower = text.toLowerCase();
		let score = 0;
		let worstTokenScore = Number.NEGATIVE_INFINITY;
		let literal = true;
		let matches = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, textLower);
			if (!match.matches) {
				matches = false;
				break;
			}
			score += match.score;
			worstTokenScore = Math.max(worstTokenScore, match.score);
			if (!textLower.includes(token)) literal = false;
		}

		if (matches && (literal || worstTokenScore < MIN_PURE_FUZZY_TOKEN_SCORE)) {
			results.push({ session, score, literal, index });
		}
	}

	results.sort((a, b) => {
		if (a.literal !== b.literal) return a.literal ? -1 : 1;
		if (a.literal) return compareSessionRecency(a.session, b.session) || a.index - b.index;
		return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
	});

	return results.map(result => result.session);
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
export function mergeSessionRanking(
	allSessions: SessionInfo[],
	fuzzy: SessionInfo[],
	historyIds: string[],
): SessionInfo[] {
	if (historyIds.length === 0) return fuzzy;

	const sessionsById = new Map<string, SessionInfo>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: SessionInfo[] = [];
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
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	// Maps a 0-based line within this list's own render to a filtered-session
	// index, or undefined for chrome rows (search line, blanks, scrollbar gap).
	// Rebuilt every render so the picker's mouse hit-testing tracks the live
	// scroll window. Only consulted while the picker holds the alternate screen
	// (where the overlay enables mouse tracking and paints from screen row 0).
	#hitRows: (number | undefined)[] = [];
	readonly #searchInput: Input;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	// Snapshot of the live terminal-row getter; the visible window is derived
	// from it per render so the picker fits the viewport (and adapts to resize).
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: SessionInfo) => void;

	#allSessions: SessionInfo[];
	#showCwd: boolean;
	readonly #historyMatcher?: SessionHistoryMatcher;

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#historyMatcher = historyMatcher;
		this.#filteredSessions = sessions;
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	/**
	 * Number of sessions to show at once, sized so the whole picker fits the
	 * current viewport instead of pushing its header/search off the top.
	 *
	 * Budget = rows − chrome − reserve, divided by the worst-case per-session
	 * height. Chrome (12) is the surrounding spacers/borders/header (7) plus the
	 * list's search line, blank, scroll indicator, blank, and hint (5). A titled
	 * session is the tallest item at 4 lines (title + preview + metadata +
	 * blank); budgeting for that guarantees no overflow even when every visible
	 * entry has a title. The reserve covers below-editor hook widgets / cursor.
	 */
	#visibleCount(): number {
		const CHROME = 12;
		const PER_SESSION = 4;
		const RESERVE = 1;
		const budget = this.#getTerminalRows() - CHROME - RESERVE;
		return Math.max(2, Math.floor(budget / PER_SESSION));
	}

	/** Replace the visible dataset, e.g. when toggling folder/all-projects scope. */
	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#selectedIndex = 0;
		this.#filterSessions(this.#searchInput.getValue());
	}

	#filterSessions(query: string): void {
		const fuzzy = rankSessionSearchMatches(this.#allSessions, query);
		this.#filteredSessions = this.#mergeHistoryMatches(query, fuzzy);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	/**
	 * Augment fuzzy results with prompt-history matches without replacing them.
	 * The session-list corpus only sees the first 4KB of each session, so a prompt
	 * typed deep into a long session is invisible to fuzzy search; `historyMatcher`
	 * recovers those via `history.db`.
	 */
	#mergeHistoryMatches(query: string, fuzzy: SessionInfo[]): SessionInfo[] {
		const trimmed = query.trim();
		if (!trimmed || !this.#historyMatcher) return fuzzy;
		const historyIds = this.#historyMatcher(trimmed);
		if (historyIds.length === 0) return fuzzy;
		return mergeSessionRanking(this.#allSessions, fuzzy, historyIds);
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);
		// Re-filter to update filteredSessions
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selectedIndex if we deleted the last item or beyond
		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	/** Resolve a list-local rendered-line index to a filtered-session index. */
	hitTestSession(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Wheel notch: move the selection one step (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#filteredSessions.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + delta));
	}

	/** Mouse click: select the session under the pointer and resume it. */
	selectAndConfirm(index: number): void {
		const session = this.#filteredSessions[index];
		if (!session) return;
		this.#selectedIndex = index;
		this.onSelect?.(session);
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

		if (this.#filteredSessions.length === 0) {
			if (this.#showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling. The window is sized to the
		// current viewport so the picker never overflows past the top.
		const maxVisible = this.#visibleCount();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredSessions.length);

		// Render visible sessions (3 lines, or 4 when a title adds a preview line).
		// Each session block is built into sessionLines, then wrapped by ScrollView
		// so the right-edge scrollbar is proportional at the physical-line level.
		const sessionLines: string[] = [];
		const sessionRowIndex: number[] = [];
		const overflow = this.#filteredSessions.length > maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		for (let i = startIndex; i < endIndex; i++) {
			const blockStart = sessionLines.length;
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				sessionLines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				sessionLines.push(messageLine);
			}

			// Metadata line: date + file size + lifecycle status (+ project dir in
			// all-projects scope). The status segment carries its own color, so each
			// segment is dimmed individually rather than wrapping the whole line.
			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
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
			sessionLines.push(""); // Blank line between sessions
			for (let k = blockStart; k < sessionLines.length; k++) sessionRowIndex[k] = i;
		}

		// Wrap the rendered window in a ScrollView for a proportional right-edge bar.
		const visibleCount = endIndex - startIndex;
		const linesPerItem = visibleCount > 0 ? sessionLines.length / visibleCount : 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: Math.round(this.#filteredSessions.length * linesPerItem),
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(Math.round(startIndex * linesPerItem));
		const sessionRegionStart = lines.length;
		const svLines = sv.render(width);
		for (let k = 0; k < svLines.length; k++) this.#hitRows[sessionRegionStart + k] = sessionRowIndex[k];
		lines.push(...svLines);

		return lines;
	}

	handleInput(keyData: string): void {
		// Delete key - request delete confirmation from parent
		if (matchesKey(keyData, "delete")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		// Down arrow
		if (matchesSelectDown(keyData)) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleCount());
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#visibleCount());
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected);
			}
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

export interface SessionSelectorOptions {
	onDelete?: (session: SessionInfo) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<SessionInfo[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: SessionInfo[];
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
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	// Hosts whichever of `#sessionList` / `#confirmationDialog` is live this
	// frame. The delete dialog REPLACES the list in this slot rather than being
	// appended below the picker chrome, so the picker is always
	// `chrome + max(list, dialog) + chrome` and never overflows the viewport
	// (issue #3283: an overflowing dialog frame committed the header into
	// scrollback, stranding it above the viewport once the dialog closed).
	#contentSlot: Container;
	#messageContainer: Container;
	#headerText: Text;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;
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
	readonly #bottomBorder = new DynamicBorder();

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		this.#getTerminalRows = options.getTerminalRows ?? (() => 24);
		this.#fillHeight = options.fillHeight ?? false;
		// Add header
		this.addChild(new Spacer(1));
		this.#headerText = new Text(this.#headerLabel(), 1, 0);
		this.addChild(this.#headerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list in folder scope; the empty-state hint invites the
		// user to Tab into all-projects rather than silently surfacing other
		// projects' history (issue #3099).
		this.#sessionList = new SessionList(sessions, false, options.historyMatcher, options.getTerminalRows);
		this.#sessionList.onSelect = onSelect;
		this.#sessionList.onCancel = onCancel;
		this.#sessionList.onExit = onExit;
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
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
		const scopeLabel = this.#scope === "all" ? "all projects" : "current folder";
		return `${theme.bold("Resume Session")} ${theme.fg("muted", `(${scopeLabel})`)}`;
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
				this.#messageContainer.addChild(new Text(theme.fg("muted", "  Loading all projects…"), 1, 0));
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
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.#headerText.setText(this.#headerLabel());
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		const closeDialog = () => {
			this.#confirmationDialog = null;
			// Restore the SessionList into the content slot so the picker is back
			// to its normal layout on the very next render — the same frame the
			// dialog disappears.
			this.#contentSlot.clear();
			this.#contentSlot.addChild(this.#sessionList);
			this.#onRequestRender?.();
		};
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				closeDialog();
			},
			closeDialog,
		);
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
	 * Concatenate the children's renders (like {@link Container}) while recording
	 * the line where the session list begins, so the fullscreen picker can hit-
	 * test mouse rows against the live list window. SessionList rebuilds its lines
	 * every frame, so Container's reference-memoization never applied here.
	 *
	 * In fill-height mode the body is padded (or, on a cramped terminal, trimmed)
	 * to leave exactly enough room for the footer at the screen bottom, so the
	 * footer is always visible and never drifts as the list window resizes. The
	 * in-editor selector just appends the footer directly.
	 */
	render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			if (child === this.#contentSlot) this.#listLineOffset = lines.length;
			for (const line of childLines) lines.push(line);
		}
		const footer = this.#footerLines(width);
		if (this.#fillHeight) {
			const target = Math.max(0, this.#getTerminalRows() - footer.length);
			if (lines.length > target) lines.length = target;
			else for (let i = lines.length; i < target; i++) lines.push("");
		}
		this.#footerStart = lines.length;
		for (const line of footer) lines.push(line);
		return lines;
	}

	/** Blank · keybinding hint · bottom border. Rendered by {@link render}. */
	#footerLines(width: number): string[] {
		const scopeHint = this.#scope === "all" ? "current folder" : "all projects";
		const hint = theme.fg("muted", `  [Del delete · Enter select · Tab ${scopeHint} · Esc cancel]`);
		return ["", hint, "", ...this.#bottomBorder.render(width)];
	}

	handleInput(keyData: string): void {
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

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
