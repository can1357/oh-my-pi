/**
 * Agent identity colours: every subagent keeps one name colour for the
 * session, picked by the order agents arrived in it.
 *
 * Arrival order is recorded with {@link noteAgentArrival} (the agent registry
 * reports each subagent with its creation time); slots are handed out lazily,
 * by creation time, the first time any colour is needed, so agents restored on
 * resume in any order keep their original slots. A slot is never released.
 * Main draws in the theme accent.
 *
 * The palette is resolved once per theme: declared `subagent1`…`subagent6`
 * colours keep their slot; the terminal's ANSI hues fill the rest when they
 * read on every surface a name is drawn on (the terminal background and the
 * tool card tints) and stand apart from the accent, the error colour and each
 * other; hues derived from the theme accent (its lightness and chroma
 * carried to evenly spaced hues, darkened on light themes until they read)
 * come next, farthest from everything taken first; a fixed fallback set
 * fills what remains.
 */
import { hexToOklch, hueDistance, oklabDistance, oklchCusp, oklchToHex, relativeLuminance } from "@oh-my-pi/pi-utils";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { MAIN_AGENT_ID } from "../../registry/agent-hub-types";

/** Palette slots per theme; the seventh subagent reuses the first colour. */
const SLOTS = 6;
/** Optional theme keys for subagent colours, by slot. */
const SUBAGENT_KEYS = ["subagent1", "subagent2", "subagent3", "subagent4", "subagent5", "subagent6"] as const;
/** `terminal.ansi` indices tried in order: hues before brights, red left to errors. */
const ANSI_CANDIDATES = [4, 2, 3, 5, 6, 12, 10, 11, 13, 14] as const;
/** Used when the theme leaves slots empty. */
const FALLBACK_HEXES = ["#268bd2", "#d9620f", "#b58900", "#4c9a2a", "#2aa198", "#8b6fd6", "#d33682"] as const;
/** Tool card tints names are drawn on, besides the terminal background. */
const CARD_TINTS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;
/** WCAG contrast a name needs against every surface. */
const MIN_CONTRAST = 3;
/** OKLab distance under which two colours read as the same. */
const MIN_DISTANCE = 0.1;
/** OKLCH chroma under which an ANSI slot is grey. */
const MIN_CHROMA = 0.04;
/** Derived hue candidates, evenly spaced along the hue arc. */
const DERIVED_HUES = 24;
/** Lightness rings of derived candidates and the step between them (away from the surface). */
const RINGS = 3;
const RING_STEP = 0.1;
/** Lightness bounds of a derived candidate (outside them a hue reads as black or white). */
const DERIVED_LIGHTNESS = { min: 0.3, max: 0.9 };
/** Theme colours a derived hue keeps clear of. */
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
/** Below this chroma a colour has no hue. */
const GRAY_CHROMA = 0.03;
/** Degrees a derived hue keeps from every theme hue. */
const MIN_HUE_GAP = 10;
/** Hues whose sRGB cusp is visible under this lightness make up the arc. */
const ARC_MAX_LIGHTNESS = 0.88;
const DARK_LIGHTNESS = { min: 0.65, max: ARC_MAX_LIGHTNESS };
const CHROMA = { min: 0.05, max: 0.21 };
/** Chroma fraction of the cusp when the accent has no usable hue. */
const FALLBACK_CHROMA_FRACTION = 0.7;

/** The hue arc: every whole hue whose cusp lightness stays under the cap. */
const HUE_ARC: readonly number[] = Array.from({ length: 360 }, (_, hue) => hue).filter(
	hue => oklchCusp(hue).l <= ARC_MAX_LIGHTNESS,
);

/**
 * The derived colour at `fraction` of the hue arc: the nearest arc hue clear of
 * `taken` hues, the accent's lightness and chroma re-applied at that hue's cusp;
 * on dark themes lightness is clamped visible, on light ones (`surface` set)
 * lowered until the colour has 3:1 contrast against the surface.
 */
