/**
 * `editor` and `input` input behaviour: the text editing a terminal does
 * natively for a field, turned into `edit`/`undo` events.
 *
 * - Caret: left/right by grapheme (`ctrl+b`/`ctrl+f`), words (`alt`/`ctrl`
 *   arrows, `alt+b`/`alt+f`), line start/end (`home`/`end`, `ctrl+a`/
 *   `ctrl+e`), rows by the wrap the field was last painted with (`up`/`down`
 *   keep a preferred column; past the first/last row they go to the line's
 *   start/end), pages (`pageUp`/`pageDown`). A caret move is an edit
 *   replacing nothing.
 * - Selection: `super+a` selects the whole field; Shift with a caret key
 *   extends a selection. Typing, deleting and pasting replace it.
 * - Deletion: `backspace`, `delete`/`ctrl+d`, words (`ctrl+w`,
 *   `alt+backspace`, `alt+d`, `alt+delete`), to line start/end (`ctrl+u`/
 *   `ctrl+k`; at the line's edge they take the newline).
 * - Kill ring (per field): word and line deletions are kills (consecutive ones merge);
 *   `ctrl+y` yanks the newest, `alt+y` right after a yank swaps it for the
 *   one before.
 * - `ctrl+-`/`ctrl+_` ask the program to undo (`undo` event).
 * - New line (editor only): `shift+enter`, `alt+enter`, `ctrl+enter`, `ctrl+j`.
 * - Printable keys and bracketed paste insert text (an `input` flattens
 *   pasted newlines to spaces).
 *
 * The keys above are defaults: each motion and edit follows its `editor.*`
 * action in the widget keymap (`../keymap`); `alt+enter`, `ctrl+enter` and a bare LF
 * always insert a new line.
 *
 * `enter`, `tab` and `escape` are left to the program (submit, completion,
 * cancel). A `readonly` field only moves the caret. The `input` kind shares
 * this behaviour (`./input`).
 */
import type { KeyEvent, PasteEvent, TextEdit } from "../../events";
import type { UiNode } from "../../node";
import { caretCell, caretOf, type EditorProps, graphemes, lastLayout, offsetAt, rowOf } from "../painters/editor";
import { type WidgetAction, widgetActionOf, widgetKeyMatches } from "../keymap";
import { defineWidget, type Widget, type WidgetContext } from "../widgets";

// ─── Text positions ─────────────────────────────────────────────────────────

/** The grapheme boundary before `offset`. */
export function previousBoundary(text: string, offset: number): number {
	if (offset <= 0) return 0;
	// A grapheme cluster is short; look back far enough to cover the longest emoji sequences.
	const from = Math.max(0, offset - 64);
	let boundary = from;
	for (const g of graphemes(text, from, offset)) boundary = g.at;
	return boundary;
}

/** The grapheme boundary after `offset`. */
export function nextBoundary(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	const first = graphemes(text, offset, Math.min(text.length, offset + 64))[0];
	return first ? first.at + first.text.length : text.length;
}

/** Word motion groups script and delimiter runs; internal apostrophes and hyphens join words. */
function wordClass(g: string): "blank" | "delimiter" | "cjk" | "word" | "other" {
	if (/^\p{White_Space}/u.test(g)) return "blank";
	if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(g)) return "cjk";
	if (/^[\p{L}\p{N}_]/u.test(g)) return "word";
	if (/^[\p{P}\p{S}]/u.test(g)) return "delimiter";
	return "other";
}

