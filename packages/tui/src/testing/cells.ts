/**
 * Rendered-cell model of terminal rows: what a terminal shows, independent of
 * how the escape sequences that produced it were composed.
 *
 * Parity standard for painters: two rows match when every cell holds the same
 * grapheme with the same foreground, background, attributes and OSC 8 link
 * target. Redundant or reordered SGR (`\e[1m\e[1m`, a reset followed by a
 * re-open, combined `\e[1;4m` vs separate codes) does not matter; trailing
 * blank cells without visible decoration are ignored, and so are the
 * invisible parts of a space's style (its foreground, weight and slant).
 */

/** One terminal cell. A wide grapheme fills its first cell; the cells it covers hold `""`. */
export interface Cell {
	readonly ch: string;
	/** `""` default, `p0`–`p15` palette, `x16`–`x255` 256-color index, `#rrggbb` truecolor. */
	readonly fg: string;
	readonly bg: string;
	readonly bold: boolean;
	readonly faint: boolean;
	readonly italic: boolean;
	/** 0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed. */
	readonly underline: number;
	readonly blink: boolean;
	readonly inverse: boolean;
	readonly hidden: boolean;
	readonly strike: boolean;
	readonly overline: boolean;
	/** OSC 8 target, `""` when unlinked. */
	readonly link: string;
}

interface Pen {
	fg: string;
	bg: string;
	bold: boolean;
	faint: boolean;
	italic: boolean;
	underline: number;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strike: boolean;
	overline: boolean;
	link: string;
}

function freshPen(): Pen {
	return {
		fg: "",
		bg: "",
		bold: false,
		faint: false,
		italic: false,
		underline: 0,
		blink: false,
		inverse: false,
		hidden: false,
		strike: false,
		overline: false,
		link: "",
	};
}

function hex2(value: number): string {
	return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

/** Read an extended color (`38;5;n`, `38;2;r;g;b`, `38:2::r:g:b`) starting at `params[at]` (the `5`/`2`). */
function extendedColor(params: readonly string[], at: number): { color: string; next: number } {
	const mode = Number(params[at]);
	if (mode === 5) {
		const index = Number(params[at + 1] ?? 0);
		return { color: index < 16 ? `p${index}` : `x${index}`, next: at + 2 };
	}
	if (mode === 2) {
		const r = Number(params[at + 1] ?? 0);
		const g = Number(params[at + 2] ?? 0);
		const b = Number(params[at + 3] ?? 0);
		return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, next: at + 4 };
	}
	return { color: "", next: at + 1 };
}

function colonColor(sub: readonly string[]): string {
	// `38:5:n`, `38:2:r:g:b` or `38:2:cs:r:g:b` (colorspace id present).
	if (sub[1] === "5") {
		const index = Number(sub[2] ?? 0);
		return index < 16 ? `p${index}` : `x${index}`;
	}
	if (sub[1] === "2") {
		const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
		return `#${hex2(Number(rgb[0] ?? 0))}${hex2(Number(rgb[1] ?? 0))}${hex2(Number(rgb[2] ?? 0))}`;
	}
	return "";
}

