import { describe, expect, it } from "bun:test";
import { type Component, TUI, type TuiPaint } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// A fullscreen overlay paints on the alternate screen. Every keystroke in one
// (settings search, a picker, a plan-review annotation, an extension's
// fullscreen view) changes a row or two; the paint must rewrite those rows,
// not the whole terminal.

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string {
		const out = this.writes.join("");
		this.writes.length = 0;
		return out;
	}
}

class Rows implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

const OSC66 = "\x1b]66;";
const ST = "\x1b\\";

function screen(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/** 1-based screen rows a paint addressed with an absolute row move. */
function rewrittenRows(frame: string): number[] {
	return [...frame.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]));
}

async function openFullscreen(lines: string[], rows = lines.length) {
	const terminal = new RecordingTerminal(30, rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.start();
	await scheduler.settle(terminal);
	const overlay = new Rows(lines);
	tui.showOverlay(overlay, { fullscreen: true, width: "100%", maxHeight: "100%" });
	await scheduler.settle(terminal);
	terminal.takeWrites();
	return { terminal, scheduler, tui, overlay };
}

describe("fullscreen overlay paints", () => {
	it("rewrites only the rows that changed", async () => {
		const lines = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
		const { terminal, scheduler, tui, overlay } = await openFullscreen(lines);

		overlay.lines = ["alpha", "bravo", "CHARLIE CHANGED", "delta", "echo", "foxtrot"];
		tui.requestRender();
		await scheduler.settle(terminal);
		const grown = terminal.takeWrites();
		expect(rewrittenRows(grown)).toEqual([3]);
		for (const unchanged of ["alpha", "bravo", "delta", "echo", "foxtrot"]) expect(grown).not.toContain(unchanged);
		expect(screen(terminal)).toEqual(overlay.lines);

		// Deleting what was just typed returns the row to text an earlier paint
		// replaced; it must be repainted, not skipped as already on screen.
		overlay.lines = lines;
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(rewrittenRows(terminal.takeWrites())).toEqual([3]);
		expect(screen(terminal)).toEqual(lines);
		tui.stop();
	});

	it("still rewrites every row on a forced repaint", async () => {
		// The redraw gesture repairs output that corrupted the overlay behind the
		// renderer's back, even though the renderer's own frame is unchanged.
		const lines = ["alpha", "bravo", "charlie", "delta"];
		const { terminal, scheduler, tui } = await openFullscreen(lines);
		terminal.write("\x1b[2;1HGARBAGE\x1b[4;1H\x1b[2K");
		expect(screen(terminal)).toEqual(["alpha", "GARBAGE", "charlie", ""]);

		tui.requestRender(true);
		await scheduler.settle(terminal);
		expect(screen(terminal)).toEqual(lines);
		tui.stop();
	});

	it("repaints a frame holding a scaled heading whole when it changes, and not at all when it doesn't", async () => {
		// An `s=2` glyph covers the row below its own, and the terminal drops the
		// whole glyph when anything is written there. Once that row goes back to
		// the heading's blank spacer, the heading itself must be sent again even
		// though its own row never changed.
		const heading = `${OSC66}s=2;Hi${ST}`;
		const spaced = ["top", heading, "", "bottom"];
		const { terminal, scheduler, tui, overlay } = await openFullscreen(spaced);

		overlay.lines = ["top", heading, "grown", "bottom"];
		tui.requestRender();
		await scheduler.settle(terminal);
		terminal.takeWrites();

		overlay.lines = spaced;
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.takeWrites()).toContain(`${OSC66}s=2;Hi`);

		// A render that changes nothing (a spinner behind the overlay) still writes
		// nothing while the heading is on screen.
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.takeWrites()).toBe("");
		tui.stop();
	});

	it("reports the complete overlay to paint listeners when one row changes", async () => {
		// Session streaming and recording mirror the screen from paint events; a
		// partial repaint that went unreported would freeze their copy of the overlay.
		const { terminal, scheduler, tui, overlay } = await openFullscreen(["alpha", "bravo", "charlie"]);
		const paints: TuiPaint[] = [];
		tui.addPaintListener(paint => paints.push(paint));

		overlay.lines = ["alpha", "BRAVO", "charlie"];
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(paints).toHaveLength(1);
		expect(paints[0]).toMatchObject({ alt: true, reset: false, rows: 3 });
		expect(paints[0]!.viewport.map(row => Bun.stripANSI(row).trimEnd())).toEqual(overlay.lines);
		tui.stop();
	});
});
