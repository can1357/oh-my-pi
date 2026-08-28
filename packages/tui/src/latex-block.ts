// Two-dimensional layout engine for *display* LaTeX math.
//
//              ┌─────────       n         ⎛  a+b  ⎞²
//        −b ± ╲│ b² − 4ac       ∑   xᵢ    ⎜ ───── ⎟     ⎡ 1  2 ⎤
//   x = ──────────────────    i=0         ⎝   c   ⎠     ⎣ 3  4 ⎦
//               2a
//
// Only display blocks (`$$…$$`, `\[…\]`) use this; inline `$…$` stays single-line
// via `latexToUnicode` (`½`, `(a+b)/c`). The engine lays out a `Box` tree —
// rectangles of padded lines with a `baseline` row — and knows how to stack
// fractions and `\binom`, stretch delimiters (`\left…\right`, tall bare parens,
// matrix brackets), render matrix/cases/array environments as baseline-aligned
// grids, place big-operator limits (`\sum`, `\lim`, `\int\limits`) above and
// below the symbol, draw radicals, raise/lower block scripts, draw labeled
// horizontal braces (`\underbrace{x}_{lbl}`), stack `\overset`/`\underset`, and
// align `&` columns in `align`-family environments. Flat runs — symbols, fonts,
// colors, inline scripts — are delegated to `latexToUnicode`.
//
// The 2-D layout approach (stretchy delimiter piecing, stacked operator limits,
// baseline-aligned matrix grids, drawn radicals, block scripts) is modeled on
// txm — Terminal TeX Math — by @thatmagicalcat
// (https://github.com/thatmagicalcat/txm, MIT/Apache-2.0), reimplemented from
// scratch here on this module's ANSI-aware Box model.

import { latexColorScope, latexToUnicode, MATH_FONT_COMMANDS } from "./latex-to-unicode";
import { visibleWidth } from "./utils";

/**
 * A rectangular block of rendered text. Every entry in `lines` is padded to
 * exactly `width` visible columns; `baseline` is the row that aligns with the
 * surrounding text when boxes are placed side by side (e.g. the fraction bar).
 */
interface Box {
	lines: string[];
	baseline: number;
	width: number;
}

type CellAlign = "l" | "c" | "r";

const BAR = "─";
const FRAC_COMMANDS: Record<string, true> = { frac: true, dfrac: true, tfrac: true, cfrac: true };
const BINOM_COMMANDS: Record<string, true> = { binom: true, dbinom: true, tbinom: true };

// Display "wrapper" environments whose body is an expression (possibly with `\\`
// row breaks and `&` alignment). Their rows are parsed so fractions inside stack
// and `&` columns align.
const DISPLAY_ROW_ENVIRONMENTS: Record<string, true> = {
	equation: true,
	eqnarray: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	flalign: true,
	split: true,
	gather: true,
	gathered: true,
	gatheredat: true,
	multline: true,
	displaymath: true,
	math: true,
};

// Environments laid out as 2-D grids of parsed cells: [open, close] delimiter.
const GRID_ENVIRONMENTS: Record<string, readonly [string, string]> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	dcases: ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
};

// Operators whose display-style scripts stack above/below the symbol.
const LIMIT_OPERATORS: Record<string, true> = {
	sum: true,
	prod: true,
	coprod: true,
	bigcup: true,
	bigcap: true,
	bigsqcup: true,
	bigvee: true,
	bigwedge: true,
	bigoplus: true,
	bigotimes: true,
	bigodot: true,
	biguplus: true,
	lim: true,
	limsup: true,
	liminf: true,
	projlim: true,
	injlim: true,
	varlimsup: true,
	varliminf: true,
	varprojlim: true,
	varinjlim: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	gcd: true,
	Pr: true,
	argmax: true,
	argmin: true,
};

// Integral-family operators: scripts stay beside the symbol (LaTeX display
// convention) unless an explicit `\limits` follows.
const INTEGRAL_OPERATORS: Record<string, true> = {
	int: true,
	iint: true,
	iiint: true,
	iiiint: true,
	oint: true,
	oiint: true,
	oiiint: true,
	idotsint: true,
	intop: true,
	smallint: true,
};

// Horizontal brace/bracket decorations drawn as a rule row beside the content,
// with an optional limits-style label beyond the rule (`\underbrace{x}_{lbl}`).
interface HBraceSpec {
	left: string;
	mid: string;
	center: string;
	right: string;
	over: boolean;
}

const HBRACE_COMMANDS: Record<string, HBraceSpec> = {
	overbrace: { left: "╭", mid: "─", center: "┴", right: "╮", over: true },
	underbrace: { left: "╰", mid: "─", center: "┬", right: "╯", over: false },
	overbracket: { left: "┌", mid: "─", center: "─", right: "┐", over: true },
	underbracket: { left: "└", mid: "─", center: "─", right: "┘", over: false },
	overparen: { left: "╭", mid: "─", center: "─", right: "╮", over: true },
	underparen: { left: "╰", mid: "─", center: "─", right: "╯", over: false },
};

/**
 * Number of required arguments each display command consumes. Shared by
 * {@link readArg} and {@link splitLines} so nested command atoms consume exactly
 * their own arguments while preserving any outer command's pending arity.
 */
const COMMAND_ARITY: Record<string, number> = { overset: 2, underset: 2, stackrel: 2, sqrt: 1 };
for (const name in FRAC_COMMANDS) COMMAND_ARITY[name] = 2;
for (const name in BINOM_COMMANDS) COMMAND_ARITY[name] = 2;
for (const name in HBRACE_COMMANDS) COMMAND_ARITY[name] = 1;

// Vertical delimiter piece characters: `only` for single-line content, then
// top/mid/bot columns for stretched forms; `axis` replaces `mid` at the
// baseline row (the brace point).
interface DelimPieces {
	only: string;
	top: string;
	mid: string;
	bot: string;
	axis?: string;
}