function applySgr(pen: Pen, body: string): void {
	const params = body === "" ? ["0"] : body.split(";");
	for (let i = 0; i < params.length; i++) {
		const param = params[i]!;
		if (param.includes(":")) {
			const sub = param.split(":");
			const code = Number(sub[0]);
			if (code === 4) pen.underline = Number(sub[1] ?? 1);
			else if (code === 38) pen.fg = colonColor(sub);
			else if (code === 48) pen.bg = colonColor(sub);
			continue;
		}
		const code = param === "" ? 0 : Number(param);
		if (code === 38 || code === 48) {
			const { color, next } = extendedColor(params, i + 1);
			if (code === 38) pen.fg = color;
			else pen.bg = color;
			i = next - 1;
			continue;
		}
		if (code === 58) {
			// Underline color: skip its operands.
			i = extendedColor(params, i + 1).next - 1;
			continue;
		}
		switch (code) {
			case 0: {
				const link = pen.link;
				Object.assign(pen, freshPen());
				pen.link = link;
				break;
			}
			case 1:
				pen.bold = true;
				break;
			case 2:
				pen.faint = true;
				break;
			case 3:
				pen.italic = true;
				break;
			case 4:
				pen.underline = 1;
				break;
			case 5:
			case 6:
				pen.blink = true;
				break;
			case 7:
				pen.inverse = true;
				break;
			case 8:
				pen.hidden = true;
				break;
			case 9:
				pen.strike = true;
				break;
			case 21:
				pen.underline = 2;
				break;
			case 22:
				pen.bold = false;
				pen.faint = false;
				break;
			case 23:
				pen.italic = false;
				break;
			case 24:
				pen.underline = 0;
				break;
			case 25:
				pen.blink = false;
				break;
			case 27:
				pen.inverse = false;
				break;
			case 28:
				pen.hidden = false;
				break;
			case 29:
				pen.strike = false;
				break;
			case 39:
				pen.fg = "";
				break;
			case 49:
				pen.bg = "";
				break;
			case 53:
				pen.overline = true;
				break;
			case 55:
				pen.overline = false;
				break;
			default:
				if (code >= 30 && code <= 37) pen.fg = `p${code - 30}`;
				else if (code >= 90 && code <= 97) pen.fg = `p${code - 90 + 8}`;
				else if (code >= 40 && code <= 47) pen.bg = `p${code - 40}`;
				else if (code >= 100 && code <= 107) pen.bg = `p${code - 100 + 8}`;
		}
	}
}

