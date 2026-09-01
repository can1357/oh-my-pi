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
});
