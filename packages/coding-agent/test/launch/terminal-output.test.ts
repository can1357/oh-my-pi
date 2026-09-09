import { describe, expect, it } from "bun:test";
import { renderTerminalOutput } from "../../src/launch/terminal-output";

const RESET = "\x1b[0m";

interface TerminalCase {
	name: string;
	input: string;
	expected: string[];
}

const cases: TerminalCase[] = [
	{
		name: "overwrites the current row after carriage return",
		input: "progress 10%\rDONE",
		expected: [`${RESET}DONEress 10%`],
	},
	{
		name: "honors absolute and relative horizontal cursor movement",
		input: "abcdef\x1b[3GZ\x1b[2CX",
		expected: [`${RESET}abZdeX`],
	},
	{
		name: "honors absolute and relative vertical cursor movement",
		input: "one\r\ntwo\r\nthree\x1b[2A\x1b[1GONE\x1b[1B\x1b[2D]",
		expected: [`${RESET}ONE`, `${RESET}t]o`, `${RESET}three`],
	},
	{
		name: "honors absolute cursor positioning",
		input: "abc\r\ndef\x1b[1;2HZ",
		expected: [`${RESET}aZc`, `${RESET}def`],
	},
	{
		name: "erases from the cursor through the row",
		input: "abcdef\r\x1b[3C\x1b[K",
		expected: [`${RESET}abc`],
	},
	{
		name: "inserts characters without losing shifted content",
		input: "abcdef\r\x1b[3C\x1b[2@XY",
		expected: [`${RESET}abcXYdef`],
	},
	{
		name: "deletes characters and closes the gap",
		input: "abcdef\r\x1b[2C\x1b[2P",
		expected: [`${RESET}abef`],
	},
	{
		name: "inserts a terminal row",
		input: "one\r\ntwo\r\nthree\x1b[2;1H\x1b[Linserted",
		expected: [`${RESET}one`, `${RESET}inserted`, `${RESET}two`, `${RESET}three`],
	},
	{
		name: "deletes a terminal row",
		input: "one\r\ntwo\r\nthree\x1b[2;1H\x1b[M",
		expected: [`${RESET}one`, `${RESET}three`],
	},
	{
		name: "wraps at the fixed 120-column PTY width",
		input: `${"a".repeat(120)}b`,
		expected: [`${RESET}${"a".repeat(120)}`, `${RESET}b`],
	},
	{
		name: "preserves wide and combining characters",
		input: "A界e\u0301B",
		expected: [`${RESET}A界e\u0301B`],
	},
	{
		name: "canonicalizes color, reset, and text decorations",
		input: "\x1b[1;2;3;4;7;9;53;38;2;1;2;3;48;5;17mX\x1b[0mY",
		expected: [`${RESET}\x1b[1;2;3;4;7;9;53;38;2;1;2;3;48;5;17mX${RESET}Y`],
	},
	{
		name: "restores the normal buffer after alternate-buffer output",
		input: "main\x1b[?1049hALT\x1b[?1049l",
		expected: [`${RESET}main`],
	},
	{
		name: "keeps internal blank rows while trimming blank rows and spaces at the end",
		input: "alpha   \r\n\r\nomega   \r\n\r\n",
		expected: [`${RESET}alpha`, "", `${RESET}omega`],
	},
];

describe("renderTerminalOutput", () => {
	for (const testCase of cases) {
		it(testCase.name, async () => {
			expect(await renderTerminalOutput(testCase.input, { head: false, maxRows: 100 })).toEqual(testCase.expected);
		});
	}

	it("returns an empty row set for empty output", async () => {
		expect(await renderTerminalOutput("", { head: false, maxRows: 100 })).toEqual([]);
	});

	it("applies head and tail row limits after replaying scrollback", async () => {
		const output = Array.from({ length: 4_200 }, (_, index) => `row-${index}`).join("\r\n");
		expect(await renderTerminalOutput(output, { head: true, maxRows: 2 })).toEqual([
			`${RESET}row-64`,
			`${RESET}row-65`,
		]);
		expect(await renderTerminalOutput(output, { head: false, maxRows: 2 })).toEqual([
			`${RESET}row-4198`,
			`${RESET}row-4199`,
		]);
	});
});
