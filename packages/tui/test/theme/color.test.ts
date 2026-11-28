import { describe, expect, it } from "bun:test";
import { bgSgr, builtinThemes, createTheme, depthOf, fgSgr } from "@oh-my-pi/pi-tui/theme/index";

describe("color depth", () => {
	it("follows the driver's capabilities", () => {
		expect(depthOf({ truecolor: true, colors: 16_777_216 })).toBe("truecolor");
		expect(depthOf({ truecolor: false, colors: 256 })).toBe("256");
		expect(depthOf({ truecolor: false, colors: 16 })).toBe("16");
	});

	it("emits 24-bit, 256-palette or 16-color SGR for hex colors", () => {
		expect(fgSgr("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
		expect(fgSgr("#f5e0ac", "256")).toBe("\x1b[38;5;223m");
		expect(fgSgr("#ff0000", "16")).toBe("\x1b[91m");
		expect(fgSgr("#000000", "16")).toBe("\x1b[30m");
		expect(fgSgr("#0000ee", "16")).toBe("\x1b[34m");
		// Hue family and brightness win over RGB distance: a light green stays green, an orange yellow.
		expect(fgSgr("#89d281", "16")).toBe("\x1b[92m");
		expect(fgSgr("#febc38", "16")).toBe("\x1b[93m");
		expect(fgSgr("#777d88", "16")).toBe("\x1b[90m");
		// Repeated conversions at different depths stay separate.
		expect(fgSgr("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
	});

	it("keeps palette indices at 256 colors and maps them onto the 16 colors below that", () => {
		expect(fgSgr(244, "truecolor")).toBe("\x1b[38;5;244m");
		expect(fgSgr(244, "256")).toBe("\x1b[38;5;244m");
		expect(fgSgr(9, "16")).toBe("\x1b[91m");
		expect(fgSgr(1, "16")).toBe("\x1b[31m");
		expect(fgSgr(196, "16")).toBe("\x1b[91m");
	});

	it("uses the terminal default for empty colors", () => {
		expect(fgSgr("", "truecolor")).toBe("\x1b[39m");
		expect(bgSgr("", "16")).toBe("\x1b[49m");
	});

	it("emits background SGR at every depth", () => {
		expect(bgSgr("#1f2335", "truecolor")).toBe("\x1b[48;2;31;35;53m");
		expect(bgSgr("#f5e0ac", "256")).toBe("\x1b[48;5;223m");
		expect(bgSgr(236, "256")).toBe("\x1b[48;5;236m");
		expect(bgSgr("#ff0000", "16")).toBe("\x1b[101m");
		expect(bgSgr(4, "16")).toBe("\x1b[44m");
	});

	it("resolves a whole theme at the requested depth", () => {
		const builtin = builtinThemes().dark!;
		const dark = { ...builtin, colors: { ...builtin.colors, muted: "#777d88" } };
		expect(createTheme(dark, { depth: "truecolor" }).fg("muted", "x")).toBe("\x1b[38;2;119;125;136mx\x1b[39m");
		expect(createTheme(dark, { depth: "256" }).fg("muted", "x")).toBe("\x1b[38;5;244mx\x1b[39m");
		expect(createTheme(dark, { depth: "16" }).fg("muted", "x")).toMatch(/^\x1b\[(?:3[0-7]|9[0-7])mx\x1b\[39m$/);
	});
});
