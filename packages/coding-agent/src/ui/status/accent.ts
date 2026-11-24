/**
 * Session accent: a per-session color derived from the session title, so
 * concurrent sessions read apart at a glance (status bar model, title, mode
 * badges).
 *
 * The title's djb2-xor hash picks a hue on an arc that suits the theme
 * (dark: every hue whose sRGB cusp sits at or below the dark lightness cap;
 * light: the cool 195°–330° band), nudged at least 10° away from the theme's
 * own major hues. Lightness and chroma copy the theme accent's position
 * relative to its own hue's cusp, re-applied at the target hue's cusp; dark
 * themes clamp lightness into a visible band, light themes darken until the
 * color has 3:1 contrast against the status surface.
 */
import { hexToOklch, hueDistance, oklchCusp, oklchToHex, relativeLuminance } from "@oh-my-pi/pi-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";

/** Theme colors a session accent must not hue-collide with. */
const MAJOR_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"mdHeading",
	"mdLink",
	"mdCode",
	"mdCodeBlock",
	"mdQuoteBorder",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"customMessageLabel",
	"thinkingText",
] as const;

const DARK_LIGHTNESS = { min: 0.65, max: 0.88 };
const CHROMA = { min: 0.05, max: 0.21 };
/** Chroma fraction of the cusp used when the theme accent has no usable hue. */
const FALLBACK_CHROMA_FRACTION = 0.7;
/** Below this chroma a hue means nothing. */
const GRAY_CHROMA = 0.03;
const MIN_HUE_GAP = 10;
const LIGHT_CONTRAST = 3;

type Arc = readonly (readonly [number, number])[];

const DARK_ARC: Arc = (() => {
	const arc: [number, number][] = [];
	let start = -1;
	for (let hue = 0; hue <= 360; hue++) {
		const usable = hue < 360 && oklchCusp(hue).l <= DARK_LIGHTNESS.max;
		if (usable && start < 0) start = hue;
		else if (!usable && start >= 0) {
			arc.push([start, hue - 1]);
			start = -1;
		}
	}
	return arc;
})();
const LIGHT_ARC: Arc = [[195, 330]];

function arcSize(arc: Arc): number {
	let size = 0;
	for (const [from, to] of arc) size += to - from + 1;
	return size;
}

function arcHue(arc: Arc, position: number): number {
	let rest = position;
	for (const [from, to] of arc) {
		if (rest <= to - from) return from + rest;
		rest -= to - from + 1;
	}
	return arc[arc.length - 1]?.[1] ?? 0;
}

function titleHash(title: string): number {
	let hash = 5381;
	for (let i = 0; i < title.length; i++) hash = (((hash << 5) + hash) ^ title.charCodeAt(i)) >>> 0;
	return hash;
}

/** The hue at `position`, or the nearest one along the arc clear of every `taken` hue. */
function clearHue(arc: Arc, position: number, taken: readonly number[]): number {
	const size = arcSize(arc);
	const at = (p: number) => arcHue(arc, Math.max(0, Math.min(size - 1, p)));
	const clear = (hue: number) => taken.every(other => hueDistance(hue, other) >= MIN_HUE_GAP);
	if (clear(at(position))) return at(position);
	for (let step = 1; step < size; step++) {
		if (clear(at(position + step))) return at(position + step);
		if (clear(at(position - step))) return at(position - step);
	}
	return at(position);
}

interface AccentInputs {
	readonly accentHex: string;
	readonly hues: readonly number[];
	/** WCAG luminance of the status surface on light themes; undefined on dark ones. */
	readonly surface: number | undefined;
}

function accentHex(title: string, inputs: AccentInputs): string {
	const arc = inputs.surface === undefined ? DARK_ARC : LIGHT_ARC;
	const hue = clearHue(arc, titleHash(title) % arcSize(arc), inputs.hues);
	const cusp = oklchCusp(hue);
	const accent = hexToOklch(inputs.accentHex);
	let lightness = cusp.l;
	let fraction = FALLBACK_CHROMA_FRACTION;
	if (Number.isFinite(accent.l) && Number.isFinite(accent.c) && Number.isFinite(accent.h) && accent.c >= GRAY_CHROMA) {
		const own = oklchCusp(accent.h);
		lightness =
			accent.l <= own.l ? (accent.l / own.l) * cusp.l : cusp.l + ((accent.l - own.l) / (1 - own.l)) * (1 - cusp.l);
		fraction = accent.c / own.c;
	}
	const c = Math.max(CHROMA.min, Math.min(CHROMA.max, fraction * cusp.c));
	if (inputs.surface === undefined) {
		const l = Math.max(DARK_LIGHTNESS.min, Math.min(DARK_LIGHTNESS.max, lightness));
		return oklchToHex({ l, c, h: hue });
	}
	const cap = Math.max(0, (inputs.surface + 0.05) / LIGHT_CONTRAST - 0.05);
	const luminance = (l: number) => relativeLuminance(oklchToHex({ l, c, h: hue })) ?? 0;
	if (luminance(lightness) <= cap) return oklchToHex({ l: lightness, c, h: hue });
	let lo = 0;
	let hi = lightness;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if (luminance(mid) > cap) hi = mid;
		else lo = mid;
	}
	return oklchToHex({ l: lo, c, h: hue });
}

const accentInputs = new WeakMap<Theme, AccentInputs>();

function themeInputs(theme: Theme): AccentInputs {
	let inputs = accentInputs.get(theme);
	if (inputs) return inputs;
	const hues: number[] = [];
	for (const key of MAJOR_COLORS) {
		if (!theme.has(key)) continue;
		const { c, h } = hexToOklch(theme.hex(key));
		if (Number.isFinite(h) && c >= GRAY_CHROMA) hues.push(h);
	}
	inputs = {
		accentHex: theme.hex("accent"),
		hues,
		surface: theme.dark ? undefined : relativeLuminance(theme.hex("statusLineBg")),
	};
	accentInputs.set(theme, inputs);
	return inputs;
}

const hexCache = new Map<string, string>();

/** Hex of the session accent for `title` under `theme`; undefined without a title. */
export function sessionAccentHex(theme: Theme, title: string | undefined): string | undefined {
	if (!title) return undefined;
	const inputs = themeInputs(theme);
	const key = `${title}\0${inputs.accentHex}\0${inputs.surface}\0${inputs.hues.join(",")}`;
	let hex = hexCache.get(key);
	if (hex === undefined) {
		if (hexCache.size >= 256) hexCache.clear();
		hex = accentHex(title, inputs);
		hexCache.set(key, hex);
	}
	return hex;
}

/** Foreground SGR of the session accent for `title` under `theme`; undefined without a title. */
export function sessionAccentSgr(theme: Theme, title: string | undefined): string | undefined {
	const hex = sessionAccentHex(theme, title);
	return hex === undefined ? undefined : fgSgr(hex, theme.depth);
}
