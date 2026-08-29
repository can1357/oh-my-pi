import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

import { getSessionAccentHex, type SessionAccentTheme } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { hexToOklch, oklchCusp, relativeLuminance } from "@oh-my-pi/pi-utils";

const lum = (hex: string): number => relativeLuminance(hex) ?? 0;
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const saturatedThemeHues = (colors: string[]): number[] => {
	const hues: number[] = [];
	for (const color of colors) {
		const { c, h } = hexToOklch(color);
		if (c >= 0.03) hues.push(h);
	}
	return hues;
};

/** Reference vivid accents: dark-one's `hue62` and a light-theme indigo. */
const DARK_ACCENT = "#e5c07b";
const LIGHT_ACCENT = "#7287fd";

const onDark = (accentHex: string = DARK_ACCENT, colorHexes: string[] = []): SessionAccentTheme => ({
	accentHex,
	colorHexes,
});
const onLight = (surfaceLuminance: number, accentHex: string = LIGHT_ACCENT): SessionAccentTheme => ({
	accentHex,
	colorHexes: [],
	surfaceLuminance,
});

const names = Array.from({ length: 600 }, (_, i) => `analyze-debian-trixie-${i}`);

const SURFACES: Record<string, number> = {
	"light-catppuccin crust (#dce0e8)": lum("#dce0e8"),
	"light-poimandres (#7390aa)": lum("#7390aa"),
};

/** 8-bit hex quantization can nudge OKLCH hue by a degree or two. */
const HUE_TOLERANCE = 2;

describe("getSessionAccentHex", () => {
	it("is deterministic per name and parameters", () => {
		expect(getSessionAccentHex("analyze debian trixie", onDark())).toBe(
			getSessionAccentHex("analyze debian trixie", onDark()),
		);
		expect(getSessionAccentHex("x", onLight(0.7))).toBe(getSessionAccentHex("x", onLight(0.7)));
	});

	it("uses full-wheel hues with a reachable vividness peak on dark themes", () => {
		// A hue whose gamut cusp needs more lightness than the dark cap (0.88)
		// can only render as a darkened version of itself; the arc must skip those.
		for (const name of names) {
			const h = hexToOklch(getSessionAccentHex(name, onDark())).h;
			expect(oklchCusp(h).l).toBeLessThanOrEqual(0.88 + 0.01);
		}
	});

	it("does not collapse into the warm band on dark themes", () => {
		// Regression: a warm-dominated arc (25-93 plus a green sliver) made
		// ~80% of session accents render as orange. Cool hues must carry a
		// substantial share of names.
		const warm = names.filter(name => {
			const h = hexToOklch(getSessionAccentHex(name, onDark())).h;
			return h < 94 || h > 350;
		}).length;
		expect(warm / names.length).toBeLessThan(0.5);
	});

	it("uses cool OKLCH hues (195-330) on light themes", () => {
		for (const name of names) {
			const h = hexToOklch(getSessionAccentHex(name, onLight(0.5))).h;
			expect(h).toBeGreaterThanOrEqual(195 - HUE_TOLERANCE);
			expect(h).toBeLessThanOrEqual(330 + HUE_TOLERANCE);
		}
	});

	it("never lands in the yellow/chartreuse core on dark themes", () => {
		// Regression: hue-uniform sampling over 25-145 produced mustard
		// (#ab9700) and yellow (#dfe049) accents. Yellow is the one hue that
		// shifts category when rendered below its cusp, so h≈94-138 must be
		// excluded regardless of the theme accent.
		for (const accent of [DARK_ACCENT, "#ed4abf", "#7aa2f7"]) {
			for (const name of names) {
				const h = hexToOklch(getSessionAccentHex(name, onDark(accent))).h;
				expect(h < 94 + HUE_TOLERANCE || h > 138 - HUE_TOLERANCE).toBe(true);
			}
		}
	});

	it("derives softer accents from pastel themes than from vivid ones", () => {
		// The carried weight is the accent's chroma *fraction* of its hue's
		// gamut cusp, so a pastel accent must never out-saturate a vivid one.
		for (const name of names.slice(0, 50)) {
			const vivid = hexToOklch(getSessionAccentHex(name, onDark("#ed4abf"))).c;
			const pastel = hexToOklch(getSessionAccentHex(name, onDark("#bb9af7"))).c;
			expect(pastel).toBeLessThanOrEqual(vivid + 0.01);
			expect(pastel).toBeGreaterThanOrEqual(0.04);
		}
	});

	it("keeps a readable chroma floor when the theme accent is near-gray", () => {
		for (const name of names.slice(0, 50)) {
			const { c } = hexToOklch(getSessionAccentHex(name, onDark("#8a8a8e")));
			expect(c).toBeGreaterThanOrEqual(0.04);
		}
	});

	it("raises very dark theme accents to a visible lightness on dark themes", () => {
		for (const name of names.slice(0, 50)) {
			const { l } = hexToOklch(getSessionAccentHex(name, onDark("#5a3d1e")));
			expect(l).toBeGreaterThanOrEqual(0.63);
		}
	});

	it("keeps vivid (bright) accents on dark themes (undefined surface)", () => {
		const maxDark = Math.max(...names.map(n => lum(getSessionAccentHex(n, onDark()))));
		expect(maxDark).toBeGreaterThan(0.5);
	});

	it("clears AA-large WCAG contrast against light surfaces, including mid-light", () => {
		for (const surface in SURFACES) {
			const bg = SURFACES[surface];
			for (const name of names) {
				const hex = getSessionAccentHex(name, onLight(bg));
				expect(contrast(lum(hex), bg)).toBeGreaterThanOrEqual(2.99);
			}
		}
	});

	it("never produces a lighter accent on light themes than on dark for the same accent and name", () => {
		const nearWhite = SURFACES["light-catppuccin crust (#dce0e8)"];
		for (const name of names) {
			expect(lum(getSessionAccentHex(name, onLight(nearWhite, DARK_ACCENT)))).toBeLessThanOrEqual(
				lum(getSessionAccentHex(name, onDark())) + 1e-9,
			);
		}
	});
});

describe("getSessionAccentHex with real Theme", () => {
	it("stays in the cool band and avoids theme hues on light-catppuccin", async () => {
		const theme = await getThemeByName("light-catppuccin");
		if (!theme) return; // skip if theme not found
		const inputs = theme.sessionAccentInputs;
		const themeHues = saturatedThemeHues(inputs.colorHexes);

		for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
			const h = hexToOklch(getSessionAccentHex(name, inputs)).h;
			expect(h).toBeGreaterThanOrEqual(195 - HUE_TOLERANCE);
			expect(h).toBeLessThanOrEqual(330 + HUE_TOLERANCE);
			for (const th of themeHues) {
				const dist = Math.min(Math.abs(h - th), 360 - Math.abs(h - th));
				expect(dist).toBeGreaterThanOrEqual(10 - HUE_TOLERANCE);
			}
		}
	});

	it("stays in the admissible arc and avoids theme hues on dark-catppuccin", async () => {
		const theme = await getThemeByName("dark-catppuccin");
		if (!theme) return;
		const inputs = theme.sessionAccentInputs;
		const themeHues = saturatedThemeHues(inputs.colorHexes);

		for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
			const h = hexToOklch(getSessionAccentHex(name, inputs)).h;
			expect(oklchCusp(h).l).toBeLessThanOrEqual(0.88 + 0.01);
			for (const th of themeHues) {
				const dist = Math.min(Math.abs(h - th), 360 - Math.abs(h - th));
				expect(dist).toBeGreaterThanOrEqual(10 - HUE_TOLERANCE);
			}
		}
	});
});