const DELIM_PIECES: Record<string, DelimPieces> = {
	"(": { only: "(", top: "⎛", mid: "⎜", bot: "⎝" },
	")": { only: ")", top: "⎞", mid: "⎟", bot: "⎠" },
	"[": { only: "[", top: "⎡", mid: "⎢", bot: "⎣" },
	"]": { only: "]", top: "⎤", mid: "⎥", bot: "⎦" },
	"{": { only: "{", top: "⎧", mid: "⎪", bot: "⎩", axis: "⎨" },
	"}": { only: "}", top: "⎫", mid: "⎪", bot: "⎭", axis: "⎬" },
	"|": { only: "|", top: "│", mid: "│", bot: "│" },
	"‖": { only: "‖", top: "║", mid: "║", bot: "║" },
	"⌈": { only: "⌈", top: "⎡", mid: "⎢", bot: "⎢" },
	"⌉": { only: "⌉", top: "⎤", mid: "⎥", bot: "⎥" },
	"⌊": { only: "⌊", top: "⎢", mid: "⎢", bot: "⎣" },
	"⌋": { only: "⌋", top: "⎥", mid: "⎥", bot: "⎦" },
};

// `\left`/`\right`/`\middle` delimiter token → piece-table key. Unknown tokens
// fall back to `latexToUnicode` and render at the baseline row only.
const DELIM_KEYS: Record<string, string> = {
	"(": "(",
	")": ")",
	"[": "[",
	"]": "]",
	"\\{": "{",
	"\\}": "}",
	"\\lbrace": "{",
	"\\rbrace": "}",
	"|": "|",
	"\\vert": "|",
	"\\lvert": "|",
	"\\rvert": "|",
	"\\|": "‖",
	"\\Vert": "‖",
	"\\lVert": "‖",
	"\\rVert": "‖",
	"\\langle": "⟨",
	"\\rangle": "⟩",
	"<": "⟨",
	">": "⟩",
	"\\lceil": "⌈",
	"\\rceil": "⌉",
	"\\lfloor": "⌊",
	"\\rfloor": "⌋",
	"\\lbrack": "[",
	"\\rbrack": "]",
	".": "",
};

/**
 * Inline-run conversion context. `wrap` re-applies the scoped commands (math
 * fonts, colors) active at this point in the parse, so each flat run handed to
 * `latexToUnicode` renders with the same styling it would have had in one piece.
 */
interface Ctx {
	wrap: (run: string) => string;
}

const ROOT_CTX: Ctx = { wrap: run => run };

function spaces(n: number): string {
	return n > 0 ? " ".repeat(n) : "";
}

/** Pad `line` on the right to `width` visible columns. */
function padRight(line: string, width: number): string {
	return line + spaces(width - visibleWidth(line));
}

/** Pad `line` symmetrically (left-biased) to `width` visible columns. */
function center(line: string, width: number): string {
	const extra = width - visibleWidth(line);
	if (extra <= 0) return line;
	const left = extra >> 1;
	return spaces(left) + line + spaces(extra - left);
}

/** A single rendered string (possibly multi-line) as a baseline-centered box. */
function textBox(text: string): Box {
	const raw = text.split("\n");
	let width = 0;
	for (const line of raw) width = Math.max(width, visibleWidth(line));
	return { lines: raw.map(line => padRight(line, width)), baseline: (raw.length - 1) >> 1, width };
}

/** Pad every line of `b` to `width` per `align`, keeping the baseline. */
function padBox(b: Box, width: number, align: CellAlign): Box {
	if (b.width >= width) return b;
	const lines = b.lines.map(line => {
		const extra = width - visibleWidth(line);
		if (align === "l") return line + spaces(extra);
		if (align === "r") return spaces(extra) + line;
		const left = extra >> 1;
		return spaces(left) + line + spaces(extra - left);
	});
	return { lines, baseline: b.baseline, width };
}

/** Place boxes side by side, aligning their baselines. */
function hconcat(boxes: Box[]): Box {
	if (boxes.length === 1) return boxes[0];
	let above = 0;
	let below = 0;
	for (const b of boxes) {
		above = Math.max(above, b.baseline);
		below = Math.max(below, b.lines.length - 1 - b.baseline);
	}
	const height = above + below + 1;
	const lines: string[] = [];
	let width = 0;
	for (const b of boxes) width += b.width;
	for (let row = 0; row < height; row++) {
		let line = "";
		for (const b of boxes) {
			const local = row - (above - b.baseline);
			line += local >= 0 && local < b.lines.length ? b.lines[local] : spaces(b.width);
		}
		lines.push(line);
	}
	return { lines, baseline: above, width };
}

/** Stack boxes vertically, e.g. the rows of an aligned block. */
function vconcat(boxes: Box[], align: CellAlign = "l"): Box {
	if (boxes.length === 1) return boxes[0];
	let width = 0;
	for (const b of boxes) width = Math.max(width, b.width);
	const lines: string[] = [];
	for (const b of boxes) {
		for (const line of b.lines) lines.push(align === "c" ? center(line, width) : padRight(line, width));
	}
	return { lines, baseline: (lines.length - 1) >> 1, width };
}

/** Stack `num` over `den`, separated by a bar; the bar becomes the baseline. */
function fracBox(num: Box, den: Box): Box {
	const width = Math.max(num.width, den.width) + 2;
	const lines = [
		...num.lines.map(line => center(line, width)),
		BAR.repeat(width),
		...den.lines.map(line => center(line, width)),
	];
	return { lines, baseline: num.lines.length, width };
}

/**
 * One vertical delimiter column of `height` rows for piece-table key `key`
 * (`"("`, `"{"`, …); null when `key` is empty (`\left.`). Unknown keys render a
 * single glyph at the baseline row.
 */
function delimColumn(key: string, height: number, baseline: number): Box | null {
	if (!key) return null;
	const pieces = DELIM_PIECES[key];
	if (height <= 1) {
		const only = pieces?.only ?? key;
		return only ? { lines: [only], baseline: 0, width: visibleWidth(only) } : null;
	}
	const width = visibleWidth(pieces?.only ?? key);
	const blank = spaces(width);
	const lines: string[] = [];
	if (!pieces) {
		for (let y = 0; y < height; y++) lines.push(y === baseline ? key : blank);
		return { lines, baseline, width };
	}
	const axisRow = Math.min(Math.max(baseline, 1), height - 2);
	for (let y = 0; y < height; y++) {
		if (y === 0) lines.push(pieces.top);
		else if (y === height - 1) lines.push(pieces.bot);
		else if (y === axisRow && pieces.axis) lines.push(pieces.axis);
		else lines.push(pieces.mid);
	}
	return { lines, baseline, width };
}

