import { describe, expect, it } from "bun:test";
import { hyperlink } from "@oh-my-pi/pi-tui/text/osc";
import { styledSpans, unstyledText } from "@oh-my-pi/pi-tui/text/styled-spans";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bold } from "@oh-my-pi/pi-tui/theme/theme";

describe("styled text as spans", () => {
	it("names the theme color an escape came from and keeps plain runs unstyled", () => {
		const theme = currentTheme();
		expect(styledSpans(`Manage hosts.\n\n${theme.fg("accent", "Commands:")}\n  /ssh list`)).toEqual([
			{ t: "Manage hosts.\n\n" },
			{ t: "Commands:", s: "accent" },
			{ t: "\n  /ssh list" },
		]);
	});

	it("combines a color with attributes and merges neighbours of one style", () => {
		const theme = currentTheme();
		const styled = `${theme.fg("dim", "Use")}${theme.fg("dim", " now")} ${bold(theme.fg("error", "stop"))} \x1b[3;9mgone\x1b[0m`;
		expect(styledSpans(styled)).toEqual([
			{ t: "Use now", s: "dim" },
			{ t: " " },
			{ t: "stop", s: "error strong" },
			{ t: " " },
			{ t: "gone", s: "em del" },
		]);
	});

	it("maps basic 16-color foregrounds to semantic tokens and drops colors no theme key has", () => {
		expect(styledSpans("\x1b[31mbad\x1b[39m \x1b[38;2;1;2;3modd\x1b[39m \x1b[7mpick\x1b[27m")).toEqual([
			{ t: "bad", s: "error" },
			{ t: " odd " },
			{ t: "pick", s: "mark" },
		]);
	});

	it("turns a hyperlink into href and drops every other escape, control character and tab", () => {
		expect(styledSpans(`see ${hyperlink("docs", "https://example.com/a")}\x1b[2K\x07 a\tb`)).toEqual([
			{ t: "see " },
			{ t: "docs", href: "https://example.com/a" },
			{ t: " a   b" },
		]);
	});

	it("gives the visible characters alone as plain text", () => {
		const theme = currentTheme();
		expect(unstyledText(`${theme.fg("dim", "Use")} ${bold("/changelog full")}\x1b]0;title\x07`)).toBe(
			"Use /changelog full",
		);
	});
});
