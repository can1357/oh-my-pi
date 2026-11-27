import { describe, expect, it } from "bun:test";
import { anchoredRows, RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { windowImageRows } from "@oh-my-pi/pi-tui/driver/images/clip";
import { cropSixelTop } from "@oh-my-pi/pi-tui/driver/images/sixel-crop";
import { wrapTmuxPassthrough } from "@oh-my-pi/pi-tui/driver/mux/tmux";

/** A cell six pixels tall: every image row is one SIXEL band, so a crop is easy to state. */
const CELL = 6;
/** A four-row (24 px) SIXEL image, one color per band. */
const SIXEL = '\x1bP0;1;0q"1;1;2;24#1;2;100;0;0#2;2;0;100;0#3;2;0;0;100#4;2;100;100;0#1!2~-#2!2~-#3!2~-#4!2~\x1b\\';
const ITERM = "\x1b]1337;File=inline=1;width=2;height=4:QUJD\x07";

/** Row 0 text, rows 1–4 the image, row 5 text. */
function block(sequence: string, frame?: (row: string) => string): string[] {
	const image = anchoredRows(sequence, 4).map(row => (frame ? frame(row) : row));
	return ["before", ...image, "after"];
}

describe("windowImageRows", () => {
	it("leaves a wholly visible image and plain rows as they are", () => {
		const rows = block(SIXEL);
		expect(windowImageRows(rows, 0, rows.length, CELL)).toEqual(rows);
		expect(windowImageRows(rows, 0, 1, CELL)).toEqual(["before"]);
	});

	it("can scroll a long cached block without reading its offscreen tail again", () => {
		const rows = Array<string>(4096).fill("text");
		let tailReads = 0;
		Object.defineProperty(rows, rows.length - 1, {
			get() {
				tailReads++;
				return "last";
			},
		});
		expect(windowImageRows(rows, 0, 2, CELL)).toEqual(["text", "text"]);
		const afterIndex = tailReads;
		expect(windowImageRows(rows, 1, 3, CELL)).toEqual(["text", "text"]);
		expect(tailReads).toBe(afterIndex);
	});

	it("redraws a SIXEL image cut at the window's top from its first visible row", () => {
		const rows = block(SIXEL);
		const window = windowImageRows(rows, 2, 6, CELL);
		expect(window).toEqual([
			RESERVED_ROW,
			RESERVED_ROW,
			`\x1b7\x1b[2A${cropSixelTop(SIXEL, CELL, 3 * CELL)}\x1b8`,
			"after",
		]);
		// The crop keeps the three lower bands: the image's own height is cut to its rows in view.
		expect(window[2]).toContain('"1;1;2;18');
	});

	it("draws the visible top of a SIXEL image cut at the window's bottom", () => {
		const window = windowImageRows(block(SIXEL), 0, 3, CELL);
		expect(window).toEqual(["before", RESERVED_ROW, `\x1b7\x1b[1A${cropSixelTop(SIXEL, 0, 2 * CELL)}\x1b8`]);
	});

	it("draws a single visible row as the bare cropped raster", () => {
		const window = windowImageRows(block(SIXEL), 4, 6, CELL);
		expect(window).toEqual([cropSixelTop(SIXEL, 3 * CELL, CELL), "after"]);
	});

	it("holds back an image it cannot crop until the whole picture is in view", () => {
		const rows = block(ITERM);
		for (const [from, to] of [
			[2, 6],
			[0, 3],
		] as const) {
			const window = windowImageRows(rows, from, to, CELL);
			expect(window.join("")).not.toContain("1337");
			expect(window).toHaveLength(to - from);
		}
		expect(windowImageRows(rows, 0, 6, CELL).join("")).toContain("1337");
	});

	it("crops a tmux-wrapped SIXEL image and wraps the crop again", () => {
		const window = windowImageRows(block(wrapTmuxPassthrough(SIXEL)), 2, 6, CELL);
		expect(window[2]).toBe(`\x1b7\x1b[2A${wrapTmuxPassthrough(cropSixelTop(SIXEL, CELL, 3 * CELL))}\x1b8`);
	});

	it("keeps a framed image's chrome on the row the crop lands on", () => {
		const frame = (row: string): string => `| ${row} |`;
		const window = windowImageRows(block(SIXEL, frame), 0, 3, CELL);
		expect(window).toEqual([
			"before",
			frame(RESERVED_ROW),
			frame(`\x1b7\x1b[1A${cropSixelTop(SIXEL, 0, 2 * CELL)}\x1b8`),
		]);
	});

	it("holds back a crop whose landing row carries other text beside the image", () => {
		const rows = block(SIXEL);
		rows[2] = `${RESERVED_ROW} caption`;
		const window = windowImageRows(rows, 0, 3, CELL);
		expect(window.join("")).not.toContain("\x1bP");
		expect(window[2]).toBe(`${RESERVED_ROW} caption`);
	});
});
