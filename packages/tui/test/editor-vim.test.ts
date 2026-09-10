import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function vimEditor(text = "", options: { cursorToStart?: boolean } = {}): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.setVimMode(true);
	editor.setText(text);
	// `setText` parks the cursor at the end; most tests want to drive from the top of the buffer.
	if (options.cursorToStart !== false) {
		editor.handleInput(ESC);
		editor.handleInput("g");
		editor.handleInput("g");
	}
	return editor;
}

/** Cursor position, via the editor's public accessor. */
function cursor(editor: Editor): { line: number; col: number } {
	return editor.getCursor();
}

describe("Editor vim mode", () => {
	describe("disabled by default", () => {
		it("types vim command letters as ordinary text", () => {
			const editor = new Editor(defaultEditorTheme);
			for (const key of "hjkldwvyGx") editor.handleInput(key);
			expect(editor.getText()).toBe("hjkldwvyGx");
			expect(editor.vimMode).toBe("insert");
		});

		it("never claims Escape", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("draft");
			editor.handleInput(ESC);
			expect(editor.vimConsumesEscape()).toBe(false);
			expect(editor.getText()).toBe("draft");
		});
	});

	describe("mode switching", () => {
		it("starts in insert mode so typing still works when the setting is flipped on", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			editor.handleInput("hi");
			expect(editor.getText()).toBe("hi");
			expect(editor.vimMode).toBe("insert");
		});

		it("enters normal mode on Escape and stops inserting text", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			editor.handleInput("abc");
			editor.handleInput(ESC);
			expect(editor.vimMode).toBe("normal");
			editor.handleInput("z");
			expect(editor.getText()).toBe("abc");
		});

		it("hands Escape back to the app once normal mode is quiet", () => {
			const editor = vimEditor("abc");
			expect(editor.vimMode).toBe("normal");
			expect(editor.vimConsumesEscape()).toBe(false);
		});

		it("claims Escape while a count or operator is half-typed", () => {
			const editor = vimEditor("abc");
			editor.handleInput("2");
			expect(editor.vimConsumesEscape()).toBe(true);
			editor.handleInput(ESC);
			expect(editor.vimConsumesEscape()).toBe(false);

			editor.handleInput("d");
			expect(editor.vimConsumesEscape()).toBe(true);
		});

		it("returns to insert mode via i/a/I/A", () => {
			const editor = vimEditor("ab");
			editor.handleInput("i");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("X");
			expect(editor.getText()).toBe("Xab");

			editor.handleInput(ESC);
			editor.handleInput("A");
			editor.handleInput("Z");
			expect(editor.getText()).toBe("XabZ");
		});

		it("opens a line below with o and above with O", () => {
			const editor = vimEditor("one");
			editor.handleInput("o");
			editor.handleInput("two");
			expect(editor.getText()).toBe("one\ntwo");

			editor.handleInput(ESC);
			editor.handleInput("O");
			editor.handleInput("mid");
			expect(editor.getText()).toBe("one\nmid\ntwo");
		});
	});

	describe("motions", () => {
		it("moves with h/j/k/l without editing the buffer", () => {
			const editor = vimEditor("alfa\nbeta");
			for (const key of "lljhk") editor.handleInput(key);
			expect(editor.getText()).toBe("alfa\nbeta");
		});

		it("0 and $ jump to the line edges", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("$");
			editor.handleInput("a");
			editor.handleInput("!");
			expect(editor.getText()).toBe("alfa beta!");

			editor.handleInput(ESC);
			editor.handleInput("0");
			editor.handleInput("i");
			editor.handleInput(">");
			expect(editor.getText()).toBe(">alfa beta!");
		});

		it("w lands on the start of the next word", () => {
			const editor = vimEditor("alfa beta gamma");
			editor.handleInput("w");
			editor.handleInput("i");
			editor.handleInput("<");
			expect(editor.getText()).toBe("alfa <beta gamma");
		});

		it("b steps back to the start of the previous word", () => {
			const editor = vimEditor("alfa beta gamma");
			editor.handleInput("w");
			editor.handleInput("w");
			editor.handleInput("b");
			editor.handleInput("i");
			editor.handleInput(">");
			expect(editor.getText()).toBe("alfa >beta gamma");
		});

		it("applies a count prefix to a motion", () => {
			const editor = vimEditor("alfa beta gamma delta");
			editor.handleInput("3");
			editor.handleInput("w");
			editor.handleInput("i");
			editor.handleInput("|");
			expect(editor.getText()).toBe("alfa beta gamma |delta");
		});

		it("gg and G jump to the buffer edges", () => {
			const editor = vimEditor("one\ntwo\nthree");
			editor.handleInput("G");
			editor.handleInput("A");
			editor.handleInput("!");
			expect(editor.getText()).toBe("one\ntwo\nthree!");

			editor.handleInput(ESC);
			editor.handleInput("g");
			editor.handleInput("g");
			editor.handleInput("I");
			editor.handleInput(">");
			expect(editor.getText()).toBe(">one\ntwo\nthree!");
		});

		it("k on the first line moves the cursor instead of loading prompt history", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.addToHistory("an older prompt");
			editor.setVimMode(true);
			editor.setText("current draft");
			editor.handleInput(ESC);
			editor.handleInput("k");
			editor.handleInput("k");
			expect(editor.getText()).toBe("current draft");
		});

		it("arrow keys act as motions in normal mode and never browse history", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.addToHistory("an older prompt");
			editor.setVimMode(true);
			editor.setText("current draft");
			editor.handleInput(ESC);
			editor.handleInput(UP);
			editor.handleInput(DOWN);
			expect(editor.getText()).toBe("current draft");
		});

		it("backspace moves left in normal mode rather than deleting", () => {
			const editor = vimEditor("alfa", { cursorToStart: false });
			editor.handleInput(ESC);
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("alfa");
		});
	});

	describe("normal-mode edits", () => {
		it("x deletes the character under the cursor", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("x");
			expect(editor.getText()).toBe("bcd");
			editor.handleInput("2");
			editor.handleInput("x");
			expect(editor.getText()).toBe("d");
		});

		it("D deletes to end of line and C changes to end of line", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("w");
			editor.handleInput("D");
			expect(editor.getText()).toBe("alfa ");

			editor.handleInput("0");
			editor.handleInput("C");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("new");
			expect(editor.getText()).toBe("new");
		});

		it("D and C honor a count across lines", () => {
			const deleter = vimEditor("alfa beta\ngamma delta\nepsilon");
			deleter.handleInput("w");
			deleter.handleInput("2");
			deleter.handleInput("D");
			expect(deleter.getText()).toBe("alfa \nepsilon");

			const changer = vimEditor("alfa beta\ngamma delta\nepsilon");
			changer.handleInput("w");
			changer.handleInput("2");
			changer.handleInput("C");
			expect(changer.vimMode).toBe("insert");
			changer.handleInput("new");
			expect(changer.getText()).toBe("alfa new\nepsilon");
		});

		it("dw deletes a word and dd deletes a line", () => {
			const editor = vimEditor("alfa beta\nsecond line");
			editor.handleInput("d");
			editor.handleInput("w");
			expect(editor.getText()).toBe("beta\nsecond line");

			editor.handleInput("d");
			editor.handleInput("d");
			expect(editor.getText()).toBe("second line");
		});

		it("cw changes to the end of the word and enters insert mode", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("c");
			editor.handleInput("w");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("new");
			// `cw` on a non-blank behaves like `ce`, so the separating space survives.
			expect(editor.getText()).toBe("new beta");
		});

		it("cc clears the line and enters insert mode", () => {
			const editor = vimEditor("alfa beta\nsecond");
			editor.handleInput("c");
			editor.handleInput("c");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("fresh");
			expect(editor.getText()).toBe("fresh\nsecond");
		});

		it("u undoes the previous edit", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("d");
			editor.handleInput("w");
			expect(editor.getText()).toBe("beta");
			editor.handleInput("u");
			expect(editor.getText()).toBe("alfa beta");
		});

		it("yy then p duplicates a line", () => {
			const editor = vimEditor("alfa\nbeta");
			editor.handleInput("y");
			editor.handleInput("y");
			editor.handleInput("p");
			expect(editor.getText()).toBe("alfa\nalfa\nbeta");
		});
	});

	describe("text objects", () => {
		it("diw deletes the word under the cursor instead of entering insert mode", () => {
			const editor = vimEditor("alfa beta gamma");
			editor.handleInput("w");
			editor.handleInput("d");
			editor.handleInput("i");
			expect(editor.vimMode).toBe("normal");
			editor.handleInput("w");
			expect(editor.getText()).toBe("alfa  gamma");
			expect(editor.vimMode).toBe("normal");
		});

		it("daw takes the trailing whitespace with the word", () => {
			const editor = vimEditor("alfa beta gamma");
			editor.handleInput("w");
			for (const key of "daw") editor.handleInput(key);
			expect(editor.getText()).toBe("alfa gamma");
		});

		it("daw falls back to the leading whitespace at the end of a line", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("w");
			for (const key of "daw") editor.handleInput(key);
			expect(editor.getText()).toBe("alfa");
		});

		it("a counted aw takes that many words", () => {
			const editor = vimEditor("alfa beta gamma");
			for (const key of "d2aw") editor.handleInput(key);
			expect(editor.getText()).toBe("gamma");
		});

		it("ciw replaces the word and enters insert mode", () => {
			const editor = vimEditor("alfa beta");
			for (const key of "ciw") editor.handleInput(key);
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("x");
			expect(editor.getText()).toBe("x beta");
		});

		it("iw and aw over quoted spans", () => {
			const inner = vimEditor('say "hello there" now');
			for (const key of 'di"') inner.handleInput(key);
			expect(inner.getText()).toBe('say "" now');

			const around = vimEditor('say "hello there" now');
			for (const key of 'da"') around.handleInput(key);
			expect(around.getText()).toBe("say now");
		});

		it('ci" parks the cursor between empty quotes', () => {
			const editor = vimEditor('say "" now');
			for (const key of 'ci"') editor.handleInput(key);
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("hi");
			expect(editor.getText()).toBe('say "hi" now');
		});

		it("di( takes the innermost pair around the cursor", () => {
			const editor = vimEditor("call(one, nest(two), three)");
			for (let i = 0; i < 15; i++) editor.handleInput("l");
			for (const key of "di(") editor.handleInput(key);
			expect(editor.getText()).toBe("call(one, nest(), three)");
		});

		it("da{ spans the lines the block covers", () => {
			const editor = vimEditor("fn {\n  body\n}\ntail");
			editor.handleInput("j");
			for (const key of "da{") editor.handleInput(key);
			expect(editor.getText()).toBe("fn \ntail");
		});

		it("dip deletes the paragraph under the cursor linewise", () => {
			const editor = vimEditor("one\ntwo\n\nthree");
			for (const key of "dip") editor.handleInput(key);
			expect(editor.getText()).toBe("\nthree");
		});

		it("viw selects the word so the next operator applies to it", () => {
			const editor = vimEditor("alfa beta");
			for (const key of "viw") editor.handleInput(key);
			expect(editor.vimMode).toBe("visual");
			editor.handleInput("d");
			expect(editor.getText()).toBe(" beta");
		});

		it("echoes the half-typed object and cancels it with Escape", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("d");
			editor.handleInput("i");
			expect(editor.vimPending).toBe("di");
			expect(editor.vimConsumesEscape()).toBe(true);
			editor.handleInput(ESC);
			expect(editor.vimPending).toBe("");
			editor.handleInput("w");
			expect(editor.getText()).toBe("alfa beta");
		});
	});

	describe("visual mode", () => {
		it("v + motion + d deletes the selection", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("v");
			expect(editor.vimMode).toBe("visual");
			for (let i = 0; i < 4; i++) editor.handleInput("l");
			editor.handleInput("d");
			expect(editor.getText()).toBe("beta");
			expect(editor.vimMode).toBe("normal");
		});

		it("v + motion + y copies without changing the buffer", () => {
			const yanked: string[] = [];
			const editor = vimEditor("alfa beta");
			editor.onYank = text => yanked.push(text);
			editor.handleInput("v");
			for (let i = 0; i < 3; i++) editor.handleInput("l");
			editor.handleInput("y");
			expect(editor.getText()).toBe("alfa beta");
			expect(yanked).toEqual(["alfa"]);
			expect(editor.vimMode).toBe("normal");
		});

		it("yanked text comes back through p", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("v");
			for (let i = 0; i < 3; i++) editor.handleInput("l");
			editor.handleInput("y");
			editor.handleInput("$");
			editor.handleInput("p");
			expect(editor.getText()).toBe("alfa betaalfa");
		});

		it("selects across lines and deletes the joined range", () => {
			const editor = vimEditor("alfa\nbeta\ngamma");
			editor.handleInput("v");
			editor.handleInput("j");
			// Charwise selection is inclusive of the grapheme under the cursor, so this covers
			// "alfa\nb" and the surviving halves join.
			editor.handleInput("d");
			expect(editor.getText()).toBe("eta\ngamma");
		});

		it("V selects whole lines", () => {
			const editor = vimEditor("alfa\nbeta\ngamma");
			editor.handleInput("l");
			editor.handleInput("V");
			expect(editor.vimMode).toBe("visual-line");
			editor.handleInput("j");
			editor.handleInput("d");
			expect(editor.getText()).toBe("gamma");
		});

		it("Escape leaves visual mode without editing", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("v");
			editor.handleInput("l");
			expect(editor.vimConsumesEscape()).toBe(true);
			editor.handleInput(ESC);
			expect(editor.vimMode).toBe("normal");
			expect(editor.getText()).toBe("alfa beta");
		});

		it("renders the selection in reverse video", () => {
			const editor = vimEditor("alfa beta");
			editor.handleInput("v");
			for (let i = 0; i < 3; i++) editor.handleInput("l");
			const frame = editor.render(40).join("\n");
			expect(frame).toContain("\x1b[7malfa\x1b[27m");
		});

		it("highlights the newline when the selection runs onto the next line", () => {
			const editor = vimEditor("alfa\nbeta");
			editor.handleInput("v");
			editor.handleInput("j");
			const frame = editor.render(40).join("\n");
			// The first row keeps its whole text plus a highlighted cell standing in for the newline.
			expect(frame).toContain("\x1b[7malfa\x1b[27m\x1b[7m \x1b[27m");
			// The second row highlights only the grapheme under the cursor.
			expect(frame).toContain("\x1b[7mb\x1b[27m");
		});

		it("renders an empty buffer without a selection artifact", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			editor.handleInput(ESC);
			editor.handleInput("v");
			expect(() => editor.render(40)).not.toThrow();
		});
	});

	describe("batched input", () => {
		it("replays a multi-key run as separate commands", () => {
			const editor = vimEditor("alfa beta gamma");
			// Batched stdin can deliver a whole run at once; each grapheme is still one command.
			editor.handleInput("wwx");
			expect(editor.getText()).toBe("alfa beta amma");
		});

		it("types the tail of a run that switched back to insert mode", () => {
			const editor = vimEditor("xyz");
			editor.handleInput("iabc");
			expect(editor.getText()).toBe("abcxyz");
			expect(editor.vimMode).toBe("insert");
		});
	});

	describe("autocomplete", () => {
		it("spends the first Escape dismissing the popup, the second leaving insert mode", async () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			const { promise: shown, resolve: resolveShown } = Promise.withResolvers<void>();
			editor.setAutocompleteProvider({
				async getSuggestions() {
					return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.onAutocompleteUpdate = resolveShown;

			editor.handleInput("/");
			await shown;
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput(ESC);
			expect(editor.isShowingAutocomplete()).toBe(false);
			expect(editor.vimMode).toBe("insert");

			editor.handleInput(ESC);
			expect(editor.vimMode).toBe("normal");
		});
	});

	describe("protected regions", () => {
		it("a visual delete that clips an atomic token removes the whole token", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[Image #\d+, \d+x\d+\]/g;
			editor.setVimMode(true);
			editor.setText("see [Image #1, 800x600] here");
			editor.handleInput(ESC);
			editor.handleInput("g");
			editor.handleInput("g");
			// Select "see [Ima" — the tail lands inside the placeholder.
			editor.handleInput("v");
			for (let i = 0; i < 7; i++) editor.handleInput("l");
			editor.handleInput("d");
			// The partially covered token went with it rather than leaving a corrupt fragment.
			expect(editor.getText()).toBe(" here");
		});

		it("x never splits an atomic token", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[Image #\d+, \d+x\d+\]/g;
			editor.setVimMode(true);
			editor.setText("[Image #1, 800x600]!");
			editor.handleInput(ESC);
			editor.handleInput("g");
			editor.handleInput("g");
			editor.handleInput("x");
			expect(editor.getText()).toBe("!");
		});
	});

	describe("toggling the setting", () => {
		it("drops back to insert mode so typing always works after a toggle", () => {
			const editor = vimEditor("alfa");
			expect(editor.vimMode).toBe("normal");
			// `gg` left the cursor at the head of the buffer, so plain typing inserts there.
			editor.setVimMode(false);
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("x");
			expect(editor.getText()).toBe("xalfa");

			editor.setVimMode(true);
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("y");
			expect(editor.getText()).toBe("xyalfa");
		});
	});

	describe("mode chrome", () => {
		it("reports the half-typed command so hosts can echo it", () => {
			const editor = vimEditor("alfa bravo charlie");
			expect(editor.vimPending).toBe("");
			editor.handleInput("2");
			expect(editor.vimPending).toBe("2");
			editor.handleInput("d");
			expect(editor.vimPending).toBe("2d");
			editor.handleInput(ESC);
			expect(editor.vimPending).toBe("");
		});

		it("reports the Visual selection height as it grows", () => {
			const editor = vimEditor("one\ntwo\nthree");
			expect(editor.vimSelectedLines).toBe(0);
			editor.handleInput("V");
			expect(editor.vimSelectedLines).toBe(1);
			editor.handleInput("j");
			expect(editor.vimSelectedLines).toBe(2);
			editor.handleInput(ESC);
			expect(editor.vimSelectedLines).toBe(0);
		});

		it("notifies on pending and selection changes, not just mode switches", () => {
			const editor = vimEditor("one\ntwo\nthree");
			const seen: string[] = [];
			editor.onVimModeChange = () => seen.push(`${editor.vimMode}:${editor.vimPending}:${editor.vimSelectedLines}`);

			editor.handleInput("2"); // pending only — mode unchanged
			editor.handleInput(ESC); // pending cleared — mode unchanged
			editor.handleInput("V"); // mode switch
			editor.handleInput("j"); // selection grows — mode and pending unchanged

			expect(seen).toEqual(["normal:2:0", "normal::0", "visual-line::1", "visual-line::2"]);
		});

		it("draws a block cursor in Normal and an underline cursor in Insert", () => {
			const editor = vimEditor("alfa");
			editor.focused = true;
			expect(editor.render(20).join("\n")).toContain("\x1b[7m");

			editor.handleInput("i");
			expect(editor.vimMode).toBe("insert");
			const insertFrame = editor.render(20).join("\n");
			expect(insertFrame).toContain("\x1b[4m");
			expect(insertFrame).not.toContain("\x1b[7m");
		});

		it("keeps the reverse-video cursor for non-modal editors", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("alfa");
			editor.focused = true;
			const frame = editor.render(20).join("\n");
			expect(frame).not.toContain("\x1b[4m");
			expect(editor.vimEnabled).toBe(false);
		});
	});

	describe("desired column across vertical motions", () => {
		// Vim remembers the column you left, so passing over a short line does not permanently
		// collapse it. The middle line is deliberately shorter than the cursor column.
		const buf = "alfa bravo charlie\nxy\ndelta echo foxtrot";

		it("restores the column after descending through a shorter line", () => {
			const editor = vimEditor(buf);
			for (let i = 0; i < 12; i++) editor.handleInput("l");
			expect(cursor(editor)).toEqual({ line: 0, col: 12 });

			editor.handleInput("j");
			// Clamped to the short line, but the desired column is remembered.
			expect(cursor(editor)).toEqual({ line: 1, col: 1 });

			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 2, col: 12 });
		});

		it("re-anchors the column after a horizontal motion", () => {
			const editor = vimEditor(buf);
			for (let i = 0; i < 12; i++) editor.handleInput("l");
			editor.handleInput("j");
			// `0` is a horizontal motion, so the remembered column is dropped.
			editor.handleInput("0");
			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 2, col: 0 });
		});

		it("keeps the column across a counted vertical motion", () => {
			const editor = vimEditor(buf);
			for (let i = 0; i < 12; i++) editor.handleInput("l");
			editor.handleInput("j");
			// The count prefix must not clear the column `j` established.
			editor.handleInput("1");
			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 2, col: 12 });
		});

		it("makes `$` a sticky end-of-line column", () => {
			const editor = vimEditor(buf);
			editor.handleInput("$");
			expect(cursor(editor)).toEqual({ line: 0, col: 17 });

			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 1, col: 1 });

			// Not the 17 from line 0 — the end of *this* line.
			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 2, col: 17 });
		});
	});
});