const ESCAPE =
	/\x1b(?:\[([0-?]*)([ -/]*)([@-~])|\]([^\x07\x1b]*)(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|[0-?@-Z\\-_])/y;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function osc(pen: Pen, body: string): void {
	if (!body.startsWith("8;")) return;
	const rest = body.slice(2);
	const sep = rest.indexOf(";");
	pen.link = sep === -1 ? "" : rest.slice(sep + 1);
}

/** The cells one row shows. Escape sequences other than SGR and OSC 8 are zero-width and ignored. */
export function cellRow(row: string): Cell[] {
	const cells: Cell[] = [];
	const pen = freshPen();
	let plainStart = 0;
	const flush = (end: number): void => {
		if (end <= plainStart) return;
		for (const { segment } of segmenter.segment(row.slice(plainStart, end))) {
			const width = Bun.stringWidth(segment);
			if (width === 0) {
				// Combining marks and zero-width joiners attach to the previous grapheme's cell.
				const last = cells.at(-1);
				if (last) cells[cells.length - 1] = { ...last, ch: last.ch + segment };
				continue;
			}
			cells.push({ ch: segment, ...pen });
			for (let i = 1; i < width; i++) cells.push({ ch: "", ...pen });
		}
	};
	for (let i = 0; i < row.length; i++) {
		if (row.charCodeAt(i) !== 0x1b) continue;
		ESCAPE.lastIndex = i;
		const match = ESCAPE.exec(row);
		if (!match) continue;
		flush(i);
		if (match[3] === "m" && match[2] === "") applySgr(pen, match[1] ?? "");
		else if (match[4] !== undefined) osc(pen, match[4]);
		i += match[0].length - 1;
		plainStart = i + 1;
	}
	flush(row.length);
	return cells;
}

/** Whether a cell shows nothing: a space with no background, inverse, underline, strike, overline or link. */
export function isBlankCell(cell: Cell): boolean {
	return (
		cell.ch === " " &&
		cell.bg === "" &&
		!cell.inverse &&
		cell.underline === 0 &&
		!cell.strike &&
		!cell.overline &&
		cell.link === ""
	);
}

/** The cells of every row, with trailing blank cells dropped. */
export function cellGrid(rows: readonly string[]): Cell[][] {
	return rows.map(row => {
		const cells = cellRow(row);
		let end = cells.length;
		while (end > 0 && isBlankCell(cells[end - 1]!)) end--;
		return end === cells.length ? cells : cells.slice(0, end);
	});
}

/** A compact description of a cell's style: `fg=#bc3fbc bold underline link=https://…`. */
export function describeStyle(cell: Cell): string {
	const parts: string[] = [];
	if (cell.fg) parts.push(`fg=${cell.fg}`);
	if (cell.bg) parts.push(`bg=${cell.bg}`);
	if (cell.bold) parts.push("bold");
	if (cell.faint) parts.push("faint");
	if (cell.italic) parts.push("italic");
	if (cell.underline) parts.push(cell.underline === 1 ? "underline" : `underline=${cell.underline}`);
	if (cell.blink) parts.push("blink");
	if (cell.inverse) parts.push("inverse");
	if (cell.hidden) parts.push("hidden");
	if (cell.strike) parts.push("strike");
	if (cell.overline) parts.push("overline");
	if (cell.link) parts.push(`link=${cell.link}`);
	return parts.length > 0 ? parts.join(" ") : "plain";
}

/**
 * Whether a cell shows no glyph whose ink is visible: a space with no
 * underline, strike, overline or inverse. Its foreground, weight, slant and
 * blink cannot be seen; only its background and link can.
 */
function inkless(cell: Cell): boolean {
	return cell.ch === " " && cell.underline === 0 && !cell.strike && !cell.overline && !cell.inverse;
}

function sameCell(a: Cell, b: Cell): boolean {
	if (inkless(a) && inkless(b)) return a.bg === b.bg && a.link === b.link;
	return (
		a.ch === b.ch &&
		a.fg === b.fg &&
		a.bg === b.bg &&
		a.bold === b.bold &&
		a.faint === b.faint &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.blink === b.blink &&
		a.inverse === b.inverse &&
		a.hidden === b.hidden &&
		a.strike === b.strike &&
		a.overline === b.overline &&
		a.link === b.link
	);
}

function plainRow(cells: readonly Cell[]): string {
	return cells.map(cell => cell.ch).join("");
}

/**
 * The first difference between two row lists in rendered cells, or `null`
 * when they show the same thing. The message names the row, the column, both
 * cells and both rows' text.
 */
export function firstCellDiff(expectedRows: readonly string[], actualRows: readonly string[]): string | null {
	const expected = cellGrid(expectedRows);
	const actual = cellGrid(actualRows);
	const rows = Math.max(expected.length, actual.length);
	for (let row = 0; row < rows; row++) {
		const want = expected[row];
		const got = actual[row];
		if (!want || !got) {
			return want
				? `row ${row}: missing; expected ${JSON.stringify(plainRow(want))} (${expected.length} rows expected, ${actual.length} painted)`
				: `row ${row}: extra ${JSON.stringify(plainRow(got!))} (${expected.length} rows expected, ${actual.length} painted)`;
		}
		const cols = Math.max(want.length, got.length);
		for (let col = 0; col < cols; col++) {
			const a = want[col];
			const b = got[col];
			if (a && b && sameCell(a, b)) continue;
			const describe = (cell: Cell | undefined): string =>
				cell ? `${JSON.stringify(cell.ch)} ${describeStyle(cell)}` : "nothing";
			return [
				`row ${row} col ${col}: expected ${describe(a)}, got ${describe(b)}`,
				`  expected: ${JSON.stringify(plainRow(want))}`,
				`  actual:   ${JSON.stringify(plainRow(got))}`,
			].join("\n");
		}
	}
	return null;
}

/** Rows with escape sequences removed and trailing spaces trimmed (the stripped-text comparison). */
export function plainRows(rows: readonly string[]): string[] {
	return cellGrid(rows).map(plainRow);
}
