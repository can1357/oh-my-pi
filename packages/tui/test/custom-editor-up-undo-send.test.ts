/**
 * Contract: Up-arrow on an EMPTY editor is offered to the host as an "undo send"
 * gesture (`onUpWhenEmpty`). The host returns true to consume it (e.g. it pulled
 * queued messages back into the editor) or false to fall through to normal
 * input-history navigation. Up on a non-empty editor is never diverted, so
 * multi-line cursor movement and history recall keep working untouched.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";

const UP = "\x1b[A";

beforeAll(async () => {
	await initTheme();
});

describe("CustomEditor Up-on-empty undo-send", () => {
	it("invokes onUpWhenEmpty and consumes Up when it returns true (history not recalled)", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.addToHistory("remembered draft");
		let called = 0;
		editor.onUpWhenEmpty = () => {
			called++;
			return true;
		};
		editor.handleInput(UP);
		expect(called).toBe(1);
		// Consumed → the key never reached base input-history navigation.
		expect(editor.getText()).toBe("");
	});

	it("falls through to input-history navigation when onUpWhenEmpty returns false", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.addToHistory("remembered draft");
		let called = 0;
		editor.onUpWhenEmpty = () => {
			called++;
			return false;
		};
		editor.handleInput(UP);
		expect(called).toBe(1);
		// Not consumed → base editor recalled the previous history entry.
		expect(editor.getText()).toBe("remembered draft");
	});

	it("does not invoke onUpWhenEmpty when the editor holds a draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("a draft in progress");
		let called = 0;
		editor.onUpWhenEmpty = () => {
			called++;
			return true;
		};
		editor.handleInput(UP);
		expect(called).toBe(0);
		expect(editor.getText()).toBe("a draft in progress");
	});
});
