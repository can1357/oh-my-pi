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
	it("edit the focused component live while they are plain typing, and queue a shortcut with everything after it", async () => {
		const log = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
		const h = harness;

		for (const key of ["a", "\x7f", "b", "\x1bp", "c", "\x7f"]) h.terminal.send(key);
		h.flush();
		expect(log.keys).toEqual(["a", "\x7f", "b"]);

		h.tui.releaseHeldInput();
		expect(log.keys).toEqual(["a", "\x7f", "b", "\x1bp", "c", "\x7f"]);
	});

	it("behind a shortcut are held until the app releases them, then replayed once, in order, and delivered live", async () => {
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

	it.each(["before", "after"] as const)(
		"rechecks host quit arbitration across a replayed focus change when installed %s queuing",
		async timing => {
			const editor = new KeyLog();
			const dialogKeys: string[] = [];
			const dialog: Component = {
				render: () => ["Quit prompt"],
				capturesInput: () => true,
				handleInput: data => dialogKeys.push(data),
			};
			harness = await TspHarness.start(tui => tui.setFocus(editor), TERN_PREPAINT);
			const h = harness;
			let pending = false;
			let opened = 0;
			let bypassed = 0;
			editor.handleInput = data => {
				if (data === "\x1bq") {
					pending = true;
					opened++;
					h.tui.setFocus(dialog);
				} else {
					editor.keys.push(data);
				}
			};
			const remap: Record<string, string> = { "\x1bp": "\x1bn", "\x1bn": "\x1bp" };
			h.tui.addInputListener(data => {
				const transformed = remap[data];
				return transformed === undefined ? undefined : { data: transformed };
			});
			const arbitrateQuit = (data: string) => {
				if (!pending || data !== "\x1bq") return false;
				pending = false;
				bypassed++;
				h.tui.setFocus(editor);
				return true;
			};
			if (timing === "before") h.tui.onBeforeInputCapture = arbitrateQuit;
			for (const key of ["\x1bp", "\x1bq", "\x1bq", "\x1bn"]) h.terminal.send(key);
			h.flush();
			if (timing === "after") h.tui.onBeforeInputCapture = arbitrateQuit;
			expect(editor.keys).toEqual([]);
			h.tui.releaseHeldInput();
			expect(opened).toBe(1);
			expect(bypassed).toBe(1);
			expect(dialogKeys).toEqual([]);
			expect(editor.keys).toEqual(["\x1bn", "\x1bp"]);
		},
	);

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
			// The reply neither reaches the editor nor starts holding the typing after it.
			expect(log.keys).toEqual(["a", "b"]);

			h.terminal.send("\x1bp");
			h.terminal.send("\x1b[6;24;12t");
			h.flush();
			expect(getCellDimensions()).toEqual({ widthPx: 12, heightPx: 24 });
			h.tui.releaseHeldInput();
			expect(log.keys).toEqual(["a", "b", "\x1bp"]);
		} finally {
			setCellDimensions(before);
		}
	});

	it("apply iTerm2's cell-size reply in device pixels instead of replaying it as typed text", async () => {
		const before = getCellDimensions();
		try {
			const log = new KeyLog();
			harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
			const h = harness;

			h.terminal.send("a");
			// Points plus the backing scale: a Retina cell of 7x17 points is 14x34 pixels.
			h.terminal.send("\x1b]1337;ReportCellSize=17.0;7.0;2.0\x1b\\");
			h.terminal.send("b");
			h.flush();
			expect(getCellDimensions()).toEqual({ widthPx: 14, heightPx: 34 });
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

		h.terminal.send("\x1bp");
		h.flush();
		h.tui.replaceHeldFocus(editor, replacement);
		h.tui.setFocus(replacement);
		h.terminal.send("b");
		h.flush();
		expect(replacement.keys).toEqual([]);

		h.tui.releaseHeldInput();
		expect(replacement.keys).toEqual(["\x1bp", "b"]);
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
