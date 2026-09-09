import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { renderWelcomeTip, WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme, setSymbolPreset, setTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("renderWelcomeTip", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("wraps long tips under the label instead of truncating", () => {
		const tip = "Next time you see spaghetti try creating a TTSR rule that prevents this pattern before it spreads";
		const width = 44;
		const lines = renderWelcomeTip(tip, width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.length).toBeGreaterThan(1);
		expect(plain.join(" ")).not.toContain("…");
		expect(plain[0]).toStartWith(" Tip: Next time");
		expect(plain[1]).toStartWith("      ");
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("replaces a trailing [NEW] marker with a rainbow NEW! tag", () => {
		const lines = renderWelcomeTip("Try the shiny advisor [NEW]", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		const styled = lines.join("\n");

		expect(plain).toContain("Try the shiny advisor");
		expect(plain).not.toContain("[NEW]"); // literal marker stripped
		expect(plain).toContain("NEW!"); // replaced by the visible tag
		expect(styled).toContain("\x1b[1m"); // tag is bold
		expect(styled).not.toBe(plain); // tag carries SGR color escapes
	});

	it("keeps the NEW! tag within the box width", () => {
		// A width that leaves the wrapped body ending near the right edge forces
		// the tag onto its own continuation line rather than overflowing.
		for (const width of [24, 40, 60]) {
			const lines = renderWelcomeTip("Turn on the advisor to review every turn [NEW]", width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(lines.map(l => Bun.stripANSI(l)).join("\n")).toContain("NEW!");
		}
	});

	it("shimmers the tag across phases without changing visible text", () => {
		const tip = "Fresh feature here [NEW]";
		const still = renderWelcomeTip(tip, 60, 0);
		const shifted = renderWelcomeTip(tip, 60, 0.5);

		expect(shifted.join("\n")).not.toBe(still.join("\n")); // hues rotate
		expect(shifted.map(l => Bun.stripANSI(l))).toEqual(still.map(l => Bun.stripANSI(l)));
	});

	it("leaves tips without the marker untouched", () => {
		const lines = renderWelcomeTip("Plain old tip", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		expect(plain).not.toContain("NEW!");
		expect(plain).toContain("Tip: Plain old tip");
	});

	it("derives label and body colors from the active theme, with no manual dim layer", async () => {
		// Regression for #3337: hardcoded #b48cff/#9ccfff plus a manual `\x1b[2m`
		// dropped the body to ~1.5:1 contrast on any light-theme background.
		await setTheme("dark");
		const darkLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const darkMutedAnsi = theme.getFgAnsi("muted");
		const dark = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		await setTheme("light");
		const lightLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const lightMutedAnsi = theme.getFgAnsi("muted");
		const light = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		// Each theme paints with its own tokens.
		expect(dark).toContain(darkLabelAnsi);
		expect(dark).toContain(darkMutedAnsi);
		expect(light).toContain(lightLabelAnsi);
		expect(light).toContain(lightMutedAnsi);

		// Switching themes must change the emitted bytes — the previous bug
		// produced byte-identical output for both.
		expect(dark).not.toBe(light);

		// The manual `\x1b[2m` dim is gone; muted/label tokens carry their own
		// theme-tuned luminance.
		expect(dark).not.toContain("\x1b[2m");
		expect(light).not.toContain("\x1b[2m");
	});
	it("drops the nerdfont nag once the preset resolves away from unicode", async () => {
		// Regression: the startup prepaint runs under the default "unicode"
		// preset before settings load; the nag latched there used to survive
		// the switch to the user's configured "nerd" preset.
		const rand = spyOn(Math, "random").mockReturnValue(0.05);
		try {
			const welcome = new WelcomeComponent("1.0.0", "model", "provider");
			expect(welcome.tip).toBe("Please use nerdfont 😭.");
			await setSymbolPreset("nerd");
			expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		} finally {
			rand.mockRestore();
			await setSymbolPreset("unicode");
		}
	});
});
