/**
 * `stripTerminalSequences` is ported verbatim from pi-mono's TUI utils so pi
 * extensions importing it through the legacy-pi compat rewrite observe
 * identical behavior. These tests pin the escape-sequence grammar it shares
 * with its private `extractAnsiCode` helper: CSI (restricted final bytes),
 * OSC and APC with BEL or ST terminators.
 */
import { describe, expect, it } from "bun:test";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("stripTerminalSequences", () => {
	it("passes plain text through unchanged", () => {
		expect(stripTerminalSequences("plain text 123")).toBe("plain text 123");
	});

	it("strips CSI styling sequences", () => {
		expect(stripTerminalSequences(`${ESC}[31mred${ESC}[0m`)).toBe("red");
	});

	it("strips OSC 8 hyperlinks terminated by BEL", () => {
		const link = `${ESC}]8;;https://example.com${BEL}click${ESC}]8;;${BEL}`;
		expect(stripTerminalSequences(link)).toBe("click");
	});

	it("strips OSC 8 hyperlinks terminated by ST", () => {
		const link = `${ESC}]8;;https://example.com${ST}click${ESC}]8;;${ST}`;
		expect(stripTerminalSequences(link)).toBe("click");
	});

	it("strips APC sequences such as the pi cursor marker", () => {
		expect(stripTerminalSequences(`${ESC}_pi:c${BEL}`)).toBe("");
		expect(stripTerminalSequences(`before${ESC}_pi:c${BEL}after`)).toBe("beforeafter");
	});

	it("strips mixed sequences while preserving visible text", () => {
		const input = `${ESC}[1mbold ${ESC}]8;;https://pi.dev${BEL}link${ESC}]8;;${BEL}${ESC}[0m ${ESC}_pi:c${BEL}plain`;
		expect(stripTerminalSequences(input)).toBe("bold link plain");
	});
});
