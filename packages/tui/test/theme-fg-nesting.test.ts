import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";

describe("Theme.fg over styled text", () => {
	it("keeps its color on the text after a nested color ends", async () => {
		const theme = (await getThemeByName("dark"))!;
		const dim = theme.getFgAnsi("dim");
		const footer = theme.fg("dim", `${theme.fg("success", "+2")} · 3 more lines`);
		const tail = footer.slice(footer.indexOf("+2") + "+2".length);
		// The nested color's reset is followed by the outer color, so the rest stays dim.
		expect(tail.startsWith(`\x1b[39m${dim}`)).toBe(true);
		expect(Bun.stripANSI(footer)).toBe("+2 · 3 more lines");
	});

	it("restores its color after a full reset inside the text", async () => {
		const theme = (await getThemeByName("dark"))!;
		const accent = theme.getFgAnsi("accent");
		const styled = theme.fg("accent", "a\x1b[0mb");
		expect(styled).toBe(`${accent}a\x1b[0m${accent}b\x1b[39m`);
	});
});
