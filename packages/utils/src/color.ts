/**
 * Color manipulation utilities for hex colors.
 *
 * @example
 * ```ts
 * import { hexToHsv, hsvToHex } from "@oh-my-pi/pi-utils";
 *
 * // Rotate the hue by 90°
 * const hsv = hexToHsv("#4ade80");
 * hsv.h = (hsv.h + 90) % 360;
 * const newHex = hsvToHex(hsv);
 * ```
 */

export interface HSV {
	/** Hue in degrees (0-360) */
	h: number;
	/** Saturation (0-1) */
	s: number;
	/** Value/brightness (0-1) */
	v: number;
}

export interface RGB {
	/** Red (0-255) */
	r: number;
	/** Green (0-255) */
	g: number;
	/** Blue (0-255) */
	b: number;
}

/**
 * Parse a hex color string to RGB.
 * Supports #RGB, #RRGGBB formats.
 */
export function hexToRgb(hex: string): RGB {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	if (h.length === 3) {
		return {
			r: parseInt(h[0] + h[0], 16),
			g: parseInt(h[1] + h[1], 16),
			b: parseInt(h[2] + h[2], 16),
		};
	}
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

/**
 * Convert RGB to hex color string.
 */
export function rgbToHex(rgb: RGB): string {
	const toHex = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * Convert RGB to HSV.
 */
export function rgbToHsv(rgb: RGB): HSV {
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;

	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
		else if (max === g) h = ((b - r) / d + 2) / 6;
		else h = ((r - g) / d + 4) / 6;
	}

	return {
		h: h * 360,
		s: max === 0 ? 0 : d / max,
		v: max,
	};
}

/**
 * Convert HSV to RGB.
 */
export function hsvToRgb(hsv: HSV): RGB {
	const { s, v } = hsv;
	const h = ((hsv.h % 360) + 360) % 360; // Normalize to 0-360

	const i = Math.floor(h / 60);
	const f = h / 60 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);

	let r: number, g: number, b: number;
	switch (i % 6) {
		case 0:
			r = v;
			g = t;
			b = p;
			break;
		case 1:
			r = q;
			g = v;
			b = p;
			break;
		case 2:
			r = p;
			g = v;
			b = t;
			break;
		case 3:
			r = p;
			g = q;
			b = v;
			break;
		case 4:
			r = t;
			g = p;
			b = v;
			break;
		default:
			r = v;
			g = p;
			b = q;
			break;
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
	};
}

/**
 * Convert hex color to HSV.
 */
export function hexToHsv(hex: string): HSV {
	return rgbToHsv(hexToRgb(hex));
}

/**
 * Convert HSV to hex color.
 */
export function hsvToHex(hsv: HSV): string {
	return rgbToHex(hsvToRgb(hsv));
}

/**
 * Shift the hue of a hex color by a given number of degrees.
 */
export function shiftHue(hex: string, degrees: number): string {
	const hsv = hexToHsv(hex);
	hsv.h = (hsv.h + degrees) % 360;
	if (hsv.h < 0) hsv.h += 360;
	return hsvToHex(hsv);
}
export interface HSVAdjustment {
	/** Hue shift in degrees (additive) */
	h?: number;
	/** Saturation multiplier */
	s?: number;
	/** Value/brightness multiplier */
	v?: number;
}

/**
 * Adjust HSV components of a hex color.
 *
 * @param hex - Hex color string (#RGB or #RRGGBB)
 * @param adj - Adjustments: h is additive degrees, s and v are multipliers
 * @returns New hex color string
 *
 * @example
 * ```ts
 * // Shift hue +60°, reduce saturation to 71%
 * adjustHsv("#00ff88", { h: 60, s: 0.71 }) // "#4a9eff"
 * ```
 */
export function adjustHsv(hex: string, adj: HSVAdjustment): string {
	const hsv = hexToHsv(hex);
	if (adj.h !== undefined) {
		hsv.h = (hsv.h + adj.h) % 360;
		if (hsv.h < 0) hsv.h += 360;
	}
	if (adj.s !== undefined) {
		hsv.s = Math.max(0, Math.min(1, hsv.s * adj.s));
	}
	if (adj.v !== undefined) {
		hsv.v = Math.max(0, Math.min(1, hsv.v * adj.v));
	}
	return hsvToHex(hsv);
}

/**
 * Convert HSL (h: 0-360, s: 0-1, l: 0-1) to a CSS hex string.
 */
export function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

