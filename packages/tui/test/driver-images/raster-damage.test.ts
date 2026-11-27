/**
 * Rows an iTerm/SIXEL anchor draws into are not its own row: when one of them is rewritten, its
 * pixels there are gone, so the anchor row must be written again too. Thumbnails side by side put
 * several anchors on one row, and the inline writer must repaint them like the alternate screen.
 */
import { describe, expect, it } from "bun:test";
import { rasterDamage } from "@oh-my-pi/pi-tui/driver/images/viewport";
import { Vt } from "../driver-output/vt";

/** A `cells`-wide picture drawn over blank cells from `up` rows above (`anchoredCellRows`' last row). */
function picture(cells: number, up: number): string {
	return `${" ".repeat(cells)}\x1b[${cells}D\x1b7\x1b[${up}A\x1bPq#0~\x1b\\\x1b8\x1b[${cells}C`;
}

describe("raster damage", () => {
	it("follows the farthest-reaching anchor on a row, not only the first", () => {
		const anchors = `${picture(2, 1)} ${picture(2, 2)}`;
		const damage = rasterDamage(["a", "b", anchors], ["x", "b", anchors]);
		expect(damage?.[2]).toBe(1);
	});

	it("rewrites an inline anchor row when a row its picture covers is rewritten", () => {
		const vt = new Vt({ columns: 20, rows: 6 });
		const row = `cd${picture(2, 1)}`;
		vt.present({ viewport: ["ab", row], cursor: null });
		let from = vt.writes.length;
		vt.present({ viewport: ["xy", row], cursor: null });
		expect(vt.writes.slice(from).join("")).toContain("\x1bPq#0~");

		// Nothing under the picture changed: the anchor row stays as it is.
		from = vt.writes.length;
		vt.present({ viewport: ["xy", row, "z"], cursor: null });
		expect(vt.writes.slice(from).join("")).not.toContain("\x1bPq#0~");
	});
});
