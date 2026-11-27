/**
 * LaTeX math as one line of terminal text: unicode symbols and scripts,
 * `a/b` fractions, text styles and colors as SGR. `renderMathInText` finds
 * math in prose (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, bare math environments,
 * color commands) and converts it in place.
 */
import { PLAIN, renderInline, serialize, trimSegments } from "./latex/inline";
import { parseMath } from "./latex/parse";

/** Rendering options. */
export interface LatexOptions {
	/** Colors as 24-bit SGR (default) or the nearest 256-color index. */
	readonly trueColor?: boolean;
}

/** LaTeX math (without `$` delimiters) as one styled line. */
export function latexToUnicode(latex: string, options: LatexOptions = {}): string {
	return serialize(trimSegments(renderInline(parseMath(latex), PLAIN, options)));
}

/** Environments that hold math on their own; tables, lists, verbatim and floats do not. */
const MATH_ENVIRONMENTS: Readonly<Record<string, true>> = {
	equation: true,
	align: true,
	aligned: true,
	alignat: true,
	alignedat: true,
	gather: true,
	gathered: true,
	multline: true,
	split: true,
	flalign: true,
	eqnarray: true,
	cases: true,
	dcases: true,
	rcases: true,
	matrix: true,
	pmatrix: true,
	bmatrix: true,
	Bmatrix: true,
	vmatrix: true,
	Vmatrix: true,
	smallmatrix: true,
	array: true,
	subarray: true,
	math: true,
	displaymath: true,
};

/** Whether environment `name` (starred variants included) is display math that may stand bare in prose. */
export function isBareMathEnvironment(name: string): boolean {
	return MATH_ENVIRONMENTS[name.endsWith("*") ? name.slice(0, -1) : name] === true;
}

/** End of `count` braced groups (each optionally led by `[…]`) starting at `at`, or -1. */
function groupsEnd(text: string, at: number, count: number): number {
	let i = at;
	for (let group = 0; group < count; group++) {
		while (text[i] === " ") i++;
		if (text[i] === "[") {
			const close = text.indexOf("]", i);
			if (close < 0) return -1;
			i = close + 1;
		}
		while (text[i] === " ") i++;
		if (text[i] !== "{") return -1;
		let depth = 0;
		for (; i < text.length; i++) {
			if (text[i] === "\\") {
				i++;
				continue;
			}
			if (text[i] === "{") depth++;
			else if (text[i] === "}" && --depth === 0) break;
		}
		if (depth !== 0) return -1;
		i++;
	}
	return i;
}

/** Color commands converted when they stand in prose, with their argument count. */
const PROSE_COMMANDS: Readonly<Record<string, number>> = { textcolor: 2, colorbox: 2, fcolorbox: 3 };

const BEGIN = /^\\begin\{([^}]+)\}/;

/** Index just past the `\end{name}` matching the `\begin{name}` at `at`, or -1. */
function environmentEnd(text: string, at: number, name: string): number {
	const begin = `\\begin{${name}}`;
	const end = `\\end{${name}}`;
	let depth = 0;
	let i = at;
	while (i < text.length) {
		const nextBegin = text.indexOf(begin, i);
		const nextEnd = text.indexOf(end, i);
		if (nextEnd < 0) return -1;
		if (nextBegin >= 0 && nextBegin < nextEnd) {
			depth++;
			i = nextBegin + begin.length;
			continue;
		}
		depth--;
		i = nextEnd + end.length;
		if (depth === 0) return i;
	}
	return -1;
}

/** Closing `$` of inline math opened at `at`: not escaped, not after a space, not before a digit. */
function inlineMathEnd(text: string, at: number): number {
	const first = text[at + 1];
	if (first === undefined || /\s/.test(first) || first === "$") return -1;
	for (let i = at + 1; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "\n" && text[i + 1] === "\n") return -1;
		if (ch !== "$") continue;
		if (/\s/.test(text[i - 1]!) || /\d/.test(text[i + 1] ?? "")) continue;
		return i;
	}
	return -1;
}

/**
 * `text` with its math converted to unicode lines. A bare math environment
 * right after a line ending in `=` takes that line in as its left-hand side.
 * Other environments stay verbatim, contents included; `\$` is a dollar.
 */
export function renderMathInText(text: string, options: LatexOptions = {}): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "\\") {
			const next = text[i + 1];
			if (next === "$") {
				out += "$";
				i += 2;
				continue;
			}
			if (next === "(" || next === "[") {
				const close = text.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
				if (close >= 0) {
					out += latexToUnicode(text.slice(i + 2, close), options);
					i = close + 2;
					continue;
				}
			}
			const begin = BEGIN.exec(text.slice(i, i + 200));
			if (begin !== null) {
				const name = begin[1]!;
				const end = environmentEnd(text, i, name);
				if (end >= 0) {
					const source = text.slice(i, end);
					if (!isBareMathEnvironment(name)) {
						out += source;
					} else {
						const converted = latexToUnicode(source, options);
						const lineStart = out.lastIndexOf("\n", out.length - 2) + 1;
						const lhs = out.slice(lineStart, -1);
						if (out.endsWith("\n") && lhs.trimEnd().endsWith("=") && !lhs.includes("$")) {
							out = `${out.slice(0, lineStart)}${lhs.trimEnd()} ${converted}`;
						} else {
							out += converted;
						}
					}
					i = end;
					continue;
				}
			}
			const command = /^\\([A-Za-z]+)/.exec(text.slice(i, i + 20))?.[1];
			const groups = command === undefined ? undefined : PROSE_COMMANDS[command];
			if (groups !== undefined) {
				const end = groupsEnd(text, i + 1 + command!.length, groups);
				if (end >= 0) {
					out += latexToUnicode(text.slice(i, end), options);
					i = end;
					continue;
				}
			}
			out += ch;
			i++;
			continue;
		}
		if (ch === "$") {
			if (text[i + 1] === "$") {
				const close = text.indexOf("$$", i + 2);
				if (close >= 0) {
					out += latexToUnicode(text.slice(i + 2, close), options);
					i = close + 2;
					continue;
				}
			} else {
				const close = inlineMathEnd(text, i);
				if (close >= 0) {
					out += latexToUnicode(text.slice(i + 1, close), options);
					i = close + 1;
					continue;
				}
			}
		}
		out += ch;
		i++;
	}
	return out;
}
