/**
 * Terminal look of the startup splash (`omp.setup.splash`): a twinkling
 * starfield, the omp logo at double size in its gradient, a drifting nebula
 * under it, and "press ⏎ to skip" on the last row. The frame fills the
 * rows the screen gives it and animates on the terminal clock.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { gradientArt, LOGO, LOGO_WIDTH } from "../../welcome/logo";
import { formatKey } from "../../keys/format";

/** Terminal facts of the splash: the clock time the animation counts from. */
export type SplashTerm = { readonly start: number };

const STAR_GLYPHS = ["✦", "✧", "·"] as const;
/** Share of cells holding a star. */
const STAR_DENSITY = 0.022;
/** Nebula shades, faint to dense. */
const SHADES = [" ", "░", "▒", "▓", "█"] as const;

/** A stable pseudo-random value in [0, 1) for a cell and channel. */
export function cellNoise(x: number, y: number, channel: number): number {
	let h = (x * 374_761_393 + y * 668_265_263 + channel * 2_147_483_647) | 0;
	h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
	h ^= h >>> 16;
	return (h >>> 0) / 4_294_967_296;
}

/** The star at a cell at time `t` (ms), or a blank: stars twinkle on and off at their own pace. */
export function starAt(x: number, y: number, t: number, seed = 0): string {
	if (cellNoise(x, y, seed) >= STAR_DENSITY) return " ";
	const period = 900 + cellNoise(x, y, seed + 1) * 1800;
	const phase = cellNoise(x, y, seed + 2) * period;
	if ((t + phase) % period > period * 0.7) return " ";
	return STAR_GLYPHS[Math.floor(cellNoise(x, y, seed + 3) * STAR_GLYPHS.length)]!;
}

/** A row of stars, `width` cells, dimmed. */
export function starRow(theme: Theme, y: number, width: number, t: number, seed = 0): string {
	let out = "";
	for (let x = 0; x < width; x++) out += starAt(x, y, t, seed);
	return theme.fg("dim", out);
}

/** `text` centered in `width` cells (cut to fit). */
export function centered(text: string, width: number): string {
	const shown = truncate(text, width);
	return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(shown)) / 2)))}${shown}`;
}

/** The logo at twice its size (each cell doubled across and each row doubled down). */
function bigLogo(): string[] {
	const rows: string[] = [];
	for (const row of LOGO) {
		const wide = [...row].map(ch => ch + ch).join("");
		rows.push(wide, wide);
	}
	return rows;
}

/** Nebula density at a cell: soft drifting blobs under the logo. */
function nebula(x: number, y: number, t: number, width: number, height: number): number {
	const u = x / Math.max(1, width);
	const v = y / Math.max(1, height);
	const drift = t / 4000;
	const wave =
		Math.sin(u * 9 + drift) * Math.cos(v * 7 - drift * 0.7) +
		Math.sin((u + v) * 5 - drift * 1.3) * 0.6 +
		Math.cos(u * 3 - v * 11 + drift * 0.5) * 0.4;
	return Math.max(0, Math.min(1, (wave + 0.6) / 2.2 + (cellNoise(x, y, 7) - 0.5) * 0.12));
}

/** The splash frame at time `t` (ms since it started), `width` × `height`. */
export function splashRows(theme: Theme, width: number, height: number, t: number): string[] {
	const logo = width >= 2 * LOGO_WIDTH + 2 && height >= 16 ? bigLogo() : [...LOGO];
	const art = gradientArt(logo, "truecolor");
	const logoWidth = Math.max(...logo.map(row => row.length));
	const top = Math.max(0, Math.floor(height * 0.15));
	const hint = theme.fg(
		"muted",
		`press ${formatKey("enter", { preset: theme.symbols.preset, platform: process.platform })} to skip`,
	);
	const rows: string[] = [];
	for (let y = 0; y < height; y++) {
		if (y === height - 1 || (height < 3 && y === 0)) {
			rows.push(centered(hint, width));
			continue;
		}
		const at = y - top;
		if (at >= 0 && at < art.length) {
			const left = Math.max(0, Math.floor((width - logoWidth) / 2));
			rows.push(truncate(`${" ".repeat(left)}${art[at]}`, width));
			continue;
		}
		if (y > top + art.length && height >= 16) {
			let shade = "";
			for (let x = 0; x < width; x++) {
				const level = nebula(x, y, t, width, height);
				shade += level > 0.42 ? SHADES[Math.min(4, Math.floor((level - 0.42) * 9) + 1)] : starAt(x, y, t);
			}
			rows.push(theme.fg("muted", shade));
			continue;
		}
		rows.push(starRow(theme, y, width, t));
	}
	return rows;
}

function paintSplash(node: UiNode, cx: PaintContext): Block {
	const term = (node.props() as { term?: SplashTerm }).term;
	const height = cx.height ?? 24;
	const t = cx.reduceMotion ? 0 : cx.now() - (term?.start ?? 0);
	return {
		rows: splashRows(cx.theme, cx.width, height, t),
		hits: [{ row: 0, col: 0, width: cx.width, height, node, act: "skip" }],
	};
}

defineRolePainter("col", "omp.setup.splash", paintSplash);
