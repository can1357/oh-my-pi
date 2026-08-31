import { describe, expect, it } from "bun:test";
import { createTheme, getBuiltinThemes, loadTheme } from "../../../src/modes/theme/loader";
import { getResolvedThemeColors } from "../../../src/modes/theme/theme";

// #1633: an unset `userMessageText` painted user input with the terminal
// default, making user and assistant turns indistinguishable. Unset tokens now
// inherit the theme accent while that stays readable on the bubble background.
describe("userMessageText derived default", () => {
	it("inherits the accent when it contrasts the bubble background", async () => {
		const dark = await loadTheme("dark", { mode: "truecolor" });

		expect(dark.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe(dark.getFgAnsi("accent"));
	});

	it("keeps the terminal default when the accent matches the bubble", async () => {
		// porcelain uses the same color for accent and userMessageBg (contrast 1.0).
		const porcelain = await loadTheme("porcelain", { mode: "truecolor" });

		expect(porcelain.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe("\x1b[38;2;229;229;231m");
	});
	it("keeps the terminal default when the bubble background is also default", () => {
		const darkJson = getBuiltinThemes().dark;
		if (!darkJson) throw new Error("dark theme is unavailable");
		const theme = createTheme(
			{
				...darkJson,
				colors: { ...darkJson.colors, userMessageBg: "", userMessageText: "" },
			},
			{ mode: "truecolor" },
		);

		expect(theme.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe("\x1b[39m");
	});

	it("prefers an explicit token over the derived accent", async () => {
		const birch = await loadTheme("birch", { mode: "truecolor" });

		expect(birch.getFgOnBgAnsi("userMessageText", "userMessageBg")).not.toBe(birch.getFgAnsi("accent"));
		expect(birch.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe("\x1b[38;2;40;40;32m");
	});

	it("feeds the derived accent into HTML export colors", async () => {
		const dark = await getResolvedThemeColors("dark");

		expect(dark.userMessageText).toBe("#febc38");
	});

	it("guards the export derivation against the exported surface, not the bubble", async () => {
		// dark-slate: accent 3.10:1 on userMessageBg but ~2.9:1 on the exported
		// 6%-accent-over-bodyBg surface, so the export keeps the readable fallback
		// while the TUI still derives. porcelain inverts: its accent equals the
		// bubble (TUI keeps the fallback) but clears 3:1 on the light export page.
		const darkSlate = await getResolvedThemeColors("dark-slate");
		const porcelain = await getResolvedThemeColors("porcelain");

		expect(darkSlate.userMessageText).toBe(darkSlate.text);
		expect(porcelain.userMessageText).toBe(porcelain.accent);
	});
});
