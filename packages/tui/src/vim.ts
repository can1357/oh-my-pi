import { getSegmenter, moveWordLeft, moveWordRight } from "./utils";

/**
 * Modal editing state machine for {@link Editor}.
 *
 * Deliberately a *pure* state machine: it reads a snapshot of the buffer and returns the edits it
 * wants applied, so motions can be unit-tested without a terminal and the editor keeps sole
 * ownership of undo, atomic placeholder tokens, the kill ring, and `onChange`.
 *
 * This is a usable subset of Vim, not a reimplementation of it (see issue #3299): Normal and Visual
 * modes, the common motions, and operators built from those motions.
 */

export type VimMode = "insert" | "normal" | "visual" | "visual-line" | "replace";

export type VimOperator = "d" | "y" | "c" | ">" | "<";

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
 * An edit the editor should apply. `to` is always an *exclusive* end offset, so ranges compose the
 * same way regardless of whether the originating motion was inclusive (`e`) or exclusive (`w`).
 */
export type VimCommand =
	| { kind: "move"; to: VimPosition }
	| { kind: "mode"; mode: VimMode }
	| { kind: "yank"; from: VimPosition; to: VimPosition; linewise: boolean }
	| { kind: "delete"; from: VimPosition; to: VimPosition; linewise: boolean; insert: boolean }
	| { kind: "openLine"; below: boolean }
	| { kind: "paste"; after: boolean; count: number }
	| { kind: "undo" }
	| { kind: "replace"; from: VimPosition; to: VimPosition; text: string }
	| { kind: "join"; fromLine: number; lines: number }
	| { kind: "indent"; fromLine: number; toLine: number; out: boolean };

const segmenter = getSegmenter();

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

