import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lexer from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { setTableCharts, splitTableCharts } from "../../src/session/transcript/table-chart";

const TABLE = (n: number): string =>
	`| Quarter | Revenue |\n| --- | --- |\n| Q1 | ${n} |\n| Q2 | ${n * 2} |\n| Q3 | ${n * 3} |\n| Q4 | ${n * 4} |\n`;
const DOC = `Intro paragraph.\r\n\n\`\`\`ts\nif (x) {\n\treturn 1;\n}\n\`\`\`\n\n${TABLE(10)}\nBetween the tables.\n\n${TABLE(7)}\nClosing words that keep going for a while.\n`;

afterEach(() => {
	setTableCharts("off");
	vi.restoreAllMocks();
});

describe("splitTableCharts while streaming", () => {
	it("splits every growing prefix exactly as lexing it whole does", () => {
		setTableCharts("always");
		for (let end = 1; end <= DOC.length; end += 3) {
			const prefix = DOC.slice(0, end);
			const incremental = splitTableCharts(prefix, true);
			// A different reply in between drops the kept prefix: the next call lexes from scratch.
			splitTableCharts("unrelated | text", true);
			const whole = splitTableCharts(prefix, true);
			expect(incremental).toEqual(whole);
			splitTableCharts(prefix, true);
		}
	});

	it("lexes only the text after the last finished table once one has finished", () => {
		setTableCharts("always");
		const lex = vi.spyOn(lexer, "lexMarkdown");
		const settled = DOC.indexOf("Between");
		splitTableCharts(DOC.slice(0, settled + 10), true);
		lex.mockClear();
		splitTableCharts(DOC.slice(0, settled + 16), true);
		const lexedText = lex.mock.calls.map(call => call[0]);
		expect(lexedText).toHaveLength(1);
		expect(lexedText[0]!.trimStart().startsWith("Between")).toBe(true);
		expect(lexedText[0]).not.toContain("Quarter");
	});
});
