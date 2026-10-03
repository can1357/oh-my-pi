import { describe, expect, it } from "bun:test";
import { Editor, type EditorTextAssistProvider } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

describe("Editor text assistance", () => {
	it("accepts word completion at end of line with a trailing space", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		expect(editor.render(40).join("\n")).toContain("er");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("The weather ");
		expect(editor.getCursor()).toEqual({ line: 0, col: 12 });
	});
	it("reports Tab acceptance with the state the ghost was shown for", () => {
		const feedback: Array<[string, number, string, boolean]> = [];
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
			wordCompletionFeedback: (lines, line, col, suggestion, accepted) => {
				feedback.push([lines[line] ?? "", col, suggestion, accepted]);
			},
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		editor.handleInput("\t");

		expect(feedback).toEqual([["The weath", 9, "er", true]]);
	});

	it("reports a ghost as typed past only when a typed character diverges from it", () => {
		const feedback: Array<[string, string, boolean]> = [];
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => {
				const typed = (lines[line] ?? "").slice(0, col);
				if (typed.endsWith("weath")) return "er";
				if (typed.endsWith("weathe")) return "r";
				return null;
			},
			wordCompletionFeedback: (lines, line, col, suggestion, accepted) => {
				feedback.push([(lines[line] ?? "").slice(0, col), suggestion, accepted]);
			},
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		editor.handleInput("e");
		expect(feedback).toEqual([]);
		editor.handleInput("d");

		expect(editor.getText()).toBe("The weathed");
		expect(feedback).toEqual([["The weathe", "r", false]]);
	});

	it("resolves the provisional space from Tab accept against the next keystroke", () => {
		const cases: Array<[keys: string[], text: string]> = [
			[["."], "The weather."],
			[[")"], "The weather)"],
			[["-", "l"], "The weather-l"],
			[[" ", "-"], "The weather -"],
			[["\n", "i"], "The weather\ni"],
			[[" ", "i"], "The weather i"],
			[[" ", " "], "The weather  "],
			[["i"], "The weather i"],
			[['"'], 'The weather "'],
			[["\x1b[D", "\x1b[C", "."], "The weather ."],
		];
		for (const [keys, text] of cases) {
			const assist: EditorTextAssistProvider = {
				getWordCompletion: (lines, line, col) =>
					(lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null,
			};
			const editor = new Editor(defaultEditorTheme);
			editor.setTextAssistProvider(assist);
			editor.setText("The weath");

			editor.handleInput("\t");
			for (const key of keys) editor.handleInput(key);

			expect(editor.getText()).toBe(text);
		}
	});

	it("undoes punctuation typed over the provisional space back to the accepted word and space", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		editor.handleInput("\t");
		editor.handleInput(".");
		editor.handleInput("\x1f"); // Ctrl+_ (undo)

		expect(editor.getText()).toBe("The weather ");
	});

	it("accepts word completion with right arrow at end of line without a trailing space", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		editor.handleInput("\x1b[C");
		editor.handleInput("s");

		expect(editor.getText()).toBe("The weathers");
	});

	it("keeps right arrow as movement mid-line even when a word completion exists", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath end");
		editor.handleInput("\x01"); // Ctrl+A
		for (let i = 0; i < 9; i++) editor.handleInput("\x1b[C"); // after "weath"

		editor.handleInput("\x1b[C");

		expect(editor.getText()).toBe("The weath end");
		expect(editor.getCursor()).toEqual({ line: 0, col: 10 });
	});

	it("neither accepts nor reports a mid-line word completion, which is never rendered", () => {
		const feedback: string[] = [];
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
			wordCompletionFeedback: (_lines, _line, _col, suggestion) => {
				feedback.push(suggestion);
			},
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath)");
		editor.handleInput("\x1b[D");

		editor.handleInput("\t");
		editor.handleInput("x");

		expect(editor.getText()).toBe("The weathx)");
		expect(feedback).toEqual([]);
	});

	it("applies autocorrection only after the provider returns a boundary replacement", () => {
		const assist: EditorTextAssistProvider = {
			tryAutocorrect: (lines, line, col) =>
				(lines[line] ?? "").slice(0, col).endsWith("teh ") ? { replaceLen: 4, insert: "the " } : null,
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("I typed teh");

		editor.handleInput(" ");

		expect(editor.getText()).toBe("I typed the ");
	});

	it("applies an async autocorrection and notifies the host when the document is untouched", async () => {
		const correction = Promise.withResolvers<{ replaceLen: number; insert: string } | null>();
		const assist: EditorTextAssistProvider = {
			tryAutocorrect: (lines, line, col) =>
				(lines[line] ?? "").slice(0, col).endsWith("teh ") ? correction.promise : null,
		};
		const editor = new Editor(defaultEditorTheme);
		let applied = 0;
		editor.onTextAssistApplied = () => applied++;
		editor.setTextAssistProvider(assist);
		editor.setText("I typed teh");

		editor.handleInput(" ");
		expect(editor.getText()).toBe("I typed teh ");
		correction.resolve({ replaceLen: 4, insert: "the " });
		await correction.promise;
		await Promise.resolve();

		expect(editor.getText()).toBe("I typed the ");
		expect(applied).toBe(1);
	});

	it("drops an async autocorrection when the user types before it resolves", async () => {
		const correction = Promise.withResolvers<{ replaceLen: number; insert: string } | null>();
		const assist: EditorTextAssistProvider = {
			tryAutocorrect: (lines, line, col) =>
				(lines[line] ?? "").slice(0, col).endsWith("teh ") ? correction.promise : null,
		};
		const editor = new Editor(defaultEditorTheme);
		let applied = 0;
		editor.onTextAssistApplied = () => applied++;
		editor.setTextAssistProvider(assist);
		editor.setText("I typed teh");

		editor.handleInput(" ");
		editor.handleInput("x");
		correction.resolve({ replaceLen: 4, insert: "the " });
		await correction.promise;
		await Promise.resolve();

		expect(editor.getText()).toBe("I typed teh x");
		expect(applied).toBe(0);
	});

	it("opens spelling replacements with Ctrl+. and applies the selected word", () => {
		const assist: EditorTextAssistProvider = {
			getWordReplacements: () => ({
				line: 0,
				startCol: 0,
				endCol: 8,
				items: ["received", "relieved"],
			}),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("recieved ");

		editor.handleInput("\x1b[46;5u");

		expect(editor.isAutocompleteActive()).toBeTrue();
		expect(editor.render(40).join("\n")).toContain("received");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("received ");
		expect(editor.getCursor()).toEqual({ line: 0, col: 9 });
	});
	it("applies the selected spelling replacement with right arrow at end of line", () => {
		const assist: EditorTextAssistProvider = {
			getWordReplacements: () => ({
				line: 0,
				startCol: 0,
				endCol: 8,
				items: ["received", "relieved"],
			}),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("recieved");

		editor.handleInput("\x1b[46;5u");

		expect(editor.isAutocompleteActive()).toBeTrue();
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe("received");
		expect(editor.getCursor()).toEqual({ line: 0, col: 8 });
	});

	it("opens async spelling replacements", async () => {
		const suggestions = Promise.withResolvers<{
			line: number;
			startCol: number;
			endCol: number;
			items: string[];
		} | null>();
		const assist: EditorTextAssistProvider = {
			getWordReplacements: () => suggestions.promise,
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("recieved ");

		editor.handleInput("\x1b[46;5u");
		expect(editor.isAutocompleteActive()).toBeFalse();
		suggestions.resolve({
			line: 0,
			startCol: 0,
			endCol: 8,
			items: ["received", "relieved"],
		});
		await suggestions.promise;
		await Promise.resolve();

		expect(editor.isAutocompleteActive()).toBeTrue();
		expect(editor.render(40).join("\n")).toContain("received");
	});
});
