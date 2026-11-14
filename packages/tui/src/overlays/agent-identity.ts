import { hexToOklch, oklabDistance, oklchToHex, relativeLuminance } from "@oh-my-pi/pi-utils/color";
import { BG_RESET, FG_RESET } from "../theme/color";
import type { AnsiColor, ThemeBg, ThemeColor } from "../theme/schema";
import { getSessionAccentAnsi, getSessionAccentHexAt } from "../theme/session-color";
import type { Theme } from "../theme/theme-class";
import { MAIN_AGENT_ID } from "./agent-hub-types";

/** Optional theme tokens for subagent colours, in arrival order; a declared one is used as written. */
const SUBAGENT_TOKENS: readonly ThemeColor[] = [
	"subagent1",
	"subagent2",
	"subagent3",
	"subagent4",
	"subagent5",
	"subagent6",
];

/** `terminal.ansi` slots tried after the tokens: hues before brights, red left to errors. */
const ANSI_SLOTS: readonly AnsiColor[] = [
	"blue",
	"green",
	"yellow",
	"magenta",
	"cyan",
	"brightBlue",
	"brightGreen",
	"brightYellow",
	"brightMagenta",
	"brightCyan",
];

/** Last resort when the theme and the derived hues leave slots empty. */
const FALLBACK_HEXES: readonly string[] = ["#268bd2", "#d9620f", "#b58900", "#4c9a2a", "#2aa198", "#8b6fd6", "#d33682"];

/** Tints behind Task tool cards; names are drawn on these as well as on the terminal background. */
const CARD_BACKGROUNDS: readonly ThemeBg[] = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];

/** WCAG contrast an agent name needs against every surface it is drawn on. */
const MIN_CONTRAST = 3;
/** OKLab distance under which two names read as the same colour; the fallback palette's closest pair is 0.108. */
const MIN_DISTANCE = 0.1;
/** OKLCH chroma under which a terminal slot is grey, not a colour. */
const MIN_CHROMA = 0.04;
/** Evenly spaced positions along the session-accent hue arc offered as derived candidates. */
const DERIVED_CANDIDATES = 24;
/** OKLCH lightness between the rings of derived candidates, and how many rings there are. */
const LIGHTNESS_STEP = 0.1;
const LIGHTNESS_RINGS = 3;
/** OKLCH lightness bounds for a derived candidate: outside them a hue reads as black or white. */
const MIN_LIGHTNESS = 0.3;
const MAX_LIGHTNESS = 0.9;

/** The colours agent names take under one theme. */
export interface AgentPalette {
	/** Main's colour: the theme accent. */
	readonly main: string;
	/** Subagent colours in arrival order; the seventh subagent reuses the first. */
	readonly subagents: readonly string[];
}

const palettes = new WeakMap<Theme, AgentPalette>();

/** The agent palette of `theme`, resolved once per theme instance (a theme change builds a new instance). */
export function agentPalette(theme: Theme): AgentPalette {
	let palette = palettes.get(theme);
	if (!palette) {
		palette = resolveAgentPalette(theme);
		palettes.set(theme, palette);
	}
	return palette;
}

