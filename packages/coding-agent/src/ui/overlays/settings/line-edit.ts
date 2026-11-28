/**
 * Single-line text editing for fields the program owns (search queries,
 * setting drafts): a key applied to `{ text, cursor }` (UTF-16 caret), by
 * the `tui.editor.*` bindings.
 */
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { Keybinding } from "../../../config/keybindings/app-keybindings";
import { getKeybindings } from "../../../config/keybindings/keybindings";

/** A line and its caret. */
export interface LineState {
	readonly text: string;
	readonly cursor: number;
}

function graphemeBefore(text: string, at: number): number {
	let previous = 0;
	for (const { index } of segmentGraphemes(text)) {
		if (index >= at) break;
		previous = index;
	}
	return previous;
}

function graphemeAfter(text: string, at: number): number {
	for (const { index, segment } of segmentGraphemes(text)) if (index >= at) return index + segment.length;
	return text.length;
}

function wordBefore(text: string, at: number): number {
	let i = at;
	while (i > 0 && /\s/.test(text[i - 1]!)) i--;
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
	return i;
}

function wordAfter(text: string, at: number): number {
	let i = at;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	while (i < text.length && !/\s/.test(text[i]!)) i++;
	return i;
}

/** Line edits, in the order a key bound to several resolves. */
const LINE_EDITS = [
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
] as const satisfies readonly Keybinding[];

/** `key` applied to `line`; `undefined` when the key is not a line edit. */
export function editLine(line: LineState, key: KeyEvent): LineState | undefined {
	const { text, cursor } = line;
	const keybindings = getKeybindings();
	switch (LINE_EDITS.find(action => keybindings.matches(key, action))) {
		case "tui.editor.cursorLeft":
			return { text, cursor: graphemeBefore(text, cursor) };
		case "tui.editor.cursorRight":
			return { text, cursor: graphemeAfter(text, cursor) };
		case "tui.editor.cursorLineStart":
			return { text, cursor: 0 };
		case "tui.editor.cursorLineEnd":
			return { text, cursor: text.length };
		case "tui.editor.cursorWordLeft":
			return { text, cursor: wordBefore(text, cursor) };
		case "tui.editor.cursorWordRight":
			return { text, cursor: wordAfter(text, cursor) };
		case "tui.editor.deleteCharBackward": {
			if (cursor === 0) return line;
			const from = graphemeBefore(text, cursor);
			return { text: text.slice(0, from) + text.slice(cursor), cursor: from };
		}
		case "tui.editor.deleteCharForward": {
			if (cursor >= text.length) return line;
			return { text: text.slice(0, cursor) + text.slice(graphemeAfter(text, cursor)), cursor };
		}
		case "tui.editor.deleteWordBackward": {
			const from = wordBefore(text, cursor);
			return { text: text.slice(0, from) + text.slice(cursor), cursor: from };
		}
		case "tui.editor.deleteWordForward":
			return { text: text.slice(0, cursor) + text.slice(wordAfter(text, cursor)), cursor };
		case "tui.editor.deleteToLineStart":
			return { text: text.slice(cursor), cursor: 0 };
		case "tui.editor.deleteToLineEnd":
			return { text: text.slice(0, cursor), cursor };
	}
	const typed = key.text;
	if (typed === undefined || typed === "" || /[\x00-\x1f\x7f]/.test(typed)) return undefined;
	return { text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length };
}
