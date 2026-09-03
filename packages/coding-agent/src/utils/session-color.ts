import { hexToOklch, oklchCusp, oklchToHex, relativeLuminance } from "@oh-my-pi/pi-utils";

/**
 * Derive a stable 32-bit hash from a string using djb2.
 */
function nameToHash(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
		hash = hash >>> 0; // keep 32-bit unsigned
	}
	return hash;
}

/**
 * Fallback cusp-chroma fraction when the theme accent is unparseable or
 * near-gray: sits at each hue's gamut cusp at 70% of its peak chroma,
 * matching a typical vivid accent.
 */
const FALLBACK_CUSP_CHROMA_FRACTION = 0.7;

/**
 * Chroma bounds for the carried theme-accent chroma: the floor keeps the
 * hash-derived hue readable when the theme accent is near-gray, the ceiling
 * tempers neon accents so six sessions don't turn the status line into a
 * highlighter set.
 */
const MIN_CHROMA = 0.05;
const MAX_CHROMA = 0.21;

/** Lightness bounds on dark themes so a carried accent lightness stays visible on dark surfaces. */
const DARK_MIN_LIGHTNESS = 0.65;
const DARK_MAX_LIGHTNESS = 0.88;

/** Minimum contrast ratio (WCAG AA large text) between a light-theme accent and its surface. */
const ACCENT_MIN_CONTRAST = 3;

/**
 * Largest relative luminance an accent may have while still meeting
 * {@link ACCENT_MIN_CONTRAST} against a surface of the given luminance.
 */
function accentLuminanceCap(surfaceLuminance: number): number {
	return Math.max(0, (surfaceLuminance + 0.05) / ACCENT_MIN_CONTRAST - 0.05);
}

/** Minimum angular distance in hue degrees from any theme color to avoid visual collision. */
const MIN_HUE_DISTANCE = 10;
/** OKLCH chroma threshold below which hue is meaningless (near-gray). */
const MIN_CHROMA_FOR_HUE = 0.03;

/** Angular distance between two hue values (0-360). */
function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b);
	return Math.min(d, 360 - d);
}

/**
 * Parse OKLCH hue (0-360) from a hex color string.
 * Returns undefined for near-gray colors where hue is not meaningful.
 */
function hexToHue(hex: string): number | undefined {
	const { c, h } = hexToOklch(hex);
	if (!Number.isFinite(h) || c < MIN_CHROMA_FOR_HUE) return undefined;
	return h;
}

/**
 * Find a hue at least {@link MIN_HUE_DISTANCE} from all occupied hues,
 * walked outward in arc positions so it never leaves the admissible arc.
 * Returns the hue at `pos` unchanged if no safe hue exists within the arc.
 */
function findSafeHue(pos: number, occupied: number[], intervals: readonly HueInterval[]): number {
	const total = arcLength(intervals);
	const hueAt = (p: number) => arcToHue(intervals, Math.max(0, Math.min(total - 1, p)));
	const target = hueAt(pos);
	if (occupied.length === 0) return target;
	if (occupied.every(h => hueDistance(target, h) >= MIN_HUE_DISTANCE)) {
		return target;
	}
	for (let d = 1; d < total; d++) {
		for (const dir of [1, -1]) {
			const candidate = hueAt(pos + d * dir);
			if (occupied.every(h => hueDistance(candidate, h) >= MIN_HUE_DISTANCE)) {
				return candidate;
			}
		}
	}
	// fallback: keep the original target if no safe spot exists within the arc
	return target;
}

/** Inclusive hue interval [start, end] in OKLCH degrees. */
type HueInterval = readonly [number, number];

/** Number of integer hue positions across all intervals. */
function arcLength(intervals: readonly HueInterval[]): number {
	let n = 0;
	for (const [a, b] of intervals) n += b - a + 1;
	return n;
}

/** Map an arc position (`0..arcLength-1`) to its hue degree. */
function arcToHue(intervals: readonly HueInterval[], pos: number): number {
	let p = pos;
	for (const [a, b] of intervals) {
		const n = b - a + 1;
		if (p < n) return a + p;
		p -= n;
	}
	return intervals[intervals.length - 1]?.[1] ?? 0;
}

/**
 * Dark themes draw hues from the full wheel, restricted to hues whose
 * sRGB gamut cusp is reachable under {@link DARK_MAX_LIGHTNESS}. A hue whose
 * vividness peak needs more lightness than the cap can only render as a
 * darkened version of itself, and yellow (cusp L ≈ 0.97) is the one hue
 * that shifts category when darkened — to olive/mustard — so the derivation
 * excludes the yellow/chartreuse core (≈94–138°) and the over-light cyan
 * peak (≈158–200°) for every theme. Collisions with theme-semantic hues are
 * handled per-theme by {@link findSafeHue}, not by narrowing the arc.
 */
const DARK_HUE_INTERVALS: readonly HueInterval[] = (() => {
	const intervals: Array<[number, number]> = [];
	let start = -1;
	for (let h = 0; h <= 360; h++) {
		if (h < 360 && oklchCusp(h).l <= DARK_MAX_LIGHTNESS) {
			if (start < 0) start = h;
		} else if (start >= 0) {
			intervals.push([start, h - 1]);
			start = -1;
		}
	}
	return intervals;
})();

/**
 * Light themes keep a declared cool band (cyan → blue → purple); lightness
 * there is governed by the contrast bisection against the surface, not the
 * dark cap, and darkened cool hues stay categorical (dark blue is blue).
 */
