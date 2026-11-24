/**
 * The Codex reset celebration in the terminal: a night sky (about a third of
 * the screen's rows) with twinkling stars and fireworks rising and bursting
 * on the paint clock, over a banner with the spaced-out title and the line.
 * Too few rows for the banner leave the sky blank.
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { termOf } from "./common";

interface FireworksTerm {
	readonly title: string;
	readonly line: string;
	readonly startedAt: number;
	/** Terminal rows (the layer's height when it fixes one). */
	readonly rows?: number;
}

/** Frame length of the animation. */
const FRAME_MS = 80;
const BANNER_MAX = 62;
/** Rows the banner takes. */
const BANNER_ROWS = 3;

/** A small deterministic hash: the same cell and frame always draw the same. */
function hash(a: number, b: number, c = 0): number {
	let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The sky at `frame`: stars, rising rockets and bursts. */
function sky(theme: Theme, width: number, height: number, frame: number): string[] {
	const cells: { ch: string; color: string }[][] = Array.from({ length: height }, () =>
		Array.from({ length: width }, () => ({ ch: " ", color: "" })),
	);
	const put = (row: number, col: number, ch: string, color: string) => {
		if (row >= 0 && row < height && col >= 0 && col < width) cells[row]![col] = { ch, color };
	};
	for (let row = 0; row < height; row++) {
		for (let col = 0; col < width; col++) {
			const seed = hash(row, col);
			if (seed < 0.025) put(row, col, hash(row, col, Math.floor(frame / 6)) < 0.25 ? "+" : ".", "dim");
		}
	}
	// A rocket every few frames: it rises for a while, then bursts.
	const period = 12;
	const colors = ["accent", "warning", "mdLink", "success", "thinkingXhigh"];
	for (let launch = Math.floor(frame / period) - 3; launch <= Math.floor(frame / period); launch++) {
		if (launch < 0) continue;
		const age = frame - launch * period;
		const col = Math.floor(hash(launch, 7) * Math.max(1, width - 8)) + 4;
		const peak = Math.floor(hash(launch, 11) * Math.max(1, height - 4)) + 1;
		const color = colors[launch % colors.length]!;
		const rise = Math.max(1, height - peak);
		if (age < rise) {
			const row = height - 1 - age;
			put(row, col, "^", "text");
			put(row + 1, col, "|", "accent");
			continue;
		}
		const radius = age - rise;
		if (radius > 6) continue;
		const glyph = radius < 2 ? "*" : radius < 4 ? "o" : ".";
		for (let k = 0; k < 12; k++) {
			const angle = (k / 12) * Math.PI * 2;
			put(
				peak + Math.round(Math.sin(angle) * radius * 0.5),
				col + Math.round(Math.cos(angle) * radius),
				glyph,
				color,
			);
		}
	}
	return cells.map(row => {
		let out = "";
		for (const cell of row) out += cell.color ? theme.fg(cell.color, cell.ch) : cell.ch;
		return out.trimEnd();
	});
}

defineRolePainter("col", "omp.fireworks", (node, cx): Block => {
	const theme = cx.theme;
	const term = termOf<FireworksTerm>(node);
	const screen = cx.height ?? term.rows ?? 36;
	const height = Math.max(1, Math.floor(screen * 0.33));
	if (height < BANNER_ROWS + 1) return { rows: Array.from({ length: height }, () => "") };
	const frame = Math.max(0, Math.floor((cx.now() - (term.startedAt ?? cx.now())) / FRAME_MS));
	const rows = sky(theme, cx.width, height - BANNER_ROWS, frame);
	const box = theme.symbols.box;
	const width = Math.min(cx.width, BANNER_MAX);
	const lead = " ".repeat(Math.floor((cx.width - width) / 2));
	const inner = Math.max(0, width - 2);
	const title = ` ${[...(term.title ?? "").toUpperCase()].join(" ").replace(/ {3}/g, "   ")} `;
	const shownTitle = truncate(title, inner, "");
	const fill = inner - visibleWidth(shownTitle);
	const edge = (text: string) => theme.fg("thinkingXhigh", text);
	rows.push(
		`${lead}${edge(`${box.topLeft}${box.horizontal.repeat(Math.floor(fill / 2))}`)}${theme.fg("warning", shownTitle)}${edge(`${box.horizontal.repeat(Math.ceil(fill / 2))}${box.topRight}`)}`,
	);
	const line = truncate(`${term.line ?? ""} · ⎋ to return`, inner, "");
	const pad = inner - visibleWidth(line);
	rows.push(
		`${lead}${edge(`${box.vertical}${" ".repeat(Math.floor(pad / 2))}`)}${theme.fg("mdLink", line)}${edge(`${" ".repeat(Math.ceil(pad / 2))}${box.vertical}`)}`,
	);
	rows.push(`${lead}${edge(`${box.bottomLeft}${box.horizontal.repeat(inner)}${box.bottomRight}`)}`);
	return { rows };
});
