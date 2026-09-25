import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { KillRing } from "../kill-ring";
import { SpaceHoldGesture } from "../space-hold";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import { cursorColumnWindow } from "./scroll-viewport";
import {
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceWithWidth,
	visibleWidth,
} from "../utils";

const segmenter = getSegmenter();

/**
 * Clean text entering the single-line value from outside the keyboard (pastes, dictation) —
 * decode tmux's re-encoded control bytes (both extended-keys formats, e.g. Ctrl+J → "\n") back to
 * literal bytes so the escape tail does not leak in, remove newlines/carriage returns, expand tabs,
 * NFC-normalize, then strip any remaining control bytes. The decoder can synthesize Ctrl+A..Ctrl+Z
 * (0x01..0x1A) from a paste, and a single-line value must hold none of them — newlines are already
 * gone and tabs are already spaces by the time the C0/DEL strip runs.
 *
 * NFC normalization rationale: macOS Finder drag-drops file paths in NFD
 * (Conjoining Jamo, U+1100..U+11FF). `Bun.stringWidth` counts each
 * conjoining jamo as a separate cell — a Korean syllable like `화` is
 * 1 char and 2 cells in NFC, but 2 chars and 3 cells in NFD (ᄒ=2 cells
 * + ᅪ=1 cell). The terminal renders the NFD sequence as a single
 * combined syllable (2 cells visible), so the width mismatch shows up
 * as cursor drift past the visible filename — N×~1.5 cells for a path
 * with N Korean syllables. NFC normalization at insert time stores the
 * value in the same form everything else in the codebase assumes.
 */
function toSingleLine(text: string): string {
	return replaceTabs(decodeReencodedPasteControls(text).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""))
		.normalize("NFC")
		.replace(/[\x00-\x1F\x7F]/g, "");
}

interface InputState {
	value: string;
	cursor: number;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	#value: string = "";
	#cursor: number = 0; // Cursor position in the value
	#useTerminalCursor = false;
	/** Rendered before the editable area; set to "" for chrome-less embedding. */
	prompt = "> ";
	/** Render the editable value as bullets while retaining the real value internally. */
	mask = false;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	/** Space-bar push-to-talk; set its `handler` to enable it. */
	readonly spaceHold = new SpaceHoldGesture(count => this.deleteBeforeCursor(count));
	/** When set, replaces the cursor glyph at end-of-text with this ANSI-styled string. */
	cursorOverride: string | undefined;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	#pasteHandler = new BracketedPasteHandler();

	// Kill ring for Emacs-style kill/yank operations
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	#undoStack: InputState[] = [];
	/** States undone off {@link #undoStack}, replayable until the next fresh edit. */
	#redoStack: InputState[] = [];

	/** Code units of the current volatile speech-to-text preview (see {@link setVolatileText}). */
	#volatileTextLen = 0;

	getValue(): string {
		return this.#value;
	}
	/** Return bounded input content and cursor state for debug inspection. */
	debugState(): Record<string, unknown> {
		return {
			textPreview: this.mask ? "********" : this.#value.slice(0, 120),
			textLength: this.#value.length,
			previewTruncated: this.#value.length > 120,
			cursor: this.#cursor,
			cursorLine: 0,
			selection: null,
			placeholderActive: false,
			masked: this.mask,
		};
	}

	setValue(value: string): void {
		this.#value = value;
		// Callers seed or replace the value wholesale; typing continues at the end.
		this.#cursor = value.length;
		this.#undoStack.length = 0;
		this.#redoStack.length = 0;
		this.#lastAction = null;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	handleInput(data: string): void {
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

		// Space-hold push-to-talk: a sustained space bar starts/stops STT instead of typing spaces.
		switch (this.spaceHold.process(matchesKey(data, "space"))) {
			case "type":
				this.#insertCharacter(" ");
				return;
			case "swallow":
				return;
		}

		const kb = getKeybindings();

		// Escape/Cancel
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return;
		}

		// Redo
		if (kb.matches(data, "tui.editor.redo")) {
			this.#redo();
			return;
		}