const LIGHT_HUE_INTERVALS: readonly HueInterval[] = [[195, 330]];

/** Theme-derived inputs for {@link getSessionAccentHex}; see `Theme.sessionAccentInputs`. */
export interface SessionAccentTheme {
	/** Theme accent hex; the session accent adopts its OKLCH lightness and chroma. */
	accentHex: string;
	/** Major theme color hexes checked for hue collision. */
	colorHexes: string[];
	/** WCAG luminance of the status-line surface on light themes; undefined on dark themes. */
	surfaceLuminance?: number;
}

/**
 * Derive a stable CSS hex accent color from a session name and the active theme.
 *
 * The session name hash picks only the **hue**, from a dark/light-specific
 * hue arc so the accent feels natural for the theme type: the full wheel on
 * dark minus hues whose vividness peak is unreachable under the dark
 * lightness cap (see {@link DARK_HUE_INTERVALS}); cool on light. **Lightness and chroma are carried over from the theme's own accent
 * color**, normalized to the sRGB gamut cusp of each hue: the lightness at
 * which a hue peaks in chroma varies wildly (yellow ≈ 0.97, blue ≈ 0.45), so
 * absolute OKLCH lightness cannot transfer between hues — a pink accent's
 * l≈0.67 re-hued to yellow is mustard, not vivid yellow. Instead the
 * accent's position relative to its own hue's cusp (lightness side and
 * chroma fraction) is re-applied at the target hue's cusp, so the session
 * accent inherits the theme's vividness at every hue. The hue is checked against all
 * theme color hues and shifted if it lands within {@link MIN_HUE_DISTANCE}
 * of one, but the shift walks along the admissible arc so it never drifts
 * into an unrelated or excluded part of the spectrum.
 *
 * On dark themes (`surfaceLuminance` undefined) the carried lightness is
 * clamped to stay visible on dark surfaces. On light themes it is reduced
 * until the accent's luminance clears {@link ACCENT_MIN_CONTRAST} against
 * the actual surface it renders on — legible on near-white *and* mid-light
 * backgrounds.
 *
 * @param name — session name for per-session uniqueness.
 * @param theme — accent hex, collision colors, and surface luminance of the active theme.
 */
export function getSessionAccentHex(name: string, theme: SessionAccentTheme): string {
	// 1. Pick hue range based on theme mode
	const isDark = theme.surfaceLuminance === undefined;
	const intervals = isDark ? DARK_HUE_INTERVALS : LIGHT_HUE_INTERVALS;

	// 2. Session name picks a position along the admissible arc
	const pos = nameToHash(name) % arcLength(intervals);

	// 3. Shift away if too close to any theme color — stays within the arc
	const themeHues = theme.colorHexes.map(hexToHue).filter((h): h is number => h !== undefined);
	const targetHue = findSafeHue(pos, themeHues, intervals);

	// 4. Carry the theme accent's perceived weight, re-normalized to the
	//    target hue's gamut cusp (see doc comment above).
	const accent = hexToOklch(theme.accentHex);
	const usable =
		Number.isFinite(accent.l) &&
		Number.isFinite(accent.c) &&
		Number.isFinite(accent.h) &&
		accent.c >= MIN_CHROMA_FOR_HUE;
	const target = oklchCusp(targetHue);
	let lightness: number;
	let chromaFraction: number;
	if (usable) {
		const source = oklchCusp(accent.h);
		// Preserve which side of the cusp the accent sits on and how far along:
		// below-cusp accents map proportionally into [0, targetCusp.l], above-cusp
		// (pastel) accents into [targetCusp.l, 1].
		lightness =
			accent.l <= source.l
				? (accent.l / source.l) * target.l
				: target.l + ((accent.l - source.l) / (1 - source.l)) * (1 - target.l);
		chromaFraction = accent.c / source.c;
	} else {
		lightness = target.l;
		chromaFraction = FALLBACK_CUSP_CHROMA_FRACTION;
	}
	const chroma = Math.max(MIN_CHROMA, Math.min(MAX_CHROMA, chromaFraction * target.c));

	// 5. Lightness/contrast — clamped visible on dark, bisected for AA on light
	if (theme.surfaceLuminance === undefined) {
		const l = Math.max(DARK_MIN_LIGHTNESS, Math.min(DARK_MAX_LIGHTNESS, lightness));
		return oklchToHex({ l, c: chroma, h: targetHue });
	}

	const cap = accentLuminanceCap(theme.surfaceLuminance);
	const top = oklchToHex({ l: lightness, c: chroma, h: targetHue });
	if ((relativeLuminance(top) ?? 0) <= cap) return top;

	// Bisect lightness: `lo` always yields luminance <= cap, `hi` always above it.
	let lo = 0;
	let hi = lightness;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if ((relativeLuminance(oklchToHex({ l: mid, c: chroma, h: targetHue })) ?? 0) > cap) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	return oklchToHex({ l: lo, c: chroma, h: targetHue });
}

/**
 * Convert a hex accent color to an ANSI-16m foreground escape sequence.
 * Returns `undefined` if `hex` is nullish or Bun.color conversion fails.
 */
export function getSessionAccentAnsi(hex: string | undefined): string | undefined {
	if (!hex) return undefined;
	return Bun.color(hex, "ansi-16m") ?? undefined;
}
