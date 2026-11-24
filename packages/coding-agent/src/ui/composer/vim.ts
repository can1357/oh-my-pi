/**
 * Modal editing state machine for the composer and dialog text boxes ({@link VimEditor} in
 * `./vim-editor` applies what it decides).
 *
 * Deliberately a *pure* state machine: it reads a snapshot of the buffer and returns the edits it
 * wants applied, so motions can be unit-tested without a terminal and the host keeps sole
 * ownership of undo, atomic chips and the text itself.
 *
 * This is a usable subset of Vim, not a reimplementation of it (see issue #3299): Normal, Visual and
 * Replace modes, the common motions, and operators built from those motions.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type VimMode = "insert" | "normal" | "visual" | "visual-line" | "replace";

/** `g~`/`gu`/`gU` are Vim's case operators: toggle, lower, upper. */
export type VimOperator = "d" | "y" | "c" | ">" | "<" | "g~" | "gu" | "gU";

export type VimCaseMode = "toggle" | "lower" | "upper";

export interface VimPosition {
	line: number;
	col: number;
}

/** Read-only view of the editor buffer that motions resolve against. */
export interface VimBuffer {
	readonly lines: readonly string[];
	readonly cursorLine: number;
	readonly cursorCol: number;
}

/**
 * Where `count` screen rows down (negative: up) from the cursor lands on the editor's wrapped
 * layout, keeping the screen column as `gj`/`gk` do; null when the cursor cannot move at all.
 */
export type VimScreenMove = (count: number) => VimPosition | null;

/**
 * An edit the editor should apply. `to` is always an *exclusive* end offset, so ranges compose the
 * same way regardless of whether the originating motion was inclusive (`e`) or exclusive (`w`).
 */
export type VimCommand =
	| { kind: "move"; to: VimPosition }
	| { kind: "mode"; mode: VimMode }
	/** `register` is the `"x` prefix the command was typed with, if any. */
	| { kind: "yank"; from: VimPosition; to: VimPosition; linewise: boolean; register?: string }
	| { kind: "delete"; from: VimPosition; to: VimPosition; linewise: boolean; insert: boolean; register?: string }
	| { kind: "openLine"; below: boolean }
	/** `gp`/`gP` leave the cursor just past the put text instead of on it. */
	| { kind: "paste"; after: boolean; count: number; cursorAfter: boolean; register?: string }
	/** Visual `p`/`P`: swap the selection for the register; `P` keeps the register as it was. */
	| {
			kind: "visualPut";
			from: VimPosition;
			to: VimPosition;
			linewise: boolean;
			keepRegister: boolean;
			register?: string;
	  }
	/** `u` / `Ctrl-R`: step `count` changes back or forward. */
	| { kind: "undo"; count: number }
	| { kind: "redo"; count: number }
	| { kind: "replace"; from: VimPosition; to: VimPosition; text: string }
	| { kind: "case"; from: VimPosition; to: VimPosition; linewise: boolean; mode: VimCaseMode }
	/** `J` normalizes the whitespace at each seam; `gJ` (`spaces: false`) concatenates as is. */
	| { kind: "join"; fromLine: number; lines: number; spaces: boolean }
	| { kind: "indent"; fromLine: number; toLine: number; out: boolean }
	| { kind: "retype"; record: VimInsertRecord; times: number; newline: boolean; overwrite: boolean }
	/** `3ifoo<Esc>`: type the session that just ended `times` more times (`newline` for `o`/`O`). */
	| { kind: "insertRepeat"; times: number; newline: boolean }
	/** `/` and `?`: open the host's prompt-history search (`Ctrl+R`'s), as a shell's vi mode does. */
	| { kind: "historySearch" }
	/** `:` on an empty prompt: type `/` in Insert mode, so the host's slash-command menu opens. */
	| { kind: "commandLine" }
	/** `k`/`j` (and `-`/`+`) with no line left above or below: step `count` prompts through history, as zsh's vi mode. */
	| { kind: "historyStep"; older: boolean; count: number };

/** What an Insert/Replace session typed, relative to where it started; `.` replays it. */
export interface VimInsertRecord {
	/** Graphemes removed before the session's start cursor (Backspace past the insert point). */
	deleteBefore: number;
	/** Graphemes removed after it (forward delete). */
	deleteAfter: number;
	text: string;
}

const cursorOf = (buf: VimBuffer): VimPosition => ({ line: buf.cursorLine, col: buf.cursorCol });

/** Start offset of the grapheme after `col`, clamped to `text.length`. */
export function nextGraphemeStart(text: string, col: number): number {
	if (col >= text.length) return text.length;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= col) return Math.min(seg.index + seg.segment.length, text.length);
	}
	return text.length;
}

/** Start offset of the grapheme before `col`, clamped to 0. */
export function prevGraphemeStart(text: string, col: number): number {
	if (col <= 0) return 0;
	let last = 0;
	for (const seg of segmenter.segment(text)) {
		if (seg.index >= col) break;
		last = seg.index;
	}
	return last;
}

/** Offset of the final grapheme — where a Normal-mode cursor rests on a non-empty line. */
export function lastGraphemeStart(text: string): number {
	return prevGraphemeStart(text, text.length);
}

export function countGraphemes(text: string): number {
	let count = 0;
	for (const _ of segmenter.segment(text)) count++;
	return count;
}

/** Offset `count` graphemes forward or backward from `offset`, clamped to the text. */
export function stepGraphemes(text: string, offset: number, count: number, forward: boolean): number {
	if (count <= 0) return offset;
	const boundaries: number[] = [];
	for (const seg of segmenter.segment(text)) boundaries.push(seg.index);
	boundaries.push(text.length);
	let i = 0;
	while (i + 1 < boundaries.length && boundaries[i + 1]! <= offset) i++;
	const last = boundaries.length - 1;
	if (forward) return boundaries[Math.min(i + count, last)]!;
	return boundaries[Math.max(i - count + (boundaries[i]! < offset ? 1 : 0), 0)]!;
}

/**
 * What a session turned `before` into, anchored at its start `cursor`: the prefix match stops at the
 * cursor and the suffix match never crosses it, so typing `aa` before an existing `a` records `aa`
 * at the cursor rather than after the old one. Comparisons are whole graphemes, so a shared high
 * surrogate cannot split an emoji into the replayed text.
 */
export function diffInsertSession(before: string, cursor: number, after: string): VimInsertRecord {
	const beforeBounds = graphemeBoundaries(before);
	const afterBounds = graphemeBoundaries(after);
	let cursorBound = 0;
	while (cursorBound + 1 < beforeBounds.length && beforeBounds[cursorBound + 1]! <= cursor) cursorBound++;

	let prefix = 0;
	while (
		prefix < cursorBound &&
		prefix + 1 < afterBounds.length &&
		before.slice(beforeBounds[prefix]!, beforeBounds[prefix + 1]!) ===
			after.slice(afterBounds[prefix]!, afterBounds[prefix + 1]!)
	) {
		prefix++;
	}

	const beforeEnd = beforeBounds.length - 1;
	const afterEnd = afterBounds.length - 1;
	let suffix = 0;
	while (
		beforeEnd - suffix > cursorBound &&
		afterEnd - suffix > prefix &&
		before.slice(beforeBounds[beforeEnd - suffix - 1]!, beforeBounds[beforeEnd - suffix]!) ===
			after.slice(afterBounds[afterEnd - suffix - 1]!, afterBounds[afterEnd - suffix]!)
	) {
		suffix++;
	}

	return {
		deleteBefore: cursorBound - prefix,
		deleteAfter: beforeEnd - suffix - cursorBound,
		text: after.slice(afterBounds[prefix]!, afterBounds[afterEnd - suffix]!),
	};
}

/** Inclusive start offsets plus `text.length`, one entry per grapheme boundary. */
function graphemeBoundaries(text: string): number[] {
	const bounds = [0];
	for (const seg of segmenter.segment(text)) {
		const end = seg.index + seg.segment.length;
		if (end !== bounds[bounds.length - 1]) bounds.push(end);
	}
	if (bounds[bounds.length - 1] !== text.length) bounds.push(text.length);
	return bounds;
}

/** Vim's `skipwhite`: the first non-blank, or the end of an all-blank line (Normal mode clamps it). */
export function firstNonBlank(text: string): number {
	for (const seg of segmenter.segment(text)) {
		if (seg.segment.trim() !== "") return seg.index;
	}
	return text.length;
}

function findPendingKey(pending: { forward: boolean; till: boolean } | null): string {
	if (!pending) return "";
	return pending.till ? (pending.forward ? "t" : "T") : pending.forward ? "f" : "F";
}

/**
 * Column of the `count`th grapheme equal to `target`, searching strictly after `fromCol` when
 * `forward` and strictly before it otherwise. Line-local, like Vim's `f`/`F`.
 */
function findGrapheme(text: string, fromCol: number, target: string, forward: boolean, count: number): number | null {
	if (count < 1 || target.length === 0) return null;
	const segs = [...segmenter.segment(text)];
	let here = -1;
	for (let i = 0; i < segs.length; i++) {
		if (segs[i]!.index <= fromCol) here = i;
		else break;
	}
	let seen = 0;
	if (forward) {
		for (let i = here + 1; i < segs.length; i++) {
			if (segs[i]!.segment === target && ++seen === count) return segs[i]!.index;
		}
	} else {
		for (let i = here - 1; i >= 0; i--) {
			if (segs[i]!.segment === target && ++seen === count) return segs[i]!.index;
		}
	}
	return null;
}

