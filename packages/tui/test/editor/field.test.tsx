/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `editor`/`input` kinds in the terminal: layout, painting and the
 * widget's native editing (edits applied by a minimal program).
 */
import { describe, expect, test } from "bun:test";
import { createRoot, type KeyEvent, signal, type UiEvent, type UiNode } from "../../src";
import { bubbleEvent, keypathOf } from "../../src/dispatch";
import { type EditorProps, lastLayout, layoutText, rowOf } from "../../src/term/painters/editor";
import { paintNode, staticEnvironment } from "../../src/term/paint";
import { setWidgetKeymap } from "../../src/term/keymap";
import { widgetFor, widgetState } from "../../src/term/widgets";
import { plainRows } from "../../src/testing/cells";
import { loadThemeSync } from "../../src/theme";
import "../../src/term/painters";

interface Field {
	node: UiNode;
	text(): string;
	cursor(): number;
	undos: number;
	press(id: string, text?: string, raw?: string): boolean;
	paste(text: string): void;
	rows(width: number): string[];
}

function field(
	kind: "editor" | "input",
	initial: string,
	cursor = initial.length,
	extra: Partial<EditorProps> = {},
): Field {
	return createRoot(() => {
		const text = signal(initial);
		const caret = signal(cursor);
		const state = { undos: 0 };
		const onEdit = (event: Extract<UiEvent, { type: "edit" }>) => {
			if (event.len !== text().length) return;
			text.set(text().slice(0, event.from) + event.text + text().slice(event.to));
			caret.set(event.cursor);
		};
		const node = (
			<col>
				{kind === "editor" ? (
					<editor text={text} cursor={caret} onEdit={onEdit} onUndo={() => state.undos++} {...extra} />
				) : (
					<input text={text} cursor={caret} onEdit={onEdit} onUndo={() => state.undos++} />
				)}
			</col>
		) as UiNode;
		const target = node.children()[0]!;
		const env = staticEnvironment(loadThemeSync("dark"), { focus: target });
		const cx = {
			emit: (event: UiEvent) => void bubbleEvent([node, target], event),
			state: <T,>(name: string, init: () => T) => {
				const map = widgetState(target);
				if (!map.has(name)) map.set(name, signal<unknown>(init()));
				return map.get(name) as ReturnType<typeof signal<T>>;
			},
			keypath: keypathOf([node, target]),
			focus: () => {},
			pageRows: 10,
		};
		const widget = widgetFor(target)!;
		return {
			node: target,
			text,
			cursor: caret,
			get undos() {
				return state.undos;
			},
			press(id: string, typed?: string, raw?: string) {
				const key: KeyEvent = { id, kind: "press", raw: raw ?? typed ?? id, ...(typed ? { text: typed } : {}) };
				return widget.key!(target, key, cx);
			},
			paste(pasted: string) {
				widget.paste!(target, { text: pasted }, cx);
			},
			rows(width: number) {
				return plainRows([...paintNode(env, target, width).rows]);
			},
		};
	});
}

describe("layout", () => {
	test("wraps by words, swallowing the blank at a break", () => {
		const rows = layoutText("alpha beta gamma", 10);
		expect(rows.map(r => [r.start, r.textEnd, r.end])).toEqual([
			[0, 10, 11],
			[11, 16, 16],
		]);
	});
	test("breaks a word wider than a row by graphemes", () => {
		expect(layoutText("abcdefgh", 3).map(r => [r.start, r.end])).toEqual([
			[0, 3],
			[3, 6],
			[6, 8],
		]);
	});
	test("keeps trailing blanks of a line on its last row", () => {
		const rows = layoutText("abcd  ", 4);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.textEnd).toBe(4);
		expect(rows[0]!.end).toBe(6);
	});
	test("finds the row holding an offset at breaks, blank lines and past the end", () => {
		// "alpha beta" (the blank at 10 is swallowed by the soft break), "gamma", the blank line, "xy".
		const rows = layoutText("alpha beta gamma\n\nxy", 10);
		expect(rows.map(r => [r.start, r.end])).toEqual([
			[0, 11],
			[11, 16],
			[17, 17],
			[18, 20],
		]);
		// A swallowed blank stays on its row, a soft break starts the next, a line's end stays on its last row.
		expect([0, 10, 11, 16, 17, 18, 20, 99].map(offset => rowOf(rows, offset))).toEqual([0, 0, 1, 1, 2, 3, 3, 3]);
	});
	test("lays a field out again after an edit as a fresh layout would", () => {
		const f = field("editor", "one two three\nfour five six\nseven", 8);
		f.rows(9);
		for (const [id, typed] of [
			["x", "x"],
			["enter", undefined],
			["backspace", undefined],
			["space", " "],
		] as const)
			f.press(id, typed);
		f.paste("a much longer pasted line\nand another");
		f.rows(9);
		expect(lastLayout(f.node)).toEqual(layoutText(f.text(), 9));
		f.rows(6);
		expect(lastLayout(f.node)).toEqual(layoutText(f.text(), 6));
	});
});

