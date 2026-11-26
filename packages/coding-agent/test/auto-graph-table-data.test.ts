import { describe, expect, it } from "bun:test";
import { analyzeTable, cellStatus, parseCell } from "@oh-my-pi/pi-coding-agent/auto-graph/table-data";
import { lexMarkdown, type Tokens } from "@oh-my-pi/pi-tui/text/markdown/lexer";

function table(markdown: string): Tokens.Table {
	const token = lexMarkdown(markdown).find((entry): entry is Tokens.Table => entry.type === "table");
	if (!token) throw new Error("no table in fixture");
	return token;
}

function analyze(markdown: string) {
	const parsed = table(markdown);
	return analyzeTable(
		parsed.header.map(cell => cell.text),
		parsed.rows.map(row => row.map(cell => cell.text)),
	);
}

describe("parseCell", () => {
	// Regression (#16331): a day-first date (`9 Oct`, `3–4 paź`) read as its day number, so day numbers of different months charted on one axis.
	it("reads day-first dates as dates, and a count beside a month-like word as a number", () => {
		for (const date of [
			"9 Oct",
			"9 paź",
			"3–4 paź",
			"31 paź – 1 lis",
			"5 lis (zmiana), potem 14–15 lis",
			"9. Okt.",
			"9 października 2026",
		]) {
			expect(parseCell(date).kind).toBe("date");
		}
		expect(parseCell("3 decks")).toMatchObject({ value: 3, fit: "note" });
		expect(parseCell("3 may fail")).toMatchObject({ value: 3, fit: "prose" });
	});

	// Regression (#16331): `zł` split into `z` and `ł`, so the range's figure lost its unit and a noun read as prose.
	it("keeps units and nouns with non-ASCII letters whole", () => {
		expect(parseCell("3–4 zł")).toMatchObject({ value: 3, upper: 4, fit: "range", figure: "3–4 zł" });
		expect(parseCell("12 żółwi")).toMatchObject({ value: 12, fit: "note" });
	});
});

// Regression (#16331): `ok.` before a number is Polish "about", so `ok. 5–6 gru` read as a passing status.
describe("cellStatus", () => {
	it("does not read `ok.` before a number as a status word", () => {
		expect(cellStatus("ok. 5–6 gru")).toBeUndefined();
		expect(cellStatus("ok")).toBe("good");
	});
});

describe("analyzeTable", () => {
	// Regression (#16331): day-first date columns read as measures, so their day numbers were plotted on one log axis.
	it("reads a table of day-first dates as temporal columns, with no measure to plot", () => {
		const analysis = analyze(
			"| Osoba | Termin 1 | Termin 2 | Następny termin |\n|---|---|---|---|\n| A | 3–4 paź | 9 paź | 7–8 lis |\n| B | 10–11 paź | 16 paź | 5 lis (zmiana), potem 14–15 lis |\n| C | 17–18 paź | 23 paź | 21–22 lis |\n| D | 24–25 paź | 30 paź | 28–29 lis |\n| E | 31 paź – 1 lis | 6 lis | ok. 5–6 gru |",
		);
		expect(analysis.columns.map(column => column.role)).toEqual(["label", "temporal", "temporal", "temporal"]);
		expect(analysis.measures).toEqual([]);
	});
});