/** Wrap `inner` in (possibly stretched) delimiters, padding tall content. */
function delimBox(inner: Box, left: string, right: string): Box {
	const height = inner.lines.length;
	const lcol = delimColumn(left, height, inner.baseline);
	const rcol = delimColumn(right, height, inner.baseline);
	if (!lcol && !rcol) return inner;
	const pad: Box | null = height > 1 ? textBox(" ") : null;
	const parts: Box[] = [];
	if (lcol) parts.push(lcol);
	if (pad) parts.push(pad);
	parts.push(inner);
	if (pad) parts.push(pad);
	if (rcol) parts.push(rcol);
	return hconcat(parts);
}

/** `\binom{n}{k}`: `n` over `k` (no bar) inside stretched parentheses. */
function binomBox(top: Box, bottom: Box): Box {
	const width = Math.max(top.width, bottom.width);
	const lines = [
		...top.lines.map(line => center(line, width)),
		spaces(width),
		...bottom.lines.map(line => center(line, width)),
	];
	return delimBox({ lines, baseline: top.lines.length, width }, "(", ")");
}

/**
 * A drawn radical for a multi-line radicand: overline row on top, bar column
 * on the left, hook at the bottom. Single-line radicands stay flat (`√x̄`).
 */
function radicalBox(inner: Box, degree: string | null): Box {
	const lines: string[] = [` ┌${BAR.repeat(inner.width + 1)}`];
	for (let y = 0; y < inner.lines.length; y++) {
		lines.push((y === inner.lines.length - 1 ? "╲│ " : " │ ") + inner.lines[y]);
	}
	const box: Box = { lines, baseline: inner.baseline + 1, width: inner.width + 3 };
	if (!degree) return box;
	const deg = latexToUnicode(`^{${degree}}`);
	// Degree sits one row above the baseline, at the radical's upper left.
	return hconcat([{ lines: [deg, spaces(visibleWidth(deg))], baseline: 1, width: visibleWidth(deg) }, box]);
}

/** Big operator with limits: `sup` centered above `glyph`, `sub` below. */
function limitsBox(glyph: Box, sub: Box | null, sup: Box | null): Box {
	const width = Math.max(glyph.width, sub?.width ?? 0, sup?.width ?? 0);
	const lines: string[] = [];
	if (sup) for (const line of sup.lines) lines.push(center(line, width));
	const baseline = lines.length + glyph.baseline;
	for (const line of glyph.lines) lines.push(center(line, width));
	if (sub) for (const line of sub.lines) lines.push(center(line, width));
	return { lines, baseline, width };
}

/**
 * `\underbrace{content}_{label}` / `\overbrace{content}^{label}`: the content
 * with a drawn horizontal brace beside it and the label centered beyond the
 * brace. The baseline stays on the content so neighbors align with it.
 */
function hbraceBox(content: Box, spec: HBraceSpec, label: Box | null): Box {
	const braceWidth = Math.max(content.width, 3);
	const width = Math.max(braceWidth, label?.width ?? 0);
	const lead = (braceWidth - 3) >> 1;
	const brace = center(
		spec.left + spec.mid.repeat(lead) + spec.center + spec.mid.repeat(braceWidth - 3 - lead) + spec.right,
		width,
	);
	const contentLines = content.lines.map(line => center(line, width));
	const labelLines = label === null ? [] : label.lines.map(line => center(line, width));
	if (spec.over) {
		return {
			lines: [...labelLines, brace, ...contentLines],
			baseline: labelLines.length + 1 + content.baseline,
			width,
		};
	}
	return { lines: [...contentLines, brace, ...labelLines], baseline: content.baseline, width };
}

/**
 * Attach block scripts to `base` as one shared right-hand column: the
 * superscript ends level with the base's top row (raised one row above a
 * single-line base), the subscript starts level with its bottom row (lowered
 * one row below a single-line base).
 */
function attachScripts(base: Box, sub: Box | null, sup: Box | null): Box {
	if (sub === null && sup === null) return base;
	const single = base.lines.length === 1;
	const width = Math.max(sub?.width ?? 0, sup?.width ?? 0);
	const blank = spaces(width);
	const lines: string[] = [];
	let baseline = 0;
	if (sup) {
		const lift = single ? 1 : base.baseline;
		for (const line of sup.lines) lines.push(padRight(line, width));
		for (let k = 0; k < lift; k++) lines.push(blank);
		baseline = lines.length - 1;
	}
	if (sub) {
		const below = base.lines.length - 1 - base.baseline - (sub.lines.length - 1);
		let drop = Math.max(below, single ? 1 : 0);
		if (sup && drop < 1) drop = 1;
		// Rows between the baseline row and the subscript's top row.
		const gap = lines.length === 0 ? drop : drop - 1;
		for (let k = 0; k < gap; k++) lines.push(blank);
		for (const line of sub.lines) lines.push(padRight(line, width));
	}
	return hconcat([base, { lines, baseline, width }]);
}

/**
 * Lay out parsed cells as a grid: per-column width/alignment, per-gap width.
 * With `rowGap > 0` (matrix-family environments), blank rows separate the grid
 * rows and the total height is forced odd, so the baseline sits at the true
 * vertical center — `A = [matrix]` centers on the brackets, and stretched
 * braces get a real middle piece even for two content rows.
 */
function gridBox(rows: Box[][], align: (col: number) => CellAlign, gap: (col: number) => number, rowGap = 0): Box {
	let ncols = 0;
	for (const row of rows) ncols = Math.max(ncols, row.length);
	if (ncols === 0 || rows.length === 0) return textBox("");
	const widths = new Array<number>(ncols).fill(0);
	for (const row of rows) {
		row.forEach((cell, j) => {
			widths[j] = Math.max(widths[j], cell.width);
		});
	}
	const rowBoxes: Box[] = [];
	for (const row of rows) {
		if (rowGap > 0 && rowBoxes.length > 0) {
			for (let g = 0; g < rowGap; g++) rowBoxes.push({ lines: [""], baseline: 0, width: 0 });
		}
		const parts: Box[] = [];
		for (let j = 0; j < ncols; j++) {
			if (j > 0) {
				const g = gap(j);
				if (g > 0) parts.push({ lines: [spaces(g)], baseline: 0, width: g });
			}
			parts.push(padBox(row[j] ?? { lines: [""], baseline: 0, width: 0 }, widths[j], align(j)));
		}
		rowBoxes.push(hconcat(parts));
	}
	const grid = vconcat(rowBoxes);
	if (rowGap > 0 && rows.length > 1 && grid.lines.length % 2 === 0) {
		return { lines: [...grid.lines, spaces(grid.width)], baseline: grid.lines.length >> 1, width: grid.width };
	}
	return grid;
}

