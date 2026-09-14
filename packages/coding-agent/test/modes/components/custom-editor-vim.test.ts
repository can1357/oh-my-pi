import { beforeAll, describe, expect, it } from "bun:test";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "../../../src/modes/theme/theme";

const ESC = "\x1b";

function makeEditor(vim: boolean): { editor: CustomEditor; state: { escapes: number } } {
	const editor = new CustomEditor(getEditorTheme());
	const state = { escapes: 0 };
	editor.onEscape = () => {
		state.escapes++;
	};
	editor.setVimMode(vim);
	return { editor, state };
}

describe("CustomEditor vim mode", () => {
	beforeAll(() => {
		initTheme();
	});

	it("leaves Escape to the app interrupt when vim mode is off", () => {
		const { editor, state } = makeEditor(false);
		editor.setText("draft");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(1);
	});

	it("spends the first Escape leaving insert mode instead of interrupting", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("draft");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(0);
		expect(editor.vimMode).toBe("normal");
	});

	it("gives Escape back to the app once normal mode is quiet", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("draft");
		editor.handleInput(ESC);
		editor.handleInput(ESC);
		expect(state.escapes).toBe(1);
		expect(editor.getText()).toBe("draft");
	});

	it("spends Escape cancelling a visual selection before interrupting", () => {
		const { editor, state } = makeEditor(true);
		editor.setText("alfa beta");
		editor.handleInput(ESC);
		editor.handleInput("v");
		editor.handleInput("h");
		editor.handleInput(ESC);
		expect(state.escapes).toBe(0);
		expect(editor.vimMode).toBe("normal");
		expect(editor.getText()).toBe("alfa beta");
	});

	it("keeps the space bar as a motion in normal mode instead of push-to-talk", () => {
		const { editor } = makeEditor(true);
		const gestures: string[] = [];
		editor.sttHoldEnabled = () => true;
		editor.onSpaceHoldStart = () => gestures.push("start");
		editor.setText("alfa");
		editor.handleInput(ESC);
		for (let i = 0; i < 6; i++) editor.handleInput(" ");
		expect(gestures).toEqual([]);
		expect(editor.getText()).toBe("alfa");
	});

	it("still offers push-to-talk while composing in insert mode", () => {
		const { editor } = makeEditor(true);
		editor.sttHoldEnabled = () => true;
		editor.onSpaceHoldStart = () => {};
		expect(editor.vimMode).toBe("insert");
		editor.handleInput(" ");
		expect(editor.getText()).toBe(" ");
	});
});
