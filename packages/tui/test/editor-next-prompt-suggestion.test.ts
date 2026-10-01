import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

describe("Editor next prompt suggestion", () => {
	it("describes a contextual ghost for native hosts and accepts it without submitting or replacing a placeholder", () => {
		const editor = new Editor(defaultEditorTheme);
		const suggestion = "Inspect the current result";
		let submitted = false;
		editor.placeholder = () => "Start typing";
		editor.describePlaceholder = () => "Start typing";
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.setNextPromptSuggestion(suggestion);
		const described = editor.describe({
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		});
		const input = described.c?.find(child => "k" in child && child.k === "editor");
		expect(input).toMatchObject({ p: { text: "", ghost: suggestion, placeholder: undefined } });
		editor.handleInput("\t");
		expect(editor.getText()).toBe(suggestion);
		expect(submitted).toBe(false);
	});

	it.each(["field", "rail"])(
		"keeps the IME cursor row clear while showing a contextual ghost in the %s composer",
		shape => {
			const editor = new Editor(defaultEditorTheme);
			const suggestion = "Inspect the current result";
			editor.setBorderStyle(shape);
			editor.focused = true;
			editor.setUseTerminalCursor(true);
			editor.setImeSafeCursorLayout(true);
			editor.setNextPromptSuggestion(suggestion);
			const rendered = editor.render(80);
			const cursorRow = rendered.find(line => line.includes(CURSOR_MARKER))!;
			expect(
				stripVTControlCharacters(cursorRow.slice(cursorRow.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length)),
			).toBe("");
			expect(stripVTControlCharacters(rendered.join("\n"))).toContain(suggestion);
			editor.handleInput("\t");
			expect(editor.getText()).toBe(suggestion);
		},
	);

	it("renders a contextual ghost outside the buffer and accepts it with Tab without submitting", () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		let submitted: string | undefined;
		const changes: string[] = [];
		editor.onSubmit = text => {
			submitted = text;
		};
		editor.onChange = text => {
			changes.push(text);
		};

		editor.setNextPromptSuggestion(suggestion);

		expect(editor.getText()).toBe("");
		expect(stripVTControlCharacters(editor.render(80).join("\n"))).toContain(suggestion);

		editor.handleInput("\t");

		expect(editor.getText()).toBe(suggestion);
		expect(submitted).toBeUndefined();
		expect(editor.getCursor()).toEqual({ line: 0, col: suggestion.length });
		expect(changes).toEqual([suggestion]);

		editor.handleInput("\x1b[45;5u");

		expect(editor.getText()).toBe("");
		expect(changes).toEqual([suggestion, ""]);
	});

	it("renders and accepts a contextual ghost with the IME-safe hardware cursor layout", () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		let submitted: string | undefined;
		editor.focused = true;
		editor.setUseTerminalCursor(true);
		editor.setImeSafeCursorLayout(true);
		editor.onSubmit = text => {
			submitted = text;
		};
		editor.setNextPromptSuggestion(suggestion);

		const rendered = editor.render(80).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));

		expect(rendered[1]).toBe("|  ");
		expect(rendered[2]).toContain(suggestion);
		editor.handleInput("\t");
		expect(editor.getText()).toBe(suggestion);
		expect(submitted).toBeUndefined();
	});

	it("notifies focus changes only on real transitions", () => {
		const editor = new Editor(defaultEditorTheme);
		const transitions: boolean[] = [];
		editor.onFocusChange = focused => {
			transitions.push(focused);
		};

		editor.focused = false;
		editor.focused = true;
		editor.focused = true;
		editor.focused = false;
		editor.focused = false;

		expect(transitions).toEqual([true, false]);
	});

	it("refuses an installed suggestion until a contextual prefix has been painted", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setNextPromptSuggestion("Inspect the failing test");

		expect(editor.acceptNextPromptSuggestion()).toBe(false);
		expect(editor.getText()).toBe("");

		editor.render(80);
		editor.clearNextPromptSuggestion();

		expect(editor.acceptNextPromptSuggestion()).toBe(false);
		expect(stripVTControlCharacters(editor.render(80).join("\n"))).not.toContain("Inspect the failing test");
	});

	it("refuses a painted suggestion when the editor is no longer empty", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setNextPromptSuggestion("Inspect the failing test");
		editor.render(80);
		editor.setText("Keep this draft");

		expect(editor.acceptNextPromptSuggestion()).toBe(false);
		expect(editor.getText()).toBe("Keep this draft");
	});

	it("lets a provider hint that appears at accept time win over a painted contextual ghost", () => {
		const editor = new Editor(defaultEditorTheme);
		let inlineHint: string | null = null;
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
			getInlineHint() {
				return inlineHint;
			},
		});
		editor.setNextPromptSuggestion("Inspect the failing test");
		editor.render(80);
		inlineHint = "Provider hint";

		expect(editor.acceptNextPromptSuggestion()).toBe(false);
		expect(editor.getText()).toBe("");
		const rendered = stripVTControlCharacters(editor.render(80).join("\n"));
		expect(rendered).toContain("Provider hint");
		expect(rendered).not.toContain("Inspect the failing test");
	});

	it("refuses a painted suggestion while an autocomplete popup is open", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "help", hint: "Selected item hint" }], prefix: "/" };
			},
			applyCompletion() {
				return { lines: ["/help"], cursorLine: 0, cursorCol: 5 };
			},
		});
		const popupOpened = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = () => {
			if (editor.isShowingAutocomplete()) popupOpened.resolve();
		};
		editor.setNextPromptSuggestion("Inspect the failing test");
		editor.render(80);
		editor.handleInput("/");
		await popupOpened.promise;
		const popupRender = stripVTControlCharacters(editor.render(80).join("\n"));
		expect(popupRender).toContain("Selected item hint");
		expect(popupRender).not.toContain("Inspect the failing test");
		editor.setText("");

		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(editor.acceptNextPromptSuggestion()).toBe(false);
		expect(editor.getText()).toBe("");

		editor.setText("/");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("/help");
	});

	it("does not retrigger autocomplete after accepting suggestions that start with a slash, an at sign, or a hash", async () => {
		for (const suggestion of ["/continue debugging", "@src inspect this file", "#review changes"]) {
			const editor = new Editor(defaultEditorTheme);
			let suggestionRequests = 0;
			editor.setAutocompleteProvider({
				async getSuggestions() {
					suggestionRequests += 1;
					return { items: [{ label: "completion", value: "completion" }], prefix: suggestion[0] ?? "" };
				},
				applyCompletion(lines, cursorLine, cursorCol) {
					return { lines, cursorLine, cursorCol };
				},
			});
			editor.setNextPromptSuggestion(suggestion);
			editor.render(80);

			editor.handleInput("\t");
			await Bun.sleep(0);

			expect(editor.getText()).toBe(suggestion);
			expect(suggestionRequests).toBe(0);
			expect(editor.isShowingAutocomplete()).toBe(false);
		}
	});

	it("clears the logical suggestion before notifying onChange", () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		const changes: string[] = [];
		let reentrantAcceptance: boolean | undefined;
		editor.onChange = text => {
			changes.push(text);
			editor.onChange = undefined;
			editor.setText("");
			reentrantAcceptance = editor.acceptNextPromptSuggestion();
		};
		editor.setNextPromptSuggestion(suggestion);
		editor.render(80);

		expect(editor.acceptNextPromptSuggestion()).toBe(true);
		expect(changes).toEqual([suggestion]);
		expect(reentrantAcceptance).toBe(false);
	});

	it("preserves forced completion when contextual text has zero terminal width", async () => {
		const suggestion = "\u200B";
		const editor = new Editor(defaultEditorTheme);
		let fallbackRequests = 0;
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			async getForceFileSuggestions() {
				fallbackRequests += 1;
				return { items: [{ label: "fallback", value: "fallback" }], prefix: "" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.setNextPromptSuggestion(suggestion);

		expect(visibleWidth(suggestion)).toBe(0);
		editor.render(80);
		editor.handleInput("\t");
		await Bun.sleep(0);

		expect(editor.getText()).toBe("");
		expect(fallbackRequests).toBe(1);
		expect(editor.isShowingAutocomplete()).toBe(true);
	});

	it("preserves forced completion when no contextual grapheme fits", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], import.meta.dir));
		editor.setNextPromptSuggestion("Inspect the failing test");
		editor.render(7);

		expect(editor.acceptNextPromptSuggestion()).toBe(false);

		const popupOpened = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = () => {
			if (editor.isShowingAutocomplete()) popupOpened.resolve();
		};
		editor.handleInput("\t");
		await popupOpened.promise;

		expect(editor.getText()).toBe("");
		expect(editor.isShowingAutocomplete()).toBe(true);

		const editorWithoutGhost = new Editor(defaultEditorTheme);
		editorWithoutGhost.setAutocompleteProvider(new CombinedAutocompleteProvider([], import.meta.dir));
		const fallbackPopupOpened = Promise.withResolvers<void>();
		editorWithoutGhost.onAutocompleteUpdate = () => {
			if (editorWithoutGhost.isShowingAutocomplete()) fallbackPopupOpened.resolve();
		};

		editorWithoutGhost.handleInput("\t");
		await fallbackPopupOpened.promise;

		expect(editorWithoutGhost.getText()).toBe("");
		expect(editorWithoutGhost.isShowingAutocomplete()).toBe(true);

		const editorWithPaintedGhost = new Editor(defaultEditorTheme);
		editorWithPaintedGhost.setAutocompleteProvider(new CombinedAutocompleteProvider([], import.meta.dir));
		let paintedGhostAutocompleteUpdates = 0;
		editorWithPaintedGhost.onAutocompleteUpdate = () => {
			paintedGhostAutocompleteUpdates += 1;
		};
		editorWithPaintedGhost.setNextPromptSuggestion("Inspect the failing test");
		editorWithPaintedGhost.render(80);

		editorWithPaintedGhost.handleInput("\t");
		await Bun.sleep(0);

		expect(editorWithPaintedGhost.getText()).toBe("Inspect the failing test");
		expect(editorWithPaintedGhost.isShowingAutocomplete()).toBe(false);
		expect(paintedGhostAutocompleteUpdates).toBe(0);
	});

	it("accepts the complete logical suggestion when only a real prefix fits", () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		editor.setNextPromptSuggestion(suggestion);

		const rendered = stripVTControlCharacters(editor.render(8).join("\n"));

		expect(rendered).toContain("I");
		expect(rendered).not.toContain("…");
		editor.handleInput("\t");
		expect(editor.getText()).toBe(suggestion);
	});

	it("does not revive a suggestion invalidated while a popup was open", async () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "/help", value: "help" }], prefix: "/" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		const popupOpened = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = () => {
			if (!editor.isShowingAutocomplete()) return;
			editor.clearNextPromptSuggestion();
			popupOpened.resolve();
		};
		editor.setNextPromptSuggestion(suggestion);
		editor.render(80);

		editor.handleInput("/");
		await popupOpened.promise;
		editor.render(80);
		editor.handleInput("\x1b");
		editor.setText("");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(stripVTControlCharacters(editor.render(80).join("\n"))).not.toContain(suggestion);
		expect(editor.acceptNextPromptSuggestion()).toBe(false);
	});

	it("cancels an older asynchronous completion before inserting the suggestion", async () => {
		const suggestion = "Inspect the failing test";
		const editor = new Editor(defaultEditorTheme);
		const pendingSuggestions = Promise.withResolvers<{
			items: Array<{ label: string; value: string }>;
			prefix: string;
		} | null>();
		editor.setAutocompleteProvider({
			getSuggestions() {
				return pendingSuggestions.promise;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
		editor.setNextPromptSuggestion(suggestion);
		editor.render(80);
		editor.handleInput("/");
		editor.setText("");

		expect(editor.acceptNextPromptSuggestion()).toBe(true);
		pendingSuggestions.resolve({
			items: [{ label: "/help", value: "help" }],
			prefix: "/",
		});
		await Bun.sleep(0);

		expect(editor.getText()).toBe(suggestion);
		expect(editor.isShowingAutocomplete()).toBe(false);
	});
});
