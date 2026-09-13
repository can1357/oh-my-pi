import { expect, it } from "bun:test";
import { CURSOR_MARKER, TUI, type TerminalFramePlan, type TerminalFrameProvider } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	frame: TerminalFramePlan = {
		history: { id: 1, kind: "append", rows: Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`) },
		viewport: ["live", `${CURSOR_MARKER}input`],
	};
	renderFrame(): TerminalFramePlan {
		return this.frame;
	}
	acknowledgeHistory(): void {
		this.frame = { viewport: this.frame.viewport };
	}
}

it("restores covered screen cells before new history is appended", async () => {
	const reference = new VirtualTerminal(40, 12);
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	const provider = new Provider();
	const referenceProvider = new Provider();
	ui.setFrameProvider(provider);
	referenceUi.setFrameProvider(referenceProvider);
	ui.start();
	referenceUi.start();
	const paint = async () => {
		ui.requestRender(true);
		referenceUi.requestRender(true);
		await terminal.waitForRender();
		await reference.waitForRender();
	};
	try {
		await paint();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		await paint();
		expect(terminal.getViewport().join("\n")).toContain("MENU_1");
		const next: TerminalFramePlan = {
			history: { id: 2, kind: "append", rows: Array.from({ length: 8 }, (_, i) => `NEW_${i}`) },
			viewport: ["updated", `${CURSOR_MARKER}input`],
		};
		provider.frame = next;
		referenceProvider.frame = next;
		await paint();
		expect(terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n")).not.toContain("MENU_");
		ui.setCursorOverlay(undefined, 0, 0);
		await paint();
		expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
	} finally {
		ui.stop();
		referenceUi.stop();
	}
});
