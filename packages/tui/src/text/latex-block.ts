/**
 * LaTeX display math as a block of terminal rows: stacked fractions,
 * radicals with a roof, raised scripts that have no unicode form, limits over
 * and under big operators, matrices and cases in stretched delimiters,
 * aligned rows. Anything that fits one line comes back as one row, exactly
 * as `latexToUnicode` draws it.
 */
import type { LatexOptions } from "./latex";
import {
	applyStyle,
	type Frame,
	envBase,
	gridDelimiters,
	isGridEnvironment,
	PLAIN,
	renderInline,
	type Segment,
	scriptGlyphs,
	serialize,
	trimSegments,
	withFont,
} from "./latex/inline";
import { type EnvNode, type MathNode, parseMathRows, type ScriptsNode } from "./latex/parse";
import { spaces, visibleWidth } from "./width";

/** Rows of equal width with a baseline row other boxes align to. */
interface Box {
	readonly rows: string[];
	readonly base: number;
	readonly width: number;
}

type Align = "left" | "center" | "right";

function textBox(text: string): Box {
	return { rows: [text], base: 0, width: visibleWidth(text) };
}

function styled(text: string, frame: Frame): string {
	return serialize([{ t: text, f: frame }]);
}

function alignRow(row: string, rowWidth: number, width: number, align: Align): string {
	const free = Math.max(0, width - rowWidth);
	const left = align === "left" ? 0 : align === "right" ? free : Math.floor(free / 2);
	return `${spaces(left)}${row}${spaces(free - left)}`;
}

/** `box` widened to `width`. */
function widen(box: Box, width: number, align: Align): Box {
	if (box.width >= width) return box;
	return { rows: box.rows.map(row => alignRow(row, box.width, width, align)), base: box.base, width };
}

/** Boxes side by side, baselines aligned. */
function hcat(boxes: readonly Box[]): Box {
	const parts = boxes.filter(box => box.width > 0 || box.rows.length > 1);
	if (parts.length === 0) return textBox("");
	const above = Math.max(...parts.map(box => box.base));
	const below = Math.max(...parts.map(box => box.rows.length - box.base - 1));
	const rows = Array.from({ length: above + below + 1 }, () => "");
	for (const box of parts) {
		const top = above - box.base;
		for (let row = 0; row < rows.length; row++) {
			const line = box.rows[row - top];
			rows[row] += line ?? spaces(box.width);
		}
	}
	return { rows, base: above, width: parts.reduce((sum, box) => sum + box.width, 0) };
}

/** Boxes stacked and aligned within the widest; the baseline is row `base`. */
function vstack(boxes: readonly Box[], base: number, align: Align = "center"): Box {
	const width = Math.max(0, ...boxes.map(box => box.width));
	const rows: string[] = [];
	for (const box of boxes) rows.push(...widen(box, width, align).rows);
	return { rows, base, width };
}

// ─── Delimiters ─────────────────────────────────────────────────────────────

/** Top, extension, bottom (and middle) pieces of tall delimiters. */
const TALL: Readonly<Record<string, readonly [string, string, string, string?]>> = {
	"(": ["⎛", "⎜", "⎝"],
	")": ["⎞", "⎟", "⎠"],
	"[": ["⎡", "⎢", "⎣"],
	"]": ["⎤", "⎥", "⎦"],
	"{": ["⎧", "⎪", "⎩", "⎨"],
	"}": ["⎫", "⎪", "⎭", "⎬"],
	"⌊": ["⎢", "⎢", "⎣"],
	"⌋": ["⎥", "⎥", "⎦"],
	"⌈": ["⎡", "⎢", "⎢"],
	"⌉": ["⎤", "⎥", "⎥"],
	"|": ["│", "│", "│"],
	"‖": ["‖", "‖", "‖"],
	"⟨": ["╱", "⟨", "╲"],
	"⟩": ["╲", "⟩", "╱"],
};

