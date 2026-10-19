import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, Input, setKeybindings, TUI } from "@oh-my-pi/pi-tui";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const INPUT_CAPACITY = WIDTH - 6;
const HARDWARE_CURSOR_SHOW = "\x1b[?25h";
const HARDWARE_CURSOR_HIDE = "\x1b[?25l";
let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	cursorVisible = true;

	override write(data: string): void {
		this.writes.push(data);
		for (const match of data.matchAll(/\x1b\[\?25([hl])/g)) this.cursorVisible = match[1] === "h";
		super.write(data);
	}

	override hideCursor(): void {
		this.write(HARDWARE_CURSOR_HIDE);
	}

	override showCursor(): void {
		this.write(HARDWARE_CURSOR_SHOW);
	}

	takeWrites(): string {
		const output = this.writes.join("");
		this.writes.length = 0;
		return output;
	}
}

function renderedInputRows(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().flatMap(row => stripVTControlCharacters(row).match(/[Q界]+/g) ?? []);
}

function expectNoSoftwareCaret(terminal: VirtualTerminal): void {
	const rows = terminal.getViewport().filter(row => /[Q界]/.test(row));
	for (const row of rows) expect(row.slice(row.indexOf("Q"))).toMatch(/^[Q界]+[\s│]*$/);
}

function sendText(terminal: VirtualTerminal, text: string): void {
	for (const glyph of text) terminal.sendInput(glyph);
}

withoutTerminalMultiplexer();

describe("AnnotationOverlay fullscreen hardware cursor", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "escape",
				"app.editor.external": "ctrl+e",
			}),
		);
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("preserves full-cell input, moves only the terminal cursor, and restores focus on cancel", async () => {
		const terminal = new RecordingTerminal(WIDTH, 20);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		const input = new Input();
		input.setValue("restored input");
		tui.addChild(input);
		tui.setFocus(input);
		const source: TextReviewSource = {
			id: "fullscreen-boundary",
			kind: "message",
			label: "source",
			text: "source text",
		};
		const overlay = new AnnotationOverlay(tui, darkTheme!, getKeybindings() as KeybindingsManager, source, {
			onComplete() {
				tui.hideOverlay();
			},
		});

		tui.start();
		try {
			await scheduler.settle(terminal);
			tui.showOverlay(overlay, { fullscreen: true, width: "100%", maxHeight: "100%" });
			await scheduler.settle(terminal);
			expect(tui.getShowHardwareCursor()).toBe(true);
			expect(tui.getFocused()).toBe(overlay);
			expect(overlay.focused).toBe(true);
			expect(input.focused).toBe(false);
			expect(terminal.cursorVisible).toBe(false);
			terminal.takeWrites();

			terminal.sendInput("A");
			sendText(terminal, "Q".repeat(INPUT_CAPACITY));
			await scheduler.settle(terminal);

			const ascii = "Q".repeat(INPUT_CAPACITY);
			expect(renderedInputRows(terminal)).toEqual([ascii]);
			expectNoSoftwareCaret(terminal);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_SHOW);
			expect(terminal.cursorVisible).toBe(true);
			const asciiRow = terminal.getViewport().findIndex(row => row.includes(ascii));
			expect(terminal.getCursor()).toEqual({ row: asciiRow, col: WIDTH - 2 });

			terminal.sendInput("Q");
			await scheduler.settle(terminal);
			expect(renderedInputRows(terminal)).toEqual([ascii, "Q"]);
			expectNoSoftwareCaret(terminal);

			terminal.sendInput("Q");
			await scheduler.settle(terminal);
			expect(renderedInputRows(terminal)).toEqual([ascii, "QQ"]);
			expectNoSoftwareCaret(terminal);

			const beforeMove = terminal.getViewport();
			const previousCursor = terminal.getCursor();
			terminal.takeWrites();
			terminal.sendInput("\x1b[D");
			await scheduler.settle(terminal);
			expect(terminal.getViewport()).toEqual(beforeMove);
			expect(terminal.getCursor()).toEqual({ row: previousCursor.row, col: previousCursor.col - 1 });
			expect(stripVTControlCharacters(terminal.takeWrites())).toBe("");
			expect(terminal.cursorVisible).toBe(true);

			terminal.takeWrites();
			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_HIDE);
			expect(terminal.cursorVisible).toBe(false);
			expect(tui.getFocused()).toBe(overlay);
			expect(renderedInputRows(terminal)).toEqual([]);

			terminal.sendInput("A");
			sendText(terminal, `${"Q".repeat(INPUT_CAPACITY - 2)}界`);
			await scheduler.settle(terminal);
			expect(renderedInputRows(terminal)).toEqual([`${"Q".repeat(INPUT_CAPACITY - 2)}界`]);
			expectNoSoftwareCaret(terminal);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_SHOW);
			expect(terminal.cursorVisible).toBe(true);
			const wideRow = terminal.getViewport().findIndex(row => row.includes("界"));
			expect(terminal.getCursor()).toEqual({ row: wideRow, col: WIDTH - 2 });

			terminal.takeWrites();
			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_HIDE);
			expect(terminal.cursorVisible).toBe(false);

			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			expect(tui.hasOverlay()).toBe(false);
			expect(tui.getFocused()).toBe(input);
			expect(input.focused).toBe(true);
			expect(overlay.focused).toBe(false);
			expect(terminal.getViewport().join("\n")).toContain("restored input");
			expect(terminal.cursorVisible).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("switches a mounted editor to software fallback without showing two cursors", async () => {
		const terminal = new RecordingTerminal(WIDTH, 20);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		const source: TextReviewSource = {
			id: "fullscreen-cursor-preference",
			kind: "message",
			label: "source",
			text: "source text",
		};
		const overlay = new AnnotationOverlay(tui, darkTheme!, getKeybindings() as KeybindingsManager, source, {
			onComplete() {},
		});

		tui.start();
		try {
			await scheduler.settle(terminal);
			tui.showOverlay(overlay, { fullscreen: true, width: "100%", maxHeight: "100%" });
			terminal.sendInput("A");
			terminal.sendInput("Q");
			await scheduler.settle(terminal);
			expectNoSoftwareCaret(terminal);
			expect(terminal.cursorVisible).toBe(true);

			terminal.takeWrites();
			tui.setShowHardwareCursor(false);
			await scheduler.settle(terminal);
			const softwareRow = terminal.getViewport().find(row => row.includes("Q"))!;
			expect(softwareRow).toContain(`Q${stripVTControlCharacters(darkTheme!.nav.cursor)}`);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_HIDE);
			expect(terminal.cursorVisible).toBe(false);

			tui.setShowHardwareCursor(true);
			await scheduler.settle(terminal);
			expectNoSoftwareCaret(terminal);
			expect(terminal.takeWrites()).toContain(HARDWARE_CURSOR_SHOW);
			expect(terminal.cursorVisible).toBe(true);

			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			expect(renderedInputRows(terminal)).toEqual([]);
			expect(terminal.cursorVisible).toBe(false);
		} finally {
			tui.stop();
		}
	});
});
