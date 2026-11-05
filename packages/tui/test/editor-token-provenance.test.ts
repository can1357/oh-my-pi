import { describe, expect, it } from "bun:test";
import { Editor, mapExternalEdit } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

/**
 * The invariant these tests defend:
 *
 *   Buffer text equal to a token's text is a token only if this editor recorded putting it
 *   there. Nothing — submit, the chips band, a draft recall, or an external editor's return —
 *   finds a token by comparing buffer text against the atom table or a `[Paste #N]` pattern.
 *
 * Every way a person can get characters into the buffer is tried below against a live token of
 * the same text. The person's characters must come back as characters. Where an external editor
 * leaves a token's fate in doubt, the round trip is refused rather than guessed.
 */

const PNG = "user-🖼 #1.png";

function withImage(): Editor {
	const editor = new Editor(defaultEditorTheme);
	editor.insertAtom("🖼 #1", "[Image #1, 3x3]");
	return editor;
}

describe("Editor token provenance", () => {
	it("leaves a typed lookalike as typed text beside a real token", () => {
		const editor = withImage();
		for (const char of ` beside ${PNG}`) editor.handleInput(char);
		expect(editor.getText()).toBe(`🖼 #1  beside ${PNG}`);
		expect(editor.getExpandedText()).toBe(`[Image #1, 3x3]  beside ${PNG}`);
		expect(editor.getExpandedRuns().filter(run => run.atom !== undefined)).toHaveLength(1);
	});

	it("leaves a short pasted lookalike as pasted text", () => {
		const editor = withImage();
		editor.pasteText(`shot of ${PNG}`);
		expect(editor.getExpandedText()).toBe(`[Image #1, 3x3] shot of ${PNG}`);
	});

	it("leaves a lookalike inside a collapsed paste as content", () => {
		const editor = withImage();
		editor.pasteText(`${PNG}\n${"filler\n".repeat(20)}`);
		const text = editor.getText();
		expect(text).toContain("[Paste #1");
		expect(editor.getExpandedText()).toContain(PNG);
		expect(editor.getExpandedText()).not.toContain("[Image #1, 3x3].png");
	});

	it("leaves a pasted `[Paste #1]` literal when a later paste takes that id", () => {
		// Round-10 F3: two pieces of one delivery, the first naming the marker the second gets.
		const editor = new Editor(defaultEditorTheme);
		editor.pasteText('{"name":"[Paste #1]","body":"');
		editor.pasteText(`${"long\n".repeat(20)}"}`);
		const expanded = editor.getExpandedText();
		expect(expanded).toContain('{"name":"[Paste #1]","body":"');
		expect(expanded.match(/long/g)?.length).toBe(20);
	});

	it("leaves prefilled text literal, however much it reads like a token", () => {
		const editor = withImage();
		editor.setText(`prefilled ${PNG} and 🖼 #1`);
		expect(editor.getExpandedText()).toBe(`prefilled ${PNG} and 🖼 #1`);
	});

	it("keeps a re-edited draft's own tokens and only those", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setRuns([{ atom: "🖼 #1", expansion: "[Image #1, 3x3]" }, ` beside ${PNG}`]);
		expect(editor.getExpandedText()).toBe(`[Image #1, 3x3] beside ${PNG}`);
	});

	it("keeps the tokens of a recalled draft, and nothing else in its text", () => {
		const editor = withImage();
		editor.insertText(`beside ${PNG}`);
		const before = editor.getExpandedText();
		editor.rememberDraft();
		editor.setText("");
		editor.handleInput("\x1b[A");
		expect(editor.getExpandedText()).toBe(before);
		expect(editor.getExpandedRuns().filter(run => run.atom !== undefined)).toHaveLength(1);
	});

	it("drops a token whose characters the person edited", () => {
		const editor = withImage();
		editor.moveToMessageStart();
		// Three steps put the caret between `#` and `1`, inside the token's own characters.
		for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");
		editor.handleInput("9");
		expect(editor.getText()).toBe("🖼 #91 ");
		expect(editor.getExpandedText()).toBe("🖼 #91 ");
	});

	it("restores a token with the undo that restores its text", () => {
		const editor = withImage();
		editor.insertText("tail");
		editor.handleInput("\x7f");
		editor.handleInput("\x1f");
		expect(editor.getExpandedText()).toBe("[Image #1, 3x3] tail");
	});
});

describe("external editor round trip", () => {
	it("keeps a token an unchanged return hands back", () => {
		const editor = withImage();
		editor.insertText(`beside ${PNG}`);
		const payload = editor.externalEditPayload();
		expect(payload.text).toBe(`🖼 #1 beside ${PNG}`);
		const mapping = mapExternalEdit(payload, payload.text);
		expect(mapping).toEqual({
			ok: true,
			runs: [{ atom: "🖼 #1", expansion: "[Image #1, 3x3]" }, ` beside ${PNG}`],
		});
	});

	it("keeps a token when the person edits the text around it", () => {
		const editor = withImage();
		editor.insertText(`beside ${PNG}`);
		const payload = editor.externalEditPayload();
		const mapping = mapExternalEdit(payload, `prefix 🖼 #1 beside ${PNG} suffix`);
		expect(mapping.ok).toBe(true);
		if (!mapping.ok) return;
		editor.applyExternalEdit(mapping.runs);
		expect(editor.getExpandedText()).toBe(`prefix [Image #1, 3x3] beside ${PNG} suffix`);
	});

	it("drops a token the person deleted there, as deleting it here does", () => {
		const editor = withImage();
		editor.insertText(`beside ${PNG}`);
		const payload = editor.externalEditPayload();
		const mapping = mapExternalEdit(payload, `beside ${PNG}`);
		expect(mapping.ok).toBe(true);
		if (!mapping.ok) return;
		editor.applyExternalEdit(mapping.runs);
		expect(editor.getExpandedText()).toBe(`beside ${PNG}`);
		expect(editor.getExpandedRuns().filter(run => run.atom !== undefined)).toHaveLength(0);
	});

	it("refuses a return that writes a token's characters by hand", () => {
		const editor = withImage();
		const payload = editor.externalEditPayload();
		const mapping = mapExternalEdit(payload, "🖼 #1 and a second 🖼 #1 nobody attached");
		expect(mapping.ok).toBe(false);
		if (mapping.ok) return;
		expect(mapping.reason).toContain("🖼 #1");
	});

	it("refuses a return that edited a token's own characters", () => {
		const editor = withImage();
		editor.insertText("tail");
		const payload = editor.externalEditPayload();
		const mapping = mapExternalEdit(payload, "🖼 #2 tail");
		expect(mapping.ok).toBe(false);
	});

	it("refuses a return that moved a token", () => {
		const editor = withImage();
		editor.insertText(`${"line\n".repeat(5)}end`);
		const payload = editor.externalEditPayload();
		const moved = `${"line\n".repeat(5)}end 🖼 #1`;
		expect(mapExternalEdit(payload, moved).ok).toBe(false);
	});

	it("writes a collapsed paste out in full and takes it back as text", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.pasteText(`${"body\n".repeat(20)}tail`);
		const payload = editor.externalEditPayload();
		expect(payload.text).toBe(`${"body\n".repeat(20)}tail`);
		expect(payload.tokens).toHaveLength(0);
		const mapping = mapExternalEdit(payload, `${payload.text} edited`);
		expect(mapping.ok).toBe(true);
		if (!mapping.ok) return;
		editor.applyExternalEdit(mapping.runs);
		expect(editor.getExpandedText()).toBe(`${"body\n".repeat(20)}tail edited`);
	});
});