/** A delimiter `height` rows tall. */
function delimiter(glyph: string, height: number, frame: Frame): string[] {
	if (glyph === "") return Array<string>(height).fill("");
	const pieces = TALL[glyph];
	if (height === 1 || pieces === undefined) {
		return Array.from({ length: height }, (_, row) =>
			row === Math.floor((height - 1) / 2) ? styled(glyph, frame) : spaces(visibleWidth(glyph)),
		);
	}
	const [top, extension, bottom, middle] = pieces;
	return Array.from({ length: height }, (_, row) => {
		if (row === 0) return styled(top, frame);
		if (row === height - 1) return styled(bottom, frame);
		if (middle !== undefined && row === Math.floor((height - 1) / 2)) return styled(middle, frame);
		return styled(extension, frame);
	});
}

function delimiterBox(glyph: string, height: number, base: number, frame: Frame): Box {
	const rows = delimiter(glyph, height, frame);
	return { rows, base, width: glyph === "" ? 0 : visibleWidth(glyph) };
}

/** `inner` between delimiters stretched to its height, one space inside each (only when tall). */
function fence(open: string, close: string, inner: Box, frame: Frame, pad = true): Box {
	const height = inner.rows.length;
	const gap = pad ? textBox(" ") : textBox("");
	return hcat([
		delimiterBox(open, height, inner.base, frame),
		open === "" ? textBox("") : { ...gap, base: 0 },
		inner,
		close === "" ? textBox("") : gap,
		delimiterBox(close, height, inner.base, frame),
	]);
}

// ─── Layout ─────────────────────────────────────────────────────────────────

function isBlank(node: MathNode): boolean {
	return node.k === "text" && node.t.trim() === "";
}

function trimNodes(nodes: readonly MathNode[]): readonly MathNode[] {
	let start = 0;
	let end = nodes.length;
	while (start < end && isBlank(nodes[start]!)) start++;
	while (end > start && isBlank(nodes[end - 1]!)) end--;
	return nodes.slice(start, end);
}

class BlockLayout {
	readonly #options: LatexOptions;

	constructor(options: LatexOptions) {
		this.#options = options;
	}

	#segments(nodes: readonly MathNode[], frame: Frame): Segment[] {
		return renderInline(nodes, frame, this.#options);
	}

	/**
	 * Whether a script needs a raised (or lowered) box: it is tall, styled,
	 * has a character without a unicode script form, or is a word (unicode
	 * script letters of mixed heights read ragged).
	 */
	#scriptRaised(content: readonly MathNode[], frame: Frame, kind: "sub" | "sup"): boolean {
		if (content.some(node => this.isTall(node, frame))) return true;
		const segments = trimSegments(this.#segments(content, frame));
		if (segments.length === 0) return false;
		if (/[A-Za-z][^A-Za-z]*[A-Za-z]/.test(segments.map(segment => segment.t).join(""))) return true;
		return scriptGlyphs(segments, frame, kind) === undefined;
	}