/** End-exclusive span an `iw`/`a(`-style text object resolves to. */
interface TextObjectRange {
	from: VimPosition;
	to: VimPosition;
	linewise: boolean;
}

/** `0` whitespace, `1` keyword, `2` punctuation — the classes `w` groups by (`W` folds 2 into 1). */
function charClass(ch: string, big: boolean): 0 | 1 | 2 {
	if (/\s/.test(ch)) return 0;
	if (big || /[\p{L}\p{N}_]/u.test(ch)) return 1;
	return 2;
}

interface Chunk {
	start: number;
	end: number;
	space: boolean;
}

/** Split a line into maximal same-class runs — the atoms a counted `iw`/`aw` walks over. */
function chunkLine(text: string, big: boolean): Chunk[] {
	const chunks: Chunk[] = [];
	let i = 0;
	while (i < text.length) {
		const cls = charClass(text.charAt(i), big);
		let j = i + 1;
		while (j < text.length && charClass(text.charAt(j), big) === cls) j++;
		chunks.push({ start: i, end: j, space: cls === 0 });
		i = j;
	}
	return chunks;
}

/**
 * `iw`/`aw`/`iW`/`aW`, line-local like Vim's. `aw` takes the trailing whitespace run, or the
 * leading one when the word ends the line; starting on whitespace instead takes it plus the
 * following word.
 */
function wordObject(text: string, col: number, around: boolean, big: boolean, count: number): [number, number] | null {
	const chunks = chunkLine(text, big);
	if (chunks.length === 0) return null;
	const last = chunks.length - 1;
	let first = chunks.findIndex(chunk => col < chunk.end);
	if (first < 0) first = last;
	let end = first;
	if (!around) {
		end = Math.min(first + count - 1, last);
	} else if (chunks[first]!.space) {
		end = Math.min(first + 2 * count - 1, last);
	} else {
		for (let n = 0; n < count; n++) {
			if (n > 0 && end < last) end++;
			if (end < last && chunks[end + 1]!.space) end++;
		}
		if (!chunks[end]!.space && first > 0 && chunks[first - 1]!.space) first--;
	}
	return [chunks[first]!.start, chunks[end]!.end];
}

/**
 * `i"`/`a"` and friends, line-local like Vim's: quotes pair off left to right, and the cursor
 * selects the first pair that ends at or after it. `a` swallows the trailing whitespace, or the
 * leading run when there is none.
 */
function quoteObject(text: string, col: number, quote: string, around: boolean): [number, number] | null {
	const marks = quoteMarks(text, quote);
	for (let p = 0; p + 1 < marks.length; p += 2) {
		const open = marks[p]!;
		const close = marks[p + 1]!;
		if (col > close) continue;
		if (!around) return [open + 1, close];
		let end = close + 1;
		let start = open;
		while (end < text.length && /\s/.test(text.charAt(end))) end++;
		if (end === close + 1) while (start > 0 && /\s/.test(text.charAt(start - 1))) start--;
		return [start, end];
	}
	return null;
}

/** Buffer flattened to one string plus the cursor's offset in it, so scans can cross lines. */
export function flatten(buf: VimBuffer): { text: string; cursor: number } {
	let cursor = buf.cursorCol;
	for (let i = 0; i < buf.cursorLine; i++) cursor += (buf.lines[i] ?? "").length + 1;
	return { text: buf.lines.join("\n"), cursor };
}

export function offsetToPos(lines: readonly string[], offset: number): VimPosition {
	let remaining = offset;
	for (let line = 0; line < lines.length; line++) {
		const width = (lines[line] ?? "").length;
		if (remaining <= width) return { line, col: remaining };
		remaining -= width + 1;
	}
	const line = Math.max(0, lines.length - 1);
	return { line, col: (lines[line] ?? "").length };
}

/**
 * `i(`/`a{`… — the innermost pair enclosing the cursor, counting nesting and spanning lines, or the
 * next pair ahead when none encloses it. A cursor sitting on either delimiter counts as being on
 * that pair. Charwise in both variants; Vim's linewise-ish `i{` reshaping is deliberately not
 * reproduced.
 */
function bracketObject(buf: VimBuffer, open: string, close: string, around: boolean): TextObjectRange | null {
	const { text, cursor } = flatten(buf);
	let depth = 0;
	let openAt = -1;
	for (let i = Math.min(cursor, text.length - 1); i >= 0; i--) {
		const ch = text.charAt(i);
		if (ch === close && i !== cursor) depth++;
		else if (ch === open) {
			if (depth === 0) {
				openAt = i;
				break;
			}
			depth--;
		}
	}
	if (openAt < 0) {
		// Vim 9.2: outside any pair, the first unclosed opener after the cursor, any line ahead.
		depth = 0;
		for (let i = cursor + 1; i < text.length; i++) {
			const ch = text.charAt(i);
			if (ch === close) depth++;
			else if (ch === open) {
				if (depth === 0) {
					openAt = i;
					break;
				}
				depth--;
			}
		}
	}
	if (openAt < 0) return null;
	depth = 0;
	let closeAt = -1;
	for (let i = openAt + 1; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === open) depth++;
		else if (ch === close) {
			if (depth === 0) {
				closeAt = i;
				break;
			}
			depth--;
		}
	}
	if (closeAt < 0) return null;
	const from = offsetToPos(buf.lines, around ? openAt : openAt + 1);
	const to = offsetToPos(buf.lines, around ? closeAt + 1 : closeAt);
	return { from, to, linewise: false };
}

/**
 * `ip`/`ap`: the run of lines matching the cursor line's blankness. `ap` also takes the run that
 * follows, or the one before it when the paragraph ends the buffer. Always linewise.
 */
function paragraphObject(buf: VimBuffer, around: boolean): TextObjectRange {
	const last = buf.lines.length - 1;
	const blank = (line: number): boolean => (buf.lines[line] ?? "").trim() === "";
	const target = blank(buf.cursorLine);
	let first = buf.cursorLine;
	let end = buf.cursorLine;
	while (first > 0 && blank(first - 1) === target) first--;
	while (end < last && blank(end + 1) === target) end++;
	if (around) {
		const stop = end;
		while (end < last && blank(end + 1) !== target) end++;
		if (end === stop) while (first > 0 && blank(first - 1) !== target) first--;
	}
	return { from: { line: first, col: 0 }, to: { line: end, col: (buf.lines[end] ?? "").length }, linewise: true };
}

const BRACKET_MATCH: Record<string, { mate: string; forward: boolean }> = {
	"(": { mate: ")", forward: true },
	")": { mate: "(", forward: false },
	"[": { mate: "]", forward: true },
	"]": { mate: "[", forward: false },
	"{": { mate: "}", forward: true },
	"}": { mate: "{", forward: false },
};

/** Quote columns, skipping a backslash and the character after it, same as `i"`/`a"`. */
function quoteMarks(text: string, quote: string): number[] {
	const marks: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\\") i++;
		else if (text.charAt(i) === quote) marks.push(i);
	}
	return marks;
}

function quoteMate(marks: readonly number[], col: number): number | null {
	for (let p = 0; p + 1 < marks.length; p += 2) {
		const open = marks[p]!;
		const close = marks[p + 1]!;
		if (col === open) return close;
		if (col === close) return open;
	}
	return null;
}

/** Column of the match for `%`: the next bracket or quote on this line, then its pair. */
function matchDelimiter(buf: VimBuffer): VimPosition | null {
	const line = buf.lines[buf.cursorLine] ?? "";
	const quotes = {
		'"': quoteMarks(line, '"'),
		"'": quoteMarks(line, "'"),
	};
	const quoteAt = (col: number): '"' | "'" | null =>
		quotes['"'].includes(col) ? '"' : quotes["'"].includes(col) ? "'" : null;
	let col = buf.cursorCol;
	while (col < line.length && BRACKET_MATCH[line.charAt(col)] === undefined && quoteAt(col) === null) col++;
	const quote = quoteAt(col);
	if (quote) {
		const mate = quoteMate(quotes[quote], col);
		return mate === null ? null : { line: buf.cursorLine, col: mate };
	}
	const spec = BRACKET_MATCH[line.charAt(col)];
	if (!spec) return null;
	const { text, cursor } = flatten({ lines: buf.lines, cursorLine: buf.cursorLine, cursorCol: col });
	const open = spec.forward ? line.charAt(col) : spec.mate;
	const close = spec.forward ? spec.mate : line.charAt(col);
	let depth = 0;
	let match = -1;
	if (spec.forward) {
		for (let i = cursor + 1; i < text.length; i++) {
			const ch = text.charAt(i);
			if (ch === open) depth++;
			else if (ch === close) {
				if (depth === 0) {
					match = i;
					break;
				}
				depth--;
			}
		}
	} else {
		for (let i = cursor - 1; i >= 0; i--) {
			const ch = text.charAt(i);
			if (ch === close) depth++;
			else if (ch === open) {
				if (depth === 0) {
					match = i;
					break;
				}
				depth--;
			}
		}
	}
	return match < 0 ? null : offsetToPos(buf.lines, match);
}

function isParagraphBlank(lines: readonly string[], line: number): boolean {
	return (lines[line] ?? "").trim() === "";
}

