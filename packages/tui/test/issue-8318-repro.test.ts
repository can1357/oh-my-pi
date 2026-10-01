import { describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// Kitty OSC 66 text-sizing marker and the erase sequences the renderer emits.
// A scale-`s` heading renders `s` cells tall and `visibleWidth` cells wide, so
// the blank rows beneath it hold the multicell glyph's lower half: those
// columns must survive every repaint or the glyph vanishes and leaves
// reserved-but-invisible space (issue #8318). The `s=2` "Heading" glyph is
// 2 * 7 = 14 cells wide; the `s=3` "Big" glyph is 3 * 3 = 9.
const OSC66 = "\x1b]66;";
const ST = "\x1b\\";
const ERASE_LINE = "\x1b[2K";

class RawLines implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	setLines(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.#lines;
	}
}

// Flush the real render scheduler. Its throttle and post-paint settle windows
// are driven by the platform clock, so these integration tests wait real time
// (the suite-wide convention in deccara/image-budget tests) rather than mock a
// scheduler that would not exercise the resize-settle full paint under test.
async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// A non-multiplexer resize paints the viewport immediately and defers the
// authoritative full paint until the drag settles (120 ms window).
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

/**
 * Split the paint write that carries the sized heading into terminal rows and
 * return the heading row plus the `spacerCount` rows written directly beneath
 * it. Rows are `\r\n`-separated in the emitted buffer; the OSC 66 ST (`ESC \\`)
 * never contains a newline, so the split keeps each span intact.
 */
function headingAndSpacers(writes: string[], spacerCount: number): { heading: string; spacers: string[] } {
	const paint = writes.find(write => write.includes(OSC66));
	expect(paint).toBeDefined();
	const rows = paint!.split("\r\n");
	const idx = rows.findIndex(row => row.includes(OSC66));
	expect(idx).toBeGreaterThanOrEqual(0);
	return { heading: rows[idx]!, spacers: rows.slice(idx + 1, idx + 1 + spacerCount) };
}

/**
 * A reserved spacer row must preserve the glyph's own columns `[0, glyphWidth)`
 * while clearing any stale cells to their right (a row can reflow from wider
 * text into the spacer). So: no whole-line erase, no erase-to-end before the
 * glyph, and exactly one cursor-forward to `glyphWidth` followed by erase-to-end.
 */
function expectClearsRightOfGlyph(spacer: string, glyphWidth: number): void {
	expect(spacer).not.toContain(ERASE_LINE);
	expect(spacer).not.toMatch(/^(?:\x1b\[0m)?\x1b\[K/);
	const match = spacer.match(/\x1b\[(\d+)C\x1b\[K/);
	expect(match).not.toBeNull();
	expect(Number(match![1])).toBe(glyphWidth);
}

describe("issue #8318: scaled OSC 66 headings survive repaint and resize", () => {
	it("re-emits the heading and preserves its reserved row on a full repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// Destructive full replay — the same gesture a redraw/session replace
			// uses, routed through the per-row erase path (#lineRewriteSequence).
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
			expect(writes.find(write => write.includes(OSC66))).toContain("Body");
		} finally {
			tui.stop();
		}
	});

	it("preserves the reserved row across a resize repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			term.resize(70, 6);
			await settleResize(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expectClearsRightOfGlyph(spacers[0]!, 14);
		} finally {
			tui.stop();
		}
	});

	it("protects every reserved row of a scale-3 heading (the /debug probe case)", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=3;Big${ST}`, "", "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 2);
			expect(heading).toContain("Big");
			for (const spacer of spacers) expectClearsRightOfGlyph(spacer, 9);
		} finally {
			tui.stop();
		}
	});

	it("protects all six reserved rows at the maximum legal scale", async () => {
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=7;Max${ST}`, "", "", "", "", "", "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { spacers } = headingAndSpacers(writes, 6);
			for (const spacer of spacers) expectClearsRightOfGlyph(spacer, 21);
		} finally {
			tui.stop();
		}
	});
});