	/** Whether `node` needs more than one row. */
	isTall(node: MathNode, frame: Frame): boolean {
		switch (node.k) {
			case "frac":
			case "sqrt":
			case "brace":
				return true;
			case "group":
			case "accent":
			case "wrap":
				return node.c.some(child => this.isTall(child, frame));
			case "font": {
				const inner = withFont(frame, node.font);
				return node.c.some(child => this.isTall(child, inner));
			}
			case "style": {
				const inner = applyStyle(frame, node.style, this.#options);
				return node.c.some(child => this.isTall(child, inner));
			}
			case "delim":
				return node.c.some(child => this.isTall(child, frame));
			case "scripts": {
				if (node.stack) return true;
				if (node.base?.k === "op" && node.base.limits) return true;
				if (node.base !== undefined && this.isTall(node.base, frame)) return true;
				return (
					(node.sup !== undefined && this.#scriptRaised(node.sup, frame, "sup")) ||
					(node.sub !== undefined && this.#scriptRaised(node.sub, frame, "sub"))
				);
			}
			case "env":
				return (
					node.rows.length > 1 ||
					node.rows.some(row => row.some(cell => cell.some(child => this.isTall(child, frame))))
				);
			default:
				return false;
		}
	}

	/** A node list as one box: one-row runs stay inline, tall nodes become boxes, parentheses around tall content stretch. */
	list(nodes: readonly MathNode[], frame: Frame): Box {
		const boxes: Box[] = [];
		let flat: MathNode[] = [];
		const flush = (): void => {
			if (flat.length === 0) return;
			boxes.push(textBox(serialize(this.#segments(flat, frame))));
			flat = [];
		};
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			if (node.k === "text" && (node.t === "(" || node.t === "[")) {
				const close = this.#matchingClose(nodes, i);
				if (close > 0 && nodes.slice(i + 1, close).some(child => this.isTall(child, frame))) {
					flush();
					boxes.push(
						fence(node.t, node.t === "(" ? ")" : "]", this.list(nodes.slice(i + 1, close), frame), frame),
					);
					i = close;
					continue;
				}
			}
			if (!this.isTall(node, frame)) {
				flat.push(node);
				continue;
			}
			flush();
			boxes.push(this.#tall(node, frame));
		}
		flush();
		return hcat(boxes);
	}

	#matchingClose(nodes: readonly MathNode[], open: number): number {
		const openGlyph = (nodes[open] as { t: string }).t;
		const closeGlyph = openGlyph === "(" ? ")" : "]";
		let depth = 0;
		for (let i = open; i < nodes.length; i++) {
			const node = nodes[i]!;
			if (node.k !== "text") continue;
			if (node.t === openGlyph) depth++;
			else if (node.t === closeGlyph && --depth === 0) return i;
		}
		return -1;
	}

	#tall(node: MathNode, frame: Frame): Box {
		switch (node.k) {
			case "group":
			case "accent":
				return this.list(node.c, frame);
			case "font":
				return this.list(node.c, withFont(frame, node.font));
			case "brace":
				return this.#brace(node.over, node.c, undefined, frame);
			case "style":
				return this.list(node.c, applyStyle(frame, node.style, this.#options));
			case "wrap":
				return hcat([
					textBox(styled(node.open, frame)),
					this.list(node.c, frame),
					textBox(styled(node.close, frame)),
				]);
			case "frac":
				return this.#fraction(node.num, node.den, node.bar, frame);
			case "sqrt":
				return this.#radical(node.c, node.index, frame);
			case "scripts":
				return this.#scripts(node, frame);
			case "delim":
				return this.#delimited(node.left, node.right, node.c, frame);
			case "env":
				return this.#environment(node, frame);
			default:
				return textBox(serialize(this.#segments([node], frame)));
		}
	}

	/** Content with a brace drawn over or under it, and the brace's label beyond it. */
	#brace(over: boolean, body: readonly MathNode[], label: readonly MathNode[] | undefined, frame: Frame): Box {
		const content = this.list(trimNodes(body), frame);
		const width = Math.max(3, content.width);
		const tip = Math.floor((width - 1) / 2);
		const [left, middle, right] = over ? ["╭", "┴", "╮"] : ["╰", "┬", "╯"];
		const rule = textBox(
			styled(`${left}${"─".repeat(tip - 1)}${middle}${"─".repeat(width - tip - 2)}${right}`, frame),
		);
		const parts = [content, rule];
		if (label !== undefined) parts.push(this.list(trimNodes(label), frame));
		if (!over) return vstack(parts, content.base);
		parts.reverse();
		return vstack(parts, parts.slice(0, -1).reduce((sum, box) => sum + box.rows.length, 0) + content.base);
	}

	#fraction(numerator: readonly MathNode[], denominator: readonly MathNode[], bar: boolean, frame: Frame): Box {
		const num = this.list(trimNodes(numerator), frame);
		const den = this.list(trimNodes(denominator), frame);
		if (!bar) return fence("(", ")", vstack([num, textBox(""), den], num.rows.length), frame);
		const width = Math.max(num.width, den.width) + 2;
		const rule = textBox(styled("─".repeat(width), frame));
		return vstack([widen(num, width, "center"), rule, widen(den, width, "center")], num.rows.length);
	}

	#radical(body: readonly MathNode[], index: readonly MathNode[] | undefined, frame: Frame): Box {
		const inner = this.list(trimNodes(body), frame);
		const height = inner.rows.length;
		const rows = [styled(` ┌${"─".repeat(inner.width + 1)}`, frame)];
		inner.rows.forEach((row, i) => rows.push(`${styled(i === height - 1 ? "╲│" : " │", frame)} ${row}`));
		const radical: Box = { rows, base: inner.base + 1, width: inner.width + 3 };
		if (index === undefined) return radical;
		const glyphs = scriptGlyphs(trimSegments(this.#segments(index, frame)), frame, "sup");
		if (glyphs === undefined) return radical;
		// The degree sits on the roof row, left of the radical.
		const width = visibleWidth(glyphs);
		const degree: Box = {
			rows: rows.map((_, row) => (row === 0 ? styled(glyphs, frame) : spaces(width))),
			base: radical.base,
			width,
		};
		return hcat([degree, radical]);
	}

	#scripts(node: ScriptsNode, frame: Frame): Box {
		const brace = node.base?.k === "brace" ? node.base : undefined;
		const label = brace === undefined ? undefined : brace.over ? node.sup : node.sub;
		if (brace !== undefined && label !== undefined) return this.#brace(brace.over, brace.c, label, frame);
		const base = node.base === undefined ? textBox("") : this.list([node.base], frame);
		const limits = node.stack || (node.base?.k === "op" && node.base.limits);
		if (limits) {
			const over = node.sup === undefined ? undefined : this.list(trimNodes(node.sup), frame);
			const under = node.sub === undefined ? undefined : this.list(trimNodes(node.sub), frame);
			const parts = [over, base, under].filter((box): box is Box => box !== undefined);
			return vstack(parts, (over?.rows.length ?? 0) + base.base);
		}
		const raised =
			(node.sup !== undefined && this.#scriptRaised(node.sup, frame, "sup")) ||
			(node.sub !== undefined && this.#scriptRaised(node.sub, frame, "sub"));
		const height = base.rows.length;
		if (!raised) {
			const sup =
				node.sup === undefined
					? ""
					: (scriptGlyphs(trimSegments(this.#segments(node.sup, frame)), frame, "sup") ?? "");
			const sub =
				node.sub === undefined
					? ""
					: (scriptGlyphs(trimSegments(this.#segments(node.sub, frame)), frame, "sub") ?? "");
			if (height === 1) {
				return hcat([base, textBox(styled(node.first === "sub" ? sub + sup : sup + sub, frame))]);
			}
			// Pinned to the corners of a tall base.
			const width = Math.max(visibleWidth(sup), visibleWidth(sub));
			const column = Array.from({ length: height }, (_, row) =>
				row === 0 && sup !== ""
					? alignRow(styled(sup, frame), visibleWidth(sup), width, "left")
					: row === height - 1 && sub !== ""
						? alignRow(styled(sub, frame), visibleWidth(sub), width, "left")
						: spaces(width),
			);
			return hcat([base, { rows: column, base: base.base, width }]);
		}
		const over = node.sup === undefined ? undefined : this.list(trimNodes(node.sup), frame);
		const under = node.sub === undefined ? undefined : this.list(trimNodes(node.sub), frame);
		const middle: Box = { rows: Array<string>(height).fill(""), base: 0, width: 0 };
		const parts = [over, middle, under].filter((box): box is Box => box !== undefined);
		return hcat([base, vstack(parts, (over?.rows.length ?? 0) + base.base, "left")]);
	}

	#delimited(left: string, right: string, body: readonly MathNode[], frame: Frame): Box {
		const parts: Box[] = [];
		const middles: string[] = [];
		let run: MathNode[] = [];
		for (const node of trimNodes(body)) {
			if (node.k === "middle") {
				parts.push(this.list(trimNodes(run), frame));
				middles.push(node.t);
				run = [];
			} else run.push(node);
		}
		parts.push(this.list(trimNodes(run), frame));
		const above = Math.max(...parts.map(box => box.base));
		const below = Math.max(...parts.map(box => box.rows.length - box.base - 1));
		const height = above + below + 1;
		const pieces: Box[] = [];
		parts.forEach((part, index) => {
			if (index > 0)
				pieces.push(textBox(" "), delimiterBox(middles[index - 1]!, height, above, frame), textBox(" "));
			pieces.push(part);
		});
		return fence(left, right, hcat(pieces), frame);
	}

	#environment(node: EnvNode, frame: Frame): Box {
		const name = envBase(node.name);
		const grid = isGridEnvironment(name);
		const cells = node.rows.map(row => row.map(cell => this.list(trimNodes(cell), frame)));
		if (!grid && cells.length === 1 && cells[0]!.length === 1) return cells[0]![0]!;
		const columns = Math.max(...cells.map(row => row.length));
		const aligns: Align[] = Array.from({ length: columns }, (_, column) => {
			if (name === "array" || name === "subarray") return specAlign(node.spec ?? "", column);
			if (name === "cases" || name === "dcases" || name === "rcases") return "left";
			if (grid || name === "gather" || name === "gathered" || name === "multline") return "center";
			return column % 2 === 0 ? "right" : "left";
		});
		const widths = Array.from({ length: columns }, (_, column) =>
			Math.max(0, ...cells.map(row => row[column]?.width ?? 0)),
		);
		const separator = grid ? "  " : " ";
		const lines: Box[] = cells.map(row =>
			hcat(
				widths.flatMap((width, column) => {
					const cell = widen(row[column] ?? textBox(""), width, aligns[column]!);
					return column === 0 ? [cell] : [textBox(separator), cell];
				}),
			),
		);
		const stacked: Box[] = [];
		lines.forEach((line, index) => {
			if (index > 0 && grid) stacked.push(textBox(""));
			stacked.push(line);
		});
		const height = stacked.reduce((sum, box) => sum + box.rows.length, 0);
		const body = vstack(stacked, Math.floor((height - 1) / 2), "left");
		const [open, close] = gridDelimiters(name);
		return open === "" && close === "" ? body : fence(open, close, body, frame);
	}
}

/** Alignment of column `index` in an `array` column specification (`l`, `c`, `r`; `p{…}` reads as left). */
function specAlign(spec: string, index: number): Align {
	const columns: Align[] = [];
	for (let i = 0; i < spec.length; i++) {
		const ch = spec[i]!;
		if (ch === "l") columns.push("left");
		else if (ch === "c") columns.push("center");
		else if (ch === "r") columns.push("right");
		else if (ch === "p" || ch === "m" || ch === "b" || ch === "@" || ch === "!" || ch === "*") {
			if (ch === "p" || ch === "m" || ch === "b") columns.push("left");
			const open = spec.indexOf("{", i);
			if (open < 0) break;
			let depth = 0;
			for (i = open; i < spec.length; i++) {
				if (spec[i] === "{") depth++;
				else if (spec[i] === "}" && --depth === 0) break;
			}
		}
	}
	return columns[index] ?? "center";
}

/**
 * LaTeX display math as rows padded to one width; `[]` for blank input. A
 * top-level `\\` or line break starts a new row (unless a command is still
 * reading its arguments); rows stack left-aligned.
 */
export function latexToBlock(latex: string, options: LatexOptions = {}): string[] {
	if (latex.trim() === "") return [];
	const layout = new BlockLayout(options);
	const rows = parseMathRows(latex)
		.map(trimNodes)
		.filter(row => row.length > 0)
		.map(row =>
			row.some(node => layout.isTall(node, PLAIN))
				? layout.list(row, PLAIN)
				: textBox(serialize(trimSegments(renderInline(row, PLAIN, options)))),
		);
	if (rows.length === 0) return [];
	return vstack(rows, 0, "left").rows;
}
