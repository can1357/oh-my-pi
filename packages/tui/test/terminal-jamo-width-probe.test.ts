import { describe, expect, it } from "bun:test";
import { detectTerminalId, getTerminalInfo } from "@oh-my-pi/pi-tui/terminal-capabilities";

function jamoWidthFor(env: NodeJS.ProcessEnv): "platform" | "unicode" | 1 | 2 {
	return getTerminalInfo(detectTerminalId(env)).hangulJamoWidth;
}

describe("Hangul Compatibility Jamo width terminal capability", () => {
	it("prevents Korean IME cursor drift by matching terminal-specific Hangul Compatibility Jamo widths", () => {
		// Ghostty and Orca follow UAX#11 and render Hangul Compatibility Jamo at
		// 2 cells; Warp renders them at 1 cell. Every other terminal keeps the
		// platform default (macOS narrow, otherwise UAX#11).
		expect(jamoWidthFor({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app" })).toBe(2);
		expect(jamoWidthFor({ TERM_PROGRAM: "ghostty" })).toBe(2);
		// Ghostty identified only via TERM (env-filtered shells that drop
		// GHOSTTY_RESOURCES_DIR / TERM_PROGRAM) must still resolve wide — mirrors
		// the Ghostty detection in terminal-capabilities.ts.
		expect(jamoWidthFor({ TERM: "xterm-ghostty" })).toBe(2);
		expect(jamoWidthFor({ TERM_PROGRAM: "WarpTerminal" })).toBe(1);
		expect(jamoWidthFor({ TERM_PROGRAM: "Orca", TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe(2);
		expect(jamoWidthFor({ TERM_PROGRAM: "iTerm.app" })).toBe("platform");
		expect(jamoWidthFor({ TERM_PROGRAM: "Apple_Terminal" })).toBe("platform");
		expect(jamoWidthFor({})).toBe("platform");
	});
});