function firstNonBlank(text: string): number {
	for (const seg of segmenter.segment(text)) {
		if (seg.segment.trim() !== "") return seg.index;
	}
	return 0;
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

/** Vim's `w`: `moveWordRight` stops at the end of the current word, so skip the gap that follows. */
function wordForward(text: string, col: number): number {
	let next = moveWordRight(text, col);
	while (next < text.length && /\s/.test(text.charAt(next))) next++;
	return next;
}

/** Vim's `e`: the last grapheme of the word the cursor is about to run into. */
function wordEnd(text: string, col: number): number {
	let from = nextGraphemeStart(text, col);
	while (from < text.length && /\s/.test(text.charAt(from))) from++;
	const end = moveWordRight(text, from);
	return Math.max(col, prevGraphemeStart(text, end));
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
function flatten(buf: VimBuffer): { text: string; cursor: number } {
	let cursor = buf.cursorCol;
	for (let i = 0; i < buf.cursorLine; i++) cursor += (buf.lines[i] ?? "").length + 1;
	return { text: buf.lines.join("\n"), cursor };
}

function offsetToPos(lines: readonly string[], offset: number): VimPosition {
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
 * `i(`/`a{`… — the innermost pair enclosing the cursor, counting nesting and spanning lines. A
 * cursor sitting on either delimiter counts as being on that pair. Charwise in both variants;
 * Vim's linewise-ish `i{` reshaping is deliberately not reproduced.
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

	/**
	 * Vim's "desired column": `j`/`k` remember the column you started from, so descending through a
	 * short line and back out returns to it instead of collapsing permanently. `null` means the
	 * next vertical motion anchors it to the live cursor column; `Infinity` is `$`'s sticky
	 * end-of-line, which keeps `$j` on the end of each line. Every non-vertical command clears it.
	 */
	#desiredCol: number | null = null;

	/** True while a count, operator, `g`, text-object, find, or `r` prefix is half-typed — Escape cancels it. */
	get pending(): boolean {
		return (
			this.#count.length > 0 ||
			this.#operator !== null ||
			this.#pendingG ||
			this.#textObject !== null ||
			this.#findPending !== null ||
			this.#replaceChar
		);
	}

	/**
	 * The half-typed command as Vim would echo it (`"2"`, `"d"`, `"2d"`, `"di"`, `"df"`, `"r"`) — empty
	 * when nothing is pending. Hosts render this next to the mode so a partially entered operator is
	 * visible instead of silently swallowing the next keystroke.
	 */
	get pendingText(): string {
		return `${this.#count}${this.#operator ?? ""}${this.#pendingG ? "g" : ""}${this.#textObject ?? ""}${findPendingKey(this.#findPending)}${this.#replaceChar ? "r" : ""}`;
	}

	get visual(): boolean {
		return this.mode === "visual" || this.mode === "visual-line";
	}

	reset(): void {
		this.mode = "normal";
		this.anchor = null;
		this.#desiredCol = null;
		this.#clearPending();
		this.#lastFind = null;
	}

	#clearPending(): void {
		this.#count = "";
		this.#operator = null;
		this.#pendingG = false;
		this.#textObject = null;
		this.#findPending = null;
		this.#replaceChar = false;
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
		if (key === "escape") return this.#handleEscape(buf);
		if (this.mode === "insert") return null;
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

		// Count prefix. `0` is the line-start motion unless it extends a count already being typed.
		if ((key >= "1" && key <= "9") || (key === "0" && this.#count.length > 0)) {
			this.#count += key;
			return [];
		}

		if (this.#pendingG) {
			this.#pendingG = false;
			if (key !== "g") {
				this.#clearPending();
				return [];
			}
			// `gg` goes to the first line; `5gg` to line 5.
			this.#desiredCol = null;
			const line = Math.min(this.#takeCount() - 1, buf.lines.length - 1);
			return this.#applyMotion(buf, { to: { line, col: 0 }, inclusive: false, linewise: true });
		}

		if (this.#textObject !== null) {
			this.#desiredCol = null;
			return this.#applyTextObject(key, buf);
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
		if ((key === "r" || key === "R") && this.#operator === null && !this.visual) {
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
			this.mode = "normal";
			this.anchor = null;
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: this.#clampNormal(buf, cursorOf(buf)) },
			];
		}
		if (this.mode === "insert" || this.mode === "replace") {
			this.mode = "normal";
			const text = buf.lines[buf.cursorLine] ?? "";
			return [
				{ kind: "mode", mode: "normal" },
				{ kind: "move", to: { line: buf.cursorLine, col: prevGraphemeStart(text, buf.cursorCol) } },
			];
		}
		// Normal mode with nothing pending: leave Escape to the app (interrupt / clear draft).
		return null;
	}

	#resolveMotion(key: string, buf: VimBuffer): Motion | null {
		const count = this.#count.length > 0 ? Number.parseInt(this.#count, 10) : 1;
		const line = buf.lines[buf.cursorLine] ?? "";
		const at = (col: number): VimPosition => ({ line: buf.cursorLine, col });

		switch (key === " " ? "l" : key) {
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
			case "$":
				// Sticky end-of-line, so `$j` lands on the end of each line rather than a fixed column.
				this.#desiredCol = Number.POSITIVE_INFINITY;
				return { to: at(line.length), inclusive: false, linewise: false };
			case "w": {
				let col = buf.cursorCol;
				// Vim's `cw` quirk: standing on a non-blank, it changes to the end of the word like
				// `ce` rather than swallowing the whitespace that follows it.
				if (this.#operator === "c" && !/\s/.test(line.charAt(col))) {
					for (let i = 0; i < count; i++) col = wordEnd(line, col);
					return { to: at(col), inclusive: true, linewise: false };
				}
				for (let i = 0; i < count; i++) col = wordForward(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "b": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = moveWordLeft(line, col);
				return { to: at(col), inclusive: false, linewise: false };
			}
			case "e": {
				let col = buf.cursorCol;
				for (let i = 0; i < count; i++) col = wordEnd(line, col);
				return { to: at(col), inclusive: true, linewise: false };
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
				const target = this.#count.length > 0 ? count - 1 : buf.lines.length - 1;
				return {
					to: { line: Math.max(0, Math.min(target, buf.lines.length - 1)), col: 0 },
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
			// `$` parks on the last grapheme in Normal mode but must still be able to select the
			// final character in Visual mode, where the cursor is allowed one past it. Replace mode
			// may also sit past the end, so typing there appends instead of overwriting the last grapheme.
			const to =
				this.visual || this.mode === "replace"
					? { line: motion.to.line, col: Math.min(motion.to.col, (buf.lines[motion.to.line] ?? "").length) }
					: this.#clampNormal(buf, motion.to);
			return [{ kind: "move", to }];
		}

		const from: VimPosition = { line: buf.cursorLine, col: buf.cursorCol };
		let start = from;
		let end = motion.to;
		if (end.line < start.line || (end.line === start.line && end.col < start.col)) [start, end] = [end, start];
		if (motion.inclusive) {
			const text = buf.lines[end.line] ?? "";
			end = { line: end.line, col: nextGraphemeStart(text, end.col) };
		}
		return this.#operate(operator, start, end, motion.linewise);
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
		if (operator !== "c") {
			return [{ kind: "delete", from, to, linewise, insert: false }];
		}
		// `c` always lands in Insert mode. The leading move matters when the range is empty
		// (`ci"` between bare quotes): the delete is a no-op, so nothing else would park the cursor.
		// `cc`/`cj` clear the lines but keep them, so a linewise change stays linewise-shaped.
		this.mode = "insert";
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
			case "g":
				this.#pendingG = true;
				return [];
			case "i":
				this.#takeCount();
				this.mode = "insert";
				return [{ kind: "mode", mode: "insert" }];
			case "a":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: nextGraphemeStart(line, buf.cursorCol) } },
				];
			case "I":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: firstNonBlank(line) } },
				];
			case "A":
				this.#takeCount();
				this.mode = "insert";
				return [
					{ kind: "mode", mode: "insert" },
					{ kind: "move", to: { line: buf.cursorLine, col: line.length } },
				];
			case "o":
			case "O":
				this.#takeCount();
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
			case "D":
			case "C": {
				// Like Vim, `D`/`C` take a count: `2D` deletes to the end of the next line, not just
				// this one (`:h D` — "and [count]-1 more lines").
				const span = this.#takeCount();
				const last = Math.min(buf.cursorLine + span - 1, buf.lines.length - 1);
				return this.#operate(
					key === "C" ? "c" : "d",
					{ line: buf.cursorLine, col: buf.cursorCol },
					{ line: last, col: (buf.lines[last] ?? "").length },
					false,
				);
			}
			case "d":
			case "y":
			case "c":
				// A doubled operator (`dd`, `yy`, `cc`) is linewise over `count` lines.
				if (this.#operator === key) {
					const span = this.#takeCount();
					const last = Math.min(buf.cursorLine + span - 1, buf.lines.length - 1);
					this.#operator = null;
					return this.#operate(
						key,
						{ line: buf.cursorLine, col: 0 },
						{ line: last, col: (buf.lines[last] ?? "").length },
						true,
					);
				}
				this.#operator = key;
				return [];
			case "p":
			case "P":
				return [{ kind: "paste", after: key === "p", count: this.#takeCount() }];
			case "u":
				this.#takeCount();
				return [{ kind: "undo" }];
			case "J": {
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				return [{ kind: "join", fromLine: buf.cursorLine, lines: Math.max(2, this.#takeCount()) }];
			}
			case ">":
			case "<": {
				if (this.#operator === key) {
					const span = this.#takeCount();
					const last = Math.min(buf.cursorLine + span - 1, buf.lines.length - 1);
					this.#operator = null;
					return [{ kind: "indent", fromLine: buf.cursorLine, toLine: last, out: key === "<" }];
				}
				if (this.#operator !== null) {
					this.#clearPending();
					return [];
				}
				this.#operator = key;
				return [];
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
			case "y":
			case "d":
			case "x":
			case "c":
			case "s": {
				const operator: VimOperator = key === "y" ? "y" : key === "c" || key === "s" ? "c" : "d";
				const { from, to } = visualRange(buf, anchor, linewise);
				this.#clearPending();
				this.anchor = null;
				// `#operate` switches to Insert itself for `c`; everything else drops back to Normal.
				if (operator !== "c") this.mode = "normal";
				const commands = this.#operate(operator, from, to, linewise);
				return operator === "c" ? commands : [...commands, { kind: "mode", mode: "normal" }];
			}
			case ">":
			case "<":
			case "J": {
				const { from, to } = visualRange(buf, anchor, linewise);
				this.#clearPending();
				this.anchor = null;
				this.mode = "normal";
				const edit: VimCommand =
					key === "J"
						? { kind: "join", fromLine: from.line, lines: Math.max(2, to.line - from.line + 1) }
						: { kind: "indent", fromLine: from.line, toLine: to.line, out: key === "<" };
				return [edit, { kind: "mode", mode: "normal" }];
			}
			default:
				this.#clearPending();
				return [];
		}
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
	return { from, to: { line: to.line, col: nextGraphemeStart(text, to.col) } };
}
