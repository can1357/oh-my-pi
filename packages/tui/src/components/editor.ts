import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	findLeadingSlashCommandStart,
	findTrailingSlashCommandStart,
	isDirectoryCompletionValue,
	midPromptSkillTokenMatches,
	SKILL_NAMESPACE,
} from "../autocomplete";
import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { canonicalKeyId, getKeybindings, type KeybindingsManager } from "../keybindings";
import { extractPrintableText, matchesKey, parseKey } from "../keys";
import { KillRing } from "../kill-ring";
import type { SymbolTheme } from "../symbols";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	getSegmenter,
	getWidthConfigEpoch,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "../utils";
import {
	borderlessComposerStyle,
	type ComposerChromeContext,
	type ComposerStyle,
	type EditorBorderStyle,
	type EditorTopBorder,
	getComposerStyle,
	isFilledComposerStyle,
} from "./composer";

export type { EditorBorderStyle, EditorTopBorder };

import { type SelectItem, SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const PASSTHROUGH_COLOR = (text: string): string => text;

const AUTOCOMPLETE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	overflowSearch: false,
};

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
	wrapDescription: true,
	maxDescriptionRows: 2,
	overflowSearch: false,
};

function sanitizeLoadedText(text: string): string {
	// Normalize CRLF/CR → LF, then strip C0 control chars except \n.
	return replaceTabs(text.replace(/\r\n?/g, "\n")).replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

const segmenter = getSegmenter();

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks the text content, its position in the original line, and its exact
 * visible width (`width === visibleWidth(text)`, measured at build time) so
 * layout/render never re-measure cached chunks.
 */
interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
	width: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * Widths are carried, never recomputed: the line is segmented exactly once,
 * per-grapheme widths are measured lazily at most once each, and every chunk
 * is a contiguous slice of `line` (no incremental string concatenation).
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param knownLineWidth - Caller-carried exact `visibleWidth(line)`, if already measured
 * @returns Array of chunks with text, position, and exact visible width
 */
function wordWrapLine(line: string, maxWidth: number, knownLineWidth?: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0, width: 0 }];
	}

	const lineWidth = knownLineWidth ?? visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length, width: lineWidth }];
	}

	// Single segmentation pass: grapheme start offsets (with end sentinel),
	// lazily-filled grapheme widths, and word/whitespace token boundaries.
	const gStart: number[] = [];
	const gWidth: number[] = [];
	interface Token {
		startG: number;
		endG: number;
		startIndex: number;
		endIndex: number;
		isWhitespace: boolean;
	}
	const tokens: Token[] = [];
	let inWhitespace = false;
	let tokenStartG = 0;
	let tokenStartIndex = 0;
	let gCount = 0;
	for (const seg of segmenter.segment(line)) {
		const graphemeIsWhitespace = getWordNavKind(seg.segment) === "whitespace";
		if (gCount === 0) {
			inWhitespace = graphemeIsWhitespace;
		} else if (graphemeIsWhitespace !== inWhitespace) {
			// Token type changed - close the current token
			tokens.push({
				startG: tokenStartG,
				endG: gCount,
				startIndex: tokenStartIndex,
				endIndex: seg.index,
				isWhitespace: inWhitespace,
			});
			tokenStartG = gCount;
			tokenStartIndex = seg.index;
			inWhitespace = graphemeIsWhitespace;
		}
		gStart.push(seg.index);
		gWidth.push(-1);
		gCount++;
	}
	gStart.push(line.length);
	if (gCount > tokenStartG) {
		tokens.push({
			startG: tokenStartG,
			endG: gCount,
			startIndex: tokenStartIndex,
			endIndex: line.length,
			isWhitespace: inWhitespace,
		});
	}

	/** Exact `visibleWidth` of grapheme `g`, measured at most once. */
	const graphemeWidth = (g: number): number => {
		let w = gWidth[g] ?? -1;
		if (w < 0) {
			w = visibleWidth(line.slice(gStart[g] ?? 0, gStart[g + 1] ?? line.length));
			gWidth[g] = w;
		}
		return w;
	};

	const chunks: TextChunk[] = [];
	const pushChunk = (text: string, startIndex: number, endIndex: number): void => {
		chunks.push({ text, startIndex, endIndex, width: visibleWidth(text) });
	};

	/** Widest grapheme prefix of [startG, endG) that fits `availableWidth`. */
	const consumePrefixToWidth = (
		startG: number,
		endG: number,
		availableWidth: number,
	): { endG: number; len: number } => {
		let prefixWidth = 0;
		let g = startG;
		while (g < endG) {
			const w = graphemeWidth(g);
			if (prefixWidth + w > availableWidth) break;
			prefixWidth += w;
			g++;
			if (prefixWidth === availableWidth) break;
		}
		return { endG: g, len: (gStart[g] ?? 0) - (gStart[startG] ?? 0) };
	};
	const hasWideGrapheme = (startG: number, endG: number): boolean => {
		for (let g = startG; g < endG; g++) {
			if (graphemeWidth(g) > 1) return true;
		}
		return false;
	};

	// Build chunks using word wrapping. The pending chunk is always the
	// contiguous slice line[chunkStart, chunkEnd) with visible width currentWidth.
	let chunkStart = 0;
	let chunkEnd = 0;
	let currentWidth = 0;
	let atLineStart = true; // Track if we're at the start of a line (for skipping whitespace)

	for (const token of tokens) {
		const tokenWidth = visibleWidth(line.slice(token.startIndex, token.endIndex));

		// Skip leading whitespace at line start. Keep the skipped run mapped onto the
		// preceding chunk (when one exists) so every cursor position resolves to a
		// layout line instead of falling through to the buffer's last visual line.
		if (atLineStart && token.isWhitespace) {
			const prev = chunks[chunks.length - 1];
			if (prev) prev.endIndex = token.endIndex;
			chunkStart = token.endIndex;
			chunkEnd = token.endIndex;
			continue;
		}
		atLineStart = false;

		// If this single token is wider than maxWidth, we need to break it
		if (tokenWidth > maxWidth) {
			// If we're mid-line, try to use the remaining width by consuming a prefix of this long token.
			let consumedPrefixLen = 0; // JS string index (code units) consumed from the token
			let consumedPrefixEndG = token.startG;
			if (chunkEnd > chunkStart && currentWidth < maxWidth) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.startG, token.endG, remainingWidth);
				consumedPrefixEndG = consumed.endG;
				consumedPrefixLen = consumed.len;
			}
			// First, push any accumulated chunk (optionally filled with the prefix).
			if (chunkEnd > chunkStart) {
				if (consumedPrefixLen > 0) {
					const endIndex = token.startIndex + consumedPrefixLen;
					pushChunk(line.slice(chunkStart, endIndex), chunkStart, endIndex);
					chunkStart = endIndex;
					chunkEnd = endIndex;
				} else {
					pushChunk(line.slice(chunkStart, chunkEnd), chunkStart, token.startIndex);
					chunkStart = token.startIndex;
					chunkEnd = token.startIndex;
				}
				currentWidth = 0;
			}
			// Break the remaining long token by grapheme
			let tcStart = token.startIndex + consumedPrefixLen;
			let tcEnd = tcStart;
			let tcWidth = 0;
			for (let g = consumedPrefixEndG; g < token.endG; g++) {
				const w = graphemeWidth(g);
				const gEnd = gStart[g + 1] ?? line.length;
				if (tcWidth + w > maxWidth && tcEnd > tcStart) {
					pushChunk(line.slice(tcStart, tcEnd), tcStart, tcEnd);
					tcStart = tcEnd;
					tcWidth = w;
				} else {
					tcWidth += w;
				}
				tcEnd = gEnd;
			}
			// Keep remainder as start of next chunk
			if (tcEnd > tcStart) {
				chunkStart = tcStart;
				chunkEnd = tcEnd;
				currentWidth = tcWidth;
			}
			continue;
		}

		// Check if adding this token would exceed width
		if (currentWidth + tokenWidth > maxWidth) {
			// For wide-character tokens (e.g., CJK runs), prefer using remaining width before wrapping
			// the whole token to the next line. This avoids leaving a short ASCII word alone.
			if (
				chunkEnd > chunkStart &&
				!token.isWhitespace &&
				currentWidth < maxWidth &&
				hasWideGrapheme(token.startG, token.endG)
			) {
				const remainingWidth = maxWidth - currentWidth;
				const consumed = consumePrefixToWidth(token.startG, token.endG, remainingWidth);
				if (consumed.len > 0) {
					const endIndex = token.startIndex + consumed.len;
					pushChunk(line.slice(chunkStart, endIndex), chunkStart, endIndex);
					const remainder = line.slice(endIndex, token.endIndex);
					chunkStart = endIndex;
					chunkEnd = token.endIndex;
					currentWidth = visibleWidth(remainder);
					atLineStart = false;
					continue;
				}
			}
			// Push current chunk (trimming trailing whitespace for display)
			const trimmedChunk = line.slice(chunkStart, chunkEnd).trimEnd();
			if (trimmedChunk || chunks.length === 0) {
				pushChunk(trimmedChunk, chunkStart, chunkEnd);
			} else {
				// All-whitespace chunk collapsed away: keep its span mapped on the
				// previous chunk so cursor positions inside it stay addressable.
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = chunkEnd;
			}
			// Start new line - skip leading whitespace
			atLineStart = true;
			if (token.isWhitespace) {
				// Extend the preceding chunk over the whitespace run skipped at the wrap
				// point; otherwise cursor positions inside it map to no layout line.
				const prev = chunks[chunks.length - 1];
				if (prev) prev.endIndex = token.endIndex;
				chunkStart = token.endIndex;
				chunkEnd = token.endIndex;
				currentWidth = 0;
			} else {
				chunkStart = token.startIndex;
				chunkEnd = token.endIndex;
				currentWidth = tokenWidth;
				atLineStart = false;
			}
		} else {
			// Add token to current chunk
			if (chunkEnd === chunkStart) chunkStart = token.startIndex;
			chunkEnd = token.endIndex;
			currentWidth += tokenWidth;
		}
	}

	// Push final chunk
	if (chunkEnd > chunkStart) {
		pushChunk(line.slice(chunkStart, chunkEnd), chunkStart, line.length);
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0, width: 0 }];
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

