import { centerLine, visibleWidth } from "../../utils";
import { padToWidth } from "../../render/utils";
import { gradientEscape, gradientLogo, logoNode, PI_LOGO, type ShineConfig } from "../../prompt/welcome";
import { theme } from "../../theme/theme";
import { formatKeyHint } from "../../app-keybindings";
import { col, node, span, text } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { Memo } from "../../native/memo";

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

/** Skip affordance; built at render time so it follows the live symbol preset. */
function skipHint(): string {
	return `press ${formatKeyHint("enter")} to skip`;
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

/** Continuous diagonal gradient position (bottom-left → top-right) across the whole screen. */
function screenGradientT(x: number, y: number, width: number, height: number, phase: number): number {
	const span = Math.max(1, width + height - 1);
	const base = (x + (height - 1 - y)) / span;
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
 * Time-invariant terms of the rippling water for one screen size: three
 * travelling sine waves interfere, then a radial edge falloff and a downward
 * fade concentrate the ripples beneath the mark and dissolve them toward the
 * edges/bottom. Only the sine phases move per tick, so everything else is
 * computed once per size.
 */
interface WaterField {
	readonly width: number;
	readonly height: number;
	readonly waterTop: number;
	/** Per cell (row-major from `waterTop`): `dist * 0.55`. */
	readonly radial: Float64Array;
	/** Per cell: `x * 0.22 + y * 0.45`. */
	readonly diagonal: Float64Array;
	/** Per cell: `|dx| * 0.8 + dy * 0.5`. */
	readonly cross: Float64Array;
	/** Per cell: `(waterJitter(x, y) - 0.5) * 0.06`. */
	readonly jitter: Float64Array;
	/** Per column: `edge ** 0.7`. */
	readonly edge: Float64Array;
	/** Per water row: downward fade. */
	readonly fade: Float64Array;
}

let waterField: WaterField | undefined;

function getWaterField(width: number, height: number, cx: number, waterTop: number): WaterField {
	const cached = waterField;
	if (cached && cached.width === width && cached.height === height && cached.waterTop === waterTop) return cached;
	const waterHeight = Math.max(1, height - waterTop);
	const rows = Math.max(0, height - waterTop);
	const radial = new Float64Array(rows * width);
	const diagonal = new Float64Array(rows * width);
	const cross = new Float64Array(rows * width);
	const jitter = new Float64Array(rows * width);
	const edge = new Float64Array(width);
	const fade = new Float64Array(rows);
	for (let x = 0; x < width; x++) edge[x] = Math.max(0, 1 - Math.abs(x - cx) / (width * 0.5)) ** 0.7;
	for (let row = 0; row < rows; row++) {
		const y = waterTop + row;
		const dy = y - waterTop;
		fade[row] = Math.max(0, 1 - (dy / waterHeight) * 0.55);
		for (let x = 0; x < width; x++) {
			const i = row * width + x;
			const dx = (x - cx) / 2;
			radial[i] = Math.sqrt(dx * dx + dy * dy) * 0.55;
			diagonal[i] = x * 0.22 + y * 0.45;
			cross[i] = Math.abs(dx) * 0.8 + dy * 0.5;
			jitter[i] = (waterJitter(x, y) - 0.5) * 0.06;
		}
	}
	waterField = { width, height, waterTop, radial, diagonal, cross, jitter, edge, fade };
	return waterField;
}

/** Water glyph for an amplitude, lightest → heaviest density ramp; undefined below the floor. */
function waterChar(amp: number): string | undefined {
	if (amp > 0.62) return "█";
	if (amp > 0.5) return "▓";
	if (amp > 0.36) return "▒";
	if (amp > 0.24) return "░";
	return undefined;
}

/** Reused cell grid; resized when the screen changes. */
let splashCells: string[][] = [];

function resetCells(width: number, height: number): string[][] {
	if (splashCells.length !== height || splashCells[0]?.length !== width) {
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		splashCells = Array.from({ length: height }, () => new Array<string>(width).fill(" "));
	} else {
		for (const row of splashCells) row.fill(" ");
	}
	return splashCells;
}

/** Per-frame gradient escapes, one per screen diagonal (the gradient only varies along it). */
let diagonalEscapes: (string | undefined)[] = [];

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
	const phase = progress * 1.8;
	const shine: ShineConfig = { pos: (progress * 2.5) % 1, strength: Math.max(0, 1 - progress * 0.35) };

	if (w < MIN_SCENE_WIDTH || h < MIN_SCENE_HEIGHT) return renderCompactSplash(w, h, phase, shine);

	const frame = Math.floor(elapsedMs / SETUP_TICK_MS);
	const cx = Math.floor(w / 2);
	const surfaceTime = frame * 0.13;

	const cells = resetCells(w, h);
	const put = (x: number, y: number, glyph: string): void => {
		if (y >= 0 && y < h && x >= 0 && x < w) cells[y][x] = glyph;
	};
	// Every cell on a diagonal shares one gradient position, so resolve each
	// escape once per frame instead of once per cell.
	const diagonals = w + h - 1;
	if (diagonalEscapes.length !== diagonals) diagonalEscapes = Array.from({ length: diagonals });
	else diagonalEscapes.fill(undefined);
	const escapes = diagonalEscapes;
	const gradient = (x: number, y: number): string => {
		const d = x + (h - 1 - y);
		let escape = escapes[d];
		if (escape === undefined) {
			escape = gradientEscape(screenGradientT(x, y, w, h, phase), shine);
			escapes[d] = escape;
		}
		return escape;
	};

	const hx = Math.floor((w - LOGO_WIDTH) / 2);
	const hy = Math.max(2, Math.floor(h * 0.16));
	const waterTop = hy + LOGO_HEIGHT;

	// 1. rippling water surface (shares the screen-wide gradient with the mark)
	const field = getWaterField(w, h, cx, waterTop);
	const tDiagonal = surfaceTime * 0.7;
	const tCross = surfaceTime * 1.4;
	for (let y = waterTop; y < h; y++) {
		const row = y - waterTop;
		const fade = field.fade[row];
		for (let x = 0; x < w; x++) {
			const i = row * w + x;
			const wave =
				0.5 * Math.sin(field.radial[i] - surfaceTime) +
				0.3 * Math.sin(field.diagonal[i] - tDiagonal) +
				0.2 * Math.sin(field.cross[i] - tCross);
			const level = 0.5 + 0.5 * wave;
			const char = waterChar(level * field.edge[x] * fade + field.jitter[i]);
			if (char) cells[y][x] = gradient(x, y) + char + RESET;
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
			const x = hx + col;
			const y = hy + row;
			if (ch !== " " && y >= 0 && y < h && x >= 0 && x < w) cells[y][x] = gradient(x, y) + ch + RESET;
			col++;
		}
	});
	// 4. skip hint on a cleared strip at the bottom so it stays legible over the water
	const hint = skipHint();
	const hintWidth = visibleWidth(hint);
	const hintStart = Math.floor((w - hintWidth) / 2);
	const hintRow = h - 1;
	for (let x = hintStart - 1; x <= hintStart + hintWidth; x++) put(x, hintRow, " ");
	let col = hintStart;
	for (const ch of hint) put(col++, hintRow, ch === " " ? " " : theme.fg("dim", ch));

	return cells.map(row => row.join(""));
}

