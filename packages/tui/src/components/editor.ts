import { getProjectDir, logger } from "@pk-nerdsaver-ai/pi-utils";
import {
	type AutocompleteProvider,
	type CombinedAutocompleteProvider,
	findLeadingSlashCommandStart,
} from "../autocomplete";
import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { KillRing } from "../kill-ring";
import type { SymbolTheme } from "../symbols";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const AUTOCOMPLETE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	overflowSearch: false,
};

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	overflowSearch: false,
	wrapDescription: true,
};

function sanitizeLoadedText(text: string): string {
	// Normalize CRLF/CR → LF, then strip C0 control chars except \n.
	return replaceTabs(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

const segmenter = getSegmenter();

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @returns Array of chunks with text and position information
 */
function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];

	// Split into tokens (words and whitespace runs)
	const tokens: { text: string; startIndex: number; endIndex: number; isWhitespace: boolean }[] = [];
	let currentToken = "";
	let tokenStart = 0;
	let inWhitespace = false;
	let charIndex = 0;

	for (const seg of segmenter.segment(line)) {
		const grapheme = seg.segment;
		const graphemeIsWhitespace = getWordNavKind(grapheme) === "whitespace";

		if (currentToken === "") {
			inWhitespace = graphemeIsWhitespace;
			tokenStart = charIndex;
		} else if (graphemeIsWhitespace !== inWhitespace) {
			// Token type changed - save current token
			tokens.push({
				text: currentToken,
				startIndex: tokenStart,
				endIndex: charIndex,
				isWhitespace: inWhitespace,
			});
			currentToken = "";
			tokenStart = charIndex;
			inWhitespace = graphemeIsWhitespace;
		}

		currentToken += grapheme;
		charIndex += grapheme.length;
	}

	// Push final token
	if (currentToken) {
		tokens.push({
			text: currentToken,
			startIndex: tokenStart,
			endIndex: charIndex,
			isWhitespace: inWhitespace,
		});
	}

	// Build chunks using word wrapping
	let currentChunk = "";
	let currentWidth = 0;
	let chunkStartIndex = 0;
	let atLineStart = true; // Track if we're at the start of a line (for skipping whitespace)

	function consumePrefixToWidth(text: string, availableWidth: number): { text: string; len: number } {
		let prefix = "";
		let prefixWidth = 0;
		let len = 0;
		for (const seg of segmenter.segment(text)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (prefixWidth + graphemeWidth > availableWidth) break;
			prefix += grapheme;
			prefixWidth += graphemeWidth;
			len += grapheme.length;
			if (prefixWidth === availableWidth) break;
		}
		return { text: prefix, len };
	}
	function hasWideGrapheme(text: string): boolean {
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 1) return true;
		}
		return false;
	}
	for (const token of tokens) {
		const tokenWidth = visibleWidth(token.text);

		// Skip leading whitespace at line start. Keep the skipped run mapped onto the
		// preceding chunk (when one exists) so every cursor position resolves to a
		// layout line instead of falling through to the buffer's last visual line.
		if (atLineStart && token.isWhitespace) {
			const prev = chunks[chunks.length - 1];
			if (prev) prev.endIndex = token.endIndex;
			chunkStartIndex = token.endIndex;
			continue;
		}
		atLineStart = false;

		// If this single token is wider than maxWidth, we need to break it
		if (tokenWidth > maxWidth) {
			// If we're mid-line, try to use the remaining width by consuming a prefix of this long token.
			let consumedPrefix = "";
			let consumedPrefixLen = 0; // JS string index (code units) consumed from token.text
			if (currentChunk && currentWidth < maxWidth) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				consumedPrefix = consumed.text;
				consumedPrefixLen = consumed.len;
			}
			// First, push any accumulated chunk (optionally filled with the prefix).
			if (currentChunk) {
				if (consumedPrefix) {
					chunks.push({
						text: currentChunk + consumedPrefix,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumedPrefixLen,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex + consumedPrefixLen;
				} else {
					chunks.push({
						text: currentChunk,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex,
					});
					currentChunk = "";
					currentWidth = 0;
					chunkStartIndex = token.startIndex;
				}
			}
			// Break the remaining long token by grapheme
			const remainingText = consumedPrefixLen > 0 ? token.text.slice(consumedPrefixLen) : token.text;
			let tokenChunk = "";
			let tokenChunkWidth = 0;
			let tokenChunkStart = token.startIndex + consumedPrefixLen;
			let tokenCharIndex = token.startIndex + consumedPrefixLen;
			for (const seg of segmenter.segment(remainingText)) {
				const grapheme = seg.segment;
				const graphemeWidth = visibleWidth(grapheme);
				if (tokenChunkWidth + graphemeWidth > maxWidth && tokenChunk) {
					chunks.push({
						text: tokenChunk,
						startIndex: tokenChunkStart,
						endIndex: tokenCharIndex,
					});
					tokenChunk = grapheme;
					tokenChunkWidth = graphemeWidth;
					tokenChunkStart = tokenCharIndex;
				} else {
					tokenChunk += grapheme;
					tokenChunkWidth += graphemeWidth;
				}
				tokenCharIndex += grapheme.length;
			}
			// Keep remainder as start of next chunk
			if (tokenChunk) {
				currentChunk = tokenChunk;
				currentWidth = tokenChunkWidth;
				chunkStartIndex = tokenChunkStart;
			}
			continue;
		}

		// Check if adding this token would exceed width
		if (currentWidth + tokenWidth > maxWidth) {
			// For wide-character tokens (e.g., CJK runs), prefer using remaining width before wrapping
			// the whole token to the next line. This avoids leaving a short ASCII word alone.
			if (currentChunk && !token.isWhitespace && currentWidth < maxWidth && hasWideGrapheme(token.text)) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.text, remainingWidth);
				if (consumed.text) {
					chunks.push({
						text: currentChunk + consumed.text,
						startIndex: chunkStartIndex,
						endIndex: token.startIndex + consumed.len,
					});
					const remainder = token.text.slice(consumed.len);
					currentChunk = remainder;
					currentWidth = visibleWidth(remainder);
					chunkStartIndex = token.startIndex + consumed.len;
					atLineStart = false;
					continue;
				}
			}
			// Push current chunk (trimming trailing whitespace for display)
			const trimmedChunk = currentChunk.trimEnd();
			if (trimmedChunk || chunks.length === 0) {
				chunks.push({
					text: trimmedChunk,
					startIndex: chunkStartIndex,
					endIndex: chunkStartIndex + currentChunk.length,
				});
			} else {
				// All-whitespace chunk collapsed away: keep its span mapped on the
				// previous chunk so cursor positions inside it stay addressable.
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = chunkStartIndex + currentChunk.length;
			}
			// Start new line - skip leading whitespace
			atLineStart = true;
			if (token.isWhitespace) {
				// Extend the preceding chunk over the whitespace run skipped at the wrap
				// point; otherwise cursor positions inside it map to no layout line.
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = token.endIndex;
				currentChunk = "";
				currentWidth = 0;
				chunkStartIndex = token.endIndex;
			} else {
				currentChunk = token.text;
				currentWidth = tokenWidth;
				chunkStartIndex = token.startIndex;
				atLineStart = false;
			}
		} else {
			// Add token to current chunk
			currentChunk += token.text;
			currentWidth += tokenWidth;
		}
	}

	// Push final chunk
	if (currentChunk) {
		chunks.push({
			text: currentChunk,
			startIndex: chunkStartIndex,
			endIndex: line.length,
		});
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}

/** Visual cell column of code-unit `offset` within `text`, counted by grapheme walk. */
function visualColAtOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	let col = 0;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= offset) break;
		col += visibleWidth(seg.segment);
	}
	return col;
}

/** Code-unit offset of visual cell `col` within `text`, snapped to a grapheme
 *  boundary so the result never splits a surrogate pair or cluster. */
function offsetAtVisualCol(text: string, col: number): number {
	if (col <= 0) return 0;
	let current = 0;
	for (const seg of segmenter.segment(text)) {
		const width = visibleWidth(seg.segment);
		if (current + width > col) return seg.index;
		current += width;
	}
	return text.length;
}

/** Highest visual column the cursor may occupy on a wrap segment: the full width
 *  on a logical line's last segment, otherwise just before the final grapheme
 *  (the segment end is the next segment's start). */
function maxSegmentVisualCol(text: string, isLastSegment: boolean): number {
	let total = 0;
	let lastWidth = 0;
	for (const seg of segmenter.segment(text)) {
		lastWidth = visibleWidth(seg.segment);
		total += lastWidth;
	}
	return isLastSegment ? total : Math.max(0, total - lastWidth);
}

const DEFAULT_PAGE_SCROLL_LINES = 10;

const MAX_UNDO_STACK = 100;

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
	editorPaddingX?: number;
	/** Style function for inline hint/ghost text (dim text after cursor) */
	hintStyle?: (text: string) => string;
}

export interface EditorTopBorder {
	/** The status content (already styled) */
	content: string;
	/** Visible width of the content */
	width: number;
}

interface HistoryEntry {
	prompt: string;
}

interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number): HistoryEntry[];
}

type HistoryCursorAnchor = "start" | "end";

export class Editor implements Component, Focusable {
	#state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	#theme: EditorTheme;
	#useTerminalCursor = false;

	/** When set, replaces the normal cursor glyph at end-of-text with this ANSI-styled string. */
	cursorOverride: string | undefined;
	/** Display width of the cursorOverride glyph (needed because override may contain ANSI escapes). */
	cursorOverrideWidth: number | undefined;
	/** Optional hook that styles displayed input text with zero-width ANSI escapes.
	 *  MUST preserve visible width (may only add SGR codes, never glyphs). Applied per
	 *  layout line to the user-text segments — never to the cursor glyph or inline hint. */
	decorateText: ((text: string) => string) | undefined;
	#promptGutter: string | undefined;

	// Store last layout width for cursor navigation
	#lastLayoutWidth: number = 80;
	// Word-wrap result cache shared by #layoutText, #buildVisualLineMap, and key
	// handlers within a frame. Line text is a sound key (strings are immutable);
	// cleared on width change and size-bounded so stale lines don't accumulate.
	#wrapCache = new Map<string, TextChunk[]>();
	#wrapCacheWidth = -1;
	#paddingXOverride: number | undefined;
	#maxHeight?: number;
	#scrollOffset: number = 0;

	// Emacs-style kill ring
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	#jumpMode: "forward" | "backward" | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	#preferredVisualCol: number | null = null;

