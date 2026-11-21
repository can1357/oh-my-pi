import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// GFM alignment markers (`:---`, `---:`, `:---:`) tell the renderer where each
// column's content belongs. A right-aligned column ends at the column's right
// edge, a centered one is surrounded by padding on both sides, and an unmarked
// column stays flush left.
const source = ["| A | B | C |", "| :--- | ---: | :---: |", "| Alpha | 1200 | ripe |", "| a | 1 | ok |"].join("\n");

/**
 * The cells of every rendered row of a table. A row reads `| cell | cell |`, so
 * each field between two borders is the separator space, the cell's own
 * content, and the separator space again.
 */
function tableCells(text: string, width = 80): string[][] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme)
		.render(width)
		.map(line => stripVTControlCharacters(line).trimEnd())
		.filter(line => line.startsWith("|"))
		.map(row =>
			row
				.split("|")
				.slice(1, -1)
				.map(field => field.slice(1, -1)),
		);
}

describe("markdown table column alignment", () => {
	it("places header and body cells according to the column's alignment marker", () => {
		const rows = tableCells(source);
		expect(rows).toHaveLength(3);

		const [header, firstRow, secondRow] = rows;

		// An unmarked column stays flush left.
		expect(header[0]).toBe("A    ");
		expect(secondRow[0]).toBe("a    ");

		// A right-aligned column ends at the column's right edge.
		expect(header[1]).toBe("   B");
		expect(secondRow[1]).toBe("   1");

		// A centered column is padded on both sides, never flush left.
		expect(header[2]).toBe(" C  ");
		expect(secondRow[2]).toBe(" ok ");

		// The row whose cells fill their columns exactly is unaffected.
		expect(firstRow).toEqual(["Alpha", "1200", "ripe"]);
	});

	it("aligns every wrapped line of a cell to its column", () => {
		const rows = tableCells("| L | R |\n| :--- | ---: |\n| abc | alpha beta |", 19);
		expect(rows).toHaveLength(3);

		// The right-aligned cell wraps; its header and every wrapped line end at
		// the column's right edge, and the left column stays flush left.
		expect(rows[0]).toEqual(["L  ", "        R"]);
		expect(rows[1]).toEqual(["abc", "    alpha"]);
		expect(rows[2]).toEqual(["   ", "     beta"]);

		for (const row of rows) {
			const right = row[1]!;
			expect(right).toBe(right.trimEnd());
			expect(right.trim().length).toBeGreaterThan(0);
		}
	});
});