/** True when every code unit is plain printable text: no C0 controls (so no
 *  ESC/CR/LF/TAB), no DEL, no C1 range — the same set `extractPrintableText`
 *  rejects. Such a run can never encode a key sequence. */
function isPlainTextRun(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
	}
	return true;
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
	/** Exact `visibleWidth(text)` carried from wrap/layout, never re-derived. */
	width: number;
	sourceLine: number;
	sourceStartCol: number;
	hasCursor: boolean;
	cursorPos?: number;
}

/** Per-line measurement carried across renders: exact visible width plus
 *  lazily-built wrap chunks (only populated once the line needs wrapping). */
interface WrapEntry {
	width: number;
	chunks: TextChunk[] | null;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	/** Stable accent for composer chrome that should not follow the mutable border state. */
	accentColor?: (str: string) => string;
	/** Background fill used by filled composer styles. */
	surfaceColor?: (str: string) => string;
	/** Foreground used when the composer shape leaves its text surface transparent. */
	textColor?: (str: string) => string;
	selectList: SelectListTheme;
	symbols: SymbolTheme;
	editorPaddingX?: number;
	/** Style function for inline hint/ghost text (dim text after cursor) */
	hintStyle?: (text: string) => string;
}

interface HistoryEntry {
	prompt: string;
}

interface HistoryStorage {
	add(prompt: string, cwd?: string): Promise<void>;
	getRecent(limit: number): HistoryEntry[];
}

/** A synchronous replacement immediately before the editor cursor. */
export interface EditorInlineReplacement {
	/** UTF-16 code units to remove immediately before the cursor. */
	replaceLen: number;
	/** Literal text inserted where the removed suffix started. */
	insert: string;
}

/** Replacement candidates and the current-line span they replace. */
export interface EditorWordReplacements {
	line: number;
	startCol: number;
	endCol: number;
	items: readonly string[];
}

/** Source location for one visual text segment passed to `decorateText`. */
export interface EditorTextDecorationContext {
	line: number;
	startCol: number;
	endCol: number;
}

/**
 * Optional prose assistance kept separate from command/file autocomplete.
 * Hosts independently decide whether word completion and autocorrection are enabled.
 */
export interface EditorTextAssistProvider {
	/** Return ghost-text suffix for the partial word at the cursor, or `null`. */
	getWordCompletion?(lines: string[], cursorLine: number, cursorCol: number): string | null;
	/** Return a correction after one single-character insertion, or `null`. */
	tryAutocorrect?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): EditorInlineReplacement | null | Promise<EditorInlineReplacement | null>;
	/** Return replacement candidates for the misspelled word at the cursor. */
	getWordReplacements?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): EditorWordReplacements | null | Promise<EditorWordReplacements | null>;
}

type HistoryCursorAnchor = "start" | "end";
type AutocompleteRequest = { kind: "regular"; explicitTab: boolean } | { kind: "force" };