	// Border color (can be changed dynamically)
	borderColor: (str: string) => string;

	// Autocomplete support
	#autocompleteProvider?: AutocompleteProvider;
	#autocompleteList?: SelectList;
	#autocompleteState: "regular" | "force" | null = null;
	#autocompletePrefix: string = "";
	#autocompleteRequestId: number = 0;
	#autocompleteMaxVisible: number = 5;
	onAutocompleteUpdate?: () => void;

	// Paste tracking for large pastes
	#pastes: Map<number, string> = new Map();
	#pasteCounter: number = 0;

	/** Optional pattern matching atomic placeholder tokens (e.g. `[Image #1, 800x600]` or
	 *  `[Paste #2, +30 lines]`) that the editor treats as indivisible: a backspace or forward-delete
	 *  landing on any character of a token removes the whole token instead of corrupting it into
	 *  stray text. MUST be a global regex; the editor recompiles a private copy so its `lastIndex`
	 *  is never shared with the caller. */
	atomicTokenPattern: RegExp | undefined;
	#atomicTokenSource: string | undefined;
	#atomicTokenRe: RegExp | undefined;

	// Bracketed paste mode buffering
	#pasteHandler = new BracketedPasteHandler();

	// Prompt history for up/down navigation
	#history: string[] = [];
	#historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.
	#historyStorage?: HistoryStorage;

	// Undo stack for editor state changes
	#undoStack: EditorState[] = [];
	#suspendUndo = false;

	// Debounce timer for autocomplete updates
	#autocompleteTimeout?: NodeJS.Timeout;

	onSubmit?: (text: string) => void | Promise<void>;
	onAltEnter?: (text: string) => void;
	onChange?: (text: string) => void;
	/** Called for a "marker-sized" paste — the point where the editor would otherwise collapse it
	 *  into a `[Paste #N]` token (> 10 lines or > 1000 characters). Return `true` to intercept:
	 *  the editor inserts nothing and records no undo state, leaving insertion to the host (e.g. a
	 *  "wrap in a code block / XML / attach as file" menu for very large pastes), which re-inserts
	 *  via {@link insertPaste} or {@link insertText}. Return `false` (or leave unset) for the
	 *  default collapse-to-marker behavior. `lineCount` is the sanitized paste's line count. */
	onLargePaste?: (text: string, lineCount: number) => boolean;
	onAutocompleteCancel?: () => void;
	disableSubmit: boolean = false;

	// Custom top border (for status line integration)
	#topBorderContent?: EditorTopBorder;
	#borderVisible = true;

	constructor(theme: EditorTheme) {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
	}

	/**
	 * Set custom content for the top border (e.g., status line).
	 * Pass undefined to use the default plain border.
	 */
	setTopBorder(content: EditorTopBorder | undefined): void {
		this.#topBorderContent = content;
	}

	/**
	 * Show or hide the editor border chrome.
	 */
	setBorderVisible(borderVisible: boolean): void {
		this.#borderVisible = borderVisible;
	}

	setPromptGutter(promptGutter: string | undefined): void {
		this.#promptGutter = promptGutter;
	}

