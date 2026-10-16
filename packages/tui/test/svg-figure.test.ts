import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	getTerminalBackgroundColor,
	ImageProtocol,
	setCellDimensions,
	setTerminalBackgroundColor,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import type { Component } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** A HiDPI cell; 838 units at 2.25 px/unit is 1885.5 px, not a whole number of cells. */
const CELL: CellDimensions = { widthPx: 16, heightPx: 36 };
const SVG = `<svg viewBox="0 0 838 200"><rect width="838" height="200" fill="var(--accent)"/></svg>`;

/** A final figure whose raster landings resolve `landed()`. */
function figure(source: string = SVG): { figure: SvgFigure; landed: () => Promise<void> } {
	let resolve = () => {};
	const svg = new SvgFigure({ onChange: () => resolve() });
	svg.update(source, true);
	return {
		figure: svg,
		landed: () => {
			const next = Promise.withResolvers<void>();
			resolve = next.resolve;
			return next.promise;
		},
	};
}

/** The raster's pixels and the pixels of the cell box its Kitty placement asks the terminal to fill. */
function placement(svg: SvgFigure, width: number): { raster: string; box: string; columns: number } {
	const match = /c=(\d+),r=(\d+)/.exec(svg.render(width).join("\n"));
	if (!match) throw new Error("no Kitty placement rendered");
	const columns = Number(match[1]);
	const rows = Number(match[2]);
	return {
		raster: String(svg.debugState().raster),
		box: `${columns * CELL.widthPx}x${rows * CELL.heightPx}`,
		columns,
	};
}

