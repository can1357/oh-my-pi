import { describe, expect, it } from "bun:test";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

function builtinWith(name: "dark" | "light", colors: Partial<ThemeJson["colors"]> = {}) {
	const json = getBuiltinThemes()[name];
	if (!json) throw new Error(`${name} theme unavailable`);
	return createTheme({ ...json, colors: { ...json.colors, ...colors } }, { mode: "truecolor" });
}

describe("PowerShell edition colors", () => {
	it("derive the logo colors readable on the theme's surface when omitted", () => {
		const dark = builtinWith("dark");
		expect(dark.getColorHex("toolPowerShell").toLowerCase()).toBe("#a9c8ff");
		expect(dark.getColorHex("toolWindowsPowerShell").toLowerCase()).toBe("#5391fe");

		const light = builtinWith("light");
		expect(light.getColorHex("toolPowerShell").toLowerCase()).toBe("#2c5591");
		expect(light.getColorHex("toolWindowsPowerShell").toLowerCase()).toBe("#3e6dbf");
	});

	it("keep explicit theme values", () => {
		const t = builtinWith("dark", { toolPowerShell: "#123456", toolWindowsPowerShell: "#654321" });
		expect(t.getColorHex("toolPowerShell")).toBe("#123456");
		expect(t.getColorHex("toolWindowsPowerShell")).toBe("#654321");
	});
});