/** Line `{`/`}` land on. A missing boundary stays on the first or last line. */
function paragraphBoundary(lines: readonly string[], line: number, forward: boolean): number {
	const last = lines.length - 1;
	if (last < 0) return 0;
	let i = Math.max(0, Math.min(line, last));
	if (forward) {
		if (i < last && !isParagraphBlank(lines, i)) {
			while (i < last && !isParagraphBlank(lines, i + 1)) i++;
			return i < last ? i + 1 : last;
		}
		while (i < last && isParagraphBlank(lines, i)) i++;
		while (i < last && !isParagraphBlank(lines, i)) i++;
		return i;
	}
	if (i > 0 && !isParagraphBlank(lines, i)) {
		while (i > 0 && !isParagraphBlank(lines, i - 1)) i--;
		return i > 0 ? i - 1 : 0;
	}
	while (i > 0 && isParagraphBlank(lines, i)) i--;
	while (i > 0 && !isParagraphBlank(lines, i - 1)) i--;
	return i > 0 ? i - 1 : 0;
}

interface Motion {
	to: VimPosition;
	/** Inclusive motions cover the grapheme under `to` when used with an operator. */
	inclusive: boolean;
	linewise: boolean;
}

/** Commands whose count repeats the typed text rather than a motion (`3.` after `ifoo` → `foofoofoo`). */
const INSERT_KEYS: Record<string, true> = { i: true, a: true, I: true, A: true, o: true, O: true, R: true };
const EDIT_KINDS: Partial<Record<VimCommand["kind"], true>> = {
	delete: true,
	replace: true,
	join: true,
	indent: true,
	paste: true,
	openLine: true,
	case: true,
};
/** Visual keys that act on whole lines even from a charwise selection, as Vim's do. */
const VISUAL_LINE_KEYS: Partial<Record<string, true>> = { X: true, D: true, Y: true, C: true, S: true, R: true };
/** Visual keys that delete the selection and enter Insert. */
const VISUAL_CHANGE_KEYS: Partial<Record<string, true>> = { c: true, s: true, S: true, C: true, R: true };
/** The operator each Visual edit key applies (`>`/`<`/`J` are handled before this). */
const VISUAL_OPERATORS: Partial<Record<string, VimOperator>> = {
	y: "y",
	Y: "y",
	d: "d",
	x: "d",
	X: "d",
	D: "d",
	c: "c",
	s: "c",
	S: "c",
	C: "c",
	R: "c",
	u: "gu",
	U: "gU",
	"~": "g~",
};
const EMPTY_RECORD: VimInsertRecord = { deleteBefore: 0, deleteAfter: 0, text: "" };

/**
 * The last change `.` repeats. Normal-mode changes replay their keys so motions and text objects
 * re-resolve at the new cursor; Visual changes replay the selection's shape, as Vim does.
 */
type VimChange =
	| { kind: "keys"; keys: string[]; count: number | null; insert: VimInsertRecord | null }
	| {
			kind: "visual";
			key: string;
			linewise: boolean;
			lines: number;
			graphemes: number;
			endCol: number;
			insert: VimInsertRecord | null;
	  };

/**
 * Vim's `cls()`: 0 blank (end of line counts), 1 punctuation, 2 keyword, 3 emoji. WORD motions
 * (`W`/`B`/`E`) fold every non-blank into 1, so only whitespace separates.
 */
function vimClass(grapheme: string | undefined, big: boolean): number {
	if (grapheme === undefined || /^\s+$/u.test(grapheme)) return 0;
	if (big) return 1;
	if (/^[\p{L}\p{N}\p{M}_]/u.test(grapheme)) return 2;
	if (/\p{Extended_Pictographic}/u.test(grapheme)) return 3;
	return 1;
}

/**
 * A position stepping like Vim's `inc()`/`dec()`: one grapheme at a time, with the end of each line
 * (`col === length`, Vim's NUL) as a stop of its own between the last grapheme and the next line.
 */
class VimWalker {
	line: number;
	col: number;
	/** Grapheme starts of the current line plus its length; `col === #bounds[#at]`. */
	#bounds: number[];
	#at: number;

	constructor(
		readonly lines: readonly string[],
		from: VimPosition,
	) {
		this.line = from.line;
		this.#bounds = graphemeBoundaries(this.text);
		let at = 0;
		while (at + 1 < this.#bounds.length && this.#bounds[at + 1]! <= from.col) at++;
		this.#at = at;
		this.col = this.#bounds[at]!;
	}

	get text(): string {
		return this.lines[this.line] ?? "";
	}

	get pos(): VimPosition {
		return { line: this.line, col: this.col };
	}

	/** True on an empty line, where `w`/`b`/`ge` stop as if it were a word. */
	get onEmptyLine(): boolean {
		return this.col === 0 && this.text.length === 0;
	}

	cls(big: boolean): number {
		const text = this.text;
		if (this.col >= text.length) return 0;
		return vimClass(text.slice(this.col, this.#bounds[this.#at + 1]!), big);
	}

	/** `inc()`: 0 moved within the line, 2 moved onto its end, 1 wrapped to the next line, -1 at the buffer end. */
	inc(): number {
		const length = this.text.length;
		if (this.col < length) {
			this.col = this.#bounds[++this.#at]!;
			return this.col < length ? 0 : 2;
		}
		if (this.line >= this.lines.length - 1) return -1;
		this.line++;
		this.#bounds = graphemeBoundaries(this.text);
		this.#at = 0;
		this.col = 0;
		return 1;
	}

	/** `dec()`: 0 moved within the line, 1 wrapped onto the end of the previous line, -1 at the buffer start. */
	dec(): number {
		if (this.col > 0) {
			this.col = this.#bounds[--this.#at]!;
			return 0;
		}
		if (this.line === 0) return -1;
		this.line--;
		this.#bounds = graphemeBoundaries(this.text);
		this.#at = this.#bounds.length - 1;
		this.col = this.#bounds[this.#at]!;
		return 1;
	}
}

/** Vim's `fwd_word()`. `eol` (operators) stops the last word at the end of its line. False at the buffer end. */
function fwdWord(walker: VimWalker, count: number, big: boolean, eol: boolean): boolean {
	while (--count >= 0) {
		const sclass = walker.cls(big);
		const lastLine = walker.line === walker.lines.length - 1;
		let i = walker.inc();
		if (i === -1 || (i >= 1 && lastLine)) return false;
		if (i >= 1 && eol && count === 0) return true;
		if (sclass !== 0) {
			while (walker.cls(big) === sclass) {
				i = walker.inc();
				if (i === -1 || (i >= 1 && eol && count === 0)) return true;
			}
		}
		while (walker.cls(big) === 0) {
			if (walker.onEmptyLine) break;
			i = walker.inc();
			if (i === -1 || (i >= 1 && eol && count === 0)) return true;
		}
	}
	return true;
}

/** Vim's `bck_word()` with `stop` false (`b`/`B`). False when already at the buffer start. */
function bckWord(walker: VimWalker, count: number, big: boolean): boolean {
	while (--count >= 0) {
		if (walker.dec() === -1) return false;
		let finished = false;
		while (walker.cls(big) === 0) {
			if (walker.onEmptyLine) {
				finished = true;
				break;
			}
			if (walker.dec() === -1) return true;
		}
		if (finished) continue;
		const word = walker.cls(big);
		while (walker.cls(big) === word) {
			if (walker.dec() === -1) return true;
		}
		walker.inc();
	}
	return true;
}

/** Vim's `end_word()` (`e`/`E`, `empty` false). `stop` keeps `cw` from leaving a word it already ends on. */
function endWord(walker: VimWalker, count: number, big: boolean, stop: boolean): boolean {
	while (--count >= 0) {
		const sclass = walker.cls(big);
		if (walker.inc() === -1) return false;
		if (walker.cls(big) === sclass && sclass !== 0) {
			while (walker.cls(big) === sclass) if (walker.inc() === -1) return false;
		} else if (!stop || sclass === 0) {
			while (walker.cls(big) === 0) if (walker.inc() === -1) return false;
			const word = walker.cls(big);
			while (walker.cls(big) === word) if (walker.inc() === -1) return false;
		}
		walker.dec();
		stop = false;
	}
	return true;
}

/** Vim's `bckend_word()` (`ge`/`gE`). False when already at the buffer start. */
function bckendWord(walker: VimWalker, count: number, big: boolean): boolean {
	while (--count >= 0) {
		const sclass = walker.cls(big);
		if (walker.dec() === -1) return false;
		if (sclass !== 0) {
			while (walker.cls(big) === sclass) if (walker.dec() === -1) return true;
		}
		while (walker.cls(big) === 0) {
			if (walker.onEmptyLine) break;
			if (walker.dec() === -1) return true;
		}
	}
	return true;
}

/**
 * Largest count a command takes. Beyond it a held digit key would reach
 * Infinity (`parseInt` of 400 nines), and motions and pastes loop count times.
 */
const MAX_COUNT = 99_999;

export class VimState {
	mode: VimMode = "normal";
	/** Fixed end of a Visual selection; the cursor is the moving end. */
	anchor: VimPosition | null = null;

	#count = "";
	#operator: VimOperator | null = null;
	#pendingG = false;
	/** `i` or `a` typed after an operator or in Visual mode — waiting for the object key. */
	#textObject: "i" | "a" | null = null;
	/** `f`/`F`/`t`/`T` waiting for the target grapheme. */
	#findPending: { forward: boolean; till: boolean } | null = null;
	/** Last find attempt, so `;` repeats it and `,` reverses it. */
	#lastFind: { forward: boolean; till: boolean; target: string } | null = null;
	/** `r` waiting for the replacement grapheme. */
	#replaceChar = false;
	/** `"` typed, waiting for the register name; then the named register the command will use. */
	#registerPending = false;
	#register: string | null = null;
	/** `:` opened the Insert session: what it types is a slash command, not a change `.` repeats. */
	#unrecordedInsert = false;
	/** The editor's wrapped-row lookup for `gj`/`gk`; without one they move by lines like `j`/`k`. */
	screenMove: VimScreenMove | null = null;
	/** Whether the host has a slash-command menu for `:` to open; without one `:` does nothing. */
	slashCommands = false;

	/**
	 * Vim's "desired column": `j`/`k` remember the column you started from, so descending through a
	 * short line and back out returns to it instead of collapsing permanently. `null` means the
	 * next vertical motion anchors it to the live cursor column; `Infinity` is `$`'s sticky
	 * end-of-line, which keeps `$j` on the end of each line. Every non-vertical command clears it.
	 */
	#desiredCol: number | null = null;
	/** Keys of the Normal-mode command being typed, count digits excluded. */
	#cmdKeys: string[] = [];
	/** Every count digit typed in that command, in order. */
	#cmdCount = "";
	#lastChange: VimChange | null = null;
	#stagedChange: VimChange | null = null;
	/** Count typed before `i`/`a`/`o`/…: Escape types the session `count - 1` more times, as Vim does. */
	#insertRepeat = 1;
	#insertNewline = false;
	/** Where Insert mode was last left (Vim's `'^` mark), for `gi`. */
	#lastInsertPos: VimPosition | null = null;
	/** The last Visual selection, for `gv`. */
	#lastVisual: { mode: "visual" | "visual-line"; anchor: VimPosition; cursor: VimPosition } | null = null;

	/** Text the last Insert session typed; the editor reads it to apply an `insertRepeat`. */
	get lastInsertText(): string {
		return this.#lastChange?.insert?.text ?? "";
	}

	/** An arrow key split the Insert session; like Vim, the count no longer repeats it. */
	cancelInsertRepeat(): void {
		this.#insertRepeat = 1;
	}

	/** True while a count, operator, `g`, text-object, find, `r`, or `"x` prefix is half-typed — Escape cancels it. */
	get pending(): boolean {
		return this.#commandPending() || this.#registerPending || this.#register !== null;
	}

	/** A count, operator, `g`, text object, find, or `r` is waiting for the key that finishes the command. */
	#commandPending(): boolean {
		return (
			this.#count.length > 0 ||
			this.#operator !== null ||
			this.#pendingG ||
			this.#textObject !== null ||
			this.#findPending !== null ||
			this.#replaceChar
		);
	}

	/** The register a `"x` prefix named for the command being typed, or null. */
	get register(): string | null {
		return this.#register;
	}

	/**
	 * The half-typed command as Vim would echo it (`"2"`, `"d"`, `"2d"`, `"di"`, `"df"`, `"r"`, `"a`) —
	 * empty when nothing is pending. Hosts render this next to the mode so a partially entered operator
	 * is visible instead of silently swallowing the next keystroke.
	 */
	get pendingText(): string {
		const register = this.#registerPending ? '"' : this.#register !== null ? `"${this.#register}` : "";
		return `${register}${this.#count}${this.#operator ?? ""}${this.#pendingG ? "g" : ""}${this.#textObject ?? ""}${findPendingKey(this.#findPending)}${this.#replaceChar ? "r" : ""}`;
	}

	get visual(): boolean {
		return this.mode === "visual" || this.mode === "visual-line";
	}

	/** Start a fresh prompt in `mode`: no selection, nothing half-typed. `.`, registers, finds, and searches carry over. */
	begin(mode: "insert" | "normal"): void {
		this.mode = mode;
		this.anchor = null;
		this.#desiredCol = null;
		this.#clearPending();
		this.#cmdKeys = [];
		this.#cmdCount = "";
		this.#insertRepeat = 1;
		this.#unrecordedInsert = false;
	}

	reset(): void {
		this.mode = "normal";
		this.anchor = null;
		this.#desiredCol = null;
		this.#clearPending();
		this.#lastFind = null;
		this.#cmdKeys = [];
		this.#cmdCount = "";
		this.#lastChange = null;
		this.#stagedChange = null;
		this.#insertRepeat = 1;
		this.#lastInsertPos = null;
		this.#lastVisual = null;
	}

	#currentMode(): VimMode {
		return this.mode;
	}

	/** `0` is the line-start motion unless it extends a count already being typed. */
	#isCountKey(key: string): boolean {
		return (
			!this.#findPending &&
			!this.#replaceChar &&
			!this.#registerPending &&
			((key >= "1" && key <= "9") || (key === "0" && this.#count.length > 0))
		);
	}

	#clearPending(): void {
		this.#count = "";
		this.#operator = null;
		this.#pendingG = false;
		this.#textObject = null;
		this.#findPending = null;
		this.#replaceChar = false;
		this.#registerPending = false;
		this.#register = null;
	}

	#takeCount(): number {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		this.#count = "";
		return Math.max(1, count);
	}

