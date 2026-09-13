import { expect, it } from "bun:test";
import { CURSOR_MARKER, TUI, type TerminalFramePlan, type TerminalFrameProvider } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	#history: readonly string[] = [];
	#nextHistoryId = 2;
	frame: TerminalFramePlan = {
		history: { id: 1, kind: "append", rows: Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`) },
		viewport: ["live", `${CURSOR_MARKER}input`],
	};
	renderFrame(): TerminalFramePlan {
		return this.frame;
	}
	acknowledgeHistory(): void {
		const batch = this.frame.history;
		if (batch) {
			this.#history = batch.kind === "replay" ? batch.rows : [...this.#history, ...batch.rows];
			this.#nextHistoryId = Math.max(this.#nextHistoryId, batch.id + 1);
		}
		this.frame = { viewport: this.frame.viewport };
	}
	beginHistoryReplay(): void {
		this.frame = {
			history: { id: this.#nextHistoryId++, kind: "replay", rows: this.#history },
			viewport: this.frame.viewport,
		};
	}
	renderResizeFrame(): readonly string[] {
		return this.frame.viewport;
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

it("clips over-width cursor popup rows at the terminal boundary", async () => {
	const terminal = new VirtualTerminal(20, 6);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = { viewport: ["live", `${CURSOR_MARKER}input`] };
	ui.setFrameProvider(provider);
	ui.setCursorOverlay(() => ["X".repeat(25)], 0, 1);
	ui.start();
	try {
		ui.requestRender(true);
		await terminal.waitForRender();
		expect(writes.join("")).not.toContain("X".repeat(25));
		expect(terminal.getViewport()[2]).toBe("X".repeat(20));
		expect(terminal.getViewport()[3]).toBe("");
		expect(terminal.getViewport()[1]).toBe("input");
	} finally {
		ui.stop();
	}
});

it("restores the complete scaled glyph when a popup covers only its lower row", async () => {
	const terminal = new VirtualTerminal(40, 6);
	const ui = new TUI(terminal);
	const provider = new Provider();
	const heading = "\x1b]66;s=2;Heading\x1b\\";
	provider.frame = { viewport: ["", "", heading, "", `${CURSOR_MARKER}input`, ""] };
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		expect(writes.join("")).toContain(heading);
		expect(writes.join("")).not.toContain("\x1b[4;1H\x1b[0m\x1b[K");
	} finally {
		ui.stop();
	}
});

it("replays authoritative history after a popup is resized into native scrollback", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const provider = new Provider();
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		terminal.resize(40, 4);
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("input")));
		await Bun.sleep(300);
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		const rows = terminal.getScrollBuffer();
		expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(
			Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`),
		);
		expect(rows.join("\n")).not.toContain("MENU_");
	} finally {
		ui.stop();
	}
});

it("restores popup backing on stop without an optional history flush hook", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const reference = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	ui.setFrameProvider(new Provider());
	referenceUi.setFrameProvider(new Provider());
	ui.start();
	referenceUi.start();
	try {
		await terminal.waitForRender();
		await reference.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("MENU_1");
	} finally {
		ui.stop();
		referenceUi.stop();
	}
	expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
});

it("restores normal history after a fullscreen selector resizes over a passive popup", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	ui.setFrameProvider(new Provider());
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const selector = ui.showOverlay({ render: () => ["SELECTOR"] }, { fullscreen: true, mouseTracking: false });
		await terminal.waitForRender();
		terminal.resize(40, 4);
		await terminal.waitForRender();
		selector.hide();
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		await Bun.sleep(300);
		await terminal.waitForRender();
		const rows = terminal.getScrollBuffer();
		expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(
			Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`),
		);
		expect(rows.join("\n")).not.toContain("MENU_");
	} finally {
		ui.stop();
	}
});
