import { describe, expect, it } from "bun:test";
import { Box, type BoxBorder, Text } from "@oh-my-pi/pi-tui";

const CHARS: BoxBorder["chars"] = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
};

function borderedBox(border?: Partial<BoxBorder>): Box {
	// paddingY 0 keeps the row count predictable; ignoreTight pins paddingX to exactly 1.
	// Real SGR escapes so Bun.stripANSI removes both bg and border color before width checks.
	const box = new Box(1, 0, t => `\x1b[48;5;236m${t}\x1b[49m`, {
		chars: CHARS,
		color: t => `\x1b[31m${t}\x1b[39m`,
		...border,
	});
	box.setIgnoreTight(true);
	box.addChild(new Text("hi", 0, 0));
	return box;
}

const widths = (rows: readonly string[]): number[] => rows.map(r => Bun.stringWidth(Bun.stripANSI(r)));
const plain = (rows: readonly string[]): string[] => rows.map(r => Bun.stripANSI(r));

describe("Box border", () => {
	it("frames content without exceeding the given width", () => {
		const rows = borderedBox().render(20);
		// top rule + single content row + bottom rule
		expect(rows.length).toBe(3);
		for (const w of widths(rows)) expect(w).toBe(20);

		const flat = plain(rows);
		expect(flat[0]).toBe(`+${"-".repeat(18)}+`);
		expect(flat[2]).toBe(`+${"-".repeat(18)}+`);
		// Interior rows are wrapped by the vertical glyph on both edges.
		expect(flat[1]!.startsWith("|")).toBe(true);
		expect(flat[1]!.endsWith("|")).toBe(true);
		expect(flat[1]).toContain("hi");
	});

	it("paints border glyphs with the supplied colorizer", () => {
		const rows = borderedBox().render(20);
		// The top rule is emitted through the color fn (red SGR), the interior is not.
		expect(rows[0]).toContain("\x1b[31m");
	});

	it("recomputes width when the border is toggled off", () => {
		const box = borderedBox();
		expect(widths(box.render(20))).toEqual([20, 20, 20]);

		box.setBorder(undefined);
		const rows = box.render(20);
		// No border rows now; the single content row fills the full width.
		expect(rows.length).toBe(1);
		expect(Bun.stringWidth(Bun.stripANSI(rows[0]!))).toBe(20);
		expect(Bun.stripANSI(rows[0]!)).not.toContain("+");
	});

	it("frames at the boundary width without overflowing", () => {
		// paddingX 1 → the border needs width >= 5 (2 borders + 2 padding + 1 content col).
		const rows = borderedBox().render(5);
		for (const w of widths(rows)) expect(w).toBe(5);
		expect(plain(rows)[0]).toBe(`+${"-".repeat(3)}+`);
	});

	it("drops the border when the interior can't fit padding + content", () => {
		for (const width of [3, 4]) {
			const rows = borderedBox().render(width);
			for (const w of widths(rows)) expect(w).toBeLessThanOrEqual(width);
			for (const line of plain(rows)) expect(line).not.toContain("+");
		}
	});

	it("sets a label into the top rule without changing the width and leaves the bottom rule plain", () => {
		const rows = plain(borderedBox({ topLabel: "GITHUB" }).render(30));
		const interior = 30 - 2;
		// The label is centered: equal rule on both sides, a space around the text.
		const spare = interior - "GITHUB".length - 2;
		const left = Math.floor(spare / 2);
		expect(rows[0]).toBe(`+${"-".repeat(left)} GITHUB ${"-".repeat(spare - left)}+`);
		expect(rows[2]).toBe(`+${"-".repeat(interior)}+`);
		for (const w of widths(rows)) expect(w).toBe(30);
	});

	it("truncates a label that does not fit and marks the cut", () => {
		const rows = plain(borderedBox({ topLabel: "a very long pull request title that cannot fit" }).render(20));
		expect(Bun.stringWidth(rows[0]!)).toBe(20);
		expect(rows[0]!.startsWith("+-")).toBe(true);
		expect(rows[0]).toContain("…");
	});

	it("strips escape sequences and control characters from a label so remote text cannot reach the terminal", () => {
		const row = borderedBox({ topLabel: "ok\x1b[31mred\x07\tend" }).render(30)[0]!;
		const flat = Bun.stripANSI(row);
		// The whole SGR sequence and the bell go; the tab becomes spaces like all other untrusted text.
		expect(flat).toMatch(/^\+-+ okred\s+end -+\+$/);
		expect(row).not.toContain("\x07");
		expect(row).not.toContain("\t");
		// The only escapes left are the border colorizer's own opening and closing sequences.
		expect(row.match(/\x1b/g)?.length).toBe(2);
		expect(Bun.stringWidth(flat)).toBe(30);
	});

	it("keeps a plain rule when the box is too narrow to hold a label", () => {
		const rows = plain(borderedBox({ topLabel: "GITHUB" }).render(6));
		expect(rows[0]).toBe(`+${"-".repeat(4)}+`);
	});
});