const splashMemo = new Memo();

/**
 * Native splash: the 2x brand mark with a terminal-clocked shimmer, the
 * wordmark, and the skip hint pinned to the bottom. The water and starfield
 * are cell paintings with no semantic counterpart. A click on the splash
 * sends the `skip` action.
 */
export function describeSetupSplash(): NativeNode {
	const hint = skipHint();
	return splashMemo.get([hint], () =>
		col(
			[
				node("spacer", { grow: 1 }),
				logoNode(LARGE_LOGO, true),
				text([span("O h   M y   P i", "strong")], { wrap: "none" }),
				node("spacer", { grow: 1 }),
				text([span(hint, "dim")], { wrap: "none" }),
			],
			{ align: "center", gap: "md", grow: 1, role: "omp.setup.splash", actions: { click: "skip" } },
		),
	);
}

/** Centered fallback for windows too small to hold the full scene. */
function renderCompactSplash(width: number, height: number, phase: number, shine: ShineConfig): string[] {
	const art = height >= 14 ? LARGE_LOGO : PI_LOGO;
	const content = [...gradientLogo(art, phase, shine), "", theme.bold("O h   M y   P i")];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		const item = content[y - start];
		lines.push(width > 0 ? padToWidth(item !== undefined ? centerLine(item, width) : "", width) : "");
	}
	if (height > 2)
		lines[height - 2] = width > 0 ? padToWidth(centerLine(theme.fg("dim", skipHint()), width), width) : "";
	return lines;
}
