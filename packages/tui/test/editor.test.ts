import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	type ComposerStyle,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	registerComposerStyle,
	TUI,
} from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

describe("Editor component", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	describe("Word delete keybindings", () => {
		it("honors a keybindings.yml remap of deleteWordBackward in the multi-line editor", () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteWordBackward": "alt+g" }));
			const editor = new Editor(defaultEditorTheme);
			editor.setText("alfa beta gamma");
			editor.handleInput("\x1bg"); // Alt+G
			expect(editor.getText()).toBe("alfa beta ");
		});

		it("stops firing a hardcoded chord once the config replaces the action's keys", () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.deleteWordBackward": "alt+g" }));
			const editor = new Editor(defaultEditorTheme);
			editor.setText("alfa beta gamma");
			editor.handleInput("\x17"); // Ctrl+W, no longer bound to deleteWordBackward
			expect(editor.getText()).toBe("alfa beta gamma");
		});

		it("deletes a word on ctrl+backspace via its registry default key", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("alfa beta gamma");
			editor.handleInput("\x1b[127;5u"); // kitty CSI-u ctrl+backspace
			expect(editor.getText()).toBe("alfa beta ");
		});

		it("deletes the next word for Ghostty's physical Option+Forward-Delete wire", () => {
			setKittyProtocolActive(true);
			try {
				const editor = new Editor(defaultEditorTheme);
				editor.setText("foo bar baz");
				editor.handleInput("\x01"); // Ctrl+A
				for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C"); // After "foo"
				editor.handleInput("\x1b[3;11~"); // Ghostty Option+Forward-Delete
				expect(editor.getText()).toBe("foo baz");
			} finally {
				setKittyProtocolActive(false);
			}
		});
	});

	describe("Submit/newline keybindings", () => {
		it("submits on Ctrl+Enter when tui.input.submit is remapped to it (#8906)", () => {
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.input.submit": "ctrl+enter",
					"tui.input.newLine": "enter",
				}),
			);
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello");
			let submitted: string | undefined;
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.handleInput("\x1b[13;5u"); // kitty CSI-u Ctrl+Enter
			expect(submitted).toBe("hello");
			expect(editor.getText()).toBe("");
		});

		it("still inserts a newline on Ctrl+Enter under the default bindings", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("hello");
			let submitted: string | undefined;
			editor.onSubmit = text => {
				submitted = text;
			};
			editor.handleInput("\x1b[13;5u"); // kitty CSI-u Ctrl+Enter
			expect(submitted).toBeUndefined();
			expect(editor.getText()).toBe("hello\n");
		});
	});

	describe("Prompt history navigation", () => {
		it("does nothing on Up arrow when history is empty", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("\x1b[A"); // Up arrow

			expect(editor.getText()).toBe("");
		});

		it("shows most recent history entry on Up arrow when editor is empty", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first prompt");
			editor.addToHistory("second prompt");

			editor.handleInput("\x1b[A"); // Up arrow

			expect(editor.getText()).toBe("second prompt");
		});

		it("cycles through history entries on repeated Up arrow", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("\x1b[A"); // Up - shows "third"
			expect(editor.getText()).toBe("third");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[A"); // Up - shows "first"
			expect(editor.getText()).toBe("first");

			editor.handleInput("\x1b[A"); // Up - stays at "first" (oldest)
			expect(editor.getText()).toBe("first");
		});

		it("returns to empty editor on Down arrow after browsing history", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("prompt");

			editor.handleInput("\x1b[A"); // Up - shows "prompt"
			expect(editor.getText()).toBe("prompt");

			editor.handleInput("\x1b[B"); // Down - clears editor
			expect(editor.getText()).toBe("");
		});

		it("navigates forward through history with Down arrow", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			// Go to oldest
			editor.handleInput("\x1b[A"); // third
			editor.handleInput("\x1b[A"); // second
			editor.handleInput("\x1b[A"); // first

			// Navigate back
			editor.handleInput("\x1b[B"); // second
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[B"); // third
			expect(editor.getText()).toBe("third");

			editor.handleInput("\x1b[B"); // empty
			expect(editor.getText()).toBe("");
		});

		it("exits history mode when typing a character", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("old prompt");

			editor.handleInput("\x1b[A"); // Up - shows "old prompt"
			editor.handleInput("x"); // Type a character - exits history mode

			expect(editor.getText()).toBe("old promptx");
		});

		it("exits history mode on setText", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");

			editor.handleInput("\x1b[A"); // Up - shows "second"
			editor.setText(""); // External clear

			// Up should start fresh from most recent
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("second");
		});

		it("exits history mode at the history edit anchor before public insertText", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("line1\nline2");
			editor.handleInput("\x1b[A"); // Up - recalls at the top edit anchor
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			editor.insertText("[Image #1] ");

			expect(editor.getText()).toBe("line1\nline2[Image #1] ");
			expect(editor.getCursor()).toEqual({ line: 1, col: "line2[Image #1] ".length });
		});

		it("does not add empty strings to history", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("");
			editor.addToHistory("   ");
			editor.addToHistory("valid");

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("valid");

			// Should not have more entries
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("valid");
		});

		it("does not add consecutive duplicates to history", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("same");
			editor.addToHistory("same");
			editor.addToHistory("same");

			editor.handleInput("\x1b[A"); // "same"
			expect(editor.getText()).toBe("same");

			editor.handleInput("\x1b[A"); // stays at "same" (only one entry)
			expect(editor.getText()).toBe("same");
		});
		it("persists a consecutive duplicate so storage can refresh its project metadata", () => {
			const persisted: string[] = [];
			const editor = new Editor(defaultEditorTheme);
			editor.setHistoryStorage({
				add: prompt => {
					persisted.push(prompt);
					return Promise.resolve();
				},
				getRecent: () => [{ prompt: "same" }],
			});

			editor.addToHistory("same");

			expect(persisted).toEqual(["same"]);
		});

		it("allows non-consecutive duplicates in history", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("first"); // Not consecutive, should be added

			editor.handleInput("\x1b[A"); // "first"
			expect(editor.getText()).toBe("first");

			editor.handleInput("\x1b[A"); // "second"
			expect(editor.getText()).toBe("second");

			editor.handleInput("\x1b[A"); // "first" (older one)
			expect(editor.getText()).toBe("first");
		});

		it("uses cursor movement instead of history when editor has content", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("history item");
			editor.setText("line1\nline2");

			// Cursor is at end of line2, Up should move to line1
			editor.handleInput("\x1b[A"); // Up - cursor movement

			// Insert character to verify cursor position
			editor.handleInput("X");

			// X should be inserted in line1, not replace with history
			expect(editor.getText()).toBe("line1X\nline2");
		});

		it("limits history to 100 entries", () => {
			const editor = new Editor(defaultEditorTheme);

			// Add 105 entries
			for (let i = 0; i < 105; i++) {
				editor.addToHistory(`prompt ${i}`);
			}

			// Navigate to oldest
			for (let i = 0; i < 100; i++) {
				editor.handleInput("\x1b[A");
			}

			// Should be at entry 5 (oldest kept), not entry 0
			expect(editor.getText()).toBe("prompt 5");

			// One more Up should not change anything
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("prompt 5");
		});

		it("anchors history entry at top when navigating with Up", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");
			editor.handleInput("\x1b[A");

			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("anchors history entry at bottom when navigating with Down", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("older");
			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // latest, anchored at top
			editor.handleInput("\x1b[A"); // older, anchored at top
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			editor.handleInput("\x1b[B"); // newer, anchored at bottom
			expect(editor.getText()).toBe("line1\nline2\nline3");
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 });
		});

		it("still allows in-entry cursor movement while browsing history", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");
			editor.handleInput("\x1b[A"); // top anchor

			editor.handleInput("\x1b[B"); // move within entry
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("\x1b[B");
			editor.handleInput("\x1b[B"); // at bottom, exit history
			expect(editor.getText()).toBe("");
		});
	});

	describe("public state accessors", () => {
		it("returns cursor position", () => {
			const editor = new Editor(defaultEditorTheme);

			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");

			expect(editor.getCursor()).toEqual({ line: 0, col: 3 });

			editor.handleInput("\x1b[D"); // Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		});

		it("moves cursor to message boundaries", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("first line\nsecond line\nthird");

			editor.moveToMessageStart();
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			editor.moveToMessageEnd();
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 });
		});

		it("returns lines as a defensive copy", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("a\nb");

			const lines = editor.getLines();
			expect(lines).toEqual(["a", "b"]);

			lines[0] = "mutated";
			expect(editor.getLines()).toEqual(["a", "b"]);
		});
	});

	describe("autocomplete triggers", () => {
		it("triggers slash-command autocomplete without losing the hardware cursor anchor", async () => {
			const editor = new Editor(defaultEditorTheme);
			editor.focused = true;
			editor.setUseTerminalCursor(true);
			const { promise, resolve } = Promise.withResolvers<string>();
			const { promise: autocompleteUpdated, resolve: resolveAutocompleteUpdated } = Promise.withResolvers<void>();

			editor.setAutocompleteProvider({
				async getSuggestions(lines, cursorLine, cursorCol) {
					const currentLine = lines[cursorLine] ?? "";
					resolve(currentLine.slice(0, cursorCol));
					return { items: [{ label: "/help", value: "/help" }], prefix: "/" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.onAutocompleteUpdate = resolveAutocompleteUpdated;

			editor.handleInput("/");

			await expect(promise).resolves.toBe("/");
			await autocompleteUpdated;
			expect(editor.isShowingAutocomplete()).toBe(true);
			expect(editor.render(80).some(line => line.includes(CURSOR_MARKER))).toBe(true);
		});

		it("caps wrapped slash-command descriptions at two rows with an ellipsis", async () => {
			const editor = new Editor(defaultEditorTheme);
			const longDescription =
				"Plan and execute non-trivial architectural improvements to the codebase. Use this skill when you need to refactor existing systems and it keeps rambling on far past what two popup rows can hold.";
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[{ name: "improve-codebase-architecture", description: longDescription }],
					"/tmp",
				),
			);

			const { promise: autocompleteUpdated, resolve: resolveAutocompleteUpdated } = Promise.withResolvers<void>();
			editor.onAutocompleteUpdate = resolveAutocompleteUpdated;

			editor.handleInput("/");
			await autocompleteUpdated;

			const rendered = editor.render(80).map(line => stripVTControlCharacters(line));
			const commandRowIndex = rendered.findIndex(line => line.includes("improve-codebase-architecture"));
			expect(commandRowIndex).not.toBe(-1);
			// Wrapped continuation is capped at one extra row ending in an ellipsis.
			const popupRows = rendered.slice(commandRowIndex);
			expect(popupRows.length).toBe(2);
			expect(popupRows[1]).toContain("…");
			expect(rendered.join("\n")).not.toContain("rambling");
		});

		it("triggers file-reference autocomplete when typing at-sign", async () => {
			const editor = new Editor(defaultEditorTheme);
			const { promise, resolve } = Promise.withResolvers<string>();

			editor.setAutocompleteProvider({
				async getSuggestions(lines, cursorLine, cursorCol) {
					const currentLine = lines[cursorLine] ?? "";
					resolve(currentLine.slice(0, cursorCol));
					return { items: [{ label: "src/", value: "src/" }], prefix: "@" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});

			editor.handleInput("@");

			await expect(promise).resolves.toBe("@");
		});

		it("chains into argument completions after tab-completing slash command names", async () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[
						{
							name: "model",
							description: "Select a model",
							getArgumentCompletions() {
								return [{ label: "claude-opus", value: "claude-opus" }];
							},
						},
						{ name: "help", description: "Show help" },
					],
					"/tmp",
				),
			);

			editor.handleInput("/");
			await Bun.sleep(0);
			editor.handleInput("m");
			editor.handleInput("o");
			editor.handleInput("d");
			await Bun.sleep(110);

			editor.handleInput("	");
			await Bun.sleep(0);

			expect(editor.getText()).toBe("/model ");
			expect(editor.isShowingAutocomplete()).toBe(true);

			editor.handleInput("	");

			expect(editor.getText()).toBe("/model claude-opus");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("does not show argument completions when command has no argument completer", async () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					[
						{
							name: "model",
							description: "Select a model",
							getArgumentCompletions() {
								return [{ label: "claude-opus", value: "claude-opus" }];
							},
						},
						{ name: "help", description: "Show help" },
					],
					"/tmp",
				),
			);

			editor.handleInput("/");
			await Bun.sleep(0);
			editor.handleInput("h");
			editor.handleInput("e");
			await Bun.sleep(110);

			editor.handleInput("	");
			await Bun.sleep(0);

			expect(editor.getText()).toBe("/help ");
			expect(editor.isShowingAutocomplete()).toBe(false);
		});

		it("does not open file autocomplete after tab-completing no-arg slash commands", async () => {
			vi.useFakeTimers();
			const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "slash-tab-no-arg-"));
			try {
				await Bun.write(path.join(baseDir, "visible-file.ts"), "export {};\n");
				const editor = new Editor(defaultEditorTheme);
				editor.setAutocompleteProvider(
					new CombinedAutocompleteProvider([{ name: "quit", description: "Quit", allowArgs: false }], baseDir),
				);

				let nextUpdate = Promise.withResolvers<void>();
				editor.onAutocompleteUpdate = () => nextUpdate.resolve();
				editor.handleInput("/");
				await nextUpdate.promise;

				nextUpdate = Promise.withResolvers<void>();
				editor.onAutocompleteUpdate = () => nextUpdate.resolve();
				editor.handleInput("q");
				vi.advanceTimersByTime(100);
				await nextUpdate.promise;

				const chainedUpdates = Promise.withResolvers<void>();
				let updateCount = 0;
				editor.onAutocompleteUpdate = () => {
					updateCount += 1;
					if (updateCount === 2) {
						chainedUpdates.resolve();
					}
				};
				editor.handleInput("	");
				await chainedUpdates.promise;

				expect(editor.getText()).toBe("/quit ");
				expect(editor.isShowingAutocomplete()).toBe(false);
			} finally {
				vi.useRealTimers();
				await fs.rm(baseDir, { recursive: true, force: true });
			}
		});
	});

	describe("Unicode text editing behavior", () => {
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("H");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput(" ");
			editor.handleInput("😀");

			const text = editor.getText();
			expect(text).toBe("Hello äöü 😀");
		});

		it("inserts keypad digits instead of treating them as navigation", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("\x1b[57400u");
			editor.handleInput("\x1b[57400;129u");

			expect(editor.getText()).toBe("a11");
		});

		it("inserts a newline for Ctrl+Enter variants with NumLock or keypad Enter metadata", () => {
			const variants = ["\x1b[13;133u", "\x1b[57414;5u", "\x1b[57414;133u"];

			for (const variant of variants) {
				const editor = new Editor(defaultEditorTheme);

				editor.handleInput("a");
				editor.handleInput(variant);
				editor.handleInput("b");

				expect(editor.getText()).toBe("a\nb");
			}
		});

		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Delete the last character (ü)
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			expect(text).toBe("äö");
		});

		it("deletes multi-code-unit emojis with single Backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");

			// Delete the last emoji (👍) - single backspace deletes whole grapheme cluster
			editor.handleInput("\x7f"); // Backspace

			const text = editor.getText();
			expect(text).toBe("😀");
		});

		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// Move cursor left twice
			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("\x1b[D"); // Left arrow

			// Insert 'x' in the middle
			editor.handleInput("x");

			const text = editor.getText();
			expect(text).toBe("äxöü");
		});

		it("moves cursor across multi-code-unit emojis with single arrow key", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");
			editor.handleInput("🎉");

			// Move cursor left over last emoji (🎉) - single arrow moves over whole grapheme
			editor.handleInput("\x1b[D"); // Left arrow

			// Move cursor left over second emoji (👍)
			editor.handleInput("\x1b[D");

			// Insert 'x' between first and second emoji
			editor.handleInput("x");

			const text = editor.getText();
			expect(text).toBe("😀x👍🎉");
		});

		it("preserves umlauts across line breaks", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput("\n"); // new line
			editor.handleInput("Ä");
			editor.handleInput("Ö");
			editor.handleInput("Ü");

			const text = editor.getText();
			expect(text).toBe("äöü\nÄÖÜ");
		});

		it("splits public insertText newlines into logical editor rows", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.insertText("a\nb");

			expect(editor.getText()).toBe("a\nb");
			expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
			for (const renderedLine of editor.render(80)) {
				expect(renderedLine).not.toContain("\n");
			}
		});

		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			const editor = new Editor(defaultEditorTheme);

			// Simulate bracketed paste / programmatic replacement
			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			const text = editor.getText();
			expect(text).toBe("Hällö Wörld! 😀 äöüÄÖÜß");
		});

		it("expands tabs to the fixed display width when loading text programmatically", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("foo\tbar");
			expect(editor.getText()).toBe("foo   bar");
		});

		it("strips control characters from programmatically loaded text before render", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("start\x1b[31mred\x1b[0m\u0007end");

			expect(editor.getText()).toBe("start[31mred[0mend");
			expect(editor.getText()).not.toContain("\x1b");
			expect(editor.getText()).not.toContain("\u0007");
			expect(editor.render(80).join("\n")).not.toContain("\x1b[31m");
		});

		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\x01"); // Ctrl+A (move to start)
			editor.handleInput("x"); // Insert at start

			const text = editor.getText();
			expect(text).toBe("xab");
		});

		it("deletes words correctly with Ctrl+W and Alt+Backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			// Basic word deletion
			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W
			expect(editor.getText()).toBe("foo bar ");

			// Trailing whitespace
			editor.setText("foo bar   ");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo ");

			// Punctuation run
			editor.setText("foo bar...");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo bar");

			// snake_case identifier deletes as a single word (issue #4776)
			editor.setText("allowed_openai_params");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("");

			// Delete across multiple lines
			editor.setText("line one\nline two");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("line one\nline ");

			// Delete empty line (merge)
			editor.setText("line one\n");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("line one");

			// Grapheme safety (emoji as a word)
			editor.setText("foo 😀😀 bar");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo 😀😀 ");
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("foo ");

			// Alt+Backspace
			editor.setText("foo bar");
			editor.handleInput("\x1b\x7f"); // Alt+Backspace (legacy)
			expect(editor.getText()).toBe("foo ");

			// Issue #2064: Ghostty on macOS reports Option+Backspace as `ESC [127;11u`
			// (kitty modifier 11 wire = super(8)|alt(2)). Without super support the
			// editor used to ignore this entirely and the previous word survived.
			setKittyProtocolActive(true);
			editor.setText("foo bar");
			editor.handleInput("\x1b[F"); // End — park cursor at EOL
			editor.handleInput("\x1b[127;11u"); // Ghostty Option+Backspace
			expect(editor.getText()).toBe("foo ");
			setKittyProtocolActive(false);
		});

		it("navigates words correctly with Ctrl+Left/Right", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("foo bar... baz");
			// Cursor at end

			// Move left over baz
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 11 }); // after '...'

			// Move left over punctuation
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 7 }); // after 'bar'

			// Move left over bar
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 }); // after 'foo '

			// Move right over bar
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toEqual({ line: 0, col: 7 }); // at end of 'bar'

			// Move right over punctuation run
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toEqual({ line: 0, col: 10 }); // after '...'

			// Move right skips space and lands after baz
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toEqual({ line: 0, col: 14 }); // end of line

			// Test forward from start with leading whitespace
			editor.setText("   foo bar");
			editor.handleInput("\x01"); // Ctrl+A to go to start
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toEqual({ line: 0, col: 6 }); // after 'foo'
		});
	});

	describe("Grapheme-aware text wrapping", () => {
		it("wraps lines correctly when text contains wide emojis", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 20;

			// ✅ is 2 columns wide, so "Hello ✅ World" is 14 columns
			editor.setText("Hello ✅ World");
			const lines = editor.render(width);

			// All content lines (between borders) should fit within width
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth).toBeLessThanOrEqual(width);
			}
		});

		it("wraps long text with emojis at correct positions", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 10;

			// Each ✅ is 2 columns. "✅✅✅✅✅" = 10 columns, fits exactly
			// "✅✅✅✅✅✅" = 12 columns, needs wrap
			editor.setText("✅✅✅✅✅✅");
			const lines = editor.render(width);

			// Should have 2 content lines (plus 2 border lines)
			// First line: 5 emojis (10 cols), second line: 1 emoji (2 cols) + padding
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth).toBeLessThanOrEqual(width);
			}
		});

		it("wraps CJK characters correctly (each is 2 columns wide)", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content

			// Each CJK char is 2 columns. "日本語テスト" = 6 chars = 12 columns
			editor.setText("日本語テスト");
			const lines = editor.render(width);

			// All content lines (including last which has bottom border) should be correct width
			for (let i = 1; i < lines.length; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth).toBeLessThanOrEqual(width);
			}

			// Verify content split correctly - extract content between borders
			// Middle lines use "│  " and "  │", last line uses "╰─ " and " ─╯"
			const contentLines = lines.slice(1).map(l => {
				const stripped = stripVTControlCharacters(l);
				// Both border styles use 3 chars on each side
				return stripped.slice(3, -3).trim();
			});
			expect(contentLines.length).toBe(2);
			expect(contentLines[0]).toBe("日本語テス"); // 5 chars = 10 columns
			// Last line has cursor (|) which we need to strip
			expect(contentLines[1]?.replace("|", "")).toBe("ト"); // 1 char = 2 columns (+ cursor + padding)
		});

		it("handles mixed ASCII and wide characters in wrapping", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 15;

			// "Test ✅ OK 日本" = 4 + 1 + 2 + 1 + 2 + 1 + 4 = 15 columns (fits exactly)
			editor.setText("Test ✅ OK 日本");
			const lines = editor.render(width);

			// Should fit in one content line
			const contentLines = lines.slice(1, -1);
			expect(contentLines.length).toBe(1);

			const lineWidth = visibleWidth(contentLines[0]!);
			expect(lineWidth).toBeLessThanOrEqual(width);
		});

		it("renders cursor correctly on wide characters", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 20;

			editor.setText("A✅B");
			// Cursor should be at end (after B)
			const lines = editor.render(width);

			// The software cursor should be visible without SGR blink; Ghostty/cmux
			// can leave afterimages for blinking cells during rapid row repaints.
			const contentLine = lines[1]!;
			expect(contentLine).toContain(defaultEditorTheme.symbols.inputCursor);
			expect(contentLine).not.toContain("\x1b[5m");
			// Line should still be correct width
			expect(visibleWidth(contentLine)).toBeLessThanOrEqual(width);
		});

		it("keeps the bordered editor inside `width` when the cursor lands past a wide trailing grapheme (#3431)", () => {
			// Regression: typing a fullwidth char (e.g. CJK comma `，`, U+FF0C) at the end
			// of the input used to push the bottom-right `─╯` 1–2 cells past the terminal
			// edge, wrapping `╯` to its own row. The end-of-line cursor glyph + wide grapheme
			// extends into the right padding zone; the right chrome must shrink by the exact
			// overflow cell count.
			for (const paddingX of [1, 2]) {
				const theme = { ...defaultEditorTheme, editorPaddingX: paddingX };
				const minContentWidth = 2 * (paddingX + 1) + 3; // chrome + "，" (2) + cursor (1)
				for (let width = minContentWidth; width <= minContentWidth + 6; width++) {
					const editor = new Editor(theme);
					editor.focused = true;
					for (const c of "asd，") editor.handleInput(c);
					const lines = editor.render(width);
					for (const line of lines) {
						const stripped = line.replaceAll(CURSOR_MARKER, "");
						expect(visibleWidth(stripped)).toBeLessThanOrEqual(width);
					}
				}
			}
		});

		it("keeps the terminal-cursor editor compact by default", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.focused = true;
			editor.setUseTerminalCursor(true);
			editor.setText("ast");

			const lines = editor.render(20).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
			expect(lines).toEqual(["+------------------+", "+- ast            -+"]);
		});

		it("keeps terminal-local IME preedit from displacing the editor border (#5563)", async () => {
			const width = 20;
			const terminal = new VirtualTerminal(width, 6, 1_000);
			const tui = new TUI(terminal, true);
			const editor = new Editor(defaultEditorTheme);
			editor.setImeSafeCursorLayout(true);
			tui.addChild(editor);
			tui.setFocus(editor);

			try {
				tui.start();
				await terminal.waitForRender();
				for (const char of "ast") editor.handleInput(char);
				tui.requestRender();
				await terminal.waitForRender(() => terminal.getViewport()[1]?.includes("ast") === true);

				const beforePreedit = terminal.getViewport().map(row => row.trimEnd());
				expect(beforePreedit.slice(0, 3)).toEqual(["+------------------+", "|  ast", "+------------------+"]);

				// macOS Terminal renders marked text locally in insertion mode before
				// committed bytes reach OMP. The open cursor row must not carry right
				// chrome that the marked text can shift onto another row.
				terminal.write("\x1b[4hast，\x1b[4l");
				const afterPreedit = terminal.getViewport().map(row => row.trimEnd());
				expect(afterPreedit[1]).toBe("|  astast，");
				expect(afterPreedit[2]).toBe(beforePreedit[2]);
			} finally {
				tui.stop();
			}
		});

		it("shows cursor at end before wrap and wraps on next char", () => {
			for (const paddingX of [0, 1]) {
				const editor = new Editor({ ...defaultEditorTheme, editorPaddingX: paddingX });
				const width = 20;
				const contentWidth = width - 2 * (paddingX + 1);
				const layoutWidth = Math.max(1, contentWidth - (paddingX === 0 ? 1 : 0));
				const cursorToken = defaultEditorTheme.symbols.inputCursor;

				for (let i = 0; i < layoutWidth; i++) {
					editor.handleInput("a");
				}

				let lines = editor.render(width);
				let contentLines = lines.slice(1);
				expect(contentLines.length).toBe(1);
				expect(contentLines[0]!.includes(cursorToken)).toBeTruthy();

				editor.handleInput("a");
				lines = editor.render(width);
				contentLines = lines.slice(1);
				expect(contentLines.length).toBe(2);
			}
		});

		it("keeps a persistent prompt gutter visible after typing in borderless mode", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setUseTerminalCursor(true);

			for (const char of "hello") {
				editor.handleInput(char);
			}

			const [line] = editor.render(20);
			expect(stripVTControlCharacters(line!).startsWith("> hello")).toBeTrue();
			expect(visibleWidth(line!)).toBeLessThanOrEqual(20);
		});

		it("pads wrapped borderless lines to the prompt gutter width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setUseTerminalCursor(true);
			editor.setText("abcdefghij");

			const lines = editor.render(10).map(line => stripVTControlCharacters(line));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("> abcdefgh");
			expect(lines[1]).toBe("  ij      ");
		});

		it("keeps the prompt gutter visible when it consumes the full borderless width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");

			let lines = editor.render(1).map(line => stripVTControlCharacters(line));
			expect(lines).toEqual([">"]);
			expect(lines.every(line => visibleWidth(line) <= 1)).toBeTrue();

			lines = editor.render(2).map(line => stripVTControlCharacters(line));
			expect(lines).toEqual([`>${defaultEditorTheme.symbols.inputCursor}`]);
			expect(lines.every(line => visibleWidth(line) <= 2)).toBeTrue();

			editor.handleInput("a");

			lines = editor.render(2).map(line => stripVTControlCharacters(line));
			expect(lines).toEqual([`>${defaultEditorTheme.symbols.inputCursor}`]);
			expect(lines.every(line => visibleWidth(line) <= 2)).toBeTrue();
		});

		it("keeps cursor-following movement stable when the prompt gutter consumes the full borderless width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setMaxHeight(2);
			editor.focused = true;
			editor.setText("a\nb\nc");

			let lines = editor.render(2);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("> ");
			expect(lines[1]).toBe(` ${defaultEditorTheme.symbols.inputCursor}${CURSOR_MARKER}`);

			editor.handleInput("\x1b[A");

			expect(editor.getCursor()).toEqual({ line: 1, col: 1 });
			lines = editor.render(2);
			expect(lines).toEqual([`>${defaultEditorTheme.symbols.inputCursor}${CURSOR_MARKER}`, "  "]);
		});

		it("keeps the prompt gutter visible at the borderless width limit", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.focused = true;
			const width = 20;

			for (let i = 0; i < width - 2; i++) {
				editor.handleInput("a");
			}

			const [line] = editor.render(width);
			expect(stripVTControlCharacters(line!).startsWith("> ")).toBeTrue();
			expect(line).toContain(`\x1b[7ma\x1b[0m${CURSOR_MARKER}`);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("keeps the prompt gutter visible on the first rendered row after scrolling", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setMaxHeight(3);
			editor.setText("l0\nl1\nl2\nl3");

			const lines = editor.render(10).map(line => stripVTControlCharacters(line));
			expect(lines).toHaveLength(3);
			expect(lines[0]?.startsWith("> l1")).toBeTrue();
			expect(lines.slice(1).every(line => line.startsWith("  "))).toBeTrue();
			expect(lines.every(line => visibleWidth(line) <= 10)).toBeTrue();
		});

		it("keeps the prompt gutter visible when scrolling starts on a wrapped continuation chunk", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setUseTerminalCursor(true);
			editor.setMaxHeight(2);
			editor.setText("abcdefghijklmno\nz");

			const lines = editor.render(10).map(line => stripVTControlCharacters(line));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("> ijklmno ");
			expect(lines[1]).toBe("  z       ");
			expect(lines.every(line => visibleWidth(line) <= 10)).toBeTrue();
		});

		it("does not overflow width in borderless mode when the cursor reaches the line edge", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			const width = 20;

			for (let i = 0; i < width; i++) {
				editor.handleInput("a");
			}

			const lines = editor.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
		});

		it("clamps the terminal cursor marker inside a full-width borderless row", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setUseTerminalCursor(true);
			editor.focused = true;
			const width = 3;
			editor.setText("abc");

			const [line] = editor.render(width);
			const [beforeMarker] = line!.split(CURSOR_MARKER);

			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe("abc");
			expect(visibleWidth(beforeMarker!)).toBe(width - 1);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBe(width);
		});

		it("clamps the terminal cursor marker inside a full-width borderless prompt-gutter row", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setUseTerminalCursor(true);
			editor.focused = true;
			const width = 5;
			editor.setText("abc");

			const [line] = editor.render(width);
			const [beforeMarker] = line!.split(CURSOR_MARKER);

			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe("> abc");
			expect(visibleWidth(beforeMarker!)).toBe(width - 1);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBe(width);
		});

		it("does not overflow prompt-gutter wraps when a wide grapheme lands in a 1-column content area", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			const width = 3;
			editor.setText("好a");

			const lines = editor.render(width).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));

			expect(lines).toEqual([">  ", "  a"]);
			expect(lines.every(line => visibleWidth(line) <= width)).toBeTrue();
		});

		it("clamps terminal-cursor rows when a wide grapheme lands in a 1-column prompt-gutter content area", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.setUseTerminalCursor(true);
			editor.focused = true;
			const width = 3;
			editor.setText("好");

			const [line] = editor.render(width);

			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(">  ");
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("keeps a visible cursor marker when a focused borderless line is full width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.focused = true;
			const width = 20;

			for (let i = 0; i < width; i++) {
				editor.handleInput("a");
			}

			const [line] = editor.render(width);
			expect(line).toContain(`\x1b[7ma\x1b[0m${CURSOR_MARKER}`);
			expect(visibleWidth(line.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("preserves cursorOverride at the borderless width limit", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.cursorOverride = "\x1b[35m~\x1b[0m";
			editor.cursorOverrideWidth = 1;
			editor.focused = true;
			const width = 20;

			for (let i = 0; i < width; i++) {
				editor.handleInput("a");
			}

			const [line] = editor.render(width);
			expect(line).toContain(`${editor.cursorOverride}${CURSOR_MARKER}`);
			expect(visibleWidth(line.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("keeps the cursor marker at the full width when cursorOverride replaces a wide trailing glyph", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.cursorOverride = "\x1b[35m~\x1b[0m";
			editor.cursorOverrideWidth = 1;
			editor.focused = true;
			const width = 20;

			editor.setText("aaaaaaaaaaaaaaaaaa✅");

			const [line] = editor.render(width);
			const beforeMarker = line.split(CURSOR_MARKER)[0];
			expect(line).toContain(`${editor.cursorOverride}${CURSOR_MARKER}`);
			expect(visibleWidth(beforeMarker!)).toBe(width);
			expect(visibleWidth(line.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("preserves visible trailing text when a wide cursorOverride cannot fit on a narrow borderless line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.cursorOverride = "好";
			editor.cursorOverrideWidth = 2;
			editor.focused = true;
			const width = 1;
			editor.setText("a");

			const [line] = editor.render(width);

			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""))).toBe("a");
			expect(visibleWidth(line.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("keeps a visible fake cursor when the prompt gutter consumes the full borderless width", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.focused = true;

			const [line] = editor.render(2);

			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(
				`>${defaultEditorTheme.symbols.inputCursor}`,
			);
			expect(line).toContain(CURSOR_MARKER);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(2);
		});

		it("renders a fitting cursorOverride after the prompt glyph in a zero-content prompt gutter row", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.cursorOverride = "\x1b[35m~\x1b[0m";
			editor.cursorOverrideWidth = 1;
			editor.focused = true;
			const width = 2;

			const [line] = editor.render(width);

			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(">~");
			expect(line).toContain(`${editor.cursorOverride}${CURSOR_MARKER}`);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("highlights the only visible prompt-gutter cell when the zero-content prompt gutter truncates to one visible cell", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			const width = 1;

			const [baselineLine] = editor.render(width);
			const visibleCell = stripVTControlCharacters(baselineLine!);
			editor.focused = true;

			const [line] = editor.render(width);

			expect(line).toBe(`\x1b[7m${visibleCell}\x1b[0m${CURSOR_MARKER}`);
			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(visibleCell);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("preserves the prompt glyph when a wide cursorOverride hits the zero-content prompt gutter", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPromptGutter("> ");
			editor.cursorOverride = "好";
			editor.cursorOverrideWidth = 2;
			editor.focused = true;
			const width = 2;

			const [line] = editor.render(width);

			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(
				`>${defaultEditorTheme.symbols.inputCursor}`,
			);
			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line!)).not.toContain("好");
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("falls back to a visible cursor when a wide cursorOverride cannot fit on an empty narrow borderless line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.cursorOverride = "好";
			editor.cursorOverrideWidth = 2;
			editor.focused = true;
			const width = 1;

			const [line] = editor.render(width);

			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(
				defaultEditorTheme.symbols.inputCursor,
			);
			expect(line).toContain(CURSOR_MARKER);
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("falls back to the built-in cursor when a wide trailing grapheme cannot fit on a narrow borderless line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.focused = true;
			const width = 1;
			editor.setText("好");

			const [line] = editor.render(width);

			expect(stripVTControlCharacters(line!.replaceAll(CURSOR_MARKER, ""))).toBe(
				defaultEditorTheme.symbols.inputCursor,
			);
			expect(line).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(line!)).not.toContain("好");
			expect(visibleWidth(line!.replaceAll(CURSOR_MARKER, ""))).toBeLessThanOrEqual(width);
		});

		it("uses the full width in borderless mode when horizontal padding is zero", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setBorderVisible(false);
			editor.setPaddingX(0);
			const width = 20;

			for (let i = 0; i < width; i++) {
				editor.handleInput("a");
			}

			const lines = editor.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
		});

		it("does not exceed terminal width with emoji at wrap boundary", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 11;

			// "0123456789✅" = 10 ASCII + 2-wide emoji = 12 columns
			// Should wrap before the emoji since it would exceed width
			editor.setText("0123456789✅");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth <= width).toBeTruthy();
			}
		});
	});

	describe("Word wrapping", () => {
		function renderContentLines(editor: Editor, width: number): string[] {
			// Move cursor to start so the rendered cursor does not affect line padding/borders.
			editor.handleInput("\x01"); // Ctrl+A
			const lines = editor.render(width);
			const paddingX = defaultEditorTheme.editorPaddingX ?? 2;
			const borderWidth = paddingX + 1;
			return lines.slice(1).map(l => stripVTControlCharacters(l).slice(borderWidth, -borderWidth).trimEnd());
		}

		it("wraps at word boundaries instead of mid-word", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 40;

			editor.setText("Hello world this is a test of word wrapping functionality");
			const lines = editor.render(width);

			// Check that all lines fit within width
			for (const line of lines) {
				const lineWidth = visibleWidth(line);
				expect(lineWidth).toBe(width);
			}

			// Extract text content (strip borders and control characters)
			const allText = lines
				.map(l => stripVTControlCharacters(l))
				.join("")
				.replace(/[+\-|]/g, "")
				.replace(/\s+/g, " ")
				.trim();

			// Should contain the full text (with normalized whitespace)
			expect(allText).toBe("Hello world this is a test of word wrapping functionality");
		});

		it("does not start lines with leading whitespace after word wrap", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 20;

			editor.setText("Word1 Word2 Word3 Word4 Word5 Word6");
			const lines = editor.render(width);

			// Get content lines (between borders)
			const contentLines = lines.slice(1, -1);

			// No line should start with whitespace (except for padding at the end)
			for (let i = 0; i < contentLines.length; i++) {
				const line = stripVTControlCharacters(contentLines[i]!);
				const trimmedStart = line.trimStart();
				// The line should either be all padding or start with a word character
				if (trimmedStart.length > 0) {
					expect(/^\s+\S/.test(line.trimEnd())).toBe(false);
				}
			}
		});

		it("breaks long words (URLs) at character level", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 30;

			editor.setText("Check https://example.com/very/long/path/that/exceeds/width here");
			const lines = editor.render(width);

			// All lines should fit within width
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				expect(lineWidth).toBe(width);
			}
		});

		it("uses remaining width before breaking a long token", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			editor.setText("word 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// The first visual line should not waste remaining width by leaving just "word".
			expect(contentLines[0]?.includes("word")).toBeTruthy();
			expect(contentLines[0]?.includes("一")).toBeTruthy();
		});
		it("uses remaining width before wrapping a short wide token (CJK)", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			// This CJK token fits within maxWidth, but not within the remaining width after "word ".
			editor.setText("word 一二三四五");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// Should fill the first line with as much of the CJK token as fits.
			expect(contentLines[0]?.includes("word")).toBeTruthy();
			expect(contentLines[0]?.includes("一")).toBeTruthy();
			expect(contentLines[0]?.includes("二")).toBeTruthy();
			expect(contentLines.join("\n").includes("三")).toBeTruthy();
		});
		it("wraps a longer friendly Chinese sentence without wasting remaining width", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			editor.setText(
				"word 愿世界各地的朋友都被善意连接，愿每个人都拥有幸福灿烂的人生；愿AI与人类相互成就、共同成长，携手创造更美好的明天与未来。",
			);
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// First line should not be just the ASCII prefix.
			expect(contentLines[0]?.includes("word")).toBeTruthy();
			expect(contentLines[0]?.includes("愿")).toBeTruthy();
		});
		it("wraps Japanese kana/kanji without wasting remaining width", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			const phrase = "天気がいいから、散歩しましょう！";
			editor.setText(`word ${phrase}${phrase}${phrase}`);
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			expect(contentLines[0]?.includes("word")).toBeTruthy();
			expect(contentLines[0]?.includes("天")).toBeTruthy();
		});
		it("uses remaining width when wrapping an emoji token", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			editor.setText("word ✅✅✅✅✅ emoji-wrap-test with friends");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// Each ✅ is 2 columns wide; remaining width should fit two of them.
			expect(contentLines[0]?.includes("word ✅✅")).toBeTruthy();
			expect(contentLines.join("").includes("emoji-wrap-test")).toBeTruthy();
		});
		it("does not split narrow non-ASCII words (German)", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 14; // 6 chars for borders, 8 for content
			editor.setText("word über und danke fuer deine freundschaft");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// "über" should wrap as a whole word, not be split into the remaining width.
			expect(contentLines[0]?.includes("ü")).toBe(false);
			expect(contentLines[1]?.startsWith("über")).toBeTruthy();
		});
		it("does not split narrow non-ASCII words (Russian)", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 14; // 6 chars for borders, 8 for content
			editor.setText("word привет мой друг и спасибо за дружбу");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			// "привет" should wrap as a whole word, not be split into the remaining width.
			expect(contentLines[0]?.includes("п")).toBe(false);
			expect(contentLines[1]?.includes("привет")).toBeTruthy();
		});
		it("uses remaining width for mixed wide and narrow graphemes in one token", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 16; // 6 chars for borders, 10 for content
			editor.setText("word 一a二b三c四d五e六f七g八h九");
			const contentLines = renderContentLines(editor, width);
			expect(contentLines.length).toBeGreaterThanOrEqual(2);
			expect(contentLines[0]?.includes("word 一a二")).toBeTruthy();
			expect(contentLines[1]?.startsWith("b三")).toBeTruthy();
		});
		it("preserves multiple spaces within words on same line", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 50;

			editor.setText("Word1   Word2    Word3");
			const lines = editor.render(width);

			const contentLine = stripVTControlCharacters(lines[1]!).trim();
			// Multiple spaces should be preserved
			expect(contentLine.includes("Word1   Word2")).toBeTruthy();
		});

		it("handles empty string", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 40;

			editor.setText("");
			const lines = editor.render(width);

			// Should have at least 2 lines (borders)
			expect(lines.length).toBeGreaterThanOrEqual(2);

			// All lines should fit within width
			for (const line of lines) {
				const lineWidth = visibleWidth(line);
				expect(lineWidth).toBe(width);
			}
		});

		it("handles single word that fits exactly", () => {
			const editor = new Editor(defaultEditorTheme);
			const width = 20;

			editor.setText("1234567890");
			const lines = editor.render(width);

			// Check all lines fit within width
			for (const line of lines) {
				const lineWidth = visibleWidth(line);
				expect(lineWidth).toBe(width);
			}

			// Extract and verify content
			const allText = lines
				.map(l => stripVTControlCharacters(l))
				.join("")
				.replace(/[+\-|]/g, "")
				.trim();
			expect(allText).toBe("1234567890");
		});
	});

	describe("Word navigation (Option/Alt + Left/Right)", () => {
		const wordLeft = "\x1bb"; // ESC-b (matches alt+left on most terminals / our matcher)
		const wordRight = "\x1bf"; // ESC-f (matches alt+right on most terminals / our matcher)

		it("moves by CJK and punctuation blocks in Chinese", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "天气不错，去散步吧！";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// ! is punctuation delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length - "！".length });
			// Jump over the CJK run "去散步吧"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("，") + 1 });
			// Jump over the punctuation delimiter "，"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("，") });
			// Jump over the CJK run "天气不错"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
			// And forward again
			editor.handleInput(wordRight);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("，") });
			editor.handleInput(wordRight);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("，") + 1 });
			editor.handleInput(wordRight);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length - "！".length });
			editor.handleInput(wordRight);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
		});

		it("moves by mixed kana/kanji blocks in Japanese", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "天気がいいから、散歩しましょう！";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// Skip the final delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length - "！".length });
			// Jump over the CJK run after the comma
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("、") + 1 });
			// Skip the comma delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("、") });
			// Jump over the first CJK run
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("moves by words and Unicode punctuation in Spanish", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "¿Cómo estás? ¡Muy bien!";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// Skip the final delimiter (!), then jump over "bien"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("!") });
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.lastIndexOf("bien") });
			// Jump over "Muy"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("Muy") });
			// The inverted exclamation is a delimiter block
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("¡") });
			// Skip space + '?' delimiter (block semantics)
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("?") });
			// Then jump over "estás"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("estás") });
		});

		it("treats NBSP as whitespace for word navigation", () => {
			const editor = new Editor(defaultEditorTheme);
			const nbsp = "\u00A0";
			const text = `Hola${nbsp}mundo`;
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("mundo") });
		});

		it("keeps common joiners inside words", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "co-operate l’été";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// Jump over the last word as a single unit (keeps ’ inside)
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("l’été") });
			// Then jump over the hyphenated word as a single unit
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("recognizes Unicode quotes and dashes as delimiter blocks", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "„überraschend“ — wirklich?";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// '?' delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("?") });
			// jump over "wirklich"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("wirklich") });
			// em dash delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("—") });
		});

		it("recognizes Russian quotes and dashes as delimiter blocks", () => {
			const editor = new Editor(defaultEditorTheme);
			const text = "«Привет — мир»";
			editor.setText(text);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.length });
			// closing quote delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("»") });
			// jump over "мир"
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("мир") });
			// em dash delimiter
			editor.handleInput(wordLeft);
			expect(editor.getCursor()).toEqual({ line: 0, col: text.indexOf("—") });
		});
	});

	describe("Sticky column", () => {
		it("preserves target column when moving up through a shorter line", () => {
			const editor = new Editor(defaultEditorTheme);

			// Line 0: "2222222222x222" (x at col 10)
			// Line 1: "" (empty)
			// Line 2: "1111111111_111111111111" (_ at col 10)
			editor.setText("2222222222x222\n\n1111111111_111111111111");

			// Position cursor on _ (line 2, col 10)
			expect(editor.getCursor()).toEqual({ line: 2, col: 23 }); // At end
			editor.handleInput("\x01"); // Ctrl+A - go to start of line
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Move right to col 10
			expect(editor.getCursor()).toEqual({ line: 2, col: 10 });

			// Press Up - should move to empty line (col clamped to 0)
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			// Press Up again - should move to line 0 at col 10 (on 'x')
			editor.handleInput("\x1b[A"); // Up arrow
			expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
		});

		it("preserves target column when moving down through a shorter line", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1111111111_111\n\n2222222222x222222222222");

			// Position cursor on _ (line 0, col 10)
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 0, col: 10 });

			// Press Down - should move to empty line (col clamped to 0)
			editor.handleInput("\x1b[B"); // Down arrow
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			// Press Down again - should move to line 2 at col 10 (on 'x')
			editor.handleInput("\x1b[B"); // Down arrow
			expect(editor.getCursor()).toEqual({ line: 2, col: 10 });
		});

		it("resets sticky column on horizontal movement (left arrow)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 5
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 });

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (sticky)
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });

			// Move left - resets sticky column
			editor.handleInput("\x1b[D"); // Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 4 (new sticky from col 4)
			expect(editor.getCursor()).toEqual({ line: 2, col: 4 });
		});

		it("resets sticky column on horizontal movement (right arrow)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 0, col 5
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });

			// Move down through empty line
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (sticky)
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 });

			// Move right - resets sticky column
			editor.handleInput("\x1b[C"); // Right
			expect(editor.getCursor()).toEqual({ line: 2, col: 6 });

			// Move up twice
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 6 (new sticky from col 6)
			expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
		});

		it("resets sticky column on typing", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 });

			// Type a character - resets sticky column
			editor.handleInput("X");
			expect(editor.getCursor()).toEqual({ line: 0, col: 9 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 9 (new sticky from col 9)
			expect(editor.getCursor()).toEqual({ line: 2, col: 9 });
		});

		it("resets sticky column on backspace", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up through empty line
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 8
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 });

			// Backspace - resets sticky column
			editor.handleInput("\x7f"); // Backspace
			expect(editor.getCursor()).toEqual({ line: 0, col: 7 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 7 (new sticky from col 7)
			expect(editor.getCursor()).toEqual({ line: 2, col: 7 });
		});

		it("resets sticky column on Ctrl+A (move to line start)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Start at line 2, col 8
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// Move up - establishes sticky col 8
			editor.handleInput("\x1b[A"); // Up - line 1, col 0

			// Ctrl+A - resets sticky column to 0
			editor.handleInput("\x01"); // Ctrl+A
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			// Move up
			editor.handleInput("\x1b[A"); // Up - line 0, col 0 (new sticky from col 0)
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("resets sticky column on Ctrl+E (move to line end)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("12345\n\n1234567890");

			// Start at line 2, col 3
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 3
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 3
			expect(editor.getCursor()).toEqual({ line: 0, col: 3 });

			// Ctrl+E - resets sticky column to end
			editor.handleInput("\x05"); // Ctrl+E
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 5 (new sticky from col 5)
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 });
		});

		it("resets sticky column on word movement (Ctrl+Left)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// Start at end of line 2 (col 11)
			expect(editor.getCursor()).toEqual({ line: 2, col: 11 });

			// Move up through empty line - establishes sticky col 11
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 11
			expect(editor.getCursor()).toEqual({ line: 0, col: 11 });

			// Ctrl+Left - word movement resets sticky column
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			expect(editor.getCursor()).toEqual({ line: 0, col: 6 }); // Before "world"

			// Move down twice
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 6 (new sticky from col 6)
			expect(editor.getCursor()).toEqual({ line: 2, col: 6 });
		});

		it("resets sticky column on word movement (Ctrl+Right)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// Start at line 0, col 0
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x01"); // Ctrl+A
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			// Move down through empty line - establishes sticky col 0
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 0
			expect(editor.getCursor()).toEqual({ line: 2, col: 0 });

			// Ctrl+Right - word movement resets sticky column
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			expect(editor.getCursor()).toEqual({ line: 2, col: 5 }); // After "hello"

			// Move up twice
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 5 (new sticky from col 5)
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });
		});

		it("resets sticky column on undo", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Go to line 0, col 8
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 });

			// Move down through empty line - establishes sticky col 8
			editor.handleInput("\x1b[B"); // Down - line 1, col 0
			editor.handleInput("\x1b[B"); // Down - line 2, col 8 (sticky)
			expect(editor.getCursor()).toEqual({ line: 2, col: 8 });

			// Type something to create undo state - this clears sticky and sets col to 9
			editor.handleInput("X");
			expect(editor.getText()).toBe("1234567890\n\n12345678X90");
			expect(editor.getCursor()).toEqual({ line: 2, col: 9 });

			// Move up - establishes new sticky col 9
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 9
			expect(editor.getCursor()).toEqual({ line: 0, col: 9 });

			// Undo - resets sticky column and restores cursor to line 2, col 8
			editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			expect(editor.getText()).toBe("1234567890\n\n1234567890");
			expect(editor.getCursor()).toEqual({ line: 2, col: 8 });

			// Move up - should capture new sticky from restored col 8, not old col 9
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 8 (new sticky from restored position)
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 });
		});

		it("uses the configured undo binding", () => {
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.editor.undo": "f8",
				}),
			);

			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("a");
			expect(editor.getText()).toBe("a");

			editor.handleInput("\x1b[19~"); // F8
			expect(editor.getText()).toBe("");
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("does not swallow keys rebound to copy", () => {
			setKeybindings(
				new KeybindingsManager(TUI_KEYBINDINGS, {
					"tui.input.copy": "left",
				}),
			);

			const editor = new Editor(defaultEditorTheme);
			editor.setText("ab");

			editor.handleInput("\x1b[D"); // Left arrow
			editor.handleInput("X");

			expect(editor.getText()).toBe("aXb");
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		});

		it("strips control characters from pasted text but keeps newlines", () => {
			const editor = new Editor(defaultEditorTheme);
			// BEL (\x07) and NUL (\x00) must be removed; the newline must survive.
			editor.handleInput("\x1b[200~a\x07b\x00c\ndef\x1b[201~");
			expect(editor.getText()).toBe("abc\ndef");
		});

		it("decodes tmux xterm-format re-encoded control bytes in bracketed paste (kitty+tmux)", () => {
			const editor = new Editor(defaultEditorTheme);
			// tmux extended-keys-format=xterm (the default under kitty) re-encodes the
			// newline (Ctrl+J) inside the paste as ESC[27;5;106~. It must land as a real
			// newline, not leak the literal escape tail "[27;5;106~" into the buffer.
			editor.handleInput("\x1b[200~line1\x1b[27;5;106~line2\x1b[201~");
			expect(editor.getText()).toBe("line1\nline2");
		});

		it("decodes tmux csi-u-format re-encoded control bytes in bracketed paste", () => {
			const editor = new Editor(defaultEditorTheme);
			// tmux extended-keys-format=csi-u re-encodes the newline (Ctrl+J) as ESC[106;5u.
			editor.handleInput("\x1b[200~line1\x1b[106;5uline2\x1b[201~");
			expect(editor.getText()).toBe("line1\nline2");
		});

		it("undoes the last paste when a transient #undo trigger is executed", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("\x1b[200~pasted text\x1b[201~");
			expect(editor.getText()).toBe("pasted text");

			editor.handleInput("#");
			editor.handleInput("u");
			editor.handleInput("n");
			editor.handleInput("d");
			editor.handleInput("o");
			expect(editor.getText()).toBe("pasted text#undo");

			editor.undoPastTransientText("#undo");

			expect(editor.getText()).toBe("");
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("removes a transient undo trigger even when there is no earlier edit to restore", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.handleInput("#");
			editor.handleInput("u");
			editor.handleInput("n");
			editor.handleInput("d");
			editor.handleInput("o");
			expect(editor.getText()).toBe("#undo");

			editor.undoPastTransientText("#undo");

			expect(editor.getText()).toBe("");
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("handles multiple consecutive up/down movements", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\nab\ncd\nef\n1234567890");

			// Start at line 4, col 7
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 4, col: 7 });

			// Move up multiple times through short lines
			editor.handleInput("\x1b[A"); // Up - line 3, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 2, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 1, col 2 (clamped)
			editor.handleInput("\x1b[A"); // Up - line 0, col 7 (restored)
			expect(editor.getCursor()).toEqual({ line: 0, col: 7 });

			// Move down multiple times - sticky should still be 7
			editor.handleInput("\x1b[B"); // Down - line 1, col 2
			editor.handleInput("\x1b[B"); // Down - line 2, col 2
			editor.handleInput("\x1b[B"); // Down - line 3, col 2
			editor.handleInput("\x1b[B"); // Down - line 4, col 7 (restored)
			expect(editor.getCursor()).toEqual({ line: 4, col: 7 });
		});

		it("supports PageUp/PageDown for faster visual navigation", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setMaxHeight(6);
			editor.setText("l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9");

			editor.handleInput("\x1b[5~"); // PageUp
			expect(editor.getCursor()).toEqual({ line: 6, col: 2 });

			editor.handleInput("\x1b[5~"); // PageUp
			expect(editor.getCursor()).toEqual({ line: 3, col: 2 });

			editor.handleInput("\x1b[6~"); // PageDown
			expect(editor.getCursor()).toEqual({ line: 6, col: 2 });
		});

		it("PageUp/PageDown on an idle editor never step prompt history (#4754)", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.addToHistory("first prompt");
			editor.addToHistory("second prompt");
			editor.render(80);
			expect(editor.getText()).toBe("");

			editor.handleInput("\x1b[5~"); // PageUp on empty editor
			expect(editor.getText()).toBe("");

			editor.handleInput("\x1b[6~"); // PageDown on empty editor
			expect(editor.getText()).toBe("");

			// While browsing history (entered via Up), PageUp must not advance it.
			editor.handleInput("\x1b[A"); // Up - shows "second prompt"
			expect(editor.getText()).toBe("second prompt");
			editor.handleInput("\x1b[5~"); // PageUp - stays put
			expect(editor.getText()).toBe("second prompt");
		});

		it("moves correctly through wrapped visual lines without getting stuck", () => {
			const editor = new Editor(defaultEditorTheme);

			// Line 0: short
			// Line 1: 30 chars = wraps to multiple visual lines at narrow width
			editor.setText("short\n123456789012345678901234567890");
			editor.render(16); // Narrow width to force wrapping

			// Position at end of line 1 (col 30)
			expect(editor.getCursor()).toEqual({ line: 1, col: 30 });

			// Move up repeatedly - should traverse all visual lines of the wrapped text
			// and eventually reach line 0
			editor.handleInput("\x1b[A"); // Up - to previous visual line within line 1
			expect(editor.getCursor().line).toBe(1);

			editor.handleInput("\x1b[A"); // Up - another visual line
			expect(editor.getCursor().line).toBe(1);

			editor.handleInput("\x1b[A"); // Up - should reach line 0
			expect(editor.getCursor().line).toBe(0);
		});

		it("handles setText resetting sticky column", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// Establish sticky column
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[A"); // Up

			// setText should reset sticky column
			editor.setText("abcdefghij\n\nabcdefghij");
			expect(editor.getCursor()).toEqual({ line: 2, col: 10 }); // At end

			// Move up - should capture new sticky from current position (10)
			editor.handleInput("\x1b[A"); // Up - line 1, col 0
			editor.handleInput("\x1b[A"); // Up - line 0, col 10
			expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
		});

		it("sets preferredVisualCol when pressing right at end of prompt (last line)", () => {
			const editor = new Editor(defaultEditorTheme);

			// Line 0: 20 chars with 'x' at col 10
			// Line 1: empty
			// Line 2: 10 chars ending with '_'
			editor.setText("111111111x1111111111\n\n333333333_");

			// Go to line 0, press Ctrl+E (end of line) - col 20
			editor.handleInput("\x1b[A"); // Up to line 1
			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x05"); // Ctrl+E - move to end of line
			expect(editor.getCursor()).toEqual({ line: 0, col: 20 });

			// Move down to line 2 - cursor clamped to col 10 (end of line)
			editor.handleInput("\x1b[B"); // Down to line 1, col 0
			editor.handleInput("\x1b[B"); // Down to line 2, col 10 (clamped)
			expect(editor.getCursor()).toEqual({ line: 2, col: 10 });

			// Press Right at end of prompt - nothing visible happens, but sets preferredVisualCol to 10
			editor.handleInput("\x1b[C"); // Right - can't move, but sets preferredVisualCol
			expect(editor.getCursor()).toEqual({ line: 2, col: 10 }); // Still at same position

			// Move up twice to line 0 - should use preferredVisualCol (10) to land on 'x'
			editor.handleInput("\x1b[A"); // Up to line 1, col 0
			editor.handleInput("\x1b[A"); // Up to line 0, col 10 (on 'x')
			expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
		});

		it("handles editor resizes when preferredVisualCol is on the same line", () => {
			const editor = new Editor(defaultEditorTheme);

			editor.setText("12345678901234567890\n\n12345678901234567890");

			// Start at line 2, col 15
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");

			// Move up through empty line - establishes sticky col 15
			editor.handleInput("\x1b[A"); // Up
			editor.handleInput("\x1b[A"); // Up - line 0, col 15
			expect(editor.getCursor()).toEqual({ line: 0, col: 15 });

			// Render with narrower width to simulate resize
			editor.render(17); // Width 17 -> layoutWidth 11

			// Move down - sticky should be clamped to new width
			editor.handleInput("\x1b[B"); // Down - line 1
			editor.handleInput("\x1b[B"); // Down - line 2, col should be clamped
			expect(editor.getCursor().col).toBe(4);
		});

		it("handles editor resizes when preferredVisualCol is on a different line", () => {
			const editor = new Editor(defaultEditorTheme);

			// Create a line that wraps into multiple visual lines at width 10
			// "12345678901234567890" = 20 chars, wraps to 2 visual lines at width 10
			editor.setText("short\n12345678901234567890");

			// Go to line 1, col 15
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 1, col: 15 });

			// Move up to establish sticky col 15
			editor.handleInput("\x1b[A"); // Up to line 0
			// Line 0 has only 5 chars, so cursor at col 5
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 });

			// Narrow the editor
			editor.render(15);

			// Move down - preferredVisualCol was 15, but width is 10
			// Should land on line 1, clamped to width (visual col 9, which is logical col 9)
			editor.handleInput("\x1b[B"); // Down to line 1
			expect(editor.getCursor()).toEqual({ line: 1, col: 8 });

			// Move up
			editor.handleInput("\x1b[A"); // Up - should go to line 0
			expect(editor.getCursor()).toEqual({ line: 0, col: 5 }); // Line 0 only has 5 chars

			// Restore the original width
			editor.render(80);

			// Move down - preferredVisualCol was kept at 15
			editor.handleInput("\x1b[B"); // Down to line 1
			expect(editor.getCursor()).toEqual({ line: 1, col: 15 });
		});
		it("expands large pasted content literally in getExpandedText", () => {
			const editor = new Editor(defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			expect(editor.getText()).toMatch(/\[Paste #\d+, \+\d+ lines\]/);
			expect(editor.getExpandedText()).toBe(pastedText);
		});

		it("submits large pasted content literally", () => {
			const editor = new Editor(defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");
			let submitted = "";
			editor.onSubmit = text => {
				submitted = text;
			};

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			editor.handleInput("\r");

			expect(submitted).toBe(pastedText);
		});

		it("formats a large single-line paste as a char-count marker", () => {
			const editor = new Editor(defaultEditorTheme);
			const pastedText = "a".repeat(1500);

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			expect(editor.getText()).toMatch(/^\[Paste #\d+, 1500 chars\]$/);
			expect(editor.getExpandedText()).toBe(pastedText);
		});

		it("deletes an entire paste marker on a single backspace when atomicTokenPattern is set", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
			const pastedText = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			expect(editor.getText()).toMatch(/^\[Paste #\d+, \+\d+ lines\]$/);

			// Cursor sits just after the marker; one backspace removes the whole token
			// rather than corrupting it into stray `[Paste #1, +12 lines` text.
			editor.handleInput("\x7f");
			expect(editor.getText()).toBe("");
		});

		it("deletes an entire marker on forward-delete from its start", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
			editor.setText("[Image #1, 800x600]");

			editor.handleInput("\x01"); // Ctrl+A → start of line
			editor.handleInput("\x1b[3~"); // Delete (forward)
			expect(editor.getText()).toBe("");
		});

		it("removes only the marker and keeps surrounding text on atomic backspace", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
			editor.setText("a [Paste #1, +12 lines] b");

			editor.handleInput("\x05"); // Ctrl+E → end of line
			editor.handleInput("\x1b[D"); // left over 'b'
			editor.handleInput("\x1b[D"); // left over ' ' — cursor now just after ']'
			editor.handleInput("\x7f"); // Backspace deletes the whole marker
			expect(editor.getText()).toBe("a  b");
		});

		it("deletes a marker character-by-character when no atomicTokenPattern is set", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("[Paste #1, +12 lines]");

			editor.handleInput("\x05"); // Ctrl+E → end of line
			editor.handleInput("\x7f"); // Backspace removes only the closing bracket
			expect(editor.getText()).toBe("[Paste #1, +12 lines");
		});

		it("lets onLargePaste intercept a marker-sized paste, suppressing the default marker", () => {
			const editor = new Editor(defaultEditorTheme);
			const seen: Array<{ text: string; lineCount: number }> = [];
			editor.onLargePaste = (text, lineCount) => {
				seen.push({ text, lineCount });
				return true;
			};
			const pastedText = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			// Hook intercepted: nothing inserted, no paste marker, hook saw the full text + line count.
			expect(editor.getText()).toBe("");
			expect(seen).toHaveLength(1);
			expect(seen[0].text).toBe(pastedText);
			expect(seen[0].lineCount).toBe(1200);
		});

		it("falls back to the default marker when onLargePaste declines", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.onLargePaste = () => false;
			const pastedText = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			expect(editor.getText()).toMatch(/^\[Paste #\d+, \+1200 lines\]$/);
			expect(editor.getExpandedText()).toBe(pastedText);
		});

		it("does not call onLargePaste for a sub-marker paste", () => {
			const editor = new Editor(defaultEditorTheme);
			let calls = 0;
			editor.onLargePaste = () => {
				calls++;
				return true;
			};

			editor.handleInput("\x1b[200~just a short paste\x1b[201~");

			expect(calls).toBe(0);
			expect(editor.getText()).toBe("just a short paste");
		});

		it("insertPaste collapses content to a marker that expands on submit", () => {
			const editor = new Editor(defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = text => {
				submitted = text;
			};
			const wrapped = `\`\`\`\n${Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n")}\n\`\`\``;

			editor.insertPaste(wrapped);

			expect(editor.getText()).toMatch(/^\[Paste #\d+, \+\d+ lines\]$/);
			expect(editor.getExpandedText()).toBe(wrapped);

			editor.handleInput("\r");
			expect(submitted).toBe(wrapped);
		});
	});

	describe("Bulk input fast path and paste iteration", () => {
		it("produces identical state for a chunked paste and a single-sequence paste", () => {
			const content = "alpha beta\ngamma delta\nepsilon";
			const single = new Editor(defaultEditorTheme);
			single.handleInput(`\x1b[200~${content}\x1b[201~`);

			const chunked = new Editor(defaultEditorTheme);
			chunked.handleInput("\x1b[200~");
			for (const ch of content) chunked.handleInput(ch);
			chunked.handleInput("\x1b[201~");

			expect(chunked.getText()).toBe(single.getText());
			expect(chunked.getCursor()).toEqual(single.getCursor());
		});

		it("normalizes CRLF identically for single and chunked paste delivery", () => {
			const single = new Editor(defaultEditorTheme);
			single.handleInput("\x1b[200~one\r\ntwo\rthree\x1b[201~");

			const chunked = new Editor(defaultEditorTheme);
			chunked.handleInput("\x1b[200~one\r");
			chunked.handleInput("\ntwo");
			chunked.handleInput("\rthree\x1b[201~");

			expect(single.getText()).toBe("one\ntwo\nthree");
			expect(chunked.getText()).toBe(single.getText());
			expect(chunked.getCursor()).toEqual(single.getCursor());
		});

		it("processes paste remainders iteratively, applying every trailing paste and keystroke", () => {
			const editor = new Editor(defaultEditorTheme);
			// One read carrying two complete pastes plus trailing typed text: the
			// remainder after each paste loops back through input handling.
			editor.handleInput("\x1b[200~ab\x1b[201~\x1b[200~cd\x1b[201~ef");
			expect(editor.getText()).toBe("abcdef");
			expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
		});

		it("handles a long train of pastes in one read without recursing per remainder", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.handleInput("\x1b[200~x\x1b[201~".repeat(2000));
			expect(editor.getText()).toBe("x".repeat(2000));
		});

		it("inserts a plain printable run identically to per-scalar delivery", () => {
			const run = "The quick brown fox 123 -_. naïve 😀 path";
			const bulk = new Editor(defaultEditorTheme);
			bulk.handleInput(run);

			const perChar = new Editor(defaultEditorTheme);
			for (const ch of run) perChar.handleInput(ch);

			expect(bulk.getText()).toBe(perChar.getText());
			expect(bulk.getCursor()).toEqual(perChar.getCursor());
		});

		it("keeps escape sequences interleaved with printable runs on the dispatch path", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.handleInput("abc");
			editor.handleInput("\x1b[D"); // Left
			editor.handleInput("XY"); // bulk run lands before "c"
			expect(editor.getText()).toBe("abXYc");
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
		});

		it("opens @ autocomplete when the trigger arrives inside a bulk printable run", async () => {
			const editor = new Editor(defaultEditorTheme);
			const { promise: autocompleteUpdated, resolve: resolveAutocompleteUpdated } = Promise.withResolvers<void>();
			editor.setAutocompleteProvider({
				async getSuggestions() {
					return { items: [{ label: "src/", value: "src/" }], prefix: "@sr" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.onAutocompleteUpdate = resolveAutocompleteUpdated;

			editor.handleInput("see @sr"); // one bulk run ending in an @-token

			await autocompleteUpdated;
			expect(editor.isShowingAutocomplete()).toBe(true);
		});

		it("opens @ autocomplete after a bracketed paste ending in a trigger token", async () => {
			const editor = new Editor(defaultEditorTheme);
			const { promise: autocompleteUpdated, resolve: resolveAutocompleteUpdated } = Promise.withResolvers<void>();
			editor.setAutocompleteProvider({
				async getSuggestions() {
					return { items: [{ label: "src/", value: "src/" }], prefix: "@sr" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.onAutocompleteUpdate = resolveAutocompleteUpdated;

			editor.handleInput("\x1b[200~see @sr\x1b[201~");

			await autocompleteUpdated;
			expect(editor.isShowingAutocomplete()).toBe(true);
		});
	});

	describe("Korean NFC paste normalization", () => {
		// macOS Finder drag-drops/Copy-As-Pathname emit Korean filenames as
		// NFD (decomposed) — e.g. `화` becomes `ᄒ`(U+1112) + `ᅪ`(U+116A).
		// `Bun.stringWidth` measures NFD jamo at 3 cells per syllable while
		// terminals render the precomposed syllable at 2 cells, so without
		// normalization the cursor column drifts past the visible filename
		// and subsequent input renders into the wrong row. The earlier fix
		// landed on the legacy `Input` component; OMP's interactive prompt
		// uses `Editor`, so the fix has to live here too.

		it("normalizes NFD Korean bracketed-paste to NFC", () => {
			const editor = new Editor(defaultEditorTheme);
			const nfcPath = "/Users/leo/Documents/260411_아빠-창고-미팅-1회차";
			const nfdPath = nfcPath.normalize("NFD");
			expect(nfdPath).not.toBe(nfcPath);
			expect(nfdPath.length).toBeGreaterThan(nfcPath.length);

			editor.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

			expect(editor.getText()).toBe(nfcPath);
		});

		it("renders pasted Korean path as precomposed syllables, not NFD jamo", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.focused = true;
			const nfdPath = "/Users/leo/화면 기록.mov".normalize("NFD");
			editor.handleInput(`\x1b[200~${nfdPath}\x1b[201~`);

			const rendered = editor.render(120).join("\n");
			// Precomposed syllables (`화`, `면`, `기`, `록`) must appear in the
			// rendered output. If NFC normalization is missing, the rendered
			// text contains NFD jamo (`ᄒ`+`ᅪ`+`ᇁ` etc.) instead.
			expect(rendered).toContain("화면");
			expect(rendered).toContain("기록");
			// The leading Hangul jamo block (U+1100..U+1112) only appears in
			// NFD output. The Editor must not leak it after normalization.
			expect(rendered).not.toMatch(/[\u1100-\u1112]/);
		});
	});

	describe("Grapheme-aware vertical movement", () => {
		it("snaps vertical movement to grapheme boundaries instead of splitting surrogate pairs", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("ab\n😀😀");

			editor.handleInput("\x1b[A"); // Up to line 0
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // Right → col 1
			expect(editor.getCursor()).toEqual({ line: 0, col: 1 });

			// Down: visual col 1 is inside the first 😀 (2 cells, surrogate pair).
			// The cursor must snap to a grapheme boundary, never land mid-pair.
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			// Typing here must not corrupt the emoji buffer
			editor.handleInput("X");
			expect(editor.getText()).toBe("ab\nX😀😀");
		});

		it("preserves the visual column across lines of different glyph widths", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("ああああ\nabcdefgh");

			editor.handleInput("\x01"); // Ctrl+A on line 1
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C"); // Right ×4 → col 4
			expect(editor.getCursor()).toEqual({ line: 1, col: 4 });

			// Up: visual col 4 on the CJK line is two double-width glyphs → logical col 2,
			// not col 4 (which would be visual col 8 / end of line).
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		});
	});

	describe("Whitespace trimmed at wrap points", () => {
		it("maps cursor positions inside wrap-trimmed whitespace to a layout line", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setText("aaaa bbbb\nzzzz");
			editor.render(10); // layoutWidth 4 → "aaaa bbbb" wraps at the space

			// Up from "zzzz" lands on the second visual segment of line 0
			editor.handleInput("\x1b[A");
			expect(editor.getCursor()).toEqual({ line: 0, col: 9 });

			// Place the cursor on the trimmed space (line 0, col 4)
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 });

			// Down must move within line 0's wrapped segments. Before the fix the
			// position was unmapped: the cursor fell through to the buffer's last
			// visual line and Down became a no-op.
			editor.handleInput("\x1b[B");
			expect(editor.getCursor()).toEqual({ line: 0, col: 9 });
		});
	});

	describe("Atomic tokens in kill operations", () => {
		it("extends word-delete backwards over an intersected atomic token", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
			editor.setText("a [Paste #1, +12 lines]");

			// Ctrl+W from the end must consume the whole marker, not leave "[Paste #1, +12 " behind
			editor.handleInput("\x17");
			expect(editor.getText()).toBe("a ");
		});

		it("extends kill-to-end-of-line over an atomic token the cursor sits inside", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.atomicTokenPattern = /\[(?:Image|Paste) #\d+(?:,[^\]\n]*)?\]/g;
			editor.setText("a [Paste #1, +12 lines] b");

			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C"); // into the marker
			editor.handleInput("\x0b"); // Ctrl+K
			expect(editor.getText()).toBe("a ");
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		});
	});

	describe("Undo coalescing", () => {
		it("coalesces consecutive word typing into a single undo unit", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.handleInput("h");
			editor.handleInput("i");
			editor.handleInput(" ");
			editor.handleInput("y");
			editor.handleInput("o");
			expect(editor.getText()).toBe("hi yo");

			editor.handleInput("\x1b[45;5u"); // undo → removes "yo"
			expect(editor.getText()).toBe("hi ");
			editor.handleInput("\x1b[45;5u"); // undo → removes the space
			expect(editor.getText()).toBe("hi");
			editor.handleInput("\x1b[45;5u"); // undo → removes "hi"
			expect(editor.getText()).toBe("");
		});
	});

	describe("decorateText around the cursor seam", () => {
		// Editor.#decorate is the only seam that sees both the user prose AND the
		// trailing CURSOR_MARKER, so a decorator with a right-boundary lookahead
		// (like the magic-keyword regex /(?<!\S)ultrathink(?!\S)/g) would reject
		// matches glued to the marker — ESC is non-whitespace. The editor must
		// split around the marker so each side decorates as if it were a complete
		// line. This guards the "ultrathink doesn't glow until you type a trailing
		// character" regression reported in #2475.
		const WORD_RE = /(?<!\S)ultrathink(?!\S)/g;
		const PAINT_PREFIX = "<<";
		const PAINT_SUFFIX = ">>";
		const paintKeyword = (text: string): string => text.replace(WORD_RE, m => `${PAINT_PREFIX}${m}${PAINT_SUFFIX}`);

		it("decorates a keyword glued to the trailing cursor marker", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.decorateText = paintKeyword;
			editor.focused = true;
			editor.setText("ultrathink");

			const line = editor.render(40).join("\n");
			// Without the seam fix, the decorator's right-boundary `(?!\S)` would
			// trip on ESC (the first byte of CURSOR_MARKER) and the keyword would
			// survive verbatim. With it, the marker bookends the painted region.
			expect(line).toContain(`${PAINT_PREFIX}ultrathink${PAINT_SUFFIX}`);
		});

		it("decorates keywords on both sides of the cursor in terminal-cursor mode", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.decorateText = paintKeyword;
			editor.focused = true;
			editor.setUseTerminalCursor(true);
			editor.setText("ultrathink ultrathink");
			// Position the hardware cursor between the two keywords.
			editor.handleInput("\x01"); // Ctrl+A → start of line
			editor.handleInput("\x05"); // Ctrl+E → end of line
			for (let i = 0; i < "ultrathink".length; i++) editor.handleInput("\x1b[D"); // 10× left

			const line = editor.render(60).join("\n");
			// Both keywords are painted independently — left side ends just before
			// the marker, right side begins right after it.
			const occurrences = line.split(`${PAINT_PREFIX}ultrathink${PAINT_SUFFIX}`).length - 1;
			expect(occurrences).toBe(2);
			expect(line).toContain(CURSOR_MARKER);
		});

		it("preserves the marker as-is — never splits or duplicates it", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.decorateText = paintKeyword;
			editor.focused = true;
			editor.setText("ultrathink");

			const line = editor.render(40).join("\n");
			expect(line.split(CURSOR_MARKER).length - 1).toBe(1);
		});
	});

	describe("volatile speech-to-text preview", () => {
		it("replaces the volatile preview in place rather than appending", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVolatileText("hel");
			expect(editor.getText()).toBe("hel");
			editor.setVolatileText("hello wor");
			expect(editor.getText()).toBe("hello wor");
			editor.setVolatileText("hello world");
			expect(editor.getText()).toBe("hello world");
		});

		it("commits the preview as permanent text and previews the next phrase after it", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVolatileText("hello wor");
			editor.commitVolatileText("hello world");
			expect(editor.getText()).toBe("hello world");
			editor.setVolatileText(" goodby");
			expect(editor.getText()).toBe("hello world goodby");
			editor.commitVolatileText(" goodbye");
			expect(editor.getText()).toBe("hello world goodbye");
		});

		it("clears the preview without committing it", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.insertText("note: ");
			editor.setVolatileText("scratch that");
			expect(editor.getText()).toBe("note: scratch that");
			editor.clearVolatileText();
			expect(editor.getText()).toBe("note: ");
		});

		it("keeps preview churn out of the undo history (one undo drops a committed phrase)", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.insertText("pre ");
			editor.setVolatileText("u");
			editor.setVolatileText("um");
			editor.setVolatileText("um hel");
			editor.commitVolatileText("hello");
			expect(editor.getText()).toBe("pre hello");
			editor.handleInput("\x1b[45;5u"); // undo → removes the committed phrase, not preview fragments
			expect(editor.getText()).toBe("pre ");
		});

		it("replaces a multi-line preview across line boundaries", () => {
			const editor = new Editor(defaultEditorTheme);
			editor.setVolatileText("line one\nline two");
			expect(editor.getText()).toBe("line one\nline two");
			editor.setVolatileText("single line");
			expect(editor.getText()).toBe("single line");
		});
	});

	describe("composer border styles", () => {
		const unicodeTheme: EditorTheme = {
			...defaultEditorTheme,
			borderColor: (t: string) => t,
			symbols: {
				cursor: "❯",
				inputCursor: "│",
				boxRound: {
					topLeft: "╭",
					topRight: "╮",
					bottomLeft: "╰",
					bottomRight: "╯",
					horizontal: "─",
					vertical: "│",
				},
				boxSharp: {
					topLeft: "┌",
					topRight: "┐",
					bottomLeft: "└",
					bottomRight: "┘",
					horizontal: "─",
					vertical: "│",
					teeDown: "┬",
					teeUp: "┴",
					teeLeft: "├",
					teeRight: "┤",
					cross: "┼",
				},
				table: {
					topLeft: "┌",
					topRight: "┐",
					bottomLeft: "└",
					bottomRight: "┘",
					horizontal: "─",
					vertical: "│",
					teeDown: "┬",
					teeUp: "┴",
					teeLeft: "├",
					teeRight: "┤",
					cross: "┼",
				},
				quoteBorder: "│",
				hrChar: "─",
				spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
			},
		};

		it("renders claude style with top and bottom horizontal rules and prompt gutter", () => {
			const editor = new Editor(unicodeTheme);
			editor.setBorderStyle("claude");
			editor.setText("hello");
			const lines = editor.render(20);
			expect(lines.length).toBe(3); // top rule, content, bottom rule
			expect(lines[0]).toBe("─".repeat(20));
			expect(lines[1]).toContain("❯ hello");
			expect(lines[2]).toBe("─".repeat(20));
		});

		it("renders pi style with full-width rules, padded content, and no prompt gutter", () => {
			const editor = new Editor(unicodeTheme);
			editor.setBorderStyle("pi");
			editor.setText("hello");
			const lines = editor.render(20);
			expect(lines.length).toBe(3); // top rule, content, bottom rule
			expect(lines[0]).toBe("─".repeat(20));
			expect(lines[1]).toStartWith(" hello");
			expect(lines[1]).not.toContain(">");
			expect(lines[2]).toBe("─".repeat(20));
		});

		it("renders borderless style without box borders", () => {
			const editor = new Editor(unicodeTheme);
			editor.setBorderStyle("borderless");
			editor.setText("hello");
			const lines = editor.render(20);
			expect(lines.length).toBe(1); // content only
			expect(lines[0]).toContain("❯ hello");
		});

		it("renders default box style with compact bottom border", () => {
			const editor = new Editor(unicodeTheme);
			editor.setText("hello");
			const lines = editor.render(20);
			expect(lines.length).toBe(2); // top border, bottom border with content
			expect(lines[0]).toContain("╭");
			expect(lines[1]).toContain("╰─ hello");
		});

		it("renders rule style as a top-rule dock without closing chrome", () => {
			const editor = new Editor(unicodeTheme);
			editor.setBorderStyle("rule");
			editor.setText("hello");
			const lines = editor.render(20);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("─".repeat(20));
			expect(lines[1]).toStartWith("❯ hello");
		});

		it("renders field style as one filled row with accent caps", () => {
			const editor = new Editor({
				...unicodeTheme,
				accentColor: text => `\x1b[35m${text}\x1b[39m`,
				surfaceColor: text => `\x1b[44m${text}\x1b[49m`,
			});
			editor.setBorderStyle("field");
			editor.setText("hello");
			const [line] = editor.render(20);
			expect(stripVTControlCharacters(line)).toStartWith("▐ hello");
			expect(stripVTControlCharacters(line)).toEndWith("▌");
			expect(visibleWidth(line)).toBe(20);
			expect(line).toContain("\x1b[44m");
		});

		it("renders rail style as a full-width surface with one accent edge", () => {
			const editor = new Editor({
				...unicodeTheme,
				accentColor: text => `\x1b[35m${text}\x1b[39m`,
				surfaceColor: text => `\x1b[44m${text}\x1b[49m`,
			});
			editor.setBorderStyle("rail");
			editor.setText("hello");
			const [line] = editor.render(20);
			expect(stripVTControlCharacters(line)).toStartWith("▎ hello");
			expect(stripVTControlCharacters(line)).not.toContain("▌");
			expect(visibleWidth(line)).toBe(20);
			expect(line).toContain("\x1b[44m");
		});

		it("preserves filled extension foregrounds when legacy styles omit filledSurface", () => {
			const style: ComposerStyle = {
				id: "legacy-filled-extension",
				sideBorders: false,
				verticalChrome: 0,
				statusAttachment: "none",
				bottomBar: "none",
				bottomBarGap: false,
				defaultPromptGutter: undefined,
				defaultPaddingX: () => 0,
				sideChromeWidth: () => 0,
				renderTop: () => undefined,
				renderRow: context => [context.surfaceColor(context.text + context.pad)],
				renderBottom: () => undefined,
			};
			const unregister = registerComposerStyle(style);
			try {
				const editor = new Editor({
					...unicodeTheme,
					textColor: text => `\x1b[31m${text}\x1b[39m`,
					surfaceColor: text => `\x1b[44m\x1b[37m${text}\x1b[39m\x1b[49m`,
				});
				editor.setBorderStyle(style.id);
				editor.setText("hello");

				const [line] = editor.render(20);
				expect(line).toContain("\x1b[44m\x1b[37mhello");
				expect(line).not.toContain("\x1b[44m\x1b[37m\x1b[31m");
			} finally {
				unregister();
			}
		});
	});
});
