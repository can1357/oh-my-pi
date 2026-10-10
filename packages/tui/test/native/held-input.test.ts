import { afterEach, describe, expect, it } from "bun:test";
import { getCellDimensions, setCellDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

/** Focused component recording every keystroke the TUI hands it. */
class KeyLog implements Component {
	keys: string[] = [];
	render(): readonly string[] {
		return ["keys"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	invalidate(): void {}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** Started the way omp's prepaint starts inside Tern. */
const TERN_PREPAINT = { expected: true, deferInput: true } as const;

describe("keystrokes during a Tern startup prepaint", () => {
	it("are held until the app releases them, then replayed once, in order, and delivered live", async () => {
		const log = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
		const h = harness;
		const listened: string[] = [];
		h.tui.addInputListener(data => {
			listened.push(data);
			return undefined;
		});

		h.terminal.send("\x1bp");
		h.terminal.send("a");
		h.flush();
		expect(log.keys).toEqual([]);
		expect(listened).toEqual([]);

		h.tui.releaseHeldInput();
		expect(log.keys).toEqual(["\x1bp", "a"]);
		expect(listened).toEqual(["\x1bp", "a"]);

		h.terminal.send("b");
		h.flush();
		expect(log.keys).toEqual(["\x1bp", "a", "b"]);
	});

	it("still apply the cell-size reply on arrival instead of replaying it as typed text", async () => {
		const before = getCellDimensions();
		try {
			const log = new KeyLog();
			harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
			const h = harness;

			h.terminal.send("a");
			h.terminal.send("\x1b[6;23;11t");
			h.terminal.send("b");
			h.flush();
			expect(getCellDimensions()).toEqual({ widthPx: 11, heightPx: 23 });

			h.tui.releaseHeldInput();
			expect(log.keys).toEqual(["a", "b"]);
		} finally {
			setCellDimensions(before);
		}
	});

	it("reach a dialog that takes focus live, and resume holding when focus returns", async () => {
		const editor = new KeyLog();
		const dialog = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(editor), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("\x1bp");
		h.flush();
		h.tui.setFocus(dialog);
		h.terminal.send("\r");
		h.flush();
		expect(dialog.keys).toEqual(["\r"]);

		h.tui.setFocus(editor);
		h.terminal.send("a");
		h.flush();
		expect(editor.keys).toEqual([]);

		h.tui.releaseHeldInput();
		expect(editor.keys).toEqual(["\x1bp", "a"]);
		expect(dialog.keys).toEqual(["\r"]);
	});

	it("stay in typing order when the app swaps in a replacement editor", async () => {
		const editor = new KeyLog();
		const replacement = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(editor), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("a");
		h.flush();
		h.tui.replaceHeldFocus(editor, replacement);
		h.tui.setFocus(replacement);
		h.terminal.send("b");
		h.flush();
		expect(replacement.keys).toEqual([]);

		h.tui.releaseHeldInput();
		expect(replacement.keys).toEqual(["a", "b"]);
	});

	it("survive a dialog stopping and restarting the TUI (an external editor)", async () => {
		const editor = new KeyLog();
		const dialog = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(editor), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("\x1bp");
		h.flush();
		h.tui.setFocus(dialog);
		h.tui.stop();
		h.tui.start();
		h.tui.setFocus(editor);
		h.terminal.send("a");
		h.flush();
		expect(editor.keys).toEqual([]);

		h.tui.releaseHeldInput();
		expect(editor.keys).toEqual(["\x1bp", "a"]);
	});

	it("are released by Ctrl+C so a stalled startup stays interruptible", async () => {
		const log = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("a");
		h.terminal.send("\x03");
		h.flush();
		expect(log.keys).toEqual(["a", "\x03"]);
	});
});
