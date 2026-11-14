import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** A HiDPI cell; 838 units at 2.25 px/unit is 1885.5 px, not a whole number of cells. */
const CELL: CellDimensions = { widthPx: 16, heightPx: 36 };
const SVG = `<svg viewBox="0 0 838 200"><rect width="838" height="200" fill="var(--accent)"/></svg>`;
/** 300 units tall: ~19 rows at its natural size. */
const TALL_SVG = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#f00"/></svg>';

/** A final figure whose raster landings resolve `landed()`. */
function figure(): { figure: SvgFigure; landed: () => Promise<void> } {
	let resolve = () => {};
	const svg = new SvgFigure({ onChange: () => resolve() });
	svg.update(SVG, true);
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

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setCellDimensions(CELL);
	});

	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		setCellDimensions(originalCell);
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

	it("fits a caller's row ceiling, refitting the shown image before its redraw lands", async () => {
		let maxRows = 12;
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({ maxRows: () => maxRows, onChange: () => landed.resolve() });
		svg.update(TALL_SVG, true);
		svg.render(76);
		await landed.promise;
		expect(svg.render(76)).toHaveLength(12);

		landed = Promise.withResolvers<void>();
		maxRows = 4;
		expect(svg.render(76)).toHaveLength(4);
		await landed.promise;
		const redrawn = placement(svg, 76);
		expect(redrawn.box).toBe(redrawn.raster);
		expect(svg.render(76)).toHaveLength(4);
	});

	// Regression: the viewport default refit the drawn image to a shorter
	// terminal at once, blanking a SIXEL until its re-encode landed.
	it("keeps the drawn image while a shorter terminal's redraw is on its way", async () => {
		const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({ onChange: () => landed.resolve() });
		svg.update(TALL_SVG, true);
		try {
			svg.render(76);
			await landed.promise;
			const drawn = svg.render(76);
			expect(drawn.length).toBeGreaterThan(9);

			landed = Promise.withResolvers<void>();
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
			expect(svg.render(76)).toBe(drawn);
			await landed.promise;
			expect(svg.render(76)).toHaveLength(9);
		} finally {
			if (rows) Object.defineProperty(process.stdout, "rows", rows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("hides below one whole row without holding up completion, then draws when room returns", async () => {
		let maxRows = 0.5;
		const landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			maxRows: () => maxRows,
			onChange: () => landed.resolve(),
		});
		svg.update(TALL_SVG, true);
		expect(svg.render(76)).toEqual([]);
		expect(svg.pending).toBe(false);

		maxRows = 4;
		expect(svg.pending).toBe(true);
		svg.render(76);
		await landed.promise;
		expect(svg.render(76).some(row => TERMINAL.isImageLine(row))).toBe(true);
	});

	it("hides a SIXEL whose one band needs more rows than the ceiling", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		setCellDimensions({ widthPx: 16, heightPx: 4 });
		const landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({ maxRows: () => 1, onChange: () => landed.resolve() });
		svg.update(TALL_SVG, true);
		svg.render(76);
		await landed.promise;
		expect(svg.render(76)).toEqual([]);
	});

	it("cuts the code fallback to the ceiling, returning the same rows while unchanged", async () => {
		let maxRows = 2;
		const landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			maxRows: () => maxRows,
			onChange: () => landed.resolve(),
		});
		svg.update("not an svg\nsecond line\nthird line", true);
		svg.render(76);
		await landed.promise;
		const cut = svg.render(76);
		expect(cut).toHaveLength(2);
		expect(svg.render(76)).toBe(cut);

		maxRows = 3;
		expect(svg.render(76)).toHaveLength(3);
		maxRows = 100;
		expect(svg.render(76).join("\n")).toContain("third line");
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
