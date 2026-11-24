/**
 * One-line rendering of parsed LaTeX: unicode glyphs, unicode scripts where
 * every character has one (`^(…)`/`_(…)` otherwise), `a/b` fractions, and
 * text styles and colors as SGR.
 *
 * Output is a list of segments, each with the style frame it was drawn in;
 * `serialize` turns them into SGR. A style command opens a new frame
 * instance, so nested `\textbf` closes and re-opens bold while a color
 * change simply switches color.
 */
import type { LatexOptions } from "../latex";
import type { ColorSpec, FontName, MathNode, StyleChange } from "./parse";
import { fontGlyph, SUBSCRIPTS, SUPERSCRIPTS, VULGAR_FRACTIONS } from "./symbols";

interface Color {
	readonly sgr: string;
}

/** The style in effect: each set attribute is the instance of the command that set it. */
export interface Frame {
	readonly bold?: object;
	readonly italic?: object;
	readonly fg?: Color;
	readonly bg?: Color;
	/** Math alphabet letters are drawn in (`\mathbb`, `\mathbf`); not an SGR attribute. */
	readonly font?: Exclude<FontName, "plain">;
}

/** A run of text drawn in one frame. */
export interface Segment {
	readonly t: string;
	readonly f: Frame;
}

export const PLAIN: Frame = {};

// ─── Colors ─────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

/** xcolor's base colors (where they differ from or extend CSS). */
const XCOLOR: Readonly<Record<string, Rgb>> = {
	red: [255, 0, 0],
	green: [0, 255, 0],
	blue: [0, 0, 255],
	cyan: [0, 255, 255],
	magenta: [255, 0, 255],
	yellow: [255, 255, 0],
	black: [0, 0, 0],
	white: [255, 255, 255],
	gray: [128, 128, 128],
	darkgray: [64, 64, 64],
	lightgray: [191, 191, 191],
	brown: [191, 128, 64],
	lime: [191, 255, 0],
	olive: [128, 128, 0],
	orange: [255, 128, 0],
	pink: [255, 191, 191],
	purple: [191, 0, 64],
	teal: [0, 128, 128],
	violet: [128, 0, 128],
};

function namedColor(name: string): Rgb | undefined {
	const trimmed = name.trim();
	const base = XCOLOR[trimmed];
	if (base !== undefined) return base;
	const rgb = Bun.color(trimmed, "[rgb]");
	return rgb === null ? undefined : [rgb[0], rgb[1], rgb[2]];
}

function numbers(value: string, scale: number): number[] {
	return value.split(",").map(part => Number(part.trim()) * scale);
}

/** An xcolor expression: `name`, `name!pct`, `name!pct!name…`, or a model value. */
function resolveRgb(spec: ColorSpec): Rgb | undefined {
	const value = spec.value.trim();
	switch (spec.model?.trim()) {
		case "HTML":
			return namedColor(`#${value}`);
		case "RGB": {
			const [r, g, b] = numbers(value, 1);
			return r === undefined || g === undefined || b === undefined ? undefined : [r, g, b];
		}
		case "rgb": {
			const [r, g, b] = numbers(value, 255);
			return r === undefined || g === undefined || b === undefined ? undefined : [r, g, b];
		}
		case "gray": {
			const [level] = numbers(value, 255);
			return level === undefined ? undefined : [level, level, level];
		}
		case "cmyk": {
			const [c, m, y, k] = numbers(value, 1);
			if (c === undefined || m === undefined || y === undefined || k === undefined) return undefined;
			return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
		}
		case "cmy": {
			const [c, m, y] = numbers(value, 1);
			return c === undefined || m === undefined || y === undefined
				? undefined
				: [255 * (1 - c), 255 * (1 - m), 255 * (1 - y)];
		}
		default:
			break;
	}
	const parts = value.split("!");
	let rgb = namedColor(parts[0]!);
	if (rgb === undefined) return undefined;
	for (let i = 1; i < parts.length; i += 2) {
		const percent = Number(parts[i]);
		if (!Number.isFinite(percent)) return undefined;
		const other = parts[i + 1] === undefined ? XCOLOR.white! : namedColor(parts[i + 1]!);
		if (other === undefined) return undefined;
		const p = Math.min(100, Math.max(0, percent)) / 100;
		const mixed: Rgb = [
			rgb[0] * p + other[0] * (1 - p),
			rgb[1] * p + other[1] * (1 - p),
			rgb[2] * p + other[2] * (1 - p),
		];
		rgb = mixed;
	}
	return rgb;
}

