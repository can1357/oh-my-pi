import { describe, expect, it } from "bun:test";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "../../../src/modes/theme/theme";

/**
 * Regression for issue #4766: plugins written against upstream pi subclass
 * `CustomEditor`/`Editor` and forward `super(tui, theme, keybindings)`. omp's
 * `setEditorComponent` factory contract advertises exactly that arg order, so
 * the base constructor must resolve the real theme by shape (not position) or
 * every render throws `undefined is not an object (evaluating
 * 'this.#theme.symbols.boxRound')`.
 */
describe("CustomEditor upstream-pi constructor compatibility (#4766)", () => {
	it("renders when constructed as (tui, theme, keybindings)", async () => {
		await initTheme();
		const tui = new TUI(new ProcessTerminal());
		const editor = new CustomEditor(tui, getEditorTheme(), {});
		editor.setText("run this workflow");
		expect(() => editor.render(80)).not.toThrow();
		// The rounded border glyphs from the resolved theme must reach the frame.
		const frame = editor.render(80).join("\n");
		expect(frame).toContain(getEditorTheme().symbols.boxRound.horizontal);
		// The leading TUI is captured so plugin overrides calling
		// `this.tui.requestRender()` keep working.
		expect(editor.tui).toBe(tui);
	});

	it("still accepts omp's own (theme) constructor", async () => {
		await initTheme();
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("hello");
		expect(() => editor.render(80)).not.toThrow();
		expect(editor.tui).toBeUndefined();
	});
});