describe("painting", () => {
	test("bar caret after the text, inverse block on a character", () => {
		const f = field("editor", "hi");
		expect(f.rows(10)).toEqual(["hi▏"]);
		f.press("home");
		const env = staticEnvironment(loadThemeSync("dark"), { focus: f.node });
		const block = paintNode(env, f.node, 10);
		expect(block.rows[0]).toContain("\x1b[7mh\x1b[27m");
		expect(block.cursor).toEqual({ row: 0, col: 0 });
	});
	test("maxLines shows a window around the caret", () => {
		const f = field("editor", "1\n2\n3\n4\n5", 9, { maxLines: 2 });
		expect(f.rows(10)).toEqual(["4", "5▏"]);
	});
	test("an input scrolls horizontally to the caret", () => {
		const f = field("input", "abcdefghij");
		expect(f.rows(5)).toEqual(["ghij▏"]);
	});
});

describe("editing", () => {
	test("typing, word motions and deletion", () => {
		const f = field("editor", "one two");
		f.press("space", " ");
		f.press("x", "x");
		expect(f.text()).toBe("one two x");
		f.press("alt+b", undefined, "\x1bb");
		expect(f.cursor()).toBe(8);
		f.press("ctrl+w");
		expect(f.text()).toBe("one x");
		f.press("ctrl+a");
		f.press("alt+d");
		expect(f.text()).toBe(" x");
	});
	test("word motion keeps identifiers and joined words together; deleting at a line edge only joins the lines", () => {
		const f = field("editor", "one_two rock’n’roll\n三字abc", 0);
		f.press("alt+f");
		expect(f.cursor()).toBe(7);
		f.press("alt+f");
		expect(f.cursor()).toBe(19);
		f.press("alt+d");
		expect(f.text()).toBe("one_two rock’n’roll三字abc");
		f.press("alt+f");
		expect(f.cursor()).toBe(21);
		f.press("alt+b");
		expect(f.cursor()).toBe(19);
		f.press("ctrl+w");
		expect(f.text()).toBe("one_two 三字abc");

		const backward = field("editor", "first\nsecond", 6);
		backward.press("ctrl+w");
		expect(backward.text()).toBe("firstsecond");
		backward.press("ctrl+y");
		expect(backward.text()).toBe("first\nsecond");
	});
	test("paging keeps the column, moves a field viewport at a time and stops at the first or last row", () => {
		const f = field("editor", "abc\ndef\nghi\njkl\nmno", 1, { maxLines: 3 });
		f.rows(20);
		f.press("pageUp");
		expect(f.cursor()).toBe(1);
		f.press("pageDown");
		expect(f.cursor()).toBe(9);
		f.press("pageDown");
		expect(f.cursor()).toBe(17);
		f.press("pageDown");
		expect(f.cursor()).toBe(17);
	});
	test("kill ring: consecutive kills merge, yank and yank-pop cycle", () => {
		const f = field("editor", "alpha beta gamma");
		f.press("ctrl+w");
		f.press("ctrl+w");
		expect(f.text()).toBe("alpha ");
		f.press("ctrl+y");
		expect(f.text()).toBe("alpha beta gamma");
		f.press("ctrl+a");
		f.press("ctrl+k");
		f.press("ctrl+y");
		f.press("alt+y");
		expect(f.text()).toBe("beta gamma");
		f.press("alt+y");
		expect(f.text()).toBe("alpha beta gamma");
	});
	test("ctrl+u and ctrl+k take the newline at a line edge", () => {
		const f = field("editor", "ab\ncd", 3);
		f.press("ctrl+u");
		expect(f.text()).toBe("abcd");
		f.press("ctrl+e");
		f.press("ctrl+k");
		expect(f.text()).toBe("abcd");
	});
	test("shift selection is replaced by typing", () => {
		const f = field("editor", "hello", 0);
		f.press("shift+right");
		f.press("shift+right");
		f.press("shift+y", "Y");
		expect(f.text()).toBe("Yllo");
	});
	test("select all highlights every line from a middle caret; typing replaces it once", () => {
		const f = field("editor", "ab\ncd", 1);
		f.press("super+a");
		const env = staticEnvironment(loadThemeSync("dark"), { focus: f.node });
		const { rows } = paintNode(env, f.node, 10);
		expect(rows[0]).toContain("\x1b[7mab\x1b[27m");
		expect(rows[1]).toContain("\x1b[7mcd\x1b[27m");
		f.press("x", "x");
		f.press("y", "y");
		expect(f.text()).toBe("xy");
	});
	test("select all in a single-line input is replaced by paste or forward delete", () => {
		const f = field("input", "abcd");
		f.press("super+a");
		f.paste("e\nf");
		expect(f.text()).toBe("e f");
		f.press("super+a");
		f.press("delete");
		expect(f.text()).toBe("");
	});
	test("rows: up/down keep a column, past the edges go to line start/end", () => {
		const f = field("editor", "first\nsecond\nx", 14);
		f.rows(20);
		f.press("up");
		expect(f.cursor()).toBe(7);
		f.press("up");
		expect(f.cursor()).toBe(1);
		f.press("end");
		f.press("down");
		expect(f.cursor()).toBe(11);
		f.press("down");
		expect(f.cursor()).toBe(14);
		f.press("down");
		expect(f.cursor()).toBe(14);
		f.press("ctrl+a");
		f.press("up");
		f.press("up");
		f.press("up");
		expect(f.cursor()).toBe(0);
	});
	test("new lines in an editor only; paste flattens in an input", () => {
		const e = field("editor", "a");
		e.press("shift+enter");
		e.press("enter", undefined, "\n");
		e.press("ctrl+enter");
		expect(e.text()).toBe("a\n\n\n");
		expect(e.press("enter", undefined, "\r")).toBe(false);
		const i = field("input", "");
		expect(i.press("shift+enter")).toBe(false);
		i.paste("a\nb");
		expect(i.text()).toBe("a b");
	});
	test("undo is the program's", () => {
		const f = field("editor", "x");
		f.press("ctrl+-");
		expect(f.undos).toBe(1);
	});
	test("readonly fields only move", () => {
		const f = field("editor", "abc", 3, { readonly: true });
		expect(f.press("a", "a")).toBe(false);
		f.press("left");
		expect(f.cursor()).toBe(2);
	});
	test("motions, edits and new lines follow the widget keymap", () => {
		setWidgetKeymap({
			"editor.cursorLeft": ["ctrl+h"],
			"editor.deleteWordBackward": ["alt+w"],
			"editor.newLine": ["ctrl+o"],
		});
		try {
			const f = field("editor", "one two");
			expect(f.press("left")).toBe(false);
			f.press("ctrl+h");
			expect(f.cursor()).toBe(6);
			f.press("ctrl+shift+h");
			f.press("X", "X");
			expect(f.text()).toBe("one tXo");
			f.press("ctrl+w");
			expect(f.text()).toBe("one tXo");
			f.press("alt+w");
			expect(f.text()).toBe("one o");
			f.press("ctrl+j");
			expect(f.text()).toBe("one o");
			f.press("ctrl+o");
			f.press("alt+enter");
			expect(f.text()).toBe("one \n\no");
		} finally {
			setWidgetKeymap();
		}
	});
});