// Conventional xterm RGB for the 16 base ANSI colors. Terminals may remap these,
// so they're a best-effort approximation for light/dark classification.
const ANSI_16: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/** Parse a 256-color palette index (0–255) to RGB (0..255). */
function paletteToRgb(index: number): RGB | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const rgb = ANSI_16[index];
		return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : undefined;
	}
	if (index < 232) {
		const n = index - 16;
		return {
			r: CUBE_STEPS[Math.floor(n / 36) % 6] ?? 0,
			g: CUBE_STEPS[Math.floor(n / 6) % 6] ?? 0,
			b: CUBE_STEPS[n % 6] ?? 0,
		};
	}
	const gray = 8 + (index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

/** Parse a theme color value — `#rgb`/`#rrggbb` hex or 256-color palette index — to RGB (0..255). */
function toRgb(value: string | number): RGB | undefined {
	if (typeof value === "number") return paletteToRgb(value);
	if (typeof value !== "string" || value[0] !== "#") return undefined;
	if (value.length !== 4 && value.length !== 7) return undefined;
	const rgb = hexToRgb(value);
	if (Number.isNaN(rgb.r) || Number.isNaN(rgb.g) || Number.isNaN(rgb.b)) return undefined;
	return rgb;
}

/** Gamma-decode a single 0..255 sRGB channel to linear 0..1. */
function linearizeChannel(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Gamma-encode a linear 0..1 channel back to 0..255 sRGB. */
function delinearizeChannel(linear: number): number {
	const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
	return c * 255;
}

export interface OKLCH {
	/** Perceptual lightness (0-1) */
	l: number;
	/** Chroma (0 = gray; sRGB peaks around 0.37) */
	c: number;
	/** Hue in degrees (0-360) */
	h: number;
}

/** Convert linear sRGB (0..1 channels) to OKLab (Björn Ottosson's reference matrices). */
function linearRgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return {
		L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

/** Convert OKLab back to linear sRGB; channels may fall outside 0..1 when out of gamut. */
function oklabToLinearRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return {
		r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	};
}

/**
 * Convert a hex color to OKLCH (perceptual lightness/chroma/hue).
 *
 * Unlike HSL, equal `l`/`c` values look equally bright and colorful across
 * hues, so carrying them between colors preserves the palette's "weight".
 */
export function hexToOklch(hex: string): OKLCH {
	const rgb = hexToRgb(hex);
	const lab = linearRgbToOklab(linearizeChannel(rgb.r), linearizeChannel(rgb.g), linearizeChannel(rgb.b));
	const c = Math.hypot(lab.a, lab.b);
	let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
	if (h < 0) h += 360;
	return { l: lab.L, c, h };
}

/**
 * Max OKLab saturation (C/L) that stays inside sRGB for the hue direction
 * `(a, b)`, via Björn Ottosson's polynomial fit plus one Halley refinement.
 */
function computeMaxSaturation(a: number, b: number): number {
	// Select the channel that clips first for this hue direction.
	let k0: number, k1: number, k2: number, k3: number, k4: number;
	let wl: number, wm: number, ws: number;
	if (-1.88170328 * a - 0.80936493 * b > 1) {
		// red channel
		k0 = 1.19086277;
		k1 = 1.76576728;
		k2 = 0.59662641;
		k3 = 0.75515197;
		k4 = 0.56771245;
		wl = 4.0767416621;
		wm = -3.3077115913;
		ws = 0.2309699292;
	} else if (1.81444104 * a - 1.19445276 * b > 1) {
		// green channel
		k0 = 0.73956515;
		k1 = -0.45954404;
		k2 = 0.08285427;
		k3 = 0.1254107;
		k4 = 0.14503204;
		wl = -1.2684380046;
		wm = 2.6097574011;
		ws = -0.3413193965;
	} else {
		// blue channel
		k0 = 1.35733652;
		k1 = -0.00915799;
		k2 = -1.1513021;
		k3 = -0.50559606;
		k4 = 0.00692167;
		wl = -0.0041960863;
		wm = -0.7034186147;
		ws = 1.707614701;
	}
	const S = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

	// One Halley step against f = (channel at S) - 0: polishes the fit to
	// well below hex quantization error.
	const kl = 0.3963377774 * a + 0.2158037573 * b;
	const km = -0.1055613458 * a - 0.0638541728 * b;
	const ks = -0.0894841775 * a - 1.291485548 * b;
	const l_ = 1 + S * kl;
	const m_ = 1 + S * km;
	const s_ = 1 + S * ks;
	const f = wl * l_ ** 3 + wm * m_ ** 3 + ws * s_ ** 3;
	const f1 = wl * 3 * kl * l_ * l_ + wm * 3 * km * m_ * m_ + ws * 3 * ks * s_ * s_;
	const f2 = wl * 6 * kl * kl * l_ + wm * 6 * km * km * m_ + ws * 6 * ks * ks * s_;
	return S - (f * f1) / (f1 * f1 - 0.5 * f * f2);
}

/**
 * The sRGB gamut cusp for an OKLCH hue: the lightness/chroma point where the
 * hue reaches its maximum chroma inside sRGB.
 *
 * The cusp lightness varies wildly per hue (yellow ≈ 0.97, blue ≈ 0.45), so
 * transferring absolute OKLCH lightness/chroma between hues distorts
 * vividness; normalize against the cusp instead. See `getSessionAccentHex`.
 */
export function oklchCusp(h: number): { l: number; c: number } {
	const hRad = (h * Math.PI) / 180;
	const a = Math.cos(hRad);
	const b = Math.sin(hRad);
	const sCusp = computeMaxSaturation(a, b);
	const rgb = oklabToLinearRgb(1, sCusp * a, sCusp * b);
	const lCusp = Math.cbrt(1 / Math.max(rgb.r, rgb.g, rgb.b));
	return { l: lCusp, c: lCusp * sCusp };
}

/** Slack allowed on linear channels before a color counts as out of sRGB gamut. */
const GAMUT_EPSILON = 1e-4;

/** True when all linear channels sit inside sRGB (within {@link GAMUT_EPSILON}). */
function inSrgbGamut(rgb: { r: number; g: number; b: number }): boolean {
	return (
		rgb.r >= -GAMUT_EPSILON &&
		rgb.r <= 1 + GAMUT_EPSILON &&
		rgb.g >= -GAMUT_EPSILON &&
		rgb.g <= 1 + GAMUT_EPSILON &&
		rgb.b >= -GAMUT_EPSILON &&
		rgb.b <= 1 + GAMUT_EPSILON
	);
}

/**
 * Convert OKLCH to a CSS hex string, gamut-mapping by chroma reduction.
 *
 * Out-of-gamut inputs keep their lightness and hue while chroma is bisected
 * down until the color fits sRGB, matching CSS Color 4's recommended intent.
 */
export function oklchToHex(oklch: OKLCH): string {
	const l = Math.max(0, Math.min(1, oklch.l));
	const hRad = (oklch.h * Math.PI) / 180;
	const cos = Math.cos(hRad);
	const sin = Math.sin(hRad);
	const at = (c: number) => oklabToLinearRgb(l, c * cos, c * sin);

	let rgb = at(oklch.c);
	if (!inSrgbGamut(rgb)) {
		// `lo` always fits (chroma 0 is the gray axis), `hi` never does.
		let lo = 0;
		let hi = oklch.c;
		for (let i = 0; i < 20; i++) {
			const mid = (lo + hi) / 2;
			if (inSrgbGamut(at(mid))) lo = mid;
			else hi = mid;
		}
		rgb = at(lo);
	}
	return rgbToHex({
		r: Math.max(0, Math.min(255, delinearizeChannel(rgb.r))),
		g: Math.max(0, Math.min(255, delinearizeChannel(rgb.g))),
		b: Math.max(0, Math.min(255, delinearizeChannel(rgb.b))),
	});
}

/**
 * Perceptual luma (gamma-encoded BT.709 weights over raw sRGB), normalized to 0..1.
 *
 * Accepts a hex string (`#rgb` / `#rrggbb`) or a 256-color palette index; returns
 * `undefined` for var refs, empty strings, or anything unparseable.
 *
 * Cheap and good enough for a light/dark *classification* threshold. NOT suitable
 * for contrast ratios — use {@link relativeLuminance} for those.
 */
export function colorLuma(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/**
 * WCAG 2.x relative luminance (BT.709 weights over linearized sRGB), normalized to
 * 0..1. This is the value the WCAG contrast-ratio formula expects.
 *
 * Accepts a hex string (`#rgb` / `#rrggbb`) or a 256-color palette index; returns
 * `undefined` for var refs, empty strings, or anything unparseable.
 */
export function relativeLuminance(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return 0.2126 * linearizeChannel(rgb.r) + 0.7152 * linearizeChannel(rgb.g) + 0.0722 * linearizeChannel(rgb.b);
}