	/**
	 * Get the available width for top border content given a total terminal width.
	 * Accounts for the border characters and horizontal padding when visible.
	 */
	getTopBorderAvailableWidth(terminalWidth: number): number {
		const paddingX = this.#getEditorPaddingX();
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, terminalWidth - borderWidth * 2);
	}

	/**
	 * Use the real terminal cursor instead of rendering a cursor glyph.
	 */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	setMaxHeight(maxHeight: number | undefined): void {
		if (this.#maxHeight === maxHeight) return;
		this.#maxHeight = maxHeight;
		// Don't reset scrollOffset — #updateScrollOffset will clamp it on next render
	}

	setPaddingX(paddingX: number): void {
		this.#paddingXOverride = Math.max(0, paddingX);
	}

	getAutocompleteMaxVisible(): number {
		return this.#autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.#autocompleteMaxVisible !== newMaxVisible) {
			this.#autocompleteMaxVisible = newMaxVisible;
		}
	}

	setHistoryStorage(storage: HistoryStorage): void {
		this.#historyStorage = storage;
		const recent = storage.getRecent(100);
		this.#history = recent.map(entry => entry.prompt);
		this.#historyIndex = -1;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.#history.length > 0 && this.#history[0] === trimmed) return;
		this.#history.unshift(trimmed);
		// Limit history size
		if (this.#history.length > 100) {
			this.#history.pop();
		}

		const stor = this.#historyStorage;
		if (stor) {
			stor.add(trimmed, getProjectDir()).catch(error => {
				logger.error("HistoryStorage add failed", { error: String(error) });
			});
		}
	}

	#isEditorEmpty(): boolean {
		return this.#state.lines.length === 1 && this.#state.lines[0] === "";
	}

	#isOnFirstVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	#isOnLastVisualLine(): boolean {
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	#navigateHistory(direction: 1 | -1): void {
		this.#resetKillSequence();
		if (this.#history.length === 0) return;
		const newIndex = this.#historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.#history.length) return;
		this.#historyIndex = newIndex;
		if (this.#historyIndex === -1) {
			// Returned to "current" state - clear editor
			this.#setTextInternal("", "end");
		} else {
			const cursorAnchor: HistoryCursorAnchor = direction === -1 ? "start" : "end";
			this.#setTextInternal(this.#history[this.#historyIndex] || "", cursorAnchor);
		}
	}
	/** Internal setText that doesn't reset history state - used by navigateHistory */
	#setTextInternal(text: string, cursorAnchor: HistoryCursorAnchor = "end"): void {
		this.#undoStack.length = 0;
		const lines = sanitizeLoadedText(text).split("\n");
		this.#state.lines = lines.length === 0 ? [""] : lines;
		if (cursorAnchor === "start") {
			this.#state.cursorLine = 0;
			this.#setCursorCol(0);
		} else {
			this.#state.cursorLine = this.#state.lines.length - 1;
			this.#setCursorCol(this.#state.lines[this.#state.cursorLine]?.length || 0);
		}
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#getEditorPaddingX(): number {
		const padding = this.#paddingXOverride ?? this.#theme.editorPaddingX ?? 2;
		return Math.max(0, padding);
	}

	#getHorizontalChromeWidth(paddingX: number): number {
		return this.#borderVisible ? paddingX + 1 : 0;
	}

	#getPromptGutterWidth(width: number, paddingX: number): number {
		if (this.#borderVisible || !this.#promptGutter) return 0;
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		const availableWidth = Math.max(0, width - chromeWidth);
		return Math.min(visibleWidth(this.#promptGutter), availableWidth);
	}

	#getPromptGutter(
		width: number,
		paddingX: number,
	): { firstLine: string; continuation: string; width: number } | undefined {
		if (this.#borderVisible || !this.#promptGutter) return undefined;
		const gutterWidth = this.#getPromptGutterWidth(width, paddingX);
		if (gutterWidth === 0) return undefined;
		return {
			firstLine: sliceByColumn(this.#promptGutter, 0, gutterWidth, true),
			continuation: padding(gutterWidth),
			width: gutterWidth,
		};
	}

	#getContentWidth(width: number, paddingX: number): number {
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		return Math.max(0, width - chromeWidth - this.#getPromptGutterWidth(width, paddingX));
	}

	#getLayoutWidth(width: number, paddingX: number): number {
		const contentWidth = this.#getContentWidth(width, paddingX);
		const cursorReserve = this.#borderVisible && paddingX === 0 ? 1 : 0;
		// Keep cursor/scroll layout addressable even when a borderless prompt gutter consumes every visible column.
		return Math.max(1, contentWidth - cursorReserve);
	}

	#getVisibleContentHeight(contentLines: number): number {
		if (this.#maxHeight === undefined) return contentLines;
		const verticalChrome = this.#borderVisible ? 2 : 0;
		return Math.max(1, this.#maxHeight - verticalChrome);
	}

	/** Apply the optional input decorator to a plain (ANSI-free) text segment.
	 *  Decoration only adds zero-width SGR codes, so visible width is unchanged.
	 *  Splits around CURSOR_MARKER so each user-text segment is decorated in
	 *  isolation: the marker begins with ESC, and a keyword regex that pins
	 *  the right boundary with `(?!\S)` would otherwise reject an otherwise-
	 *  valid match at the cursor seam (e.g. `ultrathink` immediately followed
	 *  by the marker stops glowing until a trailing character is typed). */
	#decorate(text: string): string {
		const decorate = this.decorateText;
		if (decorate === undefined || text.length === 0) return text;
		const idx = text.indexOf(CURSOR_MARKER);
		if (idx === -1) return decorate(text);
		const before = text.slice(0, idx);
		const after = text.slice(idx + CURSOR_MARKER.length);
		return (before.length > 0 ? decorate(before) : "") + CURSOR_MARKER + (after.length > 0 ? decorate(after) : "");
	}

	#getStyledInputCursor(): { text: string; width: number } {
		const cursorChar = this.#theme.symbols.inputCursor;
		// Keep the software cursor steady. Ghostty/cmux can leave visual
		// afterimages for SGR blink cells during rapid input-row repaints.
		return { text: cursorChar, width: visibleWidth(cursorChar) };
	}

	#renderEndOfLineCursorAtWidthLimit(
		before: string,
		marker: string,
		maxWidth: number,
		replacement?: { text: string; width: number },
	): { text: string; width: number } {
		const beforeGraphemes = [...segmenter.segment(before)];
		const lastGrapheme = beforeGraphemes[beforeGraphemes.length - 1]?.segment;
		const lastGraphemeWidth = lastGrapheme ? visibleWidth(lastGrapheme) : 0;
		const builtInCursor = this.#getStyledInputCursor();
		const fallbackReplacement = lastGrapheme
			? { text: `\x1b[7m${lastGrapheme}\x1b[0m`, width: lastGraphemeWidth }
			: builtInCursor;
		const clampReplacement = (candidate: { text: string; width: number }): { text: string; width: number } => {
			let text = sliceByColumn(candidate.text, 0, maxWidth, true);
			let width = visibleWidth(text);
			if (width > maxWidth) {
				text = "";
				width = 0;
			}
			return { text, width };
		};

		let clampedReplacement = clampReplacement(replacement ?? fallbackReplacement);
		if (replacement && clampedReplacement.width === 0) {
			// A custom override that cannot fit at all should first fall back to the highlighted tail.
			clampedReplacement = clampReplacement(fallbackReplacement);
		}
		if (lastGrapheme && clampedReplacement.width === 0) {
			// If even the highlighted trailing grapheme cannot fit, show the built-in single-column cursor.
			clampedReplacement = clampReplacement(builtInCursor);
		}

		const replacedSpanWidth = Math.min(maxWidth, Math.max(lastGraphemeWidth, clampedReplacement.width));
		const prefixWidth = Math.max(0, maxWidth - replacedSpanWidth);
		const beforePrefix = sliceByColumn(before, 0, prefixWidth, true);
		const replacementPad = padding(Math.max(0, replacedSpanWidth - clampedReplacement.width));
		return {
			text: `${beforePrefix}${replacementPad}${clampedReplacement.text}${marker}`,
			width: visibleWidth(beforePrefix) + replacedSpanWidth,
		};
	}

	#renderTerminalCursorMarker(text: string, marker: string, maxWidth: number): string {
		if (!marker) return text;
		if (visibleWidth(text) < maxWidth) {
			return text + marker;
		}

		let insertAt = text.length;
		let offset = 0;
		for (const seg of segmenter.segment(text)) {
			if (visibleWidth(seg.segment) > 0) {
				insertAt = offset;
			}
			offset += seg.segment.length;
		}

		return `${text.slice(0, insertAt)}${marker}${text.slice(insertAt)}`;
	}

	#getPageScrollStep(totalVisualLines: number): number {
		const visibleHeight =
			this.#maxHeight === undefined ? DEFAULT_PAGE_SCROLL_LINES : this.#getVisibleContentHeight(totalVisualLines);
		return Math.max(1, visibleHeight - 1);
	}

	#updateScrollOffset(layoutWidth: number, layoutLines: LayoutLine[], visibleHeight: number): void {
		if (layoutLines.length <= visibleHeight) {
			this.#scrollOffset = 0;
			return;
		}

		const visualLines = this.#buildVisualLineMap(layoutWidth);
		const cursorLine = this.#findCurrentVisualLine(visualLines);
		if (cursorLine < this.#scrollOffset) {
			this.#scrollOffset = cursorLine;
		} else if (cursorLine >= this.#scrollOffset + visibleHeight) {
			this.#scrollOffset = cursorLine - visibleHeight + 1;
		}

		const maxOffset = Math.max(0, layoutLines.length - visibleHeight);
		this.#scrollOffset = Math.min(this.#scrollOffset, maxOffset);
	}

	render(width: number): readonly string[] {
		const paddingX = this.#getEditorPaddingX();
		const borderVisible = this.#borderVisible;
		const promptGutter = this.#getPromptGutter(width, paddingX);
		const contentAreaWidth = this.#getContentWidth(width, paddingX);
		const layoutWidth = this.#getLayoutWidth(width, paddingX);
		this.#lastLayoutWidth = layoutWidth;

		// Box-drawing characters for rounded corners
		const box = this.#theme.symbols.boxRound;
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);
		const topLeft = this.borderColor(`${box.topLeft}${box.horizontal.repeat(paddingX)}`);
		const topRight = this.borderColor(`${box.horizontal.repeat(paddingX)}${box.topRight}`);
		const bottomLeft = this.borderColor(`${box.bottomLeft}${box.horizontal}${padding(Math.max(0, paddingX - 1))}`);
		const horizontal = this.borderColor(box.horizontal);

		// Layout the text
		const layoutLines = this.#layoutText(layoutWidth);
		const visibleContentHeight = this.#getVisibleContentHeight(layoutLines.length);
		this.#updateScrollOffset(layoutWidth, layoutLines, visibleContentHeight);
		const visibleLayoutLines = layoutLines.slice(this.#scrollOffset, this.#scrollOffset + visibleContentHeight);

		const result: string[] = [];

		if (borderVisible) {
			// Render top border: ╭─ [status content] ────────────────╮
			const topFillWidth = Math.max(0, width - borderWidth * 2);
			if (this.#topBorderContent) {
				const { content, width: statusWidth } = this.#topBorderContent;
				if (statusWidth <= topFillWidth) {
					// Status fits - add fill after it
					const fillWidth = topFillWidth - statusWidth;
					result.push(topLeft + content + this.borderColor(box.horizontal.repeat(fillWidth)) + topRight);
				} else {
					// Status too long - truncate it
					const truncated = truncateToWidth(content, Math.max(0, topFillWidth - 1));
					const truncatedWidth = visibleWidth(truncated);
					const fillWidth = Math.max(0, topFillWidth - truncatedWidth);
					result.push(topLeft + truncated + this.borderColor(box.horizontal.repeat(fillWidth)) + topRight);
				}
			} else {
				result.push(topLeft + horizontal.repeat(topFillWidth) + topRight);
			}
		}

		// Render each layout line
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.#autocompleteState;
		const lineContentWidth = contentAreaWidth;

		// Compute inline hint text (dim ghost text after cursor)
		const inlineHint = this.#getInlineHint();
		const hintStyle = this.#theme.hintStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);

		for (let visibleIndex = 0; visibleIndex < visibleLayoutLines.length; visibleIndex++) {
			const layoutLine = visibleLayoutLines[visibleIndex]!;
			let displayText = layoutLine.text;
			let displayWidth = visibleWidth(layoutLine.text);
			let cursorPaddingOverflow = 0;
			let decorated = false;
			const showPromptGutter = promptGutter !== undefined && visibleIndex === 0;
			const gutterText =
				promptGutter === undefined ? "" : showPromptGutter ? promptGutter.firstLine : promptGutter.continuation;

			// Add cursor if this line has it
			const hasCursor = layoutLine.hasCursor && layoutLine.cursorPos !== undefined;
			const marker = emitCursorMarker ? CURSOR_MARKER : "";

			if (!borderVisible && displayWidth > lineContentWidth) {
				displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
				displayWidth = visibleWidth(displayText);
			}

			if (!borderVisible && lineContentWidth === 0) {
				if (hasCursor && !this.#useTerminalCursor) {
					const zeroWidthCursorBudget = visibleWidth(gutterText);
					const zeroWidthCursorReplacement = this.cursorOverride
						? { text: this.cursorOverride, width: this.cursorOverrideWidth ?? 1 }
						: this.#getStyledInputCursor();
					if (showPromptGutter && zeroWidthCursorBudget > 0) {
						// Keep the leading prompt glyph visible when the gutter consumes the whole row.
						const promptGlyph = [...segmenter.segment(gutterText)][0]?.segment ?? "";
						const promptGlyphWidth = visibleWidth(promptGlyph);
						const remainingCursorWidth = Math.max(0, zeroWidthCursorBudget - promptGlyphWidth);
						if (remainingCursorWidth === 0) {
							result.push(`\x1b[7m${promptGlyph}\x1b[0m${marker}`);
						} else {
							const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
								"",
								marker,
								remainingCursorWidth,
								zeroWidthCursorReplacement,
							);
							result.push(`${promptGlyph}${widthLimitedCursor.text}`);
						}
					} else {
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(
							gutterText,
							marker,
							zeroWidthCursorBudget,
							zeroWidthCursorReplacement,
						);
						result.push(widthLimitedCursor.text);
					}
				} else if (hasCursor && this.#useTerminalCursor) {
					result.push(this.#renderTerminalCursorMarker(gutterText, marker, visibleWidth(gutterText)));
				} else {
					result.push(gutterText + (hasCursor ? marker : ""));
				}
				continue;
			}

			if (hasCursor && this.#useTerminalCursor) {
				if (marker) {
					const before = displayText.slice(0, layoutLine.cursorPos);
					const after = displayText.slice(layoutLine.cursorPos);
					if (after.length === 0 && inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth);
						const hintText = hintStyle(truncateToWidth(inlineHint, availWidth));
						displayText = before + marker + hintText;
						displayWidth += Math.min(visibleWidth(inlineHint), availWidth);
					} else if (after.length === 0 && !borderVisible && displayWidth >= lineContentWidth) {
						displayText = this.#renderTerminalCursorMarker(before, marker, lineContentWidth);
					} else {
						displayText = before + marker + after;
					}
				}
			} else if (hasCursor && !this.#useTerminalCursor) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					const afterGraphemes = [...segmenter.segment(after)];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
					// Decorate the plain text on each side of the cursor glyph. The reverse-video
					// reset (\x1b[0m) ends in "m" (a word char), so a boundary match on restAfter
					// would fail in the whole-line fallback below — decorate the segments here.
					displayText = this.#decorate(before) + marker + cursor + this.#decorate(restAfter);
					decorated = true;
					// displayWidth stays the same - we're replacing, not adding
				} else if (this.cursorOverride) {
					// Cursor override replaces the normal end-of-text cursor glyph
					const overrideWidth = this.cursorOverrideWidth ?? 1;
					if (!borderVisible && displayWidth + overrideWidth > lineContentWidth) {
						// Borderless editors have no spare padding cell for an end-of-line cursor glyph.
						// Preserve cursorOverride by replacing the tail of the line with it.
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth, {
							text: this.cursorOverride,
							width: overrideWidth,
						});
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - overrideWidth);
						const hintText = hintStyle(truncateToWidth(inlineHint, availWidth));
						displayText = before + marker + this.cursorOverride + hintText;
						displayWidth += overrideWidth + Math.min(visibleWidth(inlineHint), availWidth);
					} else {
						displayText = before + marker + this.cursorOverride;
						displayWidth += overrideWidth;
					}
				} else {
					// Cursor is at the end - add thin cursor glyph
					const { text: cursor, width: cursorWidth } = this.#getStyledInputCursor();
					if (!borderVisible && displayWidth + cursorWidth > lineContentWidth) {
						// Borderless editors have no spare padding cell for an end-of-line cursor glyph.
						// Highlight the last grapheme so the cursor stays visible without consuming width.
						const widthLimitedCursor = this.#renderEndOfLineCursorAtWidthLimit(before, marker, lineContentWidth);
						displayText = widthLimitedCursor.text;
						displayWidth = widthLimitedCursor.width;
					} else if (inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth - cursorWidth);
						const hintText = hintStyle(truncateToWidth(inlineHint, availWidth));
						displayText = before + marker + cursor + hintText;
						displayWidth += cursorWidth + Math.min(visibleWidth(inlineHint), availWidth);
					} else {
						displayText = before + marker + cursor;
						displayWidth += cursorWidth;
					}
					if (displayWidth > lineContentWidth && paddingX > 0) {
						cursorPaddingOverflow = displayWidth - lineContentWidth;
					}
				}
			}

			// No cursor on this line, or a branch that left the user text intact: decorate
			// the whole line. `#decorate` splits around CURSOR_MARKER so a keyword glued to
			// the cursor still satisfies its right-boundary lookahead.
			if (!decorated) {
				displayText = this.#decorate(displayText);
			}

			const linePad = padding(Math.max(0, lineContentWidth - displayWidth));

			if (!borderVisible) {
				result.push(gutterText + displayText + linePad);
				continue;
			}

			// All lines have consistent borders based on padding. When the end-of-line cursor
			// glyph (or a wide trailing grapheme) extends past `lineContentWidth`, shrink the
			// right chrome by the exact overflow count: drop padding spaces first, then the
			// trailing `─`, but never the corner/vertical bar itself.
			const isLastLine = visibleIndex === visibleLayoutLines.length - 1;
			const rightChromeCells = Math.max(1, paddingX + 1 - cursorPaddingOverflow);
			if (isLastLine) {
				const rightPad = Math.max(0, rightChromeCells - 2);
				const includeHorizontal = rightChromeCells >= 2;
				const bottomRightAdjusted = this.borderColor(
					`${padding(rightPad)}${includeHorizontal ? box.horizontal : ""}${box.bottomRight}`,
				);
				result.push(`${bottomLeft}${displayText}${linePad}${bottomRightAdjusted}`);
			} else {
				const leftBorder = this.borderColor(`${box.vertical}${padding(paddingX)}`);
				const rightBorder = this.borderColor(`${padding(Math.max(0, rightChromeCells - 1))}${box.vertical}`);
				result.push(leftBorder + displayText + linePad + rightBorder);
			}
		}

		// Add autocomplete list if active
		if (this.#autocompleteState && this.#autocompleteList) {
			const autocompleteResult = this.#autocompleteList.render(width);
			result.push(...autocompleteResult);
		}

		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.#jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.#jumpMode = null;
				return;
			}

			const printableText = extractPrintableText(data);
			if (printableText) {
				const direction = this.#jumpMode;
				this.#jumpMode = null;
				this.#jumpToChar(printableText, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.#jumpMode = null;
		}

		// Handle bracketed paste mode
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		// Handle special key combinations first

		// Ctrl+C is reserved by parent components for app-level handling.
		// Do not consume arbitrary user-bound "copy" keys here, since the editor
		// has no copy implementation and would make those keys disappear.
		if (matchesKey(data, "ctrl+c")) {
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.#applyUndo();
			return;
		}

		// Handle autocomplete special keys first (but don't block other input)
		if (this.#autocompleteState && this.#autocompleteList) {
			// Escape - cancel autocomplete
			if (kb.matches(data, "tui.select.cancel")) {
				this.#cancelAutocomplete(true);
				return;
			}
			// Let the autocomplete list handle navigation and selection
			else if (
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.pageUp") ||
				kb.matches(data, "tui.select.pageDown") ||
				kb.matches(data, "tui.input.submit") ||
				data === "\n" ||
				kb.matches(data, "tui.input.tab")
			) {
				// Only pass navigation keys to the list, not Enter/Tab (we handle those directly)
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.pageUp") ||
					kb.matches(data, "tui.select.pageDown")
				) {
					this.#autocompleteList.handleInput(data);
					this.onAutocompleteUpdate?.();
					return;
				}

				// If Tab was pressed, always apply the selection
				if (kb.matches(data, "tui.input.tab")) {
					const selected = this.#autocompleteList.getSelectedItem();
					if (selected && this.#autocompleteProvider) {
						const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							this.#autocompletePrefix,
						);

						this.#state.lines = result.lines;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);

						this.#cancelAutocomplete();
						this.onAutocompleteUpdate?.();

						if (this.onChange) {
							this.onChange(this.getText());
						}

						result.onApplied?.();

						if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
							void this.#tryTriggerAutocomplete();
						}
					}
					return;
				}

				// If Enter was pressed on a slash command, apply completion and submit
				if (
					(kb.matches(data, "tui.input.submit") || data === "\n") &&
					findLeadingSlashCommandStart(this.#autocompletePrefix) !== null
				) {
					// Check for stale autocomplete state due to debounce
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (currentTextBeforeCursor !== this.#autocompletePrefix) {
						// Autocomplete is stale - cancel and fall through to normal submission
						this.#cancelAutocomplete();
					} else {
						const selected = this.#autocompleteList.getSelectedItem();
						if (selected && this.#autocompleteProvider) {
							const result = this.#autocompleteProvider.applyCompletion(
								this.#state.lines,
								this.#state.cursorLine,
								this.#state.cursorCol,
								selected,
								this.#autocompletePrefix,
							);

							this.#state.lines = result.lines;
							this.#state.cursorLine = result.cursorLine;
							this.#setCursorCol(result.cursorCol);
							result.onApplied?.();
						}
						this.#cancelAutocomplete();
					}
					// Don't return - fall through to submission logic
				}
				// If Enter was pressed on a file path, apply completion
				else if (kb.matches(data, "tui.input.submit") || data === "\n") {
					const selected = this.#autocompleteList.getSelectedItem();
					if (selected && this.#autocompleteProvider) {
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							this.#autocompletePrefix,
						);

						this.#state.lines = result.lines;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);

						this.#cancelAutocomplete();
						this.onAutocompleteUpdate?.();

						if (this.onChange) {
							this.onChange(this.getText());
						}

						result.onApplied?.();
					}
					return;
				}
			}
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}

		// Tab key - context-aware completion (but not when already autocompleting)
		if (kb.matches(data, "tui.input.tab") && !this.#autocompleteState) {
			this.#handleTabCompletion();
			return;
		}

		// Continue with rest of input handling
		// Ctrl+K - Delete to end of line
		if (matchesKey(data, "ctrl+k")) {
			this.#deleteToEndOfLine();
		}
		// Ctrl+U - Delete to start of line
		else if (matchesKey(data, "ctrl+u")) {
			this.#deleteToStartOfLine();
		}
		// Ctrl+W - Delete word backwards
		else if (matchesKey(data, "ctrl+w")) {
			this.#deleteWordBackwards();
		}
		// Option/Alt+Backspace - Delete word backwards.
		// Ghostty on macOS reports Option+Backspace as super+alt (kitty mod 11) — see #2064.
		else if (matchesKey(data, "alt+backspace") || matchesKey(data, "super+alt+backspace")) {
			this.#deleteWordBackwards();
		}
		// Option/Alt+D and Option+Delete - Delete word forwards. Same Ghostty quirk applies.
		else if (
			matchesKey(data, "alt+d") ||
			matchesKey(data, "alt+delete") ||
			matchesKey(data, "super+alt+d") ||
			matchesKey(data, "super+alt+delete")
		) {
			this.#deleteWordForwards();
		}
		// Ctrl+Y - Yank from kill ring
		else if (matchesKey(data, "ctrl+y")) {
			this.#yankFromKillRing();
		}
		// Alt+Y - Yank-pop (cycle kill ring)
		else if (matchesKey(data, "alt+y")) {
			this.#yankPop();
		}
		// Ctrl+A - Move to start of line
		else if (matchesKey(data, "ctrl+a")) {
			this.#moveToLineStart();
		}
		// Ctrl+E - Move to end of line
		else if (matchesKey(data, "ctrl+e")) {
			this.#moveToLineEnd();
		}
		// Alt+Enter - special handler if callback exists, otherwise new line
		else if (matchesKey(data, "alt+enter")) {
			if (this.onAltEnter) {
				this.onAltEnter(this.getText());
			} else {
				this.#addNewLine();
			}
		}
		// New line
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
			matchesKey(data, "ctrl+enter") || // Ctrl+Enter (Kitty/modifyOtherKeys, including lock bits/keypad Enter)
			data === "\x1b\r" || // Option+Enter in some terminals (legacy)
			data === "\x1b[13;2~" || // Shift+Enter in some terminals (legacy format)
			kb.matches(data, "tui.input.newLine") || // Shift+Enter (Kitty protocol, handles lock bits)
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1) // Shift+Enter from iTerm2 mapping
		) {
			if (this.#shouldSubmitOnBackslashEnter(data, kb)) {
				this.#handleBackspace();
				this.#submitValue();
				return;
			}
			this.#addNewLine();
		}
		// Plain Enter - submit (handles both legacy \r and Kitty protocol with lock bits)
		else if (kb.matches(data, "tui.input.submit") || data === "\n") {
			// If submit is disabled, do nothing
			if (this.disableSubmit) {
				return;
			}

			// Synchronous slash command completion for the race condition where
			// async autocomplete hasn't resolved yet (user types /q quickly + Enter).
			// Match the existing selected-item behavior when autocomplete IS showing.
			if (!this.#autocompleteState) {
				const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				if (
					findLeadingSlashCommandStart(textBeforeCursor) !== null &&
					this.#isInSubmittedSlashCommandContext() &&
					this.#autocompleteProvider?.trySyncSlashCompletion
				) {
					const syncResult = this.#autocompleteProvider.trySyncSlashCompletion(textBeforeCursor);
					if (syncResult && syncResult.items.length > 0) {
						// Invalidate any pending async autocomplete so its stale results are discarded
						this.#autocompleteRequestId += 1;
						// Apply the best match and submit the completed command
						const selected = syncResult.items[0]!;
						const result = this.#autocompleteProvider.applyCompletion(
							this.#state.lines,
							this.#state.cursorLine,
							this.#state.cursorCol,
							selected,
							syncResult.prefix,
						);
						this.#state.lines = result.lines;
						this.#state.cursorLine = result.cursorLine;
						this.#setCursorCol(result.cursorCol);
						result.onApplied?.();
					}
				}
			}

			this.#submitValue();
		}
		// Backspace (including Shift+Backspace)
		else if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.#handleBackspace();
		}
		// Line navigation shortcuts (Home/End keys)
		else if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#moveToLineStart();
		} else if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#moveToLineEnd();
		}
		// Page navigation (PageUp/PageDown)
		else if (kb.matches(data, "tui.editor.pageUp")) {
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1);
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1);
			} else {
				this.#pageScroll(-1);
			}
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1);
			} else {
				this.#pageScroll(1);
			}
		}
		// Forward delete (Fn+Backspace or Delete key, including Shift+Delete)
		else if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.#handleForwardDelete();
		}
		// Word navigation (Option/Alt + Arrow or Ctrl + Arrow)
		else if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			// Word left
			this.#resetKillSequence();
			this.#moveWordBackwards();
		} else if (kb.matches(data, "tui.editor.cursorWordRight")) {
			// Word right
			this.#resetKillSequence();
			this.#moveWordForwards();
		}
		// Arrow keys
		else if (kb.matches(data, "tui.editor.cursorUp")) {
			// Up - history navigation or cursor movement
			if (this.#isEditorEmpty()) {
				this.#navigateHistory(-1); // Start browsing history
			} else if (this.#historyIndex > -1 && this.#isOnFirstVisualLine()) {
				this.#navigateHistory(-1); // Navigate to older history entry
			} else if (this.#isOnFirstVisualLine()) {
				// Already at top - jump to start of line
				this.#moveToLineStart();
			} else {
				this.#moveCursor(-1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorDown")) {
			// Down - history navigation or cursor movement
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1); // Navigate to newer history entry or clear
			} else if (this.#isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.#moveToLineEnd();
			} else {
				this.#moveCursor(1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matches(data, "tui.editor.cursorRight")) {
			// Right
			this.#moveCursor(0, 1);
		} else if (kb.matches(data, "tui.editor.cursorLeft")) {
			// Left
			this.#moveCursor(0, -1);
		}
		// Shift+Space - insert regular space (Kitty protocol sends escape sequence)
		else if (matchesKey(data, "shift+space")) {
			this.#insertCharacter(" ");
		}
		// Character jump mode triggers
		else if (kb.matches(data, "tui.editor.jumpForward")) {
			this.#jumpMode = "forward";
		} else if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.#jumpMode = "backward";
		}
		// Printable keystrokes, including Kitty CSI-u text-producing sequences.
		else {
			const printableText = extractPrintableText(data);
			if (printableText) {
				this.#insertCharacter(printableText);
			}
		}
	}

	#wrapLine(line: string, width: number): TextChunk[] {
		if (width !== this.#wrapCacheWidth) {
			this.#wrapCache.clear();
			this.#wrapCacheWidth = width;
		}
		let chunks = this.#wrapCache.get(line);
		if (chunks === undefined) {
			if (this.#wrapCache.size >= 256) {
				this.#wrapCache.clear();
			}
			chunks = wordWrapLine(line, width);
			this.#wrapCache.set(line, chunks);
		}
		return chunks;
	}

	#layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.#state.lines.length === 0 || (this.#state.lines.length === 1 && this.#state.lines[0] === "")) {
			// Empty editor
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		// Process each logical line
		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const isCurrentLine = i === this.#state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				// Line fits in one layout line
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.#state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = this.#wrapLine(line, contentWidth);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = this.#state.cursorCol;
					const isLastChunk = chunkIndex === chunks.length - 1;

					// Determine if cursor is in this chunk
					// For word-wrapped chunks, we need to handle the case where
					// cursor might be in trimmed whitespace at end of chunk
					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						// The first chunk owns any leading whitespace the wrapper skipped,
						// so a cursor inside it still maps to a layout line.
						const chunkStart = chunkIndex === 0 ? 0 : chunk.startIndex;
						if (isLastChunk) {
							// Last chunk: cursor belongs here if >= startIndex
							hasCursorInChunk = cursorPos >= chunkStart;
						} else {
							// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
							hasCursorInChunk = cursorPos >= chunkStart && cursorPos < chunk.endIndex;
						}
						if (hasCursorInChunk) {
							// Clamp into the displayed text (cursor may sit in trimmed/skipped whitespace)
							adjustedCursorPos = Math.max(0, Math.min(cursorPos - chunk.startIndex, chunk.text.length));
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.#state.lines.join("\n");
	}

	#expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.#pastes) {
			const markerRegex = new RegExp(`\\[Paste #${pasteId}(?:, (?:\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.#expandPasteMarkers(this.#state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.#state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.#state.cursorLine, col: this.#state.cursorCol };
	}

	moveToLineStart(): void {
		this.#moveToLineStart();
	}

	moveToLineEnd(): void {
		this.#moveToLineEnd();
	}

	moveToMessageStart(): void {
		this.#moveToMessageStart();
	}

	moveToMessageEnd(): void {
		this.#moveToMessageEnd();
	}

	/**
	 * Undo the last meaningful edit while ignoring transient text that is still present at the cursor.
	 * Used for command-like autocomplete actions whose typed trigger should not count as the edit being undone.
	 */
	undoPastTransientText(transientText: string): void {
		if (transientText.length === 0) {
			this.#applyUndo();
			return;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const transientStartCol = this.#state.cursorCol - transientText.length;
		if (transientStartCol < 0 || currentLine.slice(transientStartCol, this.#state.cursorCol) !== transientText) {
			this.#applyUndo();
			return;
		}

		const beforeTransient = currentLine.slice(0, transientStartCol);
		const afterTransient = currentLine.slice(this.#state.cursorCol);
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		this.#state.lines[this.#state.cursorLine] = beforeTransient + afterTransient;
		this.#setCursorCol(transientStartCol);

		while (true) {
			const snapshot = this.#undoStack.at(-1);
			if (
				!snapshot ||
				!this.#matchesTransientUndoSnapshot(
					snapshot,
					transientText,
					transientStartCol,
					beforeTransient,
					afterTransient,
				)
			) {
				break;
			}
			this.#undoStack.pop();
		}

		if (this.#undoStack.length === 0) {
			if (this.onChange) {
				this.onChange(this.getText());
			}
			return;
		}

		this.#applyUndo();
	}

	setText(text: string): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#setTextInternal(text);
	}

	#exitHistoryForEditing(): void {
		if (this.#historyIndex === -1) return;
		if (this.#state.cursorLine === 0 && this.#state.cursorCol === 0) {
			this.#state.cursorLine = this.#state.lines.length - 1;
			const line = this.#state.lines[this.#state.cursorLine] || "";
			this.#setCursorCol(line.length);
		}
		this.#historyIndex = -1;
	}

	/** Insert text at the current cursor position */
	insertText(text: string): void {
		this.#exitHistoryForEditing();
		this.#insertTextAtCursor(text);
	}

	/** Delete up to `count` characters immediately before the cursor on the current line.
	 *  Used to "track back" the auto-repeat spaces that the space-hold push-to-talk gesture
	 *  optimistically inserts before it recognizes the hold. Capped at the cursor column so it
	 *  never crosses a line boundary or under-runs the line. */
	deleteBeforeCursor(count: number): void {
		const removable = Math.min(count, this.#state.cursorCol);
		if (removable <= 0) return;
		this.#exitHistoryForEditing();
		this.#recordUndoState();
		const line = this.#state.lines[this.#state.cursorLine] ?? "";
		this.#state.lines[this.#state.cursorLine] =
			line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol);
		this.#setCursorCol(this.#state.cursorCol - removable);
		this.#lastAction = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/** Code units of the current volatile speech-to-text preview (see {@link setVolatileText}). */
	#volatileTextLen = 0;

	/** Show or replace a volatile speech-to-text preview at the cursor. The text is
	 *  inserted with undo suspended so a long live dictation never floods the undo
	 *  stack; finalize it with {@link commitVolatileText} or drop it with
	 *  {@link clearVolatileText}. Newlines are allowed. */
	setVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => {
			this.#deleteCharsBeforeCursor(this.#volatileTextLen);
			if (text) this.#insertTextAtCursor(text);
		});
		this.#volatileTextLen = text.length;
		if (!text && this.onChange) this.onChange(this.getText());
	}

	/** Remove the current volatile preview without committing it. */
	clearVolatileText(): void {
		if (this.#volatileTextLen === 0) return;
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (this.onChange) this.onChange(this.getText());
	}

	/** Drop any volatile preview, then insert `text` as a single undoable edit. */
	commitVolatileText(text: string): void {
		this.#exitHistoryForEditing();
		this.#withUndoSuspended(() => this.#deleteCharsBeforeCursor(this.#volatileTextLen));
		this.#volatileTextLen = 0;
		if (text) this.#insertTextAtCursor(text);
		else if (this.onChange) this.onChange(this.getText());
	}

	/** Delete `count` UTF-16 code units immediately before the cursor, crossing line
	 *  boundaries (each consumed newline counts as one). Undo is the caller's concern. */
	#deleteCharsBeforeCursor(count: number): void {
		let remaining = count;
		while (remaining > 0) {
			if (this.#state.cursorCol > 0) {
				const removable = Math.min(remaining, this.#state.cursorCol);
				const line = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#state.lines[this.#state.cursorLine] =
					line.slice(0, this.#state.cursorCol - removable) + line.slice(this.#state.cursorCol);
				this.#setCursorCol(this.#state.cursorCol - removable);
				remaining -= removable;
			} else if (this.#state.cursorLine > 0) {
				const prev = this.#state.lines[this.#state.cursorLine - 1] ?? "";
				const cur = this.#state.lines[this.#state.cursorLine] ?? "";
				this.#state.lines[this.#state.cursorLine - 1] = prev + cur;
				this.#state.lines.splice(this.#state.cursorLine, 1);
				this.#state.cursorLine -= 1;
				this.#setCursorCol(prev.length);
				remaining -= 1;
			} else {
				break;
			}
		}
	}

	/** Apply terminal paste semantics to text from non-bracketed paste transports. */
	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	/** Insert `content` as a collapsed `[Paste #N]` marker (stored for expansion on submit via
	 *  {@link getExpandedText}). Hosts that intercept large pastes through {@link onLargePaste} use
	 *  this to re-insert a (possibly transformed) paste without re-triggering the interception hook. */
	insertPaste(content: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();
		this.#withUndoSuspended(() => {
			this.#storePasteMarker(content, content.split("\n").length);
		});
	}

	// All the editor methods from before...
	#insertCharacter(char: string): void {
		this.#exitHistoryForEditing();
		// Undo coalescing: consecutive word typing collapses into one undo unit
		// (mirrors Input); any other action resets the run via #lastAction.
		const isWordChunk = [...segmenter.segment(char)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#recordUndoState();
		}
		this.#lastAction = isWordChunk ? "type-word" : null;

		const line = this.#state.lines[this.#state.cursorLine] || "";

		const before = line.slice(0, this.#state.cursorCol);
		const after = line.slice(this.#state.cursorCol);

		this.#state.lines[this.#state.cursorLine] = before + char + after;
		this.#setCursorCol(this.#state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Synchronous inline replacement (e.g. emoji shortcodes `:joy:` → 😂).
		// Runs before autocomplete trigger so the popup doesn't briefly chase a
		// prefix that's about to be rewritten.
		if (char.length === 1 && this.#autocompleteProvider?.trySyncInlineReplace) {
			const replaceLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = replaceLine.slice(0, this.#state.cursorCol);
			const replacement = this.#autocompleteProvider.trySyncInlineReplace(textBeforeCursor);
			if (replacement) {
				const before = replaceLine.slice(0, this.#state.cursorCol - replacement.replaceLen);
				const after = replaceLine.slice(this.#state.cursorCol);
				this.#state.lines[this.#state.cursorLine] = before + replacement.insert + after;
				this.#setCursorCol(before.length + replacement.insert.length);
				if (this.onChange) {
					this.onChange(this.getText());
				}
				if (this.#autocompleteState) {
					this.#cancelAutocomplete();
					this.onAutocompleteUpdate?.();
				}
				return;
			}
		}

		// Check if we should trigger or update autocomplete
		if (!this.#autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.#isAtStartOfSubmittedMessage()) {
				this.#tryTriggerAutocomplete();
			}
			// Auto-trigger for "@" file reference (fuzzy search)
			else if (char === "@") {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				// Only trigger if @ is after whitespace or at start of line
				const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
					this.#tryTriggerAutocomplete();
				}
			}
			// Auto-trigger for "#" prompt actions anywhere in the current token
			else if (char === "#") {
				this.#tryTriggerAutocomplete();
			}
			// Also auto-trigger when typing letters/path chars in a completable context
			else if (/[a-zA-Z0-9.\-_/]/.test(char)) {
				const currentLine = this.#state.lines[this.#state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				if (this.#isInSubmittedSlashCommandContext()) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in an @ file reference context
				else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in a # prompt action context
				else if (textBeforeCursor.match(/#[^\s#]*$/)) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're in a :emoji shortcode context
				else if (textBeforeCursor.match(/(?:^|[\s([{>]):[a-zA-Z0-9_+-]*$/)) {
					this.#tryTriggerAutocomplete();
				}
				// Check if we're typing an internal URL scheme (e.g. local://, skill://)
				else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
					this.#tryTriggerAutocomplete();
				}
			}
		} else {
			this.#debouncedUpdateAutocomplete();
		}
	}

	#handlePaste(pastedText: string): void {
		let filteredText = this.#sanitizePastedText(pastedText);

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability.
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const charBeforeCursor = this.#state.cursorCol > 0 ? currentLine[this.#state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		const pastedLines = filteredText.split("\n");
		const totalChars = filteredText.length;
		// "Marker-sized": large enough to collapse into a `[Paste #N]` token (> 10 lines or
		// > 1000 characters) instead of flooding the buffer.
		const isMarkerSized = pastedLines.length > 10 || totalChars > 1000;

		// Let the host intercept marker-sized pastes (e.g. the large-paste menu). When it takes
		// over, the editor inserts nothing and records no undo state — the host re-inserts via
		// `insertPaste`/`insertText` once the user chooses.
		if (isMarkerSized && this.onLargePaste?.(filteredText, pastedLines.length)) {
			return;
		}

		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (isMarkerSized) {
				this.#storePasteMarker(filteredText, pastedLines.length);
				return;
			}

			if (pastedLines.length === 1) {
				// Single line - insert in one operation (per-char replay is O(paste × buffer)),
				// then evaluate autocomplete triggers once at the final cursor position.
				if (filteredText) {
					this.#insertTextAtCursor(filteredText);
					this.#retriggerAutocompleteAtCursor();
				}
				return;
			}

			// Multi-line paste - use insertTextAtCursor for proper handling
			this.#insertTextAtCursor(filteredText);
		});
	}

	/** Normalize raw pasted text: decode tmux re-encoded control bytes (both extended-keys formats),
	 *  normalize CRLF and
	 *  NFC (macOS NFD filename drag-drops), expand tabs, and strip control characters except newline. */
	#sanitizePastedText(pastedText: string): string {
		// Decode tmux's re-encoded control bytes (both extended-keys formats) back to
		// their literal byte so the per-char filter below preserves newlines instead of
		// stripping ESC and leaking the printable tail into the editor. See the decoder.
		const decodedText = decodeReencodedPasteControls(pastedText);

		// Clean the pasted text. NFC-normalize so macOS Finder drag-drops of
		// Korean filenames (which arrive as NFD: e.g. `ᄒ`+`ᅪ` instead of `화`)
		// land in the buffer as the same precomposed syllables a terminal
		// renders — without this, cursor column accounting drifts by
		// `(NFD cells − NFC cells)` and the visible glyph desyncs from the
		// hardware cursor.
		const cleanText = decodedText.replace(/\r\n?/g, "\n").normalize("NFC");

		// Convert tabs to spaces (4 spaces per tab).
		const tabExpandedText = cleanText.replace(/\t/g, "   ");

		// Strip control characters except newline (tabs already expanded above, CRs already
		// normalized). Single regex pass instead of split/filter/join to avoid allocating a
		// per-code-unit array for large pastes.
		return tabExpandedText.replace(/[\x00-\x09\x0B-\x1F]/g, "");
	}

	/** Store `content` in the paste buffer and insert a collapsed `[Paste #N]` marker that expands
	 *  back to `content` on submit. `lineCount` is the content's line count. */
	#storePasteMarker(content: string, lineCount: number): void {
		this.#pasteCounter++;
		const pasteId = this.#pasteCounter;
		this.#pastes.set(pasteId, content);

		// Insert marker like "[Paste #1, +123 lines]" or "[Paste #1, 1234 chars]".
		const marker =
			lineCount > 10 ? `[Paste #${pasteId}, +${lineCount} lines]` : `[Paste #${pasteId}, ${content.length} chars]`;
		this.#insertTextAtCursor(marker);
	}

	/** Re-evaluate autocomplete triggers for the text ending at the cursor (used after bulk edits). */
	#retriggerAutocompleteAtCursor(): void {
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
			return;
		}
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
		if (this.#isInSubmittedSlashCommandContext()) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
			this.#tryTriggerAutocomplete();
		} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
			this.#tryTriggerAutocomplete();
		}
	}

	#addNewLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		const before = currentLine.slice(0, this.#state.cursorCol);
		const after = currentLine.slice(this.#state.cursorCol);

		// Split current line
		this.#state.lines[this.#state.cursorLine] = before;
		this.#state.lines.splice(this.#state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.#state.cursorLine++;
		this.#setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		return this.#state.cursorCol > 0 && currentLine[this.#state.cursorCol - 1] === "\\";
	}

	#submitValue(): void {
		this.#resetKillSequence();

		const result = this.#expandPasteMarkers(this.#state.lines.join("\n")).trim();

		this.#state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.#pastes.clear();
		this.#pasteCounter = 0;
		this.#historyIndex = -1;
		this.#scrollOffset = 0;
		this.#undoStack.length = 0;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	/** Resolve the compiled, global copy of `atomicTokenPattern`, rebuilt only when the source changes. */
	#getAtomicTokenRe(): RegExp | undefined {
		const pattern = this.atomicTokenPattern;
		if (pattern === undefined) {
			this.#atomicTokenSource = undefined;
			this.#atomicTokenRe = undefined;
			return undefined;
		}
		if (pattern.source !== this.#atomicTokenSource) {
			this.#atomicTokenSource = pattern.source;
			this.#atomicTokenRe = new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			);
		}
		return this.#atomicTokenRe;
	}

	/** Find an atomic token on `line` whose span contains column `col` (`start <= col < end`). */
	#atomicTokenAt(line: string, col: number): { start: number; end: number } | undefined {
		const re = this.#getAtomicTokenRe();
		if (re === undefined) return undefined;
		re.lastIndex = 0;
		for (;;) {
			const match = re.exec(line);
			if (match === null) break;
			if (match[0].length === 0) {
				re.lastIndex = match.index + 1;
				continue;
			}
			const start = match.index;
			const end = start + match[0].length;
			if (col < start) break;
			if (col < end) return { start, end };
		}
		return undefined;
	}

	/** Expand the half-open range [start, end) so it never cuts through an atomic
	 *  placeholder token: a boundary landing inside a token pulls the whole token in. */
	#expandRangeOverAtomicTokens(line: string, start: number, end: number): { start: number; end: number } {
		const startToken = this.#atomicTokenAt(line, start);
		if (startToken !== undefined && startToken.start < start) {
			start = startToken.start;
		}
		if (end > start) {
			const endToken = this.#atomicTokenAt(line, end - 1);
			if (endToken !== undefined && endToken.end > end) {
				end = endToken.end;
			}
		}
		return { start, end };
	}

	#handleBackspace(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		if (this.#state.cursorCol > 0) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			// An atomic placeholder token (image/paste marker) deletes as a unit, so a single
			// backspace never leaves a half-eaten `[Paste #1, +30 lines` behind as stray text.
			const token = this.#atomicTokenAt(line, this.#state.cursorCol - 1);
			if (token !== undefined) {
				this.#state.lines[this.#state.cursorLine] = line.slice(0, token.start) + line.slice(token.end);
				this.#setCursorCol(token.start);
			} else {
				// Delete grapheme before cursor (handles emojis, combining characters, etc.)
				const beforeCursor = line.slice(0, this.#state.cursorCol);

				// Find the last grapheme in the text before cursor
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

				const before = line.slice(0, this.#state.cursorCol - graphemeLength);
				const after = line.slice(this.#state.cursorCol);

				this.#state.lines[this.#state.cursorLine] = before + after;
				this.#setCursorCol(this.#state.cursorCol - graphemeLength);
			}
		} else if (this.#state.cursorLine > 0) {
			// Merge with previous line
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";

			this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
			this.#state.lines.splice(this.#state.cursorLine, 1);

			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			// Slash command context
			if (this.#isInSubmittedSlashCommandContext()) {
				this.#tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// # prompt action context
			else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// internal URL scheme context (e.g. local://, skill://)
			else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	#setCursorCol(col: number): void {
		this.#state.cursorCol = col;
		this.#preferredVisualCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	#moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];

		if (currentVL && targetVL) {
			// Work in visual cells (grapheme-walked), not UTF-16 code units: code-unit
			// columns land mid-surrogate on emoji and drift on wide CJK glyphs.
			const sourceLine = this.#state.lines[currentVL.logicalLine] || "";
			const sourceText = sourceLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
			const currentVisualCol = visualColAtOffset(sourceText, this.#state.cursorCol - currentVL.startCol);

			// For non-last segments, clamp before the segment end to stay within the segment
			const isLastSourceSegment =
				currentVisualLine === visualLines.length - 1 ||
				visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
			const sourceMaxVisualCol = maxSegmentVisualCol(sourceText, isLastSourceSegment);

			const isLastTargetSegment =
				targetVisualLine === visualLines.length - 1 ||
				visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
			const targetLine = this.#state.lines[targetVL.logicalLine] || "";
			const targetText = targetLine.slice(targetVL.startCol, targetVL.startCol + targetVL.length);
			const targetMaxVisualCol = maxSegmentVisualCol(targetText, isLastTargetSegment);

			const moveToVisualCol = this.#computeVerticalMoveColumn(
				currentVisualCol,
				sourceMaxVisualCol,
				targetMaxVisualCol,
			);

			// Set cursor position, snapping to a grapheme boundary in the target text
			this.#state.cursorLine = targetVL.logicalLine;
			const targetCol = targetVL.startCol + offsetAtVisualCol(targetText, moveToVisualCol);
			this.#state.cursorCol = Math.min(targetCol, targetLine.length);
		}
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table.
	 */
	#computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.#preferredVisualCol !== null;
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
		const targetTooShort = targetMaxVisualCol < currentVisualCol;

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				this.#preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}
			this.#preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.#preferredVisualCol!;
		if (targetTooShort || targetCantFitPreferred) {
			return targetMaxVisualCol;
		}

		const result = this.#preferredVisualCol!;
		this.#preferredVisualCol = null;
		return result;
	}

	#moveToLineStart(): void {
		this.#resetKillSequence();
		this.#setCursorCol(0);
	}

	#moveToLineEnd(): void {
		this.#resetKillSequence();
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#moveToMessageStart(): void {
		this.#resetKillSequence();
		this.#state.cursorLine = 0;
		this.#setCursorCol(0);
	}

	#moveToMessageEnd(): void {
		this.#resetKillSequence();
		this.#state.cursorLine = this.#state.lines.length - 1;
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		this.#setCursorCol(currentLine.length);
	}

	#resetKillSequence(): void {
		this.#lastAction = null;
	}

	#withUndoSuspended<T>(fn: () => T): T {
		const wasSuspended = this.#suspendUndo;
		this.#suspendUndo = true;
		try {
			return fn();
		} finally {
			this.#suspendUndo = wasSuspended;
		}
	}

	#recordUndoState(): void {
		if (this.#suspendUndo) return;
		this.#undoStack.push(structuredClone(this.#state));
		if (this.#undoStack.length > MAX_UNDO_STACK) {
			this.#undoStack.shift();
		}
	}

	#applyUndo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) return;

		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#preferredVisualCol = null;
		Object.assign(this.#state, snapshot);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			if (this.#isInSubmittedSlashCommandContext()) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			} else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	#matchesTransientUndoSnapshot(
		snapshot: EditorState,
		transientText: string,
		transientStartCol: number,
		beforeTransient: string,
		afterTransient: string,
	): boolean {
		if (snapshot.cursorLine !== this.#state.cursorLine) return false;
		if (snapshot.lines.length !== this.#state.lines.length) return false;

		const transientLength = snapshot.cursorCol - transientStartCol;
		if (transientLength < 0 || transientLength >= transientText.length) return false;

		for (let i = 0; i < snapshot.lines.length; i++) {
			if (i === this.#state.cursorLine) continue;
			if (snapshot.lines[i] !== this.#state.lines[i]) return false;
		}

		return (
			snapshot.lines[snapshot.cursorLine] ===
			beforeTransient + transientText.slice(0, transientLength) + afterTransient
		);
	}

	#recordKill(text: string, direction: "forward" | "backward", accumulate = this.#lastAction === "kill"): void {
		if (!text) return;
		this.#killRing.push(text, { prepend: direction === "backward", accumulate });
		this.#lastAction = "kill";
	}

	#insertTextAtCursor(text: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();

		const normalized = text.replace(/\r\n?/g, "\n");
		const lines = normalized.split("\n");

		if (lines.length === 1) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const before = line.slice(0, this.#state.cursorCol);
			const after = line.slice(this.#state.cursorCol);
			this.#state.lines[this.#state.cursorLine] = before + normalized + after;
			this.#setCursorCol(this.#state.cursorCol + normalized.length);
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
			const afterCursor = currentLine.slice(this.#state.cursorCol);

			const newLines: string[] = [];
			for (let i = 0; i < this.#state.cursorLine; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			newLines.push(beforeCursor + (lines[0] || ""));
			for (let i = 1; i < lines.length - 1; i++) {
				newLines.push(lines[i] || "");
			}
			newLines.push((lines[lines.length - 1] || "") + afterCursor);

			for (let i = this.#state.cursorLine + 1; i < this.#state.lines.length; i++) {
				newLines.push(this.#state.lines[i] || "");
			}

			this.#state.lines = newLines;
			this.#state.cursorLine += lines.length - 1;
			this.#setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#yankFromKillRing(): void {
		const text = this.#killRing.peek();
		if (!text) return;
		this.#insertTextAtCursor(text);
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank") return;
		if (this.#killRing.length <= 1) return;

		this.#historyIndex = -1;
		this.#recordUndoState();

		this.#withUndoSuspended(() => {
			if (!this.#deleteYankedText()) return;
			this.#killRing.rotate();
			const text = this.#killRing.peek();
			if (text) {
				this.#insertTextAtCursor(text);
			}
		});

		this.#lastAction = "yank";
	}

	/**
	 * Delete the most recently yanked text from the buffer.
	 *
	 * This is a best-effort operation and assumes the cursor is still positioned
	 * at the end of the yanked text.
	 */
	#deleteYankedText(): boolean {
		const yankedText = this.#killRing.peek();
		if (!yankedText) return false;

		const yankLines = yankedText.split("\n");
		const endLine = this.#state.cursorLine;
		const endCol = this.#state.cursorCol;
		const startLine = endLine - (yankLines.length - 1);
		if (startLine < 0) return false;

		if (yankLines.length === 1) {
			const line = this.#state.lines[endLine] ?? "";
			const startCol = endCol - yankedText.length;
			if (startCol < 0) return false;
			if (line.slice(startCol, endCol) !== yankedText) return false;

			this.#state.lines[endLine] = line.slice(0, startCol) + line.slice(endCol);
			this.#state.cursorLine = endLine;
			this.#setCursorCol(startCol);
			return true;
		}

		const firstInserted = yankLines[0] ?? "";
		const lastInserted = yankLines[yankLines.length - 1] ?? "";
		const firstLineText = this.#state.lines[startLine] ?? "";
		const lastLineText = this.#state.lines[endLine] ?? "";

		if (!firstLineText.endsWith(firstInserted)) return false;
		if (endCol !== lastInserted.length) return false;
		if (lastLineText.slice(0, endCol) !== lastInserted) return false;

		const startCol = firstLineText.length - firstInserted.length;
		if (startCol < 0) return false;

		const suffix = lastLineText.slice(endCol);
		const newLine = firstLineText.slice(0, startCol) + suffix;

		this.#state.lines.splice(startLine, yankLines.length, newLine);
		this.#state.cursorLine = startLine;
		this.#setCursorCol(startCol);
		return true;
	}

	#deleteToStartOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol > 0) {
			// Delete from start of line up to cursor, extending over any atomic token
			// the boundary would otherwise cut in half.
			const { end } = this.#expandRangeOverAtomicTokens(currentLine, 0, this.#state.cursorCol);
			deletedText = currentLine.slice(0, end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(end);
			this.#setCursorCol(0);
		} else if (this.#state.cursorLine > 0) {
			// At start of line - merge with previous line
			deletedText = "\n";
			const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
			this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
			this.#state.lines.splice(this.#state.cursorLine, 1);
			this.#state.cursorLine--;
			this.#setCursorCol(previousLine.length);
		}

		this.#recordKill(deletedText, "backward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#deleteToEndOfLine(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		let deletedText = "";

		if (this.#state.cursorCol < currentLine.length) {
			// Delete from cursor to end of line, extending backwards over an atomic
			// token the cursor sits inside so no half-eaten marker text remains.
			const { start } = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, currentLine.length);
			deletedText = currentLine.slice(start);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, start);
			if (start < this.#state.cursorCol) {
				this.#setCursorCol(start);
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			deletedText = "\n";
			this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
			this.#state.lines.splice(this.#state.cursorLine + 1, 1);
		}

		this.#recordKill(deletedText, "forward");

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#deleteWordBackwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#recordKill("\n", "backward");
				const previousLine = this.#state.lines[this.#state.cursorLine - 1] || "";
				this.#state.lines[this.#state.cursorLine - 1] = previousLine + currentLine;
				this.#state.lines.splice(this.#state.cursorLine, 1);
				this.#state.cursorLine--;
				this.#setCursorCol(previousLine.length);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordBackwards();
			// Extend the range over any atomic token it intersects so a word delete
			// never leaves half-eaten marker text behind.
			const range = this.#expandRangeOverAtomicTokens(currentLine, this.#state.cursorCol, oldCursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, range.start) + currentLine.slice(range.end);
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "backward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#deleteWordForwards(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#recordKill("\n", "forward");
				const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
				this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
				this.#state.lines.splice(this.#state.cursorLine + 1, 1);
			}
		} else {
			const oldCursorCol = this.#state.cursorCol;
			this.#moveWordForwards();
			// Extend the range over any atomic token it intersects so a word delete
			// never leaves half-eaten marker text behind.
			const range = this.#expandRangeOverAtomicTokens(currentLine, oldCursorCol, this.#state.cursorCol);

			const deletedText = currentLine.slice(range.start, range.end);
			this.#state.lines[this.#state.cursorLine] = currentLine.slice(0, range.start) + currentLine.slice(range.end);
			this.#setCursorCol(range.start);
			this.#recordKill(deletedText, "forward");
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	#handleForwardDelete(): void {
		this.#historyIndex = -1; // Exit history browsing mode
		this.#resetKillSequence();
		this.#recordUndoState();

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		if (this.#state.cursorCol < currentLine.length) {
			// An atomic placeholder token (image/paste marker) deletes as a unit.
			const token = this.#atomicTokenAt(currentLine, this.#state.cursorCol);
			if (token !== undefined) {
				this.#state.lines[this.#state.cursorLine] =
					currentLine.slice(0, token.start) + currentLine.slice(token.end);
				this.#setCursorCol(token.start);
			} else {
				// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
				const afterCursor = currentLine.slice(this.#state.cursorCol);

				// Find the first grapheme at cursor
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

				const before = currentLine.slice(0, this.#state.cursorCol);
				const after = currentLine.slice(this.#state.cursorCol + graphemeLength);
				this.#state.lines[this.#state.cursorLine] = before + after;
			}
		} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
			// At end of line - merge with next line
			const nextLine = this.#state.lines[this.#state.cursorLine + 1] || "";
			this.#state.lines[this.#state.cursorLine] = currentLine + nextLine;
			this.#state.lines.splice(this.#state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		if (this.#autocompleteState) {
			this.#debouncedUpdateAutocomplete();
		} else {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			// Slash command context
			if (this.#isInSubmittedSlashCommandContext()) {
				this.#tryTriggerAutocomplete();
			}
			// @ file reference context
			else if (textBeforeCursor.match(/(?:^|[\s])@[^\s]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// # prompt action context
			else if (textBeforeCursor.match(/#[^\s#]*$/)) {
				this.#tryTriggerAutocomplete();
			}
			// internal URL scheme context (e.g. local://, skill://)
			else if (this.#textTriggersUrlAutocomplete(textBeforeCursor)) {
				this.#tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.#state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	#buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// Empty line still takes one visual line
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = this.#wrapLine(line, width);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	#findCurrentVisualLine(visualLines: Array<{ logicalLine: number; startCol: number; length: number }>): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl) continue;
			if (vl.logicalLine === this.#state.cursorLine) {
				const colInSegment = this.#state.cursorCol - vl.startCol;
				// Cursor is in this segment if it's within range
				// For the last segment of a logical line, cursor can be at length (end position)
				// The first segment also owns any leading whitespace the wrapper skipped
				// (its startCol can be > 0), so a negative colInSegment maps there.
				const isLastSegmentOfLine =
					i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
				const isFirstSegmentOfLine = i === 0 || visualLines[i - 1]?.logicalLine !== vl.logicalLine;
				if (
					(colInSegment >= 0 || isFirstSegmentOfLine) &&
					(colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))
				) {
					return i;
				}
			}
		}
		// Fallback: return last visual line
		return visualLines.length - 1;
	}

	#moveCursor(deltaLine: number, deltaCol: number): void {
		this.#resetKillSequence();
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.#state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.#state.cursorCol);
					const graphemes = [...segmenter.segment(afterCursor)];
					const firstGrapheme = graphemes[0];
					this.#setCursorCol(this.#state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.#state.cursorLine < this.#state.lines.length - 1) {
					// Wrap to start of next logical line
					this.#state.cursorLine++;
					this.#setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						const segmentText = currentLine.slice(currentVL.startCol, currentVL.startCol + currentVL.length);
						this.#preferredVisualCol = visualColAtOffset(segmentText, this.#state.cursorCol - currentVL.startCol);
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.#state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
					const graphemes = [...segmenter.segment(beforeCursor)];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.#setCursorCol(this.#state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.#state.cursorLine > 0) {
					// Wrap to end of previous logical line
					this.#state.cursorLine--;
					const prevLine = this.#state.lines[this.#state.cursorLine] || "";
					this.#setCursorCol(prevLine.length);
				}
			}
		}
	}

	#pageScroll(direction: -1 | 1): void {
		this.#resetKillSequence();
		const visualLines = this.#buildVisualLineMap(this.#lastLayoutWidth);
		const currentVisualLine = this.#findCurrentVisualLine(visualLines);
		const step = this.#getPageScrollStep(visualLines.length);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * step));
		if (targetVisualLine === currentVisualLine) return;
		this.#moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	#moveWordBackwards(): void {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.#state.cursorCol === 0) {
			if (this.#state.cursorLine > 0) {
				this.#state.cursorLine--;
				const prevLine = this.#state.lines[this.#state.cursorLine] || "";
				this.#setCursorCol(prevLine.length);
			}
			return;
		}

		this.#setCursorCol(moveWordLeft(currentLine, this.#state.cursorCol));
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	#jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.#resetKillSequence();
		const isForward = direction === "forward";
		const lines = this.#state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.#state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.#state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.#state.cursorCol + 1
					: this.#state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.#state.cursorLine = lineIdx;
				this.#setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	#moveWordForwards(): void {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.#state.cursorCol >= currentLine.length) {
			if (this.#state.cursorLine < this.#state.lines.length - 1) {
				this.#state.cursorLine++;
				this.#setCursorCol(0);
			}
			return;
		}

		this.#setCursorCol(moveWordRight(currentLine, this.#state.cursorCol));
	}

	#hasOnlyWhitespaceBeforeCursorLine(): boolean {
		for (let i = 0; i < this.#state.cursorLine; i++) {
			if ((this.#state.lines[i] || "").trim() !== "") {
				return false;
			}
		}
		return true;
	}

	// Slash commands execute only when the submitted prompt starts with the command.
	#isAtStartOfSubmittedMessage(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		return this.#hasOnlyWhitespaceBeforeCursorLine() && (beforeCursor.trim() === "" || beforeCursor.trim() === "/");
	}

	#isInSubmittedSlashCommandContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		return this.#hasOnlyWhitespaceBeforeCursorLine() && beforeCursor.trimStart().startsWith("/");
	}

	#isSlashCommandNameAutocompleteSelection(): boolean {
		if (this.#autocompleteState !== "regular") {
			return false;
		}

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return (
			this.#isInSubmittedSlashCommandContext() && textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")
		);
	}

	#isCompletedSlashCommandAtCursor(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		if (this.#state.cursorCol !== currentLine.length) {
			return false;
		}

		const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol).trimStart();
		return this.#isInSubmittedSlashCommandContext() && /^\/\S+ $/.test(textBeforeCursor);
	}

	// Autocomplete methods
	/**
	 * Whether the text ending at the cursor looks like a `scheme://` URL token.
	 * Generic by design: any scheme triggers a suggestion fetch and the active
	 * provider decides whether it has candidates (returning none is a no-op).
	 * MUST stay in sync with the token grammar in coding-agent's
	 * `internal-url-autocomplete.ts`.
	 */
	#textTriggersUrlAutocomplete(textBeforeCursor: string): boolean {
		return /(?:^|[\s"'`(<=])[a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*$/i.test(textBeforeCursor);
	}

	async #tryTriggerAutocomplete(explicitTab: boolean = false): Promise<void> {
		if (!this.#autocompleteProvider) return;
		// Check if we should trigger file completion on Tab
		if (explicitTab) {
			const provider = this.#autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.#state.lines, this.#state.cursorLine, this.#state.cursorCol);
			if (!shouldTrigger) {
				return;
			}
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "regular";
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}
	#createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : AUTOCOMPLETE_SELECT_LIST_LAYOUT;
		return new SelectList(items, this.#autocompleteMaxVisible, this.#theme.selectList, layout);
	}

	#handleTabCompletion(): void {
		if (!this.#autocompleteProvider) return;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		// Check if we're in a slash command context
		if (this.#isInSubmittedSlashCommandContext() && !beforeCursor.trimStart().includes(" ")) {
			this.#handleSlashCommandCompletion();
		} else {
			this.#forceFileAutocomplete(true);
		}
	}

	#handleSlashCommandCompletion(): void {
		this.#tryTriggerAutocomplete(true);
	}

	/*
https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19536643416/job/559322883
17 this job fails with https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19
536643416/job/55932288317 havea  look at .gi
    */
	async #forceFileAutocomplete(explicitTab: boolean = false): Promise<void> {
		if (!this.#autocompleteProvider) return;

		// Check if provider supports force file suggestions via runtime check
		const provider = this.#autocompleteProvider as {
			getForceFileSuggestions?: CombinedAutocompleteProvider["getForceFileSuggestions"];
		};
		if (typeof provider.getForceFileSuggestions !== "function") {
			await this.#tryTriggerAutocomplete(true);
			return;
		}

		const requestId = ++this.#autocompleteRequestId;
		const suggestions = await provider.getForceFileSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			// If there's exactly one suggestion and this was an explicit Tab press, apply it immediately
			if (explicitTab && suggestions.items.length === 1) {
				const item = suggestions.items[0]!;
				const result = this.#autocompleteProvider.applyCompletion(
					this.#state.lines,
					this.#state.cursorLine,
					this.#state.cursorCol,
					item,
					suggestions.prefix,
				);

				this.#state.lines = result.lines;
				this.#state.cursorLine = result.cursorLine;
				this.#setCursorCol(result.cursorCol);

				if (this.onChange) {
					this.onChange(this.getText());
				}
				return;
			}

			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = "force";
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}

	#cancelAutocomplete(notifyCancel: boolean = false): void {
		const wasAutocompleting = this.#autocompleteState !== null;
		this.#clearAutocompleteTimeout();
		this.#autocompleteRequestId += 1;
		this.#autocompleteState = null;
		this.#autocompleteList = undefined;
		this.#autocompletePrefix = "";
		if (notifyCancel && wasAutocompleting) {
			this.onAutocompleteCancel?.();
		}
	}

	isShowingAutocomplete(): boolean {
		return this.#autocompleteState !== null;
	}

	async #updateAutocomplete(): Promise<void> {
		if (!this.#autocompleteState || !this.#autocompleteProvider) return;

		// In force mode, use forceFileAutocomplete to get suggestions
		if (this.#autocompleteState === "force") {
			this.#forceFileAutocomplete();
			return;
		}

		const requestId = ++this.#autocompleteRequestId;

		const suggestions = await this.#autocompleteProvider.getSuggestions(
			this.#state.lines,
			this.#state.cursorLine,
			this.#state.cursorCol,
		);
		if (requestId !== this.#autocompleteRequestId) return;

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			// Always create new SelectList to ensure update
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.onAutocompleteUpdate?.();
		} else {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
	}

	#debouncedUpdateAutocomplete(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
		}
		this.#autocompleteTimeout = setTimeout(() => {
			this.#updateAutocomplete();
			this.#autocompleteTimeout = undefined;
		}, 100);
	}

	#clearAutocompleteTimeout(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
			this.#autocompleteTimeout = undefined;
		}
	}

	/**
	 * Get inline hint text to show as dim ghost text after the cursor.
	 * Checks selected autocomplete item's hint first, then falls back to provider.
	 */
	#getInlineHint(): string | null {
		// Check selected autocomplete item for a hint
		if (this.#autocompleteState && this.#autocompleteList) {
			const selected = this.#autocompleteList.getSelectedItem();
			return selected?.hint ?? null;
		}

		// Fall back to provider's getInlineHint
		if (this.#autocompleteProvider?.getInlineHint) {
			return this.#autocompleteProvider.getInlineHint(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			);
		}

		return null;
	}
}