function derivedHex(
	fraction: number,
	accentHex: string,
	taken: readonly number[],
	surface: number | undefined,
): string {
	const at = (p: number): number => HUE_ARC[Math.max(0, Math.min(HUE_ARC.length - 1, p))]!;
	const clear = (hue: number): boolean => taken.every(other => hueDistance(hue, other) >= MIN_HUE_GAP);
	const position = Math.floor(fraction * HUE_ARC.length);
	let hue = at(position);
	for (let step = 1; !clear(hue) && step < HUE_ARC.length; step++) {
		if (clear(at(position + step))) hue = at(position + step);
		else if (clear(at(position - step))) hue = at(position - step);
	}
	if (!clear(hue)) hue = at(position);
	const cusp = oklchCusp(hue);
	const accent = hexToOklch(accentHex);
	let lightness = cusp.l;
	let fractionOfCusp = FALLBACK_CHROMA_FRACTION;
	if (Number.isFinite(accent.l) && Number.isFinite(accent.h) && accent.c >= GRAY_CHROMA) {
		const own = oklchCusp(accent.h);
		lightness =
			accent.l <= own.l ? (accent.l / own.l) * cusp.l : cusp.l + ((accent.l - own.l) / (1 - own.l)) * (1 - cusp.l);
		fractionOfCusp = accent.c / own.c;
	}
	const c = Math.max(CHROMA.min, Math.min(CHROMA.max, fractionOfCusp * cusp.c));
	if (surface === undefined) {
		return oklchToHex({ l: Math.max(DARK_LIGHTNESS.min, Math.min(DARK_LIGHTNESS.max, lightness)), c, h: hue });
	}
	const cap = Math.max(0, (surface + 0.05) / MIN_CONTRAST - 0.05);
	const luminanceAt = (l: number): number => relativeLuminance(oklchToHex({ l, c, h: hue })) ?? 0;
	if (luminanceAt(lightness) <= cap) return oklchToHex({ l: lightness, c, h: hue });
	let lo = 0;
	let hi = lightness;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if (luminanceAt(mid) > cap) hi = mid;
		else lo = mid;
	}
	return oklchToHex({ l: lo, c, h: hue });
}

/** The colours agent names take under one theme. */
export interface AgentPalette {
	/** Main's colour (the accent). */
	readonly main: string;
	/** Subagent colours by arrival slot. */
	readonly subagents: readonly string[];
}

/** Theme internals the palette reads when the theme has them (`ResolvedTheme`). */
interface ThemeSurfaces {
	readonly json?: { readonly terminal?: { readonly background?: unknown } };
	paletteHex?(slot: number): string | undefined;
}

const kPalette = Symbol("omp.agent-palette");

/** The agent palette of `theme`, resolved once per theme instance. */
export function agentPalette(theme: Theme): AgentPalette {
	const tagged = theme as Theme & { [kPalette]?: AgentPalette };
	tagged[kPalette] ??= resolvePalette(theme);
	return tagged[kPalette];
}

function luminance(hex: string): number {
	return relativeLuminance(hex) ?? 0;
}

