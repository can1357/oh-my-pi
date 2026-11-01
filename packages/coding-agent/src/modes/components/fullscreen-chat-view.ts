import { ensureThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { copyToClipboard } from "../../utils/clipboard";
import {
	ALT_WHEEL_SCROLL_MULTIPLIER,
	type Component,
	type Container,
	colToCodeUnitIndex,
	Ellipsis,
	type MouseRoutable,
	matchesKey,
	type OverlayFocusOwner,
	Input,
	CURSOR_MARKER,
	isKeyRelease,
	truncateToWidth,
	parseSgrMouse,
	ScrollView,
	type SgrMouseEvent,
	stripTerminalSequences,
	endOfTerminalSequence,
	visibleWidth,
	WheelScrollAccelerator,
} from "@oh-my-pi/pi-tui";

export interface FullscreenChatViewOptions {
	/** Transcript components: the history that scrolls independently of the dock. */
	transcript: readonly Component[];
	/** Dock components pinned to the bottom: pending messages, status, editor, footer. */
	dock: readonly Component[];
	/** Container whose focused child owns the keyboard while fullscreen is up. */
	editorContainer: Container;
	/** Terminal height in rows, polled on each render. */
	terminalRows: () => number;
	/**
	 * Resolved at click time: the editor slot can be hot-swapped while
	 * fullscreen is up (approval prompts, visualizers), and a stale captured
	 * instance would silently route clicks into an unmounted instance.
	 */
	editor: () => Component & MouseRoutable;
	/** Asks the host for a re-render; drives drag auto-scroll and copy-flash timers. */
	requestRender?: () => void;
	/** Moves terminal keyboard focus to a fullscreen-owned input (search). */
	setFocus?: (component: Component) => void;
	/** Renders fullscreen rows through the composer's viewport pipeline, including link hints. */
	renderFullscreenViewport?: (rows: readonly string[], width: number) => readonly string[];
}

/**
 * Persistent alternate-screen chat surface.
 *
 * The regular OMP root remains the source of truth for every existing
 * transcript, status, hook, and editor component. This view gives those
 * components a viewport: history scrolls independently while the live dock
 * stays fixed at the bottom of the terminal. On top of that viewport it owns
 * the fullscreen-only text interactions: speed-adaptive wheel scrolling,
 * click-to-position routing into the composer, character-level selection with
 * OSC 52 copy, transcript search, and the jump-to-latest indicator.
 */
export class FullscreenChatView implements Component, OverlayFocusOwner {
	#scrollView = new ScrollView([], { height: 1, scrollbar: "auto", ellipsis: Ellipsis.Omit });
	#followTail = true;
	#viewportHeight = 1;
	#viewportTop = 0;
	#statusRow: number | undefined;
	#dockTop = 1;
	#width = 1;
	#draggingScrollbar = false;
	/** Editor rows within the dock, from the last render; undefined when the editor is not laid out. */
	#editorDockRows: { top: number; count: number } | undefined;
	/** Absolute rendered-line anchors stay on the same text when streaming appends rows. */
	#selection: { anchor: SelectionPoint; head: SelectionPoint } | undefined;
	#draggingSelection = false;
	/** Last press position and time, for double/triple-click word and line selection. */
	#lastClick: { ms: number; row: number; col: number; count: number } | undefined;
	/** Drag auto-scroll state: direction while the pointer holds against a viewport edge. */
	#autoScrollTimer: NodeJS.Timeout | undefined;
	#autoScrollDir = 0;
	/** Column of the last drag motion, so auto-scroll extends the head at the pointer's column. */
	#dragCol = 0;
	/** Transient copy feedback in a separate status row. */
	#flash: string | undefined;
	#flashTimer: NodeJS.Timeout | undefined;
	/** Styled transcript lines from the last render, backing selection and search. */
	#transcriptLines: readonly string[] = [];
	#transcriptWidth = 0;
	/** Scales wheel events by fling speed so touch scrolling keeps up with a flick. */
	#wheelAccelerator = new WheelScrollAccelerator();
	/** Transcript length at the last render; growth while scrolled up means new activity. */
	#lastContentLength = 0;
	/** True once content grew while the user was scrolled away from the tail. */
	#hasNewActivity = false;
	/** Active transcript search: typed query plus its literal matches and cursor. */
	#search:
		| {
				input: Input;
				matches: TranscriptMatch[];
				current: number;
				reveal: boolean;
				matchQuery: string;
		  }
		| undefined;

	constructor(private readonly options: FullscreenChatViewOptions) {}

	/** Lets the normal editor slot keep keyboard focus while this overlay owns the screen. */
	ownsOverlayFocusTarget(component: Component): boolean {
		return this.ownsSearchInput(component) || this.options.editorContainer.children.includes(component);
	}

	/** True for the transient search field, which keeps fullscreen keyboard routing. */
	ownsSearchInput(component: Component): boolean {
		return component === this.#search?.input;
	}

	/** True when the fullscreen surface consumed the input: navigation keys, the search bar, selection gestures, or composer-click routing. */
	handleViewportInput(data: string): boolean {
		const mouse = parseSgrMouse(data);
		if (mouse) return this.#handleMouse(mouse);
		if (isKeyRelease(data)) return this.#search !== undefined;

		// Ctrl+F toggles the transcript search bar. The editor still owns the
		// bare key as cursor-right's Ctrl twin; fullscreen takes the chord.
		if (matchesKey(data, "ctrl+f")) {
			if (this.#search === undefined) {
				this.#search = this.#openSearch();
				this.options.setFocus?.(this.#search.input);
			} else this.#closeSearch(true);
			return true;
		}
		if (this.#search !== undefined) {
			this.#handleSearchKey(data);
			return true;
		}

		if (!this.#handleViewportKey(data)) return false;
		this.#syncFollowTail();
		return true;
	}

	#openSearch() {
		this.#clearSelection();
		const input = new Input();
		input.prompt = " find: ";
		input.focused = true;
		input.onEscape = () => this.#closeSearch(true);
		input.onSubmit = () => this.#stepSearch(1);
		return { input, matches: [] as TranscriptMatch[], current: 0, reveal: false, matchQuery: "" };
	}

	#handleSearchKey(data: string): void {
		if (matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+shift+g")) {
			this.#stepSearch(-1);
		} else if (matchesKey(data, "ctrl+g")) {
			this.#stepSearch(1);
		} else if (this.#handleViewportKey(data)) {
			this.#syncFollowTail();
		} else {
			const search = this.#search!;
			search.input.handleInput(data);
			if (this.#search === search) this.#refreshSearchQuery();
		}
	}

	#refreshSearchQuery(): void {
		const search = this.#search;
		if (!search || search.matchQuery === search.input.getValue()) return;
		search.matchQuery = search.input.getValue();
		search.matches = findTranscriptMatches(this.#transcriptLines, search.matchQuery);
		const firstVisible = this.#scrollView.getScrollOffset();
		search.current = Math.max(
			0,
			search.matches.findIndex(match => match.line >= firstVisible),
		);
		this.#jumpToCurrentMatch();
	}

	#stepSearch(delta: number): void {
		const search = this.#search!;
		this.#refreshSearchQuery();
		if (search.matches.length === 0) return;
		search.current = (search.current + delta + search.matches.length) % search.matches.length;
		this.#jumpToCurrentMatch();
	}

	/** Reveal after layout so search/status rows are included in the viewport height. */
	#jumpToCurrentMatch(): void {
		if (!this.#search?.matches.length) return;
		this.#search.reveal = true;
		this.#followTail = false;
	}

	/** Closes search, optionally returning focus to the mounted chat editor. */
	#closeSearch(focusEditor: boolean): void {
		if (this.#search === undefined) return;
		this.#search = undefined;
		if (focusEditor && this.options.editorContainer.children.includes(this.options.editor())) {
			this.options.setFocus?.(this.options.editor());
		}
	}

	/** An editor-slot prompt or modal owns all input until it returns control. */
	cancelInput(): void {
		this.#closeSearch(false);
		this.#draggingScrollbar = false;
		this.#clearSelection();
	}

	dispose(): void {
		this.cancelInput();
		for (const component of this.options.transcript) {
			if (component instanceof TranscriptContainer) component.releaseDocumentCaches();
		}
		clearTimeout(this.#flashTimer);
		this.#flashTimer = undefined;
		this.#flash = undefined;
	}

	#clearSelection(): void {
		this.#selection = undefined;
		this.#draggingSelection = false;
		this.#stopAutoScroll();
	}

	invalidate(): void {
		this.#clearSelection();
		for (const component of this.options.transcript) component.invalidate?.();
		for (const component of this.options.dock) component.invalidate?.();
	}

	render(width: number): readonly string[] {
		if (!this.options.editorContainer.children.includes(this.options.editor())) this.cancelInput();
		this.#width = Math.max(1, width);
		const terminalRows = Math.max(1, this.options.terminalRows());
		const dockLines = this.#renderDock(this.#width, terminalRows);
		const availableRows = Math.max(1, terminalRows - dockLines.length);
		this.#viewportTop = this.#search !== undefined && availableRows > 1 ? 1 : 0;
		const showStatus =
			(this.#flash !== undefined ||
				(!this.#followTail && this.#lastContentLength > availableRows - this.#viewportTop)) &&
			availableRows - this.#viewportTop > 1;
		this.#viewportHeight = availableRows - this.#viewportTop - Number(showStatus);
		this.#statusRow = showStatus ? this.#viewportTop + this.#viewportHeight : undefined;
		this.#dockTop = availableRows;
		// Reserve the scrollbar from the previous frame once content overflows.
		// The transition frame may re-render once; every later frame uses one width.
		const scrollbarReserved = this.#lastContentLength > this.#viewportHeight;
		let transcriptWidth = scrollbarReserved ? Math.max(1, this.#width - 1) : this.#width;
		let transcriptLines = this.#renderComponents(this.options.transcript, transcriptWidth);
		// The scrollbar consumes the last terminal column. Re-render newly overflowing
		// content so each component wraps itself instead of ScrollView cutting it short.
		if (!scrollbarReserved && transcriptLines.length > this.#viewportHeight) {
			transcriptWidth = Math.max(1, this.#width - 1);
			transcriptLines = this.#renderComponents(this.options.transcript, transcriptWidth);
		}
		const transcriptChanged = !this.#sameTranscriptLines(transcriptLines);
		if (this.#selection) {
			const last = Math.max(this.#selection.anchor.line, this.#selection.head.line);
			// A reflow or replacement before the selection invalidates its row coordinates.
			if (
				transcriptWidth !== this.#transcriptWidth ||
				this.#transcriptLines.slice(0, last + 1).some((line, index) => line !== transcriptLines[index])
			)
				this.#clearSelection();
		}
		this.#transcriptLines = transcriptLines;
		this.#transcriptWidth = transcriptWidth;
		const rangesByLine = new Map<number, { start: number; end: number }[]>();
		this.#refreshSearchQuery();
		if (this.#search) {
			const search = this.#search;
			const current = search.matches[search.current];
			const query = search.input.getValue();
			if (transcriptChanged || search.matchQuery !== query) {
				search.matches = findTranscriptMatches(transcriptLines, query);
				search.matchQuery = query;
			}
			const retained = search.matches.findIndex(
				match => match.line === current?.line && match.start === current.start,
			);
			search.current = retained >= 0 ? retained : Math.min(search.current, Math.max(0, search.matches.length - 1));
			for (const match of search.matches) {
				const ranges = rangesByLine.get(match.line) ?? [];
				ranges.push(match);
				rangesByLine.set(match.line, ranges);
			}
		} else if (this.#selection) {
			const [first, last] = this.#normalizedSelection();
			for (let line = first.line; line <= last.line; line++) {
				const start = line === first.line ? first.unit : 0;
				const end = line === last.line ? last.unit : stripTerminalSequences(transcriptLines[line] ?? "").length;
				if (end > start) rangesByLine.set(line, [{ start, end }]);
			}
		}

		this.#scrollView.setHeight(this.#viewportHeight);
		this.#scrollView.setLines(
			rangesByLine.size === 0
				? transcriptLines
				: transcriptLines.map((line, index) => highlightTranscriptRanges(line, rangesByLine.get(index) ?? [])),
		);
		if (this.#search?.reveal) {
			const match = this.#search.matches[this.#search.current];
			if (match) this.#scrollView.setScrollOffset(Math.max(0, match.line - Math.floor(this.#viewportHeight / 3)));
			this.#search.reveal = false;
		}
		if (this.#followTail) this.#scrollView.scrollToBottom();

		if (!this.#followTail && transcriptLines.length > this.#lastContentLength) {
			this.#hasNewActivity = true;
		}
		this.#lastContentLength = transcriptLines.length;

		const rows: string[] = [];
		if (this.#viewportTop) rows.push(this.#renderSearchBar());
		rows.push(...this.#scrollView.render(this.#width));
		if (showStatus) {
			const label =
				this.#flash ?? (this.#hasNewActivity ? "● New activity · Back to bottom" : "↓ Back to bottom · Ctrl+End");
			rows.push(this.#renderCentered(label));
		}
		// Only the active input emits an IME cursor marker.
		rows.push(...(this.#search ? dockLines.map(line => line.replaceAll(CURSOR_MARKER, "")) : dockLines));
		return this.options.renderFullscreenViewport?.(rows, this.#width) ?? rows;
	}

	/** A muted chip row: left-aligned filling the row, or centered hugging its label. */
	#renderChipRow(text: string, center: boolean): string {
		text = truncateToWidth(text, this.#width);
		const padding = Math.max(0, this.#width - visibleWidth(text));
		const left = center ? Math.floor(padding / 2) : 0;
		ensureThemeSync();
		const styled = theme.bgFill("userMessageBg", theme.fgOnBg("userMessageText", "userMessageBg", text));
		return `${" ".repeat(left)}${styled}${" ".repeat(padding - left)}`;
	}

	#renderSearchBar(): string {
		const search = this.#search!;
		const count = search.matches.length === 0 ? "no matches" : `${search.current + 1}/${search.matches.length}`;
		const suffix = truncateToWidth(`  ${count} · Enter↓ ⇧Enter↑ · Esc`, Math.max(0, this.#width - 12));
		const input = search.input.render(this.#width - visibleWidth(suffix))[0] ?? "";
		return this.#renderChipRow(input + suffix, false);
	}

	#renderCentered(label: string): string {
		return this.#renderChipRow(`  ${label}  `, true);
	}

	/** Recomputes tail-following from the scroll position; landing on the tail also clears activity. */
	#syncFollowTail(): void {
		this.#followTail = this.#scrollView.getScrollOffset() === this.#scrollView.getMaxScrollOffset();
		if (this.#followTail) this.#hasNewActivity = false;
	}

	#renderComponents(components: readonly Component[], width: number): string[] {
		const lines: string[] = [];
		for (const component of components) {
			lines.push(
				...(component instanceof TranscriptContainer ? component.renderDocument(width) : component.render(width)),
			);
		}
		return lines;
	}

	#sameTranscriptLines(lines: readonly string[]): boolean {
		return (
			this.#transcriptLines.length === lines.length &&
			this.#transcriptLines.every((line, index) => line === lines[index])
		);
	}

	#renderDock(width: number, terminalRows: number): string[] {
		const lines: string[] = [];
		let editorTop = -1;
		let editorCount = 0;
		for (const component of this.options.dock) {
			const rendered = component.render(width);
			if (component === this.options.editorContainer) {
				// The editor container renders its children in order; the editor
				// is the first (and currently only) child, so its rows start at
				// the container's first row.
				editorTop = lines.length;
				editorCount = rendered.length;
			}
			lines.push(...rendered);
		}
		// Keep one transcript row usable even when a transient panel and a tall
		// editor would otherwise consume the whole terminal. The tail contains
		// the editor and footer, which must remain available to type.
		let dockLines = lines;
		if (lines.length >= terminalRows) {
			dockLines = lines.slice(lines.length - terminalRows + 1);
			if (editorTop >= 0) editorTop -= lines.length - dockLines.length;
		}
		this.#editorDockRows =
			editorTop >= 0 && editorTop < dockLines.length ? { top: editorTop, count: editorCount } : undefined;
		return dockLines;
	}

	#handleViewportKey(data: string): boolean {
		// Keep arrows, Home, and End available to the multiline editor.
		// Ctrl+Home/End navigate the transcript.
		if (matchesKey(data, "pageUp")) {
			this.#scrollView.scroll(-this.#pageStep());
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.#scrollView.scroll(this.#pageStep());
			return true;
		}
		if (matchesKey(data, "ctrl+home")) {
			this.#scrollView.scrollToTop();
			return true;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.#scrollView.scrollToBottom();
			return true;
		}
		return false;
	}

	/** Page-turn step that keeps the last lines of the previous page visible. */
	#pageStep(): number {
		return Math.max(1, this.#viewportHeight - 4);
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		if (event.wheel !== null) {
			// A trackpad/touch fling emits a dense event stream: scale lines by
			// event speed, and let Alt multiply for a jump.
			const lines = this.#wheelAccelerator.linesForEvent();
			if (lines > 0) {
				const alt = (event.button & 8) !== 0;
				this.#scrollView.scroll(event.wheel * lines * (alt ? ALT_WHEEL_SCROLL_MULTIPLIER : 1));
			}
			this.#syncFollowTail();
			return true;
		}

		if (event.release) {
			this.#draggingScrollbar = false;
			// A finished drag over the transcript commits the selection: push the
			// covered character range to the client clipboard via OSC 52 (the only
			// clipboard that reaches the user over SSH) and clear the highlight —
			// the transient "Copied N lines" chip confirms it landed. Requires
			// client support: most terminals and tmux (`set-clipboard on`) honor it.
			if (this.#draggingSelection) {
				this.#emitSelectionClipboard();
				this.#clearSelection();
			}
			// Mouse tracking is enabled for the whole fullscreen surface, so even a
			// release that did not end a scrollbar drag must stay out of the editor.
			return true;
		}

		// Drags keep tracking the pointer across the whole screen, so both
		// motion handlers run before the row is classified below.
		if (event.motion && this.#draggingScrollbar) {
			this.#scrollToPointer(event.row - this.#viewportTop);
			return true;
		}
		if (event.motion && (event.button & 3) === 0 && this.#draggingSelection) {
			this.#dragCol = event.col;
			const row = Math.max(0, Math.min(this.#viewportHeight - 1, event.row - this.#viewportTop));
			if (this.#selection) this.#selection.head = this.#pointAt(row, event.col);
			// Holding the drag against a viewport edge keeps scrolling so a
			// selection can extend past one screen.
			if (event.row <= this.#viewportTop) this.#startAutoScroll(-1);
			else if (event.row >= this.#viewportTop + this.#viewportHeight - 1) this.#startAutoScroll(1);
			else this.#stopAutoScroll();
			return true;
		}

		if (event.row >= this.#dockTop) {
			// Dock rows: a click on the editor's rows routes through the
			// MouseRoutable contract (click-to-position, CC-style); everything
			// else is consumed so the sequences never reach the editor.
			this.#routeEditorClick(event);
			return true;
		}

		// Chrome has its own rows and never maps to transcript text.
		if (event.row < this.#viewportTop) return true;
		if (event.row === this.#statusRow) {
			if (event.leftClick && this.#flash === undefined && !this.#followTail) {
				this.#scrollView.scrollToBottom();
				this.#syncFollowTail();
			}
			return true;
		}
		const scrollbarColumn = this.#scrollView.getMaxScrollOffset() > 0 ? this.#width - 1 : this.#width;
		if (event.leftClick && event.col === scrollbarColumn) {
			this.#draggingScrollbar = true;
			this.#clearSelection();
			this.#scrollToPointer(event.row - this.#viewportTop);
			return true;
		}
		// Character selection: press plants an anchor on the glyph under the
		// pointer; a quick second click selects the word, a third the line.
		if (event.leftClick && event.col < scrollbarColumn) {
			const point = this.#pointAt(event.row - this.#viewportTop, event.col);
			this.#stopAutoScroll();
			this.#draggingSelection = true;
			this.#draggingScrollbar = false;
			this.#followTail = false;
			this.#closeSearch(true); // starting a selection leaves search mode
			const clicks = this.#multiClickCount(event);
			this.#selection =
				clicks >= 2 ? this.#multiClickSelection(point.line, event.col, clicks) : { anchor: point, head: point };
			return true;
		}
		// Mouse tracking is active while fullscreen owns the TTY. Consume idle
		// motion and clicks so their escape sequences never enter the editor.
		return true;
	}

	/** Forwards a dock-area click into the editor with frame-local coordinates; other dock rows are simply consumed. */
	#routeEditorClick(event: SgrMouseEvent): void {
		if (!event.leftClick || this.#editorDockRows === undefined) return;
		const dockRow = event.row - this.#dockTop;
		if (dockRow < this.#editorDockRows.top || dockRow >= this.#editorDockRows.top + this.#editorDockRows.count) {
			return;
		}
		this.#closeSearch(true); // clicking into the composer leaves search mode
		this.options.editor().routeMouse(event, dockRow - this.#editorDockRows.top, event.col);
	}

	/** Selection endpoints in reading order. */
	#normalizedSelection(): [SelectionPoint, SelectionPoint] {
		const { anchor, head } = this.#selection!;
		return anchor.line < head.line || (anchor.line === head.line && anchor.unit <= head.unit)
			? [anchor, head]
			: [head, anchor];
	}

	#pointAt(viewportRow: number, visibleCol: number): SelectionPoint {
		const line = Math.max(
			0,
			Math.min(this.#scrollView.getScrollOffset() + viewportRow, this.#transcriptLines.length - 1),
		);
		return { line, unit: pickCodeUnit(this.#transcriptLines[line] ?? "", visibleCol) };
	}

	/** Counts chained clicks at the same cell within 500ms (double → word, triple+ → line). */
	#multiClickCount(event: SgrMouseEvent): number {
		const now = performance.now();
		const repeat =
			this.#lastClick !== undefined &&
			this.#lastClick.row === event.row &&
			this.#lastClick.col === event.col &&
			now - this.#lastClick.ms < 500;
		const count = repeat ? this.#lastClick!.count + 1 : 1;
		this.#lastClick = { ms: now, row: event.row, col: event.col, count };
		return count;
	}

	#multiClickSelection(
		line: number,
		visibleCol: number,
		clicks: number,
	): {
		anchor: SelectionPoint;
		head: SelectionPoint;
	} {
		const styled = this.#transcriptLines[line] ?? "";
		const text = stripTerminalSequences(styled);
		if (clicks >= 3) {
			return { anchor: { line, unit: 0 }, head: { line, unit: text.length } };
		}
		// Double-click: the whitespace-delimited word under the pointer; / and -
		// stay joined, matching terminal double-click selection.
		const [start, end] = wordRangeAt(text, pickCodeUnit(styled, visibleCol));
		return { anchor: { line, unit: start }, head: { line, unit: end } };
	}

	/** Push the selected transcript range (styled text stripped) to the client clipboard via OSC 52. */
	#emitSelectionClipboard(): void {
		if (this.#selection === undefined) return;
		const [first, last] = this.#normalizedSelection();
		const lines: string[] = [];
		for (let line = first.line; line <= last.line; line++) {
			const text = stripTerminalSequences(this.#transcriptLines[line] ?? "");
			lines.push(text.slice(line === first.line ? first.unit : 0, line === last.line ? last.unit : text.length));
		}
		// An anchor sitting at a line boundary contributes no text of its own.
		while (lines.length > 1 && lines[0]!.trim().length === 0) lines.shift();
		while (lines.length > 1 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
		const text = lines.map(line => line.trimEnd()).join("\n");
		if (text.length === 0) return;
		void copyToClipboard(text);
		this.#showFlash(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`);
	}

	/** Shows a transient copy confirmation below the transcript. */
	#showFlash(text: string): void {
		const durationMs = 1500;
		this.#flash = text;
		if (this.#flashTimer !== undefined) clearTimeout(this.#flashTimer);
		this.#flashTimer = setTimeout(() => {
			this.#flash = undefined;
			this.#flashTimer = undefined;
			this.options.requestRender?.();
		}, durationMs);
		this.options.requestRender?.();
	}

	#startAutoScroll(direction: number): void {
		if (this.#autoScrollDir === direction && this.#autoScrollTimer !== undefined) return;
		this.#stopAutoScroll();
		this.#autoScrollDir = direction;
		// Two rows per tick: fast enough to cross screens, slow enough to stop
		// where intended while the pointer holds the edge.
		this.#autoScrollTimer = setInterval(() => {
			this.#scrollView.scroll(direction * 2);
			if (this.#selection) {
				this.#selection.head = this.#pointAt(direction < 0 ? 0 : this.#viewportHeight - 1, this.#dragCol);
			}
			this.#syncFollowTail();
			this.options.requestRender?.();
		}, 50);
	}

	#stopAutoScroll(): void {
		if (this.#autoScrollTimer !== undefined) clearInterval(this.#autoScrollTimer);
		this.#autoScrollTimer = undefined;
		this.#autoScrollDir = 0;
	}

	#scrollToPointer(row: number): void {
		const max = this.#scrollView.getMaxScrollOffset();
		const denominator = Math.max(1, this.#viewportHeight - 1);
		const ratio = Math.max(0, Math.min(1, row / denominator));
		this.#scrollView.setScrollOffset(Math.round(max * ratio));
		this.#syncFollowTail();
	}
}

/** One literal query hit: [start, end) into the SGR-stripped line text (UTF-16 code units). */
type TranscriptMatch = { line: number; start: number; end: number };

/** Find literal case-insensitive query hits across SGR-stripped transcript lines. */
export function findTranscriptMatches(lines: readonly string[], query: string): TranscriptMatch[] {
	if (query.length === 0) return [];
	const pattern = new RegExp(RegExp.escape(query), "giu");
	const matches: TranscriptMatch[] = [];
	for (let line = 0; line < lines.length; line++) {
		for (const match of stripTerminalSequences(lines[line]!).matchAll(pattern)) {
			matches.push({ line, start: match.index, end: match.index + match[0].length });
		}
	}
	return matches;
}

/**
 * Re-insert reverse-video highlights around [start, end) ranges given as
 * indices into the SGR-stripped line text. Escape sequences pass through
 * untouched and do not consume index space; adjacent ranges merge so the
 * on/off sequences never interleave.
 */
export function highlightTranscriptRanges(line: string, ranges: readonly { start: number; end: number }[]): string {
	if (ranges.length === 0) return line;
	const merged: { start: number; end: number }[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = merged[merged.length - 1];
		if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	let out = "";
	let textIndex = 0;
	let rangeIndex = 0;
	let highlighted = false;
	let i = 0;
	while (i < line.length) {
		const end = endOfTerminalSequence(line, i);
		if (end > i) {
			out += line.slice(i, end);
			if (highlighted && line[i + 1] === "[" && line[end - 1] === "m") out += "\x1b[7m";
			i = end;
			continue;
		}
		const range = merged[rangeIndex];
		if (range !== undefined && textIndex === range.start) {
			out += "\x1b[7m";
			highlighted = true;
		}
		out += line[i];
		textIndex++;
		i++;
		if (range !== undefined && textIndex === range.end) {
			out += "\x1b[27m";
			highlighted = false;
			rangeIndex++;
		}
	}
	if (highlighted) out += "\x1b[27m";
	return out;
}

/** A character-selection anchor: absolute rendered line + code-unit offset in the SGR-stripped line text. */
type SelectionPoint = { line: number; unit: number };

/** Maps a visible column to a code-unit index in the SGR-stripped text of a styled line. */
function pickCodeUnit(line: string, visibleCol: number): number {
	return colToCodeUnitIndex(stripTerminalSequences(line), visibleCol);
}

/** Word range [start, end) around idx: whitespace-delimited, / and - stay joined (terminal double-click). */
function wordRangeAt(text: string, idx: number): [number, number] {
	const wordChar = (ch: string | undefined) => ch !== undefined && ch.trim().length > 0;
	let start = idx;
	while (wordChar(text[start - 1])) start--;
	let end = idx;
	while (wordChar(text[end])) end++;
	return [start, end];
}
