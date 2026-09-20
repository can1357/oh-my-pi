import { beforeAll, describe, expect, test } from "bun:test";
import { buildDiffDocument, DiffPane } from "@oh-my-pi/pi-tui/apps/git/diff-pane";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { sliceWithWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";

beforeAll(async () => {
	await initTheme(false);
});

const LONG_LINE = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november";
const OTHER_LINE = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
const SHORT_LINE = "one two three";

/** Body columns of one rendered row: the minimap and its separator column are dropped. */
function body(line: string, width: number): string {
	return sliceWithWidth(line, 0, width - 2).text;
}

/** Rendered rows of the file view with gutters stripped, leading whitespace kept. */
function fileBodies(pane: DiffPane, width: number, height = 40): string[] {
	const gutter = pane.doc?.gutterWidth ?? 3;
	return pane
		.render(width, height)
		.map(line =>
			Bun.stripANSI(body(line, width))
				.slice(gutter + 1)
				.replace(/\s+$/, ""),
		)
		.filter(row => row.length > 0);
}

/** Rendered rows of the file view with gutters stripped: the line body per visual row. */
function fileRows(pane: DiffPane, width: number, height = 40): string[] {
	return fileBodies(pane, width, height)
		.map(row => row.trim())
		.filter(row => row.length > 0);
}

/** Both panes of a split rendering as `[old, new]` bodies, gutters stripped. */
function splitRows(pane: DiffPane, width: number, height = 40): { old: string[]; new: string[] } {
	const old: string[] = [];
	const next: string[] = [];
	for (const side of splitSides(pane, width, height)) {
		if (side.oldBody.length > 0) old.push(side.oldBody);
		if (side.newBody.length > 0) next.push(side.newBody);
	}
	return { old, new: next };
}

/** Split rendering as per-row `{ oldGutter, oldBody, newGutter, newBody }` fields. */
function splitSides(pane: DiffPane, width: number, height = 40) {
	const gutter = pane.doc?.gutterWidth ?? 3;
	return pane
		.render(width, height)
		.map(line => Bun.stripANSI(body(line, width)).split("│"))
		.map(([left = "", right = ""]) => ({
			oldGutter: left.slice(0, gutter).trim(),
			oldBody: left.slice(gutter + 1).trim(),
			newGutter: right.slice(0, gutter).trim(),
			newBody: right.slice(gutter + 1).trim(),
		}));
}

function words(rows: string[]): string[] {
	return rows.flatMap(row => row.split(/\s+/));
}

describe("git diff pane word wrap", () => {
	test("wraps long lines without splitting a word across rows", () => {
		const pane = new DiffPane();
		pane.mode = "file";
		pane.setDocument(buildDiffDocument("", `${LONG_LINE}\n`, "words.txt"), "ready");
		pane.wrap = true;
		const expected = LONG_LINE.split(" ");
		for (const width of [30, 44, 60, 96]) {
			// A fresh pane per width: the layout is cached against the render width.
			pane.setDocument(buildDiffDocument("", `${LONG_LINE}\n`, "words.txt"), "ready");
			const rows = fileRows(pane, width);
			expect(words(rows)).toEqual(expected);
			// Dropped break whitespace aside, no character is lost.
			expect(rows.join("").replace(/\s+/g, "")).toBe(LONG_LINE.replace(/\s+/g, ""));
		}
	});

	test("wraps both split panes and keeps each side's words whole", () => {
		const pane = new DiffPane();
		pane.mode = "split";
		const doc = buildDiffDocument(`${LONG_LINE}\n`, `${OTHER_LINE}\n`, "words.txt");
		pane.setDocument(doc, "ready");
		pane.wrap = true;
		const rows = splitRows(pane, 120);
		expect(words(rows.old)).toEqual(LONG_LINE.split(" "));
		expect(words(rows.new)).toEqual(OTHER_LINE.split(" "));
	});

	test("pads the shorter split side without repeating its gutter number", () => {
		// Regression: wrap windows are per side, so the side that wraps to fewer
		// rows has no window on its partner's extra rows. Treating that as a first
		// row repeats its line number on a filler row; treating it as a normal row
		// re-slices its text past the end.
		const pane = new DiffPane();
		pane.mode = "split";
		pane.setDocument(buildDiffDocument(`${LONG_LINE}\n`, `${SHORT_LINE}\n`, "words.txt"), "ready");
		pane.wrap = true;
		const sides = splitSides(pane, 120);
		const old = sides.filter(row => row.oldBody.length > 0);
		const next = sides.filter(row => row.newBody.length > 0);
		expect(old).toHaveLength(2);
		expect(words(old.map(row => row.oldBody))).toEqual(LONG_LINE.split(" "));
		expect(next).toHaveLength(1);
		expect(next[0]?.newBody).toBe(SHORT_LINE);
		// Only the row that starts a side's text carries its number.
		expect(old.map(row => row.oldGutter)).toEqual(["1", ""]);
		expect(next.map(row => row.newGutter)).toEqual(["1"]);
	});

	test("keeps wide and combining clusters intact when a line wraps", () => {
		// Cells that every terminal agrees on: a wide CJK glyph, a base + combining
		// mark, and a single-codepoint emoji. ZWJ families and skin-tone modifiers
		// are deliberately absent: a terminal whose font does not compose them
		// draws the parts separately, so its rows render wider than any width model
		// (ours and kitty's) can account for, which looks like the row overflowing
		// the text margin.
		const line = `${"word ".repeat(9)}한글 e\u0301 🚀 tail ${"wide 텍스트 ".repeat(5)}`;
		const pane = new DiffPane();
		pane.mode = "file";
		pane.wrap = true;
		for (const width of [24, 33, 48, 72]) {
			pane.setDocument(buildDiffDocument("", `${line}\n`, "emoji.txt"), "ready");
			const rows = fileRows(pane, width);
			const textWidth = width - (pane.doc?.gutterWidth ?? 3) - 1 - 2 - 2;
			for (const row of rows) {
				// Every row is a contiguous run of whole graphemes from the source,
				// and never wider than the margin it was measured against.
				expect(line).toContain(row);
				expect(visibleWidth(row)).toBeLessThanOrEqual(textWidth);
			}
			// A combining mark never starts a row: the cluster stays with its base.
			for (let index = 1; index < rows.length; index++) expect(rows[index]?.startsWith("\u0301")).toBe(false);
			expect(rows.some(row => row.includes("🚀"))).toBe(true);
			expect(rows.join("").replace(/\s+/g, "")).toBe(line.replace(/\s+/g, ""));
		}
	});

	test("fills rows at separators instead of stranding a long token", () => {
		// Regression: wrapping at spaces only pushed a long code token to the next
		// row, leaving 27 cells of blank before the margin. Breaking after the
		// separators vim's `breakat` covers fills the row (gap 5 here) without
		// splitting a letter/digit run.
		const line = `${"prefix ".repeat(16)}see \`alpha/bravo/charlie/delta/echo/foxtrot/golf/hotel\` and then some trailing prose that continues.`;
		const pane = new DiffPane();
		pane.mode = "file";
		pane.setDocument(buildDiffDocument("", `${line}\n`, "words.txt"), "ready");
		pane.wrap = true;
		const rows = fileRows(pane, 150);
		const textWidth = 150 - (pane.doc?.gutterWidth ?? 3) - 1 - 2 - 2;
		for (const row of rows.slice(0, -1)) expect(textWidth - visibleWidth(row)).toBeLessThanOrEqual(6);
		// Whole words survive the break: letters and digits are never split.
		for (const run of ["alpha", "bravo", "charlie", "foxtrot", "hotel", "continues"]) {
			expect(rows.some(row => row.includes(run))).toBe(true);
		}
		expect(rows.join("").replace(/\s+/g, "")).toBe(line.replace(/\s+/g, ""));
	});

	test("keeps an indented line's leading whitespace when it wraps", () => {
		// Regression: the wrap skipped leading whitespace on the line's own first
		// segment too, so every indented line rendered flush-left once wrap was on.
		const line = `\t\tconst line = "${"word ".repeat(14)}";`;
		const pane = new DiffPane();
		pane.mode = "file";
		pane.setDocument(buildDiffDocument("", `${line}\n`, "indent.ts"), "ready");
		pane.wrap = true;
		const bodies = fileBodies(pane, 60);
		expect(bodies.length).toBeGreaterThan(1);
		// Two tabs expand to 6 spaces (DEFAULT_TAB_WIDTH 3) on the first row.
		expect(bodies[0]?.startsWith("      const line")).toBe(true);
		// The continuation row starts at the text margin: the whitespace the break
		// consumed is dropped, not re-emitted.
		expect(bodies[1]?.startsWith("word")).toBe(true);
	});

	test("leaves the unwrapped view as a single panned row per line", () => {
		const pane = new DiffPane();
		pane.mode = "file";
		pane.setDocument(buildDiffDocument("", `${LONG_LINE}\n`, "words.txt"), "ready");
		pane.wrap = false;
		expect(fileRows(pane, 40)).toHaveLength(1);
	});
});
