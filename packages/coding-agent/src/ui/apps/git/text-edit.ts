/**
 * Text editing of the git sidebar's fields: one-line fields (the commit
 * summary, the AI staging prompt) and the multi-line commit description,
 * each a `{ text, cursor }` value (UTF-16 caret) the sidebar owns.
 */
import type { KeyEvent, TextEdit } from "@oh-my-pi/pi-tui";
import { editLine, type LineState } from "../../overlays/settings/line-edit";

/** An empty field. */
export const EMPTY_LINE: LineState = { text: "", cursor: 0 };

/** A field holding `text` with the caret at its end. */
export function lineAt(text: string): LineState {
	return { text, cursor: text.length };
}

/** A terminal's `edit` event applied to a field; undefined when it is stale (its `len` is not the field's). */
export function applyTextEdit(line: LineState, edit: TextEdit): LineState | undefined {
	if (edit.len !== line.text.length) return undefined;
	return { text: `${line.text.slice(0, edit.from)}${edit.text}${line.text.slice(edit.to)}`, cursor: edit.cursor };
}

/** The logical line holding `cursor`, and the caret's offset in it. */
export function caretLine(value: LineState): { line: number; column: number; start: number; end: number } {
	let start = 0;
	let line = 0;
	for (;;) {
		const end = value.text.indexOf("\n", start);
		if (end < 0 || value.cursor <= end) {
			return { line, column: value.cursor - start, start, end: end < 0 ? value.text.length : end };
		}
		start = end + 1;
		line++;
	}
}

/**
 * `key` applied to a multi-line value: Enter breaks the line, ↑/↓ move
 * between lines keeping the column, ←/→ and Backspace cross line ends;
 * everything else edits the caret's line. Undefined when not an edit.
 */
export function editMultiline(value: LineState, key: KeyEvent): LineState | undefined {
	const { text, cursor } = value;
	const at = caretLine(value);
	switch (key.id) {
		case "enter":
		case "shift+enter":
			return { text: `${text.slice(0, cursor)}\n${text.slice(cursor)}`, cursor: cursor + 1 };
		case "up": {
			if (at.start === 0) return value;
			const prevStart = text.lastIndexOf("\n", at.start - 2) + 1;
			return { text, cursor: prevStart + Math.min(at.column, at.start - 1 - prevStart) };
		}
		case "down": {
			if (at.end >= text.length) return value;
			const nextStart = at.end + 1;
			const nextEnd = text.indexOf("\n", nextStart);
			const length = (nextEnd < 0 ? text.length : nextEnd) - nextStart;
			return { text, cursor: nextStart + Math.min(at.column, length) };
		}
		case "left":
			if (at.column === 0) return { text, cursor: Math.max(0, cursor - 1) };
			break;
		case "right":
			if (cursor === at.end) return { text, cursor: Math.min(text.length, cursor + 1) };
			break;
		case "backspace":
			if (at.column === 0 && cursor > 0)
				return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
			break;
		case "delete":
			if (cursor === at.end && cursor < text.length)
				return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
			break;
	}
	const line = text.slice(at.start, at.end);
	const edited = editLine({ text: line, cursor: at.column }, key);
	if (!edited) return undefined;
	return { text: `${text.slice(0, at.start)}${edited.text}${text.slice(at.end)}`, cursor: at.start + edited.cursor };
}
