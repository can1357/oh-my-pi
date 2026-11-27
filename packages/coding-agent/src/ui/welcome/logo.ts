/**
 * The omp brand mark for terminals: a block-grid logo painted with a diagonal
 * pink → violet → cyan gradient, the half-block `omp` wordmark, and the
 * intro animation (the gradient sweeping round while a highlight crosses it).
 */
import type { ColorDepth } from "@oh-my-pi/pi-tui/theme/color";

/** The block-grid logo. */
export const LOGO: readonly string[] = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

/** Columns of {@link LOGO}. */
export const LOGO_WIDTH = 12;

/** The `omp` wordmark in half-blocks, set beside the logo from its second row (the `p` descends a row). */
export const WORDMARK: readonly string[] = ["▄▀▀▄ █▀▄▀▄ █▀▀▄", "▀▄▄▀ █ █ █ █▄▄▀", "           █"];

/** Columns of {@link WORDMARK}. */
export const WORDMARK_WIDTH = 15;

/** Gradient stops along the diagonal (truecolor). */
const STOPS: readonly (readonly [number, number, number])[] = [
	[248, 79, 204],
	[147, 98, 244],
	[0, 219, 228],
];

/** The gradient on the 256-color palette. */
const RAMP_256 = [206, 170, 134, 99, 69, 74, 44];

/** Half-width of the highlight band along the diagonal. */
const SHINE_HALF_WIDTH = 0.18;

/** A white highlight band: `strength` in [0, 1] at diagonal position `pos`. */
export interface Shine {
	readonly strength: number;
	readonly pos: number;
}

/** Foreground SGR of the gradient at diagonal position `t` in [0, 1], under an optional highlight. */
export function gradientSgr(t: number, depth: ColorDepth, shine?: Shine): string {
	const intensity =
		shine && shine.strength > 0 ? Math.max(0, 1 - Math.abs(t - shine.pos) / SHINE_HALF_WIDTH) * shine.strength : 0;
	if (depth === "truecolor") {
		const at = t * (STOPS.length - 1);
		const i = Math.min(STOPS.length - 2, Math.floor(at));
		const f = at - i;
		const from = STOPS[i]!;
		const to = STOPS[i + 1]!;
		const channel = (c: number) => {
			const value = from[c]! + (to[c]! - from[c]!) * f;
			return Math.round(value + (255 - value) * intensity);
		};
		return `\x1b[38;2;${channel(0)};${channel(1)};${channel(2)}m`;
	}
	const index =
		intensity > 0.5
			? RAMP_256.length - 1
			: Math.min(RAMP_256.length - 1, Math.max(0, Math.floor(t * (RAMP_256.length - 1) + 0.5)));
	return `\x1b[38;5;${RAMP_256[index]}m`;
}

/** `art` painted with the gradient running top-left to bottom-right, shifted by `phase` (wrapping at 1). */
export function gradientArt(art: readonly string[], depth: ColorDepth, phase = 0, shine?: Shine): string[] {
	const width = Math.max(...art.map(row => row.length));
	const xSpan = Math.max(1, width - 1);
	const ySpan = Math.max(1, art.length - 1);
	const shift = ((phase % 1) + 1) % 1;
	return art.map((row, y) => {
		let out = "";
		for (let x = 0; x < row.length; x++) {
			const ch = row[x]!;
			if (ch === " ") {
				out += ch;
				continue;
			}
			const base = (x / xSpan + y / ySpan) / 2;
			out += `${gradientSgr(shift === 0 ? base : (base + shift) % 1, depth, shine)}${ch}\x1b[0m`;
		}
		return out;
	});
}

/** Length of the intro animation. */
export const INTRO_MS = 3000;
/** Full gradient turns the intro sweeps through. */
const INTRO_SWEEPS = 2.5;
/** Times the highlight crosses the logo during the intro. */
const INTRO_SHINE_PASSES = 3;

/** The logo at intro progress `progress` in [0, 1): an eased-out sweep and a fading highlight; at 1, the resting logo. */
export function introLogo(progress: number, depth: ColorDepth): string[] {
	if (progress >= 1) return gradientArt(LOGO, depth);
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const pos = (((progress * INTRO_SHINE_PASSES) % 1) + 1) % 1;
	return gradientArt(LOGO, depth, phase, { strength: (1 - eased) ** 1.5, pos });
}
