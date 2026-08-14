import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { gradientEscape, gradientLogo, PI_LOGO, type ShineConfig } from "../../components/welcome";
import { theme } from "../../theme/theme";

export const SETUP_SPLASH_MS = 2600;
export const SETUP_TICK_MS = 33;

/** Brand mark at 2x: every glyph doubled horizontally, every row doubled vertically. */
const LARGE_LOGO = PI_LOGO.flatMap(line => {
	let wide = "";
	for (const char of line) {
		wide += char === " " ? "  " : `${char}${char}`;
	}
	return [wide, wide];
});
const LOGO_WIDTH = Math.max(...LARGE_LOGO.map(line => visibleWidth(line)));
const LOGO_HEIGHT = LARGE_LOGO.length;
const RESET = "\x1b[0m";

/** Full scene needs comfortable room; below this we drop to a centered mark. */
const MIN_SCENE_WIDTH = 56;
const MIN_SCENE_HEIGHT = 22;

const SKIP_HINT = "press enter to skip";

/** Density ramp for the rippling water, lightest → heaviest. */
const WATER_RAMP = [
	{ min: 0.62, char: "█" },
	{ min: 0.5, char: "▓" },
	{ min: 0.36, char: "▒" },
	{ min: 0.24, char: "░" },
];

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

function starAt(x: number, y: number, frame: number): string {
	const hash = (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791);
	const bucket = Math.abs(hash) % 97;
	if (bucket === 0) return theme.fg("accent", "✦");
	if (bucket === 1) return theme.fg("muted", "·");
	return " ";
}

export function renderStarfield(width: number, height: number, frame: number): string[] {
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		let line = "";
		for (let x = 0; x < width; x++) {
			line += starAt(x, y, frame >> 3);
		}
		lines.push(line);
	}
	return lines;
}

/** Continuous diagonal gradient position (top-left → bottom-right) across the whole screen. */
function screenGradientT(x: number, y: number, width: number, height: number, phase: number): number {
	const span = Math.max(1, width + height - 1);
	const base = (x + y) / span;
	return (((base + phase) % 1) + 1) % 1;
}

/** Twinkling sparkle for the upper "sky". Returns a styled glyph, or null for empty space. */
function skyGlyph(x: number, y: number, frame: number): string | null {
	const hash = (x * 73856093) ^ (y * 19349663) ^ (frame * 83492791);
	const bucket = Math.abs(hash) % 150;
	if (bucket === 0) return theme.fg("accent", "✦");
	if (bucket === 1) return theme.fg("border", "✧");
	if (bucket === 2) return theme.fg("border", "·");
	return null;
}

