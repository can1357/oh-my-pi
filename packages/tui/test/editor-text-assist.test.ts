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
	it("accepts word completion with right arrow at end of line", () => {
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setTextAssistProvider(assist);
		editor.setText("The weath");

		editor.handleInput("\x1b[C");

		expect(editor.getText()).toBe("The weather ");
		expect(editor.getCursor()).toEqual({ line: 0, col: 12 });
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

	it("accepts word completion before whitespace or closing punctuation without adding a space", () => {
		for (const suffix of [" rest", ", later"]) {
			const assist: EditorTextAssistProvider = {
				getWordCompletion: (lines, line, col) =>
					(lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null,
			};
			const editor = new Editor(defaultEditorTheme);
			editor.setTextAssistProvider(assist);
			editor.setText(`The weath${suffix}`);
			for (let i = 0; i < suffix.length; i++) editor.handleInput("\x1b[D");

			editor.handleInput("\t");

			expect(editor.getText()).toBe(`The weather${suffix}`);
			expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
		}
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
