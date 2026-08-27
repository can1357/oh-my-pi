import { describe, expect, it } from "bun:test";
import type { ThemeJson } from "../../../src/modes/theme/schema";
import { createTheme } from "../../../src/modes/theme/loader";

const BASE: ThemeJson = { colors: {} } as unknown as ThemeJson;

describe("createTheme final-answer token fallbacks", () => {
	it("falls back to userMessageBg/text when the tokens are absent", () => {
		const theme = createTheme({ ...BASE, colors: { userMessageBg: "#101010", text: "#c0c0c0" } } as ThemeJson, {
			mode: "truecolor",
		});
		expect(theme.getBgAnsi("finalAnswerBg")).toBe(theme.getBgAnsi("userMessageBg"));
		expect(theme.fg("finalAnswerText", "x")).toBe(theme.fg("text", "x"));
	});

	it("keeps a theme-defined finalAnswerBg/Text even when falsy (review #3750148470)", () => {
		// `0` is 256-color black and `""` is the terminal default; both are
		// valid schema values (color.ts resolves "" to the reset escape and
		// numbers to 256-color escapes), so the fallback must not overwrite
		// them — only an absent key falls back.
		const theme = createTheme({ ...BASE, colors: { finalAnswerBg: 0, finalAnswerText: "" } } as ThemeJson, {
			mode: "truecolor",
		});
		expect(theme.getBgAnsi("finalAnswerBg")).toBe("\x1b[48;5;0m");
		expect(theme.fg("finalAnswerText", "x")).toBe("\x1b[39mx\x1b[39m");
	});

	it("resolves the literal defaults when the theme defines nothing at all", () => {
		const theme = createTheme(BASE, { mode: "truecolor" });
		expect(typeof theme.getBgAnsi("finalAnswerBg")).toBe("string");
		expect(theme.fg("finalAnswerText", "x")).toContain("x");
	});
});