	/** Clamp a position so the Normal-mode cursor rests *on* a grapheme rather than past the last. */
	#clampNormal(buf: VimBuffer, pos: VimPosition): VimPosition {
		const line = Math.max(0, Math.min(pos.line, buf.lines.length - 1));
		const text = buf.lines[line] ?? "";
		return { line, col: Math.max(0, Math.min(pos.col, lastGraphemeStart(text))) };
	}

	/**
	 * Handle one key. `key` is either the literal `"escape"` or a single grapheme; the editor
	 * normalizes arrow/Home/End keys onto their Vim equivalents before calling.
	 *
	 * Returns the commands to apply, or `null` when the key is not ours — the editor then falls
	 * through to its regular handling (and, for Escape in Normal mode, to the app's interrupt).
	 */
	handleKey(key: string, buf: VimBuffer): VimCommand[] | null {
		if (key === "escape") {
			this.#cmdKeys = [];
			this.#cmdCount = "";
			return this.#handleEscape(buf);
		}
		if (this.mode === "insert") return null;
		const recording = this.mode === "normal";
		const dotIsTarget = this.#findPending !== null || this.#replaceChar;
		if (recording) {
			if (this.#isCountKey(key)) this.#cmdCount += key;
			else this.#cmdKeys.push(key);
		}
		const commands = this.#dispatch(key, buf);
		if (recording && !this.pending) {
			// `#dispatch` may have entered Insert; read it afresh, past the narrowing from the early return above.
			const mode = this.#currentMode();
			const editing = mode === "insert" || mode === "replace";
			// `.` is skipped only as the top-level repeat command; as an `f`/`t`/`r` target (`df.`)
			// it completes a recordable edit. `:` types a command, not an edit.
			if (
				commands !== null &&
				(key !== "." || dotIsTarget) &&
				key !== ":" &&
				(editing || commands.some(c => EDIT_KINDS[c.kind] === true))
			) {
				// An Insert-family count (`3ifoo`) repeats the typed text, so `.` keeps it too.
				const change: VimChange = {
					kind: "keys",
					keys: this.#cmdKeys,
					count: this.#cmdCount === "" ? null : Math.min(Number.parseInt(this.#cmdCount, 10), MAX_COUNT),
					insert: null,
				};
				if (editing) {
					this.#lastChange = change;
					this.#stagedChange = null;
				} else {
					this.#stagedChange = change;
				}
			}
			this.#cmdKeys = [];
			this.#cmdCount = "";
		}
		return commands;
	}

	/**
	 * Attach what an Insert/Replace session typed to the change that opened it. After an arrow key
	 * split the session, Vim's redo becomes a plain insert of the text typed since.
	 */
	recordInsert(record: VimInsertRecord, afterArrow: boolean): void {
		if (this.#unrecordedInsert) {
			this.#unrecordedInsert = false;
			return;
		}
		if (afterArrow) {
			this.#lastChange = { kind: "keys", keys: ["i"], count: null, insert: record };
		} else if (this.#lastChange !== null) {
			this.#lastChange = { ...this.#lastChange, insert: record };
		} else if (record.text !== "" || record.deleteBefore > 0 || record.deleteAfter > 0) {
			this.#lastChange = { kind: "keys", keys: ["i"], count: null, insert: record };
		}
	}

	/** Commit a staged change when the editor confirms text changed. */
	commitChange(): void {
		if (this.#stagedChange !== null) {
			this.#lastChange = this.#stagedChange;
			this.#stagedChange = null;
		}
	}

	/** Discard a staged change when the command was a no-op (e.g. `J` on the last line). */
	discardChange(): void {
		this.#stagedChange = null;
	}
	#repeat(buf: VimBuffer, dotCount: number | null): VimCommand[] {
		const change = this.#lastChange;
		if (change === null) return [];
		let commands: VimCommand[];
		let count: number | null = null;
		if (change.kind === "keys") {
			count = dotCount ?? change.count;
			commands = [];
			// Every key but the last only arms a prefix and edits nothing, so one buffer snapshot holds.
			for (const key of count === null ? change.keys : [...String(count), ...change.keys]) {
				commands = this.#dispatch(key, buf) ?? [];
			}
			this.#lastChange = { ...change, count };
		} else {
			commands = this.#repeatVisual(change, buf);
		}
		if (this.mode === "insert" || this.mode === "replace") {
			const insertKey = change.kind === "keys" && INSERT_KEYS[change.keys[0] ?? ""] === true;
			commands.push({
				kind: "retype",
				record: change.insert ?? EMPTY_RECORD,
				times: insertKey ? (count ?? 1) : 1,
				newline: insertKey && change.kind === "keys" && (change.keys[0] === "o" || change.keys[0] === "O"),
				overwrite: this.mode === "replace",
			});
			// The replayed `3i` armed a count repeat; `times` above already covers it.
			this.#insertRepeat = 1;
			this.mode = "normal";
			commands.push({ kind: "mode", mode: "normal" });
		}
		return commands;
	}

	/** Re-applies a Visual change over the same shape starting at the cursor; `.`'s count is ignored. */
	#repeatVisual(change: Extract<VimChange, { kind: "visual" }>, buf: VimBuffer): VimCommand[] {
		const fromLine = buf.cursorLine;
		const toLine = Math.min(fromLine + change.lines - 1, buf.lines.length - 1);
		const lineAt = (line: number) => buf.lines[line] ?? "";
		const cursor = cursorOf(buf);
		let from: VimPosition;
		let to: VimPosition;
		if (change.linewise) {
			from = { line: fromLine, col: 0 };
			to = { line: toLine, col: lineAt(toLine).length };
		} else if (change.lines === 1) {
			from = cursor;
			to = { line: fromLine, col: stepGraphemes(lineAt(fromLine), buf.cursorCol, change.graphemes, true) };
		} else {
			from = cursor;
			// `endCol` was measured on the original last line, so it can land mid-grapheme on a
			// destination line with longer clusters; snap it up to a boundary or a replayed `d`
			// would leave half an emoji behind.
			const text = lineAt(toLine);
			const target = Math.min(change.endCol, text.length);
			let endCol = text.length;
			for (const seg of segmenter.segment(text)) {
				if (seg.index >= target) {
					endCol = seg.index;
					break;
				}
				endCol = seg.index + seg.segment.length;
			}
			to = { line: toLine, col: endCol };
		}
		return this.#visualEdit(change.key, from, to, change.linewise);
	}

	/** `#dispatchKey`, then hand a `"x` prefix to the command that finishes it (Vim drops it otherwise). */
	#dispatch(key: string, buf: VimBuffer): VimCommand[] | null {
		// Captured first: a finishing command clears its pending state, register included.
		const register = this.#register;
		const commands = this.#dispatchKey(key, buf);
		// The key that names the register (`"a`) is not the command it is for.
		if (register === null) return commands;
		if (this.#commandPending() && this.#register !== null) return commands;
		this.#register = null;
		if (commands === null) return null;
		return commands.map(command =>
			command.kind === "yank" ||
			command.kind === "delete" ||
			command.kind === "paste" ||
			command.kind === "visualPut"
				? { ...command, register }
				: command,
		);
	}

	#dispatchKey(key: string, buf: VimBuffer): VimCommand[] | null {
		// The character after `f`/`t` is the target, including digits. Resolve it before the count prefix.
		if (this.#findPending) {
			const spec = this.#findPending;
			this.#findPending = null;
			this.#desiredCol = null;
			this.#lastFind = { ...spec, target: key };
			const count = this.#count.length > 0 ? Math.max(1, Number.parseInt(this.#count, 10)) : 1;
			const motion = this.#seek(key, buf, spec, count);
			if (!motion) {
				this.#operator = null;
				this.#count = "";
				return [];
			}
			return this.#applyMotion(buf, motion);
		}
		if (this.#replaceChar) {
			this.#replaceChar = false;
			if (this.visual) return this.#visualReplace(key, buf);
			const count = this.#count.length > 0 ? Math.max(1, Number.parseInt(this.#count, 10)) : 1;
			const line = buf.lines[buf.cursorLine] ?? "";
			// One segmenter pass: stepping with `nextGraphemeStart` would rescan the line per grapheme.
			let end = -1;
			let taken = 0;
			for (const seg of segmenter.segment(line)) {
				if (seg.index < buf.cursorCol) continue;
				if (++taken === count) {
					end = seg.index + seg.segment.length;
					break;
				}
			}
			this.#count = "";
			if (end < 0) return [];
			return [
				{
					kind: "replace",
					from: { line: buf.cursorLine, col: buf.cursorCol },
					to: { line: buf.cursorLine, col: end },
					text: key.repeat(count),
				},
			];
		}
		if (this.#registerPending) {
			this.#registerPending = false;
			if (!/^[a-zA-Z0-9"\-_+*]$/.test(key)) {
				this.#clearPending();
				return [];
			}
			this.#register = key;
			return [];
		}

		if (this.#isCountKey(key)) {
			this.#count = String(Math.min(Number(this.#count + key), MAX_COUNT));
			return [];
		}

		if (this.#pendingG) {
			this.#pendingG = false;
			return this.#handleGKey(key, buf);
		}

		if (this.#textObject !== null) {
			this.#desiredCol = null;
			return this.#applyTextObject(key, buf);
		}
		// `"x` names the register the next yank, delete, or put uses. After an operator `"` is a
		// text-object or motion key instead (`di"`).
		if (key === '"' && this.#operator === null) {
			this.#registerPending = true;
			return [];
		}

		// `i`/`a` only introduce a text object where they cannot mean "insert": after an operator,
		// or in Visual mode. Bare `i` in Normal mode still enters Insert.
		if ((key === "i" || key === "a") && (this.#operator !== null || this.visual)) {
			this.#textObject = key;
			return [];
		}
		if (key === "f" || key === "F" || key === "t" || key === "T") {
			this.#desiredCol = null;
			this.#findPending = { forward: key === "f" || key === "t", till: key === "t" || key === "T" };
			return [];
		}
		if (this.#operator === null && (key === "r" || (key === "R" && !this.visual))) {
			this.#desiredCol = null;
			if (key === "R") {
				this.#takeCount();
				this.mode = "replace";
				return [{ kind: "mode", mode: "replace" }];
			}
			this.#replaceChar = true;
			return [];
		}

		// Only consecutive `j`/`k` carry the desired column; anything else re-anchors it. Counts and
		// the `g` prefix returned above, so `2j` still continues an established column.
		if (key !== "j" && key !== "k") this.#desiredCol = null;

		// `g` prefixes a second key in Normal and Visual mode alike (`gg`, `gU`, `gJ`, `ge`).
		if (key === "g") {
			this.#pendingG = true;
			return [];
		}
		const motion = this.#resolveMotion(key, buf);
		if (motion) return this.#applyMotion(buf, motion);

		return this.visual ? this.#handleVisualKey(key, buf) : this.#handleNormalKey(key, buf);
	}

	#handleEscape(buf: VimBuffer): VimCommand[] | null {
		if (this.pending) {
			this.#clearPending();
			return [];
		}
		if (this.visual) {
			this.#rememberVisual(buf);
			this.mode = "normal";
			this.anchor = null;
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: this.#clampNormal(buf, cursorOf(buf)) },
			];
		}
		if (this.mode === "insert" || this.mode === "replace") {
			this.mode = "normal";
			this.#lastInsertPos = cursorOf(buf);
			const repeat = this.#insertRepeat;
			this.#insertRepeat = 1;
			// `3ifoo<Esc>`: the copies land where the cursor is; the repeat steps back like Escape does.
			if (repeat > 1) {
				return [
					{ kind: "mode", mode: "normal" },
					{ kind: "insertRepeat", times: repeat - 1, newline: this.#insertNewline },
				];
			}
			const text = buf.lines[buf.cursorLine] ?? "";
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: { line: buf.cursorLine, col: prevGraphemeStart(text, buf.cursorCol) } },
			];
		}
		// Normal mode with nothing pending: leave Escape to the app (interrupt / clear draft).
		return null;
	}

	/** The key after `g`: `gg`, `gj`/`gk`, `ge`/`gE`, the case operators, `gJ`, `gv`, `gi`, `gp`/`gP`. */
	#handleGKey(key: string, buf: VimBuffer): VimCommand[] | null {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		switch (key) {
			case "g": {
				// `gg` goes to the first line (`5gg` to line 5), on its first non-blank like Vim.
				this.#desiredCol = null;
				const line = Math.min(this.#takeCount() - 1, buf.lines.length - 1);
				const to = { line, col: firstNonBlank(buf.lines[line] ?? "") };
				return this.#applyMotion(buf, { to, inclusive: false, linewise: true });
			}
			case "j":
			case "k": {
				// Screen rows of a wrapped line, exclusive and charwise like Vim's `nv_screengo`. A count
				// past the first or last row stops there; only a move that goes nowhere fails.
				if (this.screenMove === null) {
					const motion = this.#resolveMotion(key, buf);
					if (motion === null) break;
					return this.#applyMotion(buf, motion);
				}
				const to = this.screenMove(key === "j" ? count : -count);
				if (to === null) break;
				return this.#applyMotion(buf, { to, inclusive: false, linewise: false });
			}
			case "e":
			case "E": {
				this.#desiredCol = null;
				const walker = new VimWalker(buf.lines, cursorOf(buf));
				if (!bckendWord(walker, count, key === "E") && this.#operator === null) {
					this.#clearPending();
					return [];
				}
				return this.#applyMotion(buf, { to: walker.pos, inclusive: true, linewise: false });
			}
			case "~":
			case "u":
			case "U": {
				if (this.visual) return this.#handleVisualKey(key, buf);
				const op: VimOperator = key === "~" ? "g~" : key === "u" ? "gu" : "gU";
				// `gUgU` is `gUU`: the operator typed again means "this line".
				if (this.#operator === op) return this.#lineOperate(op, buf);
				if (this.#operator !== null) break;
				this.#operator = op;
				return [];
			}
			case "J":
				if (this.#operator !== null) break;
				if (this.visual) return this.#handleVisualKey("gJ", buf);
				return [{ kind: "join", fromLine: buf.cursorLine, lines: Math.max(2, this.#takeCount()), spaces: false }];
			case "v": {
				const last = this.#lastVisual;
				if (this.#operator !== null || this.visual || last === null) break;
				this.#takeCount();
				this.mode = last.mode;
				this.anchor = this.#clampNormal(buf, last.anchor);
				return [
					{ kind: "mode", mode: this.mode },
					{ kind: "move", to: this.#clampNormal(buf, last.cursor) },
				];
			}
			case "i": {
				if (this.#operator !== null || this.visual) break;
				this.#armInsert(key);
				this.mode = "insert";
				const commands: VimCommand[] = [{ kind: "mode", mode: "insert" }];
				const at = this.#lastInsertPos;
				if (at !== null) {
					const line = Math.min(at.line, buf.lines.length - 1);
					commands.push({ kind: "move", to: { line, col: Math.min(at.col, (buf.lines[line] ?? "").length) } });
				}
				return commands;
			}
			case "p":
			case "P":
				if (this.#operator !== null || this.visual) break;
				return [{ kind: "paste", after: key === "p", count: this.#takeCount(), cursorAfter: true }];
		}
		this.#clearPending();
		return [];
	}

	/**
	 * A doubled operator (`dd`, `yy`, `cc`, `>>`, `gUU`): linewise over `count` lines. Like Vim's
	 * `nv_lineop`, the range starts on the first non-blank, which is where `u` brings the cursor
	 * back; `yy` leaves the cursor where it is.
	 */
	#lineOperate(op: VimOperator, buf: VimBuffer): VimCommand[] {
		const span = this.#takeCount();
		const last = Math.min(buf.cursorLine + span - 1, buf.lines.length - 1);
		this.#operator = null;
		const line = buf.lines[buf.cursorLine] ?? "";
		return this.#operate(
			op,
			{ line: buf.cursorLine, col: op === "y" ? buf.cursorCol : firstNonBlank(line) },
			{ line: last, col: (buf.lines[last] ?? "").length },
			true,
		);
	}

	/** `i`/`a`/`o`/…: a count (`3ifoo`) makes Escape type the session again `count - 1` times. */
	#armInsert(key: string): void {
		this.#insertRepeat = this.#takeCount();
		this.#insertNewline = key === "o" || key === "O";
	}

	#rememberVisual(buf: VimBuffer): void {
		if (!this.visual || this.anchor === null) return;
		this.#lastVisual = {
			mode: this.mode === "visual-line" ? "visual-line" : "visual",
			anchor: this.anchor,
			cursor: cursorOf(buf),
		};
	}

	/** Visual `r{char}`: every grapheme in the selection becomes `char`; line breaks stay. */
	#visualReplace(char: string, buf: VimBuffer): VimCommand[] {
		const { from, to } = visualRange(buf, this.anchor ?? cursorOf(buf), this.mode === "visual-line");
		this.#rememberVisual(buf);
		this.#clearPending();
		this.anchor = null;
		this.mode = "normal";
		const commands: VimCommand[] = [];
		for (let line = from.line; line <= to.line; line++) {
			const text = buf.lines[line] ?? "";
			const start = line === from.line ? from.col : 0;
			const end = line === to.line ? Math.min(to.col, text.length) : text.length;
			if (end <= start) continue;
			commands.push({
				kind: "replace",
				from: { line, col: start },
				to: { line, col: end },
				text: char.repeat(countGraphemes(text.slice(start, end))),
			});
		}
		commands.push({ kind: "mode", mode: "normal" }, { kind: "move", to: from });
		return commands;
	}

	#resolveMotion(key: string, buf: VimBuffer): Motion | null {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		const line = buf.lines[buf.cursorLine] ?? "";
		const at = (col: number): VimPosition => ({ line: buf.cursorLine, col });

		if (key === " ") key = "l";

		switch (key) {
			case "h": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = prevGraphemeStart(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "l": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = nextGraphemeStart(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "j":
			case "k": {
				const delta = key === "j" ? count : -count;
				// Vim's `cursor_down`/`cursor_up` fail only when already on the edge line, so `dk` on the
				// first line deletes nothing while `5k` from the third line still reaches the top.
				if (buf.cursorLine === (delta > 0 ? buf.lines.length - 1 : 0)) return null;
				const target = Math.max(0, Math.min(buf.cursorLine + delta, buf.lines.length - 1));
				// Anchor the desired column on the first vertical move, then keep reusing it. The host
				// clamps the target to each line's length, so short lines en route never shrink it.
				this.#desiredCol ??= buf.cursorCol;
				return { to: { line: target, col: this.#desiredCol }, inclusive: false, linewise: true };
			}
			case "0":
				return { to: at(0), inclusive: false, linewise: false };
			case "^":
				return { to: at(firstNonBlank(line)), inclusive: false, linewise: false };
			case "$": {
				// Sticky end-of-line, so `$j` lands on the end of each line rather than a fixed column.
				// A count reaches `count - 1` lines down, so `2D` (Vim's `2d$`) ends on the next line.
				this.#desiredCol = Number.POSITIVE_INFINITY;
				const target = Math.min(buf.cursorLine + count - 1, buf.lines.length - 1);
				return { to: { line: target, col: (buf.lines[target] ?? "").length }, inclusive: false, linewise: false };
			}
			case "-":
			case "+":
			case "_": {
				// Vim's `nv_up`/`nv_down`/`nv_lineop`: linewise, landing on the first non-blank.
				// `_` moves `count - 1` lines down, so `d_` is `dd` and `c_` is `cc`.
				const delta = key === "-" ? -count : key === "+" ? count : count - 1;
				if (delta !== 0 && buf.cursorLine === (delta > 0 ? buf.lines.length - 1 : 0)) return null;
				const target = Math.max(0, Math.min(buf.cursorLine + delta, buf.lines.length - 1));
				return {
					to: { line: target, col: firstNonBlank(buf.lines[target] ?? "") },
					inclusive: false,
					linewise: true,
				};
			}
			case "w":
			case "W":
			case "e":
			case "E":
				return this.#wordMotion(key, buf, count);
			case "b":
			case "B": {
				const walker = new VimWalker(buf.lines, cursorOf(buf));
				if (!bckWord(walker, count, key === "B") && this.#operator === null) return null;
				return { to: walker.pos, inclusive: false, linewise: false };
			}
			case "%": {
				// `{count}%` jumps to that percentage of the buffer, linewise, like Vim.
				if (this.#count.length > 0) {
					if (count > 100) return null;
					const target = Math.max(0, Math.floor((count * buf.lines.length + 99) / 100) - 1);
					const text = buf.lines[target] ?? "";
					return { to: { line: target, col: firstNonBlank(text) }, inclusive: false, linewise: true };
				}
				const to = matchDelimiter(buf);
				return to === null ? null : { to, inclusive: true, linewise: false };
			}
			case "{":
			case "}": {
				let line = buf.cursorLine;
				for (let n = 0; n < count; n++) {
					const next = paragraphBoundary(buf.lines, line, key === "}");
					if (next === line) break;
					line = next;
				}
				const text = buf.lines[line] ?? "";
				// No blank line ahead: Vim parks at the end of the buffer, not column 0. A bare move
				// clamps back onto the last grapheme; an operator still covers the rest of the line.
				const atBufferEnd = key === "}" && line === buf.lines.length - 1 && text.trim() !== "";
				return { to: { line, col: atBufferEnd ? text.length : 0 }, inclusive: false, linewise: false };
			}
			case "G": {
				// Like Vim with 'startofline', `G` lands on the target line's first non-blank.
				const target = Math.max(
					0,
					Math.min(this.#count.length > 0 ? count - 1 : buf.lines.length - 1, buf.lines.length - 1),
				);
				return {
					to: { line: target, col: firstNonBlank(buf.lines[target] ?? "") },
					inclusive: false,
					linewise: true,
				};
			}
			case ";":
			case ",":
				return this.#repeatFind(key === ";", buf, count);
			default:
				return null;
		}
	}

	/**
	 * Vim's `nv_wordcmd` for `w`/`W`/`e`/`E`. `cw` on a non-blank acts like `ce` but stays on the
	 * word it already ends on; an operator's last `w` stops at the end of its line.
	 */
	#wordMotion(key: "w" | "W" | "e" | "E", buf: VimBuffer, count: number): Motion | null {
		const big = key === "W" || key === "E";
		let wordEnd = key === "e" || key === "E";
		let inclusive = wordEnd;
		let stop = false;
		const line = buf.lines[buf.cursorLine] ?? "";
		if (
			!wordEnd &&
			this.#operator === "c" &&
			buf.cursorCol < line.length &&
			!/^\s/u.test(line.slice(buf.cursorCol))
		) {
			inclusive = true;
			wordEnd = true;
			stop = true;
		}
		const walker = new VimWalker(buf.lines, cursorOf(buf));
		const ok = wordEnd ? endWord(walker, count, big, stop) : fwdWord(walker, count, big, this.#operator !== null);
		if (!ok && this.#operator === null) return null;
		let to = walker.pos;
		// Vim's `adjust_cursor`: a forward move must not rest on the end of a line, so it backs onto the
		// last grapheme and covers it.
		const landed = buf.lines[to.line] ?? "";
		const moved = to.line > buf.cursorLine || (to.line === buf.cursorLine && to.col > buf.cursorCol);
		if (moved && to.col > 0 && to.col >= landed.length && !this.visual) {
			to = { line: to.line, col: prevGraphemeStart(landed, to.col) };
			inclusive = true;
		}
		return { to, inclusive, linewise: false };
	}

	#repeatFind(sameDirection: boolean, buf: VimBuffer, count: number): Motion | null {
		const last = this.#lastFind;
		if (!last) return null;
		const forward = sameDirection ? last.forward : !last.forward;
		const text = buf.lines[buf.cursorLine] ?? "";
		// A till lands beside its target, so repeating from the cursor rediscovers that same target.
		const fromCol = last.till
			? forward
				? nextGraphemeStart(text, buf.cursorCol)
				: prevGraphemeStart(text, buf.cursorCol)
			: buf.cursorCol;
		return this.#seek(last.target, buf, { forward, till: last.till }, count, fromCol);
	}

	/**
	 * `f`/`F` land on the match and include it. `t`/`T` land on the adjacent grapheme and include
	 * that grapheme, so the operator stops short of the target. A till that would not move fails.
	 */
	#seek(
		target: string,
		buf: VimBuffer,
		spec: { forward: boolean; till: boolean },
		count: number,
		fromCol = buf.cursorCol,
	): Motion | null {
		const text = buf.lines[buf.cursorLine] ?? "";
		const match = findGrapheme(text, fromCol, target, spec.forward, count);
		if (match === null) return null;
		const land = spec.till ? (spec.forward ? prevGraphemeStart(text, match) : nextGraphemeStart(text, match)) : match;
		if (land === buf.cursorCol) return null;
		return { to: { line: buf.cursorLine, col: land }, inclusive: true, linewise: false };
	}

	/** Turn a resolved motion into either a cursor move, a selection extension, or an operator range. */
	#applyMotion(buf: VimBuffer, motion: Motion): VimCommand[] {
		const operator = this.#operator;
		this.#operator = null;
		this.#takeCount();
		if (operator === ">" || operator === "<") {
			const fromLine = Math.min(buf.cursorLine, motion.to.line);
			const toLine = Math.max(buf.cursorLine, motion.to.line);
			return [{ kind: "indent", fromLine, toLine, out: operator === "<" }];
		}

		if (operator === null) {
			// Normal mode parks on the last grapheme. Visual mode does too, except after `$`, whose
			// selection runs through the line break like Vim's. Replace mode may sit past the end, so
			// typing there appends instead of overwriting the last grapheme.
			const text = buf.lines[motion.to.line] ?? "";
			const pastEnd = this.mode === "replace" || (this.visual && this.#desiredCol === Number.POSITIVE_INFINITY);
			const to = pastEnd
				? { line: motion.to.line, col: Math.min(motion.to.col, text.length) }
				: this.#clampNormal(buf, motion.to);
			return [{ kind: "move", to }];
		}
		// An operator re-anchors the desired column, as Vim's does: `D` then `j` keeps no `$` stickiness.
		this.#desiredCol = null;

		const from: VimPosition = { line: buf.cursorLine, col: buf.cursorCol };
		let start = from;
		let end = motion.to;
		if (end.line < start.line || (end.line === start.line && end.col < start.col)) [start, end] = [end, start];
		let linewise = motion.linewise;
		// Only blanks before the start: Vim's `inindent()`, which decides when a span becomes linewise.
		const startInIndent = /^\s*$/u.test((buf.lines[start.line] ?? "").slice(0, start.col));
		// Vim's `do_pending_operator`: an exclusive motion ending in column 0 of a later line stops at
		// the end of the line before, and covers whole lines when it started in the indent (`d}`, `dw`).
		if (!linewise && !motion.inclusive && end.col === 0 && end.line > start.line) {
			const prev = end.line - 1;
			end = { line: prev, col: (buf.lines[prev] ?? "").length };
			if (startInIndent) linewise = true;
		}
		if (motion.inclusive) {
			const text = buf.lines[end.line] ?? "";
			end = { line: end.line, col: nextGraphemeStart(text, end.col) };
		}
		// Vim's `op_delete`: a multi-line delete that leaves only blanks behind on both ends is linewise.
		if (
			operator === "d" &&
			!linewise &&
			end.line > start.line &&
			startInIndent &&
			/^\s*$/u.test((buf.lines[end.line] ?? "").slice(end.col))
		) {
			linewise = true;
		}
		return this.#operate(operator, start, end, linewise);
	}

	#operate(operator: VimOperator, from: VimPosition, to: VimPosition, linewise: boolean): VimCommand[] {
		if (operator === ">" || operator === "<") {
			const fromLine = Math.min(from.line, to.line);
			const toLine = Math.max(from.line, to.line);
			return [{ kind: "indent", fromLine, toLine, out: operator === "<" }];
		}
		if (operator === "y") {
			return [
				{ kind: "yank", from, to, linewise },
				{ kind: "move", to: from },
			];
		}
		if (operator === "g~" || operator === "gu" || operator === "gU") {
			const mode = operator === "gU" ? "upper" : operator === "gu" ? "lower" : "toggle";
			// Vim leaves the cursor on the start of the changed text.
			return [
				{ kind: "move", to: from },
				{ kind: "case", from, to, linewise, mode },
			];
		}
		if (operator !== "c") {
			// Vim parks the cursor on the range start before deleting, which is where `u` returns to.
			return [
				{ kind: "move", to: from },
				{ kind: "delete", from, to, linewise, insert: false },
			];
		}
		// `c` always lands in Insert mode. The leading move matters when the range is empty
		// (`ci"` between bare quotes): the delete is a no-op, so nothing else would park the cursor.
		this.mode = "insert";
		if (linewise) {
			// `cc`/`cj`/`S`: like Vim's `op_delete` for a linewise change, the lines go to the register
			// whole but one empty line stays behind to type into, whatever column the cursor was on.
			const start = { line: from.line, col: 0 };
			return [
				{ kind: "move", to: start },
				{ kind: "delete", from: start, to, linewise: true, insert: true },
				{ kind: "mode", mode: "insert" },
			];
		}
		return [
			{ kind: "move", to: from },
			{ kind: "delete", from, to, linewise: false, insert: true },
			{ kind: "mode", mode: "insert" },
		];
	}

	/** `iw`, `a(`, `i"`, `ap`, … — resolved around the cursor rather than from a motion endpoint. */
	#resolveTextObject(key: string, around: boolean, buf: VimBuffer, count: number): TextObjectRange | null {
		const line = buf.lines[buf.cursorLine] ?? "";
		const onLine = (range: [number, number] | null): TextObjectRange | null =>
			range === null
				? null
				: {
						from: { line: buf.cursorLine, col: range[0] },
						to: { line: buf.cursorLine, col: range[1] },
						linewise: false,
					};

		switch (key) {
			case "w":
			case "W":
				return onLine(wordObject(line, buf.cursorCol, around, key === "W", count));
			case '"':
			case "'":
			case "`":
				return onLine(quoteObject(line, buf.cursorCol, key, around));
			case "(":
			case ")":
			case "b":
				return bracketObject(buf, "(", ")", around);
			case "[":
			case "]":
				return bracketObject(buf, "[", "]", around);
			case "{":
			case "}":
			case "B":
				return bracketObject(buf, "{", "}", around);
			case "<":
			case ">":
				return bracketObject(buf, "<", ">", around);
			case "p":
				return paragraphObject(buf, around);
			default:
				return null;
		}
	}

	/**
	 * Consume the object key that follows a pending `i`/`a`. Under an operator the object becomes
	 * the operated range (`diw`); in Visual mode it becomes the selection instead (`viw`).
	 */
	#applyTextObject(key: string, buf: VimBuffer): VimCommand[] {
		const around = this.#textObject === "a";
		const operator = this.#operator;
		this.#textObject = null;
		this.#operator = null;
		const range = this.#resolveTextObject(key, around, buf, this.#takeCount());
		if (range === null) return [];
		if (operator !== null) return this.#operate(operator, range.from, range.to, range.linewise);

		this.anchor = range.from;
		const commands: VimCommand[] = [];
		// A linewise object in charwise Visual mode promotes the selection, as Vim's `vip` does.
		if (range.linewise && this.mode === "visual") {
			this.mode = "visual-line";
			commands.push({ kind: "mode", mode: this.mode });
		}
		// The selection's moving end sits *on* the object's last grapheme, not one past it.
		let to = range.to;
		if (to.col > 0) to = { line: to.line, col: prevGraphemeStart(buf.lines[to.line] ?? "", to.col) };
		else if (to.line > range.from.line)
			to = { line: to.line - 1, col: lastGraphemeStart(buf.lines[to.line - 1] ?? "") };
		else to = range.from;
		commands.push({ kind: "move", to });
		return commands;
	}

	#handleNormalKey(key: string, buf: VimBuffer): VimCommand[] | null {
		const line = buf.lines[buf.cursorLine] ?? "";
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;

		switch (key) {
			case "i":
				this.#armInsert(key);
				this.mode = "insert";
				return [{ kind: "mode", mode: "insert" }];
			case "a":
				this.#armInsert(key);
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: nextGraphemeStart(line, buf.cursorCol) } },
				];
			case "I":
				this.#armInsert(key);
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: firstNonBlank(line) } },
				];
			case "A":
				this.#armInsert(key);
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: line.length } },
				];
			case "o":
			case "O":
				this.#armInsert(key);
				this.mode = "insert";
				return [
					{ kind: "openLine", below: key === "o" },
					{ kind: "mode", mode: "insert" },
				];
			case "v":
			case "V":
				this.#takeCount();
				this.mode = key === "v" ? "visual" : "visual-line";
				this.anchor = { line: buf.cursorLine, col: buf.cursorCol };
				return [{ kind: "mode", mode: this.mode }];
			case "x": {
				this.#takeCount();
				let col = buf.cursorCol;
				for (let i = 0; i < count && col < line.length; i++) col = nextGraphemeStart(line, col);
				if (col === buf.cursorCol) return [];
				return [
					{
						kind: "delete",
						from: { line: buf.cursorLine, col: buf.cursorCol },
						to: { line: buf.cursorLine, col },
						linewise: false,
						insert: false,
					},
				];
			}
			case "X":
			case "D":
			case "C":
			case "S":
			case "s":
			case "Y": {
				// Vim's `nv_optrans` feeds these back as `dh`, `d$`, `c$`, `cc`, `cl`, `yy`, count
				// included, so each is that command in every respect. A pending operator cancels.
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				if (key === "S" || key === "Y") return this.#lineOperate(key === "S" ? "c" : "y", buf);
				this.#operator = key === "X" || key === "D" ? "d" : "c";
				const motion = this.#resolveMotion(key === "X" ? "h" : key === "s" ? "l" : "$", buf);
				return motion === null ? [] : this.#applyMotion(buf, motion);
			}
			case "d":
			case "y":
			case "c":
			case ">":
			case "<":
				if (this.#operator === key) return this.#lineOperate(key, buf);
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				this.#operator = key;
				return [];
			case "~": {
				if (this.#operator === "g~") return this.#lineOperate("g~", buf);
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				// Toggle `count` graphemes and step past them, staying on the line.
				this.#takeCount();
				let col = buf.cursorCol;
				for (let i = 0; i < count && col < line.length; i++) col = nextGraphemeStart(line, col);
				if (col === buf.cursorCol) return [];
				const from = cursorOf(buf);
				return [
					{ kind: "case", from, to: { line: buf.cursorLine, col }, linewise: false, mode: "toggle" },
					{ kind: "move", to: { line: buf.cursorLine, col } },
				];
			}
			case "U":
				// `gUU`; Vim's line-undo `U` is not supported.
				if (this.#operator === "gU") return this.#lineOperate("gU", buf);
				this.#clearPending();
				return [];
			case "p":
			case "P":
				return [{ kind: "paste", after: key === "p", count: this.#takeCount(), cursorAfter: false }];
			case "u":
			case "ctrl+r":
				// `u` completes `guu`; otherwise neither is a motion, so after an operator (`du`) Vim
				// cancels instead of undoing.
				if (key === "u" && this.#operator === "gu") return this.#lineOperate("gu", buf);
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				return [{ kind: key === "u" ? "undo" : "redo", count: this.#takeCount() }];
			case ".": {
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				const dotCount = this.#count.length > 0 ? this.#takeCount() : null;
				return this.#repeat(buf, dotCount);
			}
			case "/":
			case "?":
				// Prompt history, not the draft: the host's history search, as a shell's vi mode.
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				this.#takeCount();
				return [{ kind: "historySearch" }];
			case ":": {
				// No Ex command line: on an empty prompt `:` starts a slash command instead, so the host's
				// command menu opens as if `/` were typed. With a draft it would mix into the text, so it does nothing.
				const operator = this.#operator;
				this.#clearPending();
				if (!this.slashCommands || operator !== null || buf.lines.length !== 1 || buf.lines[0] !== "") return [];
				this.mode = "insert";
				this.#unrecordedInsert = true;
				return [{ kind: "mode", mode: "insert" }, { kind: "commandLine" }];
			}
			case "j":
			case "k":
			case "-":
			case "+": {
				// Reached only when the motion had no line to go to. Like zsh's vi mode, the line past the
				// first or last is the neighbouring prompt in history; under an operator it just fails.
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				return [{ kind: "historyStep", older: key === "k" || key === "-", count: this.#takeCount() }];
			}
			case "J": {
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				return [{ kind: "join", fromLine: buf.cursorLine, lines: Math.max(2, this.#takeCount()), spaces: true }];
			}
			default:
				// Normal mode swallows unknown printable keys rather than typing them into the buffer.
				this.#clearPending();
				return [];
		}
	}

	#handleVisualKey(key: string, buf: VimBuffer): VimCommand[] | null {
		const anchor = this.anchor ?? { line: buf.cursorLine, col: buf.cursorCol };
		const linewise = this.mode === "visual-line";

		switch (key) {
			case "v":
			case "V": {
				const next = key === "v" ? "visual" : "visual-line";
				if (this.mode === next) {
					this.mode = "normal";
					this.anchor = null;
					return [
						{ kind: "mode", mode: "normal" },
						{ kind: "move", to: this.#clampNormal(buf, cursorOf(buf)) },
					];
				}
				this.mode = next;
				return [{ kind: "mode", mode: next }];
			}
			case "o": {
				this.anchor = { line: buf.cursorLine, col: buf.cursorCol };
				return [{ kind: "move", to: anchor }];
			}
			case "p":
			case "P": {
				// The selection is swapped for the register; `P` (unlike `p`) keeps the register as it was.
				const { from, to } = visualRange(buf, anchor, linewise);
				this.#rememberVisual(buf);
				this.#clearPending();
				this.anchor = null;
				this.mode = "normal";
				return [
					{ kind: "visualPut", from, to, linewise, keepRegister: key === "P" },
					{ kind: "mode", mode: "normal" },
				];
			}
			case "y":
			case "Y":
			case "d":
			case "x":
			case "X":
			case "D":
			case "c":
			case "s":
			case "S":
			case "C":
			case "R":
			case ">":
			case "<":
			case "J":
			case "gJ":
			case "u":
			case "U":
			case "~": {
				// Uppercase `X`/`D`/`Y`/`C`/`S`/`R` act on whole lines even from a charwise selection,
				// as Vim's do.
				const whole = linewise || VISUAL_LINE_KEYS[key] === true;
				const range = visualRange(buf, anchor, whole);
				// A linewise range still remembers the column it started from: `u` returns there.
				const head =
					anchor.line < buf.cursorLine || (anchor.line === buf.cursorLine && anchor.col <= buf.cursorCol)
						? anchor
						: cursorOf(buf);
				const from = whole ? { line: range.from.line, col: head.col } : range.from;
				const to = range.to;
				this.#rememberVisual(buf);
				this.#clearPending();
				this.anchor = null;
				if (key !== "y" && key !== "Y") {
					const change: VimChange = {
						kind: "visual",
						key,
						linewise: whole,
						lines: to.line - from.line + 1,
						graphemes:
							from.line === to.line ? countGraphemes((buf.lines[from.line] ?? "").slice(from.col, to.col)) : 0,
						endCol: to.col,
						insert: null,
					};
					if (VISUAL_CHANGE_KEYS[key] === true) {
						this.#lastChange = change;
						this.#stagedChange = null;
					} else {
						this.#stagedChange = change;
					}
				}
				return this.#visualEdit(key, from, to, whole);
			}
			default:
				this.#clearPending();
				return [];
		}
	}

	/** Apply a Visual-mode edit key to the span `from`–`to` (end-exclusive), live or from `.`. */
	#visualEdit(key: string, from: VimPosition, to: VimPosition, linewise: boolean): VimCommand[] {
		if (key === ">" || key === "<" || key === "J" || key === "gJ") {
			this.mode = "normal";
			const edit: VimCommand =
				key === ">" || key === "<"
					? { kind: "indent", fromLine: from.line, toLine: to.line, out: key === "<" }
					: {
							kind: "join",
							fromLine: from.line,
							lines: Math.max(2, to.line - from.line + 1),
							spaces: key === "J",
						};
			return [edit, { kind: "mode", mode: "normal" }];
		}
		const operator = VISUAL_OPERATORS[key] ?? "d";
		// `#operate` switches to Insert itself for `c`; everything else drops back to Normal.
		if (operator !== "c") this.mode = "normal";
		const commands = this.#operate(operator, from, to, linewise);
		return operator === "c" ? commands : [...commands, { kind: "mode", mode: "normal" }];
	}
}

/**
 * Normalized, end-exclusive span covered by a Visual selection.
 *
 * Charwise selections include the grapheme under the cursor (Vim semantics); linewise selections
 * span whole lines, with `to.col` at the end of the last line so the caller can decide whether the
 * trailing newline goes too.
 */
export function visualRange(
	buf: VimBuffer,
	anchor: VimPosition,
	linewise: boolean,
): { from: VimPosition; to: VimPosition } {
	const cursor: VimPosition = { line: buf.cursorLine, col: buf.cursorCol };
	let from = anchor;
	let to = cursor;
	if (to.line < from.line || (to.line === from.line && to.col < from.col)) [from, to] = [to, from];

	if (linewise) {
		const lastLine = Math.min(to.line, buf.lines.length - 1);
		return { from: { line: from.line, col: 0 }, to: { line: lastLine, col: (buf.lines[lastLine] ?? "").length } };
	}
	const text = buf.lines[to.line] ?? "";
	// Ending on the line break (after `$`, or on an empty line) selects the break too, as in Vim.
	if (to.col >= text.length && to.line < buf.lines.length - 1) return { from, to: { line: to.line + 1, col: 0 } };
	return { from, to: { line: to.line, col: nextGraphemeStart(text, to.col) } };
}
