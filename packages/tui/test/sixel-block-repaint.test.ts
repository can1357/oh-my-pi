import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { TUI } from "@oh-my-pi/pi-tui";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const CELL: CellDimensions = { widthPx: 10, heightPx: 20 };
const RASTER = "▓";
const SIXEL = /\x1bP[0-9;]*q[\s\S]*?\x1b\\/g;

/**
 * Model a SIXEL terminal's raster on top of the text engine, the way Windows
 * Terminal stores it: each DCS paints cells starting at the cursor, a text
 * write or erase clears the cells it covers, and a new raster composites over
 * whatever pixels it lands on (transparent background, `P2=1`). Raster cells
 * become a sentinel glyph so the engine's own writes and erases clear them;
 * `stale` counts paints that landed on cells still holding an earlier raster.
 */
function trackSixelRaster(term: VirtualTerminal): { stale: number; paints: number } {
	const state = { stale: 0, paints: 0 };
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		let offset = 0;
		for (const match of data.matchAll(SIXEL)) {
			realWrite(data.slice(offset, match.index));
			offset = match.index + match[0].length;
			const raster = /"\d+;\d+;(\d+);(\d+)/.exec(match[0]);
			if (!raster) continue;
			const columns = Math.ceil(Number(raster[1]) / CELL.widthPx);
			// Terminals can allocate complete six-pixel bands even when the
			// raster header declares a smaller height.
			const body = match[0].slice(match[0].indexOf("q") + 1, -2).replace(/["#][0-9;]+|!\d+/g, "");
			const bandExtent = body
				.split("-")
				.reduce((extent, band, index) => (/[?-~]/.test(band) ? (index + 1) * 6 : extent), 0);
			const rows = Math.ceil(Math.max(Number(raster[2]), bandExtent) / CELL.heightPx);
			const cursor = term.getCursor();
			const screen = term.getViewport();
			for (let row = cursor.row; row < cursor.row + rows; row++) {
				if (screen[row]?.slice(cursor.col, cursor.col + columns).includes(RASTER)) state.stale++;
			}
			state.paints++;
			let paint = "\x1b7";
			for (let row = 0; row < rows; row++) paint += `${RASTER.repeat(columns)}\x1b[${columns}D\x1b[B`;
			realWrite(`${paint}\x1b8`);
		}
		realWrite(data.slice(offset));
	});
	return state;
}

describe("SIXEL block repaint", () => {
	let originalCellDims: CellDimensions;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions(CELL);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		vi.useFakeTimers();
		// One full 30fps frame per read: the render throttle never defers a frame.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (now += 40));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		setTerminalImageProtocol(originalProtocol);
	});

	/** Run the `setImmediate` render hop and any throttled frame timer it arms. */
	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 2; i++) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			vi.advanceTimersByTime(40);
			await term.flush();
		}
	}

	it("erases a moved block's previous raster before painting it again", async () => {
		const encodeSixel = spyOn(natives, "encodeSixelAsync");
		const term = new VirtualTerminal(40, 12);
		const raster = trackSixelRaster(term);
		const tui = new TUI(term);
		const above = new Text("above", 0, 0);
		tui.addChild(above);
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "moving" },
				{ widthPx: 40, heightPx: 80 },
			),
		);
		tui.addChild(new Text("below", 0, 0));
		try {
			tui.start();
			await settle(term);
			await encodeSixel.mock.results[0]?.value;
			await settle(term);
			// Each frame moves the block one row inside the viewport: a diffable
			// frame in which its reserved rows are byte-identical and skipped.
			for (const text of ["above\nextra", "above", "above\nextra", "above"]) {
				above.setText(text);
				tui.requestRender();
				await settle(term);
			}
			expect(raster.paints).toBe(5);
			expect(raster.stale).toBe(0);
			// Back on rows 1..4: exactly one raster, nothing left behind.
			const rasterRows = term.getViewport().flatMap((line, row) => (line.includes(RASTER) ? [row] : []));
			expect(rasterRows).toEqual([1, 2, 3, 4]);
		} finally {
			tui.stop();
		}
	});

	for (const clippedRows of [1, 2, 3]) {
		it(`keeps a real Image within its ${4 - clippedRows} visible rows after top clipping`, async () => {
			const encodeSixel = spyOn(natives, "encodeSixelAsync");
			const term = new VirtualTerminal(40, 8);
			const raster = trackSixelRaster(term);
			const tui = new TUI(term);
			const graphic = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: `clipped-${clippedRows}` },
				{ widthPx: 40, heightPx: 80 },
			);
			let clip = false;
			let repaint = false;
			tui.setFrameProvider({
				renderFrame: size => ({
					viewport: [
						...graphic
							.render(size.columns)
							.slice(clip ? clippedRows : 0)
							.map((line, index, lines) => (repaint && index === lines.length - 1 ? `${line}\x1b[0m` : line)),
						"following text",
						"another untouched line",
					],
				}),
				acknowledgeHistory() {},
			});
			try {
				tui.start();
				await settle(term);
				await encodeSixel.mock.results[0]?.value;
				await settle(term);
				expect(raster.paints).toBeGreaterThan(0);
				expect(term.getViewport()[4]?.trimEnd()).toBe("following text");

				clip = true;
				tui.requestRender();
				await settle(term);
				const paints = raster.paints;
				expect(paints).toBeGreaterThan(1);
				// Change only a harmless suffix on the real Image line so it is
				// repainted while following text stays byte-identical and skipped.
				// An uncropped raster now overwrites that previously painted text.
				repaint = true;
				tui.requestRender();
				await settle(term);
				expect(raster.paints).toBeGreaterThan(paints);
				const viewport = term.getViewport();
				expect(viewport.flatMap((line, row) => (line.includes(RASTER) ? [row] : []))).toEqual(
					Array.from({ length: 4 - clippedRows }, (_, row) => row),
				);
				expect(viewport[4 - clippedRows]?.trimEnd()).toBe("following text");
				expect(viewport[5 - clippedRows]?.trimEnd()).toBe("another untouched line");
			} finally {
				tui.stop();
			}
		});
	}

	it("drops a top-clipped SIXEL the cropper cannot parse instead of failing the frame", async () => {
		const term = new VirtualTerminal(40, 8);
		const raster = trackSixelRaster(term);
		const tui = new TUI(term);
		// A palette definition after drawing is outside the cropper's grammar.
		const foreign = '\x1bP0;1;0q"1;1;40;80#1;2;100;0;0#1!40~#2;2;0;100;0#2!40~\x1b\\';
		const block = ["", "", "", `\x1b7\x1b[3A${foreign}\x1b8`];
		let clip = false;
		tui.setFrameProvider({
			renderFrame: () => ({ viewport: [...block.slice(clip ? 2 : 0), "following text"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await settle(term);
			const paints = raster.paints;
			expect(paints).toBeGreaterThan(0);

			clip = true;
			tui.requestRender();
			await settle(term);
			expect(raster.paints).toBe(paints);
			expect(term.getViewport()[2]?.trimEnd()).toBe("following text");
		} finally {
			tui.stop();
		}
	});
});
