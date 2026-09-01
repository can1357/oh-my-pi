import { describe, expect, it } from "bun:test";
import { colorToAnsi, detectColorMode } from "../src/modes/theme/color";

describe("theme color mode", () => {
	it("emits 256-color SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});
});
