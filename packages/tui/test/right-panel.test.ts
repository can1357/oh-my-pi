import { describe, expect, it } from "bun:test";
import { type Component, type PanelLayoutResult, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { RESERVED_IMAGE_ROW } from "../src/components/image";
import { compositeRightPanel, compositeRightPanels } from "../src/right-panel";
import { VirtualTerminal } from "./virtual-terminal";

// A 20-column panel: ┌──┐ / body / └──┘. Plain ASCII so visibleWidth === length.
function panel(lines: number): string[] {
	const top = `┌${"─".repeat(18)}┐`;
	const bottom = `└${"─".repeat(18)}┘`;
	const body = Array.from({ length: Math.max(0, lines - 2) }, (_, i) => `│ row ${String(i).padEnd(11)}│`);
	return [top, ...body, bottom];
}

const WIDTH = 80; // col = 80 - 20 - 1 = 59
const COL = 59;

describe("compositeRightPanel", () => {
	it("returns base lines untouched when the panel is empty", () => {
		const base = ["a", "b", "c"];
		expect(compositeRightPanel(base, [], WIDTH, 40)).toBe(base);
	});

	it("hides (returns base unchanged) when the terminal is too narrow", () => {
		const base = Array.from({ length: 12 }, () => "");
		// width 40 → col = 40 - 20 - 1 = 19 < 30
		expect(compositeRightPanel(base, panel(8), 40, 40)).toEqual(base);
	});

	it("hides when every visible row already reaches the panel column", () => {
		const base = Array.from({ length: 12 }, () => "x".repeat(COL + 1)); // wider than col
		const out = compositeRightPanel(base, panel(8), WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("hides when the only free run is shorter than 6 rows", () => {
		// 4 short rows then a long row breaks the run; nothing else fits.
		const base = ["", "", "", "", "x".repeat(COL + 1)];
		const out = compositeRightPanel(base, panel(8), WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("hides when the visible viewport is below the minimum panel height", () => {
		const base = Array.from({ length: 20 }, () => "");
		const out = compositeRightPanel(base, panel(8), WIDTH, 5);
		expect(out).toEqual(base);
	});

	it("places the panel on a free run without overwriting visible text", () => {
		const base = Array.from({ length: 12 }, () => "hi"); // all width 2 <= col
		const widget = panel(8);
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		expect(out).toHaveLength(base.length);
		for (let k = 0; k < widget.length; k++) {
			// base content preserved on the left, panel appended on the right
			expect(out[k].startsWith("hi")).toBe(true);
			expect(out[k].endsWith(widget[k])).toBe(true);
		}
		// rows past the panel are untouched
		expect(out[widget.length]).toBe("hi");
	});

	it("terminates an in-flight OSC 8 hyperlink before panel text", () => {
		const openLink = "\x1b]8;;https://example.com\x07link";
		const plain = "plain";
		const base = [...Array.from({ length: 4 }, () => openLink), ...Array.from({ length: 4 }, () => plain)];
		const widget = panel(6);
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		for (let k = 0; k < widget.length; k++) {
			expect(out[k].endsWith(widget[k])).toBe(true);
			if (k < 4) {
				// Hyperlink rows close OSC 8 before the gap and panel text.
				const closeAt = out[k].indexOf("\x1b]8;;\x07");
				const panelAt = out[k].indexOf(widget[k]);
				expect(closeAt).toBeGreaterThan(out[k].indexOf("\x1b]8;;https://example.com\x07"));
				expect(closeAt).toBeLessThan(panelAt);
			} else {
				// Plain rows receive the panel but no OSC 8 terminator.
				expect(out[k]).not.toContain("\x1b]8;");
			}
		}
		// Non-hyperlink rows past the panel are untouched.
		expect(out[widget.length]).toBe(plain);
		expect(out[widget.length + 1]).toBe(plain);
	});

	it("normalizes tabs in panel lines before measuring and appending", () => {
		const base = Array.from({ length: 8 }, () => "hi");
		const widget = ["A\tB", "C\tD"];
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		expect(out[0]).toContain("A   B");
		expect(out[1]).toContain("C   D");
		expect(out[0]).not.toContain("\t");
		expect(out[1]).not.toContain("\t");
	});

	it("hides instead of cutting a widget when the free run is shorter than the panel", () => {
		// A run of exactly 8 short rows, then a long row; widget wants 12 rows.
		const base = [...Array.from({ length: 8 }, () => ""), "x".repeat(COL + 1), "", ""];
		const widget = panel(12);
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		expect(out).toEqual(base);
	});

	it("searches only the visible viewport, not scrolled-off history", () => {
		// 100 short rows but a tiny viewport: the panel must land near the bottom.
		const base = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const widget = panel(8);
		const out = compositeRightPanel(base, widget, WIDTH, 10);
		// Top rows stay clean; the panel is placed within the last ~10 rows.
		expect(out[0]).toBe("line 0");
		const placed = out.findIndex(line => line.endsWith(widget[0]));
		expect(placed).toBeGreaterThanOrEqual(base.length - 10);
	});

	it("never composites over a terminal image block", () => {
		const widget = panel(8);
		const isImage = (l: string) => l === "IMG";
		// 5 blank placeholder rows + the raw image escape line, then free rows.
		const base = ["", "", "", "", "", "IMG", ...Array.from({ length: 12 }, () => "hi")];

		// Without image awareness the run swallows the image block (the bug).
		const naive = compositeRightPanel(base, widget, WIDTH, 40);
		expect(naive.some((line, i) => i <= 5 && line.endsWith(widget[0]))).toBe(true);

		// With image awareness the panel lands strictly below the image block.
		const safe = compositeRightPanel(base, widget, WIDTH, 40, isImage, isImage);
		expect(safe[5]).toBe("IMG"); // image escape line untouched
		for (let i = 0; i <= 5; i++) expect(safe[i].endsWith(widget[0])).toBe(false);
		expect(safe.findIndex(line => line.endsWith(widget[0]))).toBeGreaterThan(5);
	});

	it("does not occupy a Kitty OSC 66 text-sizing heading row or its reserved blank row", () => {
		// A scale-2 H1 is visually occupied itself and reserves the following
		// blank row for the scaled glyph's lower cells.
		const heading = "\x1b]66;s=2;Hello\x1b\\";
		const base = [heading, "", ...Array.from({ length: 10 }, () => "")];
		const widget = panel(8);
		const isOccupiedLine = (line: string, index: number) =>
			line.includes("\x1b]66;") || (index > 0 && line === "" && base[index - 1]?.includes("\x1b]66;"));

		const out = compositeRightPanel(base, widget, WIDTH, 40, isOccupiedLine);

		expect(out[0]).toBe(heading); // heading row untouched
		expect(out[1]).toBe(""); // structural reservation row untouched
		expect(out.findIndex(line => line.endsWith(widget[0]))).toBe(2); // lands below both
	});

	it("keeps zero-width spacer rows before OSC 66 headings eligible for panels", () => {
		const heading = "\x1b]66;s=2;Hello\x1b\\";
		const base = [...Array.from({ length: 6 }, () => ""), heading, "", "x".repeat(COL + 1)];
		const widget = panel(6);
		const isOccupiedLine = (line: string, index: number) =>
			line.includes("\x1b]66;") || (index > 0 && line === "" && base[index - 1]?.includes("\x1b]66;"));

		const out = compositeRightPanel(base, widget, WIDTH, 40, isOccupiedLine);

		expect(out.findIndex(line => line.endsWith(widget[0]))).toBe(0);
		expect(out[6]).toBe(heading);
		expect(out[7]).toBe("");
	});

	it("backfills only renderer-reserved rows above an image, not plain blank spacers", () => {
		// PR #1632 Codex P2 (r3440329546): the backward walk above a raw image escape must
		// stop at ordinary blank Markdown spacers ("") and only mark the renderer's own
		// reserved rows (RESERVED_IMAGE_ROW, a non-plain zero-width sentinel the image
		// component emits for the cells it reserves). Walking every zero-width row would
		// wrongly occupy an unrelated blank spacer above the image and hide a panel.
		const widget = panel(3);
		const isOccupied = (l: string) => l === "IMGESC";
		const isEscape = (l: string) => l === "IMGESC";

		// Plain "" spacers above the escape are NOT the renderer's reserved rows, so they
		// stay free → the panel can land at row 0.
		const plainSpacers = ["", "", "", "IMGESC", ...Array.from({ length: 10 }, () => "")];
		const out = compositeRightPanel(plainSpacers, widget, WIDTH, 40, isOccupied, isEscape);
		expect(out.findIndex(line => line.endsWith(widget[0]))).toBe(0);
		expect(out[3]).toBe("IMGESC"); // escape row itself untouched

		// Contrast: RESERVED_IMAGE_ROW rows above the escape ARE the cells the image
		// reserves, so they backfill as occupied and the panel must land below them.
		const reserved = [RESERVED_IMAGE_ROW, RESERVED_IMAGE_ROW, "IMGESC", ...Array.from({ length: 10 }, () => "")];
		const outReserved = compositeRightPanel(reserved, widget, WIDTH, 40, isOccupied, isEscape);
		for (let i = 0; i <= 2; i++) expect(outReserved[i].endsWith(widget[0])).toBe(false);
		expect(outReserved.findIndex(line => line.endsWith(widget[0]))).toBeGreaterThan(2);
	});
});

describe("compositeRightPanels", () => {
	it("composites multiple blocks independently onto distinct rows", () => {
		const base = Array.from({ length: 12 }, () => "hi"); // all width 2 <= col
		// Distinct content per block (panel() borders are identical and unusable here).
		const a = ["A0", "A1", "A2", "A3"];
		const b = ["B0", "B1", "B2"];
		const out = compositeRightPanels(base, [a, b], WIDTH, 40);

		expect(out).toHaveLength(base.length);
		const aAt = out.findIndex(line => line.endsWith("A0"));
		const bAt = out.findIndex(line => line.endsWith("B0"));
		expect(aAt).toBeGreaterThanOrEqual(0);
		expect(bAt).toBeGreaterThanOrEqual(0);
		// Distinct, non-overlapping placements (a occupies aAt..aAt+3).
		expect(bAt).toBeGreaterThanOrEqual(aAt + a.length);
	});

	it("anchors bottom-aligned blocks at the lower edge", () => {
		const base = Array.from({ length: 12 }, () => "hi");
		const top = ["T0", "T1"];
		const bottom = ["B0", "B1"];
		const out = compositeRightPanels(
			base,
			[
				{ lines: top, alignment: "top" },
				{ lines: bottom, alignment: "bottom" },
			],
			WIDTH,
			40,
		);

		expect(out[0].endsWith("T0")).toBe(true);
		expect(out[1].endsWith("T1")).toBe(true);
		expect(out[10].endsWith("B0")).toBe(true);
		expect(out[11].endsWith("B1")).toBe(true);
	});

	it("preserves scaled OSC 66 reservation rows inside panel blocks", () => {
		const heading = "\x1b]66;s=3;Title\x1b\\";
		const out = compositeRightPanels(
			Array.from({ length: 8 }, () => ""),
			[[heading, "", "", "tail"]],
			WIDTH,
			40,
		);

		expect(out[0]).toContain(heading);
		expect(out[1]).toContain(RESERVED_IMAGE_ROW);
		expect(out[2]).toContain(RESERVED_IMAGE_ROW);
	});

	it("drops only the block that does not fit and keeps the rest", () => {
		// 5 free rows then a wall: a 4-row block fits, a 12-row block cannot.
		const base = ["", "", "", "", "", "x".repeat(COL + 1)];
		const small = ["S0", "S1", "S2", "S3"];
		const big = Array.from({ length: 12 }, (_, i) => `B${i}`);
		const out = compositeRightPanels(base, [small, big], WIDTH, 40);

		expect(out.some(line => line.endsWith("S0"))).toBe(true);
		expect(out.some(line => line.endsWith("B0"))).toBe(false);
	});

	it("returns base unchanged when no block fits", () => {
		const base = Array.from({ length: 4 }, () => ""); // only 4 free rows
		const out = compositeRightPanels(base, [panel(8)], WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("places earlier blocks first, claiming space before later ones", () => {
		// Two separate 4-row gaps split by a wall.
		const base = ["", "", "", "", "x".repeat(COL + 1), "", "", "", ""];
		const first = panel(4);
		const second = panel(4);
		const out = compositeRightPanels(base, [first, second], WIDTH, 40);

		expect(out[0].endsWith(first[0])).toBe(true);
		expect(out[5].endsWith(second[0])).toBe(true);
	});

	it("returns base unchanged when there are no blocks", () => {
		const base = ["a", "b", "c"];
		expect(compositeRightPanels(base, [], WIDTH, 40)).toBe(base);
	});
});

// Engine integration: the panel is composited into the visible window only,
// restricted to rows owned by the target roots — the transcript stays a
// directly reusable root child and committed scrollback rows never carry
// panel text.
class Lines implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

// Synchronous, throttle-free scheduler: every request renders immediately,
// so streaming scenarios stay deterministic without real-time sleeps.
function immediateScheduler() {
	let now = 0;
	return {
		now: () => (now += 40),
		scheduleImmediate: (callback: () => void) => callback(),
		scheduleRender: (callback: () => void, _delayMs: number) => {
			callback();
			return { cancel: () => {} };
		},
	};
}
describe("TUI.setRightPanel", () => {
	it("evaluates component-backed panels inside the image-budget render pass", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		tui.setRightPanel(() => {
			tui.imageBudget.observe(1);
			return [["widget"]];
		});

		tui.start();
		await settle(term);
		tui.stop();
	});

	it("composites into chat rows of the visible window, never into chrome rows", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const chat = new Lines(Array.from({ length: 6 }, (_, i) => `msg-${i}`));
		const chrome = new Lines(["[status]", "[editor]"]);
		tui.addChild(chat);
		tui.addChild(chrome);
		tui.setRightPanel(() => [["<W0>", "<W1>", "<W2>"]], [chat]);
		tui.start();
		await settle(term);
		try {
			const viewport = term.getViewport();
			// Chat content is visible.
			expect(viewport.some(line => line.includes("msg-0"))).toBeTrue();
			// The widget landed on chat rows (0..5), right-aligned.
			const widgetRows = viewport.flatMap((line, i) => (line.includes("<W") ? [i] : []));
			expect(widgetRows.length).toBe(3);
			for (const row of widgetRows) expect(row).toBeLessThan(6);
			// Chrome rows stay clean.
			expect(viewport[6]).not.toContain("<W");
			expect(viewport[7]).not.toContain("<W");
		} finally {
			tui.stop();
		}
	});

	it("does not use rows between disjoint target roots for right-panel placement", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const chat = new Lines(["chat"]);
		const pending = new Lines(["", "", "", ""]);
		const todo = new Lines(["todo"]);
		tui.addChild(chat);
		tui.addChild(pending);
		tui.addChild(todo);

		const layouts: PanelLayoutResult[] = [];
		tui.setRightPanel(
			() => [["<W0>", "<W1>", "<W2>"]],
			[chat, todo],
			result => layouts.push(result),
		);
		tui.start();
		await settle(term);
		try {
			const viewport = term.getViewport();
			expect(viewport.some(line => line.includes("<W"))).toBeFalse();
			expect(layouts.at(-1)?.placedBlockIndices).toEqual([]);
			expect(layouts.at(-1)?.hiddenBlockIndices).toEqual([0]);
		} finally {
			tui.stop();
		}
	});

	it("does not paint when the panel is registered before start()", async () => {
		const term = new VirtualTerminal(80, 12, 1000);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const chat = new Lines(Array.from({ length: 6 }, (_, i) => `msg-${i}`));
		tui.addChild(chat);
		// Registering during setup must NOT commit a frame: a pre-start paint
		// would write the widget into raw scrollback before the screen is cleared.
		tui.setRightPanel(() => [["<W0>", "<W1>", "<W2>"]], [chat]);
		await settle(term);
		expect(term.getScrollBuffer().join("\n")).not.toContain("<W");
		expect(term.getViewport().join("\n")).not.toContain("<W");
		// After start(), the stored provider is picked up by the initial paint.
		tui.start();
		await settle(term);
		try {
			expect(term.getViewport().some(line => line.includes("<W"))).toBeTrue();
		} finally {
			tui.stop();
		}
	});

	it("keeps right panel out of OSC 66 heading reservation rows", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const heading = "\x1b]66;s=2;Hello\x1b\\";
		const chat = new Lines([heading, "", ...Array.from({ length: 10 }, () => "")]);
		tui.addChild(chat);
		tui.setRightPanel(() => [panel(8)], [chat]);
		tui.start();
		await settle(term);
		try {
			const widgetRows = term.getViewport().flatMap((line, i) => (line.includes("┌") ? [i] : []));
			expect(widgetRows[0]).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("keeps right panel off a scale-2 OSC 66 reservation row whose heading scrolled just above the window", async () => {
		const term = new VirtualTerminal(80, 12, 1000);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const heading = "\x1b]66;s=2;Hello\x1b\\";
		// 13 chat rows → windowTop = 13 - 12 = 1: the heading (frame row 0) scrolls one
		// row above the visible window, so its reservation row (frame row 1) becomes
		// window[0]. The forward-only occupancy scan can't see the off-screen heading;
		// the boundary check must still mark window[0] occupied so the panel skips it.
		const chat = new Lines([heading, "", ...Array.from({ length: 11 }, () => "")]);
		tui.addChild(chat);
		tui.setRightPanel(() => [panel(8)], [chat]);
		tui.start();
		await settle(term);
		try {
			const widgetRows = term.getViewport().flatMap((line, i) => (line.includes("┌") ? [i] : []));
			expect(widgetRows.length).toBe(1); // panel placed
			expect(widgetRows[0]).toBeGreaterThanOrEqual(1); // never on the reserved row 0
		} finally {
			tui.stop();
		}
	});

	it("keeps right panel off a scale-3 OSC 66 reservation row whose heading scrolled just above the window", async () => {
		const term = new VirtualTerminal(80, 12, 1000);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const heading = "\x1b]66;s=3;Hello\x1b\\";
		// 14 chat rows → windowTop = 14 - 12 = 2: frame rows 1 and 2 are reserved below
		// the heading, so row 0 in the viewport is the second reserved row. A 1-row
		// lookback misses this and would incorrectly allow the panel to occupy row 0.
		const chat = new Lines([heading, "", "", ...Array.from({ length: 11 }, () => "")]);
		tui.addChild(chat);
		tui.setRightPanel(() => [panel(8)], [chat]);
		tui.start();
		await settle(term);
		try {
			const widgetRows = term.getViewport().flatMap((line, i) => (line.includes("┌") ? [i] : []));
			expect(widgetRows.length).toBe(1); // panel placed
			expect(widgetRows[0]).toBeGreaterThanOrEqual(1); // never on the reserved row 0
		} finally {
			tui.stop();
		}
	});

	it("keeps scrolled-off rows free of panel text when content exceeds the viewport", async () => {
		const term = new VirtualTerminal(80, 12, 1000);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const chat = new Lines(Array.from({ length: 11 }, (_, i) => `msg-${i + 19}`));
		const chrome = new Lines(["[editor]"]);
		let historyPending = true;
		const provider: TerminalFrameProvider = {
			renderFrame: () => ({
				history: historyPending ? { id: 1, rows: Array.from({ length: 19 }, (_, i) => `msg-${i}`) } : undefined,
				viewport: [...chat.render(), ...chrome.render()],
				segments: [
					{ component: chat, start: 0, rowCount: 11 },
					{ component: chrome, start: 11, rowCount: 1 },
				],
			}),
			acknowledgeHistory: () => {
				historyPending = false;
			},
		};
		tui.setFrameProvider(provider);
		tui.setRightPanel(() => [["<W0>", "<W1>", "<W2>"]], [chat]);
		tui.start();
		await settle(term);
		try {
			const tape = term.getScrollBuffer();
			// Every transcript row is present exactly once: compositing happens on
			// the window copy, never on the composed frame the engine commits.
			for (let i = 0; i < 30; i++) {
				const exact = new RegExp(`^msg-${i}(\\s|$)`);
				expect(tape.filter(line => exact.test(line)).length, `msg-${i}`).toBe(1);
			}
			// Panel text exists only in the on-screen window, never in the
			// scrolled-off (committed) region.
			const scrolledOff = tape.slice(0, Math.max(0, tape.length - 12));
			expect(scrolledOff.some(line => line.includes("<W"))).toBeFalse();
			// The live viewport shows the chat tail, the widget on chat rows, and
			// an untouched chrome row.
			const viewport = term.getViewport();
			expect(viewport.some(line => line.includes("msg-29"))).toBeTrue();
			expect(viewport.some(line => line.includes("<W0>"))).toBeTrue();
			expect(viewport.find(line => line.startsWith("[editor]"))).not.toContain("<W");
		} finally {
			tui.stop();
		}
	});

	it("reports right-panel blocks hidden while overlay rows cover their placement", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term, false, { renderScheduler: immediateScheduler() });
		const chat = new Lines(Array.from({ length: 6 }, (_, i) => `msg-${i}`));
		tui.addChild(chat);

		const layouts: PanelLayoutResult[] = [];
		tui.setRightPanel(
			() => [["<W0>", "<W1>", "<W2>"]],
			[chat],
			result => layouts.push(result),
		);
		tui.start();
		await settle(term);
		try {
			expect(term.getViewport().some(line => line.includes("<W0>"))).toBeTrue();
			expect(layouts.at(-1)?.placedBlockIndices).toEqual([0]);
			expect(layouts.at(-1)?.hiddenBlockIndices).toEqual([]);

			const overlay = tui.showOverlay(new Lines(["overlay-0", "overlay-1", "overlay-2"]), {
				anchor: "top-left",
				width: 80,
				maxHeight: 3,
				fullscreen: true,
			});
			await settle(term);
			expect(term.getViewport().some(line => line.includes("<W0>"))).toBeFalse();
			expect(layouts.at(-1)?.placedBlockIndices).toEqual([]);
			expect(layouts.at(-1)?.hiddenBlockIndices).toEqual([0]);

			tui.setRightPanel(
				() => [["new-0"], ["new-1"]],
				[chat],
				result => layouts.push(result),
			);
			tui.requestRender(true);
			await settle(term);
			expect(layouts.at(-1)?.placedBlockIndices).toEqual([]);
			expect(layouts.at(-1)?.hiddenBlockIndices).toEqual([0, 1]);

			overlay.hide();
		} finally {
			tui.stop();
		}
	});
});