function colorSgr(spec: ColorSpec, background: boolean, options: LatexOptions): Color | undefined {
	const rgb = resolveRgb(spec);
	if (rgb === undefined) return undefined;
	const css = `rgb(${rgb.map(channel => Math.round(Math.min(255, Math.max(0, channel)))).join(", ")})`;
	const sgr = Bun.color(css, options.trueColor === false ? "ansi-256" : "ansi-16m");
	if (sgr === null) return undefined;
	return { sgr: background ? sgr.replace("\x1b[38;", "\x1b[48;") : sgr };
}

/** The frame a style command opens inside `frame`. */
export function applyStyle(frame: Frame, style: StyleChange, options: LatexOptions): Frame {
	let next: Frame = frame;
	if (style.bold !== undefined) next = { ...next, bold: style.bold ? {} : undefined };
	if (style.italic !== undefined) next = { ...next, italic: style.italic ? {} : undefined };
	if (style.fg !== undefined) {
		const fg = colorSgr(style.fg, false, options);
		if (fg !== undefined) next = { ...next, fg };
	}
	if (style.bg !== undefined) {
		const bg = colorSgr(style.bg, true, options);
		if (bg !== undefined) next = { ...next, bg };
	}
	return next;
}

// ─── Serializing ────────────────────────────────────────────────────────────

/** SGR moving from frame `from` to `to`: closes first, then opens, in attribute order. */
function transition(from: Frame, to: Frame): string {
	let closes = "";
	let opens = "";
	if (from.bold !== to.bold) {
		if (from.bold !== undefined) closes += "\x1b[22m";
		if (to.bold !== undefined) opens += "\x1b[1m";
	}
	if (from.italic !== to.italic) {
		if (from.italic !== undefined) closes += "\x1b[23m";
		if (to.italic !== undefined) opens += "\x1b[3m";
	}
	if (from.fg !== to.fg) {
		if (to.fg === undefined) closes += "\x1b[39m";
		else opens += to.fg.sgr;
	}
	if (from.bg !== to.bg) {
		if (to.bg === undefined) closes += "\x1b[49m";
		else opens += to.bg.sgr;
	}
	return closes + opens;
}

/** Segments as a styled string that ends with every style closed. */
export function serialize(segments: readonly Segment[]): string {
	let out = "";
	let frame = PLAIN;
	for (const segment of segments) {
		if (segment.t === "") continue;
		out += transition(frame, segment.f) + segment.t;
		frame = segment.f;
	}
	return out + transition(frame, PLAIN);
}

