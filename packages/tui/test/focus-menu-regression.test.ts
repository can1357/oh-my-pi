import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class FocusToken implements Component, Focusable {
	focused = false;

	invalidate(): void {}

	render(): string[] {
		return [];
	}
}

class MenuFrame implements Component {
	working = false;
	menuOpen = false;
	#editor: FocusToken;
	#menu: FocusToken;

	constructor(editor: FocusToken, menu: FocusToken) {
		this.#editor = editor;
		this.#menu = menu;
	}

	invalidate(): void {}

	render(): string[] {
		const lines = ["assistant"];
		if (this.working) lines.push(": Working... <esc>");
		if (this.menuOpen) {
			for (let i = 0; i < 12; i++) {
				lines.push(`menu-${i}${this.#menu.focused && i === 11 ? CURSOR_MARKER : ""}`);
			}
		}
		lines.push(`prompt${this.#editor.focused ? CURSOR_MARKER : ""}`);
		return lines;
	}
}

describe("focus-changing menu teardown", () => {
	it("repaints stale menu and working rows on ED3-risk terminals without a viewport oracle", async () => {
		const term = new VirtualTerminal(30, 6, 1000);
		const tui = new TUI(term, true);
		const editor = new FocusToken();
		const menu = new FocusToken();
		const frame = new MenuFrame(editor, menu);
		tui.addChild(frame);
		tui.setFocus(editor);

		try {
			tui.start();
			await term.waitForRender();

			frame.working = true;
			tui.requestRender();
			await term.waitForRender();

			frame.menuOpen = true;
			tui.setFocus(menu);
			tui.requestRender();
			await term.waitForRender();

			frame.working = false;
			tui.requestRender();
			await term.waitForRender();

			frame.menuOpen = false;
			tui.setFocus(editor);
			tui.requestRender();
			await term.waitForRender();

			// The menu rows were committed to history while the menu was tall;
			// closing it resyncs the commit index at the divergence (stale menu
			// stays in scrollback). The focused cursor tail is shorter than the
			// viewport, so the window re-anchors at the frame tail instead of
			// pinning "prompt" at the top with blank rows underneath —
			// "assistant" is re-shown on the grid (its committed copy stays in
			// scrollback; duplication, never loss).
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(["assistant", "prompt", "", "", "", ""]);
			expect(term.getCursor()).toEqual({ row: 1, col: 6 });
		} finally {
			tui.stop();
		}
	});
});