function wordBoundary(text: string, offset: number, step: -1 | 1): number {
	const left = step === -1;
	const edge = left ? lineStart(text, offset) : lineEnd(text, offset);
	// At a logical line edge, move over (or kill) just the newline.
	if (edge === offset) return Math.max(0, Math.min(text.length, offset + step));
	const gs = graphemes(text, left ? edge : offset, left ? offset : edge);
	let i = left ? gs.length - 1 : 0;
	while (gs[i] && wordClass(gs[i]!.text) === "blank") i += step;
	if (!gs[i]) return edge;
	const kind = wordClass(gs[i]!.text);
	i += step;
	while (kind !== "other" && gs[i]) {
		const g = gs[i]!.text;
		if (wordClass(g) !== kind) {
			if (kind !== "word" || !/^['’‐‑-]/u.test(g) || !gs[i + step] || wordClass(gs[i + step]!.text) !== "word")
				break;
			i += step;
		}
		i += step;
	}
	const last = gs[i - step]!;
	return left ? last.at : last.at + last.text.length;
}

/** Start of the preceding word, or the previous line's end at column zero. */
export function wordStartBefore(text: string, offset: number): number {
	return wordBoundary(text, offset, -1);
}

/** End of the following word, or the next line's start at end of line. */
export function wordEndAfter(text: string, offset: number): number {
	return wordBoundary(text, offset, 1);
}

/** Start of the logical line holding `offset`. */
export function lineStart(text: string, offset: number): number {
	return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** End of the logical line holding `offset`. */
export function lineEnd(text: string, offset: number): number {
	const at = text.indexOf("\n", offset);
	return at === -1 ? text.length : at;
}

// ─── Terminal-side state ────────────────────────────────────────────────────

/** What the field looked like after the widget's last action (a mismatch means something else changed it). */
interface Snapshot {
	readonly text: string;
	readonly cursor: number;
}

interface FieldState {
	/** The last action, for merging kills and allowing a yank-pop. */
	action: "kill" | "yank" | "vertical" | "other";
	after: Snapshot | null;
	/** Preferred column of vertical moves. */
	column: number;
	/** The range the last yank inserted and the ring entry it came from. */
	yank: { from: number; to: number; index: number } | null;
	/** Killed text, newest last. */
	ring: string[];
}

const KILL_RING_LIMIT = 60;

function fieldState(cx: WidgetContext): FieldState {
	return cx.state<FieldState>("field", () => ({
		action: "other",
		after: null,
		column: 0,
		yank: null,
		ring: [],
	}))();
}

function pushKill(killRing: string[], text: string, merge: "append" | "prepend" | null): void {
	if (text === "") return;
	if (merge && killRing.length > 0) {
		const last = killRing.length - 1;
		killRing[last] = merge === "append" ? `${killRing[last]}${text}` : `${text}${killRing[last]}`;
		return;
	}
	killRing.push(text);
	if (killRing.length > KILL_RING_LIMIT) killRing.shift();
}

// ─── Behaviour ──────────────────────────────────────────────────────────────

interface Field {
	readonly node: UiNode;
	readonly cx: WidgetContext;
	readonly props: EditorProps;
	readonly text: string;
	readonly cursor: number;
	readonly state: FieldState;
	readonly selection: NonNullable<UiNode["fieldSelection"]>;
	readonly multiline: boolean;
}

function openField(node: UiNode, cx: WidgetContext): Field {
	const props = node.props() as EditorProps;
	const text = props.text ?? "";
	const state = fieldState(cx);
	// A program-side change since our last action ends kill merging and yank-pop.
	const cursor = caretOf(props);
	if (state.after && (state.after.text !== text || state.after.cursor !== cursor)) {
		state.action = "other";
		state.yank = null;
	}
	return { node, cx, props, text, cursor, state, selection: node.fieldSelection!, multiline: node.kind === "editor" };
}

/** Emit an edit replacing `[from, to)` with `insert`, caret to `cursor`; `origin` marks a paste. */
function emitEdit(
	field: Field,
	from: number,
	to: number,
	insert: string,
	cursor: number,
	origin: Pick<TextEdit, "paste"> = {},
): void {
	field.cx.emit({
		type: "edit",
		key: field.cx.keypath,
		from,
		to,
		text: insert,
		cursor,
		len: field.text.length,
		...origin,
	});
}

function moveTo(field: Field, cursor: number, anchor: number | null): void {
	const target = Math.max(0, Math.min(field.text.length, cursor));
	if (target !== field.cursor) emitEdit(field, field.cursor, field.cursor, "", target);
	field.selection.anchor = anchor === target ? null : anchor;
}

function replaceSelectionOr(
	field: Field,
	from: number,
	to: number,
	insert: string,
	origin: Pick<TextEdit, "paste"> = {},
): void {
	const selection = field.selection.range(field.cursor);
	field.selection.anchor = null;
	if (selection) {
		emitEdit(field, selection.from, selection.to, insert, selection.from + insert.length, origin);
		return;
	}
	if (from === to && insert === "") return;
	emitEdit(field, from, to, insert, from + insert.length, origin);
}

function insertText(field: Field, insert: string, origin: Pick<TextEdit, "paste"> = {}): void {
	replaceSelectionOr(field, field.cursor, field.cursor, insert, origin);
}

/** Delete `[from, to)` as a kill (merged into the newest ring entry after another kill). */
function kill(field: Field, from: number, to: number, direction: "append" | "prepend"): void {
	const range = field.selection.range(field.cursor);
	if (range) {
		from = range.from;
		to = range.to;
	}
	if (from >= to) return;
	pushKill(field.state.ring, field.text.slice(from, to), field.state.action === "kill" ? direction : null);
	field.selection.anchor = null;
	emitEdit(field, from, to, "", from);
}

function vertical(field: Field, delta: -1 | 1, anchor: number | null, page = false): void {
	const rows = lastLayout(field.node);
	const at = caretCell(field.text, rows, field.cursor);
	const column = field.state.action === "vertical" ? field.state.column : at.col;
	const step = page ? Math.max(1, Math.min(field.props.maxLines ?? 10, field.cx.pageRows, rows.length) - 1) : 1;
	const target = page ? Math.max(0, Math.min(rows.length - 1, at.row + delta * step)) : at.row + delta;
	if (target < 0) moveTo(field, lineStart(field.text, field.cursor), anchor);
	else if (target >= rows.length) moveTo(field, lineEnd(field.text, field.cursor), anchor);
	else moveTo(field, offsetAt(field.text, rows, target, column), anchor);
	field.state.column = column;
}

function isNewlineKey(key: KeyEvent): boolean {
	return (
		widgetKeyMatches(key, "editor.newLine") ||
		key.id === "alt+enter" ||
		key.id === "ctrl+enter" ||
		(key.id === "enter" && key.raw === "\n")
	);
}

/** Caret motions; Shift with one extends the selection. */
const MOTIONS = [
	"editor.cursorLeft",
	"editor.cursorRight",
	"editor.cursorWordLeft",
	"editor.cursorWordRight",
	"editor.cursorLineStart",
	"editor.cursorLineEnd",
	"editor.cursorUp",
	"editor.cursorDown",
	"editor.pageUp",
	"editor.pageDown",
] as const satisfies readonly WidgetAction[];

/** Edits a writable field makes. */
const EDITS = [
	"editor.deleteCharBackward",
	"editor.deleteCharForward",
	"editor.deleteWordBackward",
	"editor.deleteWordForward",
	"editor.deleteToLineStart",
	"editor.deleteToLineEnd",
	"editor.yank",
	"editor.yankPop",
	"editor.undo",
] as const satisfies readonly WidgetAction[];

/** The motion `key` makes, and whether it extends the selection (a motion key with Shift added). */
function motionOf(key: KeyEvent): { motion: (typeof MOTIONS)[number]; extend: boolean } | undefined {
	const exact = widgetActionOf(key.id, MOTIONS);
	if (exact) return { motion: exact, extend: false };
	const unshifted = key.id.replace(/(^|\+)shift\+(?=.)/, "$1");
	if (unshifted === key.id || key.id === "shift+enter") return undefined;
	const motion = widgetActionOf(unshifted, MOTIONS);
	return motion ? { motion, extend: true } : undefined;
}

/** The edit `key` makes (Shift+Backspace/Delete delete as their bare keys do). */
function editOf(key: KeyEvent): (typeof EDITS)[number] | undefined {
	const exact = widgetActionOf(key.id, EDITS);
	if (exact) return exact;
	if (key.id === "shift+backspace" || key.id === "shift+delete") return widgetActionOf(key.id.slice(6), EDITS);
	return undefined;
}

/** Printable text a key types: text without Ctrl/Alt/Super chords. */
function typedText(key: KeyEvent): string | undefined {
	if (key.text === undefined || key.text === "") return undefined;
	if (/(?:^|\+)(?:ctrl|alt|super)\+/.test(key.id)) return undefined;
	return key.text;
}

/** Handle one key; returns the action kind, or null when the key is not the field's. */
function handleKey(field: Field, key: KeyEvent): FieldState["action"] | null {
	const { text, cursor } = field;
	const editable = field.props.readonly !== true;

	if (widgetKeyMatches(key, "editor.selectAll")) {
		// A modal field (Vim Normal/Visual/Replace, a live PTY) owns its selection.
		if (field.props.mode) return null;
		moveTo(field, text.length, 0);
		return "other";
	}
	const move = motionOf(key);
	if (move) {
		const { motion, extend } = move;
		const anchor = extend ? (field.selection.anchor ?? cursor) : null;
		switch (motion) {
			case "editor.cursorLeft": {
				const selection = field.selection.range(field.cursor);
				if (selection && !extend) moveTo(field, selection.from, null);
				else moveTo(field, previousBoundary(text, cursor), anchor);
				return "other";
			}
			case "editor.cursorRight": {
				const selection = field.selection.range(field.cursor);
				if (selection && !extend) moveTo(field, selection.to, null);
				else moveTo(field, nextBoundary(text, cursor), anchor);
				return "other";
			}
			case "editor.cursorWordLeft":
				moveTo(field, wordStartBefore(text, cursor), anchor);
				return "other";
			case "editor.cursorWordRight":
				moveTo(field, wordEndAfter(text, cursor), anchor);
				return "other";
			case "editor.cursorLineStart":
				moveTo(field, lineStart(text, cursor), anchor);
				return "other";
			case "editor.cursorLineEnd":
				moveTo(field, lineEnd(text, cursor), anchor);
				return "other";
			case "editor.cursorUp":
			case "editor.cursorDown":
				if (!field.multiline) return null;
				vertical(field, motion === "editor.cursorUp" ? -1 : 1, anchor);
				return "vertical";
			case "editor.pageUp":
			case "editor.pageDown":
				if (!field.multiline) return null;
				vertical(field, motion === "editor.pageUp" ? -1 : 1, anchor, true);
				return "vertical";
		}
	}
	if (!editable) return null;

	if (isNewlineKey(key)) {
		if (!field.multiline) return null;
		insertText(field, "\n");
		return "other";
	}
	switch (editOf(key)) {
		case "editor.deleteCharBackward":
			replaceSelectionOr(field, previousBoundary(text, cursor), cursor, "");
			return "other";
		case "editor.deleteCharForward":
			replaceSelectionOr(field, cursor, nextBoundary(text, cursor), "");
			return "other";
		case "editor.deleteWordBackward":
			kill(field, wordStartBefore(text, cursor), cursor, "prepend");
			return "kill";
		case "editor.deleteWordForward":
			kill(field, cursor, wordEndAfter(text, cursor), "append");
			return "kill";
		case "editor.deleteToLineStart": {
			const start = lineStart(text, cursor);
			kill(field, start === cursor ? Math.max(0, cursor - 1) : start, cursor, "prepend");
			return "kill";
		}
		case "editor.deleteToLineEnd": {
			const end = lineEnd(text, cursor);
			kill(field, cursor, end === cursor ? Math.min(text.length, cursor + 1) : end, "append");
			return "kill";
		}
		case "editor.yank": {
			const killRing = field.state.ring;
			const entry = killRing.at(-1);
			if (entry === undefined) return "other";
			const selection = field.selection.range(field.cursor);
			const from = selection?.from ?? cursor;
			replaceSelectionOr(field, cursor, cursor, entry);
			field.state.yank = { from, to: from + entry.length, index: killRing.length - 1 };
			return "yank";
		}
		case "editor.yankPop": {
			const yank = field.state.yank;
			const killRing = field.state.ring;
			if (field.state.action !== "yank" || !yank || killRing.length === 0) return "other";
			const index = (yank.index - 1 + killRing.length) % killRing.length;
			const entry = killRing[index]!;
			emitEdit(field, yank.from, yank.to, entry, yank.from + entry.length);
			field.state.yank = { from: yank.from, to: yank.from + entry.length, index };
			return "yank";
		}
		case "editor.undo":
			field.selection.anchor = null;
			field.cx.emit({ type: "undo", key: field.cx.keypath });
			return "other";
	}
	const typed = typedText(key);
	if (typed === undefined) return null;
	insertText(field, typed);
	return "other";
}

/** Record what the field holds now (after the program applied the edit), and keep the caret in the scroll window. */
function settleField(field: Field, action: FieldState["action"]): void {
	const props = field.node.props() as EditorProps;
	const state = field.state;
	state.action = action;
	if (action !== "yank") state.yank = null;
	state.after = { text: props.text ?? "", cursor: caretOf(props) };
	const limit = props.maxLines;
	if (limit !== undefined && limit > 0) {
		const scroll = field.cx.state("scroll", () => 0);
		const rows = lastLayout(field.node);
		const row = rowOf(rows, caretOf(props));
		const top = scroll();
		if (row < top) scroll.set(row);
		else if (row >= top + limit) scroll.set(row - limit + 1);
	}
}

/** The behaviour `editor` and `input` share (an `input` has one line: no rows, no new lines). */
export const fieldWidget: Widget = {
	key(node, key, cx) {
		if (key.kind === "release") return false;
		const field = openField(node, cx);
		const action = handleKey(field, key);
		if (action === null) return false;
		settleField(field, action);
		return true;
	},
	paste(node, paste: PasteEvent, cx) {
		const field = openField(node, cx);
		if (field.props.readonly === true) return false;
		const normalized = paste.text.replace(/\r\n?/g, "\n");
		insertText(field, field.multiline ? normalized : normalized.replace(/\n/g, " "), { paste: true });
		settleField(field, "other");
		return true;
	},
	mouse(node, mouse, at, cx) {
		if (mouse.button !== "left" || mouse.action !== "press") return false;
		const field = openField(node, cx);
		cx.emit({ type: "focus", key: cx.keypath });
		const rows = lastLayout(node);
		const top = field.props.maxLines !== undefined ? (cx.state("scroll", () => 0)() as number) : 0;
		const row = Math.min(rows.length - 1, at.row + top);
		moveTo(field, offsetAt(field.text, rows, row, at.col), null);
		settleField(field, "other");
		return true;
	},
};

defineWidget("editor", fieldWidget);