/** What the paste transport knew about the input burst before the editor inserts the payload. */
export interface PasteOptions {
	/** A submit keypress arrived in the same input burst and will be dispatched right after the paste. */
	submitAfterPaste?: boolean;
}

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
	#imeSafeCursorLayout = false;

	/** When set, replaces the normal cursor glyph at end-of-text with this ANSI-styled string. */
	cursorOverride: string | undefined;
	/** Display width of the cursorOverride glyph (needed because override may contain ANSI escapes). */
	cursorOverrideWidth: number | undefined;
	/** Optional hook that decorates displayed user text after source-text layout.
	 *  Width-changing output is allowed on lines without the cursor; it is truncated
	 *  to the content width rather than reflowed. Cursor glyphs and inline hints are excluded. */
	decorateText: ((text: string, context: EditorTextDecorationContext) => string) | undefined;
	#promptGutter: string | undefined;

	// Store last layout width for cursor navigation
	#lastLayoutWidth: number = 80;
	// Line measurement + word-wrap cache shared by #layoutText,
	// #buildVisualLineMap, and key handlers within a frame. Line text is a
	// sound key (strings are immutable); cleared on layout-width or
	// width-config (Hangul jamo setting) change and size-bounded so stale
	// lines don't accumulate.
	#wrapCache = new Map<string, WrapEntry>();
	#wrapCacheWidth = -1;
	#wrapCacheEpoch = -1;
	#paddingXOverride: number | undefined;
	#maxHeight?: number;
	#scrollOffset: number = 0;
	/** When true, the right border shows a scrollbar track/thumb when content
	 *  overflows {@link #maxHeight}. Enabled by {@link HookEditorComponent} and
	 *  other multi-line consumers; single-line consumers are unaffected. */
	#scrollbarVisible = false;

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
	#textAssistProvider?: EditorTextAssistProvider;
	#autocompleteList?: SelectList;
	#autocompleteState: "regular" | "force" | "assist" | null = null;
	#textAssistReplacement:
		| { line: number; startCol: number; endCol: number; original: string; cursorOffset: number }
		| undefined;
	#autocompletePrefix: string = "";
	#autocompleteRequestId: number = 0;
	#autocompletePendingRequest: AutocompleteRequest | undefined;
	#autocompleteRequestRunning = false;
	#autocompleteAbortController: AbortController | undefined;
	#autocompleteWaiters: Array<() => void> = [];
	#autocompleteMaxVisible: number = 10;
	onAutocompleteUpdate?: () => void;
	/** Called after an async text-assist result mutates the document outside an input event, so hosts can schedule a repaint. */
	onTextAssistApplied?: () => void;
	/** Terminal height source for clamping the autocomplete dropdown. Hosts wire this to their Terminal's rows. */
	viewportRowsProvider?: () => number;

	// Paste tracking for large pastes
	#pastes: Map<number, string> = new Map();
	#pasteCounter: number = 0;

	// Host-registered atomic chip tokens: exact buffer label → expansion emitted on submit.
	#atoms: Map<string, string> = new Map();

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
	 *  default collapse-to-marker behavior. `lineCount` is the sanitized paste's line count;
	 *  `options` carries what the paste transport knew about the burst. */
	onLargePaste?: (text: string, lineCount: number, options: PasteOptions) => boolean;
	onAutocompleteCancel?: () => void;
	disableSubmit: boolean = false;

	// Custom top border (for status line integration). Either an eager `content`
	// (set once, reused every frame) or a `provider` that recomputes lazily just
	// before the editor paints — the second form lets the host coalesce
	// per-event rebuilds down to one per rendered frame (see #4145).
	#topBorderContent?: EditorTopBorder;
	#topBorderProvider?: (availableWidth: number) => EditorTopBorder | undefined;
	#borderVisible = true;
	#borderStyle: EditorBorderStyle = "box";
	constructor(theme: EditorTheme) {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}
	/** Return bounded editor content, cursor, and transient child state for debug inspection. */
	debugState(): Record<string, unknown> {
		const lines = this.#state.lines;
		let textLength = Math.max(0, lines.length - 1);
		let textPreview = "";
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			textLength += line.length;
			if (textPreview.length >= 120) continue;
			if (i > 0) textPreview += "\n";
			textPreview += line.slice(0, 120 - textPreview.length);
		}
		return {
			textPreview,
			textLength,
			previewTruncated: textLength > 120,
			cursorLine: this.#state.cursorLine,
			cursorCol: this.#state.cursorCol,
			lineCount: lines.length,
			selection: null,
			placeholderActive: false,
		};
	}

	/** Expose the active autocomplete list to the debug tree walker. */
	get debugChildren(): readonly Component[] {
		return this.#autocompleteList ? [this.#autocompleteList] : [];
	}

	setTheme(theme: EditorTheme): void {
		this.#theme = theme;
		this.borderColor = theme.borderColor;
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#autocompleteProvider = provider;
	}

	/** Install prose assistance without changing command/file autocomplete. */
	setTextAssistProvider(provider: EditorTextAssistProvider | undefined): void {
		this.#textAssistProvider = provider;
	}

	/**
	 * Set custom content for the top border (e.g., status line).
	 * Pass undefined to use the default plain border.
	 *
	 * Eager: the passed value is cached and reused every frame. Callers that
	 * mutate status upstream must recompute and call this again. Prefer
	 * {@link setTopBorderProvider} for high-frequency updates — it collapses
	 * per-event rebuilds to one per painted frame.
	 */
	setTopBorder(content: EditorTopBorder | undefined): void {
		if (this.#topBorderContent?.content === content?.content && this.#topBorderContent?.width === content?.width)
			return;
		this.#topBorderContent = content;
	}

	/**
	 * Install a lazy provider invoked once per editor render with the current
	 * `availableWidth`. Overrides any eager content set via {@link setTopBorder}
	 * — pass `undefined` to detach and fall back to the eager slot.
	 *
	 * Use this when the top border derives from state that mutates far faster
	 * than the render cadence (session events, streaming, subagent updates).
	 * The TUI already throttles renders, so a provider is invoked exactly once
	 * per frame and does no work between paints. 	 */
	setTopBorderProvider(provider: ((availableWidth: number) => EditorTopBorder | undefined) | undefined): void {
		if (this.#topBorderProvider === provider) return;
		this.#topBorderProvider = provider;
	}

	/**
	 * Show or hide the editor border chrome.
	 */
	setBorderVisible(borderVisible: boolean): void {
		if (this.#borderVisible === borderVisible) return;
		this.#borderVisible = borderVisible;
	}

	setPromptGutter(promptGutter: string | undefined): void {
		this.#promptGutter = promptGutter;
	}
	getBorderStyle(): EditorBorderStyle {
		return this.#borderStyle;
	}

	setBorderStyle(style: EditorBorderStyle): void {
		if (this.#borderStyle === style) return;
		this.#borderStyle = style;
	}

	/** True while the autocomplete/slash-command menu is open below the editor. */
	isAutocompleteActive(): boolean {
		return this.#autocompleteState !== null;
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
		if (this.#useTerminalCursor === useTerminalCursor) return;
		this.#useTerminalCursor = useTerminalCursor;
	}

	/** Render a dedicated bottom border so terminal-local IME preedit cannot shift editor chrome. */
	setImeSafeCursorLayout(enabled: boolean): void {
		if (this.#imeSafeCursorLayout === enabled) return;
		this.#imeSafeCursorLayout = enabled;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	setMaxHeight(maxHeight: number | undefined): void {
		if (this.#maxHeight === maxHeight) return;
		this.#maxHeight = maxHeight;
		// Don't reset scrollOffset — #updateScrollOffset will clamp it on next render
	}

	/** Enable/disable the right-border scrollbar. Only shown when content overflows. */
	setScrollbarVisible(visible: boolean): void {
		this.#scrollbarVisible = visible;
	}

	setPaddingX(paddingX: number): void {
		this.#paddingXOverride = Math.max(0, paddingX);
	}

	getAutocompleteMaxVisible(): number {
		return this.#autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 10;
		if (this.#autocompleteMaxVisible !== newMaxVisible) {
			this.#autocompleteMaxVisible = newMaxVisible;
			if (this.#autocompleteState !== null) {
				this.#autocompleteList?.setMaxVisible(newMaxVisible);
			}
		}
	}

	/** Loads persistent prompts for navigation and enables future persistence. */
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

		const stor = this.#historyStorage;
		if (stor) {
			stor.add(trimmed, getProjectDir()).catch(error => {
				logger.error("HistoryStorage add failed", { error: String(error) });
			});
		}

		// Don't add consecutive duplicates
		if (this.#history.length > 0 && this.#history[0] === trimmed) return;
		this.#history.unshift(trimmed);
		// Limit history size
		if (this.#history.length > 100) {
			this.#history.pop();
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

	/** Active chrome style; a hidden border collapses every shape to borderless. */
	#effectiveStyle(): ComposerStyle {
		return this.#borderVisible ? getComposerStyle(this.#borderStyle) : borderlessComposerStyle;
	}

	#getEffectivePromptGutter(): string | undefined {
		const style = this.#effectiveStyle();
		// The box frame never renders a gutter; hosts that set one expect it only
		// in borderless contexts (hook editors, agents hub).
		if (style.sideBorders) return undefined;
		if (this.#promptGutter !== undefined) return this.#promptGutter;
		// Legacy `setBorderVisible(false)` callers control the gutter themselves;
		// only an explicitly selected composer shape gets the style default.
		if (!this.#borderVisible) return undefined;
		return style.defaultPromptGutter;
	}

	#getEditorPaddingX(): number {
		if (this.#paddingXOverride !== undefined) return Math.max(0, this.#paddingXOverride);
		return this.#effectiveStyle().defaultPaddingX(this.#theme.editorPaddingX);
	}

	#getHorizontalChromeWidth(paddingX: number): number {
		return this.#effectiveStyle().sideChromeWidth(paddingX);
	}

	#getPromptGutterWidth(width: number, paddingX: number): number {
		const gutter = this.#getEffectivePromptGutter();
		if (!gutter) return 0;
		const chromeWidth = 2 * this.#getHorizontalChromeWidth(paddingX);
		const availableWidth = Math.max(0, width - chromeWidth);
		return Math.min(visibleWidth(gutter), availableWidth);
	}

	#getPromptGutter(
		width: number,
		paddingX: number,
	): { firstLine: string; continuation: string; width: number } | undefined {
		const gutter = this.#getEffectivePromptGutter();
		if (!gutter) return undefined;
		const gutterWidth = this.#getPromptGutterWidth(width, paddingX);
		if (gutterWidth === 0) return undefined;
		return {
			firstLine: sliceByColumn(gutter, 0, gutterWidth, true),
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
		const cursorReserve = this.#effectiveStyle().sideBorders && paddingX === 0 ? 1 : 0;
		// Keep cursor/scroll layout addressable even when a borderless prompt gutter consumes every visible column.
		return Math.max(1, contentWidth - cursorReserve);
	}

	#getVisibleContentHeight(contentLines: number): number {
		if (this.#maxHeight === undefined) return contentLines;
		return Math.max(1, this.#maxHeight - this.#effectiveStyle().verticalChrome);
	}
	/** Apply the optional input decorator to a plain (ANSI-free) text segment.
	 *  Decoration only adds zero-width SGR codes, so visible width is unchanged.
	 *  Splits around CURSOR_MARKER so each user-text segment is decorated in
	 *  isolation: the marker begins with ESC, and a keyword regex that pins
	 *  the right boundary with `(?!\S)` would otherwise reject an otherwise-
	 *  valid match at the cursor seam (e.g. `ultrathink` immediately followed
	 *  by the marker stops glowing until a trailing character is typed). */
	#decorate(text: string, context: EditorTextDecorationContext): string {
		const decorate = this.decorateText;
		if (decorate === undefined || text.length === 0) return text;
		const idx = text.indexOf(CURSOR_MARKER);
		const sourceLength = Math.max(0, context.endCol - context.startCol);
		if (idx === -1) {
			const decoratedLength = Math.min(text.length, sourceLength);
			return (
				decorate(text.slice(0, decoratedLength), {
					...context,
					endCol: context.startCol + decoratedLength,
				}) + text.slice(decoratedLength)
			);
		}
		const before = text.slice(0, idx);
		const after = text.slice(idx + CURSOR_MARKER.length);
		const beforeLength = Math.min(before.length, sourceLength);
		const afterLength = Math.min(after.length, sourceLength - beforeLength);
		const cursorCol = context.startCol + beforeLength;
		return (
			(beforeLength > 0 ? decorate(before.slice(0, beforeLength), { ...context, endCol: cursorCol }) : "") +
			before.slice(beforeLength) +
			CURSOR_MARKER +
			(afterLength > 0
				? decorate(after.slice(0, afterLength), {
						...context,
						startCol: cursorCol,
						endCol: cursorCol + afterLength,
					})
				: "") +
			after.slice(afterLength)
		);
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
		const style = this.#effectiveStyle();
		const paddingX = this.#getEditorPaddingX();
		const isSideBordered = style.sideBorders;
		const promptGutter = this.#getPromptGutter(width, paddingX);
		const contentAreaWidth = this.#getContentWidth(width, paddingX);
		const layoutWidth = this.#getLayoutWidth(width, paddingX);
		this.#lastLayoutWidth = layoutWidth;

		const box = this.#theme.symbols.boxRound;
		const borderWidth = this.#getHorizontalChromeWidth(paddingX);

		// Layout the text
		const layoutLines = this.#layoutText(layoutWidth);
		const visibleContentHeight = this.#getVisibleContentHeight(layoutLines.length);
		this.#updateScrollOffset(layoutWidth, layoutLines, visibleContentHeight);
		const visibleLayoutLines = layoutLines.slice(this.#scrollOffset, this.#scrollOffset + visibleContentHeight);

		const result: string[] = [];
		// Scrollbar: shown only when content overflows and the caller opted in.
		const needsScrollbar = this.#scrollbarVisible && layoutLines.length > visibleContentHeight;
		let scrollbarThumb: { start: number; end: number } | null = null;
		if (needsScrollbar && visibleContentHeight > 0) {
			const thumbSize = Math.max(
				1,
				Math.min(
					Math.floor((visibleContentHeight * visibleContentHeight) / layoutLines.length),
					visibleContentHeight,
				),
			);
			const travel = visibleContentHeight - thumbSize;
			const maxOffset = Math.max(0, layoutLines.length - visibleContentHeight);
			const start = maxOffset === 0 ? 0 : Math.round((this.#scrollOffset / maxOffset) * travel);
			scrollbarThumb = { start, end: start + thumbSize };
		}

		// Resolve the custom top-border content once per frame; the style decides
		// how (and whether) to draw it. Provider evaluation stays editor-owned,
		// coalescing per-event rebuilds to one per painted frame.
		const topFillWidth = Math.max(0, width - borderWidth * 2);
		let topBorder: EditorTopBorder | undefined;
		if (style.statusAttachment !== "none") {
			if (this.#topBorderProvider) {
				topBorder = this.#topBorderProvider(topFillWidth);
			} else {
				topBorder = this.#topBorderContent;
			}
		}

		const chromeCtx: ComposerChromeContext = {
			width,
			paddingX,
			borderColor: (str: string) => this.borderColor(str),
			accentColor: this.#theme.accentColor ?? this.borderColor,
			surfaceColor: this.#theme.surfaceColor ?? PASSTHROUGH_COLOR,
			box,
			topBorder,
		};

		const topRow = style.renderTop(chromeCtx);
		if (topRow !== undefined) result.push(topRow);

		// Render each layout line
		// Keep the hardware cursor at the text insertion point while autocomplete
		// rows render below it; terminals use that position to anchor IME candidates.
		const emitCursorMarker = this.focused;
		const lineContentWidth = contentAreaWidth;

		// Compute inline hint text (dim ghost text after cursor)
		const inlineHint = this.#getInlineHint();
		const hintStyle = this.#theme.hintStyle ?? ((t: string) => `\x1b[2m${t}\x1b[0m`);

		for (let visibleIndex = 0; visibleIndex < visibleLayoutLines.length; visibleIndex++) {
			const layoutLine = visibleLayoutLines[visibleIndex]!;
			let displayText = layoutLine.text;
			let displayWidth = layoutLine.width;
			const decorationContext: EditorTextDecorationContext = {
				line: layoutLine.sourceLine,
				startCol: layoutLine.sourceStartCol,
				endCol: layoutLine.sourceStartCol + layoutLine.text.length,
			};
			let cursorPaddingOverflow = 0;
			let decorated = false;
			let imeSafeCursorTail = false;
			const showPromptGutter = promptGutter !== undefined && visibleIndex === 0;
			const gutterText =
				promptGutter === undefined ? "" : showPromptGutter ? promptGutter.firstLine : promptGutter.continuation;

			// Add cursor if this line has it
			const hasCursor = layoutLine.hasCursor && layoutLine.cursorPos !== undefined;
			const marker = emitCursorMarker ? CURSOR_MARKER : "";

			if (!isSideBordered && displayWidth > lineContentWidth) {
				displayText = sliceByColumn(displayText, 0, lineContentWidth, true);
				displayWidth = visibleWidth(displayText);
			}

			if (!isSideBordered && lineContentWidth === 0) {
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
					if (this.#imeSafeCursorLayout && after.length === 0 && isSideBordered) {
						// Terminal frontends render IME marked text locally before committed bytes
						// reach the application. Keep the end-of-input cursor row empty to its
						// right so that insertion cannot shift box chrome onto the next row.
						displayText = before + marker;
						imeSafeCursorTail = true;
					} else if (after.length === 0 && inlineHint) {
						const availWidth = Math.max(0, lineContentWidth - displayWidth);
						const hintText = hintStyle(truncateToWidth(inlineHint, availWidth));
						displayText = before + marker + hintText;
						displayWidth += Math.min(visibleWidth(inlineHint), availWidth);
					} else if (after.length === 0 && !isSideBordered && displayWidth >= lineContentWidth) {
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
					displayText =
						this.#decorate(before, { ...decorationContext, endCol: decorationContext.startCol + before.length }) +
						marker +
						cursor +
						this.#decorate(restAfter, {
							...decorationContext,
							startCol: decorationContext.startCol + before.length + firstGrapheme.length,
						});
					decorated = true;
					// displayWidth stays the same - we're replacing, not adding
				} else if (this.cursorOverride) {
					// Cursor override replaces the normal end-of-text cursor glyph
					const overrideWidth = this.cursorOverrideWidth ?? 1;
					if (!isSideBordered && displayWidth + overrideWidth > lineContentWidth) {
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
					if (!isSideBordered && displayWidth + cursorWidth > lineContentWidth) {
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
				displayText = this.#decorate(displayText, decorationContext);
			}
			if (!hasCursor) {
				// Undecorated, unsliced lines keep their carried width; any
				// transform above produced a new string and must be re-measured.
				displayWidth = displayText === layoutLine.text ? layoutLine.width : visibleWidth(displayText);
				if (displayWidth > lineContentWidth) {
					displayText = truncateToWidth(displayText, lineContentWidth);
					displayWidth = visibleWidth(displayText);
				}
			}
			const renderedText = isFilledComposerStyle(style)
				? displayText
				: (this.#theme.textColor ?? PASSTHROUGH_COLOR)(displayText);

			const linePad = padding(Math.max(0, lineContentWidth - displayWidth));

			result.push(
				...style.renderRow({
					...chromeCtx,
					text: renderedText,
					pad: linePad,
					gutter: gutterText,
					isLastRow: visibleIndex === visibleLayoutLines.length - 1,
					cursorOverflow: cursorPaddingOverflow,
					imeSafeCursorTail,
					scrollbarThumb:
						scrollbarThumb !== null && visibleIndex >= scrollbarThumb.start && visibleIndex < scrollbarThumb.end,
				}),
			);
		}

		const bottomRow = style.renderBottom(chromeCtx);
		if (bottomRow !== undefined) result.push(bottomRow);

		// Add autocomplete list if active
		if (this.#autocompleteState && this.#autocompleteList) {
			// Clamp the dropdown to the terminal viewport: the editor rows already
			// rendered above plus a small reserve must stay visible.
			const viewportRows = this.viewportRowsProvider?.() || process.stdout.rows || Number(Bun.env.LINES) || 24;
			this.#autocompleteList.setMaxVisible(
				Math.max(3, Math.min(this.#autocompleteMaxVisible, viewportRows - result.length - 2)),
			);
			const autocompleteResult = this.#autocompleteList.render(width);
			result.push(...autocompleteResult);
		}

		return result;
	}

	handleInput(data: string): void {
		// Iterative, not recursive: the bytes trailing a completed bracketed
		// paste (which may themselves contain further pastes) loop back here,
		// so a fragmented paste stream can never grow the call stack.
		let next: string | undefined = data;
		while (next !== undefined && next.length > 0) {
			next = this.#handleInputChunk(next);
		}
	}

	/** Process one input chunk. Returns the unconsumed tail of a completed paste, if any. */
	#handleInputChunk(data: string): string | undefined {
		const kb = getKeybindings();
		// Parse the sequence once; every binding probe below is then a set
		// lookup instead of re-parsing `data` per probe (~35 probes per key).
		const parsedKey = parseKey(data);
		const canonical = parsedKey === undefined ? undefined : canonicalKeyId(parsedKey);
		// Input wins over a pending provider lookup. The next completable edit
		// queues one fresh request after the stale request acknowledges abort.
		if (this.#autocompleteRequestRunning && this.#autocompleteState === null) {
			this.#invalidateAutocompleteRequests();
		}

		// Handle character jump mode (awaiting next character to jump to)
		if (this.#jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (
				kb.matchesCanonical(canonical, "tui.editor.jumpForward") ||
				kb.matchesCanonical(canonical, "tui.editor.jumpBackward")
			) {
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
					return paste.remaining;
				}
			}
			return;
		}

		// Bulk printable fast path: a multi-scalar run of plain text (paste
		// remainder, batched stdin) parses to no key, so no binding probe or
		// special-key branch below can consume it — it always falls through to
		// one #insertCharacter call. Take that path directly and skip the
		// dispatch cascade. Runs containing ESC or control bytes (including
		// \r/\n) keep the full path: those bytes carry key semantics.
		if (canonical === undefined && data.length > 1 && isPlainTextRun(data)) {
			this.#insertCharacter(data);
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
		if (kb.matchesCanonical(canonical, "tui.editor.undo")) {
			this.#applyUndo();
			return;
		}

		if (kb.matchesCanonical(canonical, "tui.editor.spellingSuggestions")) {
			void this.#showSpellingSuggestions();
			return;
		}

		// Handle autocomplete special keys first (but don't block other input)
		if (this.#autocompleteState && this.#autocompleteList) {
			// Escape - cancel autocomplete
			if (kb.matchesCanonical(canonical, "tui.select.cancel")) {
				this.#cancelAutocomplete(true);
				return;
			}
			// Right arrow at end of line accepts the selection like Tab (fish-style).
			// Mid-line, right arrow keeps its cursor-movement role and falls through.
			const rightArrowAccepts =
				kb.matchesCanonical(canonical, "tui.editor.cursorRight") &&
				this.#state.cursorCol >= (this.#state.lines[this.#state.cursorLine] ?? "").length;
			if (
				this.#autocompleteState === "assist" &&
				(kb.matchesCanonical(canonical, "tui.input.submit") ||
					data === "\n" ||
					kb.matchesCanonical(canonical, "tui.input.tab") ||
					rightArrowAccepts)
			) {
				this.#applySpellingSuggestion();
				return;
			}
			// Let the autocomplete list handle navigation and selection
			else if (
				kb.matchesCanonical(canonical, "tui.select.up") ||
				kb.matchesCanonical(canonical, "tui.select.down") ||
				kb.matchesCanonical(canonical, "tui.select.pageUp") ||
				kb.matchesCanonical(canonical, "tui.select.pageDown") ||
				kb.matchesCanonical(canonical, "tui.input.submit") ||
				data === "\n" ||
				kb.matchesCanonical(canonical, "tui.input.tab") ||
				rightArrowAccepts
			) {
				// Only pass navigation keys to the list, not Enter/Tab (we handle those directly)
				if (
					kb.matchesCanonical(canonical, "tui.select.up") ||
					kb.matchesCanonical(canonical, "tui.select.down") ||
					kb.matchesCanonical(canonical, "tui.select.pageUp") ||
					kb.matchesCanonical(canonical, "tui.select.pageDown")
				) {
					this.#autocompleteList.handleInput(data);
					this.onAutocompleteUpdate?.();
					return;
				}

				// If Tab was pressed, always apply the selection
				if (kb.matchesCanonical(canonical, "tui.input.tab") || rightArrowAccepts) {
					const selected = this.#autocompleteList.getSelectedItem();
					// Check for stale autocomplete state due to buffer edits since last refresh
					// (destructive keys or paste can outrun the debounced update).
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						// Autocomplete is stale - silently cancel; Tab has no fallback action here.
						this.#cancelAutocomplete();
						return;
					}
					if (selected && this.#autocompleteProvider) {
						const shouldChainAutocomplete =
							this.#isSlashCommandNameAutocompleteSelection() || isDirectoryCompletionValue(selected.value);
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

						if (shouldChainAutocomplete) {
							queueMicrotask(() => void this.#tryTriggerAutocomplete());
						}
					}
					return;
				}

				// If Enter was pressed on a submitted slash command (not an absolute-path
				// completion sharing the leading-slash prefix), apply and submit.
				if (
					(kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") &&
					findLeadingSlashCommandStart(this.#autocompletePrefix) !== null &&
					this.#isInSubmittedSlashCommandContext() &&
					!this.#selectedCompletionIsPath() &&
					!this.#selectedCompletionIsSkillNamespace()
				) {
					const selected = this.#autocompleteList.getSelectedItem();
					// Check for stale autocomplete state due to debounce
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						// Autocomplete is stale - cancel and fall through to normal submission
						this.#cancelAutocomplete();
					} else {
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
				// Otherwise, apply the completion without submitting the surrounding draft.
				else if (kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") {
					const selected = this.#autocompleteList.getSelectedItem();
					// Check for stale autocomplete state due to buffer edits since last refresh.
					const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
					const currentTextBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
					if (!this.#autocompletePrefixMatchesCursorText(currentTextBeforeCursor, selected)) {
						// Autocomplete is stale - cancel and fall through to normal submission
						this.#cancelAutocomplete();
					} else {
						if (selected && this.#autocompleteProvider) {
							const shouldChainSlashCommandAutocomplete = this.#isSlashCommandNameAutocompleteSelection();
							const shouldChainDirectoryCompletion = isDirectoryCompletionValue(selected.value);
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
							if (shouldChainDirectoryCompletion) {
								queueMicrotask(() => void this.#tryTriggerAutocomplete());
							} else if (shouldChainSlashCommandAutocomplete && this.#isCompletedSlashCommandAtCursor()) {
								void this.#tryTriggerAutocomplete();
							}
						}
						return;
					}
				}
			}
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}

		if (this.#autocompleteState === "assist") {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}

		// Tab key - context-aware completion (but not when already autocompleting)
		if (kb.matchesCanonical(canonical, "tui.input.tab") && !this.#autocompleteState) {
			void this.#handleTabCompletion();
			return;
		}

		// Continue with rest of input handling
		// Delete to end of line
		if (kb.matchesCanonical(canonical, "tui.editor.deleteToLineEnd")) {
			this.#deleteToEndOfLine();
		}
		// Delete to start of line
		else if (kb.matchesCanonical(canonical, "tui.editor.deleteToLineStart")) {
			this.#deleteToStartOfLine();
		}
		// Delete word backward. Registry defaults cover ctrl+w, alt+backspace,
		// ctrl+backspace, and super+alt+backspace (Ghostty on macOS reports
		// Option+Backspace as super+alt — kitty mod 11, see #2064).
		else if (kb.matchesCanonical(canonical, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
		}
		// Delete word forward. Registry defaults cover alt+d/alt+delete and their
		// super+alt variants for the same Ghostty quirk.
		else if (kb.matchesCanonical(canonical, "tui.editor.deleteWordForward")) {
			this.#deleteWordForwards();
		}
		// Yank from kill ring
		else if (kb.matchesCanonical(canonical, "tui.editor.yank")) {
			this.#yankFromKillRing();
		}
		// Yank-pop (cycle kill ring)
		else if (kb.matchesCanonical(canonical, "tui.editor.yankPop")) {
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
		// New line. A key the user explicitly bound to `tui.input.submit` wins
		// over these hardcoded newline fallbacks, so Ctrl/Shift+Enter can be
		// remapped to submit (#8906). The bare-LF case is exempt: its canonical
		// form is "enter" (indistinguishable from plain Enter), so gating it
		// would hijack the default Enter=submit binding.
		else if (
			(!kb.matchesCanonical(canonical, "tui.input.submit") &&
				((data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter with modifiers
					matchesKey(data, "ctrl+enter") || // Ctrl+Enter (Kitty/modifyOtherKeys, including lock bits/keypad Enter)
					data === "\x1b\r" || // Option+Enter in some terminals (legacy)
					data === "\x1b[13;2~" || // Shift+Enter in some terminals (legacy format)
					kb.matchesCanonical(canonical, "tui.input.newLine") || // Shift+Enter (Kitty protocol, handles lock bits)
					(data.length > 1 && data.includes("\x1b") && data.includes("\r")))) ||
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
		else if (kb.matchesCanonical(canonical, "tui.input.submit") || data === "\n") {
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
		else if (kb.matchesCanonical(canonical, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.#handleBackspace();
		}
		// Line navigation shortcuts (Home/End keys)
		else if (kb.matchesCanonical(canonical, "tui.editor.cursorLineStart")) {
			this.#moveToLineStart();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorLineEnd")) {
			this.#moveToLineEnd();
		}
		// Page navigation (PageUp/PageDown): page the editor viewport only. On a
		// short draft this is a no-op — it never steps prompt history (that stays
		// on Up/Down), so an idle empty editor swallows the keys instead of
		// surprising the user by loading the previous prompt (#4754).
		else if (kb.matchesCanonical(canonical, "tui.editor.pageUp")) {
			this.#pageScroll(-1);
		} else if (kb.matchesCanonical(canonical, "tui.editor.pageDown")) {
			this.#pageScroll(1);
		}
		// Forward delete (Fn+Backspace or Delete key, including Shift+Delete)
		else if (kb.matchesCanonical(canonical, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.#handleForwardDelete();
		}
		// Word navigation (Option/Alt + Arrow or Ctrl + Arrow)
		else if (kb.matchesCanonical(canonical, "tui.editor.cursorWordLeft")) {
			// Word left
			this.#resetKillSequence();
			this.#moveWordBackwards();
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorWordRight")) {
			// Word right
			this.#resetKillSequence();
			this.#moveWordForwards();
		}
		// Arrow keys
		else if (kb.matchesCanonical(canonical, "tui.editor.cursorUp")) {
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
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorDown")) {
			// Down - history navigation or cursor movement
			if (this.#historyIndex > -1 && this.#isOnLastVisualLine()) {
				this.#navigateHistory(1); // Navigate to newer history entry or clear
			} else if (this.#isOnLastVisualLine()) {
				// Already at bottom - jump to end of line
				this.#moveToLineEnd();
			} else {
				this.#moveCursor(1, 0); // Cursor movement (within text or history entry)
			}
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorRight")) {
			// Right
			// At end of line, accept the inline ghost word completion (IME-style) like Tab.
			if (
				this.#state.cursorCol >= (this.#state.lines[this.#state.cursorLine] ?? "").length &&
				this.#acceptWordCompletion()
			) {
				return;
			}
			this.#moveCursor(0, 1);
		} else if (kb.matchesCanonical(canonical, "tui.editor.cursorLeft")) {
			// Left
			this.#moveCursor(0, -1);
		}
		// Shift+Space - insert regular space (Kitty protocol sends escape sequence)
		else if (matchesKey(data, "shift+space")) {
			this.#insertCharacter(" ");
		}
		// Character jump mode triggers
		else if (kb.matchesCanonical(canonical, "tui.editor.jumpForward")) {
			this.#jumpMode = "forward";
		} else if (kb.matchesCanonical(canonical, "tui.editor.jumpBackward")) {
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

	/** Cached per-line measurement: exact visible width now, wrap chunks on demand. */
	#lineEntry(line: string, width: number): WrapEntry {
		const epoch = getWidthConfigEpoch();
		if (width !== this.#wrapCacheWidth || epoch !== this.#wrapCacheEpoch) {
			this.#wrapCache.clear();
			this.#wrapCacheWidth = width;
			this.#wrapCacheEpoch = epoch;
		}
		let entry = this.#wrapCache.get(line);
		if (entry === undefined) {
			if (this.#wrapCache.size >= 256) {
				this.#wrapCache.clear();
			}
			entry = { width: visibleWidth(line), chunks: null };
			this.#wrapCache.set(line, entry);
		}
		return entry;
	}

	#wrapLine(line: string, width: number): TextChunk[] {
		const entry = this.#lineEntry(line, width);
		entry.chunks ??= wordWrapLine(line, width, entry.width);
		return entry.chunks;
	}

	#layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.#state.lines.length === 0 || (this.#state.lines.length === 1 && this.#state.lines[0] === "")) {
			// Empty editor
			layoutLines.push({
				text: "",
				width: 0,
				sourceLine: 0,
				sourceStartCol: 0,
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		// Process each logical line
		for (let i = 0; i < this.#state.lines.length; i++) {
			const line = this.#state.lines[i] || "";
			const isCurrentLine = i === this.#state.cursorLine;
			const lineVisibleWidth = this.#lineEntry(line, contentWidth).width;

			if (lineVisibleWidth <= contentWidth) {
				// Line fits in one layout line
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						width: lineVisibleWidth,
						sourceLine: i,
						sourceStartCol: 0,
						hasCursor: true,
						cursorPos: this.#state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						width: lineVisibleWidth,
						sourceLine: i,
						sourceStartCol: 0,
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
							width: chunk.width,
							sourceLine: i,
							sourceStartCol: chunk.startIndex,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							width: chunk.width,
							sourceLine: i,
							sourceStartCol: chunk.startIndex,
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

	/** Whether the buffer text equals `value`, without `getText()`'s full join —
	 *  O(1) for the hot per-keystroke probes against short single-line values. */
	textEquals(value: string): boolean {
		const lines = this.#state.lines;
		if (lines.length === 1) return lines[0] === value;
		if (value.indexOf("\n") === -1) return false;
		return this.getText() === value;
	}

	/** Expand collapsed markers — `[Paste #N]` tokens and registered atom labels — into their
	 *  stored content. Single pass so replaced content is never rescanned (a pasted body that
	 *  happens to contain another token's label must survive verbatim). Longer atom labels are
	 *  tried first so `#1` never shadows `#10`. */
	#expandPasteMarkers(text: string): string {
		const sources: string[] = [];
		for (const pasteId of this.#pastes.keys()) {
			sources.push(`\\[Paste #${pasteId}(?:, (?:\\+\\d+ lines|\\d+ chars))?\\]`);
		}
		const labels = [...this.#atoms.keys()].sort((a, b) => b.length - a.length);
		for (const label of labels) sources.push(RegExp.escape(label));
		if (sources.length === 0) return text;
		const markerRegex = new RegExp(sources.join("|"), "g");
		return text.replace(markerRegex, match => {
			const paste = /^\[Paste #(\d+)/.exec(match);
			if (paste) return this.#pastes.get(Number(paste[1])) ?? match;
			return this.#atoms.get(match) ?? match;
		});
	}

	/** Register `label` as a collapsed atom expanding to `expansion` on submit, without inserting
	 *  it — for hosts that re-collapse restored draft text via {@link setText}. */
	registerAtom(label: string, expansion: string): void {
		this.#atoms.set(label, expansion);
	}

	/** Insert `label` (plus a trailing space) at the cursor and register it as an atom expanding
	 *  to `expansion` on submit. Pair with {@link atomicTokenPattern} so the label deletes as a
	 *  unit. */
	insertAtom(label: string, expansion: string): void {
		this.#historyIndex = -1;
		this.#resetKillSequence();
		this.#recordUndoState();
		this.registerAtom(label, expansion);
		this.#withUndoSuspended(() => {
			this.#insertTextAtCursor(`${label} `);
		});
	}

	/** Drop every registered atom expansion (draft cleared or replaced by the host). */
	clearAtoms(): void {
		this.#atoms.clear();
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
	submit(): void {
		if (this.disableSubmit) return;
		this.#submitValue();
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
	pasteText(text: string, options: PasteOptions = {}): void {
		this.#handlePaste(text, options);
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
	#applyInlineReplacement(replacement: EditorInlineReplacement): boolean {
		if (
			!Number.isInteger(replacement.replaceLen) ||
			replacement.replaceLen < 0 ||
			replacement.replaceLen > this.#state.cursorCol
		) {
			return false;
		}
		const line = this.#state.lines[this.#state.cursorLine] || "";
		const before = line.slice(0, this.#state.cursorCol - replacement.replaceLen);
		const after = line.slice(this.#state.cursorCol);
		this.#state.lines[this.#state.cursorLine] = before + replacement.insert + after;
		this.#setCursorCol(before.length + replacement.insert.length);
		this.onChange?.(this.getText());
		if (this.#autocompleteState) {
			this.#cancelAutocomplete();
			this.onAutocompleteUpdate?.();
		}
		return true;
	}

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
		if (char.length === 1) {
			const replaceLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = replaceLine.slice(0, this.#state.cursorCol);
			const inlineReplacement = this.#autocompleteProvider?.trySyncInlineReplace?.(textBeforeCursor);
			if (inlineReplacement && this.#applyInlineReplacement(inlineReplacement)) return;
			const cursorLine = this.#state.cursorLine;
			const cursorCol = this.#state.cursorCol;
			const currentLine = this.#state.lines[cursorLine] ?? "";
			const autocorrection = this.#textAssistProvider?.tryAutocorrect?.(this.#state.lines, cursorLine, cursorCol);
			if (autocorrection instanceof Promise) {
				autocorrection
					.then(replacement => {
						if (
							replacement &&
							this.#state.cursorLine === cursorLine &&
							this.#state.cursorCol === cursorCol &&
							this.#state.lines[cursorLine] === currentLine &&
							this.#applyInlineReplacement(replacement)
						) {
							this.onTextAssistApplied?.();
						}
					})
					.catch(() => {});
			} else if (autocorrection && this.#applyInlineReplacement(autocorrection)) {
				return;
			}
		}

		// Check if we should trigger or update autocomplete
		if (!this.#autocompleteState) {
			// Auto-trigger for "/" at the start of a submitted command or a mid-prompt skill lookup.
			if (char === "/" && (this.#isAtStartOfSubmittedMessage() || this.#isInMidPromptSkillSlashContext())) {
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
				// Check if we're in a slash command or mid-prompt skill lookup.
				if (this.#isInSlashAutocompleteContext()) {
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

	#handlePaste(pastedText: string, options: PasteOptions = {}): void {
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
		if (isMarkerSized && this.onLargePaste?.(filteredText, pastedLines.length, options)) {
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
		if (this.#isInSlashAutocompleteContext()) {
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
		this.#atoms.clear();
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

		let removedSlashTrigger = false;

		if (this.#state.cursorCol > 0) {
			const line = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = line.slice(0, this.#state.cursorCol);
			const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
			removedSlashTrigger = trailingSlashStart === this.#state.cursorCol - 1;
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
			if (removedSlashTrigger) {
				this.#cancelAutocomplete();
				this.onAutocompleteUpdate?.();
			} else {
				this.#debouncedUpdateAutocomplete();
			}
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.#state.lines[this.#state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.#state.cursorCol);
			// Slash command or mid-prompt skill lookup context
			if (this.#isInSlashAutocompleteContext()) {
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
			if (this.#isInSlashAutocompleteContext()) {
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
		this.#retriggerAutocompleteAtCursor();
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
		this.#retriggerAutocompleteAtCursor();
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
		this.#retriggerAutocompleteAtCursor();
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
		this.#retriggerAutocompleteAtCursor();
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
		this.#retriggerAutocompleteAtCursor();
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
			// Slash command or mid-prompt skill lookup context
			if (this.#isInSlashAutocompleteContext()) {
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
			const lineVisWidth = this.#lineEntry(line, width).width;
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

	#isInMidPromptSkillSlashContext(): boolean {
		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);
		const slashStart = findTrailingSlashCommandStart(beforeCursor);
		if (slashStart === null) return false;
		if (this.#hasOnlyWhitespaceBeforeCursorLine() && findLeadingSlashCommandStart(beforeCursor) !== null)
			return false;
		return !this.#hasOnlyWhitespaceBeforeCursorLine() || beforeCursor.slice(0, slashStart).trim() !== "";
	}

	#isInSlashAutocompleteContext(): boolean {
		return this.#isInSubmittedSlashCommandContext() || this.#isInMidPromptSkillSlashContext();
	}

	/**
	 * Decide whether the popup's `#autocompletePrefix` still safely maps onto the current
	 * text before the cursor for an accept-time (`applyCompletion`) call. Mirrors the
	 * re-anchoring branches in `CombinedAutocompleteProvider.applyCompletion`:
	 *
	 * - Exact match → always safe.
	 * - Path branch is safe when the prefix is still a live suffix of the text; the
	 *   provider's default slice at `cursorCol - prefix.length` then hits the right span.
	 * - Slash branch re-anchors when both the prefix and the current text carry a
	 *   leading slash command and the current slash token is clean (no whitespace or
	 *   inner slash), matching `applyCompletion`'s slash-branch guard. It only
	 *   engages for command-shaped selections: absolute-path completions (`/tmp/fo`
	 *   via the no-command-match fall-through) share the leading-slash prefix shape
	 *   but must use the live-suffix path rule so the apply slice stays anchored.
	 * - Mid-prompt skill branch re-anchors when the popup item is a skill and the
	 *   current text still ends in a matching trailing slash token, preventing a
	 *   stale selection from replacing a newer skill prefix.
	 * - `@`-file branch re-anchors via `#extractAtPrefix`; safe when the current text
	 *   still ends in a whitespace-anchored `@<token>`.
	 * - Everything else is stale — accepting it would corrupt the buffer (issue #4295).
	 */
	#autocompletePrefixMatchesCursorText(currentTextBeforeCursor: string, item?: SelectItem | null): boolean {
		if (currentTextBeforeCursor === this.#autocompletePrefix) return true;

		if (item?.value.startsWith("skill:") && findTrailingSlashCommandStart(this.#autocompletePrefix) !== null) {
			const currentTrailingStart = findTrailingSlashCommandStart(currentTextBeforeCursor);
			if (currentTrailingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentTrailingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) {
					// Guard the timing window where the popup was built for an earlier
					// query (e.g. bare `/`) and the user typed further characters before
					// the 100 ms debounced refresh fired: accept the stale skill only
					// when the refreshed popup would still surface it (same gate as
					// buildMidPromptSkillCompletions). `tmp` after a bare slash
					// therefore falls through to file completion instead of rewriting
					// the user's `/tmp` to `/skill:…`.
					const lowerToken = token.slice(1).toLowerCase();
					if (midPromptSkillTokenMatches(lowerToken, item.value, item.description)) return true;
				}
			}
			return false;
		}

		if (findLeadingSlashCommandStart(this.#autocompletePrefix) !== null && !this.#selectedCompletionIsPath()) {
			const currentLeadingStart = findLeadingSlashCommandStart(currentTextBeforeCursor);
			if (currentLeadingStart !== null) {
				const token = currentTextBeforeCursor.slice(currentLeadingStart);
				if (!token.includes(" ") && !token.slice(1).includes("/")) return true;
			}
			return false;
		}

		if (this.#autocompletePrefix.startsWith("@")) {
			return /(?:^|\s)@[^\s]*$/.test(currentTextBeforeCursor);
		}

		return currentTextBeforeCursor.endsWith(this.#autocompletePrefix);
	}

	/**
	 * Whether the current popup selection inserts a file path rather than a
	 * slash command. Leading-slash prefixes are ambiguous: the provider falls
	 * through to absolute-path completion when no command matches, and those
	 * item values start with `/` (or `"` when quoted) while command values are
	 * bare names.
	 */
	#selectedCompletionIsPath(): boolean {
		const selected = this.#autocompleteList?.getSelectedItem();
		if (!selected) return false;
		return selected.value.startsWith("/") || selected.value.startsWith('"');
	}
	/**
	 * Whether the current popup selection is the collapsed `/skill:` namespace
	 * row. Accepting it expands the namespace (insert `/skill:`, reopen the
	 * popup) instead of submitting, since the bare namespace is not a command.
	 */
	#selectedCompletionIsSkillNamespace(): boolean {
		return this.#autocompleteList?.getSelectedItem()?.value === SKILL_NAMESPACE;
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
		return (
			this.#isInSubmittedSlashCommandContext() &&
			(/^\/\S+ $/.test(textBeforeCursor) || textBeforeCursor === `/${SKILL_NAMESPACE}`)
		);
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
		if (
			explicitTab &&
			this.#autocompleteProvider.shouldTriggerFileCompletion &&
			!this.#autocompleteProvider.shouldTriggerFileCompletion(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			)
		) {
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "regular", explicitTab });
	}
	#createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : AUTOCOMPLETE_SELECT_LIST_LAYOUT;
		return new SelectList(items, this.#autocompleteMaxVisible, this.#theme.selectList, layout);
	}

	async #handleTabCompletion(): Promise<void> {
		if (this.#acceptWordCompletion()) return;
		if (!this.#autocompleteProvider) return;

		const currentLine = this.#state.lines[this.#state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.#state.cursorCol);

		if (this.#isInSubmittedSlashCommandContext() && !beforeCursor.trimStart().includes(" ")) {
			await this.#handleSlashCommandCompletion();
		} else if (this.#isInMidPromptSkillSlashContext()) {
			await this.#handleSlashCommandCompletion();
			if (!this.#autocompleteState) {
				await this.#forceFileAutocomplete();
			}
		} else {
			await this.#forceFileAutocomplete();
		}
	}
	/** Insert the inline ghost word completion at the cursor, if any. Shared by Tab and right-arrow accept. */
	#acceptWordCompletion(): boolean {
		const wordCompletion = this.#getWordCompletion();
		if (!wordCompletion) return false;
		const currentLine = this.#state.lines[this.#state.cursorLine] ?? "";
		const after = currentLine.slice(this.#state.cursorCol);
		this.#insertTextAtCursor(wordCompletion + (/^[\s.,;:!?"\])}]/.test(after) ? "" : " "));
		return true;
	}

	async #showSpellingSuggestions(): Promise<void> {
		const cursorLine = this.#state.cursorLine;
		const cursorCol = this.#state.cursorCol;
		const lines = [...this.#state.lines];
		const result = this.#textAssistProvider?.getWordReplacements?.(lines, cursorLine, cursorCol);
		const replacements = result instanceof Promise ? await result.catch(() => null) : result;
		if (
			!replacements ||
			this.#state.cursorLine !== cursorLine ||
			this.#state.cursorCol !== cursorCol ||
			this.#state.lines[replacements.line] !== lines[replacements.line] ||
			replacements.line < 0 ||
			replacements.line >= this.#state.lines.length ||
			replacements.startCol < 0 ||
			replacements.endCol <= replacements.startCol ||
			replacements.items.length === 0
		) {
			return;
		}
		const line = this.#state.lines[replacements.line] ?? "";
		if (replacements.endCol > line.length) return;
		const original = line.slice(replacements.startCol, replacements.endCol);
		this.#autocompletePrefix = original;
		this.#autocompleteList = this.#createAutocompleteList(
			original,
			replacements.items.map(value => ({ value, label: value })),
		);
		this.#autocompleteState = "assist";
		this.#textAssistReplacement = {
			line: replacements.line,
			startCol: replacements.startCol,
			endCol: replacements.endCol,
			original,
			cursorOffset:
				replacements.line === this.#state.cursorLine ? Math.max(0, this.#state.cursorCol - replacements.endCol) : 0,
		};
		this.onAutocompleteUpdate?.();
	}

	#applySpellingSuggestion(): void {
		const replacement = this.#textAssistReplacement;
		const selected = this.#autocompleteList?.getSelectedItem();
		if (!replacement || !selected) {
			this.#cancelAutocomplete();
			return;
		}
		const line = this.#state.lines[replacement.line] ?? "";
		if (line.slice(replacement.startCol, replacement.endCol) !== replacement.original) {
			this.#cancelAutocomplete();
			return;
		}
		this.#recordUndoState();
		this.#state.lines[replacement.line] =
			line.slice(0, replacement.startCol) + selected.value + line.slice(replacement.endCol);
		this.#state.cursorLine = replacement.line;
		this.#setCursorCol(replacement.startCol + selected.value.length + replacement.cursorOffset);
		this.#lastAction = null;
		this.#cancelAutocomplete();
		this.onAutocompleteUpdate?.();
		this.onChange?.(this.getText());
	}
	async #handleSlashCommandCompletion(): Promise<void> {
		await this.#tryTriggerAutocomplete();
	}

	async #forceFileAutocomplete(): Promise<void> {
		if (!this.#autocompleteProvider) return;
		if (typeof this.#autocompleteProvider.getForceFileSuggestions !== "function") {
			await this.#tryTriggerAutocomplete(true);
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "force" });
	}

	#cancelAutocomplete(notifyCancel: boolean = false): void {
		const wasAutocompleting = this.#autocompleteState !== null;
		this.#clearAutocompleteTimeout();
		this.#invalidateAutocompleteRequests();
		this.#autocompleteState = null;
		this.#autocompleteList = undefined;
		this.#textAssistReplacement = undefined;
		this.#autocompletePrefix = "";
		if (notifyCancel && wasAutocompleting) {
			this.onAutocompleteCancel?.();
		}
	}

	isShowingAutocomplete(): boolean {
		return this.#autocompleteState !== null;
	}

	async #updateAutocomplete(): Promise<void> {
		if (!this.#autocompleteState || !this.#autocompleteProvider || this.#autocompleteState === "assist") return;
		if (this.#autocompleteState === "force") {
			await this.#forceFileAutocomplete();
			return;
		}
		await this.#queueAutocompleteRequest({ kind: "regular", explicitTab: false });
	}

	#queueAutocompleteRequest(request: AutocompleteRequest): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#autocompleteWaiters.push(waiter.resolve);
		this.#autocompletePendingRequest = request;
		this.#autocompleteRequestId++;
		this.#autocompleteAbortController?.abort();
		if (!this.#autocompleteRequestRunning) void this.#drainAutocompleteRequests();
		return waiter.promise;
	}

	async #drainAutocompleteRequests(): Promise<void> {
		if (this.#autocompleteRequestRunning) return;
		this.#autocompleteRequestRunning = true;
		try {
			while (this.#autocompletePendingRequest) {
				const request = this.#autocompletePendingRequest;
				this.#autocompletePendingRequest = undefined;
				const requestId = this.#autocompleteRequestId;
				const controller = new AbortController();
				this.#autocompleteAbortController = controller;
				await this.#runAutocompleteRequest(request, requestId, controller.signal);
				if (this.#autocompleteAbortController === controller) {
					this.#autocompleteAbortController = undefined;
				}
			}
		} finally {
			this.#autocompleteRequestRunning = false;
			const waiters = this.#autocompleteWaiters.splice(0);
			for (const resolve of waiters) resolve();
		}
	}

	async #runAutocompleteRequest(request: AutocompleteRequest, requestId: number, signal: AbortSignal): Promise<void> {
		const provider = this.#autocompleteProvider;
		if (!provider) return;
		const lines = [...this.#state.lines];
		const cursorLine = this.#state.cursorLine;
		const cursorCol = this.#state.cursorCol;
		let suggestions: { items: AutocompleteItem[]; prefix: string } | null;
		try {
			if (request.kind === "force") {
				const getForceFileSuggestions = provider.getForceFileSuggestions;
				if (!getForceFileSuggestions) return;
				suggestions = await getForceFileSuggestions.call(provider, lines, cursorLine, cursorCol, signal);
			} else {
				suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, signal);
			}
		} catch (error) {
			if (!signal.aborted && requestId === this.#autocompleteRequestId) {
				logger.debug("Autocomplete provider failed", { error: String(error) });
				this.#cancelAutocomplete();
				this.onAutocompleteUpdate?.();
			}
			return;
		}
		if (
			signal.aborted ||
			requestId !== this.#autocompleteRequestId ||
			cursorLine !== this.#state.cursorLine ||
			cursorCol !== this.#state.cursorCol ||
			lines.length !== this.#state.lines.length ||
			lines.some((line, index) => line !== this.#state.lines[index])
		) {
			return;
		}

		if (suggestions && Array.isArray(suggestions.items) && suggestions.items.length > 0) {
			this.#autocompletePrefix = suggestions.prefix;
			this.#autocompleteList = this.#createAutocompleteList(suggestions.prefix, suggestions.items);
			this.#autocompleteState = request.kind === "force" ? "force" : "regular";
			this.onAutocompleteUpdate?.();
			return;
		}
		this.#cancelAutocomplete();
		this.onAutocompleteUpdate?.();
	}

	#invalidateAutocompleteRequests(): void {
		this.#autocompletePendingRequest = undefined;
		this.#autocompleteRequestId++;
		this.#autocompleteAbortController?.abort();
		const waiters = this.#autocompleteWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	#debouncedUpdateAutocomplete(): void {
		if (this.#autocompleteTimeout) {
			clearTimeout(this.#autocompleteTimeout);
		}
		this.#autocompleteTimeout = setTimeout(() => {
			void this.#updateAutocomplete();
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
			const hint = this.#autocompleteProvider.getInlineHint(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			);
			if (hint) return hint;
		}

		return this.#getWordCompletion();
	}
	#getWordCompletion(): string | null {
		return (
			this.#textAssistProvider?.getWordCompletion?.(
				this.#state.lines,
				this.#state.cursorLine,
				this.#state.cursorCol,
			) ?? null
		);
	}
}
