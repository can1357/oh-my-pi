import { describe, expect, it } from "bun:test";
import { Editor } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

describe("Editor atom table", () => {
	it("expands an inserted atom to its registered expansion on submit", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("before ");
		editor.moveToMessageEnd();
		editor.insertAtom("🖼 #1", "[Image #1, 800x600]");
		expect(editor.getText()).toBe("before 🖼 #1 ");
		expect(editor.getExpandedText()).toBe("before [Image #1, 800x600] ");
	});

	it("expands the longest label first so #1 never corrupts #10", () => {
		const editor = new Editor(defaultEditorTheme);
		for (let n = 1; n <= 10; n++) editor.registerAtom(`🖼 #${n}`, `[Image #${n}]`);
		editor.setText("🖼 #10 🖼 #1");
		expect(editor.getExpandedText()).toBe("[Image #10] [Image #1]");
	});

	it("never rescans expanded content for other tokens", () => {
		const editor = new Editor(defaultEditorTheme);
		// The paste body contains another atom's label verbatim; single-pass
		// expansion must leave it untouched inside the expanded content.
		editor.registerAtom("🗒 #1", "body mentioning 🖼 #1 literally");
		editor.registerAtom("🖼 #1", "[Image #1]");
		editor.setText("🗒 #1 and 🖼 #1");
		expect(editor.getExpandedText()).toBe("body mentioning 🖼 #1 literally and [Image #1]");
	});

	it("clears atoms on submit so the next draft starts fresh", () => {
		const editor = new Editor(defaultEditorTheme);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};
		editor.insertAtom("🖼 #1", "[Image #1]");
		editor.handleInput("\r");
		expect(submitted).toBe("[Image #1]");
		editor.setText("🖼 #1");
		expect(editor.getExpandedText()).toBe("🖼 #1");
	});

	it("collapses a typed span into an atom and keeps a trailing cursor anchored to the text after it", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("use /skill:foo now");
		editor.moveToMessageEnd();
		editor.collapseToAtom(0, 4, 14, "✦ foo", "/skill:foo");
		expect(editor.getText()).toBe("use ✦ foo now");
		expect(editor.getCursor()).toEqual({ line: 0, col: "use ✦ foo now".length });
		expect(editor.getExpandedText()).toBe("use /skill:foo now");
	});

	it("moves a cursor that sat inside the collapsed span to just after the atom", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setText("/skill:foo tail");
		editor.moveToMessageStart();
		for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");
		editor.collapseToAtom(0, 0, 10, "✦ foo", "/skill:foo");
		expect(editor.getCursor()).toEqual({ line: 0, col: "✦ foo".length });
		// A cursor before the span is untouched.
		editor.setText("a /skill:foo");
		editor.moveToMessageStart();
		editor.collapseToAtom(0, 2, 12, "✦ foo", "/skill:foo");
		expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("deletes an icon atom as one unit under atomicTokenPattern", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.atomicTokenPattern = /🖼 #[1-9]\d*/gu;
		editor.insertAtom("🖼 #1", "[Image #1]");
		// Cursor sits after the trailing space; two backspaces (space, then token)
		// must leave nothing behind rather than a half-eaten label.
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("");
	});

	it("advances the text revision for programmatic edits, deletion, undo, and history restore", () => {
		const editor = new Editor(defaultEditorTheme);
		const initial = editor.textRevision;
		editor.setText("one");
		expect(editor.textRevision).toBeGreaterThan(initial);
		const afterSet = editor.textRevision;
		editor.insertText(" two");
		expect(editor.textRevision).toBeGreaterThan(afterSet);
		const afterInsert = editor.textRevision;
		editor.pasteText(" pasted");
		expect(editor.textRevision).toBeGreaterThan(afterInsert);
		const afterPaste = editor.textRevision;
		editor.handleInput("\x7f");
		expect(editor.textRevision).toBeGreaterThan(afterPaste);
		const afterDelete = editor.textRevision;
		editor.handleInput("\x1f");
		expect(editor.textRevision).toBeGreaterThan(afterDelete);
		editor.addToHistory("history");
		editor.setText("");
		const beforeHistoryRestore = editor.textRevision;
		editor.handleInput("\x1b[A");
		expect(editor.textRevision).toBeGreaterThan(beforeHistoryRestore);
		expect(editor.getText()).toBe("history");
	});
});
