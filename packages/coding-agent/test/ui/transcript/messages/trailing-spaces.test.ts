import { describe, expect, test } from "bun:test";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { fillRow, paddedText } from "../../../../src/ui/styles/messages/fill";
import { tintRow } from "../../../../src/ui/styles/tools/default";

const theme = loadThemeSync("dark");

describe("message and tool row trailing-space handling", () => {
	test("paddedText indents default-background lines without right-padding to terminal width", () => {
		const rows = paddedText("Notice: short line", 80);
		expect(rows).toHaveLength(1);
		expect(stripEscapes(rows[0]!)).toBe(" Notice: short line");
		expect(rows[0]!.endsWith(" ")).toBe(false);
		expect(visibleWidth(rows[0]!)).toBeLessThan(80);
	});

	test("fillRow still pads background-filled rows to full width", () => {
		const row = fillRow(theme, "userMessageBg", " hello", 40);
		expect(visibleWidth(row)).toBe(40);
		expect(row).toContain("\x1b[49m");
	});

	test("tintRow omits trailing spaces when untinted and preserves full width when tinted", () => {
		const untinted = tintRow(theme, undefined, " info line", 40);
		expect(stripEscapes(untinted)).toBe(" info line");
		expect(untinted.endsWith(" ")).toBe(false);
		expect(visibleWidth(untinted)).toBeLessThan(40);

		const tinted = tintRow(theme, "toolSuccessBg", " ok line", 40);
		expect(visibleWidth(tinted)).toBe(40);
	});
});
