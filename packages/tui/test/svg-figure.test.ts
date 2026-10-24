import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { FigureMarkdown } from "@oh-my-pi/pi-tui/chat/figure-markdown";
import { SvgFigure } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { ImageBudget, renderForScrollback } from "@oh-my-pi/pi-tui/components/image";
import { fencedCode, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
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
import { Container, TUI } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** A HiDPI cell; 838 units at 2.25 px/unit is 1885.5 px, not a whole number of cells. */
const CELL: CellDimensions = { widthPx: 16, heightPx: 36 };
const SVG = `<svg viewBox="0 0 838 200"><rect width="838" height="200" fill="var(--accent)"/></svg>`;
const LANDSCAPE_SVG = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#f00"/></svg>';
const PORTRAIT_SVG = '<svg viewBox="0 0 300 400"><rect width="300" height="400" fill="#00f"/></svg>';
const SMALL_SQUARE_SVG = '<svg viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>';
const SMALL_PORTRAIT_SVG = '<svg viewBox="0 0 8 16"><rect width="8" height="16" fill="#00f"/></svg>';

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

function sixelRasters(output: string): { widthPx: number; heightPx: number }[] {
	return [...output.matchAll(/\x1bP[\d;]*q[\s\S]*?\x1b\\/g)].map(([payload]) => {
		const raster = /"\d+;\d+;(\d+);(\d+)/.exec(payload);
		if (!raster) throw new Error("SIXEL payload omitted its raster dimensions");
		return { widthPx: Number(raster[1]), heightPx: Number(raster[2]) };
	});
}

function sixelRowCounts(output: string): number[] {
	return sixelRasters(output).map(({ heightPx }) => Math.ceil(heightPx / CELL.heightPx));
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
		vi.restoreAllMocks();
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

	it("reuses settled figure Markdown rows for container memoization and updates them after resizing", async () => {
		let maxRows = 4;
		let landed = Promise.withResolvers<void>();
		const block = new FigureMarkdown(fencedCode("svg", SVG), {
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			onChange: () => landed.resolve(),
		});
		const container = new Container();
		container.addChild({ render: width => block.render(width, maxRows), dispose: () => block.dispose() });
		try {
			container.render(200);
			await landed.promise;
			const first = container.render(200);
			expect(first.some(row => TERMINAL.isImageLine(row))).toBe(true);
			expect(container.render(200)).toBe(first);

			landed = Promise.withResolvers<void>();
			maxRows = 2;
			container.render(200);
			await landed.promise;
			const resized = container.render(200);
			expect(resized).not.toBe(first);
			expect(resized).toHaveLength(2);
			expect(resized.some(row => TERMINAL.isImageLine(row))).toBe(true);
			expect(container.render(200)).toBe(resized);
		} finally {
			container.dispose();
		}
	});

	it("fits an SVG fence's reserved rows and SIXEL payload within a smaller surface", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		let changed = Promise.withResolvers<void>();
		const block = new FigureMarkdown(fencedCode("svg", LANDSCAPE_SVG), {
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			maxRows: () => 4,
			onChange: () => changed.resolve(),
		});
		try {
			block.render(76);
			await changed.promise;
			changed = Promise.withResolvers<void>();
			const reserved = block.render(76);
			await changed.promise;
			const drawn = block.render(76);
			expect(reserved.length).toBeLessThanOrEqual(4);
			expect(drawn.length).toBeLessThanOrEqual(4);
			expect(drawn.at(-1)).toMatch(/\x1bP[\d;]*q/);
		} finally {
			block.dispose();
		}
	});

	it.each([
		["top-left", "", "", 4],
		["bottom-left", "", "", 4],
		["top-left", "Before the figure\n\n", "", 2],
		["bottom-left", "", "\n\nAfter the figure", 2],
	] as const)(
		"keeps a complete SIXEL figure inside a %s overlay with prefix %j and suffix %j",
		async (anchor, prefix, suffix, figureRows) => {
			setTerminalImageProtocol(ImageProtocol.Sixel);
			const term = new VirtualTerminal(80, 12);
			const writes = spyOn(term, "write");
			const encoded = spyOn(natives, "encodeSixelAsync");
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const landed = Promise.withResolvers<void>();
			const block = new FigureMarkdown(`${prefix}${fencedCode("svg", LANDSCAPE_SVG)}${suffix}`, {
				markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
				charts: false,
				budget: tui.imageBudget,
				onChange: () => {
					landed.resolve();
					tui.requestRender();
				},
			});
			tui.showOverlay(block, { anchor, width: 76, maxHeight: 4 });
			try {
				tui.start();
				await scheduler.settle(term);
				await landed.promise;
				await scheduler.settle(term);
				await encoded.mock.results.at(-1)?.value;
				await scheduler.advance(term, 400);

				const output = writes.mock.calls.map(([data]) => data).join("");
				expect(new Set(sixelRowCounts(output))).toEqual(new Set([figureRows]));
				if (prefix || suffix) expect(term.getViewport().join("\n")).toContain((prefix || suffix).trim());
			} finally {
				block.dispose();
				tui.stop();
			}
		},
	);

	it.each([
		[
			"a figure instead of a separator in a one-row overlay",
			"top-left",
			1,
			`${fencedCode("svg", LANDSCAPE_SVG)}\n\n${fencedCode("svg", PORTRAIT_SVG)}`,
			"landscape",
			undefined,
		],
		[
			"the first of adjacent figures at the top anchor",
			"top-left",
			4,
			`${fencedCode("svg", LANDSCAPE_SVG)}\n\n${fencedCode("svg", PORTRAIT_SVG)}`,
			"landscape",
			undefined,
		],
		[
			"the last of adjacent figures at the bottom anchor",
			"bottom-left",
			4,
			`${fencedCode("svg", LANDSCAPE_SVG)}\n\n${fencedCode("svg", PORTRAIT_SVG)}`,
			"portrait",
			undefined,
		],
		[
			"a leading figure when later prose exceeds the top-anchored overlay",
			"top-left",
			4,
			`${fencedCode("svg", LANDSCAPE_SVG)}\n\nOne\n\nTwo\n\nThree\n\nFour\n\nFive`,
			"landscape",
			undefined,
		],
		[
			"a final figure when earlier prose exceeds the bottom-anchored overlay",
			"bottom-left",
			4,
			`One\n\nTwo\n\nThree\n\nFour\n\nFive\n\n${fencedCode("svg", PORTRAIT_SVG)}`,
			"portrait",
			undefined,
		],
		[
			"the final visible image within the budget at the top anchor",
			"top-left",
			4,
			`${fencedCode("svg", SMALL_SQUARE_SVG)}\n\n${fencedCode("svg", SMALL_PORTRAIT_SVG)}`,
			"portrait",
			1,
		],
		[
			"the final visible image within the budget at the bottom anchor",
			"bottom-left",
			4,
			`${fencedCode("svg", SMALL_SQUARE_SVG)}\n\n${fencedCode("svg", SMALL_PORTRAIT_SVG)}`,
			"portrait",
			1,
		],
	] as const)("preserves %s", async (_contract, anchor, maxHeight, text, shape, cap?: number) => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const term = new VirtualTerminal(80, 12);
		const writes = spyOn(term, "write");
		const rasterized = spyOn(natives, "rasterizeSvg");
		const encoded = spyOn(natives, "encodeSixelAsync");
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		if (cap !== undefined) tui.imageBudget.setCap(cap);
		const block = new FigureMarkdown(text, {
			markdown: source => new Markdown(source, 0, 0, getMarkdownTheme()),
			charts: false,
			budget: tui.imageBudget,
			onChange: () => tui.requestRender(),
		});
		tui.showOverlay(block, { anchor, width: 76, maxHeight });
		try {
			tui.start();
			await scheduler.settle(term);
			// A hidden figure never fires onChange. Await only work that actually
			// started, including replacement rasters after placeholders grow.
			for (let pass = 0; pass < 10; pass++) {
				const count = rasterized.mock.results.length + encoded.mock.results.length;
				await Promise.all([
					...rasterized.mock.results.map(result => result.value),
					...encoded.mock.results.map(result => result.value),
				]);
				await scheduler.advance(term, 400);
				if (count === rasterized.mock.results.length + encoded.mock.results.length) break;
				if (pass === 9) throw new Error("Overlay figures did not settle after ten raster/encode passes");
			}

			const streamed = writes.mock.calls.map(([data]) => data).join("");
			for (const rows of sixelRowCounts(streamed)) expect(rows).toBeLessThanOrEqual(maxHeight);
			writes.mockClear();
			tui.requestRender(true);
			await scheduler.advance(term, 400);
			const rasters = sixelRasters(writes.mock.calls.map(([data]) => data).join(""));
			expect(rasters).toHaveLength(1);
			const raster = rasters[0]!;
			expect(Math.ceil(raster.heightPx / CELL.heightPx)).toBeLessThanOrEqual(maxHeight);
			if (shape === "landscape") expect(raster.widthPx).toBeGreaterThan(raster.heightPx);
			else expect(raster.widthPx).toBeLessThan(raster.heightPx);
		} finally {
			block.dispose();
			tui.stop();
		}
	});

	it("shrinks a visible overlay figure to the rows left by margins after a terminal resize", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const term = new VirtualTerminal(80, 12);
		const writes = spyOn(term, "write");
		const encoded = spyOn(natives, "encodeSixelAsync");
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
		svg.update(LANDSCAPE_SVG, true);
		tui.showOverlay(svg, { anchor: "top-left", width: 76, margin: { top: 2, bottom: 2 } });
		const drawnRows = () => new Set(sixelRowCounts(writes.mock.calls.map(([data]) => data).join("")));
		try {
			tui.start();
			await scheduler.settle(term);
			await landed.promise;
			await scheduler.settle(term);
			await encoded.mock.results.at(-1)?.value;
			await scheduler.advance(term, 400);
			expect(drawnRows()).toEqual(new Set([8]));

			writes.mockClear();
			landed = Promise.withResolvers<void>();
			term.resize(80, 8);
			await scheduler.advance(term, 160);
			expect(drawnRows()).toEqual(new Set([4]));
			await landed.promise;
			await scheduler.settle(term);
			await encoded.mock.results.at(-1)?.value;
			await scheduler.advance(term, 400);
			expect(drawnRows()).toEqual(new Set([4]));
		} finally {
			svg.dispose();
			tui.stop();
		}
	});

	it.each(["render argument", "row callback", "setter"] as const)(
		"keeps an already drawn SVG within a smaller %s bound while its raster is replaced",
		async bound => {
			setTerminalImageProtocol(ImageProtocol.Sixel);
			const encoded = spyOn(natives, "encodeSixelAsync");
			const budget = new ImageBudget(1);
			let maxRows = 12;
			let landed = Promise.withResolvers<void>();
			const svg = new SvgFigure({
				budget,
				maxRows: bound === "row callback" ? () => maxRows : bound === "setter" ? maxRows : undefined,
				onChange: () => landed.resolve(),
			});
			svg.update(LANDSCAPE_SVG, true);
			const render = (): readonly string[] => {
				budget.beginPass();
				let rows = svg.render(76, bound === "render argument" ? maxRows : undefined);
				if (budget.endPass()) {
					budget.beginPass();
					rows = svg.render(76, bound === "render argument" ? maxRows : undefined);
					budget.endPass();
				}
				return rows;
			};
			try {
				render();
				await landed.promise;
				render();
				await encoded.mock.results.at(-1)?.value;
				const initial = render();
				expect(initial.length).toBeGreaterThan(4);
				expect(initial.at(-1)).toMatch(/\x1bP[\d;]*q/);

				landed = Promise.withResolvers<void>();
				maxRows = 4;
				if (bound === "setter") svg.setMaxRows(maxRows);
				const pending = render();
				expect(pending.length).toBeLessThanOrEqual(maxRows);
				expect(pending.at(-1)).toMatch(/\x1bP[\d;]*q/);
				await landed.promise;
				const replacing = render();
				expect(replacing.length).toBeLessThanOrEqual(maxRows);
				expect(replacing.at(-1)).toMatch(/\x1bP[\d;]*q/);
				await encoded.mock.results.at(-1)?.value;
				const drawn = render();
				expect(drawn.length).toBeLessThanOrEqual(maxRows);
				expect(drawn.at(-1)).toMatch(/\x1bP[\d;]*q/);
				const raster = /"\d+;\d+;(\d+);(\d+)/.exec(drawn.join("\n"));
				expect(raster).not.toBeNull();
				expect(Math.ceil(Number(raster![2]) / CELL.heightPx)).toBeLessThanOrEqual(maxRows);
			} finally {
				svg.dispose();
			}
		},
	);

	it.each(["render argument", "row callback", "setter"] as const)(
		"hides placeholders and existing images at zero rows through a %s, then draws when room returns",
		async bound => {
			let maxRows = 0;
			const landed = Promise.withResolvers<void>();
			const block = new FigureMarkdown(fencedCode("svg", LANDSCAPE_SVG), {
				markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
				charts: false,
				maxRows: bound === "row callback" ? () => maxRows : bound === "setter" ? maxRows : undefined,
				onChange: () => landed.resolve(),
			});
			const render = () => block.render(76, bound === "render argument" ? maxRows : undefined);
			try {
				expect(render()).toEqual([]);
				await Promise.resolve();
				expect(render()).toEqual([]);
				expect(block.pending).toBe(false);

				maxRows = 4;
				if (bound === "setter") block.setMaxRows(maxRows);
				render();
				await landed.promise;
				expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);

				maxRows = 0;
				if (bound === "setter") block.setMaxRows(maxRows);
				expect(render()).toEqual([]);
				maxRows = 4;
				if (bound === "setter") block.setMaxRows(maxRows);
				expect(render().some(row => TERMINAL.isImageLine(row))).toBe(true);
			} finally {
				block.dispose();
			}
		},
	);

	it("keeps failed SVG rows stable for container memoization as ceilings and source change", async () => {
		let landed = Promise.withResolvers<void>();
		const svg = new SvgFigure({
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			onChange: () => landed.resolve(),
		});
		const container = new Container();
		container.addChild(svg);
		svg.update("not an svg\nsecond line\nthird line", true);
		try {
			container.render(76);
			await landed.promise;
			const full = container.render(76);
			expect(full.join("\n")).toContain("third line");
			expect(container.render(76)).toBe(full);
			svg.setMaxRows(full.length);
			expect(container.render(76)).toBe(full);

			svg.setMaxRows(2);
			const clipped = container.render(76);
			expect(clipped).toHaveLength(2);
			expect(clipped.join("\n")).toContain("not an svg");
			expect(container.render(76)).toBe(clipped);
			svg.setMaxRows(0);
			expect(container.render(76)).toEqual([]);
			svg.setMaxRows(3);
			const expanded = container.render(76);
			expect(expanded).toHaveLength(3);
			expect(expanded.join("\n")).toContain("second line");
			expect(container.render(76)).toBe(expanded);

			landed = Promise.withResolvers<void>();
			svg.update("replacement invalid svg\nsecond replacement\nthird replacement", true);
			container.render(76);
			await landed.promise;
			const replacement = container.render(76);
			expect(replacement).toHaveLength(3);
			expect(replacement.join("\n")).toContain("replacement invalid svg");
			expect(container.render(76)).toBe(replacement);
			const bottom = svg.render(76, 3, "bottom");
			expect(bottom).toHaveLength(3);
			expect(bottom.join("\n")).toContain("third replacement");
			expect(bottom.join("\n")).not.toContain("replacement invalid svg");
			expect(svg.render(76, 3, "bottom")).toBe(bottom);
			const top = svg.render(76, 3, "top");
			expect(top.join("\n")).toContain("replacement invalid svg");
			expect(svg.render(76, 3, "top")).toBe(top);
			svg.setMaxRows(undefined);
			const restored = container.render(76);
			expect(restored.join("\n")).toContain("third replacement");
			expect(container.render(76)).toBe(restored);
		} finally {
			container.dispose();
		}
	});

	it("restores the configured row callback after a FigureMarkdown render override", async () => {
		setTerminalImageProtocol(ImageProtocol.Sixel);
		let maxRows = 12;
		let landed = Promise.withResolvers<void>();
		const block = new FigureMarkdown(fencedCode("svg", LANDSCAPE_SVG), {
			markdown: text => new Markdown(text, 0, 0, getMarkdownTheme()),
			charts: false,
			maxRows: () => maxRows,
			onChange: () => landed.resolve(),
		});
		try {
			block.render(76, 4);
			await landed.promise;
			expect(renderForScrollback(() => block.render(76, 4))).toHaveLength(4);

			landed = Promise.withResolvers<void>();
			maxRows = 6;
			block.render(76);
			await landed.promise;
			const drawn = renderForScrollback(() => block.render(76));
			expect(drawn).toHaveLength(maxRows);
			const raster = /"\d+;\d+;(\d+);(\d+)/.exec(drawn.join("\n"));
			expect(raster).not.toBeNull();
			expect(Math.ceil(Number(raster![2]) / CELL.heightPx)).toBe(maxRows);
		} finally {
			block.dispose();
		}
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
