/**
 * OSC 66 scaled text spans rows below its own; a blank row drawn there must
 * not erase the cells the glyph covers (kitty erases the whole multicell glyph).
 */
import { describe, expect, it } from "bun:test";
import { coveredCells, drawRow } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { Vt } from "./vt";

const TITLE = "\x1b]66;s=2;Title\x1b\\";

describe("OSC 66 multicell rows", () => {
	it("skips the covered cells when blanking a row under a scaled span", () => {
		expect(coveredCells([TITLE, ""], 1)).toBe(10);
		expect(coveredCells([TITLE, "", ""], 2)).toBe(0);
		expect(drawRow("", 30, 10)).toBe("\r\x1b[0m\x1b[10C\x1b[K");
		expect(drawRow("", 8, 10)).toBe("\r");
		expect(drawRow("", 30)).toBe("\r\x1b[2K");
		// Padding after the span covers nothing; an indented spacer is still a spacer.
		expect(coveredCells([`  ${TITLE}    `, "  "], 1)).toBe(12);
		expect(drawRow("  \x1b[0m", 30, 12)).toBe("\r\x1b[0m\x1b[12C\x1b[K");
	});

	for (const fullscreen of [false, true]) {
		it(`keeps the scaled glyph on screen (${fullscreen ? "alternate" : "inline"})`, () => {
			const vt = new Vt({ columns: 30, rows: 8 });
			const rows = [TITLE, "", "body"];
			vt.present(fullscreen ? { viewport: [], cursor: null, fullscreen: rows } : { viewport: rows, cursor: null });
			const screen = vt.screen();
			const top = screen.findIndex(row => row.includes("T"));
			expect(top).toBeGreaterThanOrEqual(0);
			expect(screen.join("\n")).toContain("body");
			// Repaint the row below the glyph as a different blank-led frame: the glyph must survive.
			vt.present(
				fullscreen
					? { viewport: [], cursor: null, fullscreen: [TITLE, "", "next"] }
					: { viewport: [TITLE, "", "next"], cursor: null },
			);
			expect(vt.screen()[top]).toBe(screen[top]);
		});
	}
});
