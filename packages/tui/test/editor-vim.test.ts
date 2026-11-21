import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

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

		it("dap takes the trailing blank line, or the leading one at the end of the buffer", () => {
			const middle = vimEditor("one\ntwo\n\nthree");
			for (const key of "dap") middle.handleInput(key);
			expect(middle.getText()).toBe("three");

			const end = vimEditor("one\ntwo\n\nthree");
			end.handleInput("G");
			for (const key of "dap") end.handleInput(key);
			expect(end.getText()).toBe("one\ntwo");
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

		it("counted r refuses to cut an atomic token", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[Image #\d+\]/g;
			editor.setVimMode(true);
			editor.setText("ab[Image #1] tail");
			editor.handleInput(ESC);
			editor.handleInput("g");
			editor.handleInput("g");
			editor.handleInput("5");
			editor.handleInput("r");
			editor.handleInput("x");
			expect(editor.getText()).toBe("ab[Image #1] tail");
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

	describe("find and till", () => {
		it("lands f and F on the match, and t and T on the adjacent grapheme", () => {
			const editor = vimEditor("abcde");
			editor.handleInput("f");
			editor.handleInput("c");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });

			editor.handleInput("F");
			editor.handleInput("a");
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });

			editor.handleInput("t");
			editor.handleInput("c");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });

			editor.handleInput("$");
			editor.handleInput("T");
			editor.handleInput("c");
			expect(cursor(editor)).toEqual({ line: 0, col: 3 });
		});

		it("counts occurrences and does not cross lines", () => {
			const editor = vimEditor("abaca\nzzz");
			editor.handleInput("2");
			editor.handleInput("f");
			editor.handleInput("a");
			expect(cursor(editor)).toEqual({ line: 0, col: 4 });

			editor.handleInput("f");
			editor.handleInput("z");
			expect(cursor(editor)).toEqual({ line: 0, col: 4 });
		});

		it("includes the find target and stops short of the till target", () => {
			const found = vimEditor("abcde");
			found.handleInput("d");
			found.handleInput("f");
			found.handleInput("c");
			expect(found.getText()).toBe("de");

			const till = vimEditor("abcde");
			till.handleInput("d");
			till.handleInput("t");
			till.handleInput("c");
			expect(till.getText()).toBe("cde");
		});

		it("repeats with semicolon and reverses with comma", () => {
			const editor = vimEditor("a-b-c");
			editor.handleInput("f");
			editor.handleInput("-");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });
			editor.handleInput(";");
			expect(cursor(editor)).toEqual({ line: 0, col: 3 });
			editor.handleInput(",");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });
		});

		it("repeats a till past the target it just landed beside", () => {
			const editor = vimEditor("a,b,c,d");
			editor.handleInput("t");
			editor.handleInput(",");
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });
			editor.handleInput(";");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });
		});

		it("cancels a half-typed find without moving, and finds a digit", () => {
			const editor = vimEditor("a1b");
			editor.handleInput("f");
			expect(editor.vimConsumesEscape()).toBe(true);
			editor.handleInput(ESC);
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });
			expect(editor.vimConsumesEscape()).toBe(false);

			editor.handleInput("f");
			editor.handleInput("1");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });
		});

		it("finds a multi-code-unit grapheme", () => {
			const text = "a😀b";
			const editor = vimEditor(text);
			editor.handleInput("f");
			editor.handleInput("😀");
			expect(cursor(editor)).toEqual({ line: 0, col: text.indexOf("😀") });
		});
	});

	describe("replace", () => {
		it("replaces the character under the cursor and stays in normal mode", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("l");
			editor.handleInput("r");
			expect(editor.vimConsumesEscape()).toBe(true);
			editor.handleInput("X");
			expect(editor.getText()).toBe("aXcd");
			expect(editor.vimMode).toBe("normal");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });
		});

		it("replaces a count and refuses to run past the line", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("3");
			editor.handleInput("r");
			editor.handleInput("z");
			expect(editor.getText()).toBe("zzzd");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });

			editor.handleInput("$");
			editor.handleInput("2");
			editor.handleInput("r");
			editor.handleInput("Q");
			expect(editor.getText()).toBe("zzzd");
		});

		it("overwrites in replace mode, restores on backspace, and steps back on Escape", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("R");
			expect(editor.vimMode).toBe("replace");
			editor.handleInput("XY");
			expect(editor.getText()).toBe("XYcd");
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("Xbcd");
			editor.handleInput("Z");
			expect(editor.getText()).toBe("XZcd");
			editor.handleInput(ESC);
			expect(editor.vimMode).toBe("normal");
			expect(cursor(editor)).toEqual({ line: 0, col: 1 });
			editor.handleInput("q");
			expect(editor.getText()).toBe("XZcd");
		});

		it("appends once replace mode runs past the end of the line", () => {
			const editor = vimEditor("ab");
			editor.handleInput("$");
			editor.handleInput("R");
			editor.handleInput("YZ");
			expect(editor.getText()).toBe("aYZ");
		});

		it("turns a recalled prompt into a draft once replace mode overwrites it", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			editor.addToHistory("previous");
			editor.handleInput(UP);
			expect(editor.getText()).toBe("previous");
			editor.handleInput(ESC);
			editor.handleInput("0");
			editor.handleInput("R");
			editor.handleInput("X");
			editor.handleInput(ESC);
			editor.handleInput("i");
			editor.handleInput(DOWN);
			expect(editor.getText()).toBe("Xrevious");
		});

		it("keeps appending after Right at the end of the line", () => {
			const editor = vimEditor("abc");
			editor.handleInput("R");
			editor.handleInput("xyz");
			editor.handleInput("\x1b[C");
			editor.handleInput("w");
			expect(editor.getText()).toBe("xyzw");
		});

		it("does not restore a replaced character into text set after the overwrite", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("R");
			editor.handleInput("xy");
			editor.setText("hyllo");
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[D");
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("hyllo");
		});
	});

	describe("bracket match", () => {
		it("jumps between a nested pair and back", () => {
			const editor = vimEditor("(a(b)c)");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 0, col: 6 });
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 0, col: 4 });
		});

		it("matches across lines and deletes through the pair", () => {
			const editor = vimEditor("(\n)");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
			editor.handleInput("%");
			editor.handleInput("d");
			editor.handleInput("%");
			expect(editor.getText()).toBe("");
		});

		it("scans forward on the line and stays put when unmatched", () => {
			const editor = vimEditor("ab(c");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });
			expect(editor.getText()).toBe("ab(c");
		});

		it("jumps between quotes and ignores an escaped one", () => {
			const doubled = vimEditor('say "hi"');
			doubled.handleInput("f");
			doubled.handleInput('"');
			doubled.handleInput("%");
			expect(cursor(doubled)).toEqual({ line: 0, col: 7 });
			doubled.handleInput("%");
			expect(cursor(doubled)).toEqual({ line: 0, col: 4 });

			const single = vimEditor("say 'hi'");
			single.handleInput("%");
			expect(cursor(single)).toEqual({ line: 0, col: 7 });

			const escaped = vimEditor('say \\"hi\\"');
			escaped.handleInput("%");
			expect(cursor(escaped)).toEqual({ line: 0, col: 0 });
			expect(escaped.getText()).toBe('say \\"hi\\"');
		});

		it("goes to a percentage of the buffer when counted", () => {
			const editor = vimEditor("(a)\nb\n  c\nd");
			editor.handleInput("5");
			editor.handleInput("0");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
			editor.handleInput("7");
			editor.handleInput("5");
			editor.handleInput("%");
			expect(cursor(editor)).toEqual({ line: 2, col: 2 });
		});
	});

	describe("paragraph motions", () => {
		it("lands on blank-line boundaries and steps back", () => {
			const editor = vimEditor("aaa\n\nbbb\n\nccc");
			editor.handleInput("}");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
			editor.handleInput("}");
			expect(cursor(editor)).toEqual({ line: 3, col: 0 });
			editor.handleInput("{");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
		});

		it("deletes the paragraph text and leaves the boundary line", () => {
			const editor = vimEditor("aaa\n\nbbb");
			editor.handleInput("d");
			editor.handleInput("}");
			expect(editor.getText()).toBe("\nbbb");
		});

		it("clears through the end of a prompt that has no blank line", () => {
			const one = vimEditor("hello world");
			one.handleInput("d");
			one.handleInput("}");
			expect(one.getText()).toBe("");

			const two = vimEditor("one\ntwo");
			two.handleInput("}");
			expect(cursor(two)).toEqual({ line: 1, col: 2 });
			two.handleInput("g");
			two.handleInput("g");
			two.handleInput("d");
			two.handleInput("}");
			expect(two.getText()).toBe("");
		});

		it("does not restore the sticky column after a find", () => {
			const editor = vimEditor("abcdefghij\nab");
			for (let i = 0; i < 8; i++) editor.handleInput("l");
			editor.handleInput("j");
			editor.handleInput("k");
			editor.handleInput("F");
			editor.handleInput("a");
			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
		});
	});

	describe("join", () => {
		it("inserts one space, two after a sentence, and none before a closing paren", () => {
			const spaced = vimEditor("foo\n  bar");
			spaced.handleInput("J");
			expect(spaced.getText()).toBe("foo bar");
			expect(cursor(spaced)).toEqual({ line: 0, col: 3 });

			const sentence = vimEditor("end.\nnext");
			sentence.handleInput("J");
			expect(sentence.getText()).toBe("end.  next");

			const paren = vimEditor("call(\n  )");
			paren.handleInput("J");
			expect(paren.getText()).toBe("call()");
		});

		it("keeps a trailing space, joins a count, and does nothing on the last line", () => {
			const editor = vimEditor("foo \nbar\nbaz");
			editor.handleInput("J");
			expect(editor.getText()).toBe("foo bar\nbaz");
			editor.handleInput("g");
			editor.handleInput("g");
			editor.handleInput("3");
			editor.handleInput("J");
			expect(editor.getText()).toBe("foo bar baz");

			const last = vimEditor("only");
			last.handleInput("J");
			expect(last.getText()).toBe("only");
		});

		it("adds no space when the joined line is empty or blank", () => {
			const empty = vimEditor("foo\n\nbar");
			empty.handleInput("J");
			expect(empty.getText()).toBe("foo\nbar");

			const blank = vimEditor("foo\n   \nbar");
			blank.handleInput("J");
			expect(blank.getText()).toBe("foo\nbar");
		});
	});

	describe("indent", () => {
		it("shifts by two spaces, honors a count, and stops at the margin", () => {
			const editor = vimEditor("a\nb");
			editor.handleInput(">");
			editor.handleInput(">");
			expect(editor.getText()).toBe("  a\nb");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });
			editor.handleInput("2");
			editor.handleInput(">");
			editor.handleInput(">");
			expect(editor.getText()).toBe("    a\n  b");
			editor.handleInput("g");
			editor.handleInput("g");
			editor.handleInput("<");
			editor.handleInput("<");
			expect(editor.getText()).toBe("  a\n  b");
			editor.handleInput("<");
			editor.handleInput("<");
			expect(editor.getText()).toBe("a\n  b");
			editor.handleInput("<");
			editor.handleInput("<");
			expect(editor.getText()).toBe("a\n  b");
		});

		it("shifts the lines a motion covers, and a visual selection", () => {
			const moved = vimEditor("a\nb\nc");
			moved.handleInput(">");
			moved.handleInput("j");
			expect(moved.getText()).toBe("  a\n  b\nc");

			const visual = vimEditor("a\nb");
			visual.handleInput("V");
			visual.handleInput("j");
			visual.handleInput(">");
			expect(visual.getText()).toBe("  a\n  b");
			expect(visual.vimMode).toBe("normal");
		});

		it("indents a text object instead of deleting it", () => {
			const editor = vimEditor("one\ntwo\n\nthree");
			editor.handleInput(">");
			editor.handleInput("i");
			editor.handleInput("p");
			expect(editor.getText()).toBe("  one\n  two\n\nthree");
		});

		it("leaves empty lines unindented", () => {
			const editor = vimEditor("one\n\ntwo");
			editor.handleInput(">");
			editor.handleInput("G");
			expect(editor.getText()).toBe("  one\n\n  two");
		});

		it("cancels a pending r on an arrow, and treats space as a find target", () => {
			const replaced = vimEditor("abc");
			replaced.handleInput("r");
			replaced.handleInput("\x1b[D");
			expect(replaced.getText()).toBe("abc");
			expect(replaced.vimPending).toBe("");

			const found = vimEditor("a b");
			found.handleInput("f");
			found.handleInput(" ");
			expect(cursor(found)).toEqual({ line: 0, col: 1 });
		});

		it("cancels a pending command when Enter submits", () => {
			const submitted: string[] = [];
			const editor = vimEditor("abc");
			editor.onSubmit = text => {
				submitted.push(text);
			};
			editor.handleInput("r");
			editor.handleInput("\r");
			expect(submitted).toEqual(["abc"]);
			expect(editor.vimPending).toBe("");
		});

		it("overwrites the rest of a batched replace", () => {
			const editor = vimEditor("abcd");
			editor.handleInput("RXY");
			expect(editor.getText()).toBe("XYcd");
			expect(editor.vimMode).toBe("replace");
		});

		it("does not restore a replace after another edit moves the bytes", () => {
			const editor = vimEditor("abc");
			editor.handleInput("R");
			editor.handleInput("X");
			expect(editor.getText()).toBe("Xbc");
			editor.handleInput("\x1b[H");
			editor.handleInput("\x1b[3~");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("bc");
			expect(editor.vimMode).toBe("replace");
		});

		it("does not restore the sticky column after r or R", () => {
			const replaced = vimEditor("abcdefghij\nab\nabcdefghij");
			for (let i = 0; i < 8; i++) replaced.handleInput("l");
			replaced.handleInput("j");
			replaced.handleInput("r");
			replaced.handleInput("X");
			replaced.handleInput("j");
			expect(cursor(replaced)).toEqual({ line: 2, col: 1 });

			const mode = vimEditor("abcdefghij\nab\nabcdefghij");
			for (let i = 0; i < 8; i++) mode.handleInput("l");
			mode.handleInput("j");
			mode.handleInput("R");
			mode.handleInput("Z");
			mode.handleInput(ESC);
			mode.handleInput("j");
			expect(cursor(mode)).toEqual({ line: 2, col: 1 });
		});
	});

	describe("dot repeat", () => {
		const press = (editor: Editor, ...keys: string[]) => {
			for (const key of keys) editor.handleInput(key);
		};

		it("repeats an operator change and undoes it in one step", () => {
			const editor = vimEditor("alfa beta gamma");
			press(editor, "d", "w", ".");
			expect(editor.getText()).toBe("gamma");
			press(editor, "u");
			expect(editor.getText()).toBe("beta gamma");
		});

		it("replaces the original count with the count on `.`, which later `.` keeps", () => {
			const editor = vimEditor("a b c d e f g h i");
			press(editor, "2", "d", "w");
			expect(editor.getText()).toBe("c d e f g h i");
			press(editor, "3", ".");
			expect(editor.getText()).toBe("f g h i");
			press(editor, ".");
			expect(editor.getText()).toBe("i");
		});

		it("replays a change's typed text, with the live session and the repeat each one undo step", () => {
			const editor = vimEditor("alfa beta gamma");
			press(editor, "c", "w", "new", ESC, "w", ".");
			expect(editor.getText()).toBe("new new gamma");
			press(editor, "u");
			expect(editor.getText()).toBe("new beta gamma");
			press(editor, "u");
			expect(editor.getText()).toBe("alfa beta gamma");
		});

		it("multiplies an insert's text by the count on `.`", () => {
			const editor = vimEditor("x");
			press(editor, "A", "!", ESC);
			expect(editor.getText()).toBe("x!");
			press(editor, "3", ".");
			expect(editor.getText()).toBe("x!!!!");
			press(editor, ".");
			expect(editor.getText()).toBe("x!!!!!!!");
		});

		it("opens one line per copy when `.` repeats `o` with a count", () => {
			const editor = vimEditor("a");
			press(editor, "o", "b", ESC, "2", ".");
			expect(editor.getText()).toBe("a\nb\nb\nb");
			expect(cursor(editor)).toEqual({ line: 3, col: 0 });
		});

		it("replays Backspace past the insert point", () => {
			const editor = vimEditor("abcd\nefgh");
			press(editor, "A", BACKSPACE, BACKSPACE, "X", ESC);
			expect(editor.getText()).toBe("abX\nefgh");
			press(editor, "j", ".");
			expect(editor.getText()).toBe("abX\nefX");
		});

		it("splits redo and undo at an arrow key inside Insert mode", () => {
			const editor = vimEditor("one\ntwo");
			press(editor, "I", "x", LEFT, "y", ESC);
			expect(editor.getText()).toBe("yxone\ntwo");
			press(editor, "j", ".");
			expect(editor.getText()).toBe("yxone\nytwo");
			press(editor, "u");
			expect(editor.getText()).toBe("yxone\ntwo");
			press(editor, "u");
			expect(editor.getText()).toBe("xone\ntwo");
			press(editor, "u");
			expect(editor.getText()).toBe("one\ntwo");
		});

		it("overwrites rather than inserts when repeating Replace mode", () => {
			const editor = vimEditor("abcd\nefgh");
			press(editor, "R", "xy", ESC, "j", "0", ".");
			expect(editor.getText()).toBe("xycd\nxygh");
		});

		it("repeats a Visual change over the same shape at the cursor", () => {
			const lines = vimEditor("a\nb\nc\nd\ne");
			press(lines, "V", "j", "d");
			expect(lines.getText()).toBe("c\nd\ne");
			press(lines, ".");
			expect(lines.getText()).toBe("e");

			const chars = vimEditor("abcdef");
			press(chars, "v", "l", "d");
			expect(chars.getText()).toBe("cdef");
			press(chars, ".");
			expect(chars.getText()).toBe("ef");
		});

		it("ignores yanks and undo when choosing what `.` repeats", () => {
			const editor = vimEditor("abcdef");
			press(editor, "x");
			expect(editor.getText()).toBe("bcdef");
			press(editor, "y", "w", "u");
			expect(editor.getText()).toBe("abcdef");
			press(editor, ".");
			expect(editor.getText()).toBe("bcdef");
		});

		it("replays an insert that replaced one emoji with another without splitting a surrogate", () => {
			const editor = vimEditor("😀 abc\n😇 def");
			press(editor, "l", "i", BACKSPACE, "😇", ESC, "j", "l", ".");
			expect(editor.getText()).toBe("😇 abc\n😇 def");
		});

		it("restores the pre-insert text in one undo after the session outgrows the undo stack", () => {
			const editor = vimEditor("seed");
			press(editor, "i", ..." ".repeat(130), ESC, "u");
			expect(editor.getText()).toBe("seed");
		});

		it("splits redo and undo on native caret moves inside Insert mode", () => {
			const editor = vimEditor("abcdef");
			press(editor, "i", "X");
			editor.applyHostEdit({ len: 7, from: 5, to: 5, cursor: 5, text: "" });
			press(editor, "Y", ESC);
			expect(editor.getText()).toBe("XabcdYef");
			press(editor, "u");
			expect(editor.getText()).toBe("Xabcdef");
			press(editor, "u");
			expect(editor.getText()).toBe("abcdef");
			press(editor, ".");
			expect(editor.getText()).toBe("Yabcdef");
		});

		it("treats the initial Insert session on a fresh editor as a whole-session change", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			press(editor, ..."hello world", ESC);
			expect(editor.getText()).toBe("hello world");
			press(editor, ".");
			expect(editor.getText()).toBe("hello worlhello worldd");
			press(editor, "u");
			expect(editor.getText()).toBe("hello world");
			press(editor, "u");
			expect(editor.getText()).toBe("");
		});

		it("preserves newlines in Replace mode recordings", () => {
			const editor = vimEditor("abcd\nefgh");
			press(editor, "R", "X", "\n", "Y", ESC);
			expect(editor.getText()).toBe("X\nYcd\nefgh");
			press(editor, "j", "0", ".");
			expect(editor.getText()).toBe("X\nYcd\nX\nYgh");
			press(editor, "u");
			expect(editor.getText()).toBe("X\nYcd\nefgh");
		});

		it("does not replace the last change when an edit command is a no-op", () => {
			const editor = vimEditor("alfa\nbeta");
			press(editor, "x");
			expect(editor.getText()).toBe("lfa\nbeta");
			press(editor, "G", "J");
			expect(editor.getText()).toBe("lfa\nbeta");
			press(editor, "g", "g", ".");
			expect(editor.getText()).toBe("fa\nbeta");
		});

		it("starts a fresh tracked Insert session after a submitted draft", () => {
			const editor = vimEditor("");
			press(editor, "i", ..."one");
			editor.submit();
			press(editor, ..."two", ESC);
			expect(editor.getText()).toBe("two");
			press(editor, ".");
			expect(editor.getText()).toBe("twtwoo");
			press(editor, "u");
			expect(editor.getText()).toBe("two");
			press(editor, "u");
			expect(editor.getText()).toBe("");
		});

		it("deletes whole graphemes at a multiline Visual repeat's end", () => {
			const editor = vimEditor("a\nb\nc\n😀x");
			press(editor, "v", "j", "d", "j", ".");
			expect(editor.getText()).toBe("\nx");
		});

		it("repeats a find that ended on `.` as its target", () => {
			const editor = vimEditor("a.b.c");
			press(editor, "d", "f", ".");
			expect(editor.getText()).toBe("b.c");
			press(editor, ".");
			expect(editor.getText()).toBe("c");
		});

		it("replays a backspace masked by retyping the same grapheme", () => {
			const editor = vimEditor("abX\ncdY");
			press(editor, "l", "l", "i", BACKSPACE, "b", "b", ESC);
			expect(editor.getText()).toBe("abbX\ncdY");
			press(editor, "j", ".");
			expect(editor.getText()).toBe("abbX\ncbbY");
		});

		it("does not coalesce the first session keystroke with pre-Vim typing", () => {
			const editor = new Editor(defaultEditorTheme);
			press(editor, ..."abc");
			editor.setVimMode(true);
			press(editor, ..."def", ESC);
			expect(editor.getText()).toBe("abcdef");
			press(editor, "u");
			expect(editor.getText()).toBe("abc");
		});

		it("starts a fresh tracked Replace session after a submitted draft", () => {
			const editor = vimEditor("");
			press(editor, "R", ..."one");
			editor.submit();
			press(editor, ..."two", ESC);
			expect(editor.getText()).toBe("two");
			press(editor, ".");
			expect(editor.getText()).toBe("twtwo");
			press(editor, "u");
			expect(editor.getText()).toBe("two");
			press(editor, "u");
			expect(editor.getText()).toBe("");
		});
	});

	describe("WORD motions", () => {
		it("treats punctuation as part of a WORD", () => {
			const editor = vimEditor("foo-bar baz.qux");
			editor.handleInput("W");
			expect(cursor(editor)).toEqual({ line: 0, col: 8 });

			editor.handleInput("0E");
			expect(cursor(editor)).toEqual({ line: 0, col: 6 });

			editor.handleInput("$B");
			expect(cursor(editor)).toEqual({ line: 0, col: 8 });
		});

		it("counts WORDs across newlines and blank lines", () => {
			const editor = vimEditor("foo-bar baz.qux\n\nlast:item end");
			editor.handleInput("2W");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
			editor.handleInput("W");
			expect(cursor(editor)).toEqual({ line: 2, col: 0 });
			editor.handleInput("B");
			expect(cursor(editor)).toEqual({ line: 1, col: 0 });
			editor.handleInput("2B");
			expect(cursor(editor)).toEqual({ line: 0, col: 0 });
			editor.handleInput("3E");
			expect(cursor(editor)).toEqual({ line: 2, col: 8 });
		});

		it("cW preserves the separator while replacing a punctuation-containing WORD", () => {
			const editor = vimEditor("foo-bar baz.qux tail");
			editor.handleInput("cW");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("fresh");
			expect(editor.getText()).toBe("fresh baz.qux tail");

			const single = vimEditor("x next.word");
			single.handleInput("cWnew");
			expect(single.getText()).toBe("new next.word");
		});

		it("applies WORD motion counts to operators", () => {
			const editor = vimEditor("a-b c.d e:f g/h keep");
			editor.handleInput("d4W");
			expect(editor.getText()).toBe("keep");
		});

		it("dB excludes the current WORD when deleting backward across a newline", () => {
			const editor = vimEditor("foo-bar\nbaz.qux");
			editor.handleInput("WdB");
			expect(editor.getText()).toBe("baz.qux");
		});

		it("stops a W operator at the end of its line like Vim's fwd_word(eol)", () => {
			// Vim 9.2 and Neovim: `dW` on a line's last WORD keeps the line break; `yW` yanks charwise.
			const deleted = vimEditor("foo\nbar");
			deleted.handleInput("dW");
			expect(deleted.getText()).toBe("\nbar");

			const yanked = vimEditor("foo\nbar");
			yanked.handleInput("yWjP");
			expect(yanked.getText()).toBe("foo\nfoobar");
		});

		it("deletes a leading empty line linewise before a whitespace-only one", () => {
			const editor = vimEditor("\n   \nfoo");
			editor.handleInput("dW");
			expect(editor.getText()).toBe("   \nfoo");
		});

		it("preserves trailing whitespace when W has no following WORD", () => {
			const editor = vimEditor("\n   ");
			editor.handleInput("dW");
			expect(editor.getText()).toBe("   ");
		});

		it("includes the final grapheme of a Visual E selection", () => {
			const editor = vimEditor("foo-bar baz");
			editor.handleInput("vEd");
			expect(editor.getText()).toBe(" baz");
			expect(editor.vimMode).toBe("normal");
		});
	});

	describe("linewise changes and line motions", () => {
		it("cc keeps the changed line in the register as a whole line", () => {
			const editor = vimEditor("alpha\nbeta");
			editor.handleInput("cc");
			editor.handleInput(ESC);
			editor.handleInput("jp");
			expect(editor.getText()).toBe("\nbeta\nalpha");
		});

		it("cj clears both lines entirely even from mid-line", () => {
			const editor = vimEditor("  abc\ndef\nghi");
			editor.handleInput("lllcj");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("x");
			expect(editor.getText()).toBe("x\nghi");
		});

		it("S is cc, including its count and dot repeat", () => {
			const editor = vimEditor("a\nb\nc\nd\ne");
			editor.handleInput("2S");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("x");
			editor.handleInput(ESC);
			expect(editor.getText()).toBe("x\nc\nd\ne");
			editor.handleInput("j.");
			expect(editor.getText()).toBe("x\nx\ne");
		});

		it("s substitutes count characters without touching the line", () => {
			const editor = vimEditor("abcd\nnext");
			editor.handleInput("2s");
			editor.handleInput("X");
			expect(editor.getText()).toBe("Xcd\nnext");
		});

		it("an operator before S is cancelled", () => {
			const editor = vimEditor("abc\ndef");
			editor.handleInput("dS");
			expect(editor.getText()).toBe("abc\ndef");
			expect(editor.vimMode).toBe("normal");
		});

		it("Visual S changes whole lines from a charwise selection", () => {
			const editor = vimEditor("alpha beta\ngamma\ndelta");
			editor.handleInput("wvjS");
			expect(editor.vimMode).toBe("insert");
			editor.handleInput("x");
			expect(editor.getText()).toBe("x\ndelta");
		});

		it("- and + move by lines onto the first non-blank", () => {
			const editor = vimEditor("  one\n    two\nthree");
			editor.handleInput("+");
			expect(cursor(editor)).toEqual({ line: 1, col: 4 });
			editor.handleInput("+");
			expect(cursor(editor)).toEqual({ line: 2, col: 0 });
			editor.handleInput("2-");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });
		});

		it("-, + and _ are linewise under an operator", () => {
			const up = vimEditor("one\ntwo\nthree");
			up.handleInput("jld-");
			expect(up.getText()).toBe("three");
			const down = vimEditor("one\ntwo\nthree");
			down.handleInput("lld+");
			expect(down.getText()).toBe("three");
			const line = vimEditor("one\ntwo\nthree");
			line.handleInput("l2d_");
			expect(line.getText()).toBe("three");
		});
	});

	// Expected results below were taken from Vim 9.2 (`vim -Nu NONE`) for the same keys and text.
	describe("undo, redo, and dot repeat", () => {
		it("repeats text typed in the same input chunk as the change that opened it", () => {
			// Terminals batch fast keystrokes: `ccQ` can arrive as one read.
			const editor = vimEditor("aa\nbb");
			editor.handleInput("ccQ");
			editor.handleInput(ESC);
			editor.handleInput("j.");
			expect(editor.getText()).toBe("Q\nQ");
		});

		it("takes a count for u and redoes with Ctrl-R until the next edit", () => {
			const editor = vimEditor("one two three four");
			editor.handleInput("dwdwdw");
			editor.handleInput("2u");
			expect(editor.getText()).toBe("two three four");
			editor.handleInput("\x12");
			expect(editor.getText()).toBe("three four");
			editor.handleInput("x");
			editor.handleInput("\x12");
			expect(editor.getText()).toBe("hree four");
		});

		it("puts the cursor back where the undone change began", () => {
			const visual = vimEditor("alpha beta\ngamma");
			visual.handleInput("vjdu");
			expect(cursor(visual)).toEqual({ line: 0, col: 0 });
			const put = vimEditor("alpha beta\ngamma");
			put.handleInput("wyyPu");
			expect(cursor(put)).toEqual({ line: 0, col: 6 });
		});

		it("repeats a counted insert on Escape as one undo step", () => {
			const editor = vimEditor("ab\ncd");
			editor.handleInput("3ix");
			editor.handleInput(ESC);
			expect(editor.getText()).toBe("xxxab\ncd");
			expect(cursor(editor)).toEqual({ line: 0, col: 2 });
			editor.handleInput("j0.");
			expect(editor.getText()).toBe("xxxab\nxxxcd");
			editor.handleInput("u");
			expect(editor.getText()).toBe("xxxab\ncd");
			const lines = vimEditor("a");
			lines.handleInput("2ofoo");
			lines.handleInput(ESC);
			expect(lines.getText()).toBe("a\nfoo\nfoo");
		});
	});

	describe("Vim word motions across lines", () => {
		it("w, b, e, and ge cross line breaks and skip indent", () => {
			const editor = vimEditor("foo bar\n  baz qux");
			editor.handleInput("2w");
			expect(cursor(editor)).toEqual({ line: 1, col: 2 });
			editor.handleInput("b");
			expect(cursor(editor)).toEqual({ line: 0, col: 4 });
			editor.handleInput("2e");
			expect(cursor(editor)).toEqual({ line: 1, col: 4 });
			editor.handleInput("ge");
			expect(cursor(editor)).toEqual({ line: 0, col: 6 });
		});

		it("stops dw at the end of the line and keeps the line break", () => {
			const editor = vimEditor("a b\nc");
			editor.handleInput("wdw");
			expect(editor.getText()).toBe("a \nc");
		});

		it("makes a multi-line delete from the indent linewise (2D, d2w)", () => {
			const dollar = vimEditor("alpha\n  beta\ngamma");
			dollar.handleInput("2D");
			expect(dollar.getText()).toBe("gamma");
			const words = vimEditor("alpha beta\ndelta\nzeta");
			words.handleInput("3dw");
			expect(words.getText()).toBe("zeta");
		});

		it("cancels dk on the first line instead of deleting it", () => {
			const editor = vimEditor("one\ntwo");
			editor.handleInput("dk");
			expect(editor.getText()).toBe("one\ntwo");
		});
	});

	describe("Vim editing commands", () => {
		it("X, Y, and ~ act like dh, yy, and a stepping case toggle", () => {
			const editor = vimEditor("abcd\nnext");
			editor.handleInput("$2X");
			expect(editor.getText()).toBe("ad\nnext");
			editor.handleInput("Yp");
			expect(editor.getText()).toBe("ad\nad\nnext");
			editor.handleInput("0~~");
			expect(editor.getText()).toBe("ad\nAD\nnext");
		});

		it("applies gU, gu, and g~ over motions, lines, and Visual selections", () => {
			const editor = vimEditor("alpha beta\nGamma Delta");
			editor.handleInput("gUiw");
			expect(editor.getText()).toBe("ALPHA beta\nGamma Delta");
			editor.handleInput("jguu");
			expect(editor.getText()).toBe("ALPHA beta\ngamma delta");
			editor.handleInput("kg~~");
			expect(editor.getText()).toBe("alpha BETA\ngamma delta");
			editor.handleInput("jveU");
			expect(editor.getText()).toBe("alpha BETA\nGAMMA delta");
		});

		it("joins without touching whitespace on gJ, in Normal and Visual mode", () => {
			const normal = vimEditor("a\n  b");
			normal.handleInput("gJ");
			expect(normal.getText()).toBe("a  b");
			const visual = vimEditor("a\n  b\nc");
			visual.handleInput("VjgJ");
			expect(visual.getText()).toBe("a  b\nc");
		});

		it("selects the line break with v$ and replaces a selection with Visual p", () => {
			const joined = vimEditor("ab\ncd");
			joined.handleInput("v$d");
			expect(joined.getText()).toBe("cd");
			const swapped = vimEditor("alpha beta");
			swapped.handleInput("yiwwviwp");
			expect(swapped.getText()).toBe("alpha alpha");
			// `p` leaves the replaced word in the register.
			swapped.handleInput("0P");
			expect(swapped.getText()).toBe("betaalpha alpha");
		});

		it("puts with gp and leaves the cursor after the text", () => {
			const editor = vimEditor("one\ntwo");
			editor.handleInput("yyjgp");
			expect(editor.getText()).toBe("one\ntwo\none");
			expect(cursor(editor)).toEqual({ line: 2, col: 0 });
		});

		it("reselects with gv and reinserts with gi", () => {
			const editor = vimEditor("alpha beta");
			editor.handleInput("vl");
			editor.handleInput(ESC);
			editor.handleInput("$gvd");
			expect(editor.getText()).toBe("pha beta");
			editor.handleInput("wiX");
			editor.handleInput(ESC);
			editor.handleInput("0giY");
			expect(editor.getText()).toBe("pha XYbeta");
		});
	});

	describe("Vim registers", () => {
		it("keeps named, yank, and black-hole registers apart from the unnamed one", () => {
			const editor = vimEditor("alpha\nbeta\ngamma");
			editor.handleInput('"ayy');
			editor.handleInput("jdd");
			editor.handleInput('"ap');
			expect(editor.getText()).toBe("alpha\ngamma\nalpha");
			editor.handleInput('"_ddp');
			expect(editor.getText()).toBe("alpha\ngamma\nbeta");
			// Only an unnamed yank fills `"0`; it survives the delete that follows.
			const yank = vimEditor("alpha\nbeta\ngamma");
			yank.handleInput('yyjdd"0p');
			expect(yank.getText()).toBe("alpha\ngamma\nalpha");
		});

		it("appends with an uppercase register and shifts deletes through 1-9", () => {
			const editor = vimEditor("one\ntwo\nthree");
			editor.handleInput('"ayiwj"Ayiw');
			editor.handleInput('G"ap');
			expect(editor.getText()).toBe("one\ntwo\ntonetwohree");
			const shifted = vimEditor("one\ntwo\nthree");
			shifted.handleInput('dddd"2p');
			expect(shifted.getText()).toBe("three\none");
		});

		it('reports which register a yank named, and "+p puts the clipboard', async () => {
			const yanked: Array<string | undefined> = [];
			const editor = vimEditor("alpha beta");
			editor.onYank = (_text, register) => yanked.push(register);
			editor.handleInput('yw"+yw"adw');
			// A plain yank, then `"+`; the delete into `"a` is no clipboard write.
			expect(yanked).toEqual([undefined, "+"]);
			// Clipboard text ending in a newline puts as a whole line, as Vim does.
			editor.readClipboard = async () => "from clipboard\n";
			const rendered = Promise.withResolvers<void>();
			editor.requestRender = () => rendered.resolve();
			editor.handleInput('"+p');
			// The read is still in flight when `p` arrives; the put lands with it and asks for a repaint.
			await rendered.promise;
			expect(editor.getText()).toBe("beta\nfrom clipboard");
		});
	});

	describe("Vim screen rows, text objects ahead, history search", () => {
		it("gj/gk move by wrapped rows and keep the screen column; j/k stay on lines", () => {
			const editor = vimEditor("aaaa bbbb cccc dddd eeee ffff gggg hhhh\nxyz");
			editor.render(20);
			editor.handleInput("llgj");
			expect(cursor(editor)).toEqual({ line: 0, col: 17 });
			editor.handleInput("gjgk");
			expect(cursor(editor)).toEqual({ line: 0, col: 17 });
			editor.handleInput("j");
			expect(cursor(editor)).toEqual({ line: 1, col: 2 });
		});

		it("brackets ahead of the cursor are the object when none encloses it, as in Vim 9.2", () => {
			const editor = vimEditor("foo (bar) baz");
			editor.handleInput("di(");
			expect(editor.getText()).toBe("foo () baz");
			const nextLine = vimEditor("foo\n(bar)");
			nextLine.handleInput("ci(X");
			expect(nextLine.getText()).toBe("foo\n(X)");
			// A stray closer ahead of the opener cancels it out, so nothing is selected.
			const unbalanced = vimEditor("foo) (bar)");
			unbalanced.handleInput("di(");
			expect(unbalanced.getText()).toBe("foo) (bar)");
		});

		it("/ walks older prompts that match, n/N step through them, and N past the newest restores the draft", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVimMode(true);
			for (const prompt of ["fix the parser bug", "write docs", "parser tests please"]) editor.addToHistory(prompt);
			editor.setText("my draft");
			editor.handleInput(ESC);
			editor.handleInput("/parser");
			expect(editor.vimPending).toBe("/parser");
			editor.handleInput("\r");
			expect(editor.getText()).toBe("parser tests please");
			editor.handleInput("n");
			expect(editor.getText()).toBe("fix the parser bug");
			expect(cursor(editor)).toEqual({ line: 0, col: 8 });
			// No older match: the entry stays.
			editor.handleInput("n");
			expect(editor.getText()).toBe("fix the parser bug");
			editor.handleInput("NN");
			expect(editor.getText()).toBe("my draft");
			expect(editor.vimMode).toBe("normal");
		});

		it("Escape and Backspace on an empty search line cancel it without touching the buffer", () => {
			const editor = vimEditor("draft");
			editor.addToHistory("draft two");
			editor.handleInput("/dr");
			editor.handleInput(ESC);
			expect(editor.vimPending).toBe("");
			editor.handleInput("/d");
			editor.handleInput(BACKSPACE);
			editor.handleInput(BACKSPACE);
			expect(editor.vimPending).toBe("");
			// Back in Normal mode, `x` is a command again rather than search text.
			editor.handleInput("x");
			expect(editor.getText()).toBe("raft");
		});

		it("searches the persistent history when the editor has one", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setHistoryStorage({
				add: async () => {},
				getRecent: () => [],
				search: query => (query === "deploy" ? [{ prompt: "deploy to eu" }, { prompt: "deploy to us" }] : []),
			});
			editor.setVimMode(true);
			editor.handleInput(ESC);
			editor.handleInput("2/deploy");
			editor.handleInput("\r");
			expect(editor.getText()).toBe("deploy to us");
		});
	});
});