function surfaceHex(theme: Theme): string {
	const background = (theme as ThemeSurfaces).json?.terminal?.background;
	if (typeof background === "string" && /^#[0-9a-f]{6}$/i.test(background)) return background;
	return theme.hex("statusLineBg");
}

function resolvePalette(theme: Theme): AgentPalette {
	const accent = theme.hex("accent");
	const error = theme.hex("error");
	const surfaces = [luminance(surfaceHex(theme))];
	for (const key of CARD_TINTS) if (theme.has(key)) surfaces.push(luminance(theme.hex(key)));
	const readable = (hex: string): boolean => {
		const l = luminance(hex);
		return surfaces.every(s => (Math.max(l, s) + 0.05) / (Math.min(l, s) + 0.05) >= MIN_CONTRAST);
	};
	const picked: string[] = [];
	const distinct = (hex: string): boolean =>
		[accent, error, ...picked].every(taken => oklabDistance(hex, taken) >= MIN_DISTANCE);
	const declared = SUBAGENT_KEYS.map(key => (theme.has(key) ? theme.hex(key) : undefined));
	for (const hex of declared) if (hex) picked.push(hex);
	const generatedFrom = picked.length;
	const ansi = (theme as ThemeSurfaces).paletteHex;
	for (const slot of ANSI_CANDIDATES) {
		if (picked.length >= SLOTS) break;
		const hex = ansi?.call(theme, slot);
		if (hex && hexToOklch(hex).c >= MIN_CHROMA && readable(hex) && distinct(hex)) picked.push(hex);
	}
	if (picked.length < SLOTS) {
		const takenHues: number[] = [];
		for (const key of MAJOR_COLORS) {
			if (!theme.has(key)) continue;
			const { c, h } = hexToOklch(theme.hex(key));
			if (Number.isFinite(h) && c >= GRAY_CHROMA) takenHues.push(h);
		}
		const surface = theme.dark ? undefined : Math.min(...surfaces);
		const hues = Array.from({ length: DERIVED_HUES }, (_, index) =>
			hexToOklch(derivedHex(index / DERIVED_HUES, accent, takenHues, surface)),
		);
		// A ring of hues that runs out steps the same hues further from the surface.
		const step = theme.dark ? RING_STEP : -RING_STEP;
		for (let ring = 0; ring < RINGS && picked.length < SLOTS; ring++) {
			const candidates = hues
				.map(({ l, c, h }) => oklchToHex({ l: l + ring * step, c, h }))
				.filter(hex => {
					const { l, c } = hexToOklch(hex);
					return l >= DERIVED_LIGHTNESS.min && l <= DERIVED_LIGHTNESS.max && c >= MIN_CHROMA && readable(hex);
				});
			// Farthest first: each pick is the candidate least like every colour taken.
			while (picked.length < SLOTS) {
				let best: string | undefined;
				let bestDistance = MIN_DISTANCE;
				for (const hex of candidates) {
					const d = Math.min(...[accent, error, ...picked].map(taken => oklabDistance(hex, taken)));
					if (d >= bestDistance) {
						best = hex;
						bestDistance = d;
					}
				}
				if (!best) break;
				picked.push(best);
			}
		}
	}
	for (const hex of FALLBACK_HEXES) {
		if (picked.length >= SLOTS) break;
		if (readable(hex) && distinct(hex)) picked.push(hex);
	}
	// No colour clears contrast: names still need telling apart.
	if (picked.length === 0) return { main: accent, subagents: FALLBACK_HEXES.slice(1) };
	const generated = picked.slice(generatedFrom);
	const subagents = declared.map(hex => hex ?? generated.shift()).filter((hex): hex is string => hex !== undefined);
	return { main: accent, subagents };
}

/** Arrival slot per subagent id. */
const slots = new Map<string, number>();
/** Agents seen but not yet given a slot, with their creation time. */
const pending = new Map<string, number>();

/** `agentId` joined the session at `createdAt` (ms); slots follow creation time. */
export function noteAgentArrival(agentId: string, createdAt: number): void {
	if (agentId === MAIN_AGENT_ID || slots.has(agentId)) return;
	pending.set(agentId, createdAt);
}

/** `agentId`'s arrival slot; an id never noted arrives now. */
export function agentSlot(agentId: string): number {
	let slot = slots.get(agentId);
	if (slot !== undefined) return slot;
	if (pending.size > 0) {
		for (const [id] of [...pending].sort((a, b) => a[1] - b[1])) slots.set(id, slots.size);
		pending.clear();
		slot = slots.get(agentId);
		if (slot !== undefined) return slot;
	}
	slot = slots.size;
	slots.set(agentId, slot);
	return slot;
}

/** Forget every arrival (a new session). */
export function resetAgentIdentities(): void {
	slots.clear();
	pending.clear();
}

/** `agentId`'s colour under `theme`: the accent for Main, else its slot's subagent colour. */
export function agentColorHex(theme: Theme, agentId: string): string {
	const palette = agentPalette(theme);
	if (agentId === MAIN_AGENT_ID) return palette.main;
	return palette.subagents[agentSlot(agentId) % palette.subagents.length]!;
}

/** `text` in `agentId`'s colour. */
export function agentColored(theme: Theme, agentId: string, text: string): string {
	return `${fgSgr(agentColorHex(theme, agentId), theme.depth)}${text}\x1b[39m`;
}