/** The visible text of segments. */
export function plainText(segments: readonly Segment[]): string {
	let out = "";
	for (const segment of segments) out += segment.t;
	return out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCount(text: string): number {
	let count = 0;
	for (const _ of segmenter.segment(text)) count++;
	return count;
}

/** Segments without leading and trailing whitespace. */
export function trimSegments(segments: readonly Segment[]): Segment[] {
	const out = segments.filter(segment => segment.t !== "");
	while (out.length > 0 && out[0]!.t.trimStart() === "") out.shift();
	while (out.length > 0 && out[out.length - 1]!.t.trimEnd() === "") out.pop();
	if (out.length === 0) return out;
	out[0] = { t: out[0]!.t.trimStart(), f: out[0]!.f };
	const last = out.length - 1;
	out[last] = { t: out[last]!.t.trimEnd(), f: out[last]!.f };
	return out;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** `segments` as unicode scripts when all are in `frame` and every character has a script form. */
export function scriptGlyphs(segments: readonly Segment[], frame: Frame, kind: "sub" | "sup"): string | undefined {
	const table = kind === "sup" ? SUPERSCRIPTS : SUBSCRIPTS;
	let out = "";
	for (const segment of segments) {
		if (segment.f !== frame && segment.t !== "") return undefined;
		for (const char of segment.t) {
			const glyph = table[char];
			if (glyph === undefined) return undefined;
			out += glyph;
		}
	}
	return out === "" ? undefined : out;
}

function isPlainIn(segments: readonly Segment[], frame: Frame): boolean {
	return segments.every(segment => segment.f === frame || segment.t === "");
}

/** A script in one line: unicode glyphs, else `^x` / `^(…)` (parentheses for several glyphs or styled text). */
function script(segments: Segment[], frame: Frame, kind: "sub" | "sup"): Segment[] {
	if (plainText(segments) === "") return [];
	const glyphs = scriptGlyphs(segments, frame, kind);
	if (glyphs !== undefined) return [{ t: glyphs, f: frame }];
	const marker = kind === "sup" ? "^" : "_";
	if (graphemeCount(plainText(segments)) > 1 || !isPlainIn(segments, frame)) {
		return [{ t: `${marker}(`, f: frame }, ...segments, { t: ")", f: frame }];
	}
	return [{ t: marker, f: frame }, ...segments];
}

function parenthesize(segments: Segment[], frame: Frame): Segment[] {
	return graphemeCount(plainText(segments)) > 1 ? [{ t: "(", f: frame }, ...segments, { t: ")", f: frame }] : segments;
}

/** `mark` (a combining character) after the last grapheme, or after every grapheme when `each`. */
export function applyAccent(segments: Segment[], mark: string, each: boolean): Segment[] {
	if (each) {
		return segments.map(segment => {
			let t = "";
			for (const { segment: grapheme } of segmenter.segment(segment.t))
				t += grapheme.trim() === "" ? grapheme : grapheme + mark;
			return { t, f: segment.f };
		});
	}
	const out = [...segments];
	for (let i = out.length - 1; i >= 0; i--) {
		if (out[i]!.t.trim() === "") continue;
		out[i] = { t: `${out[i]!.t.trimEnd()}${mark}${out[i]!.t.slice(out[i]!.t.trimEnd().length)}`, f: out[i]!.f };
		break;
	}
	return out;
}

/** The frame a math alphabet command opens (`plain` returns to ordinary letters). */
export function withFont(frame: Frame, font: FontName): Frame {
	return { ...frame, font: font === "plain" ? undefined : font };
}

function inFont(text: string, frame: Frame): string {
	const font = frame.font;
	if (font === undefined) return text;
	let out = "";
	for (const char of text) out += fontGlyph(font, char);
	return out;
}

const MATRIX_DELIMITERS: Readonly<Record<string, readonly [string, string]>> = {
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	subarray: ["", ""],
	cases: ["{", ""],
	dcases: ["{", ""],
	rcases: ["", "}"],
};

/** The base name of an environment (`align*` → `align`). */
export function envBase(name: string): string {
	return name.endsWith("*") ? name.slice(0, -1) : name;
}

/** Whether an environment lays its cells out as a grid (vs. alignment rows). */
export function isGridEnvironment(name: string): boolean {
	return MATRIX_DELIMITERS[envBase(name)] !== undefined;
}

/** The delimiters a grid environment draws around its cells. */
export function gridDelimiters(name: string): readonly [string, string] {
	return MATRIX_DELIMITERS[envBase(name)] ?? ["", ""];
}

/** Parsed LaTeX as segments in one line. */
export function renderInline(nodes: readonly MathNode[], frame: Frame, options: LatexOptions): Segment[] {
	const out: Segment[] = [];
	for (const node of nodes) out.push(...renderNode(node, frame, options));
	return out;
}

function renderNode(node: MathNode, frame: Frame, options: LatexOptions): Segment[] {
	switch (node.k) {
		case "text":
			return [{ t: inFont(node.t, frame), f: frame }];
		case "middle":
			return [{ t: node.t, f: frame }];
		case "op":
			return [{ t: node.t, f: frame }];
		case "group":
		case "brace":
			return renderInline(node.c, frame, options);
		case "style":
			return renderInline(node.c, applyStyle(frame, node.style, options), options);
		case "font":
			return renderInline(node.c, withFont(frame, node.font), options);
		case "frac": {
			const num = trimSegments(renderInline(node.num, frame, options));
			const den = trimSegments(renderInline(node.den, frame, options));
			if (!node.bar) return [{ t: "C(", f: frame }, ...num, { t: ", ", f: frame }, ...den, { t: ")", f: frame }];
			if (isPlainIn(num, frame) && isPlainIn(den, frame)) {
				const vulgar = VULGAR_FRACTIONS[`${plainText(num)}/${plainText(den)}`];
				if (vulgar !== undefined) return [{ t: vulgar, f: frame }];
			}
			return [...parenthesize(num, frame), { t: "/", f: frame }, ...parenthesize(den, frame)];
		}
		case "sqrt": {
			const body = parenthesize(trimSegments(renderInline(node.c, frame, options)), frame);
			if (node.index === undefined) return [{ t: "√", f: frame }, ...body];
			const index = plainText(renderInline(node.index, frame, options)).trim();
			if (index === "3") return [{ t: "∛", f: frame }, ...body];
			if (index === "4") return [{ t: "∜", f: frame }, ...body];
			const glyphs = scriptGlyphs([{ t: index, f: frame }], frame, "sup");
			return [{ t: `${glyphs ?? `${index}`}√`, f: frame }, ...body];
		}
		case "scripts": {
			const out = node.base === undefined ? [] : renderNode(node.base, frame, options);
			const order: ("sub" | "sup")[] = node.first === "sub" ? ["sub", "sup"] : ["sup", "sub"];
			for (const kind of order) {
				const content = node[kind];
				if (content !== undefined)
					out.push(...script(trimSegments(renderInline(content, frame, options)), frame, kind));
			}
			return out;
		}
		case "accent":
			return applyAccent(renderInline(node.c, frame, options), node.mark, node.each);
		case "delim": {
			const out: Segment[] = [];
			if (node.left !== "") out.push({ t: node.left, f: frame });
			out.push(...trimSegments(renderInline(node.c, frame, options)));
			if (node.right !== "") out.push({ t: node.right, f: frame });
			return out;
		}
		case "wrap":
			return [{ t: node.open, f: frame }, ...renderInline(node.c, frame, options), { t: node.close, f: frame }];
		case "xarrow": {
			const out: Segment[] = [{ t: node.t, f: frame }];
			out.push(...script(trimSegments(renderInline(node.above, frame, options)), frame, "sup"));
			if (node.below !== undefined) {
				out.push(...script(trimSegments(renderInline(node.below, frame, options)), frame, "sub"));
			}
			return out;
		}
		case "env": {
			const grid = isGridEnvironment(node.name);
			const rows = node.rows.map(row => {
				if (!grid) return trimSegments(row.flatMap(cell => renderInline(cell, frame, options)));
				const cells: Segment[] = [];
				row.forEach((cell, index) => {
					if (index > 0) cells.push({ t: "  ", f: frame });
					cells.push(...trimSegments(renderInline(cell, frame, options)));
				});
				return cells;
			});
			const out: Segment[] = [];
			const [open, close] = gridDelimiters(node.name);
			if (open !== "") out.push({ t: open, f: frame });
			rows.forEach((row, index) => {
				if (index > 0) out.push({ t: "; ", f: frame });
				out.push(...row);
			});
			if (close !== "") out.push({ t: close, f: frame });
			return out;
		}
	}
}