		// Submit
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.#value);
			return;
		}

		// Deletion
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.#handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.#handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.#deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.#deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#deleteToLineEnd();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.#yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.#yankPop();
			return;
		}

		// Cursor movement
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#lastAction = null;
			if (this.#cursor > 0) {
				const beforeCursor = this.#value.slice(0, this.#cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.#cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#lastAction = null;
			if (this.#cursor < this.#value.length) {
				const afterCursor = this.#value.slice(this.#cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.#cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#lastAction = null;
			this.#cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#lastAction = null;
			this.#cursor = this.#value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#moveWordForwards();
			return;
		}

		// Regular character input, including Kitty CSI-u text-producing sequences.
		const printableText = extractPrintableText(data);
		if (printableText) {
			this.#insertCharacter(printableText);
		}
	}

	/** Apply terminal paste semantics to text from non-bracketed paste transports
	 *  (e.g. kitty's OSC 5522 enhanced clipboard read). Mirrors `Editor.pasteText`. */
	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	/** Programmatically trigger submission (e.g. for voice submit). */
	submit(): void {
		this.onSubmit?.(this.#value);
	}

	/** Delete up to `count` characters immediately before the cursor. */
	deleteBeforeCursor(count: number): void {
		const removable = Math.min(count, this.#cursor);
		if (removable <= 0) return;
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(removable, "");
	}

	/** Show or replace a volatile speech-to-text preview at the cursor, outside undo history.
	 *  Finalize it with {@link commitVolatileText} or drop it with {@link clearVolatileText}. */
	setVolatileText(text: string): void {
		const clean = toSingleLine(text);
		this.#replaceBeforeCursor(this.#volatileTextLen, clean);
		this.#volatileTextLen = clean.length;
	}

	/** Remove the current volatile preview without committing it. */
	clearVolatileText(): void {
		this.setVolatileText("");
	}

	/** Drop any volatile preview, then insert `text` as a single undoable edit. */
	commitVolatileText(text: string): void {
		this.clearVolatileText();
		const clean = toSingleLine(text);
		if (!clean) return;
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(0, clean);
	}

	/** Replace up to `count` code units before the cursor with `text`, leaving the cursor after it. The
	 *  range stops at the start of the value: a volatile preview's length can outrun the cursor once
	 *  the caret moves while dictation is still streaming. */
	#replaceBeforeCursor(count: number, text: string): void {
		const start = Math.max(0, this.#cursor - count);
		this.#value = this.#value.slice(0, start) + text + this.#value.slice(this.#cursor);
		this.#cursor = start + text.length;
	}

	#insertCharacter(text: string): void {
		const isWordChunk = [...segmenter.segment(text)].every(seg => getWordNavKind(seg.segment) !== "whitespace");
		// Undo coalescing: consecutive word typing coalesces into one undo unit.
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";

		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();

		const beforeCursor = this.#value.slice(0, this.#cursor);
		const graphemes = [...segmenter.segment(beforeCursor)];
		const lastGrapheme = graphemes[graphemes.length - 1];
		const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor);
		this.#cursor -= graphemeLength;
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();

		const afterCursor = this.#value.slice(this.#cursor);
		const graphemes = [...segmenter.segment(afterCursor)];
		const firstGrapheme = graphemes[0];
		const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(0, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(this.#cursor);
		this.#killRing.push(deletedText, { prepend: false, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		// Save state before cursor movement (moveWordBackwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(deleteFrom, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor);
		this.#cursor = deleteFrom;
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		// Save state before cursor movement (moveWordForwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(this.#cursor, deleteTo);
		this.#killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo);
	}

	#yank(): void {
		const text = this.#killRing.peek();
		if (!text) {
			return;
		}

		this.#pushUndo();
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		this.#pushUndo();

		const prevText = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor - prevText.length) + this.#value.slice(this.#cursor);
		this.#cursor -= prevText.length;

		this.#killRing.rotate();
		const text = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#pushUndo(): void {
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor });
		// A fresh edit forks history: whatever was undone is no longer reachable forward.
		this.#redoStack.length = 0;
	}

	#undo(): void {
		// A volatile STT preview is not a committed edit and must never enter history snapshots.
		this.clearVolatileText();
		const snapshot = this.#undoStack.pop();
		if (!snapshot) {
			return;
		}
		this.#redoStack.push({ value: this.#value, cursor: this.#cursor });
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
	}

	#redo(): void {
		// Keep redo symmetric with undo if a new volatile preview arrived after an undo.
		this.clearVolatileText();
		const snapshot = this.#redoStack.pop();
		if (!snapshot) {
			return;
		}
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor });
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
	}

	#moveWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordLeft(this.#value, this.#cursor);
	}

	#moveWordForwards(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordRight(this.#value, this.#cursor);
	}

	#handlePaste(pastedText: string): void {
		const cleanText = toSingleLine(pastedText);
		// A payload that sanitizes to nothing (e.g. a lone newline, or only control bytes) is
		// not an edit. Recording undo before this point forked history and erased the redo
		// branch for a paste that changed nothing — the same class of bug as the no-op delete
		// commands, so the snapshot is taken only once an actual mutation is certain.
		if (cleanText.length === 0) return;
		this.#lastAction = null;
		this.#pushUndo();
		this.#replaceBeforeCursor(0, cleanText);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		// Calculate visible window
		const prompt = this.prompt;
		const availableWidth = width - visibleWidth(prompt);

		if (availableWidth <= 0) {
			return [sliceWithWidth(prompt, 0, width, true).text];
		}

		let cursorIndex = this.#cursor;
		// Ensure we always have a grapheme to invert at the cursor (space at end).
		let visibleValue = this.#value;
		if (this.mask) {
			const graphemes = [...segmenter.segment(this.#value)];
			visibleValue = "•".repeat(graphemes.length);
			cursorIndex = graphemes.filter(grapheme => grapheme.index < this.#cursor).length;
		}
		// At end of text the cursor sits on trailing padding, sized to fit a (possibly wide) cursor override.
		const atEnd = this.#cursor >= this.#value.length;
		const override =
			atEnd && this.cursorOverride !== undefined
				? { text: this.cursorOverride, width: visibleWidth(this.cursorOverride) }
				: undefined;
		const displayValue = atEnd ? visibleValue + " ".repeat(override?.width ?? 1) : visibleValue;

		const window = cursorColumnWindow(displayValue, cursorIndex, availableWidth);
		const visibleText = window.text;
		const cursorDisplay = window.cursorIndex;

		// Build the visible line and insert the cursor marker at the buffer cursor.
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? "";
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before the cursor cell for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";
		const { text: cursorChar, width: cursorWidth } = override ?? this.#cursorCell(atCursor);

		// Clamp only the trailing text (measured in terminal cells), keeping the cursor marker intact.
		const beforeWidth = visibleWidth(beforeCursor);
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = visibleWidth(renderedNoMarker);
		const pad = padding(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + pad;
		return [line];
	}

	/** The rendered cursor cell: the grapheme under the cursor, inverted unless the terminal draws its own cursor. */
	#cursorCell(atCursor: string): { text: string; width: number } {
		if (this.#useTerminalCursor) return { text: atCursor, width: visibleWidth(atCursor) };
		return { text: `\x1b[7m${atCursor || " "}\x1b[27m`, width: visibleWidth(atCursor || " ") };
	}
}