describe("SvgFigure", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalCell = { ...getCellDimensions() };
	const originalGraphics = { ...getKittyGraphics() };
	const originalBackground = getTerminalBackgroundColor();

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions(CELL);
		setTerminalBackgroundColor(null);
	});

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
		setTerminalBackgroundColor(originalBackground);
		setKittyGraphics(originalGraphics);
	});

	// Regression: a 1886 px raster was placed over 117 cells (1872 px), so the
	// terminal resampled it by 0.99 and every glyph edge blurred.
	it("draws at its natural size onto exactly the cells it is placed over", async () => {
		const { figure: svg, landed } = figure();
		const raster = landed();
		svg.render(200);
		await raster;
		const shown = placement(svg, 200);
		expect(shown.columns).toBe(118);
		expect(shown.box).toBe(shown.raster);
	});

	it("replaces an SVG raster without leaving either revision over subsequent prose", async () => {
		setKittyGraphics({ unicodePlaceholders: false });
		const term = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			budget: tui.imageBudget,
			onChange: () => {
				landed.resolve();
				tui.requestRender();
			},
		});
		svg.update(SVG, true);
		let width = 80;
		let visible = true;
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: visible ? svg.render(width) : ["prose replacing the figure"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			await landed.promise;
			await scheduler.advance(term, 400);
			const first = term.graphicsPlacements();
			expect(first).toHaveLength(1);

			landed = Promise.withResolvers<void>();
			width = 40;
			tui.requestRender();
			await scheduler.settle(term);
			await landed.promise;
			await scheduler.settle(term);
			const replacement = term.graphicsPlacements();
			expect(replacement).toHaveLength(1);
			expect(replacement[0]!.imageId).not.toBe(first[0]!.imageId);
			expect(replacement[0]!.numCols).toBeLessThan(first[0]!.numCols);

			visible = false;
			svg.dispose();
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual([]);
			expect(term.getViewport()[0]?.trimEnd()).toBe("prose replacing the figure");
		} finally {
			svg.dispose();
			tui.stop();
		}
	});

	it("redraws for a narrower width instead of leaving the terminal to shrink it", async () => {
		const { figure: svg, landed } = figure();
		let raster = landed();
		svg.render(200);
		await raster;
		raster = landed();
		svg.render(80);
		await raster;
		const shown = placement(svg, 80);
		expect(shown.columns).toBe(78);
		expect(shown.box).toBe(shown.raster);
	});

	it("holds a final raster pending through cell, width, and theme replacements", async () => {
		const { figure: svg, landed } = figure();
		let next = landed();
		svg.render(200);
		await next;
		expect(svg.pending).toBe(false);
		expect(svg.debugState().current).toBe(true);

		setCellDimensions({ widthPx: 12, heightPx: 24 });
		expect(svg.pending).toBe(true);
		expect(svg.debugState().current).toBe(false);
		next = landed();
		expect(svg.render(200).some(row => TERMINAL.isImageLine(row))).toBe(true);
		await next;
		expect(svg.pending).toBe(false);
		expect(svg.debugState().current).toBe(true);

		next = landed();
		svg.render(40);
		expect(svg.pending).toBe(true);
		expect(svg.debugState().current).toBe(false);
		await next;
		expect(svg.pending).toBe(false);

		const previousTheme = theme;
		const previousImage = svg.render(40).join("");
		try {
			const otherTheme = await getThemeByName(previousTheme.isLight ? "dark" : "light");
			if (!otherTheme) throw new Error("Expected alternate built-in theme");
			setThemeInstance(otherTheme);
			expect(svg.pending).toBe(true);
			expect(svg.debugState().current).toBe(false);
			next = landed();
			svg.render(40);
			await next;
			expect(svg.pending).toBe(false);
			expect(svg.debugState().current).toBe(true);
			expect(svg.render(40).join("")).not.toBe(previousImage);
		} finally {
			setThemeInstance(previousTheme);
			svg.dispose();
		}
	});

	it("never retires an obsolete raster after a finalized figure changes cell geometry", async () => {
		const { figure: svg, landed } = figure();
		const next = landed();
		svg.render(80);
		await next;
		const transcript = new TranscriptContainer();
		const block: Component & { isTranscriptBlockPending(): boolean } = {
			render: width => svg.render(width),
			isTranscriptBlockPending: () => svg.pending,
		};
		transcript.addChild(block);
		const obsolete = transcript.peekFlushBatch(80)!;
		expect(obsolete.rows.some(row => TERMINAL.isImageLine(row))).toBe(true);
		expect(transcript.blockStates()).toEqual(["settled"]);

		setCellDimensions({ widthPx: 12, heightPx: 24 });
		expect(svg.pending).toBe(true);
		expect(svg.debugState().current).toBe(false);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["active"]);
		transcript.acknowledgeFinalizedBatch(obsolete.id);
		expect(transcript.blockStates()).toEqual(["active"]);

		const replaced = landed();
		svg.render(80);
		await replaced;
		const current = transcript.peekFlushBatch(80)!;
		expect(current.rows.some(row => TERMINAL.isImageLine(row))).toBe(true);
		expect(current.rows).not.toEqual(obsolete.rows);
		expect(svg.pending).toBe(false);
		transcript.acknowledgeFinalizedBatch(current.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		svg.dispose();
	});

	it("retries a failed final raster when its drawing room or cell size changes", async () => {
		const { figure: svg, landed } = figure("<svg><rect></svg>");
		let next = landed();
		svg.render(80);
		await next;
		expect(svg.debugState().failed).toBe(true);
		expect(svg.pending).toBe(false);

		next = landed();
		svg.render(40);
		expect(svg.pending).toBe(true);
		await next;
		expect(svg.debugState().failed).toBe(true);
		expect(svg.pending).toBe(false);

		setCellDimensions({ widthPx: 12, heightPx: 24 });
		expect(svg.debugState().failed).toBe(false);
		expect(svg.pending).toBe(true);
		next = landed();
		svg.render(40);
		await next;
		expect(svg.debugState().failed).toBe(true);
		svg.dispose();
	});

	it("replaces the SIXEL raster when its known background changes without flattening Kitty", async () => {
		const source = `<svg viewBox="0 0 16 16"><rect width="8" height="16" fill="#ff0000" opacity=".5"/></svg>`;
		setTerminalImageProtocol(ImageProtocol.Sixel);
		setTerminalBackgroundColor("#000000");
		const { figure: svg, landed } = figure(source);
		let next = landed();
		svg.render(40);
		await next;
		const black = renderForScrollback(() => svg.render(40)).join("");
		expect(black).toContain("\x1bP");
		expect(black).not.toMatch(/#\d+;2;100;100;100/);
		expect(svg.pending).toBe(false);

		setTerminalBackgroundColor("#ffffff");
		expect(svg.pending).toBe(true);
		expect(svg.debugState().current).toBe(false);
		next = landed();
		svg.render(40);
		await next;
		const white = renderForScrollback(() => svg.render(40)).join("");
		expect(white).toContain("\x1bP");
		expect(white).not.toBe(black);
		expect(white).toMatch(/#\d+;2;100;100;100/);
		expect(svg.pending).toBe(false);
		setTerminalBackgroundColor(null);
		expect(svg.pending).toBe(true);
		next = landed();
		svg.render(40);
		await next;
		expect(svg.pending).toBe(false);
		svg.dispose();

		setTerminalImageProtocol(ImageProtocol.Kitty);
		const { figure: alpha, landed: kittyLanded } = figure(source);
		const kittyRaster = kittyLanded();
		alpha.render(40);
		await kittyRaster;
		const kitty = alpha.render(40).join("");
		setTerminalBackgroundColor("#000000");
		expect(alpha.pending).toBe(false);
		setTerminalBackgroundColor("#ffffff");
		expect(alpha.pending).toBe(false);
		expect(alpha.render(40).join("")).toBe(kitty);
		alpha.dispose();
	});

	// Regression (#15660): with no theme installed the palette threw inside the
	// raster, so the figure was marked failed and showed its source instead.
	it("draws in a process that never installed a theme", async () => {
		const script = `
			import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
			const landed = Promise.withResolvers();
			const svg = new SvgFigure({ onChange: () => landed.resolve() });
			svg.update(${JSON.stringify(SVG)}, true);
			await Promise.resolve();
			svg.render(80);
			await landed.promise;
			process.stdout.write(JSON.stringify(svg.debugState()));
		`;
		const proc = Bun.spawn([process.execPath, "--eval", script], {
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ failed: false, current: true });
	});
});
