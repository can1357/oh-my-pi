import { describe, expect, it } from "bun:test";
import { Editor, TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

/** Visible cell column of `needle` inside a rendered (SGR-carrying) row. */
function visBase(line: string, needle: string): number {
	const idx = line.indexOf(needle);
	return visibleWidth(line.slice(0, idx).replace(/\x1b\[[0-9;:]*[A-Za-z]/g, ""));
}

function setup(text: string, width = 40): { editor: Editor; textRow: (out: readonly string[]) => number } {
	const editor = new Editor(defaultEditorTheme);
	editor.setText(text);
	const out = editor.render(width);
	// The composer style may emit decoration rows (top chrome) before text rows;
	// locate the row that actually carries the text so pointer tests target it.
	const textRow = (lines: readonly string[]) =>
		lines.findIndex(line => line.includes(text.slice(0, Math.min(text.length, 8)) || "​"));
	expect(out.length).toBeGreaterThan(0);
	return { editor, textRow };
}

describe("Editor.moveCursorToRenderedPosition", () => {
	it("positions the caret at the clicked cell of the text row", () => {
		const { editor, textRow } = setup("hello world test");
		const out = editor.render(40);
		const row = textRow(out);
		// Click "world" — 7 text cells in, plus whatever chrome+gutter the row carries.
		const line = out[row] ?? "";
		expect(line).toContain("hello");
		const col = visBase(line, "hello") + 8;
		expect(editor.moveCursorToRenderedPosition(row, col)).toBe(true);
		const cursor = editor.getCursor();
		expect(cursor.line).toBe(0);
		expect(cursor.col).toBe(8); // "hello wo|rld"
	});

	it("keeps surrogate pairs intact when clicking past an emoji (UTF-16 caret math)", () => {
		const { editor, textRow } = setup("hi \u{1F44B} there");
		const out = editor.render(40);
		const row = textRow(out);
		const line = out[row] ?? "";
		const base = visBase(line, "hi");
		// Click on the emoji cells (either half): the caret stops before the
		// surrogate pair, never inside it.
		expect(editor.moveCursorToRenderedPosition(row, base + 3)).toBe(true);
		expect(editor.getCursor().col).toBe(3); // "hi |👋 there"
		expect(editor.moveCursorToRenderedPosition(row, base + 4)).toBe(true);
		expect(editor.getCursor().col).toBe(3);
		// Click on the "t" of "there": past the emoji in UTF-16 units — the
		// caret lands at 5 ("hi 👋|t…"), i.e. past the 2-unit emoji, not at 4.
		expect(editor.moveCursorToRenderedPosition(row, base + 5)).toBe(true);
		expect(editor.getCursor().col).toBe(5);
	});

	it("skips zero-width glyphs instead of inventing cells for them", () => {
		const { editor, textRow } = setup("A\u200bBC");
		const out = editor.render(40);
		const row = textRow(out);
		const line = out[row] ?? "";
		const base = visBase(line, "A");
		// Click on "C": past "A" (1 cell) and the zero-width space (0 cells) = base+2.
		expect(editor.moveCursorToRenderedPosition(row, base + 2)).toBe(true);
		expect(editor.getCursor().col).toBe(3); // after A, the zero-width space, and B; before C
	});

	it("clamps clicks past the end of the line to EOL", () => {
		const { editor, textRow } = setup("short");
		const out = editor.render(40);
		expect(editor.moveCursorToRenderedPosition(textRow(out), 500)).toBe(true);
		expect(editor.getCursor().col).toBe("short".length);
	});

	it("rejects clicks on the gutter/chrome before the text and invalid input", () => {
		const { editor, textRow } = setup("text");
		const out = editor.render(40);
		const row = textRow(out);
		const line = out[row] ?? "";
		const textStart = visBase(line, "text");
		// The gutter occupies at least the columns before the text on a composed row.
		if (textStart > 0) {
			expect(editor.moveCursorToRenderedPosition(row, 0)).toBe(false);
		}
		expect(editor.moveCursorToRenderedPosition(row, -1)).toBe(false);
		expect(editor.moveCursorToRenderedPosition(-1, 5)).toBe(false);
		expect(editor.moveCursorToRenderedPosition(Number.NaN, 5)).toBe(false);
		expect(editor.moveCursorToRenderedPosition(row, Number.POSITIVE_INFINITY)).toBe(false);
	});

	it("rejects rows outside the text (chrome above, footer/autocomplete below)", () => {
		const { editor, textRow } = setup("body");
		const out = editor.render(40);
		// A row index past everything rendered cannot map.
		expect(editor.moveCursorToRenderedPosition(out.length + 5, 3)).toBe(false);
		// Decoration rows above the text (when present) do not map either.
		const row = textRow(out);
		if (row > 0) {
			expect(editor.moveCursorToRenderedPosition(0, 3)).toBe(false);
		}
	});

	it("maps clicks on wrapped continuation rows through the chunk offset", () => {
		const editor = new Editor(defaultEditorTheme);
		const text = "word ".repeat(20).trimEnd(); // 100 cells, wraps at width 40
		editor.setText(text);
		const out = editor.render(40);
		const rowsWithWord = out.map((line, index) => ({ line, index })).filter(({ line }) => line.includes("word"));
		expect(rowsWithWord.length).toBeGreaterThan(2); //确保真的折行了
		const last = rowsWithWord[rowsWithWord.length - 1]!;
		const col = visBase(last.line, "word") + 2; // click inside "wo|rd" of the last chunk
		expect(editor.moveCursorToRenderedPosition(last.index, col)).toBe(true);
		const cursor = editor.getCursor();
		// The caret must be inside the logical line at the clicked chunk position.
		expect(cursor.line).toBe(0);
		expect(text.slice(cursor.col, cursor.col + 2)).toBe("rd");
	});
});

// Keep the TUI import referenced for future integration cases without tripping lint.
void TUI;