interface Span {
	text: string;
	end: number;
}

/** Read a balanced `{…}` beginning at `i` (which must point at `{`). */
function readBraceGroup(src: string, i: number): Span {
	let depth = 0;
	let out = "";
	let j = i;
	for (; j < src.length; j++) {
		const c = src[j];
		if (c === "\\") {
			out += c + (src[j + 1] ?? "");
			j++;
			continue;
		}
		if (c === "{") {
			depth++;
			if (depth > 1) out += c;
			continue;
		}
		if (c === "}") {
			depth--;
			if (depth === 0) {
				j++;
				break;
			}
			out += c;
			continue;
		}
		out += c;
	}
	return { text: out, end: j };
}

/**
 * Read one command argument: a `{…}` group, a single char, or a `\command`
 * together with its arguments (or whole `\begin…\end` block). Commands whose
 * arity is known consume exactly that many arguments, including across source
 * whitespace, so `\frac\sqrt {a} {b}` reads `\sqrt {a}` as the numerator and
 * leaves `{b}` for the denominator.
 */
function readArg(src: string, i: number): Span {
	while (src[i] === " " || src[i] === "\t" || src[i] === "\n") i++;
	if (i >= src.length) return { text: "", end: i };
	if (src[i] === "{") return readBraceGroup(src, i);
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	let j = i + 1;
	let name = "";
	while (/[A-Za-z]/.test(src[j] ?? "")) {
		name += src[j];
		j++;
	}
	if (name === "begin") {
		const env = consumeEnvironment(src, i);
		if (env) return env;
	}
	if (!name) return { text: src.slice(i, i + 2), end: i + 2 }; // non-letter command (\,, \{, …)

	const arity = COMMAND_ARITY[name];
	if (arity !== undefined) {
		let end = j;
		// Optional command arguments (e.g. the degree in `\sqrt[3]{x}`) do not
		// consume a required-argument slot.
		for (;;) {
			while (src[end] === " " || src[end] === "\t" || src[end] === "\n") end++;
			if (src[end] !== "[") break;
			const close = src.indexOf("]", end);
			end = close === -1 ? src.length : close + 1;
		}
		for (let arg = 0; arg < arity; arg++) end = readArg(src, end).end;
		return { text: src.slice(i, end), end };
	}

	let end = j;
	while (src[end] === "[" || src[end] === "{") {
		if (src[end] === "{") end = readBraceGroup(src, end).end;
		else {
			const close = src.indexOf("]", end);
			end = close === -1 ? src.length : close + 1;
		}
	}
	return { text: src.slice(i, end), end };
}

/** Read a `\left`/`\right`/`\middle` delimiter token (char or `\command`). */
function readDelimToken(src: string, i: number): Span | null {
	while (src[i] === " ") i++;
	if (i >= src.length) return null;
	if (src[i] !== "\\") return { text: src[i], end: i + 1 };
	let j = i + 1;
	if (!/[A-Za-z]/.test(src[j] ?? "")) return { text: src.slice(i, j + 1), end: j + 1 };
	while (/[A-Za-z]/.test(src[j] ?? "")) j++;
	return { text: src.slice(i, j), end: j };
}

/** Piece-table key for a delimiter token; unknown commands resolve via Unicode. */
function delimKey(token: string): string {
	const mapped = DELIM_KEYS[token];
	if (mapped !== undefined) return mapped;
	return token.startsWith("\\") ? latexToUnicode(token).trim() : token;
}

interface LeftRightParts {
	left: string;
	/** Inner source split at top-level `\middle` delimiters. */
	segments: string[];
	middles: string[];
	right: string;
	end: number;
}

/** Parse `\left⟨tok⟩ … \right⟨tok⟩` starting at the backslash of `\left`. */
function readLeftRight(src: string, start: number): LeftRightParts | null {
	const left = readDelimToken(src, start + 5);
	if (!left) return null;
	const segments: string[] = [];
	const middles: string[] = [];
	let depth = 1;
	let k = left.end;
	let segStart = k;
	while (k < src.length) {
		if (src[k] !== "\\") {
			k++;
			continue;
		}
		if (src.startsWith("\\left", k) && !/[A-Za-z]/.test(src[k + 5] ?? "")) {
			depth++;
			const tok = readDelimToken(src, k + 5);
			k = tok ? tok.end : k + 5;
			continue;
		}
		if (src.startsWith("\\right", k) && !/[A-Za-z]/.test(src[k + 6] ?? "")) {
			depth--;
			const tok = readDelimToken(src, k + 6);
			if (depth === 0) {
				segments.push(src.slice(segStart, k));
				return { left: left.text, segments, middles, right: tok ? tok.text : ".", end: tok ? tok.end : k + 6 };
			}
			k = tok ? tok.end : k + 6;
			continue;
		}
		if (depth === 1 && src.startsWith("\\middle", k) && !/[A-Za-z]/.test(src[k + 7] ?? "")) {
			segments.push(src.slice(segStart, k));
			const tok = readDelimToken(src, k + 7);
			middles.push(tok ? tok.text : "|");
			k = segStart = tok ? tok.end : k + 7;
			continue;
		}
		k += 2; // escaped char / other command head — never a boundary
	}
	return null; // unbalanced
}

/**
 * Index of the `close` matching the `open` at `i`, skipping escapes and brace
 * groups; −1 when unbalanced (e.g. interval notation `[0, 1)`).
 */