/** Static value-jitter in [0,1) that softens the water's threshold banding. */
function waterJitter(x: number, y: number): number {
	let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

/**
 * Rippling water amplitude in [0,1] at (x, y): three travelling sine waves
 * interfere, then a radial edge falloff and a downward fade concentrate the
 * ripples beneath the mark and dissolve them toward the edges/bottom. `t`
 * advances each tick, so the surface drifts.
 */
function waterAmplitude(
	x: number,
	y: number,
	cx: number,
	waterTop: number,
	waterHeight: number,
	width: number,
	t: number,
): number {
	const dx = (x - cx) / 2;
	const dy = y - waterTop;
	const dist = Math.sqrt(dx * dx + dy * dy);
	const wave =
		0.5 * Math.sin(dist * 0.55 - t) +
		0.3 * Math.sin(x * 0.22 + y * 0.45 - t * 0.7) +
		0.2 * Math.sin(Math.abs(dx) * 0.8 + dy * 0.5 - t * 1.4);
	const level = 0.5 + 0.5 * wave;
	const edge = Math.max(0, 1 - Math.abs(x - cx) / (width * 0.5));
	const fade = Math.max(0, 1 - (dy / Math.max(1, waterHeight)) * 0.55);
	return level * edge ** 0.7 * fade;
}

/**
 * Number of full gradient rotations the intro sweep performs before settling
 * into the resting orientation (phase 0 — same convention as welcome.ts's
 * introLogoFrame). Converging to exactly 0 keeps the settled frame's `base`
 * (always < 1 by construction) from ever wrapping mid-glyph.
 */
const SPLASH_SWEEPS = 1.8;

/**
 * Animated setup splash, in the spirit of the omp landing page: the brand π
 * mark rendered with the live diagonal gradient + shine sweep, rising out of a
 * rippling, gradient-lit water surface, under a faint twinkling starfield. The
 * mark and water share one continuous gradient so the sweep reads across the
 * whole scene; the water surface drifts each frame.
 */
export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	// Ease-out cubic so the spin decelerates into rest; phase is driven by
	// (1 - eased), which hits exactly 0 at progress=1, so the settled frame
	// never wraps mid-glyph and matches the app's canonical resting gradient.
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * SPLASH_SWEEPS) % 1) + 1) % 1;
	const shine: ShineConfig = { pos: (progress * 2.5) % 1, strength: (1 - eased) ** 1.5 };

	if (w < MIN_SCENE_WIDTH || h < MIN_SCENE_HEIGHT) return renderCompactSplash(w, h, phase, shine);

	const frame = Math.floor(elapsedMs / SETUP_TICK_MS);
	const cx = Math.floor(w / 2);
	const surfaceTime = frame * 0.13;

	const cells: string[][] = Array.from({ length: h }, () => new Array<string>(w).fill(" "));
	const put = (x: number, y: number, glyph: string): void => {
		if (y >= 0 && y < h && x >= 0 && x < w) cells[y][x] = glyph;
	};

	const hx = Math.floor((w - LOGO_WIDTH) / 2);
	const hy = Math.max(2, Math.floor(h * 0.16));
	const waterTop = hy + LOGO_HEIGHT;
	const waterHeight = Math.max(1, h - waterTop);

	// 1. rippling water surface (shares the screen-wide gradient with the mark)
	for (let y = waterTop; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const amp = waterAmplitude(x, y, cx, waterTop, waterHeight, w, surfaceTime) + (waterJitter(x, y) - 0.5) * 0.06;
			const cell = WATER_RAMP.find(step => amp > step.min);
			if (cell) put(x, y, gradientEscape(screenGradientT(x, y, w, h, phase), shine) + cell.char + RESET);
		}
	}
	// 2. twinkling starfield in the sky above the water
	for (let y = 0; y < waterTop - 1; y++) {
		for (let x = 0; x < w; x++) {
			const star = skyGlyph(x, y, frame >> 3);
			if (star) put(x, y, star);
		}
	}
	// 3. hero — the brand mark with the live gradient + shine sweep
	LARGE_LOGO.forEach((line, row) => {
		let col = 0;
		for (const ch of line) {
			if (ch !== " ") {
				put(
					hx + col,
					hy + row,
					gradientEscape(screenGradientT(hx + col, hy + row, w, h, phase), shine) + ch + RESET,
				);
			}
			col++;
		}
	});
	// 4. skip hint on a cleared strip at the bottom so it stays legible over the water
	const hintWidth = visibleWidth(SKIP_HINT);
	const hintStart = Math.floor((w - hintWidth) / 2);
	const hintRow = h - 1;
	for (let x = hintStart - 1; x <= hintStart + hintWidth; x++) put(x, hintRow, " ");
	let col = hintStart;
	for (const ch of SKIP_HINT) put(col++, hintRow, ch === " " ? " " : theme.fg("dim", ch));

	return cells.map(row => row.join(""));
}

/** Centered fallback for windows too small to hold the full scene. */
function renderCompactSplash(width: number, height: number, phase: number, shine: ShineConfig): string[] {
	const art = height >= 14 ? LARGE_LOGO : PI_LOGO;
	const content = [...gradientLogo(art, phase, shine), "", theme.bold("O h   M y   P i")];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		const item = content[y - start];
		lines.push(clampLine(item !== undefined ? centerLine(item, width) : "", width));
	}
	if (height > 2) lines[height - 2] = clampLine(centerLine(theme.fg("dim", SKIP_HINT), width), width);
	return lines;
}
