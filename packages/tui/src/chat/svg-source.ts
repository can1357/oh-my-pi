/**
 * Source-level handling of assistant SVG and Mermaid fences: splitting prose
 * around figures, turning streaming SVG into a document a parser accepts, and
 * resolving the theme tokens figures color themselves with.
 */
import { lexDocument } from "../components/markdown";

/** One run of an assistant text block: prose, or an authored figure fence body. */
export type FigureSegment =
	| { readonly kind: "markdown"; readonly text: string }
	/** SVG can draw before its closing fence arrives. */
	| { readonly kind: "svg"; readonly source: string; readonly closed: boolean }
	/** Mermaid layout waits for the complete, explicitly closed fence. */
	| { readonly kind: "mermaid"; readonly source: string; readonly closed: true };

/** A top-level (≤3-space indent) ```svg / ~~~svg fence opener, info string compared ASCII-case-insensitively. */
const SVG_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*svg(?:[ \t]|$)/im;
const MERMAID_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[ \t]|$)/im;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Whether `markdown` holds a ```svg fence that figure lifting recognizes. */
export function hasSvgFence(markdown: string): boolean {
	return markdown.includes("svg") && SVG_FENCE.test(markdown);
}

/** Whether `markdown` may hold a top-level Mermaid fence, including one still streaming. */
export function hasMermaidFence(markdown: string): boolean {
	return MERMAID_FENCE.test(markdown);
}

/** Original-source coordinates used while splitting figure fences. */
interface FencedSourceRange {
	readonly marker: string;
	readonly language: string;
	readonly start: number;
	readonly body: number;
	readonly end: number;
	readonly after: number;
	readonly line: number;
	readonly closed: boolean;
}

/** Scan CommonMark fence markers without normalizing authored code or line endings. */
function* fencedSourceRanges(markdown: string): Generator<FencedSourceRange, void, undefined> {
	let fence: Omit<FencedSourceRange, "end" | "after" | "closed"> | undefined;
	let lineStart = 0;
	let lineNumber = 0;
	while (lineStart <= markdown.length) {
		let lineEnd = lineStart;
		while (lineEnd < markdown.length && markdown[lineEnd] !== "\n" && markdown[lineEnd] !== "\r") lineEnd++;
		const next =
			lineEnd === markdown.length
				? markdown.length + 1
				: lineEnd + (markdown[lineEnd] === "\r" && markdown[lineEnd + 1] === "\n" ? 2 : 1);
		const line = markdown.slice(lineStart, lineEnd);
		if (fence) {
			if (closesFence(line, fence.marker)) {
				yield { ...fence, end: lineStart, after: Math.min(next, markdown.length), closed: true };
				fence = undefined;
			}
		} else {
			const open = FENCE_OPEN.exec(line);
			// A backtick fence's info string cannot hold backticks (CommonMark).
			if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
				const info = open[2]!.trim();
				fence = {
					marker: open[1]!,
					language: info.split(/[ \t]/, 1)[0]!.toLowerCase(),
					start: lineStart,
					body: Math.min(next, markdown.length),
					line: lineNumber,
				};
			}
		}
		lineStart = next;
		lineNumber++;
	}
	if (fence) yield { ...fence, end: markdown.length, after: markdown.length, closed: false };
}

/** Exclude only the line ending before a closer; authored blank lines and separators stay intact. */
export function fencedSourceContent(text: string, body: number, end: number): string {
	if (end > body && text[end - 1] === "\n") {
		end--;
		if (end > body && text[end - 1] === "\r") end--;
	} else if (end > body && text[end - 1] === "\r") end--;
	return text.slice(body, end);
}

/**
 * Lift enabled figure fences without changing their authored bodies. Mermaid
 * stays in the original prose until its matching closer arrives, even when the
 * message stops streaming; SVG retains its existing partial-document behavior.
 */
export function splitFigureFences(
	markdown: string,
	enabled: { readonly svg: boolean; readonly mermaid: boolean },
): FigureSegment[] {
	const closedFences: FencedSourceRange[] = [];
	let partialSvg: FencedSourceRange | undefined;
	for (const fence of fencedSourceRanges(markdown)) {
		if (fence.language === "svg" && enabled.svg) {
			if (fence.closed) closedFences.push(fence);
			else partialSvg = fence;
		} else if (fence.language === "mermaid" && enabled.mermaid && fence.closed) {
			closedFences.push(fence);
		}
	}
	const segments: FigureSegment[] = [];
	let proseStart = 0;
	for (const closed of closedFences) {
		const kind = closed.language;
		if (kind !== "svg" && kind !== "mermaid") continue;
		// Later math/HTML closers must not reinterpret an already-visible fence.
		if (kind === "mermaid" && !topLevelFenceLines(markdown.slice(0, closed.body), closed.line + 1).has(closed.line))
			continue;
		const prose = markdown.slice(proseStart, closed.start);
		if (prose.trim()) segments.push({ kind: "markdown", text: prose });
		segments.push({ kind, source: markdown.slice(closed.body, closed.end), closed: true });
		proseStart = closed.after;
	}
	if (partialSvg) {
		const prose = markdown.slice(proseStart, partialSvg.start);
		if (prose.trim()) segments.push({ kind: "markdown", text: prose });
		segments.push({ kind: "svg", source: markdown.slice(partialSvg.body), closed: false });
	} else if (markdown.slice(proseStart).trim()) {
		segments.push({ kind: "markdown", text: markdown.slice(proseStart) });
	}
	return segments;
}

/** Top-level fenced-code opener lines, without using the lexer's normalized source as figure source. */
function topLevelFenceLines(markdown: string, lineCount: number): Set<number> {
	const tokens = lexDocument(markdown);
	const lines = new Set<number>();
	// Work backwards: the lexer may omit a single leading blank line. Its
	// remaining top-level raw spans retain every line break, including ones
	// transferred between adjacent code/space tokens.
	let line = lineCount;
	for (let index = tokens.length - 1; index >= 0; index--) {
		const token = tokens[index]!;
		line -= countLineBreaks(token.raw);
		if (token.type === "code" && typeof token.lang === "string") lines.add(line);
	}
	return lines;
}

function countLineBreaks(source: string): number {
	let count = 0;
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n" || (source[index] === "\r" && source[index + 1] !== "\n")) count++;
	}
	return count;
}

/** Whether `line` closes a fence opened by `marker`: same character, at least as long, nothing after. */
function closesFence(line: string, marker: string): boolean {
	let index = 0;
	while (index < 3 && line[index] === " ") index++;
	let run = 0;
	while (line[index + run] === marker[0]) run++;
	return run >= marker.length && line.slice(index + run).trim() === "";
}

/**
 * Turn a possibly truncated SVG source into a well-formed document: cut the
 * trailing construct still being written (a tag without its `>`, an
 * unterminated comment, CDATA section, processing instruction or declaration,
 * a dangling `&entity`) and close every element left open, innermost first.
 * A complete document passes through unchanged. Returns null until the root
 * `<svg …>` start tag is complete — before that there is nothing to draw.
 */
export function closePartialSvg(source: string): string | null {
	const open: string[] = [];
	let rootSeen = false;
	let end = 0;
	let index = 0;
	for (;;) {
		const lt = source.indexOf("<", index);
		if (lt < 0) {
			// Trailing text: an entity reference still being written would not parse.
			const amp = source.lastIndexOf("&");
			end = amp >= index && !source.includes(";", amp) ? amp : source.length;
			break;
		}
		end = lt;
		const close = constructEnd(source, lt);
		if (close < 0) break;
		if (source.startsWith("</", lt)) {
			const name = source.slice(lt + 2, close - 1).trim();
			const at = open.lastIndexOf(name);
			if (at >= 0) open.length = at;
		} else if (source[lt + 1] !== "!" && source[lt + 1] !== "?") {
			const name = /^<([^\s/>]+)/.exec(source.slice(lt, close))?.[1];
			if (name !== undefined) {
				if (source[close - 2] !== "/") open.push(name);
				if (!rootSeen && (name === "svg" || name.endsWith(":svg"))) rootSeen = true;
			}
		}
		index = close;
		end = close;
	}
	if (!rootSeen) return null;
	let document = source.slice(0, end);
	for (let at = open.length - 1; at >= 0; at--) document += `</${open[at]}>`;
	return document;
}

/** `var(--name)` / `var(--name, fallback)`; the fallback may hold one level of parentheses (`rgb(…)`). */
const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
/** The first `<svg …>` start tag (namespace prefix allowed). */
const ROOT_TAG = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

/**
 * Make a figure's source what an SVG rasterizer draws as written, in the
 * reader's theme. Rasterizers resolve neither CSS custom properties nor an
 * inherited text color, and reject a root without the SVG namespace, so:
 * - styling `var(--name)` / `var(--name, fallback)` become `palette[name]`
 *   (unknown names take their fallback, else `palette.fg`); text stays literal;
 * - a root `<svg>` lacking them gets `color` = `palette.fg` (so
 *   `currentColor` follows the theme), a sans-serif `font-family` (instead
 *   of the rasterizer's Times), `xmlns`, and `xmlns:xlink` when the source
 *   uses `xlink:` attributes.
 */
export function prepareSvg(svg: string, palette: Readonly<Record<string, string>>): string {
	const fg = palette.fg ?? "currentColor";
	const resolveVariables = (value: string): string =>
		value.replace(
			VAR_REFERENCE,
			(_match, name: string, fallback: string | undefined) => palette[name] ?? (fallback?.trim() || fg),
		);
	let resolved = svg;
	if (svg.includes("var(")) {
		const parts: string[] = [];
		let from = 0;
		let inStyle = false;
		for (let lt = svg.indexOf("<"); lt >= 0; lt = svg.indexOf("<", from)) {
			const end = constructEnd(svg, lt);
			if (end < 0) break;
			const text = svg.slice(from, lt);
			const tag = svg.slice(lt, end);
			parts.push(inStyle ? resolveVariables(text) : text);
			const declaration = tag.startsWith("<!") || tag.startsWith("<?");
			parts.push(declaration && !(inStyle && tag.startsWith("<![CDATA[")) ? tag : resolveVariables(tag));
			if (/^<(?:[\w.-]+:)?style(?=[\s/>])/i.test(tag) && !/\/\s*>$/.test(tag)) inStyle = true;
			else if (/^<\/(?:[\w.-]+:)?style\s*>/i.test(tag)) inStyle = false;
			from = end;
		}
		const tail = svg.slice(from);
		parts.push(inStyle ? resolveVariables(tail) : tail);
		resolved = parts.join("");
	}
	const usesXlink = resolved.includes("xlink:");
	return resolved.replace(ROOT_TAG, tag => {
		let added = "";
		if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
		if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="sans-serif"`;
		if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
		if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
		return added ? tag.replace(/^<[^\s/>]+/, `$&${added}`) : tag;
	});
}

/** Index just past the markup construct starting at `<` (`lt`), or -1 when it is not complete yet. */
function constructEnd(source: string, lt: number): number {
	const after = (terminator: string, from: number): number => {
		const at = source.indexOf(terminator, from);
		return at < 0 ? -1 : at + terminator.length;
	};
	if (source.startsWith("<!--", lt)) return after("-->", lt + 4);
	if (source.startsWith("<![CDATA[", lt)) return after("]]>", lt + 9);
	if (source.startsWith("<?", lt)) return after("?>", lt + 2);
	// Tags and declarations end at the first `>` outside a quoted value; a
	// doctype's internal subset (`[…]`) may hold `>` of its own.
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[" && source[lt + 1] === "!") {
			subset = true;
		} else if (char === "]") {
			subset = false;
		} else if (char === ">" && !subset) {
			return at + 1;
		}
	}
	return -1;
}