function resolveAgentPalette(theme: Theme): AgentPalette {
	const accent = theme.getAccentColorHex();
	const error = theme.getColorHex("error");
	const surfaces = [relativeLuminance(theme.surfaceHex) ?? 0];
	for (const key of CARD_BACKGROUNDS) {
		if (theme.getBgAnsi(key) !== BG_RESET) surfaces.push(relativeLuminance(theme.getBgHex(key)) ?? 0);
	}
	const subagents: string[] = [];
	const readable = (hex: string) => {
		const luminance = relativeLuminance(hex) ?? 0;
		return surfaces.every(
			surface => (Math.max(luminance, surface) + 0.05) / (Math.min(luminance, surface) + 0.05) >= MIN_CONTRAST,
		);
	};
	const distance = (hex: string) => Math.min(...[accent, error, ...subagents].map(taken => oklabDistance(hex, taken)));
	const usable = (hex: string) => readable(hex) && distance(hex) >= MIN_DISTANCE;

	for (const token of SUBAGENT_TOKENS) {
		if (theme.hasColor(token)) subagents.push(theme.getColorHex(token));
	}
	for (const slot of ANSI_SLOTS) {
		const hex = theme.getAnsiHex(slot);
		if (subagents.length < SUBAGENT_TOKENS.length && hex && hexToOklch(hex).c >= MIN_CHROMA && usable(hex)) {
			subagents.push(hex);
		}
	}
	if (subagents.length < SUBAGENT_TOKENS.length) {
		// Hues derived from the accent; on light themes they darken until they clear the darkest surface.
		const inputs = {
			...theme.sessionAccentInputs,
			surfaceLuminance: theme.isLight ? Math.min(...surfaces) : undefined,
		};
		const hues = Array.from({ length: DERIVED_CANDIDATES }, (_, index) =>
			hexToOklch(getSessionAccentHexAt(index / DERIVED_CANDIDATES, inputs)),
		);
		// Muted themes leave too little room between hues at one lightness, and a card tint can sit
		// closer to the hues than the background does: once a ring of hues runs out, the next ring
		// steps the same hues further from the surface.
		const step = theme.isLight ? -LIGHTNESS_STEP : LIGHTNESS_STEP;
		for (let ring = 0; ring < LIGHTNESS_RINGS && subagents.length < SUBAGENT_TOKENS.length; ring++) {
			const candidates = hues
				.map(({ l, c, h }) => oklchToHex({ l: l + ring * step, c, h }))
				.filter(hex => {
					const { l, c } = hexToOklch(hex);
					return l >= MIN_LIGHTNESS && l <= MAX_LIGHTNESS && c >= MIN_CHROMA && readable(hex);
				});
			// Farthest first: each pick is the candidate least like every colour already taken.
			while (subagents.length < SUBAGENT_TOKENS.length) {
				let best: string | undefined;
				let bestDistance = MIN_DISTANCE;
				for (const hex of candidates) {
					const d = distance(hex);
					if (d >= bestDistance) {
						best = hex;
						bestDistance = d;
					}
				}
				if (!best) break;
				subagents.push(best);
			}
		}
	}
	for (const hex of FALLBACK_HEXES) {
		if (subagents.length < SUBAGENT_TOKENS.length && usable(hex)) subagents.push(hex);
	}
	// A theme where no colour clears contrast still needs names told apart: keep the fallback hues unfiltered.
	return { main: accent, subagents: subagents.length > 0 ? subagents : FALLBACK_HEXES.slice(1) };
}

/** Arrival slot per subagent id; never released, so a colour lasts the agent's life. */
const arrivalSlots = new Map<string, number>();
/** Registered agents not yet given a slot, with their creation time. */
const pendingArrivals = new Map<string, number>();

/**
 * Record that `agentId` joined the session at `createdAt`. Slots are handed out
 * by creation time when a colour is first needed, so agents restored on resume
 * in any order still take their original order.
 */
export function noteAgentArrival(agentId: string, createdAt: number): void {
	if (agentId === MAIN_AGENT_ID || arrivalSlots.has(agentId)) return;
	pendingArrivals.set(agentId, createdAt);
}

/** `agentId`'s colour under `theme`: the accent for Main, otherwise the subagent colour of its arrival slot. */
export function agentColorHex(theme: Theme, agentId: string): string {
	const palette = agentPalette(theme);
	if (agentId === MAIN_AGENT_ID) return palette.main;
	let slot = arrivalSlots.get(agentId);
	if (slot === undefined) {
		for (const [id] of [...pendingArrivals].sort((a, b) => a[1] - b[1])) arrivalSlots.set(id, arrivalSlots.size);
		pendingArrivals.clear();
		slot = arrivalSlots.get(agentId);
		if (slot === undefined) {
			// Never registered here (a test, a foreign id): it arrives when first drawn.
			slot = arrivalSlots.size;
			arrivalSlots.set(agentId, slot);
		}
	}
	return palette.subagents[slot % palette.subagents.length]!;
}

/** `text` in the foreground colour of `agentId`'s identity under `theme`. */
export function agentColored(theme: Theme, agentId: string, text: string): string {
	const ansi = getSessionAccentAnsi(agentColorHex(theme, agentId));
	return ansi ? `${ansi}${text}${FG_RESET}` : text;
}