function matchDelim(src: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let k = i; k < src.length; k++) {
		const c = src[k];
		if (c === "\\") {
			k++;
			continue;
		}
		if (c === "{") {
			k = readBraceGroup(src, k).end - 1;
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

interface EnvParts {
	env: string;
	bodyStart: number;
	bodyEnd: number;
	end: number;
}

/** Locate a `\begin{env}…\end{env}` block (balanced) starting at the backslash. */
function readEnvironment(src: string, start: number): EnvParts | null {
	let i = start + 6; // past "\begin"
	while (src[i] === " ") i++;
	if (src[i] !== "{") return null;
	const nameGroup = readBraceGroup(src, i);
	let k = nameGroup.end;
	let depth = 1;
	let bodyEnd = src.length;
	while (k < src.length && depth > 0) {
		if (src.startsWith("\\begin", k)) {
			depth++;
			k += 6;
			continue;
		}
		if (src.startsWith("\\end", k)) {
			depth--;
			if (depth === 0) bodyEnd = k;
			k += 4;
			while (src[k] === " ") k++;
			if (src[k] === "{") k = readBraceGroup(src, k).end;
			if (depth === 0) break;
			continue;
		}
		k++;
	}
	return { env: nameGroup.text.trim(), bodyStart: nameGroup.end, bodyEnd, end: k };
}

/** The full `\begin{env}…\end{env}` substring as an inline run. */
function consumeEnvironment(src: string, start: number): Span | null {
	const env = readEnvironment(src, start);
	return env ? { text: src.slice(start, env.end), end: env.end } : null;
}

/** Split an environment body on top-level `\\` row breaks (depth-aware). */
function splitRows(body: string): string[] {
	const rows: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < body.length) {
		if (body.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (body.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = body[i];
		if (c === "\\") {
			if (body[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				rows.push(body.slice(last, i));
				i += 2;
				while (body[i] === " ") i++;
				if (body[i] === "[") {
					const close = body.indexOf("]", i);
					i = close === -1 ? body.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2; // skip escaped char / second backslash so `\{`/`\\` never skew depth
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		i++;
	}
	rows.push(body.slice(last));
	return rows;
}

/** Split a row on top-level `&` column separators (depth-aware), trimming cells. */
function splitCells(row: string): string[] {
	const cells: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < row.length) {
		if (row.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (row.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = row[i];
		if (c === "\\") {
			i += 2; // `\&` and command heads never split
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "&" && braceDepth === 0 && envDepth === 0) {
			cells.push(row.slice(last, i));
			last = i + 1;
		}
		i++;
	}
	cells.push(row.slice(last));
	return cells.map(cell => cell.trim());
}

/** Append a script (`^`/`_`) and its argument to the inline run verbatim. */
function readScript(src: string, i: number): Span {
	let out = src[i];
	i++;
	while (src[i] === " ") {
		out += src[i];
		i++;
	}
	if (src[i] === "{") {
		const group = readBraceGroup(src, i);
		return { text: `${out}{${group.text}}`, end: group.end };
	}
	if (src[i] === "\\") {
		let j = i + 1;
		if (/[A-Za-z]/.test(src[j] ?? "")) while (/[A-Za-z]/.test(src[j] ?? "")) j++;
		else j++;
		return { text: out + src.slice(i, j), end: j };
	}
	if (i < src.length) return { text: out + src[i], end: i + 1 };
	return { text: out, end: i };
}

/** Bare argument of a script read by `readScript` (`^{ab}` → `ab`, `^a` → `a`). */
function scriptArgOf(text: string): string {
	let arg = text.slice(1).trimStart();
	if (arg.startsWith("{") && arg.endsWith("}")) arg = arg.slice(1, -1);
	return arg;
}

/**
 * Render a `\begin{env}…\end{env}` block. Grid environments (matrix family,
 * cases, array) become baseline-aligned 2-D grids in stretched delimiters;
 * wrapper environments (`align`, `gather`, …) parse each `\\` row, aligning `&`
 * columns; anything else (tabular, …) renders flat via `latexToUnicode`.
 */
function parseEnvironment(src: string, start: number, ctx: Ctx): { box: Box; end: number } | null {
	const env = readEnvironment(src, start);
	if (env === null) return null;
	const starred = env.env.endsWith("*");
	const base = starred ? env.env.slice(0, -1) : env.env;
	const gridDelims = GRID_ENVIRONMENTS[base];
	if (gridDelims) {
		let p = env.bodyStart;
		while (src[p] === " " || src[p] === "\n" || src[p] === "\t") p++;
		if (starred && src[p] === "[") {
			// Starred matrix variants take an optional alignment argument.
			const close = src.indexOf("]", p);
			if (close !== -1 && close < env.bodyEnd) {
				p = close + 1;
				while (src[p] === " " || src[p] === "\n" || src[p] === "\t") p++;
			}
		}
		let colSpec: CellAlign[] | null = null;
		if (base === "array" && src[p] === "{") {
			const spec = readBraceGroup(src, p);
			colSpec = [...spec.text].filter((ch): ch is CellAlign => ch === "l" || ch === "c" || ch === "r");
			p = spec.end;
		}
		const cells = splitRows(src.slice(p, env.bodyEnd))
			.map(row => row.trim())
			.filter(row => row !== "")
			.map(row => splitCells(row).map(cell => parseExpr(cell, ctx)));
		const isCases = base === "cases" || base === "dcases" || base === "rcases" || base === "drcases";
		const align: (col: number) => CellAlign = colSpec ? col => colSpec[col] ?? "c" : isCases ? () => "l" : () => "c";
		const grid = gridBox(cells, align, () => 2, 1);
		return { box: delimBox(grid, gridDelims[0], gridDelims[1]), end: env.end };
	}
	if (!DISPLAY_ROW_ENVIRONMENTS[base]) {
		return { box: textBox(latexToUnicode(ctx.wrap(src.slice(start, env.end)))), end: env.end };
	}
	let bodyStart = env.bodyStart;
	if (base === "alignat" || base === "alignedat" || base === "gatheredat") {
		// These carry a required column-count argument `{n}` before the body.
		let p = bodyStart;
		while (src[p] === " " || src[p] === "\n") p++;
		if (src[p] === "{") bodyStart = readBraceGroup(src, p).end;
	}
	const rows = splitRows(src.slice(bodyStart, env.bodyEnd))
		.map(row => row.trim())
		.filter(row => row !== "");
	if (rows.length === 0) return { box: textBox(""), end: env.end };
	const cellRows = rows.map(splitCells);
	let ncols = 0;
	for (const row of cellRows) ncols = Math.max(ncols, row.length);
	if (ncols <= 1) {
		const centered = base === "gather" || base === "gathered" || base === "multline";
		return {
			box: vconcat(
				rows.map(row => parseExpr(row, ctx)),
				centered ? "c" : "l",
			),
			end: env.end,
		};
	}
	// `align`-family semantics: columns alternate right/left in `rl` pairs, a
	// thin gap inside each pair and a wide gap between pairs.
	const grid = gridBox(
		cellRows.map(row => row.map(cell => parseExpr(cell, ctx))),
		col => (col % 2 === 0 ? "r" : "l"),
		col => (col % 2 === 1 ? 1 : 3),
	);
	return { box: grid, end: env.end };
}

/**
 * Paint every line of `box` through a `latexColorScope` painter so structural
 * glyphs (fraction bars, stretched delimiters, matrix brackets) inherit the
 * enclosing color scope while nested color runs still restore to it.
 */
function colorizeBox(box: Box, scope: (text: string) => string): Box {
	return { lines: box.lines.map(scope), baseline: box.baseline, width: box.width };
}

/**
 * Parse a math fragment into a layout box. 2-D constructs — fractions, binomials,
 * radicals over tall content, `\left…\right` and tall bare parens, environments,
 * big-operator limits, block scripts — become stacked boxes; everything between
 * them is gathered into inline runs rendered through `latexToUnicode` under the
 * active scope wrapper (`ctx`), with `\color` state re-applied per run.
 */
function parseExpr(src: string, ctx: Ctx = ROOT_CTX): Box {
	const boxes: Box[] = [];
	let inline = "";
	let color = "";
	let colorScope: ((text: string) => string) | null = null;
	const flush = (): void => {
		if (!inline) return;
		boxes.push(textBox(latexToUnicode(ctx.wrap(color + inline))));
		inline = "";
	};
	/** Child context carrying the enclosing wrapper plus current color state. */
	const inner = (): Ctx => {
		if (!color) return ctx;
		const pre = color;
		return { wrap: run => ctx.wrap(pre + run) };
	};
	/** Apply the active `\color` scope to a structural box's glyphs. */
	const paint = (box: Box): Box => (colorScope === null ? box : colorizeBox(box, colorScope));
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			let j = i + 1;
			let name = "";
			while (j < src.length && /[A-Za-z]/.test(src[j])) {
				name += src[j];
				j++;
			}
			if (name && FRAC_COMMANDS[name]) {
				flush();
				const num = readArg(src, j);
				const den = readArg(src, num.end);
				boxes.push(paint(fracBox(parseExpr(num.text, inner()), parseExpr(den.text, inner()))));
				i = den.end;
				continue;
			}
			if (name && BINOM_COMMANDS[name]) {
				flush();
				const top = readArg(src, j);
				const bottom = readArg(src, top.end);
				boxes.push(paint(binomBox(parseExpr(top.text, inner()), parseExpr(bottom.text, inner()))));
				i = bottom.end;
				continue;
			}
			if (name && HBRACE_COMMANDS[name]) {
				flush();
				const spec = HBRACE_COMMANDS[name];
				const arg = readArg(src, j);
				// Limits-style scripts: the brace-side script is the label; an
				// opposite-side script attaches as a regular corner script.
				let subText: string | null = null;
				let supText: string | null = null;
				let m = arg.end;
				for (;;) {
					let n = m;
					while (src[n] === " ") n++;
					if (src[n] === "_" && subText === null) {
						const s = readArg(src, n + 1);
						subText = s.text;
						m = s.end;
						continue;
					}
					if (src[n] === "^" && supText === null) {
						const s = readArg(src, n + 1);
						supText = s.text;
						m = s.end;
						continue;
					}
					break;
				}
				const labelText = spec.over ? supText : subText;
				const otherText = spec.over ? subText : supText;
				let box = hbraceBox(
					parseExpr(arg.text, inner()),
					spec,
					labelText === null ? null : parseExpr(labelText, inner()),
				);
				if (otherText !== null) {
					const other = parseExpr(otherText, inner());
					box = attachScripts(box, spec.over ? other : null, spec.over ? null : other);
				}
				boxes.push(paint(box));
				i = m;
				continue;
			}
			if (name === "overset" || name === "underset" || name === "stackrel") {
				flush();
				const anno = readArg(src, j);
				const base = readArg(src, anno.end);
				const annoBox = parseExpr(anno.text, inner());
				const baseBox = parseExpr(base.text, inner());
				boxes.push(
					paint(limitsBox(baseBox, name === "underset" ? annoBox : null, name === "underset" ? null : annoBox)),
				);
				i = base.end;
				continue;
			}
			if (name === "sqrt") {
				let k = j;
				while (src[k] === " ") k++;
				let degree: string | null = null;
				if (src[k] === "[") {
					const close = src.indexOf("]", k);
					degree = src.slice(k + 1, close === -1 ? src.length : close);
					k = close === -1 ? src.length : close + 1;
				}
				const arg = readArg(src, k);
				// Display style always draws the roof (like LaTeX); inline math
				// keeps the flat `√(…)` form via latexToUnicode.
				flush();
				boxes.push(paint(radicalBox(parseExpr(arg.text, inner()), degree)));
				i = arg.end;
				continue;
			}
			if (name === "left") {
				const lr = readLeftRight(src, i);
				if (lr) {
					const segBoxes = lr.segments.map(segment => parseExpr(segment, inner()));
					let above = 0;
					let below = 0;
					for (const b of segBoxes) {
						above = Math.max(above, b.baseline);
						below = Math.max(below, b.lines.length - 1 - b.baseline);
					}
					const height = above + below + 1;
					if (height === 1) {
						// Single-line: keep the whole span inline so converter
						// state (fonts, colors, spacing) is preserved.
						inline += src.slice(i, lr.end);
						i = lr.end;
						continue;
					}
					flush();
					const parts: Box[] = [];
					const push = (col: Box | null): void => {
						if (col) parts.push(col);
					};
					push(delimColumn(delimKey(lr.left), height, above));
					segBoxes.forEach((segment, s) => {
						parts.push(segment);
						if (s < lr.middles.length) push(delimColumn(delimKey(lr.middles[s]), height, above));
					});
					push(delimColumn(delimKey(lr.right), height, above));
					boxes.push(paint(hconcat(parts)));
					i = lr.end;
					continue;
				}
			}
			if (name && (LIMIT_OPERATORS[name] || INTEGRAL_OPERATORS[name])) {
				let k = j;
				while (src[k] === " ") k++;
				let stack = LIMIT_OPERATORS[name] === true;
				let resume = j; // resume point when the operator stays inline
				if (src.startsWith("\\limits", k) && !/[A-Za-z]/.test(src[k + 7] ?? "")) {
					stack = true;
					resume = k = k + 7;
				} else if (src.startsWith("\\nolimits", k) && !/[A-Za-z]/.test(src[k + 9] ?? "")) {
					stack = false;
					resume = k + 9;
				}
				if (stack) {
					let subText: string | null = null;
					let supText: string | null = null;
					let m = k;
					for (;;) {
						// Peek past spaces without consuming them, so a run
						// following the operator keeps its leading space.
						let n = m;
						while (src[n] === " ") n++;
						if (src[n] === "_" && subText === null) {
							const arg = readArg(src, n + 1);
							subText = arg.text;
							m = arg.end;
							continue;
						}
						if (src[n] === "^" && supText === null) {
							const arg = readArg(src, n + 1);
							supText = arg.text;
							m = arg.end;
							continue;
						}
						break;
					}
					if (subText !== null || supText !== null) {
						flush();
						const glyph = textBox(latexToUnicode(ctx.wrap(`${color}\\${name}`)));
						boxes.push(
							paint(
								limitsBox(
									glyph,
									subText === null ? null : parseExpr(subText, inner()),
									supText === null ? null : parseExpr(supText, inner()),
								),
							),
						);
						i = m;
						continue;
					}
				}
				inline += `\\${name}`;
				i = resume;
				continue;
			}
			if (name === "color" || name === "normalcolor") {
				flush(); // preceding run keeps the previous color
				if (name === "normalcolor") {
					color = "";
					colorScope = null;
					i = j;
					continue;
				}
				let k = j;
				while (src[k] === " ") k++;
				let opt = "";
				if (src[k] === "[") {
					const close = src.indexOf("]", k);
					if (close !== -1) {
						opt = src.slice(k, close + 1);
						k = close + 1;
						while (src[k] === " ") k++;
					}
				}
				if (src[k] === "{") {
					const spec = readBraceGroup(src, k);
					color = `\\color${opt}{${spec.text}}`;
					colorScope = latexColorScope(opt ? opt.slice(1, -1).trim() : null, spec.text);
					i = spec.end;
				} else {
					color = "";
					colorScope = null;
					i = k;
				}
				continue;
			}
			if (name === "begin") {
				const env = parseEnvironment(src, i, inner());
				if (env) {
					flush();
					boxes.push(paint(env.box));
					i = env.end;
					continue;
				}
			}
			if (name && (MATH_FONT_COMMANDS.has(name) || name === "textcolor")) {
				// Scoped wrapper around 2-D content: recurse with the wrapper
				// re-applied to every inline run, so styling crosses boxes.
				let k = j;
				while (src[k] === " ") k++;
				let prefix = `\\${name}`;
				let scope: ((text: string) => string) | null = null;
				if (name === "textcolor") {
					let model: string | null = null;
					if (src[k] === "[") {
						const close = src.indexOf("]", k);
						if (close !== -1) {
							model = src.slice(k + 1, close).trim();
							prefix += src.slice(k, close + 1);
							k = close + 1;
							while (src[k] === " ") k++;
						}
					}
					if (src[k] !== "{") {
						inline += `\\${name}`;
						i = j;
						continue;
					}
					const spec = readBraceGroup(src, k);
					prefix += `{${spec.text}}`;
					scope = latexColorScope(model, spec.text);
					k = spec.end;
					while (src[k] === " ") k++;
				}
				if (src[k] === "{") {
					const content = readBraceGroup(src, k);
					flush();
					const pre = color;
					let box = parseExpr(content.text, { wrap: run => ctx.wrap(`${pre}${prefix}{${run}}`) });
					if (scope !== null) box = colorizeBox(box, scope);
					boxes.push(paint(box));
					i = content.end;
					continue;
				}
			}
			if (!name) {
				// Non-letter command (`\\`, `\,`, `\{`, …): keep the 2-char token inline.
				inline += `\\${src[j] ?? ""}`;
				i = j + 1;
				continue;
			}
			// Other command: keep it and its bracket/brace arguments inline so a
			// `{…}` argument is never mistaken for a top-level stacking group.
			inline += `\\${name}`;
			i = j;
			while (src[i] === "[" || src[i] === "{") {
				if (src[i] === "{") {
					const group = readBraceGroup(src, i);
					inline += `{${group.text}}`;
					i = group.end;
				} else {
					const close = src.indexOf("]", i);
					const end = close === -1 ? src.length : close + 1;
					inline += src.slice(i, end);
					i = end;
				}
			}
			continue;
		}
		if (c === "^" || c === "_") {
			const first = readScript(src, i);
			// Consume an immediately following opposite script (`M_i^j`) so both
			// land in one shared column instead of two successive ones.
			let second: Span | null = null;
			let n = first.end;
			while (src[n] === " ") n++;
			if (src[n] === (c === "^" ? "_" : "^")) second = readScript(src, n);
			const end = second === null ? first.end : second.end;
			const supText = c === "^" ? first.text : second?.text;
			const subText = c === "_" ? first.text : second?.text;
			const supBox = supText === undefined ? null : parseExpr(scriptArgOf(supText), inner());
			const subBox = subText === undefined ? null : parseExpr(scriptArgOf(subText), inner());
			// The converter falls back to `^(…)`/`_(…)` when any character lacks a
			// Unicode script form; those scripts get real raised/lowered boxes.
			const unconvertible = (raw: string | undefined): boolean => {
				if (raw === undefined) return false;
				const flat = latexToUnicode(raw);
				return flat.startsWith("^") || flat.startsWith("_");
			};
			// Multi-letter script words (`N_{turns}`) would convert per-char into
			// Unicode glyphs of uneven height and read ragged; box them too.
			// Commands are stripped: their output (`\prime` → ′) is not letters.
			const ragged = (raw: string | undefined): boolean => {
				if (raw === undefined) return false;
				const letters = scriptArgOf(raw)
					.replace(/\\[A-Za-z]+/g, "")
					.match(/[A-Za-z]/g);
				return letters !== null && letters.length >= 2;
			};
			const tall = (supBox !== null && supBox.lines.length > 1) || (subBox !== null && subBox.lines.length > 1);
			if (tall || unconvertible(supText) || unconvertible(subText) || ragged(supText) || ragged(subText)) {
				// Block script (`x^{\frac{1}{2}}`, `x^q`): raise/lower the boxes
				// against the run or box they follow.
				flush();
				const base = boxes.pop() ?? textBox("");
				boxes.push(paint(attachScripts(base, subBox, supBox)));
				i = end;
				continue;
			}
			const last = boxes[boxes.length - 1];
			if (inline === "" && last !== undefined && last.lines.length > 1) {
				// Scripts directly on a tall box (`M^T`, `\right|_{x=a}`): pin
				// the Unicode script glyphs (guaranteed convertible here after
				// the gate above) to its corners.
				const corner = (raw: string | undefined): Box | null =>
					raw === undefined ? null : textBox(latexToUnicode(ctx.wrap(color + raw)));
				boxes[boxes.length - 1] = paint(attachScripts(last, corner(subText), corner(supText)));
				i = end;
				continue;
			}
			inline += src.slice(i, end);
			i = end;
			continue;
		}
		if (c === "{") {
			const group = readBraceGroup(src, i);
			flush();
			boxes.push(paint(parseExpr(group.text, inner())));
			i = group.end;
			continue;
		}
		if (c === "(" || c === "[") {
			// Bare delimiters stretch when their content is tall (common in
			// model output that omits `\left`/`\right`).
			const closeCh = c === "(" ? ")" : "]";
			const close = matchDelim(src, i, c, closeCh);
			if (close !== -1) {
				const innerBox = parseExpr(src.slice(i + 1, close), inner());
				if (innerBox.lines.length > 1) {
					flush();
					boxes.push(paint(delimBox(innerBox, c, closeCh)));
					i = close + 1;
					continue;
				}
			}
		}
		inline += c;
		i++;
	}
	flush();
	if (boxes.length === 0) return textBox("");
	return hconcat(boxes);
}

/**
 * Count the command arguments still owed at the end of `seg` — non-zero when
 * the row ends mid-construct (`\frac{a}` awaiting its denominator, or
 * `\frac`/`x^` awaiting any argument). Pending arities form a stack: an
 * unbraced nested command consumes one outer argument, then retains its own
 * pending arguments without discarding the outer command's remaining arity.
 * Used to keep a command joined to an argument written on the next source line
 * while still treating an ordinary next row (`a\n{b+c}`) as a real row break.
 */
function bracesOwed(seg: string): number {
	const pending: number[] = [];
	const consumeArg = (): void => {
		const top = pending.length - 1;
		if (top < 0) return;
		if (pending[top] === 1) pending.pop();
		else pending[top]--;
	};

	let i = 0;
	while (i < seg.length) {
		const c = seg[i];
		if (c === "\\") {
			let j = i + 1;
			let name = "";
			while (j < seg.length && /[A-Za-z]/.test(seg[j])) name += seg[j++];
			// A command plus its immediately attached `[…]`/`{…}` groups is one
			// atom for an enclosing argument, matching readArg. Consume that outer
			// argument first, then retain only the command's own missing arguments
			// in a nested frame. Attached groups beyond the known arity still stay
			// part of the atom and cannot consume another outer argument.
			consumeArg();
			const arity = name ? (COMMAND_ARITY[name] ?? 0) : 0;
			let attached = 0;
			if (name) {
				while (seg[j] === "[" || seg[j] === "{") {
					if (seg[j] === "{") {
						j = readBraceGroup(seg, j).end;
						if (attached < arity) attached++;
					} else {
						const close = seg.indexOf("]", j);
						j = close === -1 ? seg.length : close + 1;
					}
				}
			} else {
				j = i + 2; // non-letter command (`\,`, `\{`, …)
			}
			const missing = arity - attached;
			if (missing > 0) pending.push(missing);
			i = j;
			continue;
		}
		if (c === "{") {
			i = readBraceGroup(seg, i).end;
			consumeArg();
			continue;
		}
		if (c === "^" || c === "_") {
			pending.push(1);
			i++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\n") {
			i++;
			continue;
		}
		consumeArg(); // a bare atom satisfies one pending argument
		i++;
	}

	let owed = 0;
	for (const remaining of pending) owed += remaining;
	return owed;
}

/** Split on top-level `\n` and `\\` row separators (outside braces and environments). */
function splitLines(src: string): string[] {
	const lines: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (src.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = src[i];
		if (c === "\\") {
			if (src[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				lines.push(src.slice(last, i));
				i += 2;
				while (src[i] === " ") i++;
				if (src[i] === "[") {
					const close = src.indexOf("]", i);
					i = close === -1 ? src.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2; // escaped char — never a logical-line break
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "\n" && braceDepth === 0 && envDepth === 0) {
			// A top-level newline is a row break UNLESS the current row ends with a
			// command still awaiting an argument (e.g. `\frac{num}\n{den}`,
			// `\frac{num}\n\sqrt{x}`, or `x^\n2`). Splitting there would sever the
			// command from its argument, so keep both in one segment; latexToBlock
			// collapses the interior newline to a space before parsing. A row that
			// merely opens with a braced group (`a\n{b+c}`) stays a break.
			if (bracesOwed(src.slice(last, i)) === 0) {
				lines.push(src.slice(last, i));
				last = i + 1;
			}
		}
		i++;
	}
	lines.push(src.slice(last));
	return lines;
}

/**
 * Render a display LaTeX math fragment to lines with full 2-D layout: stacked
 * fractions, stretchy delimiters, matrix grids, operator limits, drawn
 * radicals. Top-level source newlines and `\\` become vertical rows (so a
 * `lhs =` line stays above its block). Inline math should use `latexToUnicode`
 * instead — fractions there stay single-line.
 */
export function latexToBlock(src: string): string[] {
	if (typeof src !== "string" || src.trim() === "") return [];
	const rows = splitLines(src.trim())
		.map(line => line.replace(/[ \t]*\n[ \t]*/g, " ").trim())
		.filter(line => line !== "")
		.map(line => parseExpr(line));
	if (rows.length === 0) return [];
	let lines = vconcat(rows).lines;
	while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines = lines.slice(0, -1);
	while (lines.length > 1 && lines[0].trim() === "") lines = lines.slice(1);
	return lines;
}
